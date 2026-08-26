import { createHash } from "node:crypto";
import {
  fallbackEventWindows,
  mergeEventWindows,
  parseBlsCalendarIcs,
  windowState,
} from "./event-calendars.mjs";
import { formatFlashAlert, parseEconomicRelease } from "./release-parser.mjs";

const STATE_NAME = "forward-intelligence-v2-state";
const FLASH_RETENTION_MS = 24 * 60 * 60 * 1_000;
const SOURCE_PERFORMANCE_RETENTION = 250;
const MAX_SIGNALS = 200;
const BLS_CALENDAR_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const OFFICIAL_RELEASE_URLS = Object.freeze({
  cpi: "https://www.bls.gov/news.release/cpi.nr0.htm",
  ppi: "https://www.bls.gov/news.release/ppi.nr0.htm",
  employment: "https://www.bls.gov/news.release/empsit.nr0.htm",
});

function digest(value, length = 24) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, length);
}

function contentDigest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function initialState(now) {
  return {
    version: 2,
    saved_at: now.toISOString(),
    calendar_updated_at: null,
    event_windows: fallbackEventWindows(),
    signals: [],
    source_performance: [],
    reminder_deliveries: [],
    official_baselines: {},
    calendar_health: {
      state: "degraded",
      coverage_state: "partial",
      checked_at: now.toISOString(),
      message: "Using a verified official-calendar fallback until the live BLS calendar is refreshed",
    },
  };
}

function normalizedState(candidate, now) {
  const fallback = initialState(now);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return fallback;
  return {
    ...fallback,
    ...candidate,
    version: 2,
    event_windows: mergeEventWindows(
      fallback.event_windows,
      Array.isArray(candidate.event_windows) ? candidate.event_windows : [],
    ),
    signals: Array.isArray(candidate.signals) ? candidate.signals.slice(-MAX_SIGNALS) : [],
    source_performance: Array.isArray(candidate.source_performance)
      ? candidate.source_performance.slice(-SOURCE_PERFORMANCE_RETENTION)
      : [],
    reminder_deliveries: Array.isArray(candidate.reminder_deliveries)
      ? candidate.reminder_deliveries
      : [],
    official_baselines: candidate.official_baselines && typeof candidate.official_baselines === "object"
      ? candidate.official_baselines
      : {},
  };
}

function memoryStateStore(seed = null) {
  let value = seed == null ? null : JSON.stringify(seed);
  return Object.freeze({
    async read() { return value; },
    async write(_name, next) { value = next; },
    snapshot() { return value == null ? null : JSON.parse(value); },
  });
}

function safeJsonParse(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sourceIdentity(observation) {
  const payload = observation?.payload ?? {};
  const forwarded = payload.forward_origin_key;
  if (typeof forwarded === "string" && forwarded && forwarded !== "hidden_user") {
    return { key: forwarded, independent: true };
  }
  if (forwarded === "hidden_user" || payload.forward_origin_hidden === true) {
    return { key: `hidden:${digest(observation.external_event_id)}`, independent: false };
  }
  return { key: `explicit:${digest(observation.external_event_id)}`, independent: false };
}

function sourceLabel(observation) {
  const payload = observation?.payload ?? {};
  return payload.forward_origin_title
    || (payload.forward_origin_username ? `@${payload.forward_origin_username}` : null)
    || (payload.forwarded ? "轉傳來源未公開" : "使用者明確投稿");
}

function releaseSignature(claim) {
  return [
    claim.metric_id,
    claim.period ?? "unknown",
    claim.actual,
    claim.forecast ?? "missing",
    claim.previous ?? "missing",
    claim.unit,
  ].join("|");
}

function sourceCount(claims) {
  return new Set(claims.filter((claim) => claim.independent).map((claim) => claim.source_key)).size;
}

function factState(claims) {
  const signatures = new Set(claims.map((claim) => releaseSignature(claim.parsed_claim)));
  if (signatures.size > 1) return "conflicted";
  if (claims.some((claim) => claim.official === true)) return "official_confirmed";
  if (sourceCount(claims) >= 2) return "source_matched";
  return "unverified";
}

function matchingWindow(windows, parsed, observedAt) {
  const time = Date.parse(observedAt);
  return windows
    .filter((window) => window.release_type === parsed.release_type)
    .map((window) => ({ window, distance: Math.abs(Date.parse(window.scheduled_at) - time) }))
    .filter(({ window, distance }) => {
      const inside = time >= Date.parse(window.opens_at) && time <= Date.parse(window.closes_at);
      return inside || distance <= 30 * 60 * 1_000;
    })
    .sort((left, right) => left.distance - right.distance)[0]?.window ?? null;
}

function signalIdFor(window, parsed, observedAt) {
  const eventKey = window?.id ?? `${parsed.release_type}-${observedAt.slice(0, 10)}`;
  return `flash-${digest(`${eventKey}:${parsed.metric_id}:${parsed.period ?? "unknown"}`)}`;
}

function choosePrimaryClaim(claims) {
  return [...claims].sort((left, right) => {
    if (left.official !== right.official) return left.official ? -1 : 1;
    if (left.independent !== right.independent) return left.independent ? -1 : 1;
    return Date.parse(right.received_at) - Date.parse(left.received_at);
  })[0];
}

function signalStatus(signal, now) {
  if (signal.disposition === "dismissed") return "dismissed";
  if (Date.parse(signal.expires_at) < now.getTime()) return "expired";
  if (signal.fact_state === "official_confirmed") return "official_confirmed";
  if (signal.fact_state === "source_matched") return "source_matched";
  if (signal.fact_state === "conflicted") return "conflicted";
  return "flash";
}

function formatWindow(window, now) {
  const scheduled = Date.parse(window.scheduled_at);
  return {
    ...window,
    state: windowState(window, now),
    seconds_to_release: Math.round((scheduled - now.getTime()) / 1_000),
  };
}

function pathMap(situations) {
  return situations.flatMap((entity) => {
    const paths = Array.isArray(entity.payload?.scenario_paths) ? entity.payload.scenario_paths : [];
    if (paths.length < 2) return [];
    const total = paths.reduce((sum, path) => sum + Number(path.probability ?? 0), 0);
    if (Math.abs(total - 100) > 0.001) return [];
    const ledger = Array.isArray(entity.payload?.forecast_ledger) ? entity.payload.forecast_ledger : [];
    return [{
      situation_id: entity.entity_id,
      situation_title: entity.payload.title,
      intelligence_question: entity.payload.intelligence_question
        ?? `什麼變化會讓「${entity.payload.title}」的主路徑失效？`,
      horizon: entity.payload.forecast_horizon ?? entity.payload.next_review_at,
      paths: paths.map((path) => ({
        id: path.id,
        label: path.label,
        probability: path.probability,
        summary: path.summary,
        trigger: path.trigger,
        invalidation: path.invalidation,
        tone: path.tone,
      })),
      calibration_state: ledger.length >= 20 ? "calibrating" : "heuristic",
      comparable_event_count: ledger.length,
      next_observable: entity.payload.next_observable ?? entity.payload.watch_conditions?.[0] ?? null,
    }];
  });
}

function decisionGates({ signals, situations, missions, now }) {
  const gates = [];
  for (const signal of signals) {
    if (!["source_matched", "official_confirmed", "conflicted"].includes(signal.fact_state)) continue;
    gates.push({
      id: `signal:${signal.id}`,
      kind: "signal",
      title: signal.fact_state === "conflicted" ? `來源衝突：${signal.title}` : `檢視路徑壓力：${signal.title}`,
      state: signal.fact_state,
      reason: signal.fact_state === "official_confirmed"
        ? "官方資料已確認；可審查 Situation 機率更新。"
        : signal.fact_state === "source_matched"
          ? "兩個獨立來源吻合，但仍等待官方確認。"
          : "來源數值不一致，不應更新正式機率。",
      due_at: signal.last_seen_at,
      signal_id: signal.id,
    });
  }
  for (const situation of situations) {
    if (situation.payload?.requires_decision !== true) continue;
    gates.push({
      id: `situation:${situation.entity_id}`,
      kind: "situation",
      title: situation.payload.title,
      state: "needs_user",
      reason: situation.payload.adjustment_draft?.impact ?? "Situation 有待確認的調整草稿。",
      due_at: situation.payload.next_review_at,
      situation_id: situation.entity_id,
    });
  }
  for (const mission of missions) {
    const reviewAt = Date.parse(mission.payload?.review_date ?? "");
    if (!Number.isFinite(reviewAt) || reviewAt - now.getTime() > 24 * 60 * 60 * 1_000) continue;
    if (["completed", "cancelled"].includes(mission.payload?.status)) continue;
    gates.push({
      id: `mission:${mission.entity_id}`,
      kind: "mission",
      title: mission.payload.title,
      state: mission.payload.status,
      reason: mission.payload.next_action,
      due_at: mission.payload.review_date,
      mission_id: mission.entity_id,
    });
  }
  return gates.sort((left, right) => Date.parse(left.due_at ?? "") - Date.parse(right.due_at ?? "")).slice(0, 5);
}

function releaseDateMatches(htmlText, scheduledAt) {
  const date = new Date(scheduledAt);
  const long = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "2-digit",
  }).format(date).replace(/\b0(\d)\b/, "$1");
  const numeric = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return htmlText.includes(long) || htmlText.includes(numeric);
}

function htmlToText(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function calculateMulticlassBrier(paths, outcomePathId) {
  if (!Array.isArray(paths) || paths.length < 2) throw new TypeError("paths are required");
  if (!paths.some((path) => path.id === outcomePathId)) throw new TypeError("outcome path is invalid");
  const total = paths.reduce((sum, path) => sum + Number(path.probability ?? 0), 0);
  if (Math.abs(total - 100) > 0.001) throw new TypeError("path probabilities must total 100");
  const score = paths.reduce((sum, path) => {
    const probability = Number(path.probability) / 100;
    const outcome = path.id === outcomePathId ? 1 : 0;
    return sum + ((probability - outcome) ** 2);
  }, 0);
  return Math.round((score / paths.length) * 10_000) / 10_000;
}

export function createMemoryForwardStateStore(seed) {
  return memoryStateStore(seed);
}

export function createForwardIntelligenceEngine({
  stateStore,
  stateName = STATE_NAME,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
} = {}) {
  if (!stateStore?.read || !stateStore?.write) throw new TypeError("stateStore is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  let state = initialState(clock());
  let initialized = false;
  const listeners = new Set();
  const officialAttemptAt = new Map();

  async function persist() {
    state.saved_at = clock().toISOString();
    await stateStore.write(stateName, JSON.stringify(state));
  }

  function emit(type, payload = {}) {
    const event = { type, at: clock().toISOString(), ...payload };
    for (const listener of listeners) {
      try { listener(clone(event)); } catch {}
    }
  }

  function purge() {
    const now = clock();
    const cutoff = now.getTime() - FLASH_RETENTION_MS;
    state.signals = state.signals
      .filter((signal) => Date.parse(signal.last_seen_at) >= cutoff || signal.disposition === "watch")
      .slice(-MAX_SIGNALS);
    state.reminder_deliveries = state.reminder_deliveries.filter(
      (delivery) => Date.parse(delivery.sent_at) >= now.getTime() - 30 * 24 * 60 * 60 * 1_000,
    );
  }

  async function initialize() {
    if (initialized) return;
    const stored = safeJsonParse(await stateStore.read(stateName));
    state = normalizedState(stored, clock());
    purge();
    initialized = true;
  }

  async function refreshCalendars() {
    await initialize();
    const checkedAt = clock().toISOString();
    try {
      const response = await fetchImpl(BLS_CALENDAR_URL, {
        headers: { accept: "text/calendar, text/plain;q=0.9" },
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`BLS calendar returned HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) throw new Error("BLS calendar is too large");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) throw new Error("BLS calendar is too large");
      const windows = parseBlsCalendarIcs(text);
      if (!windows.length) throw new Error("BLS calendar contained no supported event windows");
      state.event_windows = mergeEventWindows(fallbackEventWindows(), state.event_windows, windows);
      state.calendar_updated_at = checkedAt;
      state.calendar_health = {
        state: "healthy",
        coverage_state: "complete",
        checked_at: checkedAt,
        last_success_at: checkedAt,
        message: `Loaded ${windows.length} supported windows from the official BLS calendar`,
      };
      await persist();
      emit("calendar.updated", { count: windows.length });
      return { ok: true, count: windows.length };
    } catch (error) {
      state.calendar_health = {
        ...state.calendar_health,
        state: "degraded",
        coverage_state: "partial",
        checked_at: checkedAt,
        message: error instanceof Error ? error.message : "BLS calendar refresh failed",
      };
      await persist();
      return { ok: false, error: state.calendar_health.message };
    }
  }

  async function ingestObservation(observation, { official = false } = {}) {
    await initialize();
    if (!observation || typeof observation !== "object") return null;
    const parsed = parseEconomicRelease(observation.summary, { receivedAt: observation.observed_at });
    if (!parsed || parsed.extraction_confidence < 0.7) return null;
    purge();
    const observedAt = observation.observed_at ?? clock().toISOString();
    const window = matchingWindow(state.event_windows, parsed, observedAt);
    const id = signalIdFor(window, parsed, observedAt);
    const source = official
      ? { key: `official:${observation.source_url}`, independent: true }
      : sourceIdentity(observation);
    const label = official ? "官方發布" : sourceLabel(observation);
    const claim = {
      source_key: source.key,
      source_label: label,
      independent: source.independent,
      official,
      received_at: observedAt,
      source_published_at: observation.published_at ?? null,
      source_url: observation.source_url ?? null,
      observation_hash: observation.content_hash ?? contentDigest(observation.summary),
      parsed_claim: parsed,
    };
    let signal = state.signals.find((item) => item.id === id);
    const previousState = signal?.fact_state ?? null;
    const previousSignature = signal?.parsed_claim ? releaseSignature(signal.parsed_claim) : null;
    let corrected = false;
    if (!signal) {
      signal = {
        id,
        event_window_id: window?.id ?? null,
        release_type: parsed.release_type,
        title: parsed.metric_label,
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        expires_at: new Date(Date.parse(observedAt) + FLASH_RETENTION_MS).toISOString(),
        fact_state: "unverified",
        impact_state: "not_observed",
        source_label: label,
        source_url: observation.source_url ?? null,
        source_count: 0,
        independent_source_count: 0,
        mention_count: 0,
        parsed_claim: parsed,
        claims: [],
        deliveries: [],
        disposition: null,
        accepted_by_user: false,
        market_reaction: null,
      };
      state.signals.push(signal);
    }
    const existingIndex = signal.claims.findIndex((item) => item.source_key === claim.source_key);
    if (existingIndex >= 0) {
      corrected = releaseSignature(signal.claims[existingIndex].parsed_claim) !== releaseSignature(claim.parsed_claim);
      signal.claims[existingIndex] = claim;
    } else {
      signal.claims.push(claim);
    }
    const primary = choosePrimaryClaim(signal.claims);
    signal.parsed_claim = primary.parsed_claim;
    signal.source_label = primary.source_label;
    signal.source_url = primary.source_url;
    signal.last_seen_at = observedAt;
    signal.mention_count += 1;
    signal.source_count = new Set(signal.claims.map((item) => item.source_key)).size;
    signal.independent_source_count = sourceCount(signal.claims);
    signal.fact_state = factState(signal.claims);
    signal.status = signalStatus(signal, clock());
    signal.directional_pressure = {
      direction: signal.parsed_claim.pressure_direction,
      label: signal.parsed_claim.pressure_label,
      magnitude: signal.parsed_claim.pressure_magnitude,
      canonical_probability_changed: false,
    };
    const performanceKey = source.key;
    let performance = state.source_performance.find((item) => item.source_key === performanceKey);
    if (!performance) {
      performance = {
        source_key: performanceKey,
        source_label: label,
        independent: source.independent,
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        mention_count: 0,
        correction_count: 0,
        official_match_count: 0,
        official_conflict_count: 0,
        average_latency_ms: null,
      };
      state.source_performance.push(performance);
    }
    performance.last_seen_at = observedAt;
    performance.mention_count += 1;
    if (corrected) performance.correction_count += 1;
    if (window) {
      const latency = Date.parse(observedAt) - Date.parse(window.scheduled_at);
      if (Number.isFinite(latency)) {
        performance.average_latency_ms = performance.average_latency_ms == null
          ? latency
          : Math.round(((performance.average_latency_ms * (performance.mention_count - 1)) + latency) / performance.mention_count);
      }
    }
    state.source_performance = state.source_performance.slice(-SOURCE_PERFORMANCE_RETENTION);
    await persist();
    const changed = previousState !== signal.fact_state || previousSignature !== releaseSignature(signal.parsed_claim);
    if (changed) emit("signal.changed", { signal_id: signal.id, fact_state: signal.fact_state });
    return {
      signal: clone(signal),
      should_notify: changed,
      notification_text: formatFlashAlert(signal),
      edit_existing: signal.deliveries.length > 0,
    };
  }

  async function markDelivery({ signalId, chatId, messageId, kind = "flash" }) {
    await initialize();
    const signal = state.signals.find((item) => item.id === signalId);
    if (!signal) return null;
    const existing = signal.deliveries.find((item) => String(item.chat_id) === String(chatId));
    if (existing) {
      existing.message_id = String(messageId ?? existing.message_id);
      existing.updated_at = clock().toISOString();
      existing.kind = kind;
    } else {
      signal.deliveries.push({
        chat_id: String(chatId),
        message_id: String(messageId),
        kind,
        sent_at: clock().toISOString(),
        updated_at: clock().toISOString(),
      });
    }
    await persist();
    return clone(signal.deliveries);
  }

  async function recordMarketReaction(signalId, reaction) {
    await initialize();
    const signal = state.signals.find((item) => item.id === signalId);
    if (!signal) return null;
    const moves = Array.isArray(reaction?.moves) ? reaction.moves : [];
    const directions = new Set(moves.map((move) => Math.sign(Number(move.change_bps ?? move.change_percent ?? 0))).filter(Boolean));
    signal.market_reaction = {
      as_of: reaction.as_of ?? clock().toISOString(),
      provider: reaction.provider ?? "unknown",
      coverage: reaction.coverage ?? "partial",
      moves,
    };
    signal.impact_state = directions.size > 1 ? "mixed" : moves.length ? "market_reacting" : "not_observed";
    signal.status = signalStatus(signal, clock());
    await persist();
    emit("signal.market_reaction", { signal_id: signal.id, impact_state: signal.impact_state });
    return { signal: clone(signal), notification_text: formatFlashAlert(signal) };
  }

  async function applyOfficialRelease(signalId, parsed, { sourceUrl, observedAt } = {}) {
    await initialize();
    const signal = state.signals.find((item) => item.id === signalId);
    if (!signal) return null;
    const observation = {
      external_event_id: `official:${signal.event_window_id ?? signal.id}`,
      summary: `${parsed.metric_label} actual ${parsed.actual}% forecast ${parsed.forecast ?? ""}% previous ${parsed.previous ?? ""}%`,
      observed_at: observedAt ?? clock().toISOString(),
      published_at: observedAt ?? clock().toISOString(),
      source_url: sourceUrl,
      content_hash: contentDigest(JSON.stringify(parsed)),
    };
    const claim = {
      source_key: `official:${sourceUrl}`,
      source_label: "官方發布",
      independent: true,
      official: true,
      received_at: observation.observed_at,
      source_published_at: observation.published_at,
      source_url: sourceUrl,
      observation_hash: observation.content_hash,
      parsed_claim: parsed,
    };
    const existing = signal.claims.findIndex((item) => item.source_key === claim.source_key);
    if (existing >= 0) signal.claims[existing] = claim;
    else signal.claims.push(claim);
    const officialSignature = releaseSignature(parsed);
    for (const sourceClaim of signal.claims.filter((item) => !item.official)) {
      const performance = state.source_performance.find((item) => item.source_key === sourceClaim.source_key);
      if (!performance) continue;
      if (releaseSignature(sourceClaim.parsed_claim) === officialSignature) performance.official_match_count += 1;
      else performance.official_conflict_count += 1;
    }
    signal.fact_state = factState(signal.claims);
    signal.parsed_claim = parsed;
    signal.last_seen_at = observation.observed_at;
    signal.status = signalStatus(signal, clock());
    await persist();
    emit("signal.official_verification", { signal_id: signal.id, fact_state: signal.fact_state });
    return { signal: clone(signal), notification_text: formatFlashAlert(signal) };
  }

  async function verifyOpenSignals() {
    await initialize();
    const now = clock();
    const candidates = state.signals.filter((signal) => {
      if (!["unverified", "source_matched"].includes(signal.fact_state)) return false;
      const window = state.event_windows.find((item) => item.id === signal.event_window_id);
      if (!window || !OFFICIAL_RELEASE_URLS[window.release_type]) return false;
      return now.getTime() >= Date.parse(window.scheduled_at)
        && now.getTime() <= Date.parse(window.closes_at) + 10 * 60 * 1_000;
    });
    const updates = [];
    for (const signal of candidates) {
      const attempted = officialAttemptAt.get(signal.id) ?? 0;
      if (now.getTime() - attempted < 15_000) continue;
      officialAttemptAt.set(signal.id, now.getTime());
      const window = state.event_windows.find((item) => item.id === signal.event_window_id);
      const sourceUrl = OFFICIAL_RELEASE_URLS[window.release_type];
      try {
        const response = await fetchImpl(sourceUrl, {
          headers: { accept: "text/html" },
          redirect: "error",
          signal: AbortSignal.timeout(6_000),
        });
        if (!response.ok) continue;
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) continue;
        const html = await response.text();
        if (Buffer.byteLength(html, "utf8") > 2 * 1024 * 1024) continue;
        const hash = contentDigest(html);
        const baseline = state.official_baselines[window.id];
        if (!baseline) {
          state.official_baselines[window.id] = hash;
          await persist();
          continue;
        }
        const text = htmlToText(html);
        if (hash === baseline || !releaseDateMatches(text, window.scheduled_at)) continue;
        const parsed = parseEconomicRelease(text, { receivedAt: now.toISOString() });
        if (!parsed || parsed.release_type !== signal.release_type || parsed.metric_id !== signal.parsed_claim.metric_id) continue;
        const updated = await applyOfficialRelease(signal.id, parsed, { sourceUrl, observedAt: now.toISOString() });
        if (updated) updates.push(updated);
      } catch {
        // Best-effort official confirmation never blocks Telegram Fast Lane.
      }
    }
    return updates;
  }

  async function dueReminders() {
    await initialize();
    const now = clock();
    return state.event_windows
      .map((window) => formatWindow(window, now))
      .filter((window) => ["armed", "live"].includes(window.state));
  }

  async function reminderNeeded(windowId, chatId) {
    await initialize();
    return !state.reminder_deliveries.some(
      (delivery) => delivery.window_id === windowId && String(delivery.chat_id) === String(chatId),
    );
  }

  async function markReminder(windowId, chatId, messageId) {
    await initialize();
    state.reminder_deliveries.push({
      window_id: windowId,
      chat_id: String(chatId),
      message_id: String(messageId),
      sent_at: clock().toISOString(),
    });
    await persist();
  }

  function reminderText(window) {
    const local = new Date(window.scheduled_at).toLocaleTimeString("zh-TW", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return [
      `EVENT WINDOW ARMED｜${window.title}`,
      `${local} ET 發布，Fast Lane 已進入五分鐘預備狀態。`,
      `待提取：${window.expected_fields.join(" / ")}`,
      window.consensus_state === "missing_legal_source"
        ? "Consensus：尚無可合法自動取得的發布前快照。"
        : `Consensus：${window.consensus_snapshot}`,
      "看到群組快訊後，請直接轉傳到這個 Bot；第一則只作未驗證 Flash。",
    ].join("\n");
  }

  async function listEventWindows() {
    await initialize();
    const now = clock();
    return state.event_windows.map((window) => formatWindow(window, now));
  }

  async function listSignals({ includeExpired = false } = {}) {
    await initialize();
    purge();
    const now = clock();
    return state.signals
      .map((signal) => ({ ...signal, status: signalStatus(signal, now) }))
      .filter((signal) => includeExpired || !["expired", "dismissed"].includes(signal.status))
      .sort((left, right) => Date.parse(right.last_seen_at) - Date.parse(left.last_seen_at))
      .map(clone);
  }

  async function getSignal(signalId) {
    const signals = await listSignals({ includeExpired: true });
    return signals.find((signal) => signal.id === signalId) ?? null;
  }

  async function disposition(signalId, { action, situationId = null } = {}) {
    await initialize();
    if (!new Set(["watch", "dismiss", "accept", "link_situation"]).has(action)) {
      throw new TypeError("Unsupported Fast Lane disposition");
    }
    const signal = state.signals.find((item) => item.id === signalId);
    if (!signal) throw new TypeError("Fast Lane signal is unavailable");
    if (action === "accept" && signal.fact_state === "conflicted") {
      throw new TypeError("A conflicted signal cannot be accepted");
    }
    signal.disposition = action === "dismiss" ? "dismissed" : action;
    signal.accepted_by_user = action === "accept" || action === "link_situation";
    signal.linked_situation_id = action === "link_situation" ? String(situationId ?? "") : signal.linked_situation_id;
    signal.disposition_at = clock().toISOString();
    await persist();
    emit("signal.disposition", { signal_id: signal.id, action });
    return clone(signal);
  }

  async function getSourcePerformance() {
    await initialize();
    return state.source_performance
      .map((source) => ({
        ...source,
        correction_rate: source.mention_count ? source.correction_count / source.mention_count : null,
        official_hit_rate: (source.official_match_count + source.official_conflict_count)
          ? source.official_match_count / (source.official_match_count + source.official_conflict_count)
          : null,
      }))
      .sort((left, right) => (right.official_match_count - right.official_conflict_count) - (left.official_match_count - left.official_conflict_count))
      .map(clone);
  }

  async function getNowProjection({ situations = [], missions = [], connectorHealth = [] } = {}) {
    await initialize();
    const now = clock();
    const windows = state.event_windows.map((window) => formatWindow(window, now));
    const in24Hours = windows.filter((window) => {
      const distance = Date.parse(window.scheduled_at) - now.getTime();
      return distance >= -15 * 60 * 1_000 && distance <= 24 * 60 * 60 * 1_000;
    });
    const nextEvent = windows.find((window) => Date.parse(window.scheduled_at) >= now.getTime()) ?? null;
    const signals = await listSignals();
    const activeSignals = signals.filter((signal) => !["dismissed", "expired"].includes(signal.status));
    const paths = pathMap(situations);
    const gates = decisionGates({ signals: activeSignals, situations, missions, now });
    const marketHealth = connectorHealth.find((item) =>
      String(item.feed_id ?? item.connector_id) === "market.alpaca-iex");
    return {
      mode: "forward_intelligence_v2",
      as_of: now.toISOString(),
      event_radar: in24Hours.slice(0, 6),
      next_event: nextEvent,
      live_pulse: activeSignals.slice(0, 3),
      path_map: paths.slice(0, 4),
      decision_gates: gates,
      coverage_health: [
        {
          feed_id: "forward.event-calendar",
          label: "Event calendar",
          ...state.calendar_health,
        },
        {
          feed_id: "forward.telegram-fast-lane",
          label: "Telegram Fast Lane",
          state: connectorHealth.some((item) => String(item.feed_id ?? item.connector_id).includes("telegram") && ["healthy", "live"].includes(item.state ?? item.health_state))
            ? "healthy"
            : "degraded",
          coverage_state: "explicit_submit_only",
          checked_at: now.toISOString(),
          message: "Only direct user forwards are processed; third-party groups are not crawled",
        },
        {
          feed_id: "forward.market-reaction",
          label: "Market reaction",
          state: marketHealth?.state ?? marketHealth?.health_state ?? "disabled",
          coverage_state: marketHealth?.coverage_state ?? "unavailable",
          checked_at: marketHealth?.checked_at ?? now.toISOString(),
          message: marketHealth?.message ?? "Alpaca IEX adapter is credential-gated; Flash delivery does not wait for it",
        },
      ],
      latency_budget: {
        starts_at: "telegram_bot_receipt",
        deterministic_flash_p95_target_ms: 3_000,
        official_confirmation_sla: null,
      },
    };
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener is required");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getHealth() {
    return {
      feed_id: "forward-intelligence.v2",
      state: initialized ? "healthy" : "degraded",
      checked_at: clock().toISOString(),
      coverage_state: "explicit_submit_only",
      message: initialized
        ? "Event windows, deterministic Telegram Flash, and forecast projection are ready"
        : "Forward intelligence engine has not initialized",
      signal_count: state.signals.length,
      event_window_count: state.event_windows.length,
    };
  }

  return Object.freeze({
    initialize,
    refreshCalendars,
    ingestObservation,
    markDelivery,
    recordMarketReaction,
    applyOfficialRelease,
    verifyOpenSignals,
    dueReminders,
    reminderNeeded,
    markReminder,
    reminderText,
    listEventWindows,
    listSignals,
    getSignal,
    disposition,
    getSourcePerformance,
    getNowProjection,
    subscribe,
    getHealth,
  });
}
