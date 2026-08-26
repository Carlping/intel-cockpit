import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { parseCanonicalMarkdown } from "../store/markdown.mjs";
import {
  ENTITY_CONFIG,
  normalizeEntityType,
  validateLogicalId,
} from "../store/schema.mjs";

const MAX_CANONICAL_FILE_BYTES = 1024 * 1024;
const MAX_RUNTIME_JSON_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_METADATA_ENTRIES = 100_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export const RUNTIME_RETENTION_DEFAULTS = Object.freeze({
  wal_retention_ms: 7 * DAY_MS,
  recovery_retention_ms: 14 * DAY_MS,
  backup_max_age_ms: 45 * DAY_MS,
  backup_min_keep: 14,
  backup_max_keep: 31,
});

export class OperationsBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "OperationsBoundaryError";
    this.code = "OPS_BOUNDARY_ERROR";
  }
}

export class CanonicalLintError extends Error {
  constructor(message, report) {
    super(message);
    this.name = "CanonicalLintError";
    this.code = "CANONICAL_LINT_FAILED";
    this.report = report;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isInside(left, right) || isInside(right, left);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeTimestamp(date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function calendarDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWrite(filename, contents) {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function resolveBoundaries(store) {
  if (!store || typeof store.initialize !== "function" || typeof store.configuration !== "function") {
    throw new TypeError("A configured IntelligenceStore is required");
  }
  await store.initialize();
  const configured = store.configuration();
  if (!configured.vaultRoot) {
    throw new OperationsBoundaryError(
      "vaultRoot is required so operations can prove runtime artifacts are outside OneDrive",
    );
  }
  const runtimeInfo = await lstat(configured.runtimeRoot);
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) {
    throw new OperationsBoundaryError(
      "runtimeRoot must be a real directory, not a symlink or reparse-point link",
    );
  }

  const [vaultRoot, wikiRoot, intelRoot, runtimeRoot] = await Promise.all([
    realpath(configured.vaultRoot),
    realpath(configured.wikiRoot),
    realpath(configured.intelRoot),
    realpath(configured.runtimeRoot),
  ]);
  if (
    pathsOverlap(runtimeRoot, vaultRoot) ||
    pathsOverlap(runtimeRoot, wikiRoot) ||
    pathsOverlap(runtimeRoot, intelRoot)
  ) {
    throw new OperationsBoundaryError(
      "runtimeRoot must be completely outside the source and intelligence vaults",
    );
  }
  return Object.freeze({ vaultRoot, wikiRoot, intelRoot, runtimeRoot });
}

function pathKey(filename) {
  const normalized = path.resolve(filename).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function assertRuntimePath(runtimeRoot, candidate, label = "Runtime artifact") {
  const resolved = path.resolve(candidate);
  if (!isInside(runtimeRoot, resolved) || pathKey(resolved) === pathKey(runtimeRoot)) {
    throw new OperationsBoundaryError(`${label} escaped or resolved to runtimeRoot`);
  }
  return resolved;
}

async function scanRuntimeTree(
  runtimeRoot,
  root,
  {
    strict = true,
    maxEntries = MAX_RUNTIME_METADATA_ENTRIES,
    allowRuntimeRoot = false,
  } = {},
) {
  const resolvedRoot = path.resolve(root);
  if (
    !isInside(runtimeRoot, resolvedRoot) ||
    (!allowRuntimeRoot && pathKey(resolvedRoot) === pathKey(runtimeRoot))
  ) {
    throw new OperationsBoundaryError("Runtime metadata scan escaped runtimeRoot");
  }

  let rootInfo;
  try {
    rootInfo = await lstat(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        files: [],
        directories: [],
        bytes: 0,
        unsafe_entries: [],
        truncated: false,
      };
    }
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new OperationsBoundaryError("Runtime artifact root is not a real directory");
  }
  const physicalRoot = await realpath(resolvedRoot);
  if (pathKey(physicalRoot) !== pathKey(resolvedRoot) || !isInside(runtimeRoot, physicalRoot)) {
    throw new OperationsBoundaryError(
      "Runtime artifact root is a symlink, junction, or reparse-point escape",
    );
  }

  const files = [];
  const directories = [resolvedRoot];
  const unsafeEntries = [];
  const pending = [resolvedRoot];
  let bytes = 0;
  let inspected = 0;
  let truncated = false;

  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      inspected += 1;
      if (inspected > maxEntries) {
        if (strict) {
          throw new OperationsBoundaryError(
            `Runtime metadata scan exceeded ${maxEntries} entries`,
          );
        }
        truncated = true;
        pending.length = 0;
        break;
      }
      const candidate = path.join(directory, entry.name);
      if (!isInside(runtimeRoot, candidate)) {
        throw new OperationsBoundaryError("Runtime directory entry escaped runtimeRoot");
      }
      const relativePath = path.relative(runtimeRoot, candidate).replaceAll("\\", "/");
      const info = await lstat(candidate);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        unsafeEntries.push({ relative_path: relativePath, reason: "symlink_or_reparse_link" });
        if (strict) {
          throw new OperationsBoundaryError(
            `Refusing runtime maintenance because ${relativePath} is a symlink or reparse link`,
          );
        }
        continue;
      }
      if (info.isDirectory()) {
        const physical = await realpath(candidate);
        if (pathKey(physical) !== pathKey(candidate) || !isInside(runtimeRoot, physical)) {
          unsafeEntries.push({ relative_path: relativePath, reason: "junction_or_reparse_escape" });
          if (strict) {
            throw new OperationsBoundaryError(
              `Refusing runtime maintenance because ${relativePath} is a junction or reparse escape`,
            );
          }
          continue;
        }
        directories.push(candidate);
        pending.push(candidate);
        continue;
      }
      if (!info.isFile()) {
        unsafeEntries.push({ relative_path: relativePath, reason: "non_regular_entry" });
        if (strict) {
          throw new OperationsBoundaryError(
            `Refusing runtime maintenance because ${relativePath} is not a regular file`,
          );
        }
        continue;
      }
      files.push({
        path: candidate,
        relative_path: relativePath,
        bytes: info.size,
        mtime_ms: info.mtimeMs,
      });
      bytes += info.size;
    }
  }

  return {
    exists: true,
    files,
    directories,
    bytes,
    unsafe_entries: unsafeEntries,
    truncated,
  };
}

async function readRuntimeJson(runtimeRoot, filename) {
  const resolved = assertRuntimePath(runtimeRoot, filename);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new OperationsBoundaryError("Runtime JSON changed into an unsafe entry");
  }
  if (info.size > MAX_RUNTIME_JSON_BYTES) {
    throw new OperationsBoundaryError(
      `Runtime JSON exceeds the ${MAX_RUNTIME_JSON_BYTES} byte inspection limit`,
    );
  }
  return JSON.parse(await readFile(resolved, "utf8"));
}

function validTimestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isOldEnough(timestamp, nowMs, retentionMs) {
  const parsed = validTimestamp(timestamp);
  return parsed !== null && parsed <= nowMs - retentionMs;
}

function normalizeRetentionPolicy(policy = {}) {
  const normalized = {
    ...RUNTIME_RETENTION_DEFAULTS,
    ...policy,
  };
  for (const key of [
    "wal_retention_ms",
    "recovery_retention_ms",
    "backup_max_age_ms",
  ]) {
    if (!Number.isSafeInteger(normalized[key]) || normalized[key] < DAY_MS) {
      throw new TypeError(`${key} must be a whole number of milliseconds of at least one day`);
    }
  }
  for (const key of ["backup_min_keep", "backup_max_keep"]) {
    if (!Number.isSafeInteger(normalized[key]) || normalized[key] < 1) {
      throw new TypeError(`${key} must be a positive integer`);
    }
  }
  if (normalized.backup_min_keep < 14) {
    throw new TypeError("backup_min_keep cannot be lower than the 14-day dogfood floor");
  }
  if (normalized.backup_max_keep < normalized.backup_min_keep) {
    throw new TypeError("backup_max_keep cannot be lower than backup_min_keep");
  }
  return Object.freeze(normalized);
}

async function assertSafeParent(runtimeRoot, filename) {
  const parent = path.dirname(assertRuntimePath(runtimeRoot, filename));
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new OperationsBoundaryError("Runtime artifact parent changed into an unsafe entry");
  }
  const physical = await realpath(parent);
  if (pathKey(physical) !== pathKey(parent) || !isInside(runtimeRoot, physical)) {
    throw new OperationsBoundaryError("Runtime artifact parent escaped through a reparse point");
  }
}

async function safeUnlinkRuntimeFile(runtimeRoot, filename) {
  const resolved = assertRuntimePath(runtimeRoot, filename);
  await assertSafeParent(runtimeRoot, resolved);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new OperationsBoundaryError("Runtime cleanup target changed into an unsafe entry");
  }
  await unlink(resolved);
  return info.size;
}

async function safeRemoveRuntimeTree(runtimeRoot, directory) {
  const resolved = assertRuntimePath(runtimeRoot, directory);
  const scan = await scanRuntimeTree(runtimeRoot, resolved, { strict: true });
  if (!scan.exists) return 0;
  let bytes = 0;
  for (const file of scan.files.sort((left, right) => right.path.length - left.path.length)) {
    bytes += await safeUnlinkRuntimeFile(runtimeRoot, file.path);
  }
  const directories = scan.directories
    .filter((candidate) => pathKey(candidate) !== pathKey(resolved))
    .sort((left, right) => right.length - left.length);
  for (const child of directories) {
    await assertSafeParent(runtimeRoot, child);
    const info = await lstat(child);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new OperationsBoundaryError("Runtime cleanup directory changed into an unsafe entry");
    }
    await rmdir(child);
  }
  await assertSafeParent(runtimeRoot, resolved);
  const rootInfo = await lstat(resolved);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new OperationsBoundaryError("Runtime cleanup root changed into an unsafe entry");
  }
  await rmdir(resolved);
  return bytes;
}

async function removeEmptyParents(runtimeRoot, start, stop) {
  let current = path.resolve(start);
  const boundary = path.resolve(stop);
  while (
    isInside(boundary, current) &&
    pathKey(current) !== pathKey(boundary) &&
    isInside(runtimeRoot, current)
  ) {
    await assertSafeParent(runtimeRoot, current);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        current = path.dirname(current);
        continue;
      }
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new OperationsBoundaryError("Recovery parent changed into an unsafe entry");
    }
    try {
      await rmdir(current);
    } catch (error) {
      if (["ENOTEMPTY", "EEXIST"].includes(error?.code)) break;
      throw error;
    }
    current = path.dirname(current);
  }
}

function safeByteNumber(value) {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  const normalized = typeof value === "bigint" ? value : BigInt(Math.max(0, Number(value) || 0));
  return Number(normalized > maximum ? maximum : normalized);
}

async function inspectStorageWithBoundaries(
  boundaries,
  {
    clock = () => new Date(),
    statfsImpl = statfs,
  } = {},
) {
  const checkedAt = clock();
  if (!(checkedAt instanceof Date) || Number.isNaN(checkedAt.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  const metadata = await scanRuntimeTree(boundaries.runtimeRoot, boundaries.runtimeRoot, {
    strict: false,
    allowRuntimeRoot: true,
  });
  let totalBytes = null;
  let freeBytes = null;
  let freePercent = null;
  let capacityError = null;
  try {
    const capacity = await statfsImpl(boundaries.runtimeRoot, { bigint: true });
    const blockSize = typeof capacity.bsize === "bigint"
      ? capacity.bsize
      : BigInt(capacity.bsize);
    const total = blockSize * (
      typeof capacity.blocks === "bigint" ? capacity.blocks : BigInt(capacity.blocks)
    );
    const available = blockSize * (
      typeof capacity.bavail === "bigint" ? capacity.bavail : BigInt(capacity.bavail)
    );
    totalBytes = safeByteNumber(total);
    freeBytes = safeByteNumber(available);
    freePercent = total > 0n ? Number((available * 10_000n) / total) / 100 : null;
  } catch (error) {
    capacityError = error instanceof Error ? error.message : String(error);
  }

  let level = "ok";
  if (
    freeBytes !== null &&
    freePercent !== null &&
    (freeBytes < 1024 ** 3 || freePercent < 3)
  ) {
    level = "critical";
  } else if (
    freeBytes !== null &&
    freePercent !== null &&
    (freeBytes < 5 * 1024 ** 3 || freePercent < 10)
  ) {
    level = "warning";
  } else if (capacityError || metadata.unsafe_entries.length > 0 || metadata.truncated) {
    level = "warning";
  }
  const state = level === "ok" ? "healthy" : "degraded";
  const message = metadata.unsafe_entries.length
    ? "Runtime disk metadata contains an unsafe link or special entry; automatic pruning is blocked"
    : capacityError
      ? "Runtime usage was counted, but filesystem free-space capacity is unavailable"
      : level === "critical"
        ? "Runtime filesystem free space is critically low"
        : level === "warning"
          ? "Runtime filesystem free space is low"
          : "Runtime storage is within the local retention and free-space guardrails";

  return Object.freeze({
    feed_id: "operations.runtime-storage",
    state,
    checked_at: checkedAt.toISOString(),
    coverage_state:
      capacityError || metadata.unsafe_entries.length || metadata.truncated
        ? "partial"
        : "complete",
    message,
    level,
    scope: "runtime_metadata_only",
    runtime_bytes: metadata.bytes,
    runtime_file_count: metadata.files.length,
    runtime_directory_count: metadata.directories.length,
    free_bytes: freeBytes,
    total_bytes: totalBytes,
    free_percent: freePercent,
    unsafe_entry_count: metadata.unsafe_entries.length,
    metadata_scan_truncated: metadata.truncated,
    capacity_error: capacityError,
  });
}

export async function inspectRuntimeStorageHealth({
  store,
  clock = () => new Date(),
  statfsImpl = statfs,
} = {}) {
  const boundaries = await resolveBoundaries(store);
  return inspectStorageWithBoundaries(boundaries, { clock, statfsImpl });
}

function issueFor(relativePath, entityType, error, extra = {}) {
  return {
    relative_path: relativePath,
    entity_type: entityType,
    code: error?.code || "CORRUPT_CANONICAL_STATE",
    message: error instanceof Error ? error.message : String(error),
    ...extra,
  };
}

async function scanCanonicalState(boundaries) {
  const valid = [];
  const invalid = [];
  const warnings = [];

  for (const [entityType, config] of Object.entries(ENTITY_CONFIG)) {
    const directory = path.join(boundaries.intelRoot, config.directory);
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      invalid.push(
        issueFor(config.directory, entityType, new Error("Canonical entity directory is unsafe")),
      );
      continue;
    }

    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.posix.join(config.directory, entry.name);
      const sourcePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        invalid.push(
          issueFor(relativePath, entityType, new Error("Canonical symlinks are forbidden"), {
            source_path: sourcePath,
            snapshot_eligible: false,
          }),
        );
        continue;
      }
      if (!entry.isFile()) {
        warnings.push({
          relative_path: relativePath,
          code: "IGNORED_NON_FILE",
          message: "Non-file entry was ignored",
        });
        continue;
      }
      if (entry.name.startsWith(".") || !entry.name.endsWith(".md")) {
        warnings.push({
          relative_path: relativePath,
          code: "IGNORED_NON_CANONICAL_FILE",
          message: "File is outside the canonical Markdown contract",
        });
        continue;
      }

      let entityId;
      try {
        entityId = validateLogicalId(entry.name.slice(0, -3));
      } catch (error) {
        invalid.push(
          issueFor(relativePath, entityType, error, {
            snapshot_eligible: false,
          }),
        );
        continue;
      }

      let snapshotContents;
      try {
        const fileInfo = await lstat(sourcePath);
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
          throw new Error("Canonical entry changed type during lint");
        }
        if (fileInfo.size > MAX_CANONICAL_FILE_BYTES) {
          throw new Error(
            `Canonical Markdown exceeds the ${MAX_CANONICAL_FILE_BYTES} byte safety limit`,
          );
        }
        const markdown = await readFile(sourcePath, "utf8");
        snapshotContents = Buffer.from(markdown, "utf8");
        const entity = parseCanonicalMarkdown(markdown, {
          entity_type: normalizeEntityType(entityType),
          entity_id: entityId,
        });
        valid.push({
          relative_path: relativePath,
          source_path: sourcePath,
          entity_type: entityType,
          entity_id: entityId,
          revision: entity.revision,
          content_sha256: entity.content_sha256,
          file_sha256: digest(Buffer.from(markdown, "utf8")),
          bytes: Buffer.byteLength(markdown, "utf8"),
          entity,
          markdown: snapshotContents,
        });
      } catch (error) {
        invalid.push(
          issueFor(relativePath, entityType, error, {
            snapshot_eligible: Boolean(snapshotContents),
            snapshot_contents: snapshotContents,
          }),
        );
      }
    }
  }
  valid.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  invalid.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  warnings.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  return { valid, invalid, warnings };
}

async function snapshotCorruption(issue, quarantineRoot) {
  if (!issue.snapshot_eligible || !Buffer.isBuffer(issue.snapshot_contents)) {
    return { state: "metadata_only", reason: "unsafe_or_non_regular_source" };
  }
  const destination = path.join(quarantineRoot, ...issue.relative_path.split("/"));
  if (!isInside(quarantineRoot, destination)) {
    throw new OperationsBoundaryError("Quarantine destination escaped runtimeRoot");
  }
  await atomicWrite(destination, issue.snapshot_contents);
  const snapshot = await readFile(destination);
  return {
    state: "snapshotted",
    relative_path: path.relative(quarantineRoot, destination).replaceAll("\\", "/"),
    bytes: snapshot.byteLength,
    sha256: digest(snapshot),
  };
}

function publicIssue(issue) {
  const safe = { ...issue };
  delete safe.source_path;
  delete safe.snapshot_eligible;
  delete safe.snapshot_contents;
  return safe;
}

export async function lintCanonicalState({
  store,
  clock = () => new Date(),
  quarantineCorrupt = true,
  writeReport = true,
} = {}) {
  const boundaries = await resolveBoundaries(store);
  const checkedAt = clock();
  if (!(checkedAt instanceof Date) || Number.isNaN(checkedAt.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  const scan = await scanCanonicalState(boundaries);
  const runId = safeTimestamp(checkedAt);
  const quarantineRoot = path.join(
    boundaries.runtimeRoot,
    "quarantine",
    "canonical",
    runId,
  );

  const invalid = [];
  for (const issue of scan.invalid) {
    const quarantine = quarantineCorrupt
      ? await snapshotCorruption(issue, quarantineRoot)
      : { state: "not_requested" };
    invalid.push({ ...publicIssue(issue), quarantine });
  }

  const report = {
    schema_version: 1,
    scope: "canonical_intelligence_only",
    checked_at: checkedAt.toISOString(),
    ok: invalid.length === 0,
    valid_count: scan.valid.length,
    invalid_count: invalid.length,
    warning_count: scan.warnings.length,
    valid: scan.valid.map((item) => ({
      relative_path: item.relative_path,
      entity_type: item.entity_type,
      entity_id: item.entity_id,
      revision: item.revision,
      content_sha256: item.content_sha256,
      file_sha256: item.file_sha256,
      bytes: item.bytes,
    })),
    invalid,
    warnings: scan.warnings,
  };

  if (writeReport) {
    const reportsRoot = path.join(boundaries.runtimeRoot, "lint-reports");
    await atomicWrite(
      path.join(reportsRoot, `${runId}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await atomicWrite(
      path.join(reportsRoot, "latest.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return report;
}

async function readExistingBackup(target, snapshotDate) {
  try {
    const targetInfo = await stat(target);
    if (!targetInfo.isDirectory()) {
      throw new CanonicalLintError("Daily backup target exists but is not a directory");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
  if (manifest?.schema_version !== 1 || manifest?.snapshot_date !== snapshotDate) {
    throw new CanonicalLintError("Existing daily backup manifest is invalid");
  }
  return manifest;
}

export async function createDailyBackup({
  store,
  clock = () => new Date(),
  timeZone = "America/New_York",
} = {}) {
  const boundaries = await resolveBoundaries(store);
  const createdAt = clock();
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  const snapshotDate = calendarDate(createdAt, timeZone);
  const backupsRoot = path.join(boundaries.runtimeRoot, "backups", "daily");
  const target = path.join(backupsRoot, snapshotDate);
  if (!isInside(boundaries.runtimeRoot, target)) {
    throw new OperationsBoundaryError("Backup destination escaped runtimeRoot");
  }

  const existing = await readExistingBackup(target, snapshotDate);
  if (existing) {
    return Object.freeze({
      state: "existing",
      backup_path: target,
      snapshot_date: snapshotDate,
      manifest: existing,
    });
  }

  const report = await lintCanonicalState({
    store,
    clock: () => createdAt,
    quarantineCorrupt: true,
    writeReport: true,
  });
  if (!report.ok) {
    throw new CanonicalLintError(
      "Daily backup stopped because canonical state failed schema lint",
      report,
    );
  }

  const scan = await scanCanonicalState(boundaries);
  const staging = path.join(backupsRoot, `.staging-${snapshotDate}-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    const exportedEntities = [];
    const files = [];
    for (const item of scan.valid) {
      const destination = path.join(staging, "canonical", ...item.relative_path.split("/"));
      if (!isInside(staging, destination)) {
        throw new OperationsBoundaryError("Backup file escaped its staging directory");
      }
      await atomicWrite(destination, item.markdown);
      const copied = await readFile(destination);
      const copiedHash = digest(copied);
      if (copiedHash !== item.file_sha256) {
        throw new CanonicalLintError(`Backup verification failed: ${item.relative_path}`);
      }
      files.push({
        relative_path: `canonical/${item.relative_path}`,
        bytes: copied.byteLength,
        sha256: copiedHash,
      });
      exportedEntities.push(item.entity);
    }

    const exportDocument = {
      schema_version: 1,
      export_type: "intel-os-canonical-json",
      exported_at: createdAt.toISOString(),
      snapshot_date: snapshotDate,
      time_zone: timeZone,
      entity_count: exportedEntities.length,
      entities: exportedEntities,
    };
    const exportContents = `${JSON.stringify(exportDocument, null, 2)}\n`;
    await atomicWrite(path.join(staging, "export.json"), exportContents);
    files.push({
      relative_path: "export.json",
      bytes: Buffer.byteLength(exportContents),
      sha256: digest(Buffer.from(exportContents)),
    });

    const manifest = {
      schema_version: 1,
      backup_type: "daily-local-canonical",
      created_at: createdAt.toISOString(),
      snapshot_date: snapshotDate,
      time_zone: timeZone,
      source_scope: "canonical_intelligence_live",
      entity_count: exportedEntities.length,
      files,
      lint: {
        checked_at: report.checked_at,
        valid_count: report.valid_count,
        invalid_count: report.invalid_count,
        warning_count: report.warning_count,
      },
    };
    await atomicWrite(
      path.join(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await mkdir(backupsRoot, { recursive: true });
    await rename(staging, target);
    await syncDirectory(backupsRoot);

    const readBack = await readExistingBackup(target, snapshotDate);
    return Object.freeze({
      state: "created",
      backup_path: target,
      snapshot_date: snapshotDate,
      manifest: readBack,
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) {
      const raced = await readExistingBackup(target, snapshotDate);
      if (raced) {
        return Object.freeze({
          state: "existing",
          backup_path: target,
          snapshot_date: snapshotDate,
          manifest: raced,
        });
      }
    }
    throw error;
  }
}

export async function maintainRuntimeArtifacts({
  store,
  clock = () => new Date(),
  policy,
  statfsImpl = statfs,
} = {}) {
  const boundaries = await resolveBoundaries(store);
  const ranAt = clock();
  if (!(ranAt instanceof Date) || Number.isNaN(ranAt.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  const retention = normalizeRetentionPolicy(policy);
  const nowMs = ranAt.getTime();
  const roots = {
    previews: path.join(boundaries.runtimeRoot, "previews"),
    wal: path.join(boundaries.runtimeRoot, "transactions", "store"),
    recovery: path.join(boundaries.runtimeRoot, "recovery"),
    backups: path.join(boundaries.runtimeRoot, "backups", "daily"),
    lintReports: path.join(boundaries.runtimeRoot, "lint-reports"),
  };

  // Complete every metadata preflight before the first delete. One unsafe
  // symlink/junction/special entry blocks the whole cleanup run.
  const scans = {
    previews: await scanRuntimeTree(boundaries.runtimeRoot, roots.previews, { strict: true }),
    wal: await scanRuntimeTree(boundaries.runtimeRoot, roots.wal, { strict: true }),
    recovery: await scanRuntimeTree(boundaries.runtimeRoot, roots.recovery, { strict: true }),
    backups: await scanRuntimeTree(boundaries.runtimeRoot, roots.backups, { strict: true }),
    lintReports: await scanRuntimeTree(boundaries.runtimeRoot, roots.lintReports, { strict: true }),
  };

  const previewFiles = [];
  const walFiles = [];
  const recoveryRecords = [];
  const backupDirectories = [];
  const lintReportFiles = [];
  const preserved = {
    preview_unexpired_or_unreadable: 0,
    wal_nonfinal_or_too_recent: 0,
    recovery_noncommitted_or_too_recent: 0,
    backup_protected_or_unreadable: 0,
    lint_report_protected_or_unreadable: 0,
  };

  for (const file of scans.previews.files) {
    if (path.extname(file.path).toLocaleLowerCase("en-US") !== ".json") {
      preserved.preview_unexpired_or_unreadable += 1;
      continue;
    }
    try {
      const record = await readRuntimeJson(boundaries.runtimeRoot, file.path);
      if (
        record?.schema_version === 1 &&
        validTimestamp(record.expires_at) !== null &&
        Date.parse(record.expires_at) <= nowMs
      ) {
        previewFiles.push(file.path);
      } else {
        preserved.preview_unexpired_or_unreadable += 1;
      }
    } catch {
      preserved.preview_unexpired_or_unreadable += 1;
    }
  }

  for (const file of scans.wal.files) {
    if (path.extname(file.path).toLocaleLowerCase("en-US") !== ".json") {
      preserved.wal_nonfinal_or_too_recent += 1;
      continue;
    }
    try {
      const manifest = await readRuntimeJson(boundaries.runtimeRoot, file.path);
      const finalizedAt = manifest?.state === "committed"
        ? manifest.committed_at
        : manifest?.state === "applied"
          ? manifest.applied_at
          : manifest?.state === "rolled_back"
            ? manifest.rolled_back_at
            : null;
      if (
        manifest?.version === 1 &&
        ["committed", "applied", "rolled_back"].includes(manifest.state) &&
        isOldEnough(finalizedAt, nowMs, retention.wal_retention_ms)
      ) {
        walFiles.push(file.path);
      } else {
        preserved.wal_nonfinal_or_too_recent += 1;
      }
    } catch {
      preserved.wal_nonfinal_or_too_recent += 1;
    }
  }

  for (const file of scans.recovery.files) {
    if (path.extname(file.path).toLocaleLowerCase("en-US") !== ".json") continue;
    try {
      const manifest = await readRuntimeJson(boundaries.runtimeRoot, file.path);
      const expectedId = path.basename(file.path, ".json");
      const snapshot = manifest?.snapshot;
      const snapshotIsSafe =
        snapshot === null ||
        snapshot === undefined ||
        (
          typeof snapshot === "string" &&
          snapshot === `${expectedId}.before.md` &&
          path.basename(snapshot) === snapshot
        );
      if (
        manifest?.recovery_id === expectedId &&
        manifest?.state === "committed" &&
        manifest?.failure == null &&
        snapshotIsSafe &&
        isOldEnough(
          manifest.committed_at,
          nowMs,
          retention.recovery_retention_ms,
        )
      ) {
        const snapshotPath = typeof snapshot === "string"
          ? path.join(path.dirname(file.path), snapshot)
          : null;
        recoveryRecords.push({
          manifest: file.path,
          snapshot:
            snapshotPath && scans.recovery.files.some(
              (candidate) => pathKey(candidate.path) === pathKey(snapshotPath),
            )
              ? snapshotPath
              : null,
        });
      } else {
        preserved.recovery_noncommitted_or_too_recent += 1;
      }
    } catch {
      preserved.recovery_noncommitted_or_too_recent += 1;
    }
  }

  const directBackupDirectories = scans.backups.directories.filter(
    (directory) =>
      pathKey(directory) !== pathKey(roots.backups) &&
      pathKey(path.dirname(directory)) === pathKey(roots.backups),
  );
  const validBackups = [];
  for (const directory of directBackupDirectories) {
    const snapshotDate = path.basename(directory);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
      preserved.backup_protected_or_unreadable += 1;
      continue;
    }
    try {
      const manifest = await readRuntimeJson(
        boundaries.runtimeRoot,
        path.join(directory, "manifest.json"),
      );
      if (
        manifest?.schema_version !== 1 ||
        manifest?.backup_type !== "daily-local-canonical" ||
        manifest?.snapshot_date !== snapshotDate ||
        validTimestamp(manifest.created_at) === null
      ) {
        preserved.backup_protected_or_unreadable += 1;
        continue;
      }
      validBackups.push({
        directory,
        snapshot_date: snapshotDate,
        created_at_ms: Date.parse(manifest.created_at),
      });
    } catch {
      preserved.backup_protected_or_unreadable += 1;
    }
  }
  validBackups.sort((left, right) => (
    right.snapshot_date.localeCompare(left.snapshot_date) ||
    right.created_at_ms - left.created_at_ms
  ));
  for (const [index, backup] of validBackups.entries()) {
    const protectedByDogfoodFloor = index < retention.backup_min_keep;
    const exceedsCount = index >= retention.backup_max_keep;
    const exceedsAge = backup.created_at_ms <= nowMs - retention.backup_max_age_ms;
    if (!protectedByDogfoodFloor && (exceedsCount || exceedsAge)) {
      backupDirectories.push(backup.directory);
    } else {
      preserved.backup_protected_or_unreadable += 1;
    }
  }

  const validLintReports = [];
  for (const file of scans.lintReports.files) {
    if (
      path.basename(file.path).toLocaleLowerCase("en-US") === "latest.json" ||
      path.extname(file.path).toLocaleLowerCase("en-US") !== ".json"
    ) {
      preserved.lint_report_protected_or_unreadable += 1;
      continue;
    }
    try {
      const report = await readRuntimeJson(boundaries.runtimeRoot, file.path);
      const checkedAt = validTimestamp(report?.checked_at);
      if (report?.schema_version !== 1 || checkedAt === null) {
        preserved.lint_report_protected_or_unreadable += 1;
        continue;
      }
      validLintReports.push({ path: file.path, checked_at_ms: checkedAt });
    } catch {
      preserved.lint_report_protected_or_unreadable += 1;
    }
  }
  validLintReports.sort((left, right) => right.checked_at_ms - left.checked_at_ms);
  for (const [index, report] of validLintReports.entries()) {
    const protectedByDogfoodFloor = index < retention.backup_min_keep;
    const exceedsCount = index >= retention.backup_max_keep;
    const exceedsAge = report.checked_at_ms <= nowMs - retention.backup_max_age_ms;
    if (!protectedByDogfoodFloor && (exceedsCount || exceedsAge)) {
      lintReportFiles.push(report.path);
    } else {
      preserved.lint_report_protected_or_unreadable += 1;
    }
  }

  let prunedBytes = 0;
  for (const filename of previewFiles) {
    prunedBytes += await safeUnlinkRuntimeFile(boundaries.runtimeRoot, filename);
  }
  for (const filename of walFiles) {
    prunedBytes += await safeUnlinkRuntimeFile(boundaries.runtimeRoot, filename);
  }
  for (const record of recoveryRecords) {
    if (record.snapshot) {
      prunedBytes += await safeUnlinkRuntimeFile(boundaries.runtimeRoot, record.snapshot);
    }
    prunedBytes += await safeUnlinkRuntimeFile(boundaries.runtimeRoot, record.manifest);
    await removeEmptyParents(
      boundaries.runtimeRoot,
      path.dirname(record.manifest),
      roots.recovery,
    );
  }
  for (const directory of backupDirectories) {
    prunedBytes += await safeRemoveRuntimeTree(boundaries.runtimeRoot, directory);
  }
  for (const filename of lintReportFiles) {
    prunedBytes += await safeUnlinkRuntimeFile(boundaries.runtimeRoot, filename);
  }

  const pruned = Object.freeze({
    preview_files: previewFiles.length,
    wal_files: walFiles.length,
    recovery_records: recoveryRecords.length,
    backup_snapshots: backupDirectories.length,
    lint_report_files: lintReportFiles.length,
    bytes: prunedBytes,
  });
  const health = await inspectStorageWithBoundaries(boundaries, { clock, statfsImpl });
  return Object.freeze({
    schema_version: 1,
    ran_at: ranAt.toISOString(),
    policy: retention,
    pruned,
    preserved: Object.freeze(preserved),
    health: Object.freeze({
      ...health,
      last_retention_at: ranAt.toISOString(),
      last_pruned_bytes: prunedBytes,
      last_pruned_files:
        previewFiles.length +
        walFiles.length +
        recoveryRecords.reduce(
          (count, record) => count + 1 + (record.snapshot ? 1 : 0),
          0,
        ) +
        lintReportFiles.length,
      last_pruned_backup_snapshots: backupDirectories.length,
    }),
  });
}
