import { createHash } from "node:crypto";
import { createObservation } from "../connectors/contracts.mjs";

export const SEC_WATCHLIST = Object.freeze([
  Object.freeze({ cik: "0001652044", symbols: ["GOOG", "GOOGL"], company: "Alphabet Inc." }),
  Object.freeze({ cik: "0001318605", symbols: ["TSLA"], company: "Tesla, Inc." }),
  Object.freeze({ cik: "0001046179", symbols: ["TSM"], company: "Taiwan Semiconductor Manufacturing Company Limited" }),
  Object.freeze({ cik: "0000937966", symbols: ["ASML"], company: "ASML Holding N.V." }),
]);

export const SEC_FORM_ALLOWLIST = Object.freeze([
  "10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "8-K/A",
  "20-F", "20-F/A", "6-K", "6-K/A", "4", "4/A", "13F-HR", "13F-HR/A",
]);

export const FRED_SERIES = Object.freeze([
  Object.freeze({ id: "DFF", label: "Fed funds effective rate", unit: "%", frequency: "daily" }),
  Object.freeze({ id: "DGS2", label: "U.S. 2-year Treasury", unit: "%", frequency: "daily" }),
  Object.freeze({ id: "DGS10", label: "U.S. 10-year Treasury", unit: "%", frequency: "daily" }),
  Object.freeze({ id: "T10YIE", label: "10-year breakeven inflation", unit: "%", frequency: "daily" }),
  Object.freeze({ id: "DTWEXBGS", label: "Trade-weighted U.S. dollar", unit: "index", frequency: "daily" }),
  Object.freeze({ id: "NFCI", label: "Chicago Fed financial conditions", unit: "index", frequency: "weekly" }),
]);

const DEFAULT_STATE = Object.freeze({
  version: 1,
  sec_seen: {},
  sec_facts: [],
  fred_background: [],
  market_reactions: [],
  reaction_jobs: [],
  last_refresh_at: null,
});

function clone(value) {
  return structuredClone(value);
}

function cleanSecret(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteDate(value, fallback) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback;
}

function secAcceptanceDate(value, fallback) {
  if (typeof value !== "string") return fallback;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`
    : finiteDate(value, fallback);
}

function stateHealth(feedId, state, now, message, extra = {}) {
  return {
    feed_id: feedId,
    state,
    checked_at: now,
    coverage_state: state === "healthy" ? "complete" : state === "disabled" ? "unavailable" : "partial",
    message,
    ...extra,
  };
}

function safeState(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    ...clone(DEFAULT_STATE),
    ...value,
    sec_seen: value.sec_seen && typeof value.sec_seen === "object" && !Array.isArray(value.sec_seen)
      ? value.sec_seen
      : {},
    sec_facts: Array.isArray(value.sec_facts) ? value.sec_facts : [],
    fred_background: Array.isArray(value.fred_background) ? value.fred_background : [],
    market_reactions: Array.isArray(value.market_reactions) ? value.market_reactions : [],
    reaction_jobs: Array.isArray(value.reaction_jobs) ? value.reaction_jobs : [],
  };
}

function columnAt(recent, key, index) {
  return Array.isArray(recent?.[key]) ? recent[key][index] : undefined;
}

export function parseSecSubmissions(payload, company, { clock = () => new Date() } = {}) {
  const recent = payload?.filings?.recent;
  if (!recent || !Array.isArray(recent.accessionNumber)) return [];
  const now = clock().toISOString();
  const allowed = new Set(SEC_FORM_ALLOWLIST);
  return recent.accessionNumber.flatMap((accessionNumber, index) => {
    const accession = String(accessionNumber || "").trim();
    const form = String(columnAt(recent, "form", index) || "").trim().toUpperCase();
    const primaryDocument = String(columnAt(recent, "primaryDocument", index) || "").trim();
    if (!accession || !allowed.has(form) || !primaryDocument) return [];
    const filingDate = String(columnAt(recent, "filingDate", index) || "");
    const reportDate = String(columnAt(recent, "reportDate", index) || "");
    const acceptedAt = secAcceptanceDate(columnAt(recent, "acceptanceDateTime", index), finiteDate(filingDate, now));
    const cik = String(company.cik).padStart(10, "0");
    const archiveCik = String(Number(cik));
    const accessionPath = accession.replaceAll("-", "");
    const sourceUrl = `https://www.sec.gov/Archives/edgar/data/${archiveCik}/${accessionPath}/${encodeURIComponent(primaryDocument)}`;
    const summary = `${company.company} filed ${form}${reportDate ? ` for reporting period ${reportDate}` : ""}.`;
    return [createObservation({
      external_event_id: `sec:${cik}:${accession}`,
      feed_id: "sec.submissions",
      published_at: acceptedAt,
      observed_at: now,
      as_of: acceptedAt,
      source_url: sourceUrl,
      evidence_status: "unverified_external",
      matched_interest_ids: company.symbols,
      materiality: ["8-K", "6-K", "10-K", "20-F"].includes(form) ? "high" : "medium",
      coverage_state: "complete",
      license_ref: "sec_public_data_api",
      title: `${company.company} · ${form}`,
      summary,
      payload: {
        cik,
        company: company.company,
        symbols: company.symbols,
        accession_number: accession,
        form,
        filing_date: filingDate || null,
        report_date: reportDate || null,
        accepted_at: acceptedAt,
        primary_document: primaryDocument,
        sec_archive_url: sourceUrl,
        baseline_only: false,
      },
      untrusted_external_content: true,
    })];
  });
}

export function parseFredObservations(payload, series, { clock = () => new Date() } = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.observations)) {
    throw new TypeError(`FRED ${series.id} returned an invalid observations envelope`);
  }
  const now = clock().toISOString();
  return payload.observations.slice(0, 2).map((item) => {
    const numeric = item?.value === "." ? null : Number(item?.value);
    const value = Number.isFinite(numeric) ? numeric : null;
    return {
      series_id: series.id,
      label: series.label,
      unit: series.unit,
      frequency: series.frequency,
      observation_date: String(item?.date || ""),
      realtime_start: String(item?.realtime_start || ""),
      realtime_end: String(item?.realtime_end || ""),
      value,
      missing: value == null,
      observed_at: now,
    };
  });
}

function newestFirst(left, right) {
  return Date.parse(right.published_at || right.observed_at || 0) - Date.parse(left.published_at || left.observed_at || 0);
}

export function createEvidenceLoopEngine({
  secretStore,
  loadState = async () => clone(DEFAULT_STATE),
  saveState = async () => {},
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  watchlist = SEC_WATCHLIST,
  fredSeries = FRED_SERIES,
  marketAdapter,
  onFact = async () => {},
} = {}) {
  if (!secretStore?.read || !secretStore?.write) throw new TypeError("secretStore is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  let state = safeState();
  let secContact = null;
  let fredApiKey = null;
  let secHealth = stateHealth("sec.submissions", "disabled", clock().toISOString(), "SEC contact email has not been configured");
  let fredHealth = stateHealth("macro.fred", "disabled", clock().toISOString(), "FRED API key has not been configured");

  async function persist() {
    state.last_refresh_at = clock().toISOString();
    await saveState(clone(state));
  }

  async function initialize() {
    state = safeState(await loadState());
    [secContact, fredApiKey] = await Promise.all([
      secretStore.read("sec-contact-email"),
      secretStore.read("fred-api-key"),
    ]);
    const now = clock().toISOString();
    secHealth = secContact
      ? stateHealth("sec.submissions", "degraded", now, "Contact is stored; waiting for SEC refresh", { baseline_ready: Object.keys(state.sec_seen).length > 0 })
      : stateHealth("sec.submissions", "disabled", now, "SEC contact email has not been configured");
    fredHealth = fredApiKey
      ? stateHealth("macro.fred", "degraded", now, "API key is stored; waiting for FRED refresh")
      : stateHealth("macro.fred", "disabled", now, "FRED API key has not been configured");
    return getProjection();
  }

  async function setupSec({ contactEmail } = {}) {
    const email = cleanSecret(contactEmail);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TypeError("A valid SEC contact email is required");
    await secretStore.write("sec-contact-email", email);
    secContact = email;
    secHealth = stateHealth("sec.submissions", "degraded", clock().toISOString(), "Contact is stored; run refresh to establish the SEC baseline");
    return { configured: true, health: clone(secHealth) };
  }

  async function setupFred({ apiKey } = {}) {
    const key = cleanSecret(apiKey);
    if (!key) throw new TypeError("A FRED API key is required");
    await secretStore.write("fred-api-key", key);
    fredApiKey = key;
    fredHealth = stateHealth("macro.fred", "degraded", clock().toISOString(), "API key is stored; run refresh to load macro background");
    return { configured: true, health: clone(fredHealth) };
  }

  async function refreshSec() {
    const checkedAt = clock().toISOString();
    if (!secContact) {
      secHealth = stateHealth("sec.submissions", "disabled", checkedAt, "SEC refresh is fail-closed until a contact email is configured");
      return { ok: false, baseline_established: false, novel_count: 0, health: clone(secHealth) };
    }
    let successfulCompanies = 0;
    let baselineCount = 0;
    const novelFacts = [];
    const errors = [];
    for (const company of watchlist) {
      try {
        const response = await fetchImpl(`https://data.sec.gov/submissions/CIK${company.cik}.json`, {
          method: "GET",
          headers: {
            accept: "application/json",
            "user-agent": `IntelOS local research ${secContact}`,
          },
        });
        if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "unknown"}`);
        const facts = parseSecSubmissions(await response.json(), company, { clock });
        const prior = Array.isArray(state.sec_seen[company.cik]) ? state.sec_seen[company.cik] : null;
        const seen = new Set(prior || []);
        if (prior == null) {
          baselineCount += facts.length;
          for (const fact of facts.slice(0, 10)) {
            state.sec_facts.push({ ...fact, payload: { ...fact.payload, baseline_only: true } });
          }
        } else {
          novelFacts.push(...facts.filter((fact) => !seen.has(fact.payload.accession_number)));
        }
        state.sec_seen[company.cik] = [...new Set([...(prior || []), ...facts.map((fact) => fact.payload.accession_number)])].slice(-5_000);
        successfulCompanies += 1;
      } catch (error) {
        errors.push(`${company.company}: ${error instanceof Error ? error.message : "request failed"}`);
      }
    }
    for (const fact of novelFacts) {
      state.sec_facts.push(fact);
      state.reaction_jobs.push({
        id: createHash("sha256").update(fact.external_event_id).digest("hex").slice(0, 24),
        fact_id: fact.external_event_id,
        symbols: fact.payload.symbols,
        benchmark: "SPY",
        event_at: fact.published_at || fact.observed_at,
        status: "waiting_15m",
        next_attempt_at: new Date(Date.parse(fact.published_at || fact.observed_at) + 15 * 60 * 1_000).toISOString(),
        attempts: 0,
      });
      await onFact(fact);
    }
    state.sec_facts = state.sec_facts.sort(newestFirst).slice(0, 100);
    state.reaction_jobs = state.reaction_jobs.slice(-250);
    await persist();
    const ok = successfulCompanies > 0;
    const partial = successfulCompanies < watchlist.length;
    secHealth = stateHealth("sec.submissions", ok ? (partial ? "degraded" : "healthy") : "error", checkedAt,
      ok
        ? `${successfulCompanies}/${watchlist.length} companies refreshed; ${novelFacts.length} new filing(s); ${baselineCount} baseline filing(s) stayed quiet`
        : "SEC refresh failed for every watchlist company",
      { coverage_state: partial ? "partial" : "complete", successful_company_count: successfulCompanies, watchlist_count: watchlist.length, novel_count: novelFacts.length, baseline_count: baselineCount, errors });
    return { ok, baseline_established: baselineCount > 0, novel_count: novelFacts.length, baseline_count: baselineCount, facts: clone(novelFacts), health: clone(secHealth) };
  }

  async function refreshFred() {
    const checkedAt = clock().toISOString();
    if (!fredApiKey) {
      fredHealth = stateHealth("macro.fred", "disabled", checkedAt, "FRED refresh is fail-closed until an API key is configured");
      return { ok: false, series_count: 0, health: clone(fredHealth) };
    }
    const snapshots = [];
    const errors = [];
    for (const series of fredSeries) {
      try {
        const url = new URL("https://api.stlouisfed.org/fred/series/observations");
        url.searchParams.set("series_id", series.id);
        url.searchParams.set("api_key", fredApiKey);
        url.searchParams.set("file_type", "json");
        url.searchParams.set("sort_order", "desc");
        url.searchParams.set("limit", "2");
        const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" } });
        if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "unknown"}`);
        const observations = parseFredObservations(await response.json(), series, { clock });
        const latest = observations[0];
        const previous = observations.find((item) => item.value != null && item !== latest);
        snapshots.push({
          ...latest,
          previous_value: previous?.value ?? null,
          delta: latest?.value != null && previous?.value != null
            ? Math.round((latest.value - previous.value) * 1_000_000) / 1_000_000
            : null,
          prior_observation_date: previous?.observation_date ?? null,
          source_url: `https://fred.stlouisfed.org/series/${series.id}`,
          coverage_state: latest?.missing ? "partial" : "complete",
        });
      } catch (error) {
        errors.push(`${series.id}: ${error instanceof Error ? error.message : "request failed"}`);
      }
    }
    const bySeries = new Map(state.fred_background.map((item) => [item.series_id, item]));
    for (const snapshot of snapshots) bySeries.set(snapshot.series_id, snapshot);
    state.fred_background = [...bySeries.values()];
    await persist();
    const ok = snapshots.length > 0;
    const partial = snapshots.length < fredSeries.length || snapshots.some((item) => item.missing);
    fredHealth = stateHealth("macro.fred", ok ? (partial ? "degraded" : "healthy") : "error", checkedAt,
      ok ? `${snapshots.length}/${fredSeries.length} macro series refreshed with realtime dates preserved` : "FRED refresh failed for every series",
      { coverage_state: partial ? "partial" : "complete", series_count: snapshots.length, expected_series_count: fredSeries.length, errors });
    return { ok, series_count: snapshots.length, snapshots: clone(snapshots), health: clone(fredHealth) };
  }

  async function runReactionBackfill() {
    if (typeof marketAdapter?.historicalReaction !== "function") return { completed: 0, pending: state.reaction_jobs.length };
    let completed = 0;
    for (const job of state.reaction_jobs) {
      if (job.status === "complete" || Date.parse(job.next_attempt_at) > clock().getTime()) continue;
      job.attempts += 1;
      try {
        const reaction = await marketAdapter.historicalReaction({
          symbols: [...new Set([...job.symbols, job.benchmark])],
          eventAt: job.event_at,
          benchmark: job.benchmark,
        });
        if (!reaction) {
          job.status = "waiting_market_data";
          job.next_attempt_at = new Date(clock().getTime() + 5 * 60 * 1_000).toISOString();
          continue;
        }
        state.market_reactions = [{ ...reaction, fact_id: job.fact_id }, ...state.market_reactions.filter((item) => item.fact_id !== job.fact_id)].slice(0, 100);
        job.status = "complete";
        job.completed_at = clock().toISOString();
        completed += 1;
      } catch (error) {
        job.status = "retry_pending";
        job.last_error = error instanceof Error ? error.message : "Historical reaction failed";
        job.next_attempt_at = new Date(clock().getTime() + Math.min(60, job.attempts * 5) * 60 * 1_000).toISOString();
      }
    }
    await persist();
    return { completed, pending: state.reaction_jobs.filter((job) => job.status !== "complete").length };
  }

  async function refresh({ sec = true, fred = true, reactions = true } = {}) {
    const result = {};
    if (sec) result.sec = await refreshSec();
    if (fred) result.fred = await refreshFred();
    if (reactions) result.reactions = await runReactionBackfill();
    return result;
  }

  function getProjection() {
    const facts = state.sec_facts.slice(0, 30).map((fact) => {
      const reaction = state.market_reactions.find((item) => item.fact_id === fact.external_event_id) || null;
      const job = state.reaction_jobs.find((item) => item.fact_id === fact.external_event_id) || null;
      return { ...fact, reaction, reaction_state: reaction ? "complete" : job?.status || "not_scheduled" };
    });
    return {
      mode: "fact_context_reaction_v1",
      as_of: state.last_refresh_at || clock().toISOString(),
      facts,
      macro_background: clone(state.fred_background),
      market_reactions: clone(state.market_reactions),
      pending_reaction_count: state.reaction_jobs.filter((job) => job.status !== "complete").length,
      watchlist: watchlist.map((item) => clone(item)),
      health: [clone(secHealth), clone(fredHealth), marketAdapter?.getHealth?.()].filter(Boolean),
      incomplete_reasons: [
        !secContact ? "SEC contact email 尚未設定" : null,
        !fredApiKey ? "FRED API key 尚未設定" : null,
        marketAdapter?.getHealth?.()?.state !== "healthy" ? "Alpaca 尚未提供完整市場反應" : null,
      ].filter(Boolean),
    };
  }

  return Object.freeze({
    initialize,
    setupSec,
    setupFred,
    refreshSec,
    refreshFred,
    runReactionBackfill,
    refresh,
    getProjection,
    getHealth: () => [clone(secHealth), clone(fredHealth)],
  });
}
