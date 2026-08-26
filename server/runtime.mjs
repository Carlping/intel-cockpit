import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createIntelligenceStore,
  NotFoundError,
  resolveDefaultStorePaths,
} from "./store/index.mjs";
import { createApiHandler, recoverPendingBatches } from "./api/index.mjs";
import {
  TelegramConnector,
  createDpapiSecretStore,
  createDpapiTelegramAllowlistStore,
  createDpapiTelegramGroupStore,
  createDpapiTelegramSensorStore,
  createEncryptedRawUpdateStore,
  createFileCheckpointStore,
  createTruflationConnector,
  listOfficialFeedSpecs,
  pollOfficialFeed,
  routeObservation,
} from "./connectors/index.mjs";
import { createWikiReadOnlyMonitor } from "./wiki/index.mjs";
import {
  createDailyBackup,
  createDisabledTtsAdapter,
  inspectRuntimeStorageHealth,
  lintCanonicalState,
  maintainRuntimeArtifacts,
  projectDecisionBrief,
} from "./ops/index.mjs";
import { prepareRuntimeDirectory } from "./runtime-boundary.mjs";
import {
  createAlpacaIexMarketAdapter,
  createForwardIntelligenceEngine,
} from "./forward-intelligence/index.mjs";
import { createEvidenceLoopEngine } from "./evidence-loop/index.mjs";
import { containsExcludedSegment } from "./privacy/excluded-segments.mjs";

const TELEGRAM_RETRY_MS = 60_000;
const RAW_SUCCESS_RETENTION_MS = 24 * 60 * 60 * 1_000;
const QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DERIVED_ENTITY_TYPES = Object.freeze(["Situation", "Mission", "Review"]);
const WIKI_RECONCILE_MS = 5 * 60 * 1_000;
const WIKI_DIGEST_PATH = /^digests\/\d{4}-\d{2}-\d{2}\.md$/i;
const WIKI_LOG_PATH = /^log\.md$/i;
const WIKI_PRESENTATION_VERSION = 2;

function cleanWikiLine(value) {
  return String(value || "")
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/^\s*(?:#{1,6}|>|[-*+]\s+)\s*/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedWikiText(value, limit = 760) {
  const text = cleanWikiLine(value);
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function latestLogBlock(markdown) {
  const headings = [...String(markdown).matchAll(/^## \[(\d{4}-\d{2}-\d{2})\][^\n]*$/gm)];
  if (!headings.length) return String(markdown);
  const latestDate = headings.map((match) => match[1]).sort().at(-1);
  const selected = headings.find((match) => match[1] === latestDate) || headings[0];
  const start = selected.index ?? 0;
  const next = headings.find((match) => (match.index ?? 0) > start);
  return String(markdown).slice(start, next?.index ?? String(markdown).length);
}

function extractWikiDecisionBrief(markdown, relativePath) {
  const source = WIKI_LOG_PATH.test(relativePath) ? latestLogBlock(markdown) : String(markdown);
  const lines = source
    .replace(/^---\s*[\s\S]*?\n---\s*/u, "")
    .split(/\r?\n/)
    .map((line) => ({ raw: line, clean: cleanWikiLine(line) }))
    .filter((line) => line.clean);
  const unique = (values, limit) => [...new Set(values.filter(Boolean))].slice(0, limit);
  const changed = unique(lines
    .filter(({ clean }) => /今天知識庫變聰明的一點|對本庫最重要的單一新事實|內容要點|本篇核心/u.test(clean))
    .map(({ clean }) => boundedWikiText(clean.replace(/^(?:今天知識庫變聰明的一點|對本庫最重要的單一新事實|內容要點|本篇核心)\s*[：:]?\s*/u, ""))), 3);
  const watchCandidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/watchlist 命中|關注清單命中/u.test(lines[index].clean)) continue;
    const inline = boundedWikiText(
      lines[index].clean.replace(/^.*?(?:watchlist 命中|關注清單命中)\s*[：:]?\s*/u, ""),
      420,
    );
    if (inline) watchCandidates.push(inline);
    for (const next of lines.slice(index + 1, index + 7)) {
      if (/^\s*#{1,2}\s/u.test(next.raw)) break;
      if (/^\s*[-*+]\s+/u.test(next.raw)) watchCandidates.push(boundedWikiText(next.clean, 420));
    }
  }
  const watchHits = unique(watchCandidates, 5);
  const unknowns = unique(lines
    .filter(({ clean }) => /待裁決|待核|尚未|無法證實|矛盾|衝突|限制/u.test(clean))
    .map(({ clean }) => boundedWikiText(clean, 520)), 2);
  const fallback = lines.find(({ raw, clean }) => !/^\s*#/u.test(raw) && clean.length >= 80)?.clean;
  const whatChanged = changed.length ? changed.join("\n") : boundedWikiText(fallback || "");
  if (whatChanged.length < 40) return null;
  const date = relativePath.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  const logHeading = lines.find(({ raw }) => /^## \[/u.test(raw))?.clean;
  return Object.freeze({
    title: WIKI_LOG_PATH.test(relativePath)
      ? `Wiki ingest｜${logHeading || "最新批次"}`
      : `Wiki ingest digest｜${date || "最新批次"}`,
    what_changed: whatChanged,
    why_relevant: watchHits.length
      ? `命中既有關注：${watchHits.join("；")}`
      : "這是已完成 Wiki ingest 的批次變化；只在此層判斷是否值得升級為 Situation／Watch。",
    still_unknown: unknowns.length
      ? unknowns.join("\n")
      : "尚未由情報層判定是否構成 Situation 的實質變化。",
  });
}

function isWikiDecisionBatchPath(relativePath) {
  return WIKI_DIGEST_PATH.test(relativePath) || WIKI_LOG_PATH.test(relativePath);
}

async function readRuntimeJson(filename, fallback) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return structuredClone(fallback);
    throw error;
  }
}

async function writeRuntimeJson(runtimeRoot, filename, value) {
  await prepareRuntimeDirectory(runtimeRoot, path.dirname(filename));
  const temporary = `${filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filename);
}

function observationKey(observation) {
  return `${observation.external_event_id}:${observation.content_hash}`;
}

function digest(value, length = 32) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, length);
}

function entityIdForObservation(observation) {
  return `inbox-${digest(observation.external_event_id)}`;
}

function entityContext(entity) {
  return {
    id: entity.entity_id,
    created_at: entity.created_at,
    updated_at: entity.updated_at,
    ...entity.payload,
  };
}

export function watchContext(situations) {
  return situations.flatMap((entity) =>
    (Array.isArray(entity.payload?.watch_conditions)
      ? entity.payload.watch_conditions
      : []
    ).map((watch, index) => ({
      id: `${entity.entity_id}:watch:${index}`,
      parent_situation_id: entity.entity_id,
      status: entity.payload.status,
      ...(typeof watch === "string" ? { text: watch } : watch),
    })),
  );
}

function observationPayload(observation, routing, domain) {
  const payload = {
    title: observation.title || `External observation · ${observation.feed_id}`,
    status: "new",
    domain: domain || "world",
    source_type: observation.feed_id.startsWith("telegram.")
      ? "telegram"
      : observation.feed_id === "wiki.read-only"
        ? "wiki_read_only"
        : observation.evidence_status === "manual_snapshot"
          ? "manual_snapshot"
          : "official_feed",
    source_url: observation.source_url,
    external_event_id: observation.external_event_id,
    feed_id: observation.feed_id,
    evidence_status: observation.evidence_status,
    summary: observation.summary || "",
    published_at: observation.published_at || null,
    observed_at: observation.observed_at,
    as_of: observation.as_of,
    content_hash: observation.content_hash,
    coverage_state: observation.coverage_state,
    license_ref: observation.license_ref,
    matched_interest_ids: routing.matched_context.map((match) => match.id),
    matched_context: routing.matched_context.map((match) => ({ kind: match.kind, id: match.id })),
    relevance_score: routing.relevance_score,
    routing_state: routing.route,
    routing_reason: routing.reason,
    requires_decision: routing.notify,
    material_change: false,
    material_change_candidate: routing.notify,
    materiality: observation.materiality,
    untrusted_external_content: observation.untrusted_external_content !== false,
    source_payload: observation.payload || {},
  };
  if (routing.notify) {
    payload.adjustment_draft = {
      state: "awaiting_user_review",
      before: "保留既有 Situation 判斷，尚未自動改寫。",
      now: observation.summary || observation.title || "新的第一手觀察已命中監看條件。",
      impact: "請選擇 Accept／Edit／Watch／Dismiss；系統不會自動建立 Mission。",
    };
  }
  return payload;
}

const EXPLICIT_INPUT_SOURCE_TYPES = new Set([
  "telegram",
  "manual_snapshot",
  "manual_url",
  "manual_file",
  "internal_plan_reference",
  "user_submit",
]);

export function isExplicitUserInputForRouting(entity) {
  const payload = entity?.payload;
  if (!payload || payload.status === "not_relevant") return false;
  if (payload.triage?.actor === "user") return true;
  return EXPLICIT_INPUT_SOURCE_TYPES.has(payload.source_type);
}

function scoreOfficialMateriality(observation) {
  if (observation.materiality !== "unscored") return observation;
  const text = `${observation.title || ""}\n${observation.summary || ""}`.toLocaleLowerCase("en-US");
  const highImpact = /\b(emergency|unscheduled|fomc statement|rate decision|final rule|critical vulnerability|national emergency)\b/;
  return Object.freeze({
    ...observation,
    materiality: highImpact.test(text) ? "high" : "medium",
  });
}

function payloadReferences(value, ids) {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) return value.some((item) => payloadReferences(item, ids));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => payloadReferences(item, ids));
}

function collectDependencyIds(value, key = "", result = new Set()) {
  if (typeof value === "string") {
    if (
      /(?:^|_)(?:source_)?(?:inbox|situation|mission)(?:_ids?|Id|Ids)?$/i.test(key) ||
      /^(?:inbox|situation|mission)-[a-z0-9-]+$/.test(value)
    ) result.add(value);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDependencyIds(item, key, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [childKey, child] of Object.entries(value)) {
    collectDependencyIds(child, childKey, result);
  }
  return result;
}

const REMOVED_REFERENCE = Symbol("removed-reference");
const WITHDRAWN_CONTENT = "[withdrawn Telegram source content]";

function stripSourceContributions(value, ids) {
  if (typeof value === "string") return ids.has(value) ? REMOVED_REFERENCE : value;
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(item && typeof item === "object" && payloadReferences(item, ids)))
      .map((item) => stripSourceContributions(item, ids))
      .filter((item) => item !== REMOVED_REFERENCE);
  }
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      child &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      payloadReferences(child, ids)
    ) {
      continue;
    }
    const cleaned = stripSourceContributions(child, ids);
    if (cleaned !== REMOVED_REFERENCE) result[key] = cleaned;
  }
  return result;
}

function collectWithdrawnContentFragments(payload) {
  const fragments = new Set();
  const add = (value) => {
    if (typeof value !== "string") return;
    const normalized = value.trim();
    if (normalized.length >= 3) fragments.add(normalized);
  };
  const collectNestedContent = (value) => {
    if (typeof value === "string") {
      add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectNestedContent(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:chat|sender|message|update|user|bot)_?id$/i.test(key)) continue;
      collectNestedContent(child);
    }
  };

  add(payload?.title);
  add(payload?.summary);
  add(payload?.observation?.title);
  add(payload?.observation?.summary);
  collectNestedContent(payload?.source_payload);
  collectNestedContent(payload?.observation?.payload);
  return [...fragments].sort((left, right) => right.length - left.length);
}

function redactWithdrawnContent(value, fragments) {
  if (typeof value === "string") {
    let redacted = value;
    for (const fragment of fragments) {
      if (redacted.includes(fragment)) redacted = redacted.replaceAll(fragment, WITHDRAWN_CONTENT);
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactWithdrawnContent(item, fragments));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      redactWithdrawnContent(child, fragments),
    ]),
  );
}

function withdrawnSourceTrace(sources, invalidatedAt) {
  return sources.map((source) => ({
    source_type: "telegram",
    source_entity_id: source.entity_id,
    source_content_sha256: source.content_sha256,
    invalidated_at: invalidatedAt,
    content_redacted: true,
  }));
}

function invalidationPayload(entityType, invalidatedAt, withdrawnSources = []) {
  const common = {
    source_invalidated: true,
    invalidated_at: invalidatedAt,
    invalidation_reason: "Telegram contributor invoked deletion or revocation.",
    invalidated_sources: withdrawnSourceTrace(withdrawnSources, invalidatedAt),
    requires_decision: false,
  };
  if (entityType === "Situation") {
    return {
      ...common,
      title: "已因來源撤回而失效的 Situation",
      status: "closed",
      current_assessment: "原始依據已撤回；此判斷不得再作為決策依據。",
      before: "原 Situation 曾存在。",
      now: "來源已撤回，內容已清除。",
      watch_conditions: ["若有獨立且可驗證的新來源，再建立新的 Situation。"],
      stop_condition: "不得使用已撤回來源。",
      reopen_condition: "取得獨立且可追溯的新證據。",
      next_review_at: invalidatedAt,
      evidence: [
        { kind: "unknown", text: "來源撤回已被系統確認，但原內容已不再可驗證。" },
        { kind: "inference", text: "原判斷可能已失去支持。" },
        { kind: "unknown", text: "目前不知道是否存在獨立替代來源。" },
        { kind: "contradiction", text: "不得把已刪除內容當作仍有效的證據。" },
      ],
    };
  }
  if (entityType === "Mission") {
    return {
      ...common,
      title: "已因來源撤回而取消的 Mission",
      objective: "原始依據已撤回；不得繼續執行。",
      status: "cancelled",
      why_now: "來源撤回需要立即停止依賴該來源的行動。",
      next_action: "不執行；等待獨立新證據。",
      done_condition: "Mission 保持取消且不再引用撤回內容。",
      review_date: invalidatedAt,
      stop_condition: "來源已撤回。",
      reopen_condition: "建立不依賴撤回資料的新 Mission。",
    };
  }
  return {
    ...common,
    title: "已因來源撤回而失效的 Review",
    mission_id: "withdrawn-source",
    reviewed_at: invalidatedAt,
    outcome: "來源已撤回，原 Review 內容已清除。",
    assessment_change: "原結論失效。",
    next_state: "等待獨立新證據。",
  };
}

async function replaceWithInvalidationTombstone(
  store,
  entity,
  invalidatedAt,
  withdrawnSources,
) {
  await store.remove(entity.entity_type, entity.entity_id, {
    baseRevision: entity.revision,
    retainRecovery: false,
  });
  const preview = await store.preview({
    operation: "create",
    entity_type: entity.entity_type,
    entity_id: entity.entity_id,
    base_revision: 0,
    payload: invalidationPayload(entity.entity_type, invalidatedAt, withdrawnSources),
  });
  await store.commit(preview.preview_id);
}

async function replaceWithPartialInvalidation(
  store,
  entity,
  removedReferences,
  withdrawnSources,
  withdrawnFragments,
  invalidatedAt,
) {
  const withoutContributions = stripSourceContributions(entity.payload, removedReferences);
  const payload = redactWithdrawnContent(withoutContributions, withdrawnFragments);
  payload.source_invalidated = "partial";
  payload.invalidated_at = invalidatedAt;
  payload.invalidation_reason = "One referenced Telegram source was withdrawn; remaining evidence needs review.";
  payload.invalidated_sources = [
    ...(Array.isArray(payload.invalidated_sources) ? payload.invalidated_sources : []),
    ...withdrawnSourceTrace(withdrawnSources, invalidatedAt),
  ];
  payload.requires_decision = true;
  if (entity.entity_type === "Situation" && payload.status !== "closed") {
    payload.status = "watch";
    payload.material_change = true;
  }
  if (entity.entity_type === "Mission" && !["completed", "cancelled"].includes(payload.status)) {
    payload.status = "blocked";
  }
  await store.remove(entity.entity_type, entity.entity_id, {
    baseRevision: entity.revision,
    retainRecovery: false,
  });
  const preview = await store.preview({
    operation: "create",
    entity_type: entity.entity_type,
    entity_id: entity.entity_id,
    base_revision: 0,
    payload,
  });
  await store.commit(preview.preview_id);
}

export async function forgetCanonicalTelegramData(
  store,
  { chatId, userId, messageId, clock = () => new Date() } = {},
) {
  const inbox = await store.list("InboxItem");
  const removedInboxIds = new Set();
  const withdrawnSources = [];
  const withdrawnFragments = new Set();
  for (const entity of inbox) {
    const payload = entity.payload;
    if (payload?.source_type !== "telegram") continue;
    const source = payload.source_payload || {};
    if (chatId != null && String(source.chat_id) !== String(chatId)) continue;
    if (userId != null && String(source.sender_id) !== String(userId)) continue;
    if (messageId != null && String(source.message_id) !== String(messageId)) continue;
    withdrawnSources.push({
      entity_id: entity.entity_id,
      content_sha256: entity.content_sha256,
    });
    for (const fragment of collectWithdrawnContentFragments(payload)) {
      withdrawnFragments.add(fragment);
    }
    await store.remove("InboxItem", entity.entity_id, {
      baseRevision: entity.revision,
      retainRecovery: false,
    });
    removedInboxIds.add(entity.entity_id);
  }

  const invalidatedIds = new Set();
  const partiallyInvalidatedIds = new Set();
  const taintedReferences = new Set(removedInboxIds);
  const fullyInvalidReferences = new Set(removedInboxIds);
  const invalidatedAt = clock().toISOString();
  for (const entityType of DERIVED_ENTITY_TYPES) {
    for (const entity of await store.list(entityType)) {
      if (!payloadReferences(entity.payload, taintedReferences)) continue;
      const dependencies = collectDependencyIds(entity.payload);
      const matchedDependencies = new Set(
        [...dependencies].filter((dependency) => taintedReferences.has(dependency)),
      );
      if (!matchedDependencies.size) continue;
      const solelyDependent =
        dependencies.size > 0 &&
        [...dependencies].every((dependency) => fullyInvalidReferences.has(dependency));
      if (solelyDependent) {
        await replaceWithInvalidationTombstone(
          store,
          entity,
          invalidatedAt,
          withdrawnSources,
        );
        invalidatedIds.add(entity.entity_id);
        fullyInvalidReferences.add(entity.entity_id);
      } else {
        await replaceWithPartialInvalidation(
          store,
          entity,
          removedInboxIds,
          withdrawnSources,
          [...withdrawnFragments],
          invalidatedAt,
        );
        partiallyInvalidatedIds.add(entity.entity_id);
      }
      taintedReferences.add(entity.entity_id);
    }
  }
  return {
    removed: removedInboxIds.size,
    removed_entity_ids: [...removedInboxIds],
    invalidated: invalidatedIds.size,
    invalidated_entity_ids: [...invalidatedIds],
    partially_invalidated: partiallyInvalidatedIds.size,
    partially_invalidated_entity_ids: [...partiallyInvalidatedIds],
  };
}

async function purgeRuntimeTextArtifacts(runtimeRoot, needles) {
  const unique = [...new Set(needles.filter(Boolean).map(String))];
  if (!unique.length) return 0;
  const roots = ["previews", "recovery", "transactions", "exports", "quarantine"]
    .map((directory) => path.join(runtimeRoot, directory));
  let removed = 0;
  async function treeContainsNeedle(target) {
    const info = await lstat(target).catch(() => null);
    if (!info || info.isSymbolicLink()) return false;
    if (info.isDirectory()) {
      for (const entry of await readdir(target)) {
        if (await treeContainsNeedle(path.join(target, entry))) return true;
      }
      return false;
    }
    if (!info.isFile() || info.size > 16 * 1024 * 1024) return false;
    const content = await readFile(target, "utf8").catch(() => "");
    return unique.some((needle) => content.includes(needle));
  }
  async function visit(target) {
    const info = await lstat(target).catch(() => null);
    if (!info || info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of await readdir(target)) await visit(path.join(target, entry));
      return;
    }
    if (!info.isFile() || info.size > 16 * 1024 * 1024) return;
    const content = await readFile(target, "utf8").catch(() => "");
    if (!unique.some((needle) => content.includes(needle))) return;
    await rm(target, { force: true });
    removed += 1;
  }
  for (const root of roots) await visit(root);
  const dailyBackupRoot = path.join(runtimeRoot, "backups", "daily");
  for (const entry of await readdir(dailyBackupRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const snapshot = path.join(dailyBackupRoot, entry.name);
    if (!(await treeContainsNeedle(snapshot))) continue;
    await rm(snapshot, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function getOptional(store, entityType, entityId) {
  try {
    return await store.get(entityType, entityId);
  } catch (error) {
    if (error instanceof NotFoundError || error?.code === "NOT_FOUND") return null;
    throw error;
  }
}

async function commitObservation(store, observation, routing, { domain, force = false } = {}) {
  const insufficientContent = !force
    && (typeof observation.summary !== "string" || observation.summary.trim().length < 40);
  const quiet = !force && (routing.route === "quiet_inbox" || insufficientContent);
  if (quiet) return { disposition: "quiet_discarded", entity: null };
  const entityId = entityIdForObservation(observation);
  const current = await getOptional(store, "InboxItem", entityId);
  const currentPresentation = current?.payload?.source_payload?.presentation_version ?? 0;
  const nextPresentation = observation.payload?.presentation_version ?? 0;
  if (
    current?.payload?.content_hash === observation.content_hash
    && currentPresentation === nextPresentation
  ) {
    return { disposition: "duplicate", entity: current };
  }
  const preview = await store.preview({
    operation: current ? "update" : "create",
    entity_type: "InboxItem",
    entity_id: entityId,
    base_revision: current?.revision ?? 0,
    payload: observationPayload(observation, routing, domain),
  });
  return {
    disposition: current ? "updated" : "created",
    entity: await store.commit(preview.preview_id),
  };
}

async function buildRoutingContext(store) {
  const [situations, missions, inbox] = await Promise.all([
    store.list("Situation"),
    store.list("Mission"),
    store.list("InboxItem", { limit: 200 }),
  ]);
  return {
    situations: situations.map(entityContext),
    missions: missions.map(entityContext),
    watchConditions: watchContext(situations),
    interests: [
      { id: "world", title: "world intelligence", keywords: ["Fed", "CPI", "AI", "policy", "geopolitics", "cybersecurity"] },
    ],
    // Automated feeds must not recursively teach the relevance router what the
    // user cares about. Only explicit submissions, curated Wiki changes, manual
    // observations, or a recorded human triage decision count as recent input.
    recentInputs: inbox.filter(isExplicitUserInputForRouting).map(entityContext),
  };
}

function briefText(briefing) {
  const paragraphs = Array.isArray(briefing?.transcript)
    ? briefing.transcript
    : ["今日沒有需要你立即處理的新情報。系統會繼續監看既有 Situation 與 Feed。"];
  const sources = Array.isArray(briefing?.sources)
    ? briefing.sources.map((source) => `${source.id || "S"} · ${source.title}\n${source.href}`)
    : [];
  const sourceBlock = sources.length ? `\n\n來源\n${sources.join("\n")}` : "";
  const header = `今日 Decision Brief · ${briefing?.state || "quiet"}\n\n`;
  const maximumBody = Math.max(500, 4096 - header.length - sourceBlock.length - 24);
  let body = paragraphs.join("\n\n");
  if (body.length > maximumBody) body = `${body.slice(0, maximumBody - 10).trimEnd()}\n[節錄]`;
  return `${header}${body}${sourceBlock}`.slice(0, 4096);
}

async function statusText(getHealth) {
  const reports = await getHealth();
  return [
    "IntelOS Connector Status",
    ...reports.map(
      (report) =>
        `• ${report.feed_id || report.connector_id}: ${report.state || report.health_state || "unknown"}`,
    ),
  ].join("\n");
}

function canonicalCitation(entity) {
  return {
    title: `${entity.entity_type}: ${entity.entity_id}`,
    href: `intel-os://entity/${encodeURIComponent(entity.entity_type)}/${encodeURIComponent(entity.entity_id)}?revision=${entity.revision}`,
    as_of: entity.updated_at || entity.created_at || null,
  };
}

function directEvidenceSources(entity) {
  const evidence = Array.isArray(entity.payload?.evidence) ? entity.payload.evidence : [];
  return evidence.flatMap((item) => {
    const href = item?.source_url || item?.href;
    if (typeof href !== "string" || !href.trim()) return [];
    // Private Telegram transport locators are resolved through source_inbox_ids
    // below so a Brief cites the canonical Inbox record without chat/message IDs.
    if (href.startsWith("telegram:")) return [];
    return [{
      title: item.source_title || item.label || item.text || "Evidence source",
      href,
      as_of: item.as_of || item.observed_at || null,
    }];
  });
}

function referencedInboxIds(entity) {
  const payload = entity.payload ?? {};
  const ids = [
    ...(Array.isArray(payload.source_inbox_ids) ? payload.source_inbox_ids : []),
    ...(Array.isArray(payload.evidence)
      ? payload.evidence.map((item) => item?.source_inbox_id)
      : []),
  ];
  return [...new Set(ids.filter((value) => typeof value === "string" && value.trim()))];
}

async function hydrateBriefSources(store, entity) {
  if (Array.isArray(entity.payload?.sources) && entity.payload.sources.length) return entity;
  if (typeof entity.payload?.source_url === "string" && entity.payload.source_url.trim()) return entity;

  const sources = directEvidenceSources(entity);
  for (const inboxId of referencedInboxIds(entity)) {
    const inbox = await getOptional(store, "InboxItem", inboxId);
    if (!inbox) continue;
    const sourceUrl = inbox.payload?.source_url;
    sources.push(
      typeof sourceUrl === "string" && sourceUrl.startsWith("telegram:")
        ? canonicalCitation(inbox)
        : typeof sourceUrl === "string" && sourceUrl.trim()
          ? {
              title: inbox.payload?.source_title || inbox.payload?.title || "Inbox evidence",
              href: sourceUrl,
              as_of: inbox.payload?.as_of || inbox.updated_at || null,
            }
          : canonicalCitation(inbox),
    );
  }
  const unique = [...new Map(sources.map((source) => [source.href, source])).values()];
  if (!unique.length) return entity;
  return {
    ...entity,
    payload: { ...entity.payload, sources: unique },
  };
}

export async function selectBriefItems(store) {
  const [inbox, situations, missions] = await Promise.all([
    store.list("InboxItem"),
    store.list("Situation"),
    store.list("Mission"),
  ]);
  const candidates = [
    ...inbox.filter(
      (item) => item.payload?.status === "new" && item.payload?.requires_decision === true,
    ),
    ...situations.filter(
      (item) => item.payload?.requires_decision === true || item.payload?.material_change === true,
    ),
    ...missions.filter(
      (item) => ["active", "blocked"].includes(item.payload?.status) && item.payload?.next_action,
    ),
  ];
  const seen = new Set();
  const selected = candidates.filter((item) => {
    const key = `${item.entity_type}:${item.entity_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
  return Promise.all(selected.map((item) => hydrateBriefSources(store, item)));
}

function newYorkClockParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    minuteOfDay: Number(value.hour) * 60 + Number(value.minute),
  };
}

export async function createIntelRuntime({
  paths,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  startCollectors = true,
  wikiFsImpl,
} = {}) {
  const resolvedPaths = paths ?? resolveDefaultStorePaths();
  const store = await createIntelligenceStore(resolvedPaths);
  await recoverPendingBatches(store);
  const runtimeRoot = resolvedPaths.runtimeRoot;
  const runtimeStateRoot = path.join(runtimeRoot, "state");
  const officialStatePath = path.join(runtimeStateRoot, "official-feed-baselines.json");
  const evidenceLoopStatePath = path.join(runtimeStateRoot, "fact-context-reaction.json");
  const wikiStatePath = path.join(runtimeStateRoot, "wiki-allowlist-index.json");
  const officialState = await readRuntimeJson(officialStatePath, { version: 1, feeds: {} });
  const persistedWikiState = await readRuntimeJson(wikiStatePath, { version: 1, entries: null });
  if (!officialState.feeds || typeof officialState.feeds !== "object" || Array.isArray(officialState.feeds)) {
    officialState.feeds = {};
  }
  const secretStore = createDpapiSecretStore({
    baseDir: path.join(runtimeRoot, "secrets"),
    runtimeRoot,
  });
  const forwardIntelligence = createForwardIntelligenceEngine({
    stateStore: secretStore,
    fetchImpl,
    clock,
  });
  await forwardIntelligence.initialize();
  const marketReaction = createAlpacaIexMarketAdapter({
    secretStore,
    fetchImpl,
    clock,
    symbols: ["SPY", "QQQ", "IWM", "TLT", "UUP", "GLD", "GOOG", "GOOGL", "TSLA", "TSM", "ASML"],
  });
  await marketReaction.initialize();
  const checkpointStore = createFileCheckpointStore({
    baseDir: path.join(runtimeRoot, "checkpoints"),
    runtimeRoot,
  });
  const rawStore = createEncryptedRawUpdateStore({
    baseDir: path.join(runtimeRoot, "encrypted-telegram"),
    runtimeRoot,
  });
  const allowlistStore = createDpapiTelegramAllowlistStore({ secretStore });
  const telegramGroupStore = createDpapiTelegramGroupStore({ secretStore, clock });
  const telegramSensorStore = createDpapiTelegramSensorStore({ secretStore, clock });
  const truflation = createTruflationConnector({
    apiEnabled: false,
    apiKeyStore: secretStore,
    fetchImpl,
    clock,
  });
  const wikiMonitor = createWikiReadOnlyMonitor({
    wikiRoot: resolvedPaths.wikiRoot,
    vaultName: path.basename(resolvedPaths.vaultRoot),
    vaultRelativePrefix: path.relative(resolvedPaths.vaultRoot, resolvedPaths.wikiRoot),
    excludedSegments: resolvedPaths.excludedSegments,
    clock,
    fullReconcileIntervalMs: WIKI_RECONCILE_MS,
    ...(wikiFsImpl ? { fsImpl: wikiFsImpl } : {}),
  });
  let wikiBaselineReady = Array.isArray(persistedWikiState.entries);
  let wikiPersistedEntries = new Map(
    (Array.isArray(persistedWikiState.entries) ? persistedWikiState.entries : [])
      .map((entry) => [entry.relative_path, entry]),
  );
  let wikiHealth = {
    feed_id: "wiki.read-only",
    state: "degraded",
    checked_at: clock().toISOString(),
    coverage_state: "unknown",
    message: "Waiting for the first read-only Wiki allowlist index",
  };

  const feedHealth = new Map(
    listOfficialFeedSpecs().map((feed) => [
      feed.feed_id,
      {
        feed_id: feed.feed_id,
        state: feed.enabled ? "degraded" : "disabled",
        checked_at: clock().toISOString(),
        coverage_state: "unknown",
        message: feed.enabled ? "Waiting for first poll" : feed.disabled_reason,
      },
    ]),
  );
  const timers = new Set();
  let stopped = false;
  let telegramTimer = null;
  let telegramPolling = false;
  let currentBriefing = await projectDecisionBrief({
    items: await selectBriefItems(store),
    ttsAdapter: createDisabledTtsAdapter("Alpha transcript-only mode"),
    clock,
  });
  let lastDailyRun = null;
  let operationsHealth = {
    feed_id: "operations.daily",
    state: "degraded",
    checked_at: clock().toISOString(),
    coverage_state: "unknown",
    message: "Waiting for the first 07:30 ET brief and daily backup",
  };
  let runtimeStorageHealth;
  try {
    runtimeStorageHealth = await inspectRuntimeStorageHealth({ store, clock });
  } catch (error) {
    runtimeStorageHealth = {
      feed_id: "operations.runtime-storage",
      state: "degraded",
      checked_at: clock().toISOString(),
      coverage_state: "unknown",
      message: error instanceof Error
        ? `Runtime storage preflight failed: ${error.message}`
        : "Runtime storage preflight failed",
      level: "warning",
      scope: "runtime_metadata_only",
    };
  }

  let telegram;

  async function deliverForwardNotification(result, preferredChatId) {
    if (!result?.signal || !result.notification_text || !telegram) return;
    const deliveries = Array.isArray(result.signal.deliveries) ? result.signal.deliveries : [];
    const deliveredChats = new Set(deliveries.map((delivery) => String(delivery.chat_id)));
    for (const delivery of deliveries) {
      try {
        await telegram.editText?.({
          chatId: delivery.chat_id,
          messageId: delivery.message_id,
          text: result.notification_text,
        });
        await forwardIntelligence.markDelivery({
          signalId: result.signal.id,
          chatId: delivery.chat_id,
          messageId: delivery.message_id,
          kind: "flash_update",
        });
      } catch {
        // The original Bot message may have been deleted. A new message is sent
        // only to the active submitting chat below, avoiding notification fan-out.
      }
    }
    if (preferredChatId == null || deliveredChats.has(String(preferredChatId))) return;
    const sent = await telegram.sendText?.({
      chatId: preferredChatId,
      text: result.notification_text,
    });
    if (sent?.message_id != null) {
      await forwardIntelligence.markDelivery({
        signalId: result.signal.id,
        chatId: preferredChatId,
        messageId: sent.message_id,
        kind: "flash",
      });
    }
  }

  const inboxSink = async ({ observation }) => {
    if (observation?.feed_id === "telegram.explicit-submit") {
      const rapid = await forwardIntelligence.ingestObservation(observation);
      if (rapid) {
        const chatId = observation.payload?.chat_id;
        const hasChatDelivery = rapid.signal.deliveries?.some(
          (delivery) => String(delivery.chat_id) === String(chatId),
        );
        if (rapid.should_notify || !hasChatDelivery) {
          await deliverForwardNotification(rapid, chatId);
        }
      }
    }
    const context = await buildRoutingContext(store);
    const routing = routeObservation(observation, { ...context, now: clock() });
    const committed = await commitObservation(store, routing.observation, routing, {
      domain: "world",
      force: true,
    });
    if (["created", "updated"].includes(committed.disposition) && routing.notify) {
      await refreshBriefing();
    }
    return committed;
  };

  inboxSink.forget = async ({ chat_id: chatId, user_id: userId, message_id: messageId }) => {
    const result = await forgetCanonicalTelegramData(store, {
      chatId,
      userId,
      messageId,
      clock,
    });
    const privacyFragments = [
      ...result.removed_entity_ids,
      ...result.invalidated_entity_ids,
      ...result.partially_invalidated_entity_ids,
      userId == null ? null : `\"sender_id\": \"${userId}\"`,
      userId == null ? null : `\"sender_id\":\"${userId}\"`,
      chatId == null || messageId == null ? null : `telegram:${chatId}:${messageId}`,
      chatId == null || messageId == null ? null : `telegram://chat/${chatId}/message/${messageId}`,
    ];
    await purgeRuntimeTextArtifacts(runtimeRoot, privacyFragments);
    return result;
  };

  const sensorSink = async ({ observation, source_key: sourceKey, actor_key: actorKey }) => {
    const context = await buildRoutingContext(store);
    const routing = routeObservation(observation, { ...context, now: clock() });
    return telegramSensorStore.ingest({
      observation: routing.observation,
      routing,
      sourceKey,
      actorKey,
    });
  };

  sensorSink.forget = async ({ chat_id: chatId, user_id: userId, message_id: messageId }) => {
    return telegramSensorStore.forget({ chatId, userId, messageId });
  };

  const commandSink = async ({
    command,
    chat_id: chatId,
    user_id: userId,
    group,
    group_control: groupControl,
  }) => {
    if (!telegram) return { accepted: false };
    if (command.name === "pair") {
      await telegram.sendText?.({
        chatId,
        text: "配對完成。你現在可以使用 /status、/brief，或用 /intel 內容 投稿。",
      });
      return { accepted: true, command: "pair" };
    }
    if (command.name === "brief") {
      await telegram.sendText?.({ chatId, text: briefText(await refreshBriefing()) });
      return { accepted: true, command: "brief" };
    }
    if (command.name === "status") {
      await telegram.sendText?.({ chatId, text: await statusText(getHealth) });
      return { accepted: true, command: "status" };
    }
    if (command.name === "monitor") {
      const privacyBlocked = group?.status === "privacy_mode_blocking";
      await telegram.sendText?.({
        chatId,
        text: privacyBlocked
          ? "群組已登記，但 Telegram Group Privacy 仍開啟。請到 BotFather 關閉 Privacy Mode、把 Bot 移出再重新加入，然後每位成員輸入 /consent。"
          : "私人群組已登記。資料用途：只用於你的本機情報系統；原始訊息加密保存不超過 24 小時。每位成員請輸入 /consent；全員同意前不會保存普通訊息。可用 /pause、/resume、/revoke 控制。",
      });
      return { accepted: true, command: "monitor", status: group?.status };
    }
    if (command.name === "consent") {
      await telegram.sendText?.({
        chatId,
        text: group?.status === "active"
          ? "同意已記錄；全員已同意，群組感測層現在啟用。單一群組消息只會作為未驗證 lead，不會自動建立 Mission 或交易訊號。"
          : `同意已記錄；目前狀態 ${group?.status ?? "pending_consent"}，全員完成前不保存普通訊息。`,
      });
      return { accepted: true, command: "consent", status: group?.status };
    }
    if (groupControl && ["pause", "resume", "revoke"].includes(command.name)) {
      const labels = {
        pause: "群組感測已暫停。",
        resume: group?.status === "active" ? "群組感測已恢復。" : `尚未恢復；目前狀態 ${group?.status ?? "pending_consent"}。`,
        revoke: "群組感測授權已撤回；不再收集新訊息。",
      };
      await telegram.sendText?.({ chatId, text: labels[command.name] });
      return { accepted: true, command: command.name, status: group?.status };
    }
    if (command.name === "forget" || command.name === "forgetme") {
      const messageId = command.name === "forget" && /^\d+$/.test(command.argument)
        ? command.argument
        : undefined;
      if (command.name === "forget" && !messageId) {
        await telegram.sendText?.({
          chatId,
          text: "請使用 /forget <message_id> 指定要刪除的 Telegram 投稿。",
        });
        return { accepted: true, command: "forget", deleted: false };
      }
      await telegram.forget({
        chatId,
        userId: command.name === "forgetme" ? userId : undefined,
        messageId,
      });
      await telegram.sendText?.({
        chatId,
        text: command.name === "forgetme"
          ? "你的投稿與授權已撤回；可識別的衍生資料已刪除。"
          : "符合範圍的投稿已刪除。",
      });
      if (command.name === "forgetme") await telegram.revoke({ chatId, userId });
      return { accepted: true, command: command.name };
    }
    if (command.name === "revoke") {
      await telegram.revoke({ chatId, userId });
      return { accepted: true, command: "revoke" };
    }
    return { accepted: true, command: command.name };
  };

  telegram = new TelegramConnector({
    tokenStore: secretStore,
    checkpointStore,
    rawStore,
    allowlistStore,
    groupStore: telegramGroupStore,
    inboxSink,
    sensorSink,
    commandSink,
    fetchImpl,
    clock,
  });

  const evidenceLoop = createEvidenceLoopEngine({
    secretStore,
    fetchImpl,
    clock,
    marketAdapter: marketReaction,
    loadState: () => readRuntimeJson(evidenceLoopStatePath, null),
    saveState: (value) => writeRuntimeJson(runtimeRoot, evidenceLoopStatePath, value),
    onFact: async (observation) => {
      await inboxSink({ observation });
      await forwardIntelligence.ingestObservation(observation);
    },
  });
  await evidenceLoop.initialize();

  async function getHealth() {
    return [
      wikiHealth,
      operationsHealth,
      runtimeStorageHealth,
      ...feedHealth.values(),
      telegram.getHealth(),
      truflation.getHealth(),
      forwardIntelligence.getHealth(),
      marketReaction.getHealth(),
      ...evidenceLoop.getHealth(),
    ];
  }

  async function reconcileWiki() {
    try {
      const result = await wikiMonitor.reconcile({ forceFull: !wikiBaselineReady });
      const currentEntries = new Map(
        result.allowlist_index.map((entry) => [entry.relative_path, entry]),
      );
      let changedCount = 0;
      let deletedCount = 0;
      let surfacedCount = 0;
      if (wikiBaselineReady) {
        const changed = [];
        for (const entry of currentEntries.values()) {
          const before = wikiPersistedEntries.get(entry.relative_path);
          if (!before || before.sha256 !== entry.sha256) {
            changed.push({ entry, changeType: before ? "modified" : "added" });
          }
        }
        const deleted = [...wikiPersistedEntries.values()].filter(
          (entry) => !currentEntries.has(entry.relative_path),
        );
        changedCount = changed.length;
        deletedCount = deleted.length;

        // File-level changes belong in Coverage, not in the human decision
        // queue. Only a completed ingest digest (or log-only manual ingest)
        // can become one decision-grade Wiki card.
        const changedDigests = changed
          .filter(({ entry }) => WIKI_DIGEST_PATH.test(entry.relative_path))
          .sort((left, right) => left.entry.relative_path.localeCompare(right.entry.relative_path));
        let batch = changedDigests.at(-1)
          || changed.find(({ entry }) => WIKI_LOG_PATH.test(entry.relative_path));

        // Upgrade one legacy filename-only digest already stored by Alpha v1,
        // without replaying the whole Wiki on a clean first-run baseline.
        if (!batch) {
          const digestEntries = [...currentEntries.values()]
            .filter((entry) => WIKI_DIGEST_PATH.test(entry.relative_path))
            .sort((left, right) => right.relative_path.localeCompare(left.relative_path));
          for (const entry of digestEntries) {
            const legacy = await getOptional(store, "InboxItem", entityIdForObservation({
              external_event_id: `wiki:${entry.relative_path}`,
            }));
            if (legacy && legacy.payload?.source_payload?.decision_grade !== true) {
              batch = { entry, changeType: "presentation_upgrade" };
              break;
            }
          }
        }

        if (batch && isWikiDecisionBatchPath(batch.entry.relative_path)) {
          const source = await wikiMonitor.readIndexedMarkdown(batch.entry.relative_path);
          const brief = extractWikiDecisionBrief(source.text, batch.entry.relative_path);
          if (brief) {
            const observation = {
              external_event_id: `wiki:${batch.entry.relative_path}`,
              feed_id: "wiki.read-only",
              published_at: batch.entry.mtime,
              observed_at: result.observed_at,
              as_of: batch.entry.mtime,
              content_hash: batch.entry.sha256,
              source_url: batch.entry.obsidian_uri,
              evidence_status: "verified",
              matched_interest_ids: [],
              materiality: "medium",
              coverage_state: "complete",
              license_ref: "user_owned_read_only_wiki_digest",
              title: brief.title,
              summary: brief.what_changed,
              payload: {
                wiki_relative_path: batch.entry.relative_path,
                wiki_sha256: batch.entry.sha256,
                source_integrity_status: "hash_verified",
                ingest_verification_required: false,
                s0_s8_state: "completed",
                change_type: batch.changeType,
                presentation_version: WIKI_PRESENTATION_VERSION,
                decision_grade: true,
                source_excerpt_included: true,
                source_content_included: false,
                what_changed: brief.what_changed,
                why_relevant: brief.why_relevant,
                still_unknown: brief.still_unknown,
              },
              untrusted_external_content: true,
            };
            const context = await buildRoutingContext(store);
            const routing = routeObservation(observation, { ...context, now: clock() });
            const committed = await commitObservation(store, routing.observation, routing, {
              domain: "knowledge",
              force: true,
            });
            if (committed.disposition !== "duplicate") surfacedCount += 1;
          }
        }
      }
      await writeRuntimeJson(runtimeRoot, wikiStatePath, {
        version: 1,
        saved_at: result.observed_at,
        entries: [...currentEntries.values()],
      });
      wikiPersistedEntries = currentEntries;
      wikiBaselineReady = true;
      wikiHealth = {
        feed_id: "wiki.read-only",
        state: result.rejected.length ? "degraded" : "healthy",
        checked_at: result.observed_at,
        last_success_at: result.observed_at,
        coverage_state: result.rejected.length ? "partial" : "complete",
        message: `Indexed ${result.allowlist_index.length} eligible Markdown notes; ${changedCount} changed, ${deletedCount} deleted, ${surfacedCount} decision-grade ingest batch; excluded subtrees skipped`,
        rejected_count: result.rejected.length,
      };
      if (surfacedCount) await refreshBriefing();
      return result;
    } catch (error) {
      wikiHealth = {
        feed_id: "wiki.read-only",
        state: "degraded",
        checked_at: clock().toISOString(),
        coverage_state: "unknown",
        message: error instanceof Error ? error.message : "Wiki reconcile failed",
      };
      return null;
    }
  }

  async function refreshBriefing() {
    currentBriefing = await projectDecisionBrief({
      items: await selectBriefItems(store),
      ttsAdapter: createDisabledTtsAdapter("Alpha transcript-only mode"),
      clock,
    });
    return currentBriefing;
  }

  async function runDailyMaintenanceIfDue() {
    const now = clock();
    const local = newYorkClockParts(now);
    if (local.minuteOfDay < 7 * 60 + 30 || lastDailyRun === local.date) return;
    const feedsWaiting = [...feedHealth.values()].some(
      (health) => health.state !== "disabled" && health.coverage_state === "unknown",
    );
    const partialCoverage = feedsWaiting || wikiHealth.coverage_state === "unknown";
    try {
      await refreshBriefing();
      const lint = await lintCanonicalState({ store, quarantineCorrupt: true });
      if (!lint.ok) throw new Error(`Canonical lint found ${lint.invalid_count} invalid files`);
      const backup = await createDailyBackup({ store, timeZone: "America/New_York", clock });
      let retention = null;
      try {
        retention = await maintainRuntimeArtifacts({ store, clock });
        runtimeStorageHealth = retention.health;
      } catch (error) {
        runtimeStorageHealth = {
          ...runtimeStorageHealth,
          feed_id: "operations.runtime-storage",
          state: "degraded",
          checked_at: now.toISOString(),
          coverage_state: "partial",
          message: error instanceof Error
            ? `Backup succeeded, but fail-closed runtime pruning stopped: ${error.message}`
            : "Backup succeeded, but fail-closed runtime pruning stopped",
          level: "warning",
          scope: "runtime_metadata_only",
          last_retention_error_at: now.toISOString(),
        };
      }
      lastDailyRun = local.date;
      const storageDegraded = runtimeStorageHealth.state !== "healthy";
      operationsHealth = {
        feed_id: "operations.daily",
        state: partialCoverage || storageDegraded ? "degraded" : "healthy",
        checked_at: now.toISOString(),
        last_success_at: now.toISOString(),
        coverage_state: partialCoverage || storageDegraded ? "partial" : "complete",
        message: storageDegraded
          ? partialCoverage
            ? `Decision Brief and ${backup.state} daily backup are ready from available evidence; runtime storage and one or more source coverage states need attention`
            : `Decision Brief and ${backup.state} daily backup are ready; runtime storage needs attention`
          : partialCoverage
          ? `Decision Brief and ${backup.state} daily backup are ready from available evidence; one or more sources still have unknown coverage`
          : `Decision Brief and ${backup.state} daily backup are ready`,
        backup_path: backup.backup_path,
        valid_count: lint.valid_count,
        runtime_retention: retention?.pruned ?? null,
        runtime_storage: {
          level: runtimeStorageHealth.level ?? "warning",
          runtime_bytes: runtimeStorageHealth.runtime_bytes ?? null,
          free_bytes: runtimeStorageHealth.free_bytes ?? null,
          total_bytes: runtimeStorageHealth.total_bytes ?? null,
          free_percent: runtimeStorageHealth.free_percent ?? null,
          unsafe_entry_count: runtimeStorageHealth.unsafe_entry_count ?? null,
        },
      };
    } catch (error) {
      operationsHealth = {
        feed_id: "operations.daily",
        state: "degraded",
        checked_at: now.toISOString(),
        coverage_state: "partial",
        message: error instanceof Error ? error.message : "Daily maintenance failed and will retry",
      };
    }
  }

  async function pollOfficial(feed) {
    const result = await pollOfficialFeed(feed.feed_id, { fetchImpl, clock });
    let accepted = 0;
    let quiet = 0;
    let novelCount = 0;
    if (result.ok) {
      const context = await buildRoutingContext(store);
      const prior = officialState.feeds[feed.feed_id];
      if (!prior || !Array.isArray(prior.seen_keys)) {
        quiet = result.observations.length;
        officialState.feeds[feed.feed_id] = {
          initialized_at: clock().toISOString(),
          last_successful_poll_at: clock().toISOString(),
          seen_keys: result.observations.map(observationKey).slice(-5_000),
        };
        await writeRuntimeJson(runtimeRoot, officialStatePath, officialState);
        feedHealth.set(feed.feed_id, {
          ...result.health,
          accepted_count: accepted,
          quiet_count: quiet,
          baseline_count: result.observations.length,
          message: `Baseline established from ${result.observations.length} existing observations; no backlog alerts emitted`,
        });
        return { ...result, baseline_established: true };
      }

      const seen = new Set(prior.seen_keys);
      const novel = result.observations.filter(
        (observation) => !seen.has(observationKey(observation)),
      );
      novelCount = novel.length;
      for (const rawObservation of novel) {
        const observation = scoreOfficialMateriality(rawObservation);
        const routing = routeObservation(observation, { ...context, now: clock() });
        const committed = await commitObservation(store, routing.observation, routing, {
          domain: feed.domain,
        });
        if (committed.disposition.startsWith("quiet_")) quiet += 1;
        else if (committed.disposition !== "duplicate") accepted += 1;
      }
      officialState.feeds[feed.feed_id] = {
        ...prior,
        last_successful_poll_at: clock().toISOString(),
        seen_keys: [...new Set([...prior.seen_keys, ...result.observations.map(observationKey)])]
          .slice(-5_000),
      };
      await writeRuntimeJson(runtimeRoot, officialStatePath, officialState);
      if (accepted > 0) await refreshBriefing();
    }
    feedHealth.set(feed.feed_id, {
      ...result.health,
      accepted_count: accepted,
      quiet_count: quiet,
      new_observation_count: novelCount,
    });
    return result;
  }

  function scheduleOfficialFeeds() {
    const recordFailure = (feed, error) => {
      feedHealth.set(feed.feed_id, {
        feed_id: feed.feed_id,
        state: "error",
        checked_at: clock().toISOString(),
        coverage_state: "unknown",
        message: error instanceof Error ? error.message : "Official feed poll failed",
      });
    };
    for (const feed of listOfficialFeedSpecs({ includeDisabled: false })) {
      const first = setTimeout(() => {
        void pollOfficial(feed).catch((error) => recordFailure(feed, error));
      }, 1_500 + Math.floor(Math.random() * 2_000));
      const interval = setInterval(() => {
        void pollOfficial(feed).catch((error) => recordFailure(feed, error));
      }, feed.poll_interval * 1_000);
      first.unref?.();
      interval.unref?.();
      timers.add(first);
      timers.add(interval);
    }
  }

  function scheduleTelegram(delay = 500) {
    if (stopped || telegramTimer || telegramPolling) return;
    telegramTimer = setTimeout(async () => {
      telegramTimer = null;
      if (stopped) return;
      telegramPolling = true;
      let result;
      try {
        result = await telegram.pollOnce({ timeoutSeconds: 25, limit: 100 });
      } catch {
        result = { ok: false };
      } finally {
        telegramPolling = false;
      }
      scheduleTelegram(result?.ok ? 250 : TELEGRAM_RETRY_MS);
    }, delay);
    telegramTimer.unref?.();
  }

  async function dispatchForwardEventReminders() {
    const [windows, allowlist] = await Promise.all([
      forwardIntelligence.dueReminders(),
      telegram.getAllowlistSnapshot(),
    ]);
    const chatIds = [...new Set((allowlist.pairs ?? []).map((pair) => String(pair.chat_id)))];
    for (const window of windows) {
      for (const chatId of chatIds) {
        if (!await forwardIntelligence.reminderNeeded(window.id, chatId)) continue;
        try {
          const sent = await telegram.sendText({
            chatId,
            text: forwardIntelligence.reminderText(window),
          });
          if (sent?.message_id != null) {
            await forwardIntelligence.markReminder(window.id, chatId, sent.message_id);
          }
        } catch {
          // The next tick retries while the event window remains armed.
        }
      }
    }
  }

  async function runForwardIntelligenceTick() {
    await dispatchForwardEventReminders();
    const verified = await forwardIntelligence.verifyOpenSignals();
    for (const result of verified) {
      await deliverForwardNotification(result, null);
    }
    const signals = await forwardIntelligence.listSignals();
    for (const signal of signals) {
      if (signal.impact_state !== "not_observed") continue;
      const reaction = marketReaction.reactionSince(signal.first_seen_at);
      if (!reaction) continue;
      const updated = await forwardIntelligence.recordMarketReaction(signal.id, reaction);
      if (updated) await deliverForwardNotification(updated, null);
    }
  }

  const telegramGroupPreviews = new Map();
  const signalDispositionPreviews = new Map();
  const previewExpiryMs = 10 * 60 * 1_000;

  function purgeEphemeralPreviews() {
    const now = clock().getTime();
    for (const [key, preview] of telegramGroupPreviews) {
      if (Date.parse(preview.expires_at) <= now) telegramGroupPreviews.delete(key);
    }
    for (const [key, preview] of signalDispositionPreviews) {
      if (Date.parse(preview.expires_at) <= now) signalDispositionPreviews.delete(key);
    }
  }

  async function listTelegramGroups() {
    const snapshot = await telegram.getGroupSnapshot();
    return snapshot.groups.map((group) => ({
      chat_id: group.chat_id,
      status: group.status,
      consent_count: group.consent_user_ids.length,
      member_count: group.member_count,
      privacy_readable: group.privacy_readable,
      paused_reason: group.paused_reason,
      last_message_at: group.last_message_at,
      updated_at: group.updated_at,
    }));
  }

  async function previewTelegramGroupChange(body = {}) {
    purgeEphemeralPreviews();
    const action = body.action ?? "monitor";
    if (!["monitor", "pause", "resume", "revoke"].includes(action)) {
      throw new TypeError("Unsupported Telegram group action");
    }
    const previewId = `tg-group-${randomBytes(12).toString("hex")}`;
    const expiresAt = new Date(clock().getTime() + previewExpiryMs).toISOString();
    let code = null;
    let chatId = null;
    if (action === "monitor") {
      code = randomBytes(5).toString("hex");
    } else {
      chatId = String(body.chat_id ?? "");
      if (!/^-?\d{1,40}$/.test(chatId)) throw new TypeError("chat_id is invalid");
      const group = (await listTelegramGroups()).find((item) => item.chat_id === chatId);
      if (!group) throw new TypeError("Telegram group is not registered");
    }
    const preview = {
      preview_id: previewId,
      action,
      code,
      chat_id: chatId,
      expires_at: expiresAt,
      diff: action === "monitor"
        ? [
            { path: "telegram.group_sensor.mode", before: "explicit_submit_only", after: "pending_private_group_consent" },
            { path: "telegram.group_sensor.retention", before: null, after: "raw 24h · candidates 72h" },
          ]
        : [{ path: `telegram.group_sensor.${chatId}.status`, before: "current", after: action }],
    };
    telegramGroupPreviews.set(previewId, preview);
    return structuredClone(preview);
  }

  async function commitTelegramGroupChange(body = {}) {
    purgeEphemeralPreviews();
    const preview = telegramGroupPreviews.get(body.preview_id);
    if (!preview) throw new TypeError("Telegram group preview is missing or expired");
    telegramGroupPreviews.delete(preview.preview_id);
    if (preview.action === "monitor") {
      telegram.armMonitorCode(preview.code);
      return {
        committed: true,
        action: preview.action,
        monitor_code: preview.code,
        expires_at: preview.expires_at,
      };
    }
    let group;
    if (preview.action === "pause") {
      group = await telegramGroupStore.pause({
        botId: telegram.bot?.id,
        chatId: preview.chat_id,
        reason: "paused_from_local_ui",
      });
    } else if (preview.action === "resume") {
      group = await telegramGroupStore.resume({ botId: telegram.bot?.id, chatId: preview.chat_id });
    } else {
      group = await telegramGroupStore.revoke({ botId: telegram.bot?.id, chatId: preview.chat_id });
    }
    return { committed: true, action: preview.action, group };
  }

  async function listSignals() {
    const [signals, situations] = await Promise.all([
      telegramSensorStore.list(),
      store.list("Situation"),
    ]);
    const byId = new Map(situations.map((situation) => [situation.entity_id, situation]));
    return signals.map((signal) => {
      const situationId = signal.matched_context?.find((item) => item.kind === "situation")?.id;
      const situation = byId.get(situationId);
      return {
        ...signal,
        decision_preview: situation ? {
          situation_id: situation.entity_id,
          situation_title: situation.payload.title,
          before: situation.payload.now ?? situation.payload.current_assessment,
          new_signal: signal.summary,
          verification: signal.status === "corroborated" ? "multi_source_lead" : "unverified_group_lead",
          scenario_probabilities: Array.isArray(situation.payload.scenario_paths)
            ? situation.payload.scenario_paths.map((path) => ({ label: path.label, probability: path.probability }))
            : [],
          probability_change: "尚未套用；需使用者確認訊號方向與情境路徑",
          requires_user_acceptance: true,
        } : null,
      };
    });
  }

  async function previewSignalDispositions(body = {}) {
    purgeEphemeralPreviews();
    const decisions = Array.isArray(body.decisions) ? body.decisions : [body];
    if (!decisions.length || decisions.length > 20) throw new TypeError("decisions must contain 1-20 items");
    const canonicalPreviewIds = [];
    const normalized = [];
    const diff = [];
    for (const decision of decisions) {
      const signalId = String(decision.signal_id ?? "");
      const action = String(decision.action ?? "");
      if (!["interested", "not_interested", "watch", "link_situation"].includes(action)) {
        throw new TypeError("Unsupported signal disposition");
      }
      const signal = await telegramSensorStore.get(signalId);
      if (!signal || ["dismissed", "linked", "interested", "watch"].includes(signal.status)) {
        throw new TypeError("Signal is missing or already decided");
      }
      const situationId = action === "link_situation" ? String(decision.situation_id ?? "") : null;
      if (action === "link_situation" && !(await getOptional(store, "Situation", situationId))) {
        throw new TypeError("Linked Situation is unavailable");
      }
      normalized.push({ signal_id: signalId, action, situation_id: situationId });
      diff.push({ path: `signals.${signalId}.user_disposition`, before: null, after: action });
      if (action === "not_interested") continue;
      const entityId = `inbox-telegram-${signalId}`;
      const current = await getOptional(store, "InboxItem", entityId);
      const status = action === "link_situation" ? "linked" : "watch";
      const preview = await store.preview({
        operation: current ? "update" : "create",
        entity_type: "InboxItem",
        entity_id: entityId,
        base_revision: current?.revision ?? 0,
        payload: {
          title: signal.title,
          status,
          domain: "world",
          source_type: "telegram",
          source_url: signal.source_url,
          external_event_id: signal.id,
          feed_id: "telegram.group-sensor",
          evidence_status: "unverified_external",
          summary: signal.summary,
          observed_at: signal.last_seen_at,
          as_of: signal.last_seen_at,
          coverage_state: "complete",
          license_ref: "private_group_participant_consent",
          matched_interest_ids: situationId
            ? [...new Set([...(signal.matched_interest_ids ?? []), situationId])]
            : signal.matched_interest_ids ?? [],
          materiality: signal.status === "corroborated" ? "high" : "medium",
          requires_decision: false,
          material_change: false,
          material_change_candidate: signal.status === "corroborated",
          untrusted_external_content: true,
          triage: {
            actor: "user",
            decision: action,
            route: situationId ? "link_situation" : "watch",
            decided_at: clock().toISOString(),
          },
          source_payload: {
            sensor_id: signal.id,
            mention_count: signal.mention_count,
            independent_source_count: signal.independent_source_count,
            sensor_status: signal.status,
            attachment_downloaded: false,
            execute_external_content: false,
          },
        },
      });
      canonicalPreviewIds.push(preview.preview_id);
      diff.push(...preview.diff.map((item) => ({
        path: `${signalId}.${item.path}`,
        before: item.before,
        after: item.after,
      })));
    }
    const dispositionPreviewId = `signal-disposition-${randomBytes(12).toString("hex")}`;
    const value = {
      preview_id: dispositionPreviewId,
      canonical_preview_ids: canonicalPreviewIds,
      decisions: normalized,
      diff,
      expires_at: new Date(clock().getTime() + previewExpiryMs).toISOString(),
    };
    signalDispositionPreviews.set(dispositionPreviewId, value);
    return structuredClone(value);
  }

  async function commitSignalDispositions(body = {}) {
    purgeEphemeralPreviews();
    const preview = signalDispositionPreviews.get(body.preview_id);
    if (!preview) throw new TypeError("Signal disposition preview is missing or expired");
    let entities = [];
    if (preview.canonical_preview_ids.length === 1) {
      entities = [await store.commit(preview.canonical_preview_ids[0])];
    } else if (preview.canonical_preview_ids.length > 1) {
      entities = await store.commitBatch(preview.canonical_preview_ids);
    }
    for (const decision of preview.decisions) {
      await telegramSensorStore.disposition({
        signalId: decision.signal_id,
        action: decision.action,
        situationId: decision.situation_id,
      });
    }
    signalDispositionPreviews.delete(preview.preview_id);
    return { committed: true, entities, disposition_count: preview.decisions.length };
  }

  const telegramFacade = {
    getHealth: () => telegram.getHealth(),
    async bootstrap(body) {
      const pairingCode = body?.pairingCode || randomBytes(4).toString("hex");
      const result = await telegram.bootstrap({ token: body?.token, pairingCode });
      if (result.ok) scheduleTelegram(50);
      return { ...result, pairing_code: result.ok ? pairingCode : undefined };
    },
    forget: (scope) => telegram.forget(scope),
    revoke: (scope) => telegram.revoke(scope),
    groups: listTelegramGroups,
    previewGroupChange: previewTelegramGroupChange,
    commitGroupChange: commitTelegramGroupChange,
  };

  const signalFacade = {
    list: listSignals,
    previewDispositions: previewSignalDispositions,
    commitDispositions: commitSignalDispositions,
  };

  const forwardIntelligenceFacade = {
    getHealth: () => forwardIntelligence.getHealth(),
    listEventWindows: () => forwardIntelligence.listEventWindows(),
    listSignals: (options) => forwardIntelligence.listSignals(options),
    getSignal: (signalId) => forwardIntelligence.getSignal(signalId),
    disposition: (signalId, body) => forwardIntelligence.disposition(signalId, {
      action: body?.action,
      situationId: body?.situation_id,
    }),
    getSourcePerformance: () => forwardIntelligence.getSourcePerformance(),
    getNowProjection: (context) => forwardIntelligence.getNowProjection(context),
    subscribe: (listener) => forwardIntelligence.subscribe(listener),
    refreshCalendars: () => forwardIntelligence.refreshCalendars(),
    tick: runForwardIntelligenceTick,
  };

  const marketReactionFacade = {
    getHealth: () => marketReaction.getHealth(),
    bootstrap: (body) => marketReaction.bootstrap({
      keyId: body?.key_id,
      secretKey: body?.secret_key,
    }),
  };

  const evidenceLoopFacade = {
    getHealth: () => evidenceLoop.getHealth(),
    getProjection: () => evidenceLoop.getProjection(),
    setupSec: (body) => evidenceLoop.setupSec({ contactEmail: body?.contact_email }),
    setupFred: (body) => evidenceLoop.setupFred({ apiKey: body?.api_key }),
    refresh: (body) => evidenceLoop.refresh({
      sec: body?.sec !== false,
      fred: body?.fred !== false,
      reactions: body?.reactions !== false,
    }),
  };

  async function verifyWikiSource({ source_uri: sourceUri, source_hash: sourceHash } = {}) {
    if (!wikiBaselineReady || typeof sourceUri !== "string" || typeof sourceHash !== "string") {
      return { verified: false, reason: "wiki_allowlist_unavailable" };
    }
    const entry = [...wikiPersistedEntries.values()].find(
      (candidate) => candidate.obsidian_uri === sourceUri && candidate.sha256 === sourceHash,
    );
    if (!entry) return { verified: false, reason: "wiki_source_mismatch" };
    if (containsExcludedSegment(entry.relative_path, resolvedPaths.excludedSegments)) {
      return { verified: false, reason: "prohibited_wiki_path" };
    }
    return {
      verified: true,
      relative_path: entry.relative_path,
      obsidian_uri: entry.obsidian_uri,
      sha256: entry.sha256,
    };
  }

  const connectors = {
    telegram: telegramFacade,
    signals: signalFacade,
    forwardIntelligence: forwardIntelligenceFacade,
    marketReaction: marketReactionFacade,
    evidenceLoop: evidenceLoopFacade,
    truflation,
    verifyWikiSource,
    getHealth,
    getBriefing: refreshBriefing,
  };
  const api = createApiHandler({
    store,
    connectors: { ...connectors, excludedSegments: resolvedPaths.excludedSegments },
  });

  if (startCollectors) {
    scheduleOfficialFeeds();
    scheduleTelegram();
    void marketReaction.connect().catch(() => {});
    const firstWiki = setTimeout(() => void reconcileWiki(), 250);
    const firstForwardCalendar = setTimeout(
      () => void forwardIntelligence.refreshCalendars().catch(() => {}),
      2_500,
    );
    const forwardCalendarRefresh = setInterval(
      () => void forwardIntelligence.refreshCalendars().catch(() => {}),
      6 * 60 * 60 * 1_000,
    );
    const forwardTick = setInterval(
      () => void runForwardIntelligenceTick().catch(() => {}),
      15_000,
    );
    const firstEvidenceRefresh = setTimeout(
      () => void evidenceLoop.refresh().catch(() => {}),
      4_000,
    );
    const evidenceRefresh = setInterval(
      () => void evidenceLoop.refresh().catch(() => {}),
      15 * 60 * 1_000,
    );
    const wikiReconcile = setInterval(() => void reconcileWiki(), WIKI_RECONCILE_MS);
    const dailyMaintenance = setInterval(
      () => void runDailyMaintenanceIfDue().catch(() => {}),
      60_000,
    );
    firstWiki.unref?.();
    firstForwardCalendar.unref?.();
    forwardCalendarRefresh.unref?.();
    forwardTick.unref?.();
    firstEvidenceRefresh.unref?.();
    evidenceRefresh.unref?.();
    wikiReconcile.unref?.();
    dailyMaintenance.unref?.();
    timers.add(firstWiki);
    timers.add(firstForwardCalendar);
    timers.add(forwardCalendarRefresh);
    timers.add(forwardTick);
    timers.add(firstEvidenceRefresh);
    timers.add(evidenceRefresh);
    timers.add(wikiReconcile);
    timers.add(dailyMaintenance);
    const firstDailyMaintenance = setTimeout(
      () => void runDailyMaintenanceIfDue().catch(() => {}),
      15_000,
    );
    firstDailyMaintenance.unref?.();
    timers.add(firstDailyMaintenance);
    void rawStore
      .purgeOlderThan(new Date(clock().getTime() - RAW_SUCCESS_RETENTION_MS))
      .then(() => rawStore.purgeQuarantineOlderThan(new Date(clock().getTime() - QUARANTINE_RETENTION_MS)))
      .catch(() => {});
    void telegramSensorStore.purge().catch(() => {});
    void runForwardIntelligenceTick().catch(() => {});
    const purge = setInterval(() => {
      void rawStore
        .purgeOlderThan(new Date(clock().getTime() - RAW_SUCCESS_RETENTION_MS))
        .then(() => rawStore.purgeQuarantineOlderThan(new Date(clock().getTime() - QUARANTINE_RETENTION_MS)))
        .catch(() => {});
      void telegramSensorStore.purge().catch(() => {});
    }, 60 * 60 * 1_000);
    purge.unref?.();
    timers.add(purge);
  }

  return Object.freeze({
    store,
    api,
    connectors,
    paths: Object.freeze({ ...paths }),
    async pollFeed(feedId) {
      const feed = listOfficialFeedSpecs().find((candidate) => candidate.feed_id === feedId);
      if (!feed) throw new TypeError(`Unknown feed: ${feedId}`);
      return pollOfficial(feed);
    },
    reconcileWiki,
    refreshBriefing,
    runDailyMaintenanceIfDue,
    stop() {
      stopped = true;
      marketReaction.stop();
      if (telegramTimer) clearTimeout(telegramTimer);
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.clear();
    },
  });
}
