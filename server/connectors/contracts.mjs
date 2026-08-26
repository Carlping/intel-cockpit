import { createHash } from "node:crypto";

export const EVIDENCE_STATUSES = Object.freeze([
  "unverified_external",
  "manual_snapshot",
  "official_proxy",
  "verified",
]);

export const COVERAGE_STATES = Object.freeze([
  "complete",
  "partial",
  "coverage_gap",
  "unknown",
]);

export const HEALTH_STATES = Object.freeze([
  "healthy",
  "degraded",
  "disabled",
  "coverage_gap",
  "error",
]);

export const MATERIALITY_LEVELS = Object.freeze([
  "unscored",
  "low",
  "medium",
  "high",
  "critical",
]);

export class ConnectorValidationError extends TypeError {
  constructor(message, { field, code = "invalid_connector_input" } = {}) {
    super(message);
    this.name = "ConnectorValidationError";
    this.code = code;
    this.field = field;
  }
}

export class ConnectorDisabledError extends Error {
  constructor(message, { code = "connector_disabled" } = {}) {
    super(message);
    this.name = "ConnectorDisabledError";
    this.code = code;
  }
}

export class ConnectorRequestError extends Error {
  constructor(message, { code = "connector_request_failed", status, retryAfter } = {}) {
    super(message);
    this.name = "ConnectorRequestError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorValidationError(`${label} must be an object`, { field: label });
  }
}

function requireString(value, field, { max = 2_000, pattern } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConnectorValidationError(`${field} is required`, { field });
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new ConnectorValidationError(`${field} is too long`, { field });
  }
  if (pattern && !pattern.test(normalized)) {
    throw new ConnectorValidationError(`${field} has an invalid format`, { field });
  }
  return normalized;
}

function optionalString(value, field, { max = 20_000 } = {}) {
  if (value == null || value === "") return undefined;
  return requireString(value, field, { max });
}

function requireIsoDate(value, field) {
  const text = requireString(value, field, { max: 64 });
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw new ConnectorValidationError(`${field} must be an ISO-compatible date`, { field });
  }
  return new Date(timestamp).toISOString();
}

function requireEnum(value, field, values) {
  if (!values.includes(value)) {
    throw new ConnectorValidationError(
      `${field} must be one of: ${values.join(", ")}`,
      { field },
    );
  }
  return value;
}

function stringList(value, field, { maxItems = 100, maxItemLength = 200 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ConnectorValidationError(`${field} must be an array with at most ${maxItems} items`, {
      field,
    });
  }
  return [...new Set(value.map((item) => requireString(item, field, { max: maxItemLength })))];
}

function sourceUrl(value) {
  const text = requireString(value, "source_url", { max: 4_096 });
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new ConnectorValidationError("source_url must be an absolute URL", {
      field: "source_url",
    });
  }
  if (!["https:", "http:", "obsidian:", "telegram:", "manual:"].includes(parsed.protocol)) {
    throw new ConnectorValidationError("source_url uses a disallowed protocol", {
      field: "source_url",
    });
  }
  return parsed.toString();
}

export function createContentHash(value) {
  const input = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateFeedSpec(input) {
  assertRecord(input, "FeedSpec");
  const pollInterval = Number(input.poll_interval);
  if (!Number.isInteger(pollInterval) || pollInterval < 60 || pollInterval > 31_536_000) {
    throw new ConnectorValidationError(
      "poll_interval must be an integer between 60 and 31536000 seconds",
      { field: "poll_interval" },
    );
  }

  return Object.freeze({
    feed_id: requireString(input.feed_id, "feed_id", {
      max: 100,
      pattern: /^[a-z0-9][a-z0-9._-]*$/,
    }),
    source_type: requireEnum(input.source_type, "source_type", [
      "rss",
      "json_api",
      "telegram",
      "manual",
      "licensed_api",
    ]),
    authority_tier: requireEnum(input.authority_tier, "authority_tier", [
      "primary_official",
      "secondary_official",
      "publisher_primary",
      "licensed_alternative",
      "user_submitted",
    ]),
    poll_interval: pollInterval,
    license_scope: requireString(input.license_scope, "license_scope", { max: 500 }),
    domain: requireString(input.domain, "domain", { max: 100 }),
    enabled: Boolean(input.enabled),
    health_state: requireEnum(input.health_state, "health_state", HEALTH_STATES),
    endpoint: optionalString(input.endpoint, "endpoint", { max: 4_096 }),
    disabled_reason: optionalString(input.disabled_reason, "disabled_reason", { max: 500 }),
  });
}

export function validateObservation(input) {
  assertRecord(input, "Observation");
  const publishedAt = input.published_at
    ? requireIsoDate(input.published_at, "published_at")
    : undefined;
  const observedAt = requireIsoDate(input.observed_at, "observed_at");
  const asOf = requireIsoDate(input.as_of ?? input.observed_at, "as_of");
  const title = optionalString(input.title, "title", { max: 1_000 });
  const summary = optionalString(input.summary, "summary", { max: 50_000 });
  const hash = requireString(
    input.content_hash || createContentHash({ title, summary, payload: input.payload }),
    "content_hash",
    { max: 64, pattern: /^[a-f0-9]{64}$/i },
  ).toLowerCase();

  if (input.payload != null && (typeof input.payload !== "object" || Array.isArray(input.payload))) {
    throw new ConnectorValidationError("payload must be an object", { field: "payload" });
  }

  return Object.freeze({
    external_event_id: requireString(input.external_event_id, "external_event_id", {
      max: 500,
    }),
    feed_id: requireString(input.feed_id, "feed_id", { max: 100 }),
    ...(publishedAt ? { published_at: publishedAt } : {}),
    observed_at: observedAt,
    as_of: asOf,
    content_hash: hash,
    source_url: sourceUrl(input.source_url),
    evidence_status: requireEnum(
      input.evidence_status,
      "evidence_status",
      EVIDENCE_STATUSES,
    ),
    matched_interest_ids: stringList(input.matched_interest_ids, "matched_interest_ids"),
    materiality: requireEnum(input.materiality ?? "unscored", "materiality", MATERIALITY_LEVELS),
    coverage_state: requireEnum(
      input.coverage_state ?? "unknown",
      "coverage_state",
      COVERAGE_STATES,
    ),
    license_ref: requireString(input.license_ref, "license_ref", { max: 500 }),
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(input.payload != null ? { payload: structuredClone(input.payload) } : {}),
    untrusted_external_content: input.untrusted_external_content !== false,
  });
}

export function createObservation(input) {
  return validateObservation(input);
}

export function createHealthReport({
  feedId,
  state,
  checkedAt,
  message,
  lastSuccessAt,
  coverageState = "unknown",
  retryAfter,
}) {
  const report = {
    feed_id: requireString(feedId, "feed_id", { max: 100 }),
    state: requireEnum(state, "state", HEALTH_STATES),
    checked_at: requireIsoDate(checkedAt, "checked_at"),
    coverage_state: requireEnum(coverageState, "coverage_state", COVERAGE_STATES),
  };
  if (message) report.message = requireString(message, "message", { max: 1_000 });
  if (lastSuccessAt) report.last_success_at = requireIsoDate(lastSuccessAt, "last_success_at");
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) report.retry_after_seconds = seconds;
  }
  return Object.freeze(report);
}
