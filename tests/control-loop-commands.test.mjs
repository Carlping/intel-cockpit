import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { previewTypedCommand } from "../server/api/command-service.mjs";
import { ValidationError, createIntelligenceStore } from "../server/store/index.mjs";

const FIXED_NOW = new Date("2026-07-30T12:00:00.000Z");

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "intel-control-loop-"));
  const vaultRoot = path.join(base, "vault");
  const wikiRoot = path.join(vaultRoot, "wiki");
  const intelRoot = path.join(vaultRoot, "intelligence", "live");
  const runtimeRoot = path.join(base, "runtime");
  await mkdir(wikiRoot, { recursive: true });
  const store = await createIntelligenceStore({ vaultRoot, wikiRoot, intelRoot, runtimeRoot });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { store };
}

async function createEntity(store, entityType, entityId, payload) {
  const preview = await store.preview({
    operation: "create",
    entity_type: entityType,
    entity_id: entityId,
    base_revision: 0,
    payload,
  });
  return store.commit(preview.preview_id);
}

function missionPayload(overrides = {}) {
  return {
    title: "Control-loop Mission",
    objective: "Preserve the user-owned objective.",
    status: "active",
    domain: "test",
    why_now: "The control-loop contract needs a bounded fixture.",
    next_action: "Keep the original action.",
    done_condition: "The contract tests pass.",
    review_date: "2026-08-01T00:00:00.000Z",
    stop_condition: "Stop when the test ends.",
    reopen_condition: "Reopen for a regression.",
    requires_decision: false,
    ...overrides,
  };
}

function situationPayload(overrides = {}) {
  return {
    title: "Control-loop Situation",
    status: "active",
    domain: "test",
    current_assessment: "Original assessment.",
    before: "Original before.",
    now: "Original now.",
    watch_conditions: ["Watch the fixture."],
    stop_condition: "Stop when the test ends.",
    reopen_condition: "Reopen for a regression.",
    next_review_at: "2026-08-01T00:00:00.000Z",
    evidence: [],
    requires_decision: false,
    ...overrides,
  };
}

function command(store, body, options = {}) {
  return previewTypedCommand({
    store,
    body,
    clock: () => FIXED_NOW,
    excludedSegments: ["private"],
    ...options,
  });
}

async function batchPreview(store, operations) {
  const previews = [];
  for (const operation of operations) previews.push(await store.preview(operation));
  return {
    preview_ids: previews.map((preview) => preview.preview_id),
    operation_count: previews.length,
    diff: previews.flatMap((preview) => preview.diff),
  };
}

test("Mission adjustment acceptance only applies the authoritative active/blocked draft", async (t) => {
  const { store } = await fixture(t);
  await createEntity(store, "Mission", "mission-accept", missionPayload());

  const proposed = await command(store, {
    command: "mission.propose_adjustment",
    data: {
      mission_id: "mission-accept",
      base_revision: 1,
      rationale: "New evidence changes the next step.",
      next_action: "Run the bounded follow-up.",
      review_date: "2026-08-03T00:00:00.000Z",
      proposed_status: "blocked",
    },
  });
  await store.commit(proposed.preview_id);

  await assert.rejects(
    command(store, {
      command: "mission.accept_adjustment",
      data: { mission_id: "mission-accept", base_revision: 2 },
    }),
    ValidationError,
  );
  await assert.rejects(
    command(store, {
      command: "mission.accept_adjustment",
      user_confirmation: true,
      data: {
        mission_id: "mission-accept",
        base_revision: 2,
        objective: "An injected objective must never be accepted.",
      },
    }),
    /cannot override objective/,
  );

  const accepted = await command(store, {
    command: "mission.accept_adjustment",
    user_confirmation: true,
    data: { mission_id: "mission-accept", base_revision: 2 },
  });
  assert.equal(accepted.entity.payload.objective, "Preserve the user-owned objective.");
  assert.equal(accepted.entity.payload.next_action, "Run the bounded follow-up.");
  assert.equal(accepted.entity.payload.review_date, "2026-08-03T00:00:00.000Z");
  assert.equal(accepted.entity.payload.status, "blocked");
  assert.equal(accepted.entity.payload.adjustment_draft, undefined);
  assert.equal(accepted.entity.payload.requires_decision, false);
  assert.equal(accepted.entity.payload.adjustment_history.at(-1).decision, "accepted");
  await store.commit(accepted.preview_id);

  await assert.rejects(
    command(store, {
      command: "mission.accept_adjustment",
      user_confirmation: true,
      data: { mission_id: "mission-accept", base_revision: 3 },
    }),
    /no pending adjustment draft/,
  );
  await assert.rejects(
    command(store, {
      command: "mission.propose_adjustment",
      data: {
        mission_id: "mission-accept",
        base_revision: 3,
        rationale: "Invalid terminal-state proposal.",
        next_action: "Do not apply.",
        review_date: "2026-08-04T00:00:00.000Z",
        proposed_status: "completed",
      },
    }),
    /active or blocked/,
  );
});

test("Mission adjustment dismissal clears the draft without changing objective, action, or status", async (t) => {
  const { store } = await fixture(t);
  const original = missionPayload();
  await createEntity(store, "Mission", "mission-dismiss", original);
  const proposed = await command(store, {
    command: "mission.propose_adjustment",
    data: {
      mission_id: "mission-dismiss",
      base_revision: 1,
      rationale: "A proposal the user will dismiss.",
      next_action: "Proposed replacement action.",
      review_date: "2026-08-05T00:00:00.000Z",
      proposed_status: "blocked",
    },
  });
  await store.commit(proposed.preview_id);

  const dismissed = await command(store, {
    command: "mission.dismiss_adjustment",
    user_confirmation: true,
    data: { mission_id: "mission-dismiss", base_revision: 2 },
  });
  assert.equal(dismissed.entity.payload.objective, original.objective);
  assert.equal(dismissed.entity.payload.next_action, original.next_action);
  assert.equal(dismissed.entity.payload.review_date, original.review_date);
  assert.equal(dismissed.entity.payload.status, original.status);
  assert.equal(dismissed.entity.payload.adjustment_draft, undefined);
  assert.equal(dismissed.entity.payload.adjustment_history.at(-1).decision, "dismissed");
  await store.commit(dismissed.preview_id);

  await assert.rejects(
    command(store, {
      command: "mission.dismiss_adjustment",
      user_confirmation: true,
      data: { mission_id: "mission-dismiss", base_revision: 3 },
    }),
    /no pending adjustment draft/,
  );
});

test("Mission action results draft a linked Situation change and material changes can be acknowledged", async (t) => {
  const { store } = await fixture(t);
  await createEntity(store, "Situation", "situation-result-loop", situationPayload());
  await createEntity(store, "Mission", "mission-result-loop", missionPayload({
    situation_id: "situation-result-loop",
  }));

  const resultPreview = await command(store, {
    command: "mission.record_result",
    user_confirmation: true,
    data: {
      mission_id: "mission-result-loop",
      base_revision: 1,
      result_state: "changed",
      result: "The observed result differs from the original assessment.",
      next_action: "Verify the result with one independent source.",
      review_date: "2026-08-02T00:00:00.000Z",
    },
  }, { previewBatch: (operations) => batchPreview(store, operations) });
  assert.equal(resultPreview.preview_ids.length, 2);
  await store.commitBatch(resultPreview.preview_ids);

  const mission = await store.get("Mission", "mission-result-loop");
  const draftedSituation = await store.get("Situation", "situation-result-loop");
  assert.equal(mission.payload.objective, "Preserve the user-owned objective.");
  assert.equal(mission.payload.next_action, "Verify the result with one independent source.");
  assert.equal(draftedSituation.payload.requires_decision, true);
  assert.equal(draftedSituation.payload.adjustment_draft.before, "Original assessment.");
  assert.equal(
    draftedSituation.payload.adjustment_draft.now,
    "The observed result differs from the original assessment.",
  );
  assert.deepEqual(draftedSituation.payload.adjustment_draft.source, {
    entity_type: "Mission",
    entity_id: "mission-result-loop",
    result_state: "changed",
    recorded_at: FIXED_NOW.toISOString(),
  });

  const accepted = await command(store, {
    command: "situation.accept_adjustment",
    user_confirmation: true,
    data: { situation_id: "situation-result-loop", base_revision: 2 },
  });
  await store.commit(accepted.preview_id);
  assert.equal(accepted.entity.payload.material_change, true);
  assert.deepEqual(accepted.entity.payload.last_material_change.source, {
    entity_type: "Mission",
    entity_id: "mission-result-loop",
  });

  await assert.rejects(
    command(store, {
      command: "situation.acknowledge_material_change",
      data: { situation_id: "situation-result-loop", base_revision: 3 },
    }),
    /explicit interactive user confirmation/,
  );
  const acknowledged = await command(store, {
    command: "situation.acknowledge_material_change",
    user_confirmation: true,
    data: { situation_id: "situation-result-loop", base_revision: 3 },
  });
  assert.equal(acknowledged.entity.payload.material_change, false);
  assert.equal(acknowledged.entity.payload.material_change_history.at(-1).decision, "acknowledged");
  await store.commit(acknowledged.preview_id);
  await assert.rejects(
    command(store, {
      command: "situation.acknowledge_material_change",
      user_confirmation: true,
      data: { situation_id: "situation-result-loop", base_revision: 4 },
    }),
    /no accepted material change/,
  );
});

test("Situation adjustment decisions require a draft and distinguish accept from explicit edit", async (t) => {
  const { store } = await fixture(t);
  await createEntity(store, "Situation", "situation-edit", situationPayload());
  await assert.rejects(
    command(store, {
      command: "situation.accept_adjustment",
      user_confirmation: true,
      data: { situation_id: "situation-edit", base_revision: 1 },
    }),
    /no pending adjustment draft/,
  );

  const proposed = await command(store, {
    command: "situation.propose_adjustment",
    data: {
      situation_id: "situation-edit",
      base_revision: 1,
      before: "Draft before.",
      now: "Draft now.",
      impact: "Draft impact.",
    },
  });
  await store.commit(proposed.preview_id);

  await assert.rejects(
    command(store, {
      command: "situation.accept_adjustment",
      user_confirmation: true,
      data: {
        situation_id: "situation-edit",
        base_revision: 2,
        before: "Draft before.",
        now: "Injected now.",
        impact: "Draft impact.",
      },
    }),
    /does not match the authoritative adjustment draft/,
  );

  const edited = await command(store, {
    command: "situation.accept_adjustment",
    user_confirmation: true,
    data: {
      situation_id: "situation-edit",
      base_revision: 2,
      decision_mode: "edit",
      edit_reason: "The user corrected the wording before acceptance.",
      before: "Edited before.",
      now: "Edited now.",
      impact: "Edited impact.",
      material_change: true,
    },
  });
  assert.equal(edited.entity.payload.current_assessment, "Edited now.");
  assert.equal(edited.entity.payload.adjustment_history.at(-1).decision_mode, "edit");
  assert.equal(edited.entity.payload.adjustment_history.at(-1).proposal.now, "Draft now.");
  assert.equal(edited.entity.payload.adjustment_draft, undefined);
  await store.commit(edited.preview_id);

  await assert.rejects(
    command(store, {
      command: "situation.dismiss_adjustment",
      user_confirmation: true,
      data: { situation_id: "situation-edit", base_revision: 3 },
    }),
    /no pending adjustment draft/,
  );
});

test("Situation dismissal preserves the current assessment and status", async (t) => {
  const { store } = await fixture(t);
  const original = situationPayload();
  await createEntity(store, "Situation", "situation-dismiss", original);
  const proposed = await command(store, {
    command: "situation.propose_adjustment",
    data: {
      situation_id: "situation-dismiss",
      base_revision: 1,
      before: "Proposed before.",
      now: "Proposed now.",
      impact: "Proposed impact.",
    },
  });
  await store.commit(proposed.preview_id);
  const dismissed = await command(store, {
    command: "situation.dismiss_adjustment",
    user_confirmation: true,
    data: { situation_id: "situation-dismiss", base_revision: 2 },
  });
  assert.equal(dismissed.entity.payload.status, original.status);
  assert.equal(dismissed.entity.payload.current_assessment, original.current_assessment);
  assert.equal(dismissed.entity.payload.adjustment_draft, undefined);
  assert.equal(dismissed.entity.payload.adjustment_history.at(-1).decision, "dismissed");
});

test("Situation acceptance can consume only a related authoritative Inbox adjustment draft", async (t) => {
  const { store } = await fixture(t);
  await createEntity(store, "Situation", "situation-feed-target", situationPayload());
  await createEntity(store, "InboxItem", "inbox-unrelated", {
    title: "Unrelated feed proposal",
    status: "new",
    evidence_status: "official_proxy",
    matched_context: [{ kind: "situation", id: "another-situation" }],
    adjustment_draft: {
      state: "awaiting_user_review",
      before: "Unrelated before.",
      now: "Unrelated now.",
      impact: "Unrelated impact.",
    },
    requires_decision: true,
  });
  await assert.rejects(
    command(store, {
      command: "situation.accept_adjustment",
      user_confirmation: true,
      data: {
        situation_id: "situation-feed-target",
        base_revision: 1,
        inbox_id: "inbox-unrelated",
        inbox_base_revision: 1,
      },
    }, { previewBatch: (operations) => batchPreview(store, operations) }),
    /does not target the requested Situation/,
  );

  await createEntity(store, "InboxItem", "inbox-feed-proposal", {
    title: "Related official-feed proposal",
    status: "new",
    evidence_status: "official_proxy",
    source_url: "https://www.bls.gov/cpi/",
    as_of: "2026-06-01T00:00:00.000Z",
    source_payload: {
      series_id: "CUUR0000SA0",
      value: "321.5",
      unit: "index_1982_1984_100",
    },
    matched_context: [{ kind: "situation", id: "situation-feed-target" }],
    matched_interest_ids: ["situation-feed-target"],
    adjustment_draft: {
      state: "awaiting_user_review",
      before: "Authoritative feed before.",
      now: "Authoritative feed now.",
      impact: "Authoritative feed impact.",
    },
    requires_decision: true,
  });
  const sharedData = {
    situation_id: "situation-feed-target",
    base_revision: 1,
    inbox_id: "inbox-feed-proposal",
    inbox_base_revision: 1,
  };
  await assert.rejects(
    command(store, {
      command: "situation.accept_adjustment",
      user_confirmation: true,
      data: { ...sharedData, now: "Client-injected now." },
    }, { previewBatch: (operations) => batchPreview(store, operations) }),
    /does not match the authoritative adjustment draft/,
  );

  const accepted = await command(store, {
    command: "situation.accept_adjustment",
    user_confirmation: true,
    data: sharedData,
  }, { previewBatch: (operations) => batchPreview(store, operations) });
  assert.equal(accepted.preview_ids.length, 2);
  await store.commitBatch(accepted.preview_ids);
  const situation = await store.get("Situation", "situation-feed-target");
  const inbox = await store.get("InboxItem", "inbox-feed-proposal");
  assert.equal(situation.payload.current_assessment, "Authoritative feed now.");
  assert.deepEqual(situation.payload.adjustment_history.at(-1).draft_source, {
    entity_type: "InboxItem",
    entity_id: "inbox-feed-proposal",
  });
  assert.equal(situation.payload.evidence.at(-1).kind, "unknown");
  assert.equal(situation.payload.evidence.at(-1).source_url, "https://www.bls.gov/cpi/");
  assert.equal(situation.payload.timeline.at(-1).source_inbox_id, "inbox-feed-proposal");
  assert.deepEqual(situation.payload.indicator_series.at(-1), {
    series_id: "CUUR0000SA0",
    label: "Related official-feed proposal",
    value: 321.5,
    unit: "index_1982_1984_100",
    as_of: "2026-06-01T00:00:00.000Z",
    evidence_status: "official_proxy",
    source_url: "https://www.bls.gov/cpi/",
    source_inbox_id: "inbox-feed-proposal",
  });
  assert.equal(inbox.payload.status, "linked");
  assert.equal(inbox.payload.linked_situation_id, "situation-feed-target");
  assert.equal(inbox.payload.adjustment_draft, undefined);
  assert.equal(inbox.payload.requires_decision, false);
});

test("Swipe batch records interest and consolidates multiple links into one Situation revision", async (t) => {
  const { store } = await fixture(t);
  await createEntity(store, "Situation", "situation-swipe", situationPayload({ domain: "Macro" }));
  for (const [id, title] of [["swipe-fed", "Fed statement"], ["swipe-cpi", "CPI release"], ["swipe-noise", "Unrelated headline"]]) {
    await createEntity(store, "InboxItem", id, {
      title,
      summary: `${title} summary`,
      status: "new",
      evidence_status: "unverified_external",
      source_type: "rss",
    });
  }
  const body = {
    command: "inbox.swipe_batch",
    user_confirmation: true,
    data: {
      decisions: [
        {
          inbox_id: "swipe-fed",
          base_revision: 1,
          interested: true,
          situation_id: "situation-swipe",
          system_group: "Macro",
          classification_confidence: 91,
          classification_reason: "Existing macro context matches.",
        },
        {
          inbox_id: "swipe-cpi",
          base_revision: 1,
          interested: true,
          situation_id: "situation-swipe",
          system_group: "Macro",
          classification_confidence: 86,
          classification_reason: "Inflation keywords match.",
        },
        {
          inbox_id: "swipe-noise",
          base_revision: 1,
          interested: false,
          system_group: "World / General",
          classification_confidence: 54,
          classification_reason: "No matching active context.",
        },
      ],
    },
  };

  await assert.rejects(
    command(store, { ...body, user_confirmation: false }, { previewBatch: (operations) => batchPreview(store, operations) }),
    /explicit interactive user confirmation/,
  );
  const preview = await command(store, body, { previewBatch: (operations) => batchPreview(store, operations) });
  assert.equal(preview.operation_count, 4);
  await store.commitBatch(preview.preview_ids);

  const situation = await store.get("Situation", "situation-swipe");
  const fed = await store.get("InboxItem", "swipe-fed");
  const cpi = await store.get("InboxItem", "swipe-cpi");
  const noise = await store.get("InboxItem", "swipe-noise");
  assert.equal(situation.revision, 2);
  assert.deepEqual(situation.payload.source_inbox_ids, ["swipe-fed", "swipe-cpi"]);
  assert.equal(situation.payload.evidence.length, 2);
  assert.equal(fed.payload.status, "linked");
  assert.equal(cpi.payload.status, "linked");
  assert.equal(fed.payload.triage.decision, "interested");
  assert.equal(fed.payload.classification.classifier, "intel_os_alpha_rules_v1");
  assert.equal(noise.payload.status, "not_relevant");
  assert.equal(noise.payload.triage.decision, "not_interested");
});

test("Wiki ingest completion fails closed and only trusts the persisted-index verifier", async (t) => {
  const { store } = await fixture(t);
  const sourceUri = "obsidian://open?vault=Obsidian&file=wiki%2Fmacro%2Ffed.md";
  const sourceHash = "a".repeat(64);
  await createEntity(store, "InboxItem", "inbox-wiki-gate", {
    title: "Pending Wiki handoff",
    status: "wiki_ingest_pending",
    evidence_status: "unverified_external",
    source_type: "wiki_read_only",
    source_url: sourceUri,
    content_hash: sourceHash,
    s0_s8_handoff: { state: "pending" },
  });
  const body = {
    command: "inbox.complete_wiki_ingest",
    user_confirmation: true,
    data: {
      inbox_id: "inbox-wiki-gate",
      base_revision: 1,
      source_uri: sourceUri,
      source_hash: sourceHash,
    },
  };

  await assert.rejects(command(store, body), /persisted allowlist index/);
  await assert.rejects(
    command(store, body, { verifyWikiSource: async () => ({ verified: false }) }),
    /do not match the persisted allowlist index/,
  );

  let verifiedInput;
  const preview = await command(store, body, {
    verifyWikiSource: async (input) => {
      verifiedInput = input;
      return { verified: true };
    },
  });
  assert.deepEqual(verifiedInput, {
    source_uri: sourceUri,
    source_hash: sourceHash,
    inbox_id: "inbox-wiki-gate",
  });
  assert.equal(preview.entity.payload.evidence_status, "verified");
  assert.equal(preview.entity.payload.s0_s8_handoff.state, "completed");
  assert.equal(preview.entity.payload.status, "new");
  await store.commit(preview.preview_id);

  await createEntity(store, "Situation", "situation-wiki-known", situationPayload());
  const linked = await command(store, {
    command: "inbox.link_situation",
    user_confirmation: true,
    data: {
      inbox_id: "inbox-wiki-gate",
      base_revision: 2,
      situation_id: "situation-wiki-known",
    },
  }, { previewBatch: (operations) => batchPreview(store, operations) });
  await store.commitBatch(linked.preview_ids);
  const linkedSituation = await store.get("Situation", "situation-wiki-known");
  assert.equal(linkedSituation.payload.evidence.at(-1).kind, "known");
  assert.equal(linkedSituation.payload.evidence.at(-1).s0_s8_state, "completed");
  assert.equal(linkedSituation.payload.timeline.at(-1).status, "verified");

  await assert.rejects(
    command(store, {
      command: "inbox.send_to_wiki_ingest",
      user_confirmation: true,
      data: { inbox_id: "inbox-wiki-gate", base_revision: 3 },
    }),
    /Verified S0-S8 evidence cannot be sent through ingest again/,
  );

  let privateVerifierCalled = false;
  await createEntity(store, "InboxItem", "inbox-wiki-prohibited-path", {
    title: "Prohibited source gate fixture",
    status: "wiki_ingest_pending",
    evidence_status: "unverified_external",
    s0_s8_handoff: { state: "pending" },
  });
  await assert.rejects(
    command(store, {
      ...body,
      data: {
        ...body.data,
        inbox_id: "inbox-wiki-prohibited-path",
        base_revision: 1,
        source_uri: "obsidian://open?vault=IntelOS&file=wiki%2Fprivate%2Fprivate.md",
      },
    }, {
      verifyWikiSource: async () => {
        privateVerifierCalled = true;
        return true;
      },
    }),
    /permanently excluded subtree/,
  );
  assert.equal(privateVerifierCalled, false);
});
