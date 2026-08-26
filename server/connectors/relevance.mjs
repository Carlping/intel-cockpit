import { validateObservation } from "./contracts.mjs";

const CLOSED_STATES = new Set(["closed", "resolved", "archived", "dismissed", "done"]);
const MATERIALITY_RANK = Object.freeze({
  unscored: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});
const ASCII_STOPWORDS = new Set([
  "about", "after", "again", "also", "before", "being", "between", "could",
  "decision", "from", "have", "into", "next", "other", "should", "that", "their",
  "there", "these", "they", "this", "those", "under", "until", "what", "when",
  "where", "which", "while", "with", "would", "your",
]);

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US");
}

function stringList(value) {
  return Array.isArray(value)
    ? value.map(normalize).filter(Boolean)
    : [];
}

function isActive(item) {
  return item?.enabled !== false && !CLOSED_STATES.has(normalize(item?.status));
}

function eligibleTerm(value, { explicit = false } = {}) {
  const term = normalize(value);
  if (!term) return false;
  if (/^[\x00-\x7f]+$/.test(term)) {
    return term.length >= (explicit ? 2 : 4) && !ASCII_STOPWORDS.has(term);
  }
  return term.length >= 2;
}

function termsFrom(item) {
  const explicit = [
    ...(Array.isArray(item?.keywords) ? item.keywords : []),
    ...(Array.isArray(item?.tags) ? item.tags : []),
    ...(Array.isArray(item?.aliases) ? item.aliases : []),
  ].map(normalize).filter((term) => eligibleTerm(term, { explicit: true }));
  const descriptive = [
    item?.title,
    item?.name,
    item?.objective,
    item?.current_assessment,
    item?.next_action,
    item?.text,
  ].flatMap((value) => normalize(value).split(/[^\p{L}\p{N}._+-]+/u))
    .filter(eligibleTerm);
  return {
    explicit: [...new Set(explicit)].slice(0, 50),
    descriptive: [...new Set(descriptive)].slice(0, 100),
  };
}

function searchableText(observation) {
  const payloadText = observation.payload ? JSON.stringify(observation.payload) : "";
  return normalize([observation.title, observation.summary, payloadText].filter(Boolean).join("\n"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ASCII terms use token/phrase boundaries. This keeps short explicit terms
 * useful ("AI", "Fed", "VIX") without allowing substring matches such as
 * "AI" in "maintain". CJK and other non-ASCII phrases retain substring
 * matching because whitespace tokenization is not generally available.
 */
function textHasTerm(text, term) {
  if (!/^[\x00-\x7f]+$/.test(term)) return text.includes(term);
  const escaped = escapeRegExp(term);
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
}

function structuralIdentifiers(observation) {
  const seriesValues = [
    observation.payload?.series_id,
    ...(Array.isArray(observation.payload?.series_ids)
      ? observation.payload.series_ids
      : []),
  ];
  return {
    feedId: normalize(observation.feed_id),
    seriesIds: new Set(seriesValues.map(normalize).filter(Boolean)),
  };
}

function identifierHits(item, identifiers) {
  const hits = [];
  const feedIds = new Set(stringList(item?.feed_ids));
  if (feedIds.has(identifiers.feedId)) hits.push(`feed:${identifiers.feedId}`);

  const configuredSeries = new Set(stringList(item?.series_ids));
  for (const seriesId of identifiers.seriesIds) {
    if (configuredSeries.has(seriesId)) hits.push(`series:${seriesId}`);
  }
  return hits;
}

function matchTarget(item, defaultKind) {
  const parentSituationId = item?.parent_situation_id;
  if (typeof parentSituationId === "string" && parentSituationId.trim()) {
    return { kind: "situation", id: parentSituationId.trim() };
  }
  return {
    kind: defaultKind,
    id: String(item.id ?? item.slug ?? item.name ?? item.title ?? `${defaultKind}-unknown`),
  };
}

function findMatches(text, identifiers, entries, kind, points) {
  const matches = [];
  for (const item of entries.filter(isActive)) {
    const terms = termsFrom(item);
    const exactIdentifierHits = identifierHits(item, identifiers);
    const explicitHits = terms.explicit.filter((term) => textHasTerm(text, term));
    const descriptiveHits = terms.descriptive.filter((term) => textHasTerm(text, term));
    const distinctiveNonAscii = descriptiveHits.some(
      (term) => !/^[\x00-\x7f]+$/.test(term) && term.length >= 4,
    );
    if (
      !exactIdentifierHits.length &&
      !explicitHits.length &&
      descriptiveHits.length < 2 &&
      !distinctiveNonAscii
    ) continue;
    const target = matchTarget(item, kind);
    const hitTerms = [
      ...new Set([...exactIdentifierHits, ...explicitHits, ...descriptiveHits]),
    ].slice(0, 10);
    matches.push({
      ...target,
      terms: hitTerms,
      points,
    });
  }
  return matches;
}

function mergeMatches(matches) {
  const merged = new Map();
  for (const match of matches) {
    const key = `${match.kind}:${match.id}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...match, terms: [...match.terms] });
      continue;
    }
    current.points = Math.max(current.points, match.points);
    current.terms = [...new Set([...current.terms, ...match.terms])].slice(0, 10);
  }
  return [...merged.values()];
}

function recentEntries(entries, now, maxRecentAgeDays) {
  const cutoff = now.getTime() - maxRecentAgeDays * 86_400_000;
  return entries.filter((item) => {
    const timestamp = Date.parse(item?.occurred_at ?? item?.created_at ?? item?.updated_at ?? "");
    return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now.getTime();
  });
}

/**
 * Deterministic first-pass routing. It never promotes evidence or creates a Mission;
 * it only decides whether an already validated Observation deserves quiet inbox,
 * normal inbox, or notification consideration.
 */
export function routeObservation(
  input,
  {
    situations = [],
    missions = [],
    watchConditions = [],
    interests = [],
    recentInputs = [],
    now = new Date(),
    maxRecentAgeDays = 14,
  } = {},
) {
  const observation = validateObservation(input);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  if (!Number.isFinite(maxRecentAgeDays) || maxRecentAgeDays <= 0) {
    throw new TypeError("maxRecentAgeDays must be positive");
  }

  const text = searchableText(observation);
  const identifiers = structuralIdentifiers(observation);
  const matches = mergeMatches([
    ...findMatches(text, identifiers, situations, "situation", 4),
    ...findMatches(text, identifiers, missions, "mission", 4),
    ...findMatches(text, identifiers, watchConditions, "watch_condition", 4),
    ...findMatches(text, identifiers, interests, "interest", 1),
    ...findMatches(
      text,
      identifiers,
      recentEntries(recentInputs, now, maxRecentAgeDays),
      "recent_input",
      2,
    ),
  ]);
  const score = matches.reduce((total, match) => total + match.points, 0);
  const anchored = matches.some((match) =>
    ["situation", "mission", "watch_condition"].includes(match.kind),
  );
  const materialityRank = MATERIALITY_RANK[observation.materiality] ?? 0;
  const notify = anchored && score >= 4 && materialityRank >= MATERIALITY_RANK.high;
  const route = notify ? "notify" : score > 0 ? "inbox" : "quiet_inbox";
  const matchedIds = [...new Set(matches.map((match) => match.id))];

  return Object.freeze({
    observation: Object.freeze({
      ...observation,
      matched_interest_ids: [...new Set([
        ...observation.matched_interest_ids,
        ...matchedIds,
      ])],
    }),
    relevance_score: score,
    route,
    notify,
    matched_context: matches,
    reason:
      route === "quiet_inbox"
        ? "No active situation, mission, watch condition, stable interest, or recent input matched."
        : notify
          ? "A live decision context matched and materiality is at least high."
          : "Relevant context matched, but notification threshold was not met.",
  });
}
