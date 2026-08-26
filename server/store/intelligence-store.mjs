import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { loadLocalConfig } from "../config/local-config.mjs";
import path from "node:path";
import {
  ConflictError,
  CorruptionError,
  NotFoundError,
  PreviewExpiredError,
  ValidationError,
} from "./errors.mjs";
import {
  calculateContentHash,
  canonicalJson,
  parseCanonicalMarkdown,
  serializeCanonicalMarkdown,
  sha256,
} from "./markdown.mjs";
import {
  ENTITY_CONFIG,
  applyMergePatch,
  entityDirectory,
  generateLogicalId,
  normalizeEntityType,
  validateBaseRevision,
  validateEntityPayload,
  validateLogicalId,
} from "./schema.mjs";
import {
  preflightRuntimeDirectories,
  prepareRuntimeDirectories,
  prepareRuntimeDirectory,
  runtimeLayoutDirectories,
} from "../runtime-boundary.mjs";

const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;
const DEFAULT_WRITER_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_WRITER_LOCK_STALE_MS = 30_000;
const MAX_BATCH_OPERATIONS = 100;
const PREVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isInside(left, right) || isInside(right, left);
}

function pathsEqual(left, right) {
  return isInside(left, right) && isInside(right, left);
}

function assertAbsoluteDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new ValidationError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
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

async function atomicWriteFile(filename, contents) {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;

  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    await syncDirectory(directory);
    const readBack = await readFile(filename, "utf8");
    if (sha256(readBack) !== sha256(contents)) {
      throw new CorruptionError(`Atomic write read-back failed for ${path.basename(filename)}`);
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function escapePointer(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function diffValues(before, after, pointer = "", changes = []) {
  if (changes.length >= 200 || canonicalJson(before) === canonicalJson(after)) return changes;

  const beforeObject = before && typeof before === "object" && !Array.isArray(before);
  const afterObject = after && typeof after === "object" && !Array.isArray(after);
  if (beforeObject && afterObject) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      diffValues(before[key], after[key], `${pointer}/${escapePointer(key)}`, changes);
      if (changes.length >= 200) break;
    }
    return changes;
  }

  changes.push({
    path: pointer || "/",
    before: before === undefined ? null : before,
    after: after === undefined ? null : after,
  });
  return changes;
}

function validateIsoTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new CorruptionError(`${label} is not a valid timestamp`);
  }
}

function normalizeOperation(value) {
  if (value !== "create" && value !== "update") {
    throw new ValidationError("operation must be create or update");
  }
  return value;
}

function assertNoRootOverlap(wikiRoot, intelRoot, runtimeRoot, vaultRoot) {
  if (pathsOverlap(wikiRoot, intelRoot)) {
    throw new ValidationError("intelRoot and wikiRoot must not overlap");
  }
  if (pathsOverlap(wikiRoot, runtimeRoot) || pathsOverlap(intelRoot, runtimeRoot)) {
    throw new ValidationError("runtimeRoot must be outside the Wiki and intelligence roots");
  }
  if (vaultRoot && pathsOverlap(vaultRoot, runtimeRoot)) {
    throw new ValidationError("runtimeRoot must be outside vaultRoot");
  }
}

function assertVaultContainment(wikiRoot, intelRoot, vaultRoot) {
  if (!vaultRoot) return;
  if (!isInside(vaultRoot, wikiRoot)) {
    throw new ValidationError("wikiRoot must remain inside vaultRoot");
  }
  if (!isInside(vaultRoot, intelRoot)) {
    throw new ValidationError("intelRoot must remain inside vaultRoot");
  }
}

function assertRuntimeOutsideOneDrive(runtimeRoot, environment = process.env) {
  const oneDriveRoots = [
    environment.OneDrive,
    environment.OneDriveConsumer,
    environment.OneDriveCommercial,
  ]
    .filter((value) => typeof value === "string" && path.isAbsolute(value))
    .map((value) => path.resolve(value));
  const hasOneDriveSegment = path
    .resolve(runtimeRoot)
    .split(/[\\/]+/)
    .some((segment) => segment.toLocaleLowerCase("en-US") === "onedrive");
  if (
    hasOneDriveSegment ||
    oneDriveRoots.some((oneDriveRoot) => pathsOverlap(oneDriveRoot, runtimeRoot))
  ) {
    throw new ValidationError("runtimeRoot must not be stored in OneDrive");
  }
}

function commonLexicalAncestor(paths) {
  if (!paths.length) return undefined;
  let common = path.resolve(paths[0]);
  for (const candidate of paths.slice(1)) {
    while (!isInside(common, candidate)) {
      const parent = path.dirname(common);
      if (parent === common) return undefined;
      common = parent;
    }
  }
  return common;
}

async function inspectPlannedDirectory(
  configuredPath,
  label,
  { anchor, anchorReal, mustExist = false } = {},
) {
  const target = path.resolve(configuredPath);
  const traversalAnchor = anchor ?? path.parse(target).root;
  let resolvedCursor = anchorReal ?? (await realpath(traversalAnchor));
  let lexicalCursor = traversalAnchor;
  const relative = path.relative(traversalAnchor, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ValidationError(`${label} escaped its preflight anchor`);
  }

  const segments = relative === "" ? [] : relative.split(path.sep).filter(Boolean);
  const missingSegments = [];
  let missing = false;

  for (const segment of segments) {
    lexicalCursor = path.join(lexicalCursor, segment);
    if (missing) {
      missingSegments.push(segment);
      continue;
    }

    let info;
    try {
      info = await lstat(lexicalCursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing = true;
      missingSegments.push(segment);
      continue;
    }

    if (info.isSymbolicLink()) {
      throw new ValidationError(`${label} must not traverse a symbolic link or junction`);
    }
    if (!info.isDirectory()) {
      throw new ValidationError(`${label} must resolve through directories only`);
    }

    const resolved = await realpath(lexicalCursor);
    const expected = path.join(resolvedCursor, segment);
    if (!pathsEqual(resolved, expected)) {
      throw new ValidationError(`${label} traverses a reparse point outside its expected path`);
    }
    resolvedCursor = resolved;
  }

  if (mustExist && missingSegments.length > 0) {
    throw new ValidationError(`${label} must be an existing, non-symlink directory`);
  }

  if (mustExist) {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ValidationError(`${label} must be an existing, non-symlink directory`);
    }
  }

  return Object.freeze({
    configured: target,
    nearestExistingAncestor: resolvedCursor,
    resolved: path.resolve(resolvedCursor, ...missingSegments),
  });
}

async function preflightStoreDirectories({ wikiRoot, intelRoot, runtimeRoot, vaultRoot }) {
  assertNoRootOverlap(wikiRoot, intelRoot, runtimeRoot, vaultRoot);
  assertVaultContainment(wikiRoot, intelRoot, vaultRoot);
  assertRuntimeOutsideOneDrive(runtimeRoot);

  const configuredRoots = [wikiRoot, intelRoot, runtimeRoot, vaultRoot].filter(Boolean);
  const sharedAnchor = commonLexicalAncestor(configuredRoots);
  const anchor = sharedAnchor ?? path.parse(wikiRoot).root;
  const anchorInfo = await lstat(anchor);
  if (!anchorInfo.isDirectory() || anchorInfo.isSymbolicLink()) {
    throw new ValidationError("Store path preflight anchor must be a non-symlink directory");
  }
  const anchorReal = await realpath(anchor);
  const options = { anchor, anchorReal };

  const [wiki, intel, runtime, vault] = await Promise.all([
    inspectPlannedDirectory(wikiRoot, "wikiRoot", { ...options, mustExist: true }),
    inspectPlannedDirectory(intelRoot, "intelRoot", options),
    inspectPlannedDirectory(runtimeRoot, "runtimeRoot", options),
    vaultRoot
      ? inspectPlannedDirectory(vaultRoot, "vaultRoot", { ...options, mustExist: true })
      : Promise.resolve(undefined),
  ]);

  assertNoRootOverlap(wiki.resolved, intel.resolved, runtime.resolved, vault?.resolved);
  assertVaultContainment(wiki.resolved, intel.resolved, vault?.resolved);
  assertRuntimeOutsideOneDrive(runtime.resolved);

  const intelDirectories = Object.values(ENTITY_CONFIG).map(({ directory }) =>
    path.join(intelRoot, directory),
  );
  const runtimeDirectories = runtimeLayoutDirectories(runtimeRoot);
  const childPlans = await Promise.all([
    ...intelDirectories.map((directory) =>
      inspectPlannedDirectory(directory, "canonical entity directory", options),
    ),
    ...runtimeDirectories.map((directory) =>
      inspectPlannedDirectory(directory, "runtime state directory", options),
    ),
  ]);
  for (const plan of childPlans.slice(0, intelDirectories.length)) {
    if (!isInside(intel.resolved, plan.resolved)) {
      throw new ValidationError("Canonical entity directory escaped intelRoot");
    }
  }
  for (const plan of childPlans.slice(intelDirectories.length)) {
    if (!isInside(runtime.resolved, plan.resolved)) {
      throw new ValidationError("Runtime state directory escaped runtimeRoot");
    }
  }

  return Object.freeze({ wiki, intel, runtime, vault });
}

export class IntelligenceStore {
  constructor({
    intelRoot,
    wikiRoot,
    runtimeRoot,
    vaultRoot,
    clock = () => new Date(),
    previewTtlMs = DEFAULT_PREVIEW_TTL_MS,
    writerLockTimeoutMs = DEFAULT_WRITER_LOCK_TIMEOUT_MS,
    writerLockStaleMs = DEFAULT_WRITER_LOCK_STALE_MS,
    faultInjector,
  }) {
    this.intelRoot = assertAbsoluteDirectory(intelRoot, "intelRoot");
    this.wikiRoot = assertAbsoluteDirectory(wikiRoot, "wikiRoot");
    this.runtimeRoot = assertAbsoluteDirectory(runtimeRoot, "runtimeRoot");
    this.vaultRoot = vaultRoot
      ? assertAbsoluteDirectory(vaultRoot, "vaultRoot")
      : undefined;
    this.clock = clock;
    if (!Number.isSafeInteger(previewTtlMs) || previewTtlMs < 1_000) {
      throw new ValidationError("previewTtlMs must be at least 1000 milliseconds");
    }
    this.previewTtlMs = previewTtlMs;
    if (!Number.isSafeInteger(writerLockTimeoutMs) || writerLockTimeoutMs < 100) {
      throw new ValidationError("writerLockTimeoutMs must be at least 100 milliseconds");
    }
    if (!Number.isSafeInteger(writerLockStaleMs) || writerLockStaleMs < 1_000) {
      throw new ValidationError("writerLockStaleMs must be at least 1000 milliseconds");
    }
    if (faultInjector !== undefined && typeof faultInjector !== "function") {
      throw new ValidationError("faultInjector must be a function when provided");
    }
    this.writerLockTimeoutMs = writerLockTimeoutMs;
    this.writerLockStaleMs = writerLockStaleMs;
    this.faultInjector = faultInjector;
    this._initializing = undefined;
    this._rootsReady = false;
    this._initialized = false;
  }

  async initialize() {
    if (this._initialized) return this;
    if (!this._initializing) this._initializing = this.#initializeOnce();
    return this._initializing;
  }

  async #initializeOnce() {
    const preflight = await preflightStoreDirectories({
      wikiRoot: this.wikiRoot,
      intelRoot: this.intelRoot,
      runtimeRoot: this.runtimeRoot,
      vaultRoot: this.vaultRoot,
    });
    await access(this.wikiRoot, constants.R_OK);

    await mkdir(this.intelRoot, { recursive: true });
    const runtimeDirectories = runtimeLayoutDirectories(this.runtimeRoot);
    await prepareRuntimeDirectories({
      runtimeRoot: this.runtimeRoot,
      directories: runtimeDirectories,
    });
    await Promise.all(
      Object.values(ENTITY_CONFIG).map(({ directory }) =>
        mkdir(path.join(this.intelRoot, directory), { recursive: true }),
      ),
    );
    await preflightRuntimeDirectories({
      runtimeRoot: this.runtimeRoot,
      directories: runtimeDirectories,
      mustExist: true,
    });

    const [wikiReal, intelReal, runtimeReal, vaultReal] = await Promise.all([
      realpath(this.wikiRoot),
      realpath(this.intelRoot),
      realpath(this.runtimeRoot),
      this.vaultRoot ? realpath(this.vaultRoot) : Promise.resolve(undefined),
    ]);
    assertNoRootOverlap(wikiReal, intelReal, runtimeReal, vaultReal);
    assertVaultContainment(wikiReal, intelReal, vaultReal);
    assertRuntimeOutsideOneDrive(runtimeReal);
    if (
      !pathsEqual(wikiReal, preflight.wiki.resolved) ||
      !pathsEqual(intelReal, preflight.intel.resolved) ||
      !pathsEqual(runtimeReal, preflight.runtime.resolved) ||
      (vaultReal && !pathsEqual(vaultReal, preflight.vault?.resolved))
    ) {
      throw new ValidationError("Store roots changed while initialization was in progress");
    }
    this.wikiRootReal = wikiReal;
    this.intelRootReal = intelReal;
    this.runtimeRootReal = runtimeReal;
    this.vaultRootReal = vaultReal;
    this._rootsReady = true;

    await this.#withWriterLockReady(async () => {
      await this.#recoverTransactionsUnlocked();
    });
    this._initialized = true;

    return this;
  }

  configuration() {
    return Object.freeze({
      intelRoot: this.intelRoot,
      wikiRoot: this.wikiRoot,
      runtimeRoot: this.runtimeRoot,
      vaultRoot: this.vaultRoot,
    });
  }

  async #runtimeDirectory(...relativeSegments) {
    if (!this._rootsReady) await this.initialize();
    const directory = path.join(this.runtimeRoot, ...relativeSegments);
    const resolved = await prepareRuntimeDirectory(this.runtimeRoot, directory);
    if (!isInside(this.runtimeRootReal, resolved)) {
      throw new CorruptionError("Runtime directory escaped the configured runtime root");
    }
    return resolved;
  }

  async #canonicalDirectory(entityType) {
    if (!this._rootsReady) await this.initialize();
    const directory = path.join(this.intelRoot, entityDirectory(entityType));
    const resolved = await realpath(directory);
    if (!isInside(this.intelRootReal, resolved)) {
      throw new CorruptionError("Canonical directory escaped the configured intelligence root");
    }
    return resolved;
  }

  async #entityPath(entityType, entityId) {
    const normalizedType = normalizeEntityType(entityType);
    const normalizedId = validateLogicalId(entityId);
    const directory = await this.#canonicalDirectory(normalizedType);
    const filename = path.join(directory, `${normalizedId}.md`);
    if (!isInside(this.intelRootReal, filename)) {
      throw new ValidationError("Resolved entity path escaped intelRoot");
    }
    return filename;
  }

  async #readEntity(entityType, entityId, { includeMarkdown = false } = {}) {
    const normalizedType = normalizeEntityType(entityType);
    const normalizedId = validateLogicalId(entityId);
    const filename = await this.#entityPath(normalizedType, normalizedId);
    let info;
    try {
      info = await lstat(filename);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CorruptionError("Canonical entity is not a regular file");
    }

    const markdown = await readFile(filename, "utf8");
    const entity = parseCanonicalMarkdown(markdown, {
      entity_type: normalizedType,
      entity_id: normalizedId,
    });
    return includeMarkdown ? { entity, markdown, filename } : entity;
  }

  async get(entityType, entityId) {
    const entity = await this.#readEntity(entityType, entityId);
    if (!entity) {
      throw new NotFoundError(`${normalizeEntityType(entityType)} ${entityId} was not found`);
    }
    return entity;
  }

  async list(entityType, { limit = 1_000 } = {}) {
    const normalizedType = normalizeEntityType(entityType);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new ValidationError("limit must be an integer between 1 and 10000");
    }
    const directory = await this.#canonicalDirectory(normalizedType);
    const entries = await readdir(directory, { withFileTypes: true });
    const entities = [];

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new CorruptionError(`Symlinks are not allowed in canonical state: ${entry.name}`);
      }
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) {
        continue;
      }
      const entityId = entry.name.slice(0, -3);
      try {
        validateLogicalId(entityId);
      } catch {
        throw new CorruptionError(`Unsafe canonical filename: ${entry.name}`);
      }
      const entity = await this.#readEntity(normalizedType, entityId);
      if (entity) entities.push(entity);
    }

    return entities
      .sort((left, right) => {
        const byUpdated = right.updated_at.localeCompare(left.updated_at);
        return byUpdated || left.entity_id.localeCompare(right.entity_id);
      })
      .slice(0, limit);
  }

  async preview({ operation, entity_type, entity_id, base_revision, payload }) {
    const normalizedOperation = normalizeOperation(operation);
    const normalizedType = normalizeEntityType(entity_type);
    const baseRevision = validateBaseRevision(base_revision);
    const entityId = entity_id
      ? validateLogicalId(entity_id)
      : normalizedOperation === "create"
        ? generateLogicalId(normalizedType)
        : (() => {
            throw new ValidationError("entity_id is required for update");
          })();

    const current = await this.#readEntity(normalizedType, entityId);
    if (normalizedOperation === "create") {
      if (baseRevision !== 0) {
        throw new ConflictError("Create operations require base_revision 0");
      }
      if (current) throw new ConflictError(`${normalizedType} ${entityId} already exists`);
    } else {
      if (!current) throw new NotFoundError(`${normalizedType} ${entityId} was not found`);
      if (current.revision !== baseRevision) {
        throw new ConflictError(
          `Revision conflict: expected ${baseRevision}, current revision is ${current.revision}`,
        );
      }
    }

    const nextPayload = validateEntityPayload(
      normalizedType,
      normalizedOperation === "create"
        ? payload
        : applyMergePatch(current.payload, payload),
    );
    const now = this.clock().toISOString();
    const { entity: proposedEntity, markdown } = serializeCanonicalMarkdown({
      schema_version: 1,
      entity_type: normalizedType,
      entity_id: entityId,
      revision: baseRevision + 1,
      created_at: current?.created_at ?? now,
      updated_at: now,
      payload: nextPayload,
    });
    const previewId = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.clock().getTime() + this.previewTtlMs).toISOString();
    const diff = diffValues(current?.payload ?? {}, nextPayload);
    const record = {
      schema_version: 1,
      preview_id_sha256: sha256(previewId),
      created_at: now,
      expires_at: expiresAt,
      operation: normalizedOperation,
      entity_type: normalizedType,
      entity_id: entityId,
      base_revision: baseRevision,
      base_content_sha256: current?.content_sha256 ?? null,
      proposed_entity: proposedEntity,
      proposed_markdown_sha256: sha256(markdown),
      diff,
    };
    await this.#runtimeDirectory("previews");
    await atomicWriteFile(this.#previewPath(previewId), `${JSON.stringify(record, null, 2)}\n`);

    return {
      preview_id: previewId,
      base_revision: baseRevision,
      diff,
      entity: proposedEntity,
    };
  }

  #previewPath(previewId) {
    if (typeof previewId !== "string" || !PREVIEW_ID_PATTERN.test(previewId)) {
      throw new ValidationError("preview_id is invalid");
    }
    const digest = sha256(previewId);
    return path.join(this.runtimeRoot, "previews", `${digest}.json`);
  }

  async #readPreview(previewId) {
    await this.initialize();
    await this.#runtimeDirectory("previews");
    const filename = this.#previewPath(previewId);
    let serialized;
    try {
      serialized = await readFile(filename, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") throw new NotFoundError("Preview was not found");
      throw error;
    }
    let record;
    try {
      record = JSON.parse(serialized);
    } catch (error) {
      throw new CorruptionError("Preview record is invalid", { cause: error });
    }
    if (record.preview_id_sha256 !== sha256(previewId)) {
      throw new CorruptionError("Preview token verification failed");
    }
    validateIsoTimestamp(record.expires_at, "Preview expiry");
    if (Date.parse(record.expires_at) <= this.clock().getTime()) {
      await unlink(filename).catch(() => {});
      throw new PreviewExpiredError("Preview expired; create a new preview from current state");
    }
    return { record, filename };
  }

  async #fault(phase, context = {}) {
    await this.faultInjector?.(phase, context);
  }

  async #lockOwnerIsAlive(lockPath) {
    let metadata;
    try {
      metadata = JSON.parse(await readFile(lockPath, "utf8"));
    } catch {
      return null;
    }
    if (
      metadata?.host !== hostname() ||
      !Number.isSafeInteger(metadata?.pid) ||
      metadata.pid < 1
    ) {
      return null;
    }
    try {
      process.kill(metadata.pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }

  async #tryRemoveStaleWriterLock(lockPath) {
    const lockInfo = await stat(lockPath).catch(() => null);
    if (!lockInfo) return;
    const ownerAlive = await this.#lockOwnerIsAlive(lockPath);
    if (ownerAlive) return;
    if (ownerAlive === null && Date.now() - lockInfo.mtimeMs < this.writerLockStaleMs) return;
    await unlink(lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await syncDirectory(path.dirname(lockPath));
  }

  async #withWriterLockReady(operation) {
    const lockDirectory = await this.#runtimeDirectory("locks");
    const lockPath = path.join(lockDirectory, "canonical-writer.lock");
    const token = randomUUID();
    const startedAt = Date.now();
    let handle;

    while (Date.now() - startedAt < this.writerLockTimeoutMs) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(
          `${JSON.stringify({
            version: 1,
            token,
            pid: process.pid,
            host: hostname(),
            acquired_at: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
        await handle.sync();
        await syncDirectory(lockDirectory);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await this.#tryRemoveStaleWriterLock(lockPath);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    if (!handle) throw new ConflictError("Canonical writer is busy; retry the operation");
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      let ownsLock = false;
      try {
        const metadata = JSON.parse(await readFile(lockPath, "utf8"));
        ownsLock = metadata?.token === token;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (ownsLock) {
        await unlink(lockPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        await syncDirectory(lockDirectory);
      }
    }
  }

  async #withWriterLock(operation) {
    await this.initialize();
    return this.#withWriterLockReady(async () => {
      await this.#recoverTransactionsUnlocked();
      return operation();
    });
  }

  async #preparePreviewForCommit(previewId) {
    const { record, filename: previewPath } = await this.#readPreview(previewId);
    const currentState = await this.#readEntity(record.entity_type, record.entity_id, {
      includeMarkdown: true,
    });
    const current = currentState?.entity ?? null;
    if ((current?.revision ?? 0) !== record.base_revision) {
      throw new ConflictError(
        `Revision conflict: preview used ${record.base_revision}, current revision is ${current?.revision ?? 0}`,
      );
    }
    if ((current?.content_sha256 ?? null) !== record.base_content_sha256) {
      throw new ConflictError("Canonical content changed after the preview was created");
    }

    const proposed = record.proposed_entity;
    if (
      proposed.entity_type !== record.entity_type ||
      proposed.entity_id !== record.entity_id ||
      proposed.revision !== record.base_revision + 1 ||
      proposed.content_sha256 !== calculateContentHash(proposed)
    ) {
      throw new CorruptionError("Preview proposed entity failed integrity validation");
    }
    validateEntityPayload(proposed.entity_type, proposed.payload);
    const { markdown } = serializeCanonicalMarkdown(proposed);
    if (sha256(markdown) !== record.proposed_markdown_sha256) {
      throw new CorruptionError("Preview document hash verification failed");
    }

    return {
      previewId,
      previewPath,
      record,
      currentState,
      proposed,
      proposedMarkdown: markdown,
      target: await this.#entityPath(record.entity_type, record.entity_id),
    };
  }

  #transactionPath(transactionId) {
    if (typeof transactionId !== "string" || !TRANSACTION_ID_PATTERN.test(transactionId)) {
      throw new ValidationError("transaction_id is invalid");
    }
    return path.join(this.runtimeRoot, "transactions", "store", `${transactionId}.json`);
  }

  async #writeTransaction(manifest) {
    await this.#runtimeDirectory("transactions", "store");
    const filename = this.#transactionPath(manifest.transaction_id);
    await atomicWriteFile(filename, `${JSON.stringify(manifest, null, 2)}\n`);
    return filename;
  }

  #validateTransactionManifest(manifest, expectedTransactionId) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new CorruptionError("Transaction WAL must be an object");
    }
    if (
      manifest.version !== 1 ||
      manifest.transaction_id !== expectedTransactionId ||
      manifest.transaction_id_sha256 !== sha256(expectedTransactionId) ||
      !Array.isArray(manifest.operations) ||
      manifest.operations.length < 1 ||
      manifest.operations.length > MAX_BATCH_OPERATIONS
    ) {
      throw new CorruptionError("Transaction WAL header is invalid");
    }
    if (
      ![
        "prepared",
        "committing",
        "rolling_back",
        "rolled_back",
        "committed",
        "recovery_conflict",
      ].includes(manifest.state)
    ) {
      throw new CorruptionError("Transaction WAL state is invalid");
    }
    const keys = new Set();
    for (const [index, operation] of manifest.operations.entries()) {
      try {
        normalizeEntityType(operation.entity_type);
        validateLogicalId(operation.entity_id);
      } catch (error) {
        throw new CorruptionError("Transaction WAL contains an unsafe entity", { cause: error });
      }
      if (operation.index !== index || !PREVIEW_ID_PATTERN.test(operation.preview_id ?? "")) {
        throw new CorruptionError("Transaction WAL operation identity is invalid");
      }
      const key = `${operation.entity_type}:${operation.entity_id}`;
      if (keys.has(key)) throw new CorruptionError("Transaction WAL writes an entity twice");
      keys.add(key);
      if (
        typeof operation.after_markdown !== "string" ||
        sha256(operation.after_markdown) !== operation.after_markdown_sha256 ||
        typeof operation.after_content_sha256 !== "string" ||
        !["prepared", "applying", "applied", "recovery_detected", "rolling_back", "rolled_back"].includes(
          operation.phase,
        )
      ) {
        throw new CorruptionError("Transaction WAL after-state hash is invalid");
      }
      let afterEntity;
      try {
        afterEntity = parseCanonicalMarkdown(operation.after_markdown, {
          entity_type: operation.entity_type,
          entity_id: operation.entity_id,
        });
      } catch (error) {
        throw new CorruptionError("Transaction WAL after-state Markdown is invalid", {
          cause: error,
        });
      }
      if (
        afterEntity.revision !== operation.after_revision ||
        afterEntity.content_sha256 !== operation.after_content_sha256 ||
        operation.after_revision !== operation.before_revision + 1
      ) {
        throw new CorruptionError("Transaction WAL after-state entity hash is invalid");
      }
      if (operation.before_exists) {
        if (
          typeof operation.before_markdown !== "string" ||
          sha256(operation.before_markdown) !== operation.before_markdown_sha256 ||
          typeof operation.before_content_sha256 !== "string" ||
          !Number.isSafeInteger(operation.before_revision) ||
          operation.before_revision < 1
        ) {
          throw new CorruptionError("Transaction WAL before-state hash is invalid");
        }
        let beforeEntity;
        try {
          beforeEntity = parseCanonicalMarkdown(operation.before_markdown, {
            entity_type: operation.entity_type,
            entity_id: operation.entity_id,
          });
        } catch (error) {
          throw new CorruptionError("Transaction WAL before-state Markdown is invalid", {
            cause: error,
          });
        }
        if (
          beforeEntity.revision !== operation.before_revision ||
          beforeEntity.content_sha256 !== operation.before_content_sha256
        ) {
          throw new CorruptionError("Transaction WAL before-state entity hash is invalid");
        }
      } else if (
        operation.before_markdown !== null ||
        operation.before_markdown_sha256 !== null ||
        operation.before_content_sha256 !== null ||
        operation.before_revision !== 0
      ) {
        throw new CorruptionError("Transaction WAL nonexistent before-state is invalid");
      }
    }
    return manifest;
  }

  async #readTransaction(filename) {
    const transactionId = path.basename(filename, ".json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(filename, "utf8"));
    } catch (error) {
      throw new CorruptionError(`Transaction WAL ${transactionId} is invalid`, { cause: error });
    }
    return this.#validateTransactionManifest(manifest, transactionId);
  }

  async #readCanonicalRaw(entityType, entityId) {
    const filename = await this.#entityPath(entityType, entityId);
    let info;
    try {
      info = await lstat(filename);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CorruptionError("Canonical entity is not a regular file");
    }
    const markdown = await readFile(filename, "utf8");
    return { filename, markdown, markdown_sha256: sha256(markdown) };
  }

  #rawMatchesBefore(raw, operation) {
    return operation.before_exists
      ? raw?.markdown_sha256 === operation.before_markdown_sha256
      : raw === null;
  }

  async #restoreTransactionOperation(manifest, operation) {
    const current = await this.#readCanonicalRaw(operation.entity_type, operation.entity_id);
    if (current?.markdown_sha256 !== operation.after_markdown_sha256) {
      throw new CorruptionError(
        `Refusing to roll back ${operation.entity_type} ${operation.entity_id}: canonical state changed after the batch write`,
      );
    }

    if (operation.before_exists) {
      await atomicWriteFile(current.filename, operation.before_markdown);
    } else {
      await unlink(current.filename);
      await syncDirectory(path.dirname(current.filename));
    }
    const restored = await this.#readCanonicalRaw(operation.entity_type, operation.entity_id);
    if (!this.#rawMatchesBefore(restored, operation)) {
      throw new CorruptionError(
        `Transaction rollback verification failed for ${operation.entity_type} ${operation.entity_id}`,
      );
    }
    operation.phase = "rolled_back";
    operation.rolled_back_at = this.clock().toISOString();
    await this.#writeTransaction(manifest);
  }

  async #rollbackTransactionUnlocked(manifest, failure) {
    const touchedPhases = new Set(["applying", "applied", "recovery_detected", "rolling_back"]);
    const candidates = [];
    const conflicts = [];

    for (const operation of manifest.operations) {
      if (!touchedPhases.has(operation.phase)) continue;
      const current = await this.#readCanonicalRaw(operation.entity_type, operation.entity_id);
      if (current?.markdown_sha256 === operation.after_markdown_sha256) {
        if (operation.phase === "applying") {
          operation.phase = "recovery_detected";
          operation.recovery_detected_applied = true;
          operation.recovery_detected_at = this.clock().toISOString();
        }
        candidates.push(operation);
      } else if (this.#rawMatchesBefore(current, operation)) {
        operation.phase = "rolled_back";
        operation.rolled_back_at = this.clock().toISOString();
      } else {
        conflicts.push({
          entity_type: operation.entity_type,
          entity_id: operation.entity_id,
          expected_after_markdown_sha256: operation.after_markdown_sha256,
          actual_markdown_sha256: current?.markdown_sha256 ?? null,
        });
      }
    }

    if (conflicts.length) {
      manifest.state = "recovery_conflict";
      manifest.recovery_conflict_at = this.clock().toISOString();
      manifest.recovery_conflicts = conflicts;
      manifest.failure = failure instanceof Error ? failure.message : String(failure ?? "power loss");
      await this.#writeTransaction(manifest);
      throw new CorruptionError(
        "Incomplete transaction has concurrent canonical changes; automatic rollback was refused",
      );
    }

    manifest.state = "rolling_back";
    manifest.rollback_started_at ??= this.clock().toISOString();
    manifest.failure = failure instanceof Error ? failure.message : String(failure ?? "power loss");
    await this.#writeTransaction(manifest);
    for (const operation of [...candidates].reverse()) {
      await this.#restoreTransactionOperation(manifest, operation);
    }
    manifest.state = "rolled_back";
    manifest.rolled_back_at = this.clock().toISOString();
    await this.#writeTransaction(manifest);
    return {
      transaction_id: manifest.transaction_id,
      state: manifest.state,
      recovered_operations: candidates.map((operation) => ({
        entity_type: operation.entity_type,
        entity_id: operation.entity_id,
        detected_after_unfinished_wal: operation.recovery_detected_applied === true,
      })),
    };
  }

  async #recoverTransactionsUnlocked() {
    const directory = await this.#runtimeDirectory("transactions", "store");
    const entries = await readdir(directory, { withFileTypes: true });
    const recovered = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) {
        throw new CorruptionError(`Symlinks are not allowed in transaction WAL: ${entry.name}`);
      }
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".json") ||
        !TRANSACTION_ID_PATTERN.test(path.basename(entry.name, ".json"))
      ) {
        continue;
      }
      const manifest = await this.#readTransaction(path.join(directory, entry.name));
      if (manifest.state === "recovery_conflict") {
        throw new CorruptionError(
          `Transaction ${manifest.transaction_id} requires manual conflict resolution`,
        );
      }
      if (!["prepared", "committing", "rolling_back"].includes(manifest.state)) continue;
      recovered.push(await this.#rollbackTransactionUnlocked(manifest, "unfinished transaction"));
    }
    this._lastRecoveryResults = recovered;
    return recovered;
  }

  async recoverTransactions() {
    await this.initialize();
    return this.#withWriterLockReady(() => this.#recoverTransactionsUnlocked());
  }

  async #prepareRecovery(record, currentMarkdown) {
    const recoveryId = `${this.clock().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    const recoveryDirectory = await this.#runtimeDirectory(
      "recovery",
      entityDirectory(record.entity_type),
      record.entity_id,
    );
    const snapshotName = currentMarkdown ? `${recoveryId}.before.md` : null;
    if (snapshotName) {
      await atomicWriteFile(path.join(recoveryDirectory, snapshotName), currentMarkdown);
    }
    const manifestPath = path.join(recoveryDirectory, `${recoveryId}.json`);
    const manifest = {
      recovery_id: recoveryId,
      state: "prepared",
      prepared_at: this.clock().toISOString(),
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      operation: record.operation,
      before_revision: record.base_revision,
      after_revision: record.proposed_entity?.revision ?? null,
      snapshot: snapshotName,
    };
    await atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { manifest, manifestPath };
  }

  async commit(previewId) {
    return this.#withWriterLock(async () => {
      const prepared = await this.#preparePreviewForCommit(previewId);
      const { record, previewPath, currentState, proposed, proposedMarkdown, target } = prepared;
      const recovery = await this.#prepareRecovery(record, currentState?.markdown ?? null);
      try {
        await this.#fault("single_before_canonical", {
          entity_type: record.entity_type,
          entity_id: record.entity_id,
        });
        await atomicWriteFile(target, proposedMarkdown);
        await this.#fault("single_after_canonical", {
          entity_type: record.entity_type,
          entity_id: record.entity_id,
        });
        const readBack = await this.#readEntity(record.entity_type, record.entity_id);
        if (readBack.content_sha256 !== proposed.content_sha256) {
          throw new CorruptionError("Canonical read-back verification failed");
        }
        recovery.manifest.state = "committed";
        recovery.manifest.committed_at = this.clock().toISOString();
        recovery.manifest.content_sha256 = readBack.content_sha256;
        await atomicWriteFile(
          recovery.manifestPath,
          `${JSON.stringify(recovery.manifest, null, 2)}\n`,
        );
        await unlink(previewPath).catch(() => {});
        return readBack;
      } catch (error) {
        try {
          const visible = await this.#readCanonicalRaw(record.entity_type, record.entity_id);
          if (visible?.markdown_sha256 === sha256(proposedMarkdown)) {
            if (currentState?.markdown) {
              await atomicWriteFile(target, currentState.markdown);
            } else {
              await unlink(target);
              await syncDirectory(path.dirname(target));
            }
          } else if (
            visible?.markdown_sha256 !==
            (currentState?.markdown ? sha256(currentState.markdown) : undefined)
          ) {
            if (!(visible === null && !currentState)) {
              throw new CorruptionError(
                "Single commit failed after canonical state changed concurrently; rollback was refused",
              );
            }
          }
          recovery.manifest.state = "rolled_back";
          recovery.manifest.rolled_back_at = this.clock().toISOString();
          recovery.manifest.failure = error instanceof Error ? error.message : String(error);
          await atomicWriteFile(
            recovery.manifestPath,
            `${JSON.stringify(recovery.manifest, null, 2)}\n`,
          );
        } catch (rollbackError) {
          throw new CorruptionError("Commit failed and automatic recovery also failed", {
            cause: new AggregateError([error, rollbackError]),
          });
        }
        throw error;
      }
    });
  }

  async commitBatch(previewIds) {
    if (
      !Array.isArray(previewIds) ||
      previewIds.length < 1 ||
      previewIds.length > MAX_BATCH_OPERATIONS
    ) {
      throw new ValidationError(
        `previewIds must contain between 1 and ${MAX_BATCH_OPERATIONS} previews`,
      );
    }
    for (const previewId of previewIds) {
      if (typeof previewId !== "string" || !PREVIEW_ID_PATTERN.test(previewId)) {
        throw new ValidationError("previewIds contains an invalid preview_id");
      }
    }
    if (new Set(previewIds).size !== previewIds.length) {
      throw new ValidationError("previewIds cannot contain duplicates");
    }

    return this.#withWriterLock(async () => {
      const prepared = [];
      const entityKeys = new Set();
      for (const previewId of previewIds) {
        const operation = await this.#preparePreviewForCommit(previewId);
        const key = `${operation.record.entity_type}:${operation.record.entity_id}`;
        if (entityKeys.has(key)) {
          throw new ValidationError("A batch cannot write the same entity twice");
        }
        entityKeys.add(key);
        prepared.push(operation);
      }

      const transactionId = randomUUID();
      const createdAt = this.clock().toISOString();
      const manifest = {
        version: 1,
        transaction_id: transactionId,
        transaction_id_sha256: sha256(transactionId),
        state: "prepared",
        prepared_at: createdAt,
        operations: prepared.map((operation, index) => ({
          index,
          preview_id: operation.previewId,
          entity_type: operation.record.entity_type,
          entity_id: operation.record.entity_id,
          before_exists: operation.currentState !== null,
          before_revision: operation.currentState?.entity.revision ?? 0,
          before_content_sha256: operation.currentState?.entity.content_sha256 ?? null,
          before_markdown_sha256: operation.currentState
            ? sha256(operation.currentState.markdown)
            : null,
          before_markdown: operation.currentState?.markdown ?? null,
          after_revision: operation.proposed.revision,
          after_content_sha256: operation.proposed.content_sha256,
          after_markdown_sha256: sha256(operation.proposedMarkdown),
          after_markdown: operation.proposedMarkdown,
          phase: "prepared",
        })),
      };
      await this.#writeTransaction(manifest);

      try {
        await this.#fault("batch_after_prepare_wal", { transaction_id: transactionId });
        manifest.state = "committing";
        manifest.commit_started_at = this.clock().toISOString();
        await this.#writeTransaction(manifest);
        const entities = [];
        for (const [index, operation] of prepared.entries()) {
          const walOperation = manifest.operations[index];
          const visibleBefore = await this.#readCanonicalRaw(
            operation.record.entity_type,
            operation.record.entity_id,
          );
          if (!this.#rawMatchesBefore(visibleBefore, walOperation)) {
            throw new ConflictError(
              `Canonical content changed before batch operation ${index + 1} was applied`,
            );
          }
          walOperation.phase = "applying";
          walOperation.apply_started_at = this.clock().toISOString();
          await this.#writeTransaction(manifest);
          await this.#fault("batch_before_canonical", {
            transaction_id: transactionId,
            operation_index: index,
            entity_type: operation.record.entity_type,
            entity_id: operation.record.entity_id,
          });

          await atomicWriteFile(operation.target, operation.proposedMarkdown);
          await this.#fault("batch_after_canonical_before_wal", {
            transaction_id: transactionId,
            operation_index: index,
            entity_type: operation.record.entity_type,
            entity_id: operation.record.entity_id,
          });
          const readBack = await this.#readEntity(
            operation.record.entity_type,
            operation.record.entity_id,
          );
          if (readBack.content_sha256 !== operation.proposed.content_sha256) {
            throw new CorruptionError("Batch canonical read-back verification failed");
          }
          entities.push(readBack);
          walOperation.phase = "applied";
          walOperation.applied_at = this.clock().toISOString();
          await this.#writeTransaction(manifest);
        }

        for (const [index, operation] of prepared.entries()) {
          const visibleAfter = await this.#readCanonicalRaw(
            operation.record.entity_type,
            operation.record.entity_id,
          );
          if (visibleAfter?.markdown_sha256 !== manifest.operations[index].after_markdown_sha256) {
            throw new CorruptionError(
              `Canonical state changed before batch transaction ${transactionId} was finalized`,
            );
          }
        }

        manifest.state = "committed";
        manifest.committed_at = this.clock().toISOString();
        await this.#writeTransaction(manifest);
        await Promise.allSettled(prepared.map((operation) => unlink(operation.previewPath)));
        return { transaction_id: transactionId, entities };
      } catch (error) {
        try {
          await this.#rollbackTransactionUnlocked(manifest, error);
        } catch (rollbackError) {
          throw new CorruptionError("Batch commit failed and safe rollback could not complete", {
            cause: new AggregateError([error, rollbackError]),
          });
        }
        throw error;
      }
    });
  }

  async remove(entityType, entityId, { baseRevision, retainRecovery = true } = {}) {
    const normalizedType = normalizeEntityType(entityType);
    const normalizedId = validateLogicalId(entityId);
    const expectedRevision = validateBaseRevision(baseRevision);
    if (expectedRevision === 0) {
      throw new ConflictError("Removing an entity requires an existing base revision");
    }

    return this.#withWriterLock(async () => {
      const currentState = await this.#readEntity(normalizedType, normalizedId, {
        includeMarkdown: true,
      });
      if (!currentState) {
        throw new NotFoundError(`${normalizedType} ${normalizedId} was not found`);
      }
      if (currentState.entity.revision !== expectedRevision) {
        throw new ConflictError(
          `Revision conflict: expected ${expectedRevision}, current revision is ${currentState.entity.revision}`,
        );
      }

      if (typeof retainRecovery !== "boolean") {
        throw new ValidationError("retainRecovery must be a boolean");
      }
      const recovery = retainRecovery
        ? await this.#prepareRecovery(
            {
              entity_type: normalizedType,
              entity_id: normalizedId,
              operation: "remove",
              base_revision: expectedRevision,
              proposed_entity: null,
            },
            currentState.markdown,
          )
        : null;
      const target = currentState.filename;
      try {
        await this.#fault("remove_before_canonical", {
          entity_type: normalizedType,
          entity_id: normalizedId,
        });
        await unlink(target);
        await syncDirectory(path.dirname(target));
        await this.#fault("remove_after_canonical", {
          entity_type: normalizedType,
          entity_id: normalizedId,
        });
        const readBack = await this.#readEntity(normalizedType, normalizedId);
        if (readBack !== null) {
          throw new CorruptionError("Canonical remove read-back verification failed");
        }
        const removedAt = this.clock().toISOString();
        if (recovery) {
          recovery.manifest.state = "committed";
          recovery.manifest.committed_at = removedAt;
          recovery.manifest.removed_content_sha256 = currentState.entity.content_sha256;
          await atomicWriteFile(
            recovery.manifestPath,
            `${JSON.stringify(recovery.manifest, null, 2)}\n`,
          );
        } else {
          const recoveryDirectory = await this.#runtimeDirectory(
            "recovery",
            entityDirectory(normalizedType),
            normalizedId,
          );
          await rm(recoveryDirectory, { recursive: true, force: true });
        }
        return {
          entity_type: normalizedType,
          entity_id: normalizedId,
          removed_revision: expectedRevision,
          removed_at: removedAt,
          recovery_id: recovery?.manifest.recovery_id ?? null,
        };
      } catch (error) {
        try {
          await atomicWriteFile(target, currentState.markdown);
          const restored = await this.#readEntity(normalizedType, normalizedId);
          if (restored?.content_sha256 !== currentState.entity.content_sha256) {
            throw new CorruptionError("Canonical remove rollback verification failed");
          }
          if (recovery) {
            recovery.manifest.state = "rolled_back";
            recovery.manifest.rolled_back_at = this.clock().toISOString();
            recovery.manifest.failure = error instanceof Error ? error.message : String(error);
            await atomicWriteFile(
              recovery.manifestPath,
              `${JSON.stringify(recovery.manifest, null, 2)}\n`,
            );
          }
        } catch (rollbackError) {
          throw new CorruptionError("Remove failed and automatic recovery also failed", {
            cause: new AggregateError([error, rollbackError]),
          });
        }
        throw error;
      }
    });
  }
}

export async function createIntelligenceStore(options) {
  const store = new IntelligenceStore(options);
  await store.initialize();
  return store;
}

export function resolveDefaultStorePaths(environment = process.env) {
  return loadLocalConfig({ env: environment });
}
