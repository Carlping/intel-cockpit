import {
  ConflictError,
  CorruptionError,
  NotFoundError,
  PreviewExpiredError,
  ValidationError,
} from "../store/index.mjs";
import { assertSafeGenericPreview, previewTypedCommand } from "./command-service.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const COLLECTION_TYPES = Object.freeze({
  inbox: "InboxItem",
  situations: "Situation",
  missions: "Mission",
  reviews: "Review",
});
const TRUFLATION_SOURCE_URL = "https://truflation.com/marketplace/us-inflation-rate";
const MAX_BATCH_OPERATIONS = 40;

async function createBatchPreview(store, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > MAX_BATCH_OPERATIONS) {
    throw new ValidationError(`operations must contain 1-${MAX_BATCH_OPERATIONS} writes`);
  }
  const previews = [];
  const keys = new Set();
  for (const operation of operations) {
    const preview = await store.preview(normalizeRoutePreviewBody(operation));
    const key = `${preview.entity.entity_type}:${preview.entity.entity_id}`;
    if (keys.has(key)) throw new ValidationError("A batch cannot write the same entity twice");
    keys.add(key);
    previews.push(preview);
  }
  return {
    preview_ids: previews.map((preview) => preview.preview_id),
    operation_count: previews.length,
    diff: previews.flatMap((preview, index) => [
      { path: `operations[${index}]`, before: null, after: `${preview.entity.entity_type}:${preview.entity.entity_id}` },
      ...preview.diff,
    ]),
  };
}

export async function recoverPendingBatches(store) {
  if (typeof store?.recoverTransactions !== "function") return [];
  return store.recoverTransactions();
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new ValidationError(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new ValidationError(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  if (!text.trim()) throw new ValidationError("JSON request body is required");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidationError("JSON request body must be an object");
    }
    return value;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("Request body contains invalid JSON", { cause: error });
  }
}

function parseSegments(url) {
  try {
    return url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch (error) {
    throw new ValidationError("URL path contains invalid encoding", { cause: error });
  }
}

function parseLimit(url) {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 1_000;
  if (!/^\d+$/.test(raw)) throw new ValidationError("limit must be an integer");
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new ValidationError("limit must be between 1 and 10000");
  }
  return limit;
}

function activeEntity(entity) {
  return !["closed", "completed", "cancelled", "not_relevant"].includes(
    entity.payload?.status,
  );
}

const ACTIVE_INBOX_STATUSES = new Set(["new", "linked", "wiki_ingest_pending"]);
const LEGACY_WIKI_PLACEHOLDER = /^Wiki note (?:added|modified); review the existing ingest/i;

function hasDecisionGradeContent(entity) {
  const payload = entity?.payload;
  if (!payload || typeof payload !== "object") return false;
  const sourcePayload = payload.source_payload && typeof payload.source_payload === "object"
    ? payload.source_payload
    : {};
  if (payload.source_type === "wiki_read_only") {
    return sourcePayload.decision_grade === true
      && sourcePayload.source_excerpt_included === true
      && typeof payload.summary === "string"
      && payload.summary.trim().length >= 40;
  }
  if (payload.source_type === "official_feed") {
    return payload.routing_state !== "quiet_inbox"
      && typeof payload.summary === "string"
      && payload.summary.trim().length >= 40;
  }
  if (LEGACY_WIKI_PLACEHOLDER.test(String(payload.summary || ""))) return false;
  return true;
}

export function activeInboxEntity(entity) {
  return entity?.entity_type === "InboxItem"
    && ACTIVE_INBOX_STATUSES.has(entity.payload?.status)
    && hasDecisionGradeContent(entity);
}

async function collectConnectorHealth(connectors) {
  if (!connectors) return [];
  if (typeof connectors.getHealth === "function") {
    const result = await connectors.getHealth();
    const reports = Array.isArray(result) ? result : [result];
    return reports.map((report) => ({
      ...report,
      health_state: report?.health_state ?? report?.state ?? "unknown",
    }));
  }

  const health = [];
  for (const [connectorId, connector] of Object.entries(connectors)) {
    if (!connector || typeof connector.getHealth !== "function") continue;
    try {
      const result = await connector.getHealth();
      health.push({
        connector_id: connectorId,
        ...result,
        health_state: result?.health_state ?? result?.state ?? "unknown",
      });
    } catch {
      health.push({ connector_id: connectorId, health_state: "degraded" });
    }
  }
  return health;
}

async function createNowProjection(store, connectors) {
  const [inbox, situations, missions, reviews, connectorHealth] = await Promise.all([
    store.list("InboxItem"),
    store.list("Situation"),
    store.list("Mission"),
    store.list("Review"),
    collectConnectorHealth(connectors),
  ]);

  const needsYou = [...inbox, ...situations, ...missions]
    .filter((entity) =>
      activeEntity(entity)
      && entity.payload?.requires_decision === true
      && (entity.entity_type !== "InboxItem" || entity.payload?.status === "new"))
    .slice(0, 3);
  const materialChanges = situations
    .filter((entity) => activeEntity(entity) && entity.payload?.material_change === true)
    .slice(0, 3);
  const nextActions = missions
    .filter(
      (entity) =>
        activeEntity(entity) &&
        typeof entity.payload?.next_action === "string" &&
        entity.payload.next_action.trim(),
    )
    .slice(0, 3);
  const watching = situations
    .filter(
      (entity) =>
        activeEntity(entity) &&
        (entity.payload?.status === "watch" ||
          (Array.isArray(entity.payload?.watch_conditions) &&
            entity.payload.watch_conditions.length > 0)),
    )
    .slice(0, 10);

  const briefingItems = [];
  const seen = new Set();
  for (const entity of [...needsYou, ...materialChanges, ...nextActions]) {
    const key = `${entity.entity_type}:${entity.entity_id}`;
    if (seen.has(key)) continue;
    briefingItems.push(entity);
    seen.add(key);
    if (briefingItems.length === 3) break;
  }

  let generatedBriefing = null;
  let liveSignals = [];
  if (typeof connectors?.getBriefing === "function") {
    try {
      generatedBriefing = await connectors.getBriefing();
    } catch {
      generatedBriefing = null;
    }
  }
  if (typeof connectors?.signals?.list === "function") {
    try {
      liveSignals = (await connectors.signals.list())
        .filter((signal) => ["live_signal", "corroborated"].includes(signal.status))
        .slice(0, 3);
    } catch {
      liveSignals = [];
    }
  }
  let forwardIntelligence = null;
  if (typeof connectors?.forwardIntelligence?.getNowProjection === "function") {
    try {
      forwardIntelligence = await connectors.forwardIntelligence.getNowProjection({
        situations,
        missions,
        reviews,
        connectorHealth,
      });
    } catch {
      forwardIntelligence = null;
    }
  }
  let evidenceLoop = null;
  if (typeof connectors?.evidenceLoop?.getProjection === "function") {
    try {
      evidenceLoop = await connectors.evidenceLoop.getProjection();
    } catch {
      evidenceLoop = null;
    }
  }
  const allEntities = [...inbox, ...situations, ...missions, ...reviews];
  const latestTimestamp = allEntities
    .map((entity) => entity.updated_at)
    .filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? new Date().toISOString();
  const revision = allEntities.reduce(
    (total, entity) => total + (Number.isSafeInteger(entity.revision) ? entity.revision : 0),
    0,
  );

  return {
    mode: "live_local",
    as_of: latestTimestamp,
    revision,
    needs_you: needsYou,
    material_changes: materialChanges,
    next_actions: nextActions,
    watching,
    connector_health: connectorHealth,
    live_signals: liveSignals,
    forward_intelligence: forwardIntelligence,
    evidence_loop: evidenceLoop,
    briefing: generatedBriefing ?? {
      status: briefingItems.length ? "ready" : "quiet",
      items: briefingItems,
      latest_review_at: reviews[0]?.updated_at ?? null,
    },
  };
}

function createForwardEventStream(connectors) {
  if (typeof connectors?.forwardIntelligence?.subscribe !== "function") {
    return json({ error: { code: "CONNECTOR_DISABLED", message: "Forward stream is disabled" } }, 503);
  }
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("ready", { mode: "forward_intelligence_v2", connected_at: new Date().toISOString() });
      unsubscribe = connectors.forwardIntelligence.subscribe((event) => send("change", event));
      heartbeat = setInterval(() => send("heartbeat", { at: new Date().toISOString() }), 15_000);
      heartbeat.unref?.();
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    },
  });
}

function normalizeRoutePreviewBody(body, defaults = {}) {
  return {
    operation: defaults.operation ?? body.operation,
    entity_type: defaults.entity_type ?? body.entity_type,
    entity_id: defaults.entity_id ?? body.entity_id,
    base_revision: body.base_revision,
    payload: body.payload,
  };
}

async function createTruflationPreview(store, connectors, body) {
  if (body.base_revision !== 0 && body.base_revision !== undefined) {
    throw new ConflictError("Truflation manual observations use the server's current canonical revision");
  }
  if (body.confirmed_by_user !== true) {
    throw new ValidationError("confirmed_by_user must be true for a manual snapshot");
  }
  if (typeof body.observation_date !== "string" || Number.isNaN(Date.parse(body.observation_date))) {
    throw new ValidationError("observation_date must be an ISO date or timestamp");
  }
  if (typeof body.value !== "number" || !Number.isFinite(body.value)) {
    throw new ValidationError("value must be a finite number");
  }

  const snapshot = {
    observation_date: body.observation_date.slice(0, 10),
    value: body.value,
    unit: body.unit ?? "percent_yoy",
  };

  let observation = {
    series_id: "TruCPI-US",
    ...snapshot,
    retrieved_at: body.retrieved_at ?? new Date().toISOString(),
    source_url: TRUFLATION_SOURCE_URL,
    source_type: "manual_snapshot",
    confirmed_by_user: true,
  };
  if (connectors?.truflation?.manualObservation) {
    observation = await connectors.truflation.manualObservation(observation);
  }

  const observationDay = body.observation_date.slice(0, 10);
  const entityId = `inbox-truflation-us-${observationDay}`;
  let current = null;
  try {
    current = await store.get("InboxItem", entityId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
  const currentObservation = current?.payload?.observation;
  const currentSnapshot = current?.payload?.snapshot ?? {
    observation_date:
      currentObservation?.observation_date ?? currentObservation?.as_of?.slice?.(0, 10),
    value: currentObservation?.value ?? currentObservation?.payload?.value,
    unit: currentObservation?.unit ?? currentObservation?.payload?.unit,
  };
  const unchanged = current
    && currentSnapshot.observation_date === snapshot.observation_date
    && currentSnapshot.value === snapshot.value
    && currentSnapshot.unit === snapshot.unit;
  if (unchanged) {
    return { no_op: true, entity: current, diff: [] };
  }

  return store.preview({
    operation: current ? "update" : "create",
    entity_type: "InboxItem",
    entity_id: entityId,
    base_revision: current?.revision ?? 0,
    payload: {
      title: `Truflation US CPI 手動快照 · ${observationDay}`,
      status: "new",
      domain: "macro",
      source_type: "manual_snapshot",
      source_url: TRUFLATION_SOURCE_URL,
      evidence_status: "unverified_external",
      confirmed_by_user: true,
      alternative_inflation_estimate: true,
      snapshot,
      observation,
    },
  });
}

function errorResponse(error) {
  if (error?.name === "ConnectorValidationError") {
    return json(
      { error: { code: error.code ?? "CONNECTOR_VALIDATION_ERROR", message: error.message } },
      400,
    );
  }
  if (error?.name === "ConnectorDisabledError") {
    return json(
      { error: { code: error.code ?? "CONNECTOR_DISABLED", message: error.message } },
      503,
    );
  }
  if (error?.name === "ConnectorRequestError") {
    return json(
      { error: { code: error.code ?? "CONNECTOR_REQUEST_FAILED", message: error.message } },
      error.status === 429 ? 429 : 502,
    );
  }
  if (error instanceof ValidationError) {
    return json({ error: { code: error.code, message: error.message } }, 400);
  }
  if (error instanceof TypeError) {
    return json({ error: { code: "INVALID_INPUT", message: error.message } }, 400);
  }
  if (error instanceof ConflictError) {
    return json({ error: { code: error.code, message: error.message } }, 409);
  }
  if (error instanceof NotFoundError) {
    return json({ error: { code: error.code, message: error.message } }, 404);
  }
  if (error instanceof PreviewExpiredError) {
    return json({ error: { code: error.code, message: error.message } }, 410);
  }
  if (error instanceof CorruptionError) {
    return json({ error: { code: error.code, message: "Canonical state integrity check failed" } }, 500);
  }
  return json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
}

export function createApiHandler({ store, connectors } = {}) {
  if (!store || typeof store.list !== "function" || typeof store.preview !== "function") {
    throw new TypeError("createApiHandler requires an initialized intelligence store");
  }

  const handle = async (request) => {
    try {
      const url = new URL(request.url);
      const segments = parseSegments(url);
      if (segments[0] !== "api" || !["v1", "v2"].includes(segments[1])) {
        return json({ error: { code: "NOT_FOUND", message: "API route not found" } }, 404);
      }
      const version = segments[1];
      const route = segments.slice(2);

      if (version === "v2" && request.method === "GET" && route.join("/") === "stream") {
        return createForwardEventStream(connectors);
      }

      if (request.method === "GET" && route.length === 1 && route[0] === "now") {
        const projection = await createNowProjection(store, connectors);
        if (version === "v1") {
          delete projection.forward_intelligence;
          delete projection.evidence_loop;
        }
        return json({ data: projection });
      }

      if (version === "v2" && request.method === "GET" && route.join("/") === "evidence-loop") {
        if (typeof connectors?.evidenceLoop?.getProjection !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "Evidence loop is disabled" } }, 503);
        }
        return json({ data: await connectors.evidenceLoop.getProjection() });
      }

      if (version === "v2" && request.method === "POST" && route.join("/") === "evidence-loop/sec/setup") {
        if (typeof connectors?.evidenceLoop?.setupSec !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "SEC connector is disabled" } }, 503);
        }
        return json({ data: await connectors.evidenceLoop.setupSec(await readJson(request)) });
      }

      if (version === "v2" && request.method === "POST" && route.join("/") === "evidence-loop/fred/setup") {
        if (typeof connectors?.evidenceLoop?.setupFred !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "FRED connector is disabled" } }, 503);
        }
        return json({ data: await connectors.evidenceLoop.setupFred(await readJson(request)) });
      }

      if (version === "v2" && request.method === "POST" && route.join("/") === "evidence-loop/refresh") {
        if (typeof connectors?.evidenceLoop?.refresh !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "Evidence loop is disabled" } }, 503);
        }
        return json({ data: await connectors.evidenceLoop.refresh(await readJson(request)) });
      }

      if (version === "v2" && request.method === "GET" && route.join("/") === "event-windows") {
        if (typeof connectors?.forwardIntelligence?.listEventWindows !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "Event windows are disabled" } }, 503);
        }
        return json({ data: await connectors.forwardIntelligence.listEventWindows() });
      }

      if (
        version === "v2"
        && request.method === "GET"
        && route.length === 2
        && route[0] === "signals"
      ) {
        const signal = await connectors?.forwardIntelligence?.getSignal?.(route[1]);
        if (!signal) return json({ error: { code: "NOT_FOUND", message: "Signal not found" } }, 404);
        return json({ data: signal });
      }

      if (
        version === "v2"
        && request.method === "POST"
        && route.length === 3
        && route[0] === "signals"
        && route[2] === "disposition"
      ) {
        if (typeof connectors?.forwardIntelligence?.disposition !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "Fast Lane dispositions are disabled" } }, 503);
        }
        const body = await readJson(request);
        if (body.action === "link_situation") {
          if (typeof body.situation_id !== "string" || !body.situation_id) {
            throw new ValidationError("situation_id is required when linking a signal");
          }
          await store.get("Situation", body.situation_id);
        }
        return json({ data: await connectors.forwardIntelligence.disposition(route[1], body) });
      }

      if (version === "v2" && request.method === "GET" && route.join("/") === "sources/performance") {
        if (typeof connectors?.forwardIntelligence?.getSourcePerformance !== "function") {
          return json({ data: [] });
        }
        return json({ data: await connectors.forwardIntelligence.getSourcePerformance() });
      }

      if (
        version === "v2"
        && route.length === 3
        && route[0] === "situations"
        && route[2] === "forecast"
      ) {
        const situation = await store.get("Situation", route[1]);
        if (request.method === "GET") {
          return json({ data: {
            situation_id: situation.entity_id,
            revision: situation.revision,
            intelligence_question: situation.payload.intelligence_question ?? null,
            forecast_horizon: situation.payload.forecast_horizon ?? null,
            next_observable: situation.payload.next_observable ?? null,
            paths: situation.payload.scenario_paths ?? [],
            ledger: situation.payload.forecast_ledger ?? [],
          } });
        }
        if (request.method === "POST") {
          const body = await readJson(request);
          return json({ data: await previewTypedCommand({
            store,
            body: {
              command: "situation.forecast_update",
              user_confirmation: body.user_confirmation,
              data: { ...body, situation_id: situation.entity_id },
            },
            previewBatch: (operations) => createBatchPreview(store, operations),
          }) });
        }
      }

      if (
        version === "v2"
        && request.method === "POST"
        && route.length === 3
        && route[0] === "forecasts"
        && route[2] === "resolve"
      ) {
        const body = await readJson(request);
        const situations = await store.list("Situation");
        const situation = situations.find((entity) =>
          Array.isArray(entity.payload.forecast_ledger)
          && entity.payload.forecast_ledger.some((entry) => entry?.forecast_id === route[1]));
        if (!situation) return json({ error: { code: "NOT_FOUND", message: "Forecast not found" } }, 404);
        return json({ data: await previewTypedCommand({
          store,
          body: {
            command: "situation.forecast_resolve",
            user_confirmation: body.user_confirmation,
            data: {
              ...body,
              situation_id: situation.entity_id,
              forecast_id: route[1],
            },
          },
          previewBatch: (operations) => createBatchPreview(store, operations),
        }) });
      }

      if (
        request.method === "GET" &&
        route.length === 1 &&
        Object.hasOwn(COLLECTION_TYPES, route[0])
      ) {
        const entities = await store.list(COLLECTION_TYPES[route[0]], { limit: parseLimit(url) });
        return json({
          data: route[0] === "inbox" ? entities.filter(activeInboxEntity) : entities,
        });
      }

      if (
        request.method === "GET" &&
        route.length === 2 &&
        Object.hasOwn(COLLECTION_TYPES, route[0])
      ) {
        return json({ data: await store.get(COLLECTION_TYPES[route[0]], route[1]) });
      }

      if (request.method === "POST" && route.join("/") === "commands/preview") {
        const body = await readJson(request);
        if (typeof body.command === "string") {
          return json({
            data: await previewTypedCommand({
              store,
              body,
              previewBatch: (operations) => createBatchPreview(store, operations),
              verifyWikiSource: connectors?.verifyWikiSource,
              excludedSegments: connectors?.excludedSegments,
            }),
          }, 200);
        }
        if (Array.isArray(body.operations)) {
          throw new ValidationError("Raw batch operations are not accepted; use a typed command");
        }
        return json({ data: await assertSafeGenericPreview(store, normalizeRoutePreviewBody(body)) }, 200);
      }

      if (request.method === "POST" && route.join("/") === "commands/commit") {
        const body = await readJson(request);
        if (Array.isArray(body.preview_ids)) {
          return json({ data: await store.commitBatch(body.preview_ids) }, 200);
        }
        return json({ data: { entity: await store.commit(body.preview_id) } }, 200);
      }

      if (request.method === "POST" && route.length === 1 && route[0] === "inbox") {
        const body = await readJson(request);
        return json({
          data: await assertSafeGenericPreview(
            store,
            normalizeRoutePreviewBody(body, { operation: "create", entity_type: "InboxItem" }),
          ),
        });
      }

      if (request.method === "POST" && route.length === 1 && route[0] === "reviews") {
        const body = await readJson(request);
        return json({
          data: await previewTypedCommand({
            store,
            body: { ...body, command: "review.create", data: body.data ?? body },
            previewBatch: (operations) => createBatchPreview(store, operations),
          }),
        });
      }

      if (
        request.method === "PATCH" &&
        route.length === 2 &&
        ["situations", "missions"].includes(route[0])
      ) {
        const body = await readJson(request);
        if (typeof body.command !== "string") {
          throw new ValidationError("PATCH requires a typed command");
        }
        return json({
          data: await previewTypedCommand({
            store,
            body: {
              ...body,
              data: {
                ...(body.data ?? {}),
                [`${route[0] === "situations" ? "situation" : "mission"}_id`]: route[1],
              },
            },
            previewBatch: (operations) => createBatchPreview(store, operations),
          }),
        });
      }

      if (request.method === "GET" && route.join("/") === "connectors/health") {
        return json({ data: await collectConnectorHealth(connectors) });
      }

      if (request.method === "GET" && route.join("/") === "connectors/telegram/groups") {
        if (typeof connectors?.telegram?.groups !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "Telegram groups are disabled" } }, 503);
        }
        return json({ data: await connectors.telegram.groups() });
      }

      if (request.method === "POST" && route.join("/") === "connectors/telegram/groups/preview") {
        if (typeof connectors?.telegram?.previewGroupChange !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "Telegram groups are disabled" } }, 503);
        }
        return json({ data: await connectors.telegram.previewGroupChange(await readJson(request)) });
      }

      if (request.method === "POST" && route.join("/") === "connectors/telegram/groups/commit") {
        if (typeof connectors?.telegram?.commitGroupChange !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "Telegram groups are disabled" } }, 503);
        }
        return json({ data: await connectors.telegram.commitGroupChange(await readJson(request)) });
      }

      if (request.method === "GET" && route.length === 1 && route[0] === "signals") {
        if (typeof connectors?.signals?.list !== "function") return json({ data: [] });
        return json({ data: await connectors.signals.list() });
      }

      if (request.method === "POST" && route.join("/") === "signals/dispositions/preview") {
        if (typeof connectors?.signals?.previewDispositions !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "Signal dispositions are disabled" } }, 503);
        }
        return json({ data: await connectors.signals.previewDispositions(await readJson(request)) });
      }

      if (request.method === "POST" && route.join("/") === "signals/dispositions/commit") {
        if (typeof connectors?.signals?.commitDispositions !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "Signal dispositions are disabled" } }, 503);
        }
        return json({ data: await connectors.signals.commitDispositions(await readJson(request)) });
      }

      if (
        request.method === "POST"
        && route.length === 3
        && route[0] === "signals"
        && route[2] === "disposition"
      ) {
        if (typeof connectors?.signals?.previewDispositions !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "Signal dispositions are disabled" } }, 503);
        }
        const body = await readJson(request);
        return json({
          data: await connectors.signals.previewDispositions({ ...body, signal_id: route[1] }),
        });
      }

      if (request.method === "POST" && route.join("/") === "connectors/telegram/bootstrap") {
        if (!connectors?.telegram || typeof connectors.telegram.bootstrap !== "function") {
          return json(
            { error: { code: "CONNECTOR_DISABLED", message: "Telegram connector is disabled" } },
            503,
          );
        }
        const body = await readJson(request);
        return json({ data: await connectors.telegram.bootstrap(body) });
      }

      if (
        version === "v2"
        && request.method === "POST"
        && route.join("/") === "connectors/alpaca/bootstrap"
      ) {
        if (typeof connectors?.marketReaction?.bootstrap !== "function") {
          return json({ error: { code: "CONNECTOR_DISABLED", message: "Alpaca IEX adapter is disabled" } }, 503);
        }
        return json({ data: await connectors.marketReaction.bootstrap(await readJson(request)) });
      }

      if (
        request.method === "POST" &&
        route.join("/") === "connectors/truflation/manual-observation"
      ) {
        return json({ data: await createTruflationPreview(store, connectors, await readJson(request)) });
      }

      return json({ error: { code: "NOT_FOUND", message: "API route not found" } }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };

  return Object.freeze({ handle, fetch: handle });
}
