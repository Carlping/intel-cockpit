const VALUE = "([+-]?(?:\\d{1,3}(?:,\\d{3})*|\\d+)(?:\\.\\d+)?)";
const UNIT = "(%|pct|percent|百分點|百分比|％|bp|bps)?";

const RELEASE_DEFINITIONS = Object.freeze([
  {
    id: "core_cpi",
    releaseType: "cpi",
    label: "核心 CPI",
    matcher: /(?:core\s*cpi|cpi\s*(?:core|excluding\s+food\s+(?:and|&)\s+energy)|核心\s*(?:cpi|消費者物價|消费者价格)|生鮮食品を除く消費者物価)/iu,
    pressure: "inflation",
  },
  {
    id: "headline_cpi",
    releaseType: "cpi",
    label: "CPI",
    matcher: /(?:\bcpi\b|consumer\s+price\s+index|消費者物價|消费者价格|消費者物価)/iu,
    pressure: "inflation",
  },
  {
    id: "core_pce",
    releaseType: "pce",
    label: "核心 PCE",
    matcher: /(?:core\s*pce|核心\s*pce)/iu,
    pressure: "inflation",
  },
  {
    id: "headline_pce",
    releaseType: "pce",
    label: "PCE",
    matcher: /(?:\bpce\b|personal\s+consumption\s+expenditures|個人消費支出)/iu,
    pressure: "inflation",
  },
  {
    id: "headline_ppi",
    releaseType: "ppi",
    label: "PPI",
    matcher: /(?:\bppi\b|producer\s+price\s+index|生產者物價|生产者价格|生産者物価)/iu,
    pressure: "inflation",
  },
  {
    id: "nonfarm_payrolls",
    releaseType: "employment",
    label: "非農就業",
    matcher: /(?:nonfarm\s+payrolls?|\bnfp\b|非農就業|非农就业|雇用統計)/iu,
    pressure: "growth",
  },
  {
    id: "unemployment_rate",
    releaseType: "employment",
    label: "失業率",
    matcher: /(?:unemployment\s+rate|失業率|失业率|完全失業率)/iu,
    pressure: "inverse_growth",
  },
  {
    id: "fed_funds_rate",
    releaseType: "fomc",
    label: "Fed 利率決策",
    matcher: /(?:fed(?:eral\s+reserve)?\s+(?:funds\s+)?rate|fomc|聯準會.*利率|美联储.*利率|政策金利)/iu,
    pressure: "rates",
  },
]);

const FORECAST_LABELS = [
  "forecast", "consensus", "expected", "expectation", "est", "預期", "预期", "市場預期", "市场预期", "予想",
];
const PREVIOUS_LABELS = [
  "previous", "prior", "prev", "前值", "前次", "上次", "前回",
];
const ACTUAL_LABELS = [
  "actual", "released", "公布", "實際", "实际", "現值", "现值", "結果", "结果", "発表", "結果値",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(input) {
  return String(input ?? "")
    .normalize("NFKC")
    .replace(/[−–—]/g, "-")
    .replace(/[：﹕]/g, ":")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value) {
  if (typeof value !== "string") return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function pickLabelledValue(text, labels) {
  const alternation = labels.map(escapeRegExp).join("|");
  const after = new RegExp(`(?:${alternation})\\s*(?:[:=]|was|of|at|為|为|は)?\\s*${VALUE}\\s*${UNIT}`, "iu");
  const afterMatch = text.match(after);
  if (afterMatch) return { value: parseNumber(afterMatch[1]), unit: afterMatch[2] ?? null };
  const before = new RegExp(`${VALUE}\\s*${UNIT}\\s*(?:\\(|\\[)?\\s*(?:${alternation})`, "iu");
  const beforeMatch = text.match(before);
  if (beforeMatch) return { value: parseNumber(beforeMatch[1]), unit: beforeMatch[2] ?? null };
  return null;
}

function numericCandidates(text) {
  const results = [];
  const pattern = new RegExp(`${VALUE}\\s*${UNIT}`, "giu");
  for (const match of text.matchAll(pattern)) {
    const value = parseNumber(match[1]);
    if (value == null) continue;
    const raw = match[0];
    const start = match.index ?? 0;
    const context = text.slice(Math.max(0, start - 18), Math.min(text.length, start + raw.length + 18));
    if (!match[2] && value >= 1900 && value <= 2200) continue;
    if (!match[2] && /(?:^|\D)\d{1,2}:\d{2}(?:\D|$)/.test(context)) continue;
    results.push({ value, unit: match[2] ?? null, index: start, raw });
  }
  return results;
}

function inferActual(text, definition, forecast, previous) {
  const labelled = pickLabelledValue(text, ACTUAL_LABELS);
  if (labelled) return labelled;
  const match = definition.matcher.exec(text);
  const startAt = match ? (match.index ?? 0) + match[0].length : 0;
  const values = numericCandidates(text).filter((candidate) => candidate.index >= startAt);
  const excluded = new Set(
    [forecast?.value, previous?.value]
      .filter((value) => typeof value === "number")
      .map((value) => String(value)),
  );
  return values.find((candidate) => !excluded.has(String(candidate.value))) ?? values[0] ?? null;
}

function inferFrequency(text) {
  if (/(?:month[-\s]?over[-\s]?month|month(?:ly)?|\bm\/m\b|\bmom\b|月增|月率|月比|前月比)/iu.test(text)) return "mom";
  if (/(?:year[-\s]?over[-\s]?year|annual|\by\/y\b|\byoy\b|年增|年率|前年比|年比)/iu.test(text)) return "yoy";
  if (/(?:quarter[-\s]?over[-\s]?quarter|\bq\/q\b|\bqoq\b|季增|季率|前期比)/iu.test(text)) return "qoq";
  return "unspecified";
}

function inferPeriod(text) {
  const monthNames = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
  const english = text.match(new RegExp(`\\b(${monthNames})\\.?\\s+(20\\d{2})\\b`, "iu"));
  if (english) return `${english[1]} ${english[2]}`;
  const eastAsian = text.match(/(20\d{2})\s*[年\/-]\s*(1[0-2]|0?[1-9])\s*月?/u);
  if (eastAsian) return `${eastAsian[1]}-${String(Number(eastAsian[2])).padStart(2, "0")}`;
  const compact = text.match(/\b(20\d{2})[-/](1[0-2]|0[1-9])\b/u);
  return compact ? `${compact[1]}-${compact[2]}` : null;
}

function resolveUnit(actual, forecast, previous, definition) {
  const supplied = [actual?.unit, forecast?.unit, previous?.unit].find(Boolean);
  if (supplied) {
    const normalized = supplied.toLocaleLowerCase("en-US");
    if (["%", "％", "pct", "percent", "百分點", "百分比"].includes(normalized)) return "percent";
    if (["bp", "bps"].includes(normalized)) return "basis_points";
  }
  return definition.id === "nonfarm_payrolls" ? "thousands" : "number";
}

function round(value, precision = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function pressureFor(definition, surprise) {
  if (!Number.isFinite(surprise) || surprise === 0) {
    return { direction: "neutral", label: "大致符合預期", magnitude: "none" };
  }
  const positive = surprise > 0;
  const magnitude = Math.abs(surprise) >= 0.2 ? "large" : Math.abs(surprise) >= 0.1 ? "medium" : "small";
  if (definition.pressure === "inflation") {
    return positive
      ? { direction: "hawkish", label: "偏鷹派壓力", magnitude }
      : { direction: "dovish", label: "偏鴿派壓力", magnitude };
  }
  if (definition.pressure === "inverse_growth") {
    return positive
      ? { direction: "growth_down", label: "成長降溫壓力", magnitude }
      : { direction: "growth_up", label: "就業偏強壓力", magnitude };
  }
  if (definition.pressure === "rates") {
    return positive
      ? { direction: "hawkish", label: "利率路徑偏高", magnitude }
      : { direction: "dovish", label: "利率路徑偏低", magnitude };
  }
  return positive
    ? { direction: "growth_up", label: "成長偏強壓力", magnitude }
    : { direction: "growth_down", label: "成長偏弱壓力", magnitude };
}

function definitionFor(text) {
  return RELEASE_DEFINITIONS.find((definition) => definition.matcher.test(text)) ?? null;
}

export function parseEconomicRelease(input, { receivedAt = new Date().toISOString() } = {}) {
  const text = normalizeText(input);
  if (!text) return null;
  const definition = definitionFor(text);
  if (!definition) return null;
  const forecast = pickLabelledValue(text, FORECAST_LABELS);
  const previous = pickLabelledValue(text, PREVIOUS_LABELS);
  const actual = inferActual(text, definition, forecast, previous);
  if (!actual || actual.value == null) return null;
  const frequency = inferFrequency(text);
  const unit = resolveUnit(actual, forecast, previous, definition);
  const surprise = forecast?.value == null ? null : round(actual.value - forecast.value);
  const pressure = pressureFor(definition, surprise);
  const extractedCount = [actual?.value, forecast?.value, previous?.value]
    .filter((value) => typeof value === "number").length;
  const confidence = extractedCount === 3 ? 0.98 : extractedCount === 2 ? 0.88 : 0.72;
  const metricId = `${definition.id}_${frequency}`;
  return Object.freeze({
    release_type: definition.releaseType,
    metric_id: metricId,
    metric_label: `${definition.label}${frequency === "mom" ? "月增率" : frequency === "yoy" ? "年增率" : ""}`,
    frequency,
    period: inferPeriod(text),
    actual: actual.value,
    forecast: forecast?.value ?? null,
    previous: previous?.value ?? null,
    unit,
    surprise,
    pressure_direction: pressure.direction,
    pressure_label: pressure.label,
    pressure_magnitude: pressure.magnitude,
    extraction_confidence: confidence,
    extracted_field_count: extractedCount,
    received_at: receivedAt,
    parser: "deterministic_release_parser_v2",
  });
}

function displayNumber(value, unit) {
  if (!Number.isFinite(value)) return "—";
  const suffix = unit === "percent" ? "%" : unit === "basis_points" ? "bp" : unit === "thousands" ? "K" : "";
  return `${value}${suffix}`;
}

export function formatFlashAlert(signal) {
  const claim = signal?.parsed_claim;
  if (!claim) return "已收到 Telegram 快訊，但無法可靠提取數值。原文會留在待分流區，不會猜測。";
  const factLabels = {
    unverified: "未驗證",
    source_matched: "第二來源吻合",
    official_confirmed: "官方確認",
    conflicted: "來源衝突",
  };
  const impactLabels = {
    not_observed: "等待中",
    market_reacting: "市場正在反應",
    mixed: "市場反應分歧",
    contradictory: "市場反應相反",
  };
  const surprise = claim.surprise == null
    ? "缺少預期值，暫不計算"
    : `${claim.surprise > 0 ? "+" : ""}${displayNumber(claim.surprise, claim.unit)} · ${claim.pressure_label}`;
  return [
    `${claim.metric_label} FLASH｜${factLabels[signal.fact_state] ?? signal.fact_state}`,
    `實際 ${displayNumber(claim.actual, claim.unit)}｜預期 ${displayNumber(claim.forecast, claim.unit)}｜前值 ${displayNumber(claim.previous, claim.unit)}`,
    `Surprise：${surprise}`,
    `來源：${signal.source_label ?? "轉傳來源未公開"}｜收到 ${new Date(signal.last_seen_at).toLocaleTimeString("zh-TW", { timeZone: "America/New_York", hour12: false })} ET｜${signal.independent_source_count} 個獨立來源`,
    `官方確認：${factLabels[signal.fact_state] ?? signal.fact_state}｜市場反應：${impactLabels[signal.impact_state] ?? signal.impact_state}`,
    "單一快訊只改變方向壓力，不會自動改機率或建立 Mission。",
  ].join("\n");
}

export const SUPPORTED_RELEASE_TYPES = Object.freeze(
  [...new Set(RELEASE_DEFINITIONS.map((definition) => definition.releaseType))],
);
