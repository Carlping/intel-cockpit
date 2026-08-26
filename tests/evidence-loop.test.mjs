import assert from "node:assert/strict";
import test from "node:test";
import {
  FRED_SERIES,
  SEC_WATCHLIST,
  createEvidenceLoopEngine,
  parseFredObservations,
  parseSecSubmissions,
} from "../server/evidence-loop/index.mjs";

const NOW = new Date("2026-08-20T16:00:00.000Z");

function memorySecrets(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    read: async (name) => values.get(name) ?? null,
    write: async (name, value) => values.set(name, value),
  };
}

function secEnvelope(company, { novel = false } = {}) {
  const accessions = novel
    ? ["0001652044-26-000002", "0001652044-26-000001"]
    : [`${company.cik}-26-000001`];
  return {
    filings: {
      recent: {
        accessionNumber: accessions,
        form: novel ? ["8-K", "10-Q"] : [company.symbols.includes("TSM") || company.symbols.includes("ASML") ? "6-K" : "10-Q"],
        primaryDocument: accessions.map((_, index) => `filing-${index + 1}.htm`),
        filingDate: accessions.map(() => "2026-08-20"),
        reportDate: accessions.map(() => "2026-06-30"),
        acceptanceDateTime: accessions.map((_, index) => `202608201${index}0000`),
      },
    },
  };
}

test("SEC submissions parser keeps allowed forms and complete filing lineage", () => {
  const company = SEC_WATCHLIST[0];
  const facts = parseSecSubmissions({
    filings: {
      recent: {
        accessionNumber: ["0001652044-26-000010", "0001652044-26-000011"],
        form: ["8-K", "S-8"],
        primaryDocument: ["goog-20260820.htm", "ignored.htm"],
        filingDate: ["2026-08-20", "2026-08-20"],
        reportDate: ["2026-08-20", "2026-08-20"],
        acceptanceDateTime: ["20260820153045", "20260820153100"],
      },
    },
  }, company, { clock: () => NOW });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].payload.form, "8-K");
  assert.equal(facts[0].published_at, "2026-08-20T15:30:45.000Z");
  assert.equal(facts[0].payload.accession_number, "0001652044-26-000010");
  assert.match(facts[0].source_url, /\/1652044\/000165204426000010\/goog-20260820\.htm$/);
  assert.equal(facts[0].evidence_status, "unverified_external");
});

test("SEC connector fails closed, establishes a quiet baseline, then emits only a new accession", async () => {
  const secrets = memorySecrets();
  let persisted = null;
  let called = 0;
  const invocations = new Map();
  const emitted = [];
  const fetchImpl = async (url) => {
    called += 1;
    const company = SEC_WATCHLIST.find((item) => String(url).includes(item.cik));
    const count = (invocations.get(company.cik) ?? 0) + 1;
    invocations.set(company.cik, count);
    return Response.json(secEnvelope(company, { novel: company === SEC_WATCHLIST[0] && count > 1 }));
  };
  const engine = createEvidenceLoopEngine({
    secretStore: secrets,
    fetchImpl,
    clock: () => NOW,
    loadState: async () => persisted,
    saveState: async (value) => { persisted = value; },
    onFact: async (fact) => emitted.push(fact),
  });
  await engine.initialize();
  const disabled = await engine.refreshSec();
  assert.equal(disabled.ok, false);
  assert.equal(called, 0);

  await engine.setupSec({ contactEmail: "researcher@example.com" });
  const baseline = await engine.refreshSec();
  assert.equal(baseline.baseline_established, true);
  assert.equal(baseline.baseline_count, SEC_WATCHLIST.length);
  assert.equal(baseline.novel_count, 0);
  assert.equal(emitted.length, 0);
  assert.ok(engine.getProjection().facts.every((fact) => fact.payload.baseline_only));

  const delta = await engine.refreshSec();
  assert.equal(delta.novel_count, 1);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.form, "8-K");
  assert.equal(engine.getProjection().pending_reaction_count, 1);

  const restarted = createEvidenceLoopEngine({
    secretStore: secrets,
    fetchImpl,
    clock: () => NOW,
    loadState: async () => persisted,
    saveState: async (value) => { persisted = value; },
    onFact: async (fact) => emitted.push(fact),
  });
  await restarted.initialize();
  const afterRestart = await restarted.refreshSec();
  assert.equal(afterRestart.novel_count, 0);
  assert.equal(emitted.length, 1);
});

test("FRED parser preserves realtime vintage fields and explicit missing values", () => {
  const values = parseFredObservations({ observations: [
    { date: "2026-08-19", realtime_start: "2026-08-20", realtime_end: "2026-08-20", value: "4.25" },
    { date: "2026-08-18", realtime_start: "2026-08-20", realtime_end: "2026-08-20", value: "." },
  ] }, FRED_SERIES[0], { clock: () => NOW });
  assert.equal(values[0].value, 4.25);
  assert.equal(values[0].realtime_start, "2026-08-20");
  assert.equal(values[1].value, null);
  assert.equal(values[1].missing, true);
});

test("FRED refresh is allowlisted, revision-aware, and degrades on a partial envelope", async () => {
  const secrets = memorySecrets();
  let persisted = null;
  const requested = [];
  const engine = createEvidenceLoopEngine({
    secretStore: secrets,
    clock: () => NOW,
    loadState: async () => persisted,
    saveState: async (value) => { persisted = value; },
    fetchImpl: async (url) => {
      const seriesId = new URL(url).searchParams.get("series_id");
      requested.push(seriesId);
      if (seriesId === "NFCI") return Response.json({ error_code: 400, error_message: "invalid" });
      return Response.json({ observations: [
        { date: "2026-08-19", realtime_start: "2026-08-20", realtime_end: "2026-08-20", value: seriesId === "DFF" ? "." : "4.25" },
        { date: "2026-08-18", realtime_start: "2026-08-20", realtime_end: "2026-08-20", value: "4.20" },
      ] });
    },
  });
  await engine.initialize();
  assert.equal((await engine.refreshFred()).ok, false);
  await engine.setupFred({ apiKey: "fred-test-key" });
  const result = await engine.refreshFred();
  assert.equal(result.ok, true);
  assert.equal(result.series_count, FRED_SERIES.length - 1);
  assert.deepEqual(requested, FRED_SERIES.map((series) => series.id));
  assert.equal(result.health.state, "degraded");
  const dgs2 = result.snapshots.find((item) => item.series_id === "DGS2");
  assert.equal(dgs2.delta, 0.05);
  assert.equal(dgs2.realtime_start, "2026-08-20");
  assert.equal(result.snapshots.find((item) => item.series_id === "DFF").coverage_state, "partial");
});
