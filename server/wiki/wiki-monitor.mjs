import { createHash } from "node:crypto";
import {
  lstat as nodeLstat,
  readdir as nodeReaddir,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
} from "node:fs/promises";
import path from "node:path";
import {
  containsExcludedSegment,
  parseExcludedSegments,
} from "../privacy/excluded-segments.mjs";

export const DEFAULT_FULL_RECONCILE_INTERVAL_MS = 5 * 60 * 1_000;
export const DEFAULT_MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;

const READ_ONLY_FS = Object.freeze({
  lstat: nodeLstat,
  readdir: nodeReaddir,
  readFile: nodeReadFile,
  realpath: nodeRealpath,
});

const REQUIRED_FS_METHODS = Object.freeze(["lstat", "readdir", "readFile", "realpath"]);

export class WikiMonitorError extends Error {
  constructor(message, { code = "wiki_monitor_error", relativePath } = {}) {
    super(message);
    this.name = "WikiMonitorError";
    this.code = code;
    this.relativePath = relativePath;
  }
}

export class WikiPathSecurityError extends WikiMonitorError {
  constructor(message, { code = "unsafe_wiki_path", relativePath } = {}) {
    super(message, { code, relativePath });
    this.name = "WikiPathSecurityError";
  }
}

function normalizeClockValue(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("clock must return a valid Date or timestamp");
  }
  return date;
}

function toPortableRelative(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function fromPortableRelative(relativePath) {
  return relativePath.split("/").join(path.sep);
}

function relativeSegments(relativePath) {
  return toPortableRelative(relativePath)
    .split("/")
    .filter(Boolean);
}

function isMarkdownPath(relativePath) {
  return path.extname(relativePath).toLocaleLowerCase("en-US") === ".md";
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function makeObsidianUri(vaultName, relativePath) {
  const uri = new URL("obsidian://open");
  uri.searchParams.set("vault", vaultName);
  uri.searchParams.set("file", toPortableRelative(relativePath));
  return uri.toString();
}

function freezeEntry(entry) {
  return Object.freeze({ ...entry });
}

function sortEntries(entries) {
  return entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

function publicIndex(index) {
  return Object.freeze(sortEntries([...index.values()].map((entry) => freezeEntry(entry))));
}

function comparableStat(left, right) {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function diffIndexes(previous, current) {
  const added = [];
  const modified = [];
  const metadataChanged = [];
  const deleted = [];

  for (const [key, entry] of current) {
    const before = previous.get(key);
    if (!before) {
      added.push(freezeEntry(entry));
    } else if (before.sha256 !== entry.sha256) {
      modified.push(Object.freeze({ before: freezeEntry(before), after: freezeEntry(entry) }));
    } else if (before.mtime_ms !== entry.mtime_ms || before.size !== entry.size) {
      metadataChanged.push(
        Object.freeze({ before: freezeEntry(before), after: freezeEntry(entry) }),
      );
    }
  }

  for (const [key, entry] of previous) {
    if (!current.has(key)) deleted.push(freezeEntry(entry));
  }

  sortEntries(added);
  modified.sort((left, right) => left.after.relative_path.localeCompare(right.after.relative_path));
  metadataChanged.sort((left, right) =>
    left.after.relative_path.localeCompare(right.after.relative_path),
  );
  sortEntries(deleted);

  return {
    added: Object.freeze(added),
    modified: Object.freeze(modified),
    metadata_changed: Object.freeze(metadataChanged),
    deleted: Object.freeze(deleted),
  };
}

export function createS0S8HandoffDraft(entry, { changeType, observedAt, excludedSegments } = {}) {
  if (!entry || typeof entry !== "object" || !entry.relative_path || !entry.sha256) {
    throw new TypeError("A valid Wiki allowlist entry is required");
  }
  if (!isMarkdownPath(entry.relative_path) || containsExcludedSegment(entry.relative_path, excludedSegments)) {
    throw new WikiPathSecurityError("The source is not eligible for Wiki ingest handoff", {
      code: "ineligible_wiki_source",
      relativePath: entry.relative_path,
    });
  }

  const normalizedChange = changeType === "modified" ? "modified" : "added";
  const timestamp = observedAt ? new Date(observedAt) : new Date();
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("observedAt must be a valid date");

  return Object.freeze({
    handoff_id: `wiki-${entry.sha256.slice(0, 16)}-${normalizedChange}`,
    handoff_type: "wiki_s0_s8_verification_draft",
    status: "draft_requires_human_acceptance",
    detected_change: normalizedChange,
    observed_at: timestamp.toISOString(),
    source: Object.freeze({
      relative_path: entry.relative_path,
      sha256: entry.sha256,
      obsidian_uri: entry.obsidian_uri,
      size: entry.size,
      mtime: entry.mtime,
    }),
    evidence_status: "requires_s0_s8_confirmation",
    source_content_included: false,
    source_instructions_are_executable: false,
    write_target: null,
    pipeline: Object.freeze(
      Array.from({ length: 9 }, (_, index) =>
        Object.freeze({ step: `S${index}`, status: "pending" }),
      ),
    ),
  });
}

export class WikiReadOnlyMonitor {
  #clock;
  #fs;
  #fullReconcileIntervalMs;
  #index = new Map();
  #initialized = false;
  #lastFullReconcileAtMs = null;
  #maxMarkdownBytes;
  #excludedSegments;
  #pendingHints = new Set();
  #rootAbsolute;
  #rootReal;
  #vaultName;
  #vaultRelativePrefix;

  constructor({
    wikiRoot,
    vaultName,
    vaultRelativePrefix = "",
    fsImpl = READ_ONLY_FS,
    clock = () => new Date(),
    fullReconcileIntervalMs = DEFAULT_FULL_RECONCILE_INTERVAL_MS,
    maxMarkdownBytes = DEFAULT_MAX_MARKDOWN_BYTES,
    excludedSegments,
  } = {}) {
    if (typeof wikiRoot !== "string" || !wikiRoot.trim()) {
      throw new TypeError("wikiRoot is required");
    }
    for (const method of REQUIRED_FS_METHODS) {
      if (typeof fsImpl?.[method] !== "function") {
        throw new TypeError(`fsImpl.${method} must be a function`);
      }
    }
    if (!Number.isFinite(fullReconcileIntervalMs) || fullReconcileIntervalMs < 1_000) {
      throw new TypeError("fullReconcileIntervalMs must be at least 1000 milliseconds");
    }
    if (!Number.isSafeInteger(maxMarkdownBytes) || maxMarkdownBytes < 1) {
      throw new TypeError("maxMarkdownBytes must be a positive safe integer");
    }

    this.#rootAbsolute = path.resolve(wikiRoot);
    this.#vaultName = vaultName?.trim() || path.basename(this.#rootAbsolute);
    if (typeof vaultRelativePrefix !== "string" || path.isAbsolute(vaultRelativePrefix)) {
      throw new TypeError("vaultRelativePrefix must be a relative path");
    }
    const normalizedPrefix = toPortableRelative(path.normalize(vaultRelativePrefix)).replace(/^\.\/?/, "").replace(/\/$/, "");
    if (normalizedPrefix === ".." || normalizedPrefix.startsWith("../")) {
      throw new TypeError("vaultRelativePrefix cannot escape the vault");
    }
    this.#vaultRelativePrefix = normalizedPrefix;
    this.#fs = fsImpl;
    this.#clock = clock;
    this.#fullReconcileIntervalMs = fullReconcileIntervalMs;
    this.#maxMarkdownBytes = maxMarkdownBytes;
    this.#excludedSegments = parseExcludedSegments(excludedSegments);
  }

  get initialized() {
    return this.#initialized;
  }

  get lastFullReconcileAt() {
    return this.#lastFullReconcileAtMs == null
      ? null
      : new Date(this.#lastFullReconcileAtMs).toISOString();
  }

  getAllowlistIndex() {
    return publicIndex(this.#index);
  }

  async readIndexedMarkdown(candidatePath) {
    await this.#prepareRoot();
    const relativePath = this.#normalizeCandidate(candidatePath);
    const indexed = this.#index.get(relativePath);
    if (!indexed) {
      throw new WikiPathSecurityError("Markdown file is not present in the verified allowlist", {
        code: "wiki_source_not_allowlisted",
        relativePath,
      });
    }

    const absolute = path.resolve(this.#rootAbsolute, fromPortableRelative(relativePath));
    await this.#assertSafeExistingPath(absolute, relativePath);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await this.#fs.lstat(absolute);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new WikiPathSecurityError("Only regular Markdown files may be read", {
          code: "non_regular_wiki_file",
          relativePath,
        });
      }
      if (before.size > this.#maxMarkdownBytes) {
        throw new WikiMonitorError("Markdown file exceeds the configured indexing limit", {
          code: "wiki_file_too_large",
          relativePath,
        });
      }

      const content = await this.#fs.readFile(absolute);
      const after = await this.#fs.lstat(absolute);
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (
        comparableStat(before, after)
        && content.byteLength === after.size
        && sha256 === indexed.sha256
      ) {
        return Object.freeze({
          entry: freezeEntry(indexed),
          text: content.toString("utf8"),
        });
      }
    }

    throw new WikiMonitorError("Markdown file changed after it was indexed", {
      code: "wiki_entry_changed_since_index",
      relativePath,
    });
  }

  recordEventHint(candidatePath) {
    const relativePath = this.#normalizeCandidate(candidatePath);
    if (containsExcludedSegment(relativePath, this.#excludedSegments)) {
      throw new WikiPathSecurityError("The path is inside a permanently excluded subtree", {
        code: "prohibited_wiki_subtree",
        relativePath,
      });
    }
    this.#pendingHints.add(relativePath);
    return relativePath;
  }

  async initialize() {
    return this.reconcile({ forceFull: true });
  }

  async reconcile({ forceFull = false, hints = [] } = {}) {
    const observedAt = normalizeClockValue(this.#clock);
    for (const hint of hints) this.recordEventHint(hint);
    await this.#prepareRoot();

    const fullDue =
      !this.#initialized ||
      forceFull ||
      this.#lastFullReconcileAtMs == null ||
      observedAt.getTime() - this.#lastFullReconcileAtMs >= this.#fullReconcileIntervalMs;

    const previous = new Map(this.#index);
    const rejected = [];
    let mode;

    if (fullDue) {
      mode = "full";
      const next = new Map();
      await this.#scanDirectory(this.#rootAbsolute, "", next, rejected);
      this.#index = next;
      this.#pendingHints.clear();
      this.#lastFullReconcileAtMs = observedAt.getTime();
      this.#initialized = true;
    } else {
      mode = "hint";
      const queued = [...this.#pendingHints];
      this.#pendingHints.clear();
      for (const relativePath of queued) {
        await this.#reconcileHint(relativePath, rejected);
      }
    }

    const changes = diffIndexes(previous, this.#index);
    const handoffDrafts = [
      ...changes.added.map((entry) =>
        createS0S8HandoffDraft(entry, { changeType: "added", observedAt, excludedSegments: this.#excludedSegments }),
      ),
      ...changes.modified.map(({ after }) =>
        createS0S8HandoffDraft(after, { changeType: "modified", observedAt, excludedSegments: this.#excludedSegments }),
      ),
    ];

    return Object.freeze({
      mode,
      observed_at: observedAt.toISOString(),
      full_reconcile_due_at: new Date(
        this.#lastFullReconcileAtMs + this.#fullReconcileIntervalMs,
      ).toISOString(),
      allowlist_index: this.getAllowlistIndex(),
      added: changes.added,
      modified: changes.modified,
      metadata_changed: changes.metadata_changed,
      deleted: changes.deleted,
      rejected: Object.freeze(rejected.map((item) => Object.freeze({ ...item }))),
      handoff_drafts: Object.freeze(handoffDrafts),
    });
  }

  #normalizeCandidate(candidatePath) {
    if (typeof candidatePath !== "string" || !candidatePath.trim()) {
      throw new WikiPathSecurityError("Event hint path is required", {
        code: "invalid_wiki_hint",
      });
    }
    const supplied = candidatePath.trim();
    const absolute = path.isAbsolute(supplied)
      ? path.resolve(supplied)
      : path.resolve(this.#rootAbsolute, fromPortableRelative(supplied));
    if (!isWithin(this.#rootAbsolute, absolute)) {
      throw new WikiPathSecurityError("Event hint escapes wikiRoot", {
        code: "wiki_path_escape",
        relativePath: supplied,
      });
    }
    return toPortableRelative(path.relative(this.#rootAbsolute, absolute));
  }

  async #prepareRoot() {
    if (this.#rootReal) return;
    const rootStat = await this.#fs.lstat(this.#rootAbsolute);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new WikiPathSecurityError("wikiRoot must be a real directory, not a link", {
        code: "unsafe_wiki_root",
      });
    }
    this.#rootReal = await this.#fs.realpath(this.#rootAbsolute);
  }

  async #assertSafeExistingPath(absolute, relativePath) {
    if (containsExcludedSegment(relativePath, this.#excludedSegments)) {
      throw new WikiPathSecurityError("The path is inside a permanently excluded subtree", {
        code: "prohibited_wiki_subtree",
        relativePath,
      });
    }

    let cursor = this.#rootAbsolute;
    for (const segment of relativeSegments(relativePath)) {
      cursor = path.join(cursor, segment);
      const stats = await this.#fs.lstat(cursor);
      if (stats.isSymbolicLink()) {
        throw new WikiPathSecurityError("Symbolic links and junctions are excluded", {
          code: "linked_wiki_path",
          relativePath,
        });
      }
    }

    const resolved = await this.#fs.realpath(absolute);
    if (!isWithin(this.#rootReal, resolved)) {
      throw new WikiPathSecurityError("Resolved Wiki path escapes wikiRoot", {
        code: "resolved_wiki_path_escape",
        relativePath,
      });
    }
  }

  async #assertSafeAncestors(relativePath) {
    let cursor = this.#rootAbsolute;
    const segments = relativeSegments(relativePath);
    for (const segment of segments.slice(0, -1)) {
      cursor = path.join(cursor, segment);
      let stats;
      try {
        stats = await this.#fs.lstat(cursor);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      if (stats.isSymbolicLink()) {
        throw new WikiPathSecurityError("Symbolic links and junctions are excluded", {
          code: "linked_wiki_path",
          relativePath,
        });
      }
      const resolved = await this.#fs.realpath(cursor);
      if (!isWithin(this.#rootReal, resolved)) {
        throw new WikiPathSecurityError("Resolved Wiki path escapes wikiRoot", {
          code: "resolved_wiki_path_escape",
          relativePath,
        });
      }
    }
  }

  async #readMarkdownEntry(absolute, relativePath) {
    if (!isMarkdownPath(relativePath) || containsExcludedSegment(relativePath, this.#excludedSegments)) return null;
    await this.#assertSafeExistingPath(absolute, relativePath);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await this.#fs.lstat(absolute);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new WikiPathSecurityError("Only regular Markdown files may be indexed", {
          code: "non_regular_wiki_file",
          relativePath,
        });
      }
      if (before.size > this.#maxMarkdownBytes) {
        throw new WikiMonitorError("Markdown file exceeds the configured indexing limit", {
          code: "wiki_file_too_large",
          relativePath,
        });
      }

      const content = await this.#fs.readFile(absolute);
      const after = await this.#fs.lstat(absolute);
      if (comparableStat(before, after) && content.byteLength === after.size) {
        const mtimeMs = Math.trunc(after.mtimeMs);
        return freezeEntry({
          relative_path: toPortableRelative(relativePath),
          mtime: new Date(after.mtimeMs).toISOString(),
          mtime_ms: mtimeMs,
          size: after.size,
          sha256: createHash("sha256").update(content).digest("hex"),
          obsidian_uri: makeObsidianUri(
            this.#vaultName,
            this.#vaultRelativePrefix
              ? `${this.#vaultRelativePrefix}/${toPortableRelative(relativePath)}`
              : relativePath,
          ),
        });
      }
    }

    throw new WikiMonitorError("Markdown file changed while it was being indexed", {
      code: "volatile_wiki_file",
      relativePath,
    });
  }

  async #scanDirectory(absoluteDirectory, relativeDirectory, target, rejected) {
    if (containsExcludedSegment(relativeDirectory, this.#excludedSegments)) return;
    if (relativeDirectory) {
      await this.#assertSafeExistingPath(absoluteDirectory, relativeDirectory);
    }

    const entries = await this.#fs.readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = toPortableRelative(path.join(relativeDirectory, entry.name));
      if (containsExcludedSegment(relativePath, this.#excludedSegments)) continue;
      const absolute = path.join(absoluteDirectory, entry.name);

      if (entry.isSymbolicLink()) {
        rejected.push({ relative_path: relativePath, reason: "linked_wiki_path" });
        continue;
      }
      if (entry.isDirectory()) {
        try {
          await this.#scanDirectory(absolute, relativePath, target, rejected);
        } catch (error) {
          if (!(error instanceof WikiPathSecurityError)) throw error;
          rejected.push({ relative_path: relativePath, reason: error.code });
        }
        continue;
      }
      if (!entry.isFile() || !isMarkdownPath(relativePath)) continue;

      try {
        const record = await this.#readMarkdownEntry(absolute, relativePath);
        if (record) target.set(record.relative_path, record);
      } catch (error) {
        if (!(error instanceof WikiMonitorError)) throw error;
        rejected.push({ relative_path: relativePath, reason: error.code });
      }
    }
  }

  async #reconcileHint(relativePath, rejected) {
    if (containsExcludedSegment(relativePath, this.#excludedSegments)) return;
    const absolute = path.resolve(this.#rootAbsolute, fromPortableRelative(relativePath));
    if (!isWithin(this.#rootAbsolute, absolute)) {
      throw new WikiPathSecurityError("Event hint escapes wikiRoot", {
        code: "wiki_path_escape",
        relativePath,
      });
    }

    try {
      await this.#assertSafeAncestors(relativePath);
    } catch (error) {
      if (!(error instanceof WikiPathSecurityError)) throw error;
      this.#removeIndexedPrefix(relativePath);
      rejected.push({ relative_path: relativePath, reason: error.code });
      return;
    }

    let stats;
    try {
      stats = await this.#fs.lstat(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#removeIndexedPrefix(relativePath);
      return;
    }

    if (stats.isSymbolicLink()) {
      this.#removeIndexedPrefix(relativePath);
      rejected.push({ relative_path: relativePath, reason: "linked_wiki_path" });
      return;
    }
    if (stats.isDirectory()) {
      const scanned = new Map();
      try {
        await this.#scanDirectory(absolute, relativePath, scanned, rejected);
      } catch (error) {
        if (!(error instanceof WikiMonitorError)) throw error;
        this.#removeIndexedPrefix(relativePath);
        rejected.push({ relative_path: relativePath, reason: error.code });
        return;
      }
      this.#removeIndexedPrefix(relativePath);
      for (const [key, record] of scanned) this.#index.set(key, record);
      return;
    }
    if (!stats.isFile() || !isMarkdownPath(relativePath)) {
      this.#index.delete(relativePath);
      return;
    }

    try {
      const record = await this.#readMarkdownEntry(absolute, relativePath);
      if (record) this.#index.set(record.relative_path, record);
    } catch (error) {
      if (!(error instanceof WikiMonitorError)) throw error;
      this.#index.delete(relativePath);
      rejected.push({ relative_path: relativePath, reason: error.code });
    }
  }

  #removeIndexedPrefix(relativePath) {
    const portable = toPortableRelative(relativePath).replace(/\/$/, "");
    const prefix = portable ? `${portable}/` : "";
    for (const key of this.#index.keys()) {
      if (!portable || key === portable || key.startsWith(prefix)) this.#index.delete(key);
    }
  }
}

export async function buildWikiAllowlistIndex(options) {
  const monitor = new WikiReadOnlyMonitor(options);
  const result = await monitor.initialize();
  return result.allowlist_index;
}

export function createWikiReadOnlyMonitor(options) {
  return new WikiReadOnlyMonitor(options);
}
