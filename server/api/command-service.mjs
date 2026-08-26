import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "../store/index.mjs";
import { containsExcludedSegment } from "../privacy/excluded-segments.mjs";

const ROUTE_STATUS = Object.freeze({
  "inbox.reference_only": "reference_only",
  "inbox.watch": "watch",
  "inbox.not_relevant": "not_relevant",
});
const MISSION_TRANSITIONS = new Set(["active", "blocked", "completed", "cancelled"]);
const RESULT_STATES = new Set(["no_change", "changed", "blocked"]);
const ADJUSTABLE_MISSION_STATES = new Set(["active", "blocked"]);
const TRIAGEABLE_INBOX_STATES = new Set(["new"]);
const INGEST_REQUESTABLE_INBOX_STATES = new Set(["new", "linked"]);

function record(value, label = "data") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value;
}

function text(value, label, { max = 4_000 } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${label} is required`);
  if (value.length > max) throw new ValidationError(`${label} is too long`);
  return value.trim();
}

function optionalText(value, label, { max = 4_000 } = {}) {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, label, { max });
}

function revision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ValidationError(`${label} must be a positive revision`);
  return value;
}

function iso(value, label) {
  const normalized = text(value, label);
  if (!Number.isFinite(Date.parse(normalized))) throw new ValidationError(`${label} must be an ISO date or timestamp`);
  return normalized;
}

function stringList(value, label) {
  if (!Array.isArray(value) || !value.length) throw new ValidationError(`${label} must contain at least one value`);
  const normalized = value.map((item, index) => text(item, `${label}[${index}]`, { max: 1_000 }));
  return [...new Set(normalized)];
}

function forecastPaths(value, label = "scenario_paths") {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new ValidationError(`${label} must contain exactly three paths`);
  }
  const ids = new Set();
  const normalized = value.map((candidate, index) => {
    const path = record(candidate, `${label}[${index}]`);
    const id = text(path.id, `${label}[${index}].id`, { max: 80 });
    if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(id)) {
      throw new ValidationError(`${label}[${index}].id has an invalid format`);
    }
    if (ids.has(id)) throw new ValidationError(`${label} cannot contain duplicate ids`);
    ids.add(id);
    const probability = Number(path.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 100) {
      throw new ValidationError(`${label}[${index}].probability must be between 0 and 100`);
    }
    const tone = text(path.tone, `${label}[${index}].tone`, { max: 20 });
    if (!["base", "upside", "stress"].includes(tone)) {
      throw new ValidationError(`${label}[${index}].tone must be base, upside, or stress`);
    }
    return {
      id,
      label: text(path.label, `${label}[${index}].label`, { max: 120 }),
      probability: Math.round(probability * 100) / 100,
      summary: text(path.summary, `${label}[${index}].summary`),
      trigger: text(path.trigger, `${label}[${index}].trigger`),
      implication: text(path.implication, `${label}[${index}].implication`),
      invalidation: text(path.invalidation, `${label}[${index}].invalidation`),
      tone,
    };
  });
  const total = normalized.reduce((sum, path) => sum + path.probability, 0);
  if (Math.abs(total - 100) > 0.001) {
    throw new ValidationError(`${label} probabilities must total 100`);
  }
  return normalized;
}

function multiclassBrier(paths, outcomePathId) {
  if (!paths.some((path) => path.id === outcomePathId)) {
    throw new ValidationError("outcome_path_id must match a forecast path");
  }
  const score = paths.reduce((sum, path) => {
    const probability = path.probability / 100;
    const outcome = path.id === outcomePathId ? 1 : 0;
    return sum + ((probability - outcome) ** 2);
  }, 0) / paths.length;
  return Math.round(score * 10_000) / 10_000;
}

function userConfirmed(body) {
  if (body.user_confirmation !== true) {
    throw new ValidationError("This command requires an explicit interactive user confirmation");
  }
}

function requiredDraft(entity, label) {
  const draft = entity?.payload?.adjustment_draft;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new ValidationError(`${label} has no pending adjustment draft`);
  }
  return draft;
}

function assertNoClientOverride(data, fields, command) {
  const supplied = fields.filter((field) => Object.hasOwn(data, field));
  if (supplied.length) {
    throw new ValidationError(`${command} cannot override ${supplied.join(", ")}; accept the authoritative draft`);
  }
}

export function assertEligibleObsidianSource(sourceUri, { excludedSegments } = {}) {
  let parsed;
  try {
    parsed = new URL(sourceUri);
  } catch {
    throw new ValidationError("source_uri must be a valid Obsidian URI");
  }
  if (parsed.protocol !== "obsidian:" || parsed.hostname !== "open") {
    throw new ValidationError("source_uri must be an Obsidian open URI");
  }
  const sourcePath = parsed.searchParams.get("file");
  if (!sourcePath) throw new ValidationError("source_uri must identify a Wiki file");
  if (containsExcludedSegment(sourcePath, excludedSegments)) {
    throw new ValidationError("The path is inside a permanently excluded subtree");
  }
}

function inboxTargetsSituation(inbox, situationId) {
  const payload = inbox?.payload ?? {};
  if (payload.linked_situation_id === situationId) return true;
  if (Array.isArray(payload.matched_context) && payload.matched_context.some(
    (match) => match
      && typeof match === "object"
      && !Array.isArray(match)
      && String(match.kind).toLocaleLowerCase("en-US") === "situation"
      && match.id === situationId,
  )) return true;
  return Array.isArray(payload.matched_interest_ids)
    && payload.matched_interest_ids.includes(situationId);
}

function assertInboxStatus(inbox, allowed, command) {
  const status = inbox?.payload?.status;
  if (!allowed.has(status)) {
    throw new ValidationError(
      `${command} cannot process InboxItem status ${String(status ?? "missing")}`,
    );
  }
}

function uniqueAppend(values, next) {
  return [...new Set([...(Array.isArray(values) ? values : []), next])];
}

function finiteObservedNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (
    typeof value !== "string"
    || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())
  ) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function indicatorObservationFromInbox(inbox) {
  const payload = inbox?.payload ?? {};
  const observation = payload.observation && typeof payload.observation === "object"
    && !Array.isArray(payload.observation) ? payload.observation : {};
  const observationPayload = observation.payload && typeof observation.payload === "object"
    && !Array.isArray(observation.payload) ? observation.payload : {};
  const sourcePayload = payload.source_payload && typeof payload.source_payload === "object"
    && !Array.isArray(payload.source_payload) ? payload.source_payload : {};
  const snapshot = payload.snapshot && typeof payload.snapshot === "object"
    && !Array.isArray(payload.snapshot) ? payload.snapshot : {};
  const candidates = [sourcePayload, observationPayload, observation, snapshot];
  const pick = (field) => candidates.find((candidate) => candidate[field] !== undefined)?.[field];
  const seriesId = optionalText(
    pick("series_id") ?? pick("series"),
    "source_payload.series_id",
    { max: 200 },
  );
  const value = finiteObservedNumber(pick("value"));
  const unit = optionalText(pick("unit"), "source_payload.unit", { max: 80 });
  const asOfRaw = pick("as_of") ?? pick("observation_date") ?? payload.as_of;
  if (!seriesId || value === undefined || !unit || typeof asOfRaw !== "string") return null;
  const asOf = iso(asOfRaw, "source_payload.as_of");
  return {
    series_id: seriesId,
    label: optionalText(payload.source_label, "source_label", { max: 200 })
      ?? optionalText(payload.title, "title", { max: 1_000 })
      ?? seriesId,
    value,
    unit,
    as_of: asOf,
    evidence_status: payload.evidence_status ?? "unverified_external",
    source_url: optionalText(payload.source_url, "source_url") ?? null,
    source_inbox_id: inbox.entity_id,
  };
}

function upsertIndicatorSeries(series, observation) {
  if (!observation) return Array.isArray(series) ? series : [];
  const existing = Array.isArray(series) ? series : [];
  const key = `${observation.series_id}\u0000${observation.as_of}`;
  return [
    ...existing.filter((item) =>
      `${String(item?.series_id ?? "")}\u0000${String(item?.as_of ?? "")}` !== key),
    observation,
  ];
}

function inboxEvidence(inbox, accepted, now) {
  const payload = inbox.payload ?? {};
  const s0Complete = payload.s0_s8_handoff?.state === "completed";
  const evidenceStatus = payload.evidence_status ?? "unverified_external";
  const sourceUrl = optionalText(payload.source_url, "source_url");
  return {
    id: `inbox-${inbox.entity_id}-r${inbox.revision}`,
    kind: evidenceStatus === "verified" && s0Complete ? "known" : "unknown",
    text: optionalText(payload.summary, "summary") ?? accepted.now,
    source_inbox_id: inbox.entity_id,
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    source_title: optionalText(payload.title, "title") ?? inbox.entity_id,
    evidence_status: evidenceStatus,
    s0_s8_state: payload.s0_s8_handoff?.state ?? "not_completed",
    as_of: optionalText(payload.as_of, "as_of") ?? null,
    observed_at: optionalText(payload.observed_at, "observed_at") ?? now,
    accepted_at: now,
  };
}

function inboxTimelinePoint(inbox, accepted, now) {
  const payload = inbox.payload ?? {};
  const evidenceStatus = payload.evidence_status ?? "unverified_external";
  return {
    id: `inbox-${inbox.entity_id}-r${inbox.revision}`,
    date: optionalText(payload.as_of, "as_of")
      ?? optionalText(payload.observed_at, "observed_at")
      ?? now,
    label: optionalText(payload.title, "title") ?? inbox.entity_id,
    detail: accepted.now,
    status: evidenceStatus === "verified"
      ? "verified"
      : evidenceStatus === "manual_snapshot" ? "manual" : "external",
    source_inbox_id: inbox.entity_id,
    evidence_status: evidenceStatus,
  };
}

async function get(store, type, id, label) {
  try {
    return await store.get(type, text(id, label, { max: 80 }));
  } catch (error) {
    if (error instanceof NotFoundError) throw new ValidationError(`${label} does not reference an existing ${type}`);
    throw error;
  }
}

function assertClientRevision(entity, supplied, label) {
  const expected = revision(supplied, label);
  if (entity.revision !== expected) {
    throw new ConflictError(`${label} is stale: expected ${expected}, current revision is ${entity.revision}`);
  }
  return expected;
}

function situationPayload(input, sourceInbox, now) {
  const data = record(input, "situation");
  const watchConditions = Array.isArray(data.watch_conditions)
    ? stringList(data.watch_conditions, "situation.watch_conditions")
    : [text(data.watch_condition, "situation.watch_condition")];
  const assessment = text(data.current_assessment, "situation.current_assessment");
  const sourceEvidence = inboxEvidence(sourceInbox, { now: assessment }, now);
  const sourceTimeline = inboxTimelinePoint(sourceInbox, { now: assessment }, now);
  const indicator = indicatorObservationFromInbox(sourceInbox);
  return {
    title: text(data.title, "situation.title"),
    status: data.status === "active" ? "active" : "watch",
    domain: text(data.domain, "situation.domain", { max: 120 }),
    current_assessment: assessment,
    before: text(data.before, "situation.before"),
    now: text(data.now, "situation.now"),
    watch_conditions: watchConditions,
    stop_condition: text(data.stop_condition, "situation.stop_condition"),
    reopen_condition: text(data.reopen_condition, "situation.reopen_condition"),
    next_review_at: iso(data.next_review_at, "situation.next_review_at"),
    confidence: typeof data.confidence === "number" ? data.confidence : 40,
    evidence: [sourceEvidence],
    timeline: [sourceTimeline],
    ...(indicator ? { indicator_series: [indicator] } : {}),
    source_inbox_ids: [sourceInbox.entity_id],
    requires_decision: false,
    material_change: false,
  };
}

function missionPayload(input) {
  const data = record(input, "mission");
  const situationId = optionalText(data.situation_id, "mission.situation_id", { max: 80 });
  return {
    title: text(data.title, "mission.title"),
    objective: text(data.objective, "mission.objective"),
    status: "active",
    domain: text(data.domain, "mission.domain", { max: 120 }),
    why_now: text(data.why_now, "mission.why_now"),
    next_action: text(data.next_action, "mission.next_action"),
    done_condition: text(data.done_condition, "mission.done_condition"),
    review_date: iso(data.review_date, "mission.review_date"),
    stop_condition: text(data.stop_condition, "mission.stop_condition"),
    reopen_condition: text(data.reopen_condition, "mission.reopen_condition"),
    ...(situationId ? { situation_id: situationId } : {}),
    requires_decision: false,
    action_history: [],
  };
}

function previewSingle(store, operation) {
  return store.preview(operation);
}

export async function previewTypedCommand({
  store,
  body,
  previewBatch,
  verifyWikiSource,
  excludedSegments,
  clock = () => new Date(),
}) {
  const envelope = record(body, "command envelope");
  const command = text(envelope.command, "command", { max: 120 });
  const data = record(envelope.data, "data");
  const now = clock().toISOString();

  if (Object.hasOwn(ROUTE_STATUS, command)) {
    userConfirmed(envelope);
    const inbox = await get(store, "InboxItem", data.inbox_id, "inbox_id");
    assertInboxStatus(inbox, TRIAGEABLE_INBOX_STATES, command);
    const baseRevision = assertClientRevision(inbox, data.base_revision, "base_revision");
    return previewSingle(store, {
      operation: "update",
      entity_type: "InboxItem",
      entity_id: inbox.entity_id,
      base_revision: baseRevision,
      payload: {
        status: ROUTE_STATUS[command],
        requires_decision: false,
        triage: { decision: command.slice("inbox.".length), decided_at: now, actor: "user" },
      },
    });
  }

  if (command === "inbox.swipe_batch") {
    userConfirmed(envelope);
    if (typeof previewBatch !== "function") throw new TypeError("previewBatch is required");
    if (!Array.isArray(data.decisions) || data.decisions.length < 1 || data.decisions.length > 20) {
      throw new ValidationError("decisions must contain between 1 and 20 swipe decisions");
    }
    const decisions = data.decisions.map((candidate, index) => {
      const decision = record(candidate, `decisions[${index}]`);
      if (typeof decision.interested !== "boolean") {
        throw new ValidationError(`decisions[${index}].interested must be a boolean`);
      }
      const confidence = decision.classification_confidence;
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
        throw new ValidationError(`decisions[${index}].classification_confidence must be between 0 and 100`);
      }
      const situationId = optionalText(decision.situation_id, `decisions[${index}].situation_id`, { max: 80 });
      if (!decision.interested && situationId) {
        throw new ValidationError(`decisions[${index}] cannot link an uninterested item to a Situation`);
      }
      return {
        inboxId: text(decision.inbox_id, `decisions[${index}].inbox_id`, { max: 80 }),
        baseRevision: revision(decision.base_revision, `decisions[${index}].base_revision`),
        interested: decision.interested,
        situationId,
        systemGroup: text(decision.system_group, `decisions[${index}].system_group`, { max: 120 }),
        confidence: Math.round(confidence),
        reason: text(decision.classification_reason, `decisions[${index}].classification_reason`, { max: 600 }),
      };
    });
    if (new Set(decisions.map((decision) => decision.inboxId)).size !== decisions.length) {
      throw new ValidationError("decisions cannot contain duplicate Inbox items");
    }

    const inboxes = await Promise.all(decisions.map((decision) =>
      get(store, "InboxItem", decision.inboxId, "inbox_id")));
    for (let index = 0; index < decisions.length; index += 1) {
      assertInboxStatus(inboxes[index], TRIAGEABLE_INBOX_STATES, command);
      assertClientRevision(inboxes[index], decisions[index].baseRevision, `decisions[${index}].base_revision`);
    }

    const situationIds = [...new Set(decisions.flatMap((decision) => decision.situationId ? [decision.situationId] : []))];
    const situations = await Promise.all(situationIds.map((id) => get(store, "Situation", id, "situation_id")));
    const situationState = new Map(situations.map((situation) => [situation.entity_id, {
      entity: situation,
      evidence: Array.isArray(situation.payload.evidence) ? [...situation.payload.evidence] : [],
      timeline: Array.isArray(situation.payload.timeline) ? [...situation.payload.timeline] : [],
      sourceInboxIds: Array.isArray(situation.payload.source_inbox_ids) ? [...situation.payload.source_inbox_ids] : [],
      indicatorSeries: Array.isArray(situation.payload.indicator_series) ? [...situation.payload.indicator_series] : [],
    }]));
    const inboxOperations = [];

    for (let index = 0; index < decisions.length; index += 1) {
      const decision = decisions[index];
      const inbox = inboxes[index];
      const classification = {
        group: decision.systemGroup,
        confidence: decision.confidence,
        reason: decision.reason,
        classifier: "intel_os_alpha_rules_v1",
      };
      if (decision.interested && decision.situationId) {
        const state = situationState.get(decision.situationId);
        if (!state) throw new ValidationError("situation_id does not reference an existing Situation");
        const accepted = {
          now: optionalText(inbox.payload.summary, "summary")
            ?? optionalText(inbox.payload.title, "title")
            ?? inbox.entity_id,
        };
        const evidenceId = `inbox-${inbox.entity_id}-r${inbox.revision}`;
        state.evidence = [
          ...state.evidence.filter((item) => item?.id !== evidenceId),
          inboxEvidence(inbox, accepted, now),
        ];
        state.timeline = [
          ...state.timeline.filter((item) => item?.id !== evidenceId),
          inboxTimelinePoint(inbox, accepted, now),
        ];
        state.sourceInboxIds = uniqueAppend(state.sourceInboxIds, inbox.entity_id);
        state.indicatorSeries = upsertIndicatorSeries(
          state.indicatorSeries,
          indicatorObservationFromInbox(inbox),
        );
        inboxOperations.push({
          operation: "update",
          entity_type: "InboxItem",
          entity_id: inbox.entity_id,
          base_revision: inbox.revision,
          payload: {
            status: "linked",
            linked_situation_id: decision.situationId,
            requires_decision: false,
            classification,
            triage: { decision: "interested", route: "link_situation", decided_at: now, actor: "user" },
          },
        });
      } else {
        inboxOperations.push({
          operation: "update",
          entity_type: "InboxItem",
          entity_id: inbox.entity_id,
          base_revision: inbox.revision,
          payload: {
            status: decision.interested ? "watch" : "not_relevant",
            requires_decision: false,
            classification,
            triage: {
              decision: decision.interested ? "interested" : "not_interested",
              route: decision.interested ? "watch" : "not_relevant",
              decided_at: now,
              actor: "user",
            },
          },
        });
      }
    }

    const situationOperations = [...situationState.values()].map((state) => ({
      operation: "update",
      entity_type: "Situation",
      entity_id: state.entity.entity_id,
      base_revision: state.entity.revision,
      payload: {
        evidence: state.evidence,
        timeline: state.timeline,
        source_inbox_ids: state.sourceInboxIds,
        indicator_series: state.indicatorSeries,
      },
    }));
    return previewBatch([...situationOperations, ...inboxOperations]);
  }

  if (command === "inbox.link_situation") {
    userConfirmed(envelope);
    if (typeof previewBatch !== "function") throw new TypeError("previewBatch is required");
    const [inbox, situation] = await Promise.all([
      get(store, "InboxItem", data.inbox_id, "inbox_id"),
      get(store, "Situation", data.situation_id, "situation_id"),
    ]);
    assertInboxStatus(inbox, TRIAGEABLE_INBOX_STATES, command);
    const baseRevision = assertClientRevision(inbox, data.base_revision, "base_revision");
    const accepted = {
      now: optionalText(inbox.payload.summary, "summary")
        ?? optionalText(inbox.payload.title, "title")
        ?? inbox.entity_id,
    };
    const evidenceId = `inbox-${inbox.entity_id}-r${inbox.revision}`;
    const evidence = [
      ...(Array.isArray(situation.payload.evidence)
        ? situation.payload.evidence.filter((item) => item?.id !== evidenceId)
        : []),
      inboxEvidence(inbox, accepted, now),
    ];
    const timeline = [
      ...(Array.isArray(situation.payload.timeline)
        ? situation.payload.timeline.filter((item) => item?.id !== evidenceId)
        : []),
      inboxTimelinePoint(inbox, accepted, now),
    ];
    return previewBatch([
      {
        operation: "update",
        entity_type: "Situation",
        entity_id: situation.entity_id,
        base_revision: situation.revision,
        payload: {
          evidence,
          timeline,
          source_inbox_ids: uniqueAppend(situation.payload.source_inbox_ids, inbox.entity_id),
          indicator_series: upsertIndicatorSeries(
            situation.payload.indicator_series,
            indicatorObservationFromInbox(inbox),
          ),
        },
      },
      {
        operation: "update",
        entity_type: "InboxItem",
        entity_id: inbox.entity_id,
        base_revision: baseRevision,
        payload: {
          status: "linked",
          linked_situation_id: situation.entity_id,
          requires_decision: false,
          triage: { decision: "link_situation", decided_at: now, actor: "user" },
        },
      },
    ]);
  }

  if (command === "inbox.send_to_wiki_ingest") {
    userConfirmed(envelope);
    const inbox = await get(store, "InboxItem", data.inbox_id, "inbox_id");
    assertInboxStatus(inbox, INGEST_REQUESTABLE_INBOX_STATES, command);
    if (
      inbox.payload.evidence_status === "verified"
      || inbox.payload.s0_s8_handoff?.state === "completed"
    ) {
      throw new ValidationError("Verified S0-S8 evidence cannot be sent through ingest again");
    }
    const baseRevision = assertClientRevision(inbox, data.base_revision, "base_revision");
    return previewSingle(store, {
      operation: "update",
      entity_type: "InboxItem",
      entity_id: inbox.entity_id,
      base_revision: baseRevision,
      payload: {
        status: "wiki_ingest_pending",
        requires_decision: false,
        s0_s8_handoff: {
          state: "pending",
          requested_at: now,
          source_inbox_id: inbox.entity_id,
          stages: ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"].map((stage) => ({ stage, state: "pending" })),
        },
      },
    });
  }

  if (command === "inbox.complete_wiki_ingest") {
    userConfirmed(envelope);
    const inbox = await get(store, "InboxItem", data.inbox_id, "inbox_id");
    assertInboxStatus(inbox, new Set(["wiki_ingest_pending"]), command);
    if (inbox.payload?.s0_s8_handoff?.state !== "pending") {
      throw new ValidationError("inbox.complete_wiki_ingest requires a pending S0-S8 handoff");
    }
    const baseRevision = assertClientRevision(inbox, data.base_revision, "base_revision");
    const sourceUri = text(data.source_uri, "source_uri");
    assertEligibleObsidianSource(sourceUri, { excludedSegments });
    const sourceHash = text(data.source_hash, "source_hash", { max: 128 });
    if (!/^[a-f0-9]{64}$/i.test(sourceHash)) {
      throw new ValidationError("source_hash must be a SHA-256 hex digest");
    }
    if (typeof verifyWikiSource !== "function") {
      throw new ValidationError("Wiki verification is unavailable until the persisted allowlist index is ready");
    }
    const verified = await verifyWikiSource({
      source_uri: sourceUri,
      source_hash: sourceHash,
      inbox_id: inbox.entity_id,
    });
    if (verified !== true && verified?.verified !== true) {
      throw new ValidationError("Wiki source URI and hash do not match the persisted allowlist index");
    }
    return previewSingle(store, {
      operation: "update",
      entity_type: "InboxItem",
      entity_id: inbox.entity_id,
      base_revision: baseRevision,
      payload: {
        status: "new",
        evidence_status: "verified",
        verified_source_uri: sourceUri,
        verified_source_hash: sourceHash,
        s0_s8_handoff: {
          state: "completed",
          completed_at: now,
          source_inbox_id: inbox.entity_id,
          stages: ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"].map((stage) => ({ stage, state: "completed" })),
        },
        triage: { decision: "wiki_ingest_completed", decided_at: now, actor: "user" },
      },
    });
  }

  if (command === "inbox.create_situation") {
    userConfirmed(envelope);
    if (typeof previewBatch !== "function") throw new TypeError("previewBatch is required");
    const inbox = await get(store, "InboxItem", data.inbox_id, "inbox_id");
    assertInboxStatus(inbox, TRIAGEABLE_INBOX_STATES, command);
    const baseRevision = assertClientRevision(inbox, data.base_revision, "base_revision");
    const situationId = `situation-${randomUUID()}`;
    return previewBatch([
      {
        operation: "create",
        entity_type: "Situation",
        entity_id: situationId,
        base_revision: 0,
        payload: situationPayload(data.situation, inbox, now),
      },
      {
        operation: "update",
        entity_type: "InboxItem",
        entity_id: inbox.entity_id,
        base_revision: baseRevision,
        payload: {
          status: "linked",
          linked_situation_id: situationId,
          requires_decision: false,
          triage: { decision: "create_situation", decided_at: now, actor: "user" },
        },
      },
    ]);
  }

  if (command === "mission.create") {
    userConfirmed(envelope);
    const payload = missionPayload(data.mission);
    if (payload.situation_id) await get(store, "Situation", payload.situation_id, "mission.situation_id");
    return previewSingle(store, {
      operation: "create",
      entity_type: "Mission",
      entity_id: `mission-${randomUUID()}`,
      base_revision: 0,
      payload,
    });
  }

  if (command === "situation.forecast_update") {
    userConfirmed(envelope);
    const situation = await get(store, "Situation", data.situation_id, "situation_id");
    const baseRevision = assertClientRevision(situation, data.base_revision, "base_revision");
    if (situation.payload.status === "closed") {
      throw new ValidationError("A closed Situation cannot receive a new forecast");
    }
    const paths = forecastPaths(data.paths, "paths");
    const comparableEventCount = Number(data.comparable_event_count ?? 0);
    if (!Number.isSafeInteger(comparableEventCount) || comparableEventCount < 0) {
      throw new ValidationError("comparable_event_count must be a non-negative integer");
    }
    const requestedMethod = optionalText(data.method, "method", { max: 80 }) ?? "heuristic_pressure";
    if (!["heuristic_pressure", "empirical_likelihood", "user_prior"].includes(requestedMethod)) {
      throw new ValidationError("method is unsupported");
    }
    const method = comparableEventCount < 20 && requestedMethod !== "user_prior"
      ? "heuristic_pressure"
      : requestedMethod;
    const forecastId = `forecast-${randomUUID()}`;
    const ledger = Array.isArray(situation.payload.forecast_ledger)
      ? situation.payload.forecast_ledger
      : [];
    const previousPaths = Array.isArray(situation.payload.scenario_paths)
      ? situation.payload.scenario_paths
      : [];
    return previewSingle(store, {
      operation: "update",
      entity_type: "Situation",
      entity_id: situation.entity_id,
      base_revision: baseRevision,
      payload: {
        intelligence_question: text(data.intelligence_question, "intelligence_question"),
        forecast_horizon: iso(data.forecast_horizon, "forecast_horizon"),
        next_observable: text(data.next_observable, "next_observable"),
        scenario_paths: paths,
        forecast_ledger: [...ledger, {
          forecast_id: forecastId,
          created_at: now,
          prior_paths: previousPaths,
          after_paths: paths,
          evidence_signal_id: optionalText(data.evidence_signal_id, "evidence_signal_id", { max: 100 }) ?? null,
          evidence_fact_state: optionalText(data.evidence_fact_state, "evidence_fact_state", { max: 40 }) ?? "user_prior",
          method,
          calibration_state: comparableEventCount >= 20 ? "calibrating" : "heuristic",
          comparable_event_count: comparableEventCount,
          accepted_by_user: true,
          resolution: null,
        }],
        last_forecast_id: forecastId,
        requires_decision: false,
      },
    });
  }

  if (command === "situation.forecast_resolve") {
    userConfirmed(envelope);
    const situation = await get(store, "Situation", data.situation_id, "situation_id");
    const baseRevision = assertClientRevision(situation, data.base_revision, "base_revision");
    const forecastId = text(data.forecast_id, "forecast_id", { max: 100 });
    const ledger = Array.isArray(situation.payload.forecast_ledger)
      ? structuredClone(situation.payload.forecast_ledger)
      : [];
    const index = ledger.findIndex((entry) => entry?.forecast_id === forecastId);
    if (index < 0) throw new ValidationError("forecast_id is unavailable in the Situation ledger");
    if (ledger[index].resolution) throw new ValidationError("The forecast is already resolved");
    const paths = forecastPaths(ledger[index].after_paths, "forecast.after_paths");
    const outcomePathId = text(data.outcome_path_id, "outcome_path_id", { max: 80 });
    ledger[index].resolution = {
      resolved_at: iso(data.resolved_at ?? now, "resolved_at"),
      outcome_path_id: outcomePathId,
      brier_score: multiclassBrier(paths, outcomePathId),
      notes: optionalText(data.notes, "notes") ?? "No resolution notes supplied.",
      resolved_by: "user",
    };
    return previewSingle(store, {
      operation: "update",
      entity_type: "Situation",
      entity_id: situation.entity_id,
      base_revision: baseRevision,
      payload: {
        forecast_ledger: ledger,
        last_forecast_resolution: ledger[index].resolution,
      },
    });
  }

  if (command === "mission.record_result") {
    userConfirmed(envelope);
    const mission = await get(store, "Mission", data.mission_id, "mission_id");
    const baseRevision = assertClientRevision(mission, data.base_revision, "base_revision");
    if (!ADJUSTABLE_MISSION_STATES.has(mission.payload.status)) {
      throw new ValidationError("Only active or blocked Missions can record an action result");
    }
    const resultState = text(data.result_state, "result_state", { max: 40 });
    if (!RESULT_STATES.has(resultState)) throw new ValidationError("result_state is invalid");
    const result = text(data.result, "result");
    const nextAction = text(data.next_action, "next_action");
    const reviewDate = iso(data.review_date, "review_date");
    const history = Array.isArray(mission.payload.action_history) ? mission.payload.action_history : [];
    const missionOperation = {
      operation: "update",
      entity_type: "Mission",
      entity_id: mission.entity_id,
      base_revision: baseRevision,
      payload: {
        next_action: nextAction,
        review_date: reviewDate,
        action_history: [...history, {
          recorded_at: now,
          result,
          result_state: resultState,
          actor: "user",
        }],
        last_result: { recorded_at: now, result, result_state: resultState },
        requires_decision: false,
      },
    };
    if (resultState === "no_change") return previewSingle(store, missionOperation);
    if (typeof previewBatch !== "function") throw new TypeError("previewBatch is required");
    const situationId = optionalText(mission.payload.situation_id, "mission.situation_id", { max: 80 });
    if (!situationId) {
      throw new ValidationError(
        "Changed or blocked results require a linked Situation for Before-to-Now review",
      );
    }
    const situation = await get(store, "Situation", situationId, "mission.situation_id");
    if (situation.payload.status === "closed") {
      throw new ValidationError("A closed Situation cannot receive an action-result adjustment draft");
    }
    if (situation.payload.adjustment_draft) {
      throw new ValidationError(
        "The linked Situation already has a pending adjustment draft; review it first",
      );
    }
    const before = text(
      situation.payload.current_assessment ?? situation.payload.now,
      "situation.current_assessment",
    );
    const impact = optionalText(data.situation_impact, "situation_impact")
      ?? (resultState === "blocked"
        ? "Mission execution is blocked; review whether the Situation assessment or watch conditions changed."
        : "Mission execution produced a changed result; review its effect on the Situation before changing the assessment.");
    return previewBatch([
      missionOperation,
      {
        operation: "update",
        entity_type: "Situation",
        entity_id: situation.entity_id,
        base_revision: situation.revision,
        payload: {
          adjustment_draft: {
            state: "awaiting_user_review",
            proposed_at: now,
            before,
            now: result,
            impact,
            source: {
              entity_type: "Mission",
              entity_id: mission.entity_id,
              result_state: resultState,
              recorded_at: now,
            },
          },
          requires_decision: true,
        },
      },
    ]);
  }

  if (command === "mission.propose_adjustment") {
    const mission = await get(store, "Mission", data.mission_id, "mission_id");
    const baseRevision = assertClientRevision(mission, data.base_revision, "base_revision");
    if (!ADJUSTABLE_MISSION_STATES.has(mission.payload.status)) {
      throw new ValidationError("Only active or blocked Missions can receive an adjustment draft");
    }
    const proposedStatus = text(data.proposed_status, "proposed_status", { max: 40 });
    if (!ADJUSTABLE_MISSION_STATES.has(proposedStatus)) {
      throw new ValidationError("proposed_status must be active or blocked");
    }
    return previewSingle(store, {
      operation: "update",
      entity_type: "Mission",
      entity_id: mission.entity_id,
      base_revision: baseRevision,
      payload: {
        adjustment_draft: {
          proposed_at: now,
          rationale: text(data.rationale, "rationale"),
          next_action: text(data.next_action, "next_action"),
          review_date: iso(data.review_date, "review_date"),
          proposed_status: proposedStatus,
        },
        requires_decision: true,
      },
    });
  }

  if (command === "mission.accept_adjustment") {
    userConfirmed(envelope);
    const mission = await get(store, "Mission", data.mission_id, "mission_id");
    const baseRevision = assertClientRevision(mission, data.base_revision, "base_revision");
    if (!ADJUSTABLE_MISSION_STATES.has(mission.payload.status)) {
      throw new ValidationError("An adjustment cannot reopen or close a Mission");
    }
    assertNoClientOverride(
      data,
      ["objective", "title", "status", "next_action", "review_date", "proposed_status"],
      command,
    );
    const draft = requiredDraft(mission, "Mission");
    const proposedStatus = text(draft.proposed_status, "adjustment_draft.proposed_status", { max: 40 });
    if (!ADJUSTABLE_MISSION_STATES.has(proposedStatus)) {
      throw new ValidationError("The Mission adjustment draft has an invalid proposed status");
    }
    const acceptedDraft = {
      rationale: text(draft.rationale, "adjustment_draft.rationale"),
      next_action: text(draft.next_action, "adjustment_draft.next_action"),
      review_date: iso(draft.review_date, "adjustment_draft.review_date"),
      proposed_status: proposedStatus,
      proposed_at: optionalText(draft.proposed_at, "adjustment_draft.proposed_at") ?? null,
    };
    const adjustmentHistory = Array.isArray(mission.payload.adjustment_history)
      ? mission.payload.adjustment_history
      : [];
    return previewSingle(store, {
      operation: "update",
      entity_type: "Mission",
      entity_id: mission.entity_id,
      base_revision: baseRevision,
      payload: {
        next_action: acceptedDraft.next_action,
        review_date: acceptedDraft.review_date,
        status: acceptedDraft.proposed_status,
        adjustment_draft: null,
        requires_decision: false,
        adjustment_history: [...adjustmentHistory, {
          decision: "accepted",
          decided_at: now,
          actor: "user",
          proposal: acceptedDraft,
        }],
        last_adjustment_decision: { decision: "accepted", decided_at: now, actor: "user" },
      },
    });
  }

  if (command === "mission.dismiss_adjustment") {
    userConfirmed(envelope);
    const mission = await get(store, "Mission", data.mission_id, "mission_id");
    const baseRevision = assertClientRevision(mission, data.base_revision, "base_revision");
    assertNoClientOverride(
      data,
      ["objective", "title", "status", "next_action", "review_date", "proposed_status"],
      command,
    );
    const draft = requiredDraft(mission, "Mission");
    const adjustmentHistory = Array.isArray(mission.payload.adjustment_history)
      ? mission.payload.adjustment_history
      : [];
    return previewSingle(store, {
      operation: "update",
      entity_type: "Mission",
      entity_id: mission.entity_id,
      base_revision: baseRevision,
      payload: {
        adjustment_draft: null,
        requires_decision: false,
        adjustment_history: [...adjustmentHistory, {
          decision: "dismissed",
          decided_at: now,
          actor: "user",
          proposal: structuredClone(draft),
        }],
        last_adjustment_decision: { decision: "dismissed", decided_at: now, actor: "user" },
      },
    });
  }

  if (command === "situation.propose_adjustment") {
    const situation = await get(store, "Situation", data.situation_id, "situation_id");
    const baseRevision = assertClientRevision(situation, data.base_revision, "base_revision");
    return previewSingle(store, {
      operation: "update",
      entity_type: "Situation",
      entity_id: situation.entity_id,
      base_revision: baseRevision,
      payload: {
        adjustment_draft: {
          state: "awaiting_user_review",
          proposed_at: now,
          before: text(data.before, "before"),
          now: text(data.now, "now"),
          impact: text(data.impact, "impact"),
        },
        requires_decision: true,
      },
    });
  }

  if (command === "situation.dismiss_adjustment") {
    userConfirmed(envelope);
    const situation = await get(store, "Situation", data.situation_id, "situation_id");
    const baseRevision = assertClientRevision(situation, data.base_revision, "base_revision");
    const draft = requiredDraft(situation, "Situation");
    const adjustmentHistory = Array.isArray(situation.payload.adjustment_history)
      ? situation.payload.adjustment_history
      : [];
    return previewSingle(store, {
      operation: "update",
      entity_type: "Situation",
      entity_id: situation.entity_id,
      base_revision: baseRevision,
      payload: {
        adjustment_draft: null,
        requires_decision: false,
        adjustment_history: [...adjustmentHistory, {
          decision: "dismissed",
          decided_at: now,
          actor: "user",
          proposal: structuredClone(draft),
        }],
        last_adjustment_decision: { decision: "dismissed", decided_at: now, actor: "user" },
      },
    });
  }

  if (command === "situation.accept_adjustment") {
    userConfirmed(envelope);
    const situation = await get(store, "Situation", data.situation_id, "situation_id");
    const baseRevision = assertClientRevision(situation, data.base_revision, "base_revision");
    let inbox;
    let inboxRevision;
    let draftSource = { entity_type: "Situation", entity_id: situation.entity_id };
    if (data.inbox_id) {
      if (typeof previewBatch !== "function") throw new TypeError("previewBatch is required");
      inbox = await get(store, "InboxItem", data.inbox_id, "inbox_id");
      assertInboxStatus(inbox, TRIAGEABLE_INBOX_STATES, command);
      inboxRevision = assertClientRevision(inbox, data.inbox_base_revision, "inbox_base_revision");
      if (!inboxTargetsSituation(inbox, situation.entity_id)) {
        throw new ValidationError("Inbox adjustment draft does not target the requested Situation");
      }
      if (situation.payload.adjustment_draft) {
        throw new ValidationError(
          "The Situation already has a pending adjustment draft; review it before accepting an Inbox draft",
        );
      }
      draftSource = { entity_type: "InboxItem", entity_id: inbox.entity_id };
    }
    const draft = requiredDraft(inbox ?? situation, inbox ? "InboxItem" : "Situation");
    if (
      !inbox
      && draft.source
      && typeof draft.source === "object"
      && !Array.isArray(draft.source)
      && draft.source.entity_type === "Mission"
      && typeof draft.source.entity_id === "string"
    ) {
      draftSource = {
        entity_type: "Mission",
        entity_id: text(draft.source.entity_id, "adjustment_draft.source.entity_id", { max: 80 }),
      };
    }
    if (draft.state !== "awaiting_user_review") {
      throw new ValidationError("The adjustment draft is not awaiting user review");
    }
    const proposed = {
      before: text(draft.before, "adjustment_draft.before"),
      now: text(draft.now, "adjustment_draft.now"),
      impact: text(draft.impact, "adjustment_draft.impact"),
      proposed_at: optionalText(draft.proposed_at, "adjustment_draft.proposed_at") ?? null,
    };
    const decisionMode = data.decision_mode === undefined
      ? "accept"
      : text(data.decision_mode, "decision_mode", { max: 20 });
    if (!new Set(["accept", "edit"]).has(decisionMode)) {
      throw new ValidationError("decision_mode must be accept or edit");
    }
    let accepted;
    let editReason = null;
    if (decisionMode === "edit") {
      accepted = {
        before: text(data.before, "before"),
        now: text(data.now, "now"),
        impact: text(data.impact, "impact"),
      };
      editReason = text(data.edit_reason, "edit_reason");
    } else {
      accepted = { before: proposed.before, now: proposed.now, impact: proposed.impact };
      for (const field of ["before", "now", "impact"]) {
        if (data[field] !== undefined && text(data[field], field) !== proposed[field]) {
          throw new ValidationError(`${field} does not match the authoritative adjustment draft`);
        }
      }
    }
    const adjustmentHistory = Array.isArray(situation.payload.adjustment_history) ? situation.payload.adjustment_history : [];
    const acceptedMaterialChange = data.material_change !== false;
    const draftReviewAt = optionalText(draft.next_review_at, "adjustment_draft.next_review_at");
    const evidence = inbox
      ? [...(Array.isArray(situation.payload.evidence) ? situation.payload.evidence : []), inboxEvidence(inbox, accepted, now)]
      : situation.payload.evidence;
    const timeline = inbox
      ? [...(Array.isArray(situation.payload.timeline) ? situation.payload.timeline : []), inboxTimelinePoint(inbox, accepted, now)]
      : situation.payload.timeline;
    const indicatorSeries = inbox
      ? upsertIndicatorSeries(
        situation.payload.indicator_series,
        indicatorObservationFromInbox(inbox),
      )
      : situation.payload.indicator_series;
    const situationOperation = {
      operation: "update",
      entity_type: "Situation",
      entity_id: situation.entity_id,
      base_revision: baseRevision,
      payload: {
        before: accepted.before,
        now: accepted.now,
        current_assessment: accepted.now,
        impact: accepted.impact,
        material_change: acceptedMaterialChange,
        material_change_decided_at: now,
        material_change_acknowledged_at: null,
        last_material_change: {
          accepted_at: now,
          before: accepted.before,
          now: accepted.now,
          impact: accepted.impact,
          source: draftSource,
          review_due_at: draftReviewAt ?? situation.payload.next_review_at,
        },
        ...(draftReviewAt ? { next_review_at: iso(draftReviewAt, "adjustment_draft.next_review_at") } : {}),
        requires_decision: false,
        adjustment_draft: null,
        ...(inbox ? {
          evidence,
          timeline,
          source_inbox_ids: uniqueAppend(situation.payload.source_inbox_ids, inbox.entity_id),
          indicator_series: indicatorSeries,
        } : {}),
        adjustment_history: [...adjustmentHistory, {
          decision: "accepted",
          decided_at: now,
          actor: "user",
          decision_mode: decisionMode,
          edit_reason: editReason,
          draft_source: draftSource,
          proposal: proposed,
          accepted,
        }],
        last_adjustment_decision: { decision: "accepted", decided_at: now, actor: "user" },
      },
    };
    if (!inbox) return previewSingle(store, situationOperation);
    return previewBatch([
      situationOperation,
      {
        operation: "update",
        entity_type: "InboxItem",
        entity_id: inbox.entity_id,
        base_revision: inboxRevision,
        payload: {
          status: "linked",
          linked_situation_id: situation.entity_id,
          requires_decision: false,
          adjustment_draft: null,
          triage: { decision: "accepted_adjustment", decided_at: now, actor: "user" },
        },
      },
    ]);
  }

  if (command === "situation.acknowledge_material_change") {
    userConfirmed(envelope);
    const situation = await get(store, "Situation", data.situation_id, "situation_id");
    const baseRevision = assertClientRevision(situation, data.base_revision, "base_revision");
    if (situation.payload.material_change !== true) {
      throw new ValidationError("Situation has no accepted material change to acknowledge");
    }
    if (situation.payload.adjustment_draft || situation.payload.requires_decision === true) {
      throw new ValidationError(
        "Review the pending Situation decision before acknowledging its material change",
      );
    }
    const history = Array.isArray(situation.payload.material_change_history)
      ? situation.payload.material_change_history
      : [];
    return previewSingle(store, {
      operation: "update",
      entity_type: "Situation",
      entity_id: situation.entity_id,
      base_revision: baseRevision,
      payload: {
        material_change: false,
        material_change_acknowledged_at: now,
        material_change_history: [...history, {
          decision: "acknowledged",
          decided_at: now,
          actor: "user",
          material_change_decided_at: situation.payload.material_change_decided_at ?? null,
          snapshot: situation.payload.last_material_change ?? null,
        }],
      },
    });
  }

  if (command === "review.create") {
    userConfirmed(envelope);
    if (typeof previewBatch !== "function") throw new TypeError("previewBatch is required");
    const mission = await get(store, "Mission", data.mission_id, "mission_id");
    const baseRevision = assertClientRevision(mission, data.base_revision, "base_revision");
    const transition = text(data.mission_transition, "mission_transition", { max: 40 });
    if (!MISSION_TRANSITIONS.has(transition)) throw new ValidationError("mission_transition is invalid");
    const reviewId = `review-${randomUUID()}`;
    const reviewedAt = iso(data.reviewed_at ?? now, "reviewed_at");
    const nextAction = transition === "completed" || transition === "cancelled"
      ? `No action · Mission ${transition}`
      : text(data.next_action, "next_action");
    const reviewDate = transition === "completed" || transition === "cancelled"
      ? reviewedAt
      : iso(data.review_date, "review_date");
    return previewBatch([
      {
        operation: "create",
        entity_type: "Review",
        entity_id: reviewId,
        base_revision: 0,
        payload: {
          title: text(data.title, "title"),
          mission_id: mission.entity_id,
          mission_title: mission.payload.title,
          reviewed_at: reviewedAt,
          outcome: text(data.outcome, "outcome"),
          assessment_change: text(data.assessment_change, "assessment_change"),
          next_state: text(data.next_state, "next_state"),
          situation_id: mission.payload.situation_id ?? null,
        },
      },
      {
        operation: "update",
        entity_type: "Mission",
        entity_id: mission.entity_id,
        base_revision: baseRevision,
        payload: {
          status: transition,
          next_action: nextAction,
          review_date: reviewDate,
          requires_decision: false,
          last_review_id: reviewId,
          adjustment_draft: null,
        },
      },
    ]);
  }

  throw new ValidationError(`Unsupported command: ${command}`);
}

export async function assertSafeGenericPreview(store, body) {
  const operation = record(body, "preview");
  if (operation.entity_type !== "InboxItem" || operation.operation !== "create") {
    throw new ValidationError("Generic previews are restricted to new unverified InboxItem leads; use a typed command");
  }
  const payload = record(operation.payload, "payload");
  if (payload.status !== undefined && payload.status !== "new") {
    throw new ValidationError("Generic InboxItem previews must start with status new");
  }
  if (![undefined, "unverified_external", "manual_snapshot", "official_proxy"].includes(payload.evidence_status)) {
    throw new ValidationError("Generic previews cannot create verified evidence");
  }
  return store.preview({
    operation: "create",
    entity_type: "InboxItem",
    entity_id: operation.entity_id,
    base_revision: operation.base_revision,
    payload: { ...payload, status: "new", evidence_status: payload.evidence_status ?? "unverified_external" },
  });
}
