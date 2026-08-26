import { randomUUID } from "node:crypto";
import { ValidationError } from "./errors.mjs";

export const ENTITY_CONFIG = Object.freeze({
  InboxItem: Object.freeze({ directory: "inbox", prefix: "inbox" }),
  Situation: Object.freeze({ directory: "situations", prefix: "situation" }),
  Mission: Object.freeze({ directory: "missions", prefix: "mission" }),
  Review: Object.freeze({ directory: "reviews", prefix: "review" }),
});

const ENTITY_ALIASES = Object.freeze({
  inbox: "InboxItem",
  inboxitem: "InboxItem",
  situations: "Situation",
  situation: "Situation",
  missions: "Mission",
  mission: "Mission",
  reviews: "Review",
  review: "Review",
});

const RESERVED_KEYS = new Set([
  "schema_version",
  "entity_type",
  "entity_id",
  "revision",
  "created_at",
  "updated_at",
  "content_sha256",
]);

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const LOGICAL_ID = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const EVIDENCE_STATUSES = Object.freeze([
  "unverified_external",
  "verified",
  "manual_snapshot",
  "official_proxy",
]);
const S0_S8_STATES = Object.freeze(["not_completed", "pending", "completed"]);

export function normalizeEntityType(value) {
  if (typeof value !== "string") {
    throw new ValidationError("entity_type must be a string");
  }

  if (Object.hasOwn(ENTITY_CONFIG, value)) return value;
  const normalized = ENTITY_ALIASES[value.toLowerCase()];
  if (!normalized) throw new ValidationError(`Unsupported entity_type: ${value}`);
  return normalized;
}

export function entityDirectory(entityType) {
  return ENTITY_CONFIG[normalizeEntityType(entityType)].directory;
}

export function validateLogicalId(value) {
  if (typeof value !== "string" || !LOGICAL_ID.test(value)) {
    throw new ValidationError(
      "entity_id must be 1-80 lowercase letters, numbers, or hyphens and cannot contain paths",
    );
  }
  return value;
}

export function generateLogicalId(entityType) {
  const normalized = normalizeEntityType(entityType);
  return `${ENTITY_CONFIG[normalized].prefix}-${randomUUID()}`;
}

function assertPlainJson(value, path = "payload", seen = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`${path} must not contain non-finite numbers`);
    }
    return;
  }

  if (typeof value !== "object") {
    throw new ValidationError(`${path} must contain JSON values only`);
  }

  if (seen.has(value)) throw new ValidationError(`${path} must not be circular`);
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertPlainJson(value[index], `${path}[${index}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ValidationError(`${path} must use plain JSON objects`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ValidationError(`${path}.${key} is not allowed`);
      }
      assertPlainJson(child, `${path}.${key}`, seen);
    }
  }

  seen.delete(value);
}

function requireText(payload, field, { fallback } = {}) {
  const value = payload[field] ?? fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} is required`);
  }
  if (value.length > 4_000) throw new ValidationError(`${field} is too long`);
  return value.trim();
}

function validateOptionalEnum(payload, field, values) {
  if (payload[field] !== undefined && !values.includes(payload[field])) {
    throw new ValidationError(`${field} must be one of: ${values.join(", ")}`);
  }
}

function requireArray(payload, field) {
  if (!Array.isArray(payload[field])) {
    throw new ValidationError(`${field} must be an array`);
  }
  return payload[field];
}

function requireIsoDate(payload, field) {
  const value = requireText(payload, field);
  if (!Number.isFinite(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO date or timestamp`);
  }
  return value;
}

function validateSituationContract(payload) {
  payload.current_assessment = requireText(payload, "current_assessment");
  payload.before = requireText(payload, "before");
  payload.now = requireText(payload, "now");
  payload.stop_condition = requireText(payload, "stop_condition");
  payload.reopen_condition = requireText(payload, "reopen_condition");
  payload.next_review_at = requireIsoDate(payload, "next_review_at");
  const watches = requireArray(payload, "watch_conditions");
  if (!watches.length || watches.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ValidationError("watch_conditions must contain at least one non-empty condition");
  }
  const evidence = requireArray(payload, "evidence");
  const allowedKinds = new Set(["known", "inference", "unknown", "contradiction"]);
  for (const item of evidence) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ValidationError("evidence entries must be objects");
    }
    if (!allowedKinds.has(item.kind) || typeof item.text !== "string" || !item.text.trim()) {
      throw new ValidationError("evidence entries require kind and non-empty text");
    }
    if (
      item.evidence_status !== undefined
      && !EVIDENCE_STATUSES.includes(item.evidence_status)
    ) {
      throw new ValidationError(
        `evidence_status must be one of: ${EVIDENCE_STATUSES.join(", ")}`,
      );
    }
    if (item.s0_s8_state !== undefined && !S0_S8_STATES.includes(item.s0_s8_state)) {
      throw new ValidationError(
        `s0_s8_state must be one of: ${S0_S8_STATES.join(", ")}`,
      );
    }
    if (item.s0_s8_handoff !== undefined) {
      if (
        !item.s0_s8_handoff
        || typeof item.s0_s8_handoff !== "object"
        || Array.isArray(item.s0_s8_handoff)
        || !S0_S8_STATES.includes(item.s0_s8_handoff.state)
      ) {
        throw new ValidationError(
          "s0_s8_handoff.state must be one of: not_completed, pending, completed",
        );
      }
    }
    if (item.kind === "known") {
      const completedGate = item.s0_s8_state === "completed"
        || item.s0_s8_handoff?.state === "completed";
      if (item.evidence_status !== "verified" || !completedGate) {
        throw new ValidationError(
          "known evidence requires evidence_status verified and a completed S0-S8 gate",
        );
      }
    }
  }
  if (payload.confidence !== undefined && (
    typeof payload.confidence !== "number" ||
    !Number.isFinite(payload.confidence) ||
    payload.confidence < 0 ||
    payload.confidence > 100
  )) {
    throw new ValidationError("confidence must be a number between 0 and 100");
  }
  if (payload.scenario_paths !== undefined) {
    if (!Array.isArray(payload.scenario_paths) || payload.scenario_paths.length !== 3) {
      throw new ValidationError("scenario_paths must contain exactly three paths");
    }
    const ids = new Set();
    let total = 0;
    for (const [index, path] of payload.scenario_paths.entries()) {
      if (!path || typeof path !== "object" || Array.isArray(path)) {
        throw new ValidationError(`scenario_paths[${index}] must be an object`);
      }
      if (typeof path.id !== "string" || !LOGICAL_ID.test(path.id) || ids.has(path.id)) {
        throw new ValidationError("scenario_paths require unique logical ids");
      }
      ids.add(path.id);
      for (const field of ["label", "summary", "trigger", "implication", "invalidation", "tone"]) {
        if (typeof path[field] !== "string" || !path[field].trim()) {
          throw new ValidationError(`scenario_paths[${index}].${field} is required`);
        }
      }
      if (!["base", "upside", "stress"].includes(path.tone)) {
        throw new ValidationError("scenario path tone must be base, upside, or stress");
      }
      if (typeof path.probability !== "number" || !Number.isFinite(path.probability) || path.probability < 0 || path.probability > 100) {
        throw new ValidationError("scenario path probability must be between 0 and 100");
      }
      total += path.probability;
    }
    if (Math.abs(total - 100) > 0.001) {
      throw new ValidationError("scenario path probabilities must total 100");
    }
  }
  if (payload.forecast_ledger !== undefined && !Array.isArray(payload.forecast_ledger)) {
    throw new ValidationError("forecast_ledger must be an array");
  }
}

function validateMissionContract(payload) {
  payload.why_now = requireText(payload, "why_now");
  payload.next_action = requireText(payload, "next_action");
  payload.done_condition = requireText(payload, "done_condition");
  payload.review_date = requireIsoDate(payload, "review_date");
  payload.stop_condition = requireText(payload, "stop_condition");
  payload.reopen_condition = requireText(payload, "reopen_condition");
}

function validateReviewContract(payload) {
  payload.mission_id = requireText(payload, "mission_id");
  payload.reviewed_at = requireIsoDate(payload, "reviewed_at");
  payload.outcome = requireText(payload, "outcome");
  payload.assessment_change = requireText(payload, "assessment_change");
  payload.next_state = requireText(payload, "next_state");
}

export function validateEntityPayload(entityType, candidate) {
  const normalized = normalizeEntityType(entityType);
  assertPlainJson(candidate);
  if (candidate === null || Array.isArray(candidate)) {
    throw new ValidationError("payload must be a JSON object");
  }

  for (const key of Object.keys(candidate)) {
    if (RESERVED_KEYS.has(key)) {
      throw new ValidationError(`${key} is managed by the store and cannot be supplied`);
    }
  }

  const payload = structuredClone(candidate);
  if (normalized === "InboxItem") {
    payload.title = requireText(payload, "title");
    validateOptionalEnum(payload, "status", [
      "new",
      "triaged",
      "linked",
      "reference_only",
      "watch",
      "not_relevant",
      "wiki_ingest_pending",
    ]);
    validateOptionalEnum(payload, "evidence_status", [...EVIDENCE_STATUSES]);
  } else if (normalized === "Situation") {
    payload.title = requireText(payload, "title");
    validateOptionalEnum(payload, "status", ["active", "watch", "closed"]);
    validateSituationContract(payload);
  } else if (normalized === "Mission") {
    payload.objective = requireText(payload, "objective");
    payload.title = requireText(payload, "title", { fallback: payload.objective });
    validateOptionalEnum(payload, "status", [
      "active",
      "blocked",
      "completed",
      "cancelled",
    ]);
    validateMissionContract(payload);
  } else if (normalized === "Review") {
    payload.title = requireText(payload, "title");
    validateReviewContract(payload);
  }

  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new ValidationError(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return payload;
}

export function applyMergePatch(target, patch) {
  assertPlainJson(patch, "payload");
  if (patch === null || Array.isArray(patch) || typeof patch !== "object") {
    return structuredClone(patch);
  }

  const result =
    target && typeof target === "object" && !Array.isArray(target)
      ? structuredClone(target)
      : {};

  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) throw new ValidationError(`${key} is not allowed`);
    if (value === null) {
      delete result[key];
    } else {
      result[key] = applyMergePatch(result[key], value);
    }
  }
  return result;
}

export function validateBaseRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError("base_revision must be a non-negative safe integer");
  }
  return value;
}
