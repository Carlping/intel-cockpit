import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createIntelRuntime,
  forgetCanonicalTelegramData,
  isExplicitUserInputForRouting,
} from "../server/runtime.mjs";

test("recent-input routing only learns from explicit user activity", () => {
  const entity = (payload) => ({ payload });
  assert.equal(isExplicitUserInputForRouting(entity({ source_type: "telegram", status: "new" })), true);
  assert.equal(isExplicitUserInputForRouting(entity({ source_type: "manual_snapshot", status: "new" })), true);
  assert.equal(isExplicitUserInputForRouting(entity({ source_type: "wiki_read_only", status: "new" })), false);
  assert.equal(isExplicitUserInputForRouting(entity({ source_type: "official_feed", status: "new" })), false);
  assert.equal(isExplicitUserInputForRouting(entity({
    source_type: "official_feed",
    status: "watch",
    triage: { actor: "user", decision: "watch" },
  })), true);
  assert.equal(isExplicitUserInputForRouting(entity({ source_type: "telegram", status: "not_relevant" })), false);
});

async function withRuntime(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "intel-os-runtime-"));
  const vaultRoot = path.join(root, "vault");
  const paths = {
    vaultRoot,
    wikiRoot: path.join(vaultRoot, "wiki"),
    intelRoot: path.join(vaultRoot, "codex-intelligence", "live"),
    runtimeRoot: path.join(root, "local-runtime"),
    excludedSegments: ["private"],
  };
  await mkdir(paths.wikiRoot, { recursive: true });
  const runtime = await createIntelRuntime({
    paths,
    startCollectors: false,
    fetchImpl: async () => {
      throw new Error("runtime integration test must not use the network");
    },
    clock: () => new Date("2026-07-29T11:30:00.000Z"),
  });
  try {
    await run(runtime);
  } finally {
    runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function api(runtime, pathname, init = {}) {
  return runtime.api.fetch(new Request(`http://127.0.0.1${pathname}`, init));
}

test("Telegram group monitor setup is preview-first and Signals API starts quiet", async () => {
  await withRuntime(async (runtime) => {
    const groups = await api(runtime, "/api/v1/connectors/telegram/groups");
    assert.equal(groups.status, 200);
    assert.deepEqual((await groups.json()).data, []);

    const preview = await api(runtime, "/api/v1/connectors/telegram/groups/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "monitor" }),
    });
    assert.equal(preview.status, 200);
    const previewBody = (await preview.json()).data;
    assert.match(previewBody.preview_id, /^tg-group-/);
    assert.match(previewBody.code, /^[a-f0-9]{10}$/);
    assert.equal(previewBody.diff.some((item) => item.path === "telegram.group_sensor.retention"), true);

    const commit = await api(runtime, "/api/v1/connectors/telegram/groups/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preview_id: previewBody.preview_id }),
    });
    assert.equal(commit.status, 200);
    assert.equal((await commit.json()).data.monitor_code, previewBody.code);

    const signals = await api(runtime, "/api/v1/signals");
    assert.equal(signals.status, 200);
    assert.deepEqual((await signals.json()).data, []);
  });
});

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

function situationPayload(overrides = {}) {
  return {
    title: "Situation fixture",
    status: "watch",
    domain: "test",
    current_assessment: "Test-only assessment with no factual claim.",
    before: "Test-only prior state.",
    now: "Test-only current state.",
    watch_conditions: ["Review when the test fixture changes."],
    stop_condition: "Stop when this test ends.",
    reopen_condition: "Reopen for a later test fixture.",
    next_review_at: "2026-08-01T00:00:00.000Z",
    evidence: [],
    ...overrides,
  };
}

function missionPayload(overrides = {}) {
  return {
    title: "Mission fixture",
    objective: "Exercise the Mission persistence contract.",
    status: "active",
    domain: "test",
    why_now: "The test needs a complete, schema-valid Mission.",
    next_action: "Run the next test assertion.",
    done_condition: "The assertion passes.",
    review_date: "2026-08-01T00:00:00.000Z",
    stop_condition: "Stop when the test ends.",
    reopen_condition: "Reopen when this fixture is reused.",
    ...overrides,
  };
}

function reviewPayload(overrides = {}) {
  return {
    title: "Review fixture",
    mission_id: "mission-fixture",
    reviewed_at: "2026-07-29T12:00:00.000Z",
    outcome: "No external outcome is asserted by this fixture.",
    assessment_change: "No assessment change is asserted by this fixture.",
    next_state: "watch",
    ...overrides,
  };
}

async function textFiles(root) {
  const result = [];
  async function visit(target) {
    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) result.push(await readFile(child, "utf8"));
    }
  }
  await visit(root);
  return result;
}

function runtimePaths(root) {
  const vaultRoot = path.join(root, "vault");
  return {
    vaultRoot,
    wikiRoot: path.join(vaultRoot, "wiki"),
    intelRoot: path.join(vaultRoot, "codex-intelligence", "live"),
    runtimeRoot: path.join(root, "local-runtime"),
    excludedSegments: ["private"],
  };
}

function fedRss(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Federal Reserve test fixture</title>
      ${items.map((item) => `<item>
        <guid>${item.id}</guid>
        <title>${item.title}</title>
        <description>${item.summary}</description>
        <link>https://www.federalreserve.gov/test/${item.id}.htm</link>
        <pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>
      </item>`).join("\n")}
    </channel></rss>`;
}

test("integrated runtime starts quietly and exposes connector coverage", async () => {
  await withRuntime(async (runtime) => {
    const response = await api(runtime, "/api/v1/now");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.needs_you, []);
    assert.deepEqual(body.data.material_changes, []);
    assert.deepEqual(body.data.next_actions, []);
    assert.equal(body.data.mode, "live_local");
    assert.equal(Number.isFinite(Date.parse(body.data.as_of)), true);
    assert.equal(body.data.revision, 0);
    assert.equal(body.data.briefing.state, "quiet");
    assert.ok(body.data.connector_health.some((item) => item.feed_id === "telegram-explicit-submit"));
    assert.ok(body.data.connector_health.some((item) => item.feed_id === "truflation.us-inflation"));
    const storage = body.data.connector_health.find(
      (item) => item.feed_id === "operations.runtime-storage",
    );
    assert.equal(storage.scope, "runtime_metadata_only");
    assert.equal(Number.isSafeInteger(storage.runtime_bytes), true);
    assert.equal(storage.unsafe_entry_count, 0);
  });
});

test("daily maintenance backs up known state even when connector coverage is unknown", async () => {
  await withRuntime(async (runtime) => {
    await runtime.runDailyMaintenanceIfDue();
    const health = await runtime.connectors.getHealth();
    const operations = health.find((item) => item.feed_id === "operations.daily");
    assert.equal(operations.state, "degraded");
    assert.equal(operations.coverage_state, "partial");
    assert.ok(operations.last_success_at);
    assert.match(operations.message, /available evidence/);
    assert.equal(typeof operations.runtime_retention, "object");
    assert.equal(Number.isSafeInteger(operations.runtime_storage.runtime_bytes), true);
    assert.equal(typeof operations.runtime_storage.level, "string");
    const manifest = JSON.parse(
      await readFile(path.join(operations.backup_path, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.entity_count, 0);
  });
});

test("Decision Brief resolves Situation lineage to the original Inbox evidence", async () => {
  await withRuntime(async (runtime) => {
    await createEntity(runtime.store, "InboxItem", "inbox-source-lineage", {
      title: "Official source observation",
      status: "linked",
      source_type: "official_feed",
      source_url: "https://example.com/official-evidence",
      evidence_status: "unverified_external",
      summary: "A source observation used by the Situation.",
    });
    await createEntity(runtime.store, "InboxItem", "inbox-private-lineage", {
      title: "Private submitted observation",
      status: "linked",
      source_type: "telegram",
      source_url: "telegram://chat/123/message/456",
      evidence_status: "unverified_external",
      summary: "A private source observation used by the Situation.",
    });
    await createEntity(runtime.store, "Situation", "situation-source-lineage", situationPayload({
      title: "Situation with traceable evidence",
      status: "active",
      requires_decision: true,
      source_inbox_ids: ["inbox-source-lineage", "inbox-private-lineage"],
      evidence: [
        {
          kind: "unknown",
          text: "Awaiting verification.",
          source_inbox_id: "inbox-source-lineage",
          evidence_status: "unverified_external",
        },
        {
          kind: "unknown",
          text: "Private observation awaiting verification.",
          source_inbox_id: "inbox-private-lineage",
          source_url: "telegram://chat/123/message/456",
          evidence_status: "unverified_external",
        },
      ],
    }));

    const brief = await runtime.refreshBriefing();
    assert.equal(brief.state, "ready");
    assert.deepEqual(
      brief.sources.map((source) => source.href),
      [
        "https://example.com/official-evidence",
        "intel-os://entity/InboxItem/inbox-private-lineage?revision=1",
      ],
    );
    assert.equal(
      brief.sources.some((source) => source.href.includes("Situation/situation-source-lineage")),
      false,
    );
    assert.doesNotMatch(JSON.stringify(brief), /telegram:\/\/|chat\/123|message\/456/);
  });
});

test("Truflation stays manual-only and reaches canonical Inbox only after commit", async () => {
  await withRuntime(async (runtime) => {
    const previewResponse = await api(runtime, "/api/v1/connectors/truflation/manual-observation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_revision: 0,
        confirmed_by_user: true,
        observation_date: "2026-07-29",
        value: 2.43,
        unit: "percent_yoy",
      }),
    });
    const previewBody = await previewResponse.json();
    assert.equal(previewResponse.status, 200, JSON.stringify(previewBody));
    const preview = previewBody.data;
    assert.equal(preview.entity.payload.evidence_status, "unverified_external");

    let inboxResponse = await api(runtime, "/api/v1/inbox");
    assert.deepEqual((await inboxResponse.json()).data, []);

    const commitResponse = await api(runtime, "/api/v1/commands/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preview_id: preview.preview_id }),
    });
    assert.equal(commitResponse.status, 200);

    inboxResponse = await api(runtime, "/api/v1/inbox");
    const inbox = (await inboxResponse.json()).data;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].payload.source_type, "manual_snapshot");
    assert.equal(inbox[0].payload.observation.payload.value, 2.43);

    const duplicateResponse = await api(runtime, "/api/v1/connectors/truflation/manual-observation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_revision: 0,
        confirmed_by_user: true,
        observation_date: "2026-07-29",
        value: 2.43,
        unit: "percent_yoy",
      }),
    });
    assert.equal((await duplicateResponse.json()).data.no_op, true);

    const changedResponse = await api(runtime, "/api/v1/connectors/truflation/manual-observation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_revision: 0,
        confirmed_by_user: true,
        observation_date: "2026-07-29",
        value: 2.51,
        unit: "percent_yoy",
      }),
    });
    const changed = (await changedResponse.json()).data;
    assert.equal(changed.no_op, undefined);
    assert.ok(changed.diff.some((entry) => entry.path === "/snapshot/value"));
    await api(runtime, "/api/v1/commands/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preview_id: changed.preview_id }),
    });
    const updated = await runtime.store.get("InboxItem", "inbox-truflation-us-2026-07-29");
    assert.equal(updated.revision, 2);
    assert.equal(updated.payload.snapshot.value, 2.51);
    assert.equal(updated.payload.observation.payload.value, 2.51);
  });
});

test("Telegram forget removes canonical content, recovery copies, and invalidates dependencies", async () => {
  await withRuntime(async (runtime) => {
    const privateMarker = "private-source-marker";
    const inbox = await createEntity(runtime.store, "InboxItem", "inbox-telegram-secret", {
      title: "Telegram submission",
      status: "new",
      source_type: "telegram",
      summary: privateMarker,
      source_payload: {
        chat_id: "10",
        sender_id: "20",
        message_id: "30",
        text: `original ${privateMarker} Telegram submission`,
      },
    });
    const update = await runtime.store.preview({
      operation: "update",
      entity_type: "InboxItem",
      entity_id: inbox.entity_id,
      base_revision: inbox.revision,
      payload: { status: "triaged" },
    });
    await runtime.store.commit(update.preview_id);
    await createEntity(runtime.store, "Situation", "situation-private-source", situationPayload({
      title: "Dependent situation",
      status: "watch",
      source_inbox_id: inbox.entity_id,
    }));
    await createEntity(runtime.store, "Mission", "mission-private-source", missionPayload({
      title: "Dependent mission",
      objective: "Do not retain source-derived work",
      status: "active",
      situation_id: "situation-private-source",
    }));
    await createEntity(runtime.store, "Mission", "mission-mixed-sources", missionPayload({
      title: "Mixed-source mission",
      objective: `Retain independent work, but remove ${privateMarker}`,
      status: "active",
      source_inbox_ids: [inbox.entity_id, "inbox-independent-source"],
      evidence: [
        {
          source_inbox_id: inbox.entity_id,
          text: `withdrawn evidence ${privateMarker}`,
        },
        {
          source_inbox_id: "inbox-independent-source",
          text: "independent evidence remains",
        },
      ],
      timeline: [
        {
          source_inbox_id: inbox.entity_id,
          detail: `withdrawn timeline ${privateMarker}`,
        },
        {
          source_inbox_id: "inbox-independent-source",
          detail: "independent timeline remains",
        },
      ],
    }));
    await createEntity(runtime.store, "Review", "review-private-source", reviewPayload({
      title: "Dependent review",
      mission_id: "mission-private-source",
    }));
    await createEntity(runtime.store, "Review", "review-mixed-sources", reviewPayload({
      title: "Mixed-source review",
      mission_id: "mission-mixed-sources",
      outcome: `Mixed result copied from ${privateMarker}`,
    }));

    const result = await forgetCanonicalTelegramData(runtime.store, {
      chatId: "10",
      userId: "20",
      messageId: "30",
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
    });
    assert.equal(result.removed, 1);
    assert.equal(result.invalidated, 3);
    assert.equal(result.partially_invalidated, 2);
    assert.deepEqual(await runtime.store.list("InboxItem"), []);
    assert.equal((await runtime.store.get("Situation", "situation-private-source")).payload.source_invalidated, true);
    assert.equal((await runtime.store.get("Mission", "mission-private-source")).payload.status, "cancelled");
    const mixedMission = await runtime.store.get("Mission", "mission-mixed-sources");
    assert.equal(mixedMission.payload.status, "blocked");
    assert.equal(mixedMission.payload.source_invalidated, "partial");
    assert.deepEqual(mixedMission.payload.source_inbox_ids, ["inbox-independent-source"]);
    assert.deepEqual(
      mixedMission.payload.evidence.map((item) => item.source_inbox_id),
      ["inbox-independent-source"],
    );
    assert.deepEqual(
      mixedMission.payload.timeline.map((item) => item.source_inbox_id),
      ["inbox-independent-source"],
    );
    assert.doesNotMatch(JSON.stringify(mixedMission), new RegExp(privateMarker));
    assert.equal(mixedMission.payload.invalidated_sources[0].source_entity_id, inbox.entity_id);
    assert.equal(mixedMission.payload.invalidated_sources[0].content_redacted, true);
    assert.equal((await runtime.store.get("Review", "review-private-source")).payload.source_invalidated, true);
    const mixedReview = await runtime.store.get("Review", "review-mixed-sources");
    assert.equal(mixedReview.payload.source_invalidated, "partial");
    assert.doesNotMatch(JSON.stringify(mixedReview), new RegExp(privateMarker));
    const canonical = await textFiles(runtime.paths.intelRoot);
    assert.ok(canonical.every((content) => !content.includes(privateMarker)));
    const artifacts = await textFiles(runtime.paths.runtimeRoot);
    assert.ok(artifacts.every((content) => !content.includes(privateMarker)));
  });
});

test("official feed persists its first-poll baseline and only commits novel observations after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "intel-os-official-restart-"));
  const paths = runtimePaths(root);
  await mkdir(paths.wikiRoot, { recursive: true });
  const baselineItems = [
    {
      id: "legacy-one",
      title: "Fed legacy release one",
      summary: "Existing Federal Reserve backlog item.",
      publishedAt: "2026-07-27T14:00:00.000Z",
    },
    {
      id: "legacy-two",
      title: "Fed legacy release two",
      summary: "Newest existing Federal Reserve backlog item.",
      publishedAt: "2026-07-28T14:00:00.000Z",
    },
  ];
  let upstreamItems = baselineItems;
  const fetchImpl = async (url) => {
    assert.equal(String(url), "https://www.federalreserve.gov/feeds/press_monetary.xml");
    return new Response(fedRss(upstreamItems), {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    });
  };

  let firstRuntime;
  let secondRuntime;
  try {
    firstRuntime = await createIntelRuntime({
      paths,
      startCollectors: false,
      fetchImpl,
      clock: () => new Date("2026-07-29T11:30:00.000Z"),
    });
    const baseline = await firstRuntime.pollFeed("fed.monetary-policy");
    assert.equal(baseline.baseline_established, true);
    const baselineInbox = await firstRuntime.store.list("InboxItem");
    assert.deepEqual(baselineInbox, [], "an automated baseline is checkpoint state, not decision content");

    const baselineState = JSON.parse(await readFile(
      path.join(paths.runtimeRoot, "state", "official-feed-baselines.json"),
      "utf8",
    ));
    assert.equal(baselineState.feeds["fed.monetary-policy"].seen_keys.length, 2);
    firstRuntime.stop();
    firstRuntime = null;

    upstreamItems = [
      ...baselineItems,
      {
        id: "new-after-restart",
        title: "Fed new release after restart",
        summary: "A genuinely new Federal Reserve observation.",
        publishedAt: "2026-07-30T14:00:00.000Z",
      },
      {
        id: "quiet-after-restart",
        title: "Administrative archive format notice",
        summary: "Routine catalog metadata with no active decision context.",
        publishedAt: "2026-07-30T14:30:00.000Z",
      },
    ];
    secondRuntime = await createIntelRuntime({
      paths,
      startCollectors: false,
      fetchImpl,
      clock: () => new Date("2026-07-30T15:00:00.000Z"),
    });
    const afterRestart = await secondRuntime.pollFeed("fed.monetary-policy");
    assert.equal(afterRestart.baseline_established, undefined);
    let inbox = await secondRuntime.store.list("InboxItem");
    assert.equal(inbox.length, 1);
    assert.equal(
      inbox.filter((item) => item.payload.external_event_id === "fed.monetary-policy:new-after-restart").length,
      1,
    );
    assert.equal(
      inbox.some((item) => item.payload.external_event_id === "fed.monetary-policy:legacy-one"),
      false,
      "an older backlog item must not be replayed after restart",
    );
    const quietItem = inbox.find(
      (item) => item.payload.external_event_id === "fed.monetary-policy:quiet-after-restart",
    );
    assert.equal(quietItem, undefined, "quiet automated observations must not become canonical cards");

    await secondRuntime.pollFeed("fed.monetary-policy");
    inbox = await secondRuntime.store.list("InboxItem");
    assert.equal(inbox.length, 1, "the same external_event_id + content_hash must be idempotent");
  } finally {
    firstRuntime?.stop();
    secondRuntime?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Wiki reconcile keeps file churn in Coverage and surfaces one decision-grade ingest digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "intel-os-wiki-restart-"));
  const paths = runtimePaths(root);
  const notePath = path.join(paths.wikiRoot, "research", "cycle.md");
  const digestPath = path.join(paths.wikiRoot, "digests", "2026-07-30.md");
  const privatePath = path.join(paths.wikiRoot, "private", "private.md");
  await mkdir(path.dirname(notePath), { recursive: true });
  await mkdir(path.dirname(privatePath), { recursive: true });
  await writeFile(notePath, "# Cycle\n\nInitial ingested note.\n", "utf8");
  await writeFile(privatePath, "PROHIBITED_PRIVATE_MARKER", "utf8");

  function rejectPrivate(target) {
    const normalized = path.resolve(String(target)).toLocaleLowerCase("en-US");
    const prohibited = `${path.sep}private${path.sep}`.toLocaleLowerCase("en-US");
    assert.equal(normalized.includes(prohibited), false, `runtime attempted to read ${target}`);
  }
  const guardedWikiFs = {
    async lstat(target) {
      rejectPrivate(target);
      return lstat(target);
    },
    async readdir(target, options) {
      rejectPrivate(target);
      return readdir(target, options);
    },
    async readFile(target, options) {
      rejectPrivate(target);
      return readFile(target, options);
    },
    async realpath(target) {
      rejectPrivate(target);
      return realpath(target);
    },
  };
  const noNetwork = async () => {
    throw new Error("Wiki restart test must not use the network");
  };

  let firstRuntime;
  let secondRuntime;
  try {
    firstRuntime = await createIntelRuntime({
      paths,
      startCollectors: false,
      fetchImpl: noNetwork,
      wikiFsImpl: guardedWikiFs,
      clock: () => new Date("2026-07-29T11:30:00.000Z"),
    });
    const firstReconcile = await firstRuntime.reconcileWiki();
    assert.ok(firstReconcile);
    assert.deepEqual(
      firstReconcile.allowlist_index.map((entry) => entry.relative_path),
      ["research/cycle.md"],
    );
    assert.deepEqual(await firstRuntime.store.list("InboxItem"), []);
    firstRuntime.stop();
    firstRuntime = null;

    await writeFile(notePath, "# Cycle\n\nOffline edit while IntelOS was stopped.\n", "utf8");
    await mkdir(path.dirname(digestPath), { recursive: true });
    await writeFile(
      digestPath,
      "# 2026-07-30 Digest\n\n**今天知識庫變聰明的一點**：利率與流動性已成為跨資產風險的主要解釋變數，不能再只用個股基本面判斷，而且風險傳導已同時出現在債券、美元與成長板塊。\n\n## ⭐ 關注清單命中\n\n- **Fed／CPI** — 命中既有總經 Situation，下一步等待官方數字與市場反應交叉驗證。\n\n**限制**：這是知識整理摘要，尚未證明目前路徑已改變。\n",
      "utf8",
    );
    secondRuntime = await createIntelRuntime({
      paths,
      startCollectors: false,
      fetchImpl: noNetwork,
      wikiFsImpl: guardedWikiFs,
      clock: () => new Date("2026-07-30T11:30:00.000Z"),
    });
    const restartReconcile = await secondRuntime.reconcileWiki();
    assert.ok(restartReconcile);
    const inbox = await secondRuntime.store.list("InboxItem");
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].payload.source_type, "wiki_read_only");
    assert.equal(inbox[0].payload.evidence_status, "verified");
    assert.equal(inbox[0].payload.source_payload.change_type, "added");
    assert.equal(inbox[0].payload.source_payload.source_integrity_status, "hash_verified");
    assert.equal(inbox[0].payload.source_payload.ingest_verification_required, false);
    assert.equal(inbox[0].payload.source_payload.s0_s8_state, "completed");
    assert.equal(inbox[0].payload.source_payload.decision_grade, true);
    assert.equal(inbox[0].payload.source_payload.source_excerpt_included, true);
    assert.equal(inbox[0].payload.source_payload.source_content_included, false);
    assert.match(inbox[0].payload.summary, /利率與流動性/);
    assert.match(inbox[0].payload.source_payload.why_relevant, /Fed／CPI/);
    assert.equal(inbox[0].payload.untrusted_external_content, true);
    const sourceUri = new URL(inbox[0].payload.source_url);
    assert.equal(sourceUri.protocol, "obsidian:");
    assert.equal(sourceUri.searchParams.get("vault"), path.basename(paths.vaultRoot));
    assert.equal(sourceUri.searchParams.get("file"), "wiki/digests/2026-07-30.md");
    assert.equal(
      JSON.stringify(restartReconcile.allowlist_index).includes("private"),
      false,
    );
    assert.equal(
      (await textFiles(paths.runtimeRoot)).some((content) => content.includes("PROHIBITED_PRIVATE_MARKER")),
      false,
    );
  } finally {
    firstRuntime?.stop();
    secondRuntime?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
