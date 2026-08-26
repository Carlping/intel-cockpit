import assert from "node:assert/strict";
import test from "node:test";

import { createObservation, routeObservation } from "../server/connectors/index.mjs";
import { watchContext } from "../server/runtime.mjs";
import { buildAlphaSeedDefinitions } from "../scripts/seed-alpha-v1.1.mjs";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function observation(overrides = {}) {
  return createObservation({
    external_event_id: "fixture:event",
    feed_id: "fixture.feed",
    observed_at: NOW.toISOString(),
    as_of: NOW.toISOString(),
    source_url: "https://example.com/source",
    evidence_status: "unverified_external",
    matched_interest_ids: [],
    materiality: "medium",
    coverage_state: "complete",
    license_ref: "test_only",
    title: "Fixture observation",
    summary: "Fixture summary",
    payload: {},
    ...overrides,
  });
}

function seededSituations() {
  return buildAlphaSeedDefinitions({ clock: () => NOW })
    .filter((definition) => definition.entity_type === "Situation")
    .map((definition) => ({
      id: definition.entity_id,
      ...definition.payload,
    }));
}

test("Alpha seed routes realistic Fed and BLS observations by exact feed and series identity", () => {
  const situations = seededSituations();
  const fed = routeObservation(observation({
    external_event_id: "fed.monetary-policy:fomc-statement",
    feed_id: "fed.monetary-policy",
    materiality: "high",
    title: "FOMC statement",
    summary: "The Committee decided to maintain the target range for the federal funds rate.",
    source_url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260730a.htm",
    payload: { source_type: "rss" },
  }), { situations, now: NOW });

  assert.equal(fed.route, "notify");
  assert.equal(fed.notify, true);
  assert.deepEqual(
    fed.matched_context.map(({ kind, id }) => ({ kind, id })),
    [{ kind: "situation", id: "situation-us-inflation-fed" }],
  );
  assert.ok(fed.matched_context[0].terms.includes("feed:fed.monetary-policy"));

  const bls = routeObservation(observation({
    external_event_id: "bls.us-cpi:CUUR0000SA0:2026-M06",
    feed_id: "bls.us-cpi",
    materiality: "medium",
    title: "CUUR0000SA0 June",
    summary: "Value 321.5",
    source_url: "https://www.bls.gov/cpi/",
    payload: {
      series_id: "CUUR0000SA0",
      year: "2026",
      period: "M06",
      value: "321.5",
    },
  }), { situations, now: NOW });

  assert.equal(bls.route, "inbox");
  assert.equal(bls.notify, false, "ordinary official releases must not notify below high materiality");
  assert.deepEqual(
    bls.matched_context.map(({ kind, id }) => ({ kind, id })),
    [{ kind: "situation", id: "situation-us-inflation-fed" }],
  );
  assert.ok(bls.matched_context[0].terms.includes("feed:bls.us-cpi"));
  assert.ok(bls.matched_context[0].terms.includes("series:cuur0000sa0"));
});

test("short ASCII keywords use token boundaries and AI does not match maintain", () => {
  const situations = seededSituations();
  const falsePositive = routeObservation(observation({
    external_event_id: "fixture:maintenance",
    title: "Maintenance window",
    summary: "Operators maintain reliable infrastructure during a routine window.",
  }), { situations, now: NOW });

  assert.equal(falsePositive.route, "quiet_inbox");
  assert.equal(
    falsePositive.matched_context.some(
      (match) => match.id === "situation-ai-infrastructure-cycle",
    ),
    false,
  );

  const realAi = routeObservation(observation({
    external_event_id: "fixture:ai-infrastructure",
    title: "AI infrastructure investment",
    summary: "Cloud capex and data center demand changed materially.",
  }), { situations, now: NOW });
  assert.ok(
    realAi.matched_context.some(
      (match) => match.id === "situation-ai-infrastructure-cycle",
    ),
  );
});

test("watch matches retain the parent Situation identity and do not double-score it", () => {
  const situation = {
    entity_id: "situation-supply-chain",
    payload: {
      status: "watch",
      keywords: ["supply chain disruption"],
      watch_conditions: ["Supply chain disruption reaches the decision threshold."],
    },
  };
  const routed = routeObservation(observation({
    external_event_id: "fixture:supply-chain",
    materiality: "high",
    title: "Supply chain disruption reaches decision threshold",
    summary: "A monitored disruption has become material.",
  }), {
    situations: [{ id: situation.entity_id, ...situation.payload }],
    watchConditions: watchContext([situation]),
    now: NOW,
  });

  assert.equal(routed.notify, true);
  assert.equal(routed.relevance_score, 4, "Situation and its watches must count as one anchor");
  assert.deepEqual(
    routed.matched_context.map(({ kind, id }) => ({ kind, id })),
    [{ kind: "situation", id: "situation-supply-chain" }],
  );
});
