const EASTERN_TIME_ZONE = "America/New_York";
const TIME_ZONE_ALIASES = Object.freeze({
  "US-Eastern": EASTERN_TIME_ZONE,
  "US/Eastern": EASTERN_TIME_ZONE,
  EST5EDT: EASTERN_TIME_ZONE,
});

function normalizeTimeZone(value) {
  const zone = String(value ?? "").trim();
  return TIME_ZONE_ALIASES[zone] ?? (zone || EASTERN_TIME_ZONE);
}

function unfoldIcs(text) {
  return String(text ?? "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function decodeIcs(value) {
  return String(value ?? "")
    .replaceAll("\\n", " ")
    .replaceAll("\\,", ",")
    .replaceAll("\\;", ";")
    .replaceAll("\\\\", "\\")
    .trim();
}

function partsInZone(date, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
}

export function zonedDateTimeToIso({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = EASTERN_TIME_ZONE) {
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = new Date(desired);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = partsInZone(candidate, normalizedTimeZone);
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const delta = desired - represented;
    if (delta === 0) break;
    candidate = new Date(candidate.getTime() + delta);
  }
  return candidate.toISOString();
}

function parseDateTime(raw, parameters = "") {
  const value = String(raw ?? "").trim();
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!match) return null;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? 0),
    minute: Number(match[5] ?? 0),
    second: Number(match[6] ?? 0),
  };
  if (match[7] === "Z") {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)).toISOString();
  }
  const zone = parameters.match(/TZID=([^;:]+)/i)?.[1] ?? EASTERN_TIME_ZONE;
  return zonedDateTimeToIso(parts, zone);
}

function classifySummary(summary) {
  if (/consumer price index|\bcpi\b/iu.test(summary)) return { releaseType: "cpi", priority: "critical", domain: "macro" };
  if (/employment situation|nonfarm payroll/iu.test(summary)) return { releaseType: "employment", priority: "critical", domain: "macro" };
  if (/producer price index|\bppi\b/iu.test(summary)) return { releaseType: "ppi", priority: "high", domain: "macro" };
  return null;
}

function eventId(prefix, releaseType, scheduledAt) {
  return `${prefix}-${releaseType}-${scheduledAt.slice(0, 10)}`;
}

function eventWindow({ id, title, releaseType, scheduledAt, sourceUrl, sourceKind, priority = "critical" }) {
  const scheduled = Date.parse(scheduledAt);
  return Object.freeze({
    id,
    title,
    release_type: releaseType,
    domain: "macro",
    priority,
    scheduled_at: scheduledAt,
    opens_at: new Date(scheduled - 5 * 60 * 1_000).toISOString(),
    closes_at: new Date(scheduled + 15 * 60 * 1_000).toISOString(),
    source_url: sourceUrl,
    source_kind: sourceKind,
    consensus_snapshot: null,
    consensus_state: "missing_legal_source",
    expected_fields: releaseType === "fomc"
      ? ["decision", "target_range", "statement_bias"]
      : ["actual", "forecast", "previous"],
  });
}

export function parseBlsCalendarIcs(text) {
  const lines = unfoldIcs(text);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current?.summary && current?.scheduledAt) {
        const classification = classifySummary(current.summary);
        if (classification) {
          events.push(eventWindow({
            id: eventId("bls", classification.releaseType, current.scheduledAt),
            title: current.summary,
            releaseType: classification.releaseType,
            scheduledAt: current.scheduledAt,
            sourceUrl: "https://www.bls.gov/schedule/news_release/bls.ics",
            sourceKind: "official_calendar",
            priority: classification.priority,
          }));
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const descriptor = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const [name, ...parameters] = descriptor.split(";");
    if (name === "SUMMARY") current.summary = decodeIcs(value);
    if (name === "DTSTART") current.scheduledAt = parseDateTime(value, parameters.join(";"));
  }
  return events.sort((left, right) => Date.parse(left.scheduled_at) - Date.parse(right.scheduled_at));
}

function isoEastern(year, month, day, hour, minute = 0) {
  return zonedDateTimeToIso({ year, month, day, hour, minute }, EASTERN_TIME_ZONE);
}

export function fallbackEventWindows() {
  const cpiDates = [
    [2026, 8, 12],
    [2026, 9, 11],
    [2026, 10, 14],
    [2026, 11, 10],
    [2026, 12, 10],
  ];
  const fomcDates = [
    [2026, 9, 16],
    [2026, 10, 28],
    [2026, 12, 9],
  ];
  return [
    ...cpiDates.map(([year, month, day]) => {
      const scheduledAt = isoEastern(year, month, day, 8, 30);
      return eventWindow({
        id: eventId("bls", "cpi", scheduledAt),
        title: "Consumer Price Index",
        releaseType: "cpi",
        scheduledAt,
        sourceUrl: "https://www.bls.gov/schedule/news_release/cpi.htm",
        sourceKind: "official_calendar_fallback",
      });
    }),
    ...fomcDates.map(([year, month, day]) => {
      const scheduledAt = isoEastern(year, month, day, 14);
      return eventWindow({
        id: eventId("fed", "fomc", scheduledAt),
        title: "FOMC policy statement",
        releaseType: "fomc",
        scheduledAt,
        sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
        sourceKind: "official_calendar_fallback",
      });
    }),
  ].sort((left, right) => Date.parse(left.scheduled_at) - Date.parse(right.scheduled_at));
}

export function windowState(window, now = new Date()) {
  const current = now.getTime();
  const opens = Date.parse(window.opens_at);
  const scheduled = Date.parse(window.scheduled_at);
  const closes = Date.parse(window.closes_at);
  if (current < opens) return "scheduled";
  if (current < scheduled) return "armed";
  if (current <= closes) return "live";
  return "closed";
}

export function mergeEventWindows(...collections) {
  const byId = new Map();
  for (const collection of collections) {
    for (const item of Array.isArray(collection) ? collection : []) {
      if (!item?.id || !Number.isFinite(Date.parse(item.scheduled_at))) continue;
      const previous = byId.get(item.id);
      if (!previous || previous.source_kind === "official_calendar_fallback") byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort((left, right) => Date.parse(left.scheduled_at) - Date.parse(right.scheduled_at));
}
