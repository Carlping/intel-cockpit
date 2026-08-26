const DEFAULT_SYMBOLS = Object.freeze(["SPY", "QQQ", "IWM", "TLT", "UUP", "GLD"]);
const ALPACA_IEX_STREAM = "wss://stream.data.alpaca.markets/v2/iex";
const ALPACA_HISTORICAL_BARS = "https://data.alpaca.markets/v2/stocks/bars";
const MAX_POINTS_PER_SYMBOL = 1_200;

function normalizedCredentials(keyId, secretKey) {
  const key = typeof keyId === "string" ? keyId.trim() : "";
  const secret = typeof secretKey === "string" ? secretKey.trim() : "";
  return key && secret ? { key, secret } : null;
}

function health(state, checkedAt, message, extra = {}) {
  return {
    feed_id: "market.alpaca-iex",
    label: "Alpaca IEX market reaction",
    state,
    checked_at: checkedAt,
    coverage_state: state === "healthy" ? "iex_proxy" : "unavailable",
    message,
    symbols: [...DEFAULT_SYMBOLS],
    ...extra,
  };
}

function parseEvents(data) {
  try {
    const parsed = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export function createAlpacaIexMarketAdapter({
  secretStore,
  webSocketFactory = (url) => new WebSocket(url),
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  symbols = DEFAULT_SYMBOLS,
} = {}) {
  if (!secretStore?.read || !secretStore?.write) throw new TypeError("secretStore is required");
  if (typeof webSocketFactory !== "function") throw new TypeError("webSocketFactory is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const subscribedSymbols = [...new Set(symbols.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))].slice(0, 30);
  const points = new Map(subscribedSymbols.map((symbol) => [symbol, []]));
  let credentials = null;
  let socket = null;
  let authenticated = false;
  let stopped = false;
  let lastHealth = health("disabled", clock().toISOString(), "Alpaca IEX credentials have not been configured");

  async function initialize() {
    const [keyId, secretKey] = await Promise.all([
      secretStore.read("alpaca-api-key-id"),
      secretStore.read("alpaca-api-secret-key"),
    ]);
    credentials = normalizedCredentials(keyId, secretKey);
    lastHealth = credentials
      ? health("degraded", clock().toISOString(), "Credentials are stored; waiting for the IEX stream")
      : health("disabled", clock().toISOString(), "Alpaca IEX credentials have not been configured");
    return { enabled: Boolean(credentials), health: lastHealth };
  }

  function send(payload) {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  function attach(event, listener) {
    if (typeof socket?.addEventListener === "function") socket.addEventListener(event, listener);
    else if (typeof socket?.on === "function") socket.on(event, listener);
    else if (socket) socket[`on${event}`] = listener;
  }

  async function connect() {
    stopped = false;
    if (!credentials) await initialize();
    if (!credentials) return { ok: false, health: lastHealth };
    if (socket && [0, 1].includes(socket.readyState)) return { ok: true, health: lastHealth };
    try {
      socket = webSocketFactory(ALPACA_IEX_STREAM);
      authenticated = false;
      attach("open", () => {
        send({ action: "auth", key: credentials.key, secret: credentials.secret });
      });
      attach("message", (message) => {
        const raw = message?.data ?? message;
        for (const event of parseEvents(raw)) {
          if (event?.T === "success" && event.msg === "authenticated") {
            authenticated = true;
            send({ action: "subscribe", trades: subscribedSymbols });
            lastHealth = health("healthy", clock().toISOString(), "Streaming real-time IEX trades as a partial market-reaction proxy", {
              last_success_at: clock().toISOString(),
            });
            continue;
          }
          if (event?.T === "error") {
            lastHealth = health("degraded", clock().toISOString(), "Alpaca IEX rejected the stream session");
            continue;
          }
          if (event?.T !== "t" || !points.has(event.S) || !Number.isFinite(Number(event.p))) continue;
          const series = points.get(event.S);
          series.push({
            price: Number(event.p),
            at: typeof event.t === "string" && Number.isFinite(Date.parse(event.t))
              ? event.t
              : clock().toISOString(),
          });
          if (series.length > MAX_POINTS_PER_SYMBOL) series.splice(0, series.length - MAX_POINTS_PER_SYMBOL);
          lastHealth = health("healthy", clock().toISOString(), "Streaming real-time IEX trades as a partial market-reaction proxy", {
            last_success_at: clock().toISOString(),
          });
        }
      });
      attach("error", () => {
        lastHealth = health("degraded", clock().toISOString(), "Alpaca IEX stream encountered a connection error");
      });
      attach("close", () => {
        authenticated = false;
        socket = null;
        if (!stopped) lastHealth = health("degraded", clock().toISOString(), "Alpaca IEX stream disconnected; reconnect pending");
      });
      return { ok: true, health: lastHealth };
    } catch {
      socket = null;
      lastHealth = health("degraded", clock().toISOString(), "Alpaca IEX stream could not start");
      return { ok: false, health: lastHealth };
    }
  }

  async function bootstrap({ keyId, secretKey } = {}) {
    const next = normalizedCredentials(keyId, secretKey);
    if (!next) throw new TypeError("Both Alpaca key id and secret key are required");
    await secretStore.write("alpaca-api-key-id", next.key);
    await secretStore.write("alpaca-api-secret-key", next.secret);
    credentials = next;
    if (socket) {
      stopped = true;
      socket.close?.();
      socket = null;
    }
    stopped = false;
    return connect();
  }

  function reactionSince(sinceAt, { minimumAgeMs = 5_000 } = {}) {
    const since = Date.parse(sinceAt);
    if (!authenticated || !Number.isFinite(since)) return null;
    const moves = [];
    for (const symbol of subscribedSymbols) {
      const series = points.get(symbol).filter((point) => Date.parse(point.at) >= since);
      if (series.length < 2) continue;
      const first = series[0];
      const last = series.at(-1);
      if (Date.parse(last.at) - Date.parse(first.at) < minimumAgeMs || first.price === 0) continue;
      moves.push({
        symbol,
        first_price: first.price,
        last_price: last.price,
        change_percent: Math.round((((last.price - first.price) / first.price) * 100) * 10_000) / 10_000,
        first_at: first.at,
        last_at: last.at,
      });
    }
    if (!moves.length) return null;
    return {
      provider: "alpaca_iex",
      coverage: "iex_proxy",
      as_of: clock().toISOString(),
      moves,
    };
  }

  async function historicalReaction({ symbols: requestedSymbols, eventAt, benchmark = "SPY", windowMinutes = 15 } = {}) {
    if (!credentials) await initialize();
    if (!credentials) return null;
    const eventTime = Date.parse(eventAt);
    if (!Number.isFinite(eventTime)) throw new TypeError("eventAt must be an ISO date");
    if (clock().getTime() - eventTime < 15 * 60 * 1_000) return null;
    const normalized = [...new Set((Array.isArray(requestedSymbols) ? requestedSymbols : [])
      .map((symbol) => String(symbol).trim().toUpperCase())
      .filter(Boolean))].slice(0, 30);
    const benchmarkSymbol = String(benchmark || "SPY").trim().toUpperCase();
    if (!normalized.includes(benchmarkSymbol)) normalized.push(benchmarkSymbol);
    if (!normalized.length) return null;

    const start = new Date(eventTime).toISOString();
    const end = new Date(eventTime + Math.max(1, Number(windowMinutes) || 15) * 60 * 1_000).toISOString();
    let selectedFeed = "sip";
    let response;
    for (const feed of ["sip", "iex"]) {
      const url = new URL(ALPACA_HISTORICAL_BARS);
      url.searchParams.set("symbols", normalized.join(","));
      url.searchParams.set("timeframe", "1Min");
      url.searchParams.set("start", start);
      url.searchParams.set("end", end);
      url.searchParams.set("limit", "10000");
      url.searchParams.set("adjustment", "raw");
      url.searchParams.set("feed", feed);
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "APCA-API-KEY-ID": credentials.key,
          "APCA-API-SECRET-KEY": credentials.secret,
        },
      });
      if (response?.ok) {
        selectedFeed = feed;
        break;
      }
      if (![403, 422].includes(response?.status) || feed === "iex") {
        throw new Error(`Alpaca historical bars request failed with HTTP ${response?.status ?? "unknown"}`);
      }
    }
    if (!response?.ok) return null;
    const body = await response.json();
    if (!body?.bars || typeof body.bars !== "object") throw new Error("Alpaca historical bars envelope is invalid");
    const returns = [];
    for (const symbol of normalized) {
      const bars = Array.isArray(body.bars[symbol]) ? body.bars[symbol] : [];
      if (bars.length < 2) continue;
      const first = bars[0];
      const last = bars.at(-1);
      const firstPrice = Number(first?.o ?? first?.c);
      const lastPrice = Number(last?.c ?? last?.o);
      if (!Number.isFinite(firstPrice) || !Number.isFinite(lastPrice) || firstPrice === 0) continue;
      returns.push({
        symbol,
        first_price: firstPrice,
        last_price: lastPrice,
        return_percent: Math.round((((lastPrice - firstPrice) / firstPrice) * 100) * 10_000) / 10_000,
        first_at: first?.t ?? start,
        last_at: last?.t ?? end,
        bar_count: bars.length,
      });
    }
    const benchmarkReturn = returns.find((item) => item.symbol === benchmarkSymbol)?.return_percent;
    const moves = returns.map((item) => ({
      ...item,
      abnormal_return_percent: item.symbol === benchmarkSymbol || !Number.isFinite(benchmarkReturn)
        ? null
        : Math.round((item.return_percent - benchmarkReturn) * 10_000) / 10_000,
    }));
    if (!moves.some((item) => item.symbol !== benchmarkSymbol)) return null;
    return {
      provider: "alpaca_historical_bars",
      feed: selectedFeed,
      coverage: selectedFeed === "sip" ? "sip_delayed_historical" : "iex_proxy",
      event_at: start,
      window_end_at: end,
      window_minutes: Math.max(1, Number(windowMinutes) || 15),
      benchmark: benchmarkSymbol,
      benchmark_return_percent: Number.isFinite(benchmarkReturn) ? benchmarkReturn : null,
      as_of: clock().toISOString(),
      moves,
    };
  }

  function stop() {
    stopped = true;
    authenticated = false;
    socket?.close?.();
    socket = null;
  }

  return Object.freeze({
    initialize,
    connect,
    bootstrap,
    reactionSince,
    historicalReaction,
    getHealth: () => ({ ...lastHealth }),
    stop,
  });
}
