import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateMulticlassBrier,
  createAlpacaIexMarketAdapter,
  createForwardIntelligenceEngine,
  createMemoryForwardStateStore,
  parseBlsCalendarIcs,
  parseEconomicRelease,
  windowState,
  zonedDateTimeToIso,
} from "../server/forward-intelligence/index.mjs";

function telegramObservation({
  eventId,
  summary,
  originKey,
  originTitle = "Macro Wire",
  observedAt = "2026-08-12T12:30:10.000Z",
} = {}) {
  return {
    external_event_id: eventId,
    feed_id: "telegram.explicit-submit",
    published_at: observedAt,
    observed_at: observedAt,
    as_of: observedAt,
    content_hash: `${eventId}-hash`,
    source_url: `telegram://chat/10/message/${eventId}`,
    summary,
    payload: {
      chat_id: "10",
      message_id: eventId,
      forwarded: true,
      ...(originKey ? { forward_origin_key: originKey } : { forward_origin_hidden: true }),
      forward_origin_title: originTitle,
    },
  };
}

test("deterministic release parser extracts English, Chinese, and Japanese CPI triples", () => {
  const english = parseEconomicRelease("US Core CPI MoM Actual 0.4% Forecast 0.3% Previous 0.2%");
  assert.equal(english.metric_id, "core_cpi_mom");
  assert.equal(english.actual, 0.4);
  assert.equal(english.forecast, 0.3);
  assert.equal(english.previous, 0.2);
  assert.equal(english.surprise, 0.1);
  assert.equal(english.pressure_direction, "hawkish");
  assert.equal(english.extraction_confidence, 0.98);

  const chinese = parseEconomicRelease("美國核心 CPI 月率：實際 0.4%，預期 0.3%，前值 0.2%");
  assert.equal(chinese.metric_id, "core_cpi_mom");
  assert.deepEqual([chinese.actual, chinese.forecast, chinese.previous], [0.4, 0.3, 0.2]);

  const japanese = parseEconomicRelease("米国コアCPI 前月比 発表 0.4% 予想 0.3% 前回 0.2%");
  assert.equal(japanese.release_type, "cpi");
  assert.deepEqual([japanese.actual, japanese.forecast, japanese.previous], [0.4, 0.3, 0.2]);
});

test("release parser fails closed when no supported metric is present", () => {
  assert.equal(parseEconomicRelease("Breaking: markets are moving quickly"), null);
  const partial = parseEconomicRelease("CPI actual 3.1%");
  assert.equal(partial.actual, 3.1);
  assert.equal(partial.forecast, null);
  assert.equal(partial.surprise, null);
  assert.equal(partial.extraction_confidence, 0.72);
});

test("official BLS calendar creates timezone-correct five-minute event windows", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/New_York:20260812T083000",
    "SUMMARY:Consumer Price Index for July 2026",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const [window] = parseBlsCalendarIcs(ics);
  assert.equal(window.scheduled_at, "2026-08-12T12:30:00.000Z");
  assert.equal(window.opens_at, "2026-08-12T12:25:00.000Z");
  assert.equal(windowState(window, new Date("2026-08-12T12:27:00.000Z")), "armed");
  assert.equal(windowState(window, new Date("2026-08-12T12:31:00.000Z")), "live");
  assert.equal(
    zonedDateTimeToIso({ year: 2026, month: 12, day: 9, hour: 14 }),
    "2026-12-09T19:00:00.000Z",
  );
  const [blsAliasWindow] = parseBlsCalendarIcs(ics.replace("America/New_York", "US-Eastern"));
  assert.equal(blsAliasWindow.scheduled_at, "2026-08-12T12:30:00.000Z");
});

test("Fast Lane keeps source independence separate from message velocity", async () => {
  let now = new Date("2026-08-12T12:30:10.000Z");
  const engine = createForwardIntelligenceEngine({
    stateStore: createMemoryForwardStateStore(),
    clock: () => new Date(now),
    fetchImpl: async () => { throw new Error("network not expected"); },
  });
  await engine.initialize();
  const text = "US Core CPI MoM Actual 0.4% Forecast 0.3% Previous 0.2%";
  let result = await engine.ingestObservation(telegramObservation({ eventId: "1", summary: text, originKey: "channel:101:77" }));
  assert.equal(result.signal.fact_state, "unverified");
  assert.equal(result.signal.independent_source_count, 1);
  assert.equal(result.signal.directional_pressure.canonical_probability_changed, false);

  now = new Date("2026-08-12T12:30:12.000Z");
  result = await engine.ingestObservation(telegramObservation({ eventId: "2", summary: text, originKey: "channel:101:77", observedAt: now.toISOString() }));
  assert.equal(result.signal.fact_state, "unverified", "the same original channel is not a second source");
  assert.equal(result.signal.independent_source_count, 1);
  assert.equal(result.signal.mention_count, 2);

  now = new Date("2026-08-12T12:30:15.000Z");
  result = await engine.ingestObservation(telegramObservation({ eventId: "3", summary: text, originKey: "channel:202:91", observedAt: now.toISOString() }));
  assert.equal(result.signal.fact_state, "source_matched");
  assert.equal(result.signal.independent_source_count, 2);
  assert.match(result.notification_text, /第二來源吻合/);
});

test("hidden forwards cannot corroborate and disagreements become conflicts", async () => {
  let now = new Date("2026-08-12T12:30:10.000Z");
  const engine = createForwardIntelligenceEngine({
    stateStore: createMemoryForwardStateStore(),
    clock: () => new Date(now),
    fetchImpl: async () => { throw new Error("network not expected"); },
  });
  await engine.initialize();
  const first = "US CPI YoY Actual 3.0% Forecast 3.1% Previous 3.2%";
  const second = "US CPI YoY Actual 3.2% Forecast 3.1% Previous 3.2%";
  let result = await engine.ingestObservation(telegramObservation({ eventId: "hidden-1", summary: first }));
  assert.equal(result.signal.independent_source_count, 0);
  now = new Date("2026-08-12T12:30:12.000Z");
  result = await engine.ingestObservation(telegramObservation({ eventId: "hidden-2", summary: first, observedAt: now.toISOString() }));
  assert.equal(result.signal.fact_state, "unverified");
  assert.equal(result.signal.independent_source_count, 0);
  now = new Date("2026-08-12T12:30:15.000Z");
  result = await engine.ingestObservation(telegramObservation({ eventId: "source-3", summary: second, originKey: "channel:303:1", observedAt: now.toISOString() }));
  assert.equal(result.signal.fact_state, "conflicted");
  assert.match(result.notification_text, /來源衝突/);
});

test("official confirmation resolves matching claims but exposes an official conflict", async () => {
  const now = new Date("2026-08-12T12:30:10.000Z");
  const engine = createForwardIntelligenceEngine({
    stateStore: createMemoryForwardStateStore(),
    clock: () => new Date(now),
    fetchImpl: async () => { throw new Error("network not expected"); },
  });
  await engine.initialize();
  const submitted = await engine.ingestObservation(telegramObservation({
    eventId: "source-1",
    summary: "US Core CPI MoM Actual 0.4% Forecast 0.3% Previous 0.2%",
    originKey: "channel:101:1",
  }));
  const matching = parseEconomicRelease("US Core CPI MoM Actual 0.4% Forecast 0.3% Previous 0.2%");
  let verified = await engine.applyOfficialRelease(submitted.signal.id, matching, {
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  });
  assert.equal(verified.signal.fact_state, "official_confirmed");
  const conflict = parseEconomicRelease("US Core CPI MoM Actual 0.5% Forecast 0.3% Previous 0.2%");
  verified = await engine.applyOfficialRelease(submitted.signal.id, conflict, {
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
  });
  assert.equal(verified.signal.fact_state, "conflicted");
});

test("forecast scoring is explicit and normalized", () => {
  const paths = [
    { id: "base", probability: 50 },
    { id: "upside", probability: 30 },
    { id: "stress", probability: 20 },
  ];
  assert.equal(calculateMulticlassBrier(paths, "base"), 0.1267);
  assert.throws(() => calculateMulticlassBrier(paths, "missing"), /outcome path/);
});

test("Alpaca IEX adapter stays credential-gated and reports only proxy reactions", async () => {
  const secrets = new Map();
  const store = {
    async read(name) { return secrets.get(name) ?? null; },
    async write(name, value) { secrets.set(name, value); },
  };
  class FakeSocket {
    readyState = 0;
    listeners = new Map();
    sent = [];
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
    emit(name, data) { this.listeners.get(name)?.(data); }
  }
  let socket;
  const adapter = createAlpacaIexMarketAdapter({
    secretStore: store,
    webSocketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
    clock: () => new Date("2026-08-12T12:30:20.000Z"),
  });
  assert.equal((await adapter.initialize()).enabled, false);
  const started = await adapter.bootstrap({ keyId: "local-key-id", secretKey: "local-secret" });
  assert.equal(started.ok, true);
  socket.readyState = 1;
  socket.emit("open");
  assert.equal(socket.sent[0].action, "auth");
  socket.emit("message", { data: JSON.stringify([{ T: "success", msg: "authenticated" }]) });
  assert.equal(socket.sent[1].action, "subscribe");
  socket.emit("message", { data: JSON.stringify([{ T: "t", S: "SPY", p: 500, t: "2026-08-12T12:30:10.000Z" }]) });
  socket.emit("message", { data: JSON.stringify([{ T: "t", S: "SPY", p: 499, t: "2026-08-12T12:30:18.000Z" }]) });
  const reaction = adapter.reactionSince("2026-08-12T12:30:10.000Z");
  assert.equal(reaction.provider, "alpaca_iex");
  assert.equal(reaction.coverage, "iex_proxy");
  assert.equal(reaction.moves[0].change_percent, -0.2);
  assert.doesNotMatch(JSON.stringify(adapter.getHealth()), /local-secret|local-key-id/);
  adapter.stop();
});

test("Alpaca historical backfill prefers delayed SIP and labels an IEX fallback", async () => {
  const store = {
    async read(name) {
      return name === "alpaca-api-key-id" ? "key-id" : name === "alpaca-api-secret-key" ? "secret" : null;
    },
    async write() {},
  };
  const requestedFeeds = [];
  const adapter = createAlpacaIexMarketAdapter({
    secretStore: store,
    clock: () => new Date("2026-08-12T13:00:00.000Z"),
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      const feed = parsed.searchParams.get("feed");
      requestedFeeds.push(feed);
      assert.equal(init.headers["APCA-API-KEY-ID"], "key-id");
      if (feed === "sip") return new Response("subscription required", { status: 403 });
      return Response.json({ bars: {
        TSLA: [
          { t: "2026-08-12T12:30:00.000Z", o: 200, c: 201 },
          { t: "2026-08-12T12:45:00.000Z", o: 203, c: 204 },
        ],
        SPY: [
          { t: "2026-08-12T12:30:00.000Z", o: 500, c: 501 },
          { t: "2026-08-12T12:45:00.000Z", o: 504, c: 505 },
        ],
      } });
    },
  });
  await adapter.initialize();
  const reaction = await adapter.historicalReaction({
    symbols: ["TSLA", "SPY"],
    eventAt: "2026-08-12T12:30:00.000Z",
    benchmark: "SPY",
  });
  assert.deepEqual(requestedFeeds, ["sip", "iex"]);
  assert.equal(reaction.feed, "iex");
  assert.equal(reaction.coverage, "iex_proxy");
  assert.equal(reaction.moves.find((move) => move.symbol === "TSLA").return_percent, 2);
  assert.equal(reaction.moves.find((move) => move.symbol === "TSLA").abnormal_return_percent, 1);
  assert.equal(reaction.moves.find((move) => move.symbol === "SPY").abnormal_return_percent, null);
  assert.doesNotMatch(JSON.stringify(reaction), /key-id|secret/);
});
