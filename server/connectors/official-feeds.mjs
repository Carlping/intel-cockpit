import {
  ConnectorRequestError,
  createContentHash,
  createHealthReport,
  createObservation,
  validateFeedSpec,
} from "./contracts.mjs";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const specs = [
  {
    feed_id: "fed.monetary-policy",
    source_type: "rss",
    authority_tier: "primary_official",
    poll_interval: 900,
    license_scope: "Federal Reserve public press release feed; retain source attribution.",
    domain: "macro",
    enabled: true,
    health_state: "healthy",
    endpoint: "https://www.federalreserve.gov/feeds/press_monetary.xml",
  },
  {
    feed_id: "bls.us-cpi",
    source_type: "json_api",
    authority_tier: "primary_official",
    poll_interval: 21_600,
    license_scope: "U.S. Bureau of Labor Statistics public data; retain series identity.",
    domain: "macro",
    enabled: true,
    health_state: "healthy",
    endpoint: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
  },
  {
    feed_id: "bea.us-pce",
    source_type: "json_api",
    authority_tier: "primary_official",
    poll_interval: 21_600,
    license_scope: "U.S. Bureau of Economic Analysis NIPA data; retain table and series identity.",
    domain: "macro",
    enabled: false,
    health_state: "disabled",
    endpoint: "https://apps.bea.gov/api/data/",
    disabled_reason: "bea_api_key_required",
  },
  {
    feed_id: "treasury.debt-to-penny",
    source_type: "json_api",
    authority_tier: "primary_official",
    poll_interval: 21_600,
    license_scope: "U.S. Treasury Fiscal Data public API; retain field and source attribution.",
    domain: "macro",
    enabled: true,
    health_state: "healthy",
    endpoint:
      "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page%5Bsize%5D=10",
  },
  {
    feed_id: "federal-register.latest",
    source_type: "json_api",
    authority_tier: "primary_official",
    poll_interval: 3_600,
    license_scope: "Federal Register public API; link to the controlling document.",
    domain: "policy",
    enabled: true,
    health_state: "healthy",
    endpoint: "https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest",
  },
  {
    feed_id: "cisa.advisories",
    source_type: "rss",
    authority_tier: "primary_official",
    poll_interval: 1_800,
    license_scope: "CISA public advisory feed; retain advisory URL and attribution.",
    domain: "cybersecurity",
    enabled: true,
    health_state: "healthy",
    endpoint: "https://www.cisa.gov/cybersecurity-advisories/all.xml",
  },
  {
    feed_id: "cnn.world-news",
    source_type: "rss",
    authority_tier: "publisher_primary",
    poll_interval: 300,
    license_scope: "CNN.co.jp official RSS; retain headline and source URL only for local personal use.",
    domain: "world-news",
    enabled: true,
    health_state: "healthy",
    endpoint: "https://feeds.cnn.co.jp/rss/cnn/cnn.rdf",
  },
  {
    feed_id: "cnn.fear-greed",
    source_type: "manual",
    authority_tier: "publisher_primary",
    poll_interval: 900,
    license_scope: "CNN Fear & Greed reference only; automatic retrieval requires a documented or licensed API.",
    domain: "finance",
    enabled: false,
    health_state: "disabled",
    endpoint: "https://www.cnn.com/markets/fear-and-greed",
    disabled_reason: "manual_snapshot_or_licensed_source_required",
  },
  {
    feed_id: "usgs.significant-earthquakes",
    source_type: "json_api",
    authority_tier: "primary_official",
    poll_interval: 300,
    license_scope: "USGS public earthquake GeoJSON feed; retain event identity and URL.",
    domain: "geophysical-risk",
    enabled: true,
    health_state: "healthy",
    endpoint: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_day.geojson",
  },
  {
    feed_id: "sec.submissions",
    source_type: "json_api",
    authority_tier: "primary_official",
    poll_interval: 21_600,
    license_scope: "SEC fair-access policy; a descriptive User-Agent with contact is required.",
    domain: "finance",
    enabled: false,
    health_state: "disabled",
    endpoint: "https://data.sec.gov/submissions/",
    disabled_reason: "contact_email_required",
  },
];

export const OFFICIAL_FEED_SPECS = Object.freeze(specs.map(validateFeedSpec));

const specById = new Map(OFFICIAL_FEED_SPECS.map((spec) => [spec.feed_id, spec]));

export function listOfficialFeedSpecs({ includeDisabled = true } = {}) {
  return OFFICIAL_FEED_SPECS.filter((spec) => includeDisabled || spec.enabled);
}

function decodeXml(value = "") {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/g, "&");
}

function stripMarkup(value = "") {
  return decodeXml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function tagValue(block, tag) {
  const escaped = tag.replace(":", "\\:");
  const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? decodeXml(match[1].trim()) : undefined;
}

function atomLink(block) {
  const match = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  return match ? decodeXml(match[1]) : undefined;
}

function isoOrFallback(value, fallback) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function boundedText(value, maximum) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function rssSourceUrl(value, fallback) {
  try {
    const parsed = new URL(value || fallback, fallback);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.toString().length > 4_096) {
      return fallback;
    }
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function parseRss(text, spec, observedAt) {
  const itemBlocks = [...text.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(
    (match) => match[2],
  );

  return itemBlocks.slice(0, 100).flatMap((block, index) => {
    const rawTitle = stripMarkup(tagValue(block, "title"));
    const title = boundedText(rawTitle, 1_000);
    const link = rssSourceUrl(
      stripMarkup(tagValue(block, "link")) || atomLink(block),
      spec.endpoint,
    );
    const rawId = stripMarkup(tagValue(block, "guid") || tagValue(block, "id")) || `${link}#${index}`;
    const eventId = `${spec.feed_id}:${rawId}`;
    const externalEventId = eventId.length <= 500
      ? eventId
      : `${spec.feed_id}:rss-${createContentHash(rawId).slice(0, 40)}`;
    const published =
      tagValue(block, "pubDate") ||
      tagValue(block, "published") ||
      tagValue(block, "updated") ||
      observedAt;
    const rawSummary = stripMarkup(
      tagValue(block, "description") || tagValue(block, "summary") || tagValue(block, "content"),
    );
    // RSS feeds such as CISA can embed an entire advisory in <description>.
    // Keep a bounded excerpt; the canonical source URL remains the evidence.
    const headlineOnly = spec.feed_id === "cnn.world-news";
    const summary = headlineOnly ? "" : boundedText(rawSummary, 4_000);
    if (!title && !summary) return [];

    return [
      createObservation({
        external_event_id: externalEventId,
        feed_id: spec.feed_id,
        published_at: isoOrFallback(published, observedAt),
        observed_at: observedAt,
        as_of: isoOrFallback(published, observedAt),
        source_url: link,
        evidence_status: "unverified_external",
        matched_interest_ids: [],
        materiality: "unscored",
        coverage_state: "complete",
        license_ref: spec.license_scope,
        title,
        summary,
        payload: {
          source_type: "rss",
          headline_only: headlineOnly,
          excerpt_truncated: !headlineOnly && rawSummary.length > summary.length,
        },
        untrusted_external_content: true,
      }),
    ];
  });
}

function parseBls(body, spec, observedAt) {
  if (body.status !== "REQUEST_SUCCEEDED" || !Array.isArray(body.Results?.series)) {
    throw new ConnectorRequestError("BLS returned an invalid data envelope", {
      code: "invalid_upstream_payload",
    });
  }
  return body.Results.series.flatMap((series) =>
    (series.data ?? []).flatMap((point) => {
      const month = /^M(0[1-9]|1[0-2])$/.exec(point.period ?? "")?.[1];
      if (!month || !/^\d{4}$/.test(point.year ?? "")) return [];
      const asOf = new Date(`${point.year}-${month}-01T00:00:00.000Z`).toISOString();
      const title = `${series.seriesID} ${point.periodName ?? point.period}`;
      return [
        createObservation({
          external_event_id: `${spec.feed_id}:${series.seriesID}:${point.year}-${point.period}`,
          feed_id: spec.feed_id,
          observed_at: observedAt,
          as_of: asOf,
          source_url: "https://www.bls.gov/cpi/",
          evidence_status: "unverified_external",
          matched_interest_ids: [],
          materiality: "unscored",
          coverage_state: "complete",
          license_ref: spec.license_scope,
          title,
          summary: `Value ${point.value}`,
          payload: {
            series_id: series.seriesID,
            as_of: asOf,
            ...(series.seriesID === "CUUR0000SA0"
              ? { unit: "index_1982_1984_100" }
              : {}),
            year: point.year,
            period: point.period,
            period_name: point.periodName,
            value: point.value,
            footnotes: point.footnotes ?? [],
          },
          untrusted_external_content: true,
        }),
      ];
    }),
  );
}

function parseTreasury(body, spec, observedAt) {
  if (!Array.isArray(body.data)) {
    throw new ConnectorRequestError("Treasury returned an invalid data envelope", {
      code: "invalid_upstream_payload",
    });
  }
  return body.data.slice(0, 100).map((row) => {
    const asOf = isoOrFallback(`${row.record_date}T00:00:00Z`, observedAt);
    return createObservation({
      external_event_id: `${spec.feed_id}:${row.record_date}`,
      feed_id: spec.feed_id,
      observed_at: observedAt,
      as_of: asOf,
      source_url: "https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/debt-to-the-penny",
      evidence_status: "unverified_external",
      matched_interest_ids: [],
      materiality: "unscored",
      coverage_state: "complete",
      license_ref: spec.license_scope,
      title: `Debt to the Penny — ${row.record_date}`,
      summary: `Total public debt outstanding: ${row.tot_pub_debt_out_amt ?? "unavailable"}`,
      payload: { ...row },
      untrusted_external_content: true,
    });
  });
}

function parseFederalRegister(body, spec, observedAt) {
  if (!Array.isArray(body.results)) {
    throw new ConnectorRequestError("Federal Register returned an invalid data envelope", {
      code: "invalid_upstream_payload",
    });
  }
  return body.results.slice(0, 100).map((row) => {
    const asOf = isoOrFallback(`${row.publication_date}T00:00:00Z`, observedAt);
    return createObservation({
      external_event_id: `${spec.feed_id}:${row.document_number}`,
      feed_id: spec.feed_id,
      published_at: asOf,
      observed_at: observedAt,
      as_of: asOf,
      source_url: row.html_url || row.pdf_url || "https://www.federalregister.gov/",
      evidence_status: "unverified_external",
      matched_interest_ids: [],
      materiality: "unscored",
      coverage_state: "complete",
      license_ref: spec.license_scope,
      title: row.title,
      summary: row.abstract || row.type,
      payload: {
        document_number: row.document_number,
        type: row.type,
        agencies: row.agencies ?? [],
      },
      untrusted_external_content: true,
    });
  });
}

function parseUsgs(body, spec, observedAt) {
  if (!Array.isArray(body.features)) {
    throw new ConnectorRequestError("USGS returned an invalid GeoJSON envelope", {
      code: "invalid_upstream_payload",
    });
  }
  return body.features.slice(0, 100).map((feature) => {
    const properties = feature.properties ?? {};
    const publishedAt = Number.isFinite(properties.time)
      ? new Date(properties.time).toISOString()
      : observedAt;
    return createObservation({
      external_event_id: `${spec.feed_id}:${feature.id}`,
      feed_id: spec.feed_id,
      published_at: publishedAt,
      observed_at: observedAt,
      as_of: publishedAt,
      source_url: properties.url || "https://earthquake.usgs.gov/earthquakes/map/",
      evidence_status: "unverified_external",
      matched_interest_ids: [],
      materiality: "unscored",
      coverage_state: "complete",
      license_ref: spec.license_scope,
      title: properties.title || `USGS event ${feature.id}`,
      summary: `Magnitude ${properties.mag ?? "unknown"}; alert ${properties.alert ?? "none"}`,
      payload: {
        magnitude: properties.mag,
        alert: properties.alert,
        tsunami: properties.tsunami,
        significance: properties.sig,
        geometry: feature.geometry,
      },
      untrusted_external_content: true,
    });
  });
}

function parseJson(body, spec, observedAt) {
  switch (spec.feed_id) {
    case "bls.us-cpi":
      return parseBls(body, spec, observedAt);
    case "treasury.debt-to-penny":
      return parseTreasury(body, spec, observedAt);
    case "federal-register.latest":
      return parseFederalRegister(body, spec, observedAt);
    case "usgs.significant-earthquakes":
      return parseUsgs(body, spec, observedAt);
    default:
      throw new ConnectorRequestError(`No parser registered for ${spec.feed_id}`, {
        code: "parser_not_registered",
      });
  }
}

function requestFor(spec, now) {
  if (spec.feed_id !== "bls.us-cpi") {
    return {
      url: spec.endpoint,
      init: {
        method: "GET",
        headers: { accept: spec.source_type === "rss" ? "application/xml,text/xml" : "application/json" },
      },
    };
  }
  const year = now.getUTCFullYear();
  return {
    url: spec.endpoint,
    init: {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        seriesid: ["CUUR0000SA0"],
        startyear: String(year - 2),
        endyear: String(year),
      }),
    },
  };
}

async function readLimitedText(response) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ConnectorRequestError("Upstream response exceeded the size limit", {
      code: "response_too_large",
    });
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new ConnectorRequestError("Upstream response exceeded the size limit", {
      code: "response_too_large",
    });
  }
  return text;
}

function safeFailure(error) {
  if (error instanceof ConnectorRequestError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  return { code: "connector_request_failed", message: "Official feed request failed" };
}

export async function pollOfficialFeed(
  feedId,
  { fetchImpl = globalThis.fetch, clock = () => new Date(), signal } = {},
) {
  const spec = specById.get(feedId);
  if (!spec) throw new TypeError(`Unknown official feed: ${feedId}`);
  const checkedAt = clock().toISOString();
  if (!spec.enabled) {
    return {
      ok: false,
      feed: spec,
      observations: [],
      health: createHealthReport({
        feedId,
        state: "disabled",
        checkedAt,
        coverageState: "unknown",
        message: spec.disabled_reason || "Connector disabled",
      }),
    };
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  try {
    const { url, init } = requestFor(spec, new Date(checkedAt));
    const response = await fetchImpl(url, {
      ...init,
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!response?.ok) {
      throw new ConnectorRequestError(`Official feed returned HTTP ${response?.status ?? "error"}`, {
        code: "upstream_http_error",
        status: response?.status,
      });
    }
    const text = await readLimitedText(response);
    const observations =
      spec.source_type === "rss"
        ? parseRss(text, spec, checkedAt)
        : parseJson(JSON.parse(text), spec, checkedAt);
    return {
      ok: true,
      feed: spec,
      observations,
      health: createHealthReport({
        feedId,
        state: "healthy",
        checkedAt,
        lastSuccessAt: checkedAt,
        coverageState: "complete",
        message: `${observations.length} observations received`,
      }),
    };
  } catch (error) {
    const failure = safeFailure(error);
    return {
      ok: false,
      feed: spec,
      observations: [],
      error: failure,
      health: createHealthReport({
        feedId,
        state: "error",
        checkedAt,
        coverageState: "unknown",
        message: failure.message,
      }),
    };
  }
}
