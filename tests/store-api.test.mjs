import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApiHandler } from "../server/api/index.mjs";
import {
  ConflictError,
  CorruptionError,
  ValidationError,
  createIntelligenceStore,
} from "../server/store/index.mjs";

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "intel-os-store-"));
  const vaultRoot = path.join(base, "vault");
  const wikiRoot = path.join(vaultRoot, "wiki");
  const intelRoot = path.join(vaultRoot, "codex-intelligence", "live");
  const runtimeRoot = path.join(base, "runtime");
  const privateRoot = path.join(vaultRoot, "private");
  await Promise.all([
    mkdir(wikiRoot, { recursive: true }),
    mkdir(privateRoot, { recursive: true }),
  ]);
  const privateSentinel = path.join(privateRoot, "do-not-read.md");
  await writeFile(privateSentinel, "private sentinel\n", "utf8");
  const store = await createIntelligenceStore({
    vaultRoot,
    wikiRoot,
    intelRoot,
    runtimeRoot,
  });
  t.after(() => rm(base, { recursive: true, force: true }));
  return {
    base,
    vaultRoot,
    wikiRoot,
    intelRoot,
    runtimeRoot,
    excludedSegments: ["private"],
    privateSentinel,
    store,
  };
}

async function apiJson(api, pathname, { method = "GET", body } = {}) {
  const response = await api.fetch(
    new Request(`http://127.0.0.1${pathname}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return { response, json: await response.json() };
}

async function pathExists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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
    domain: "general",
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

test("preview and commit persist canonical Markdown without touching source vault", async (t) => {
  const context = await fixture(t);
  const beforeSentinel = await readFile(context.privateSentinel, "utf8");

  const preview = await context.store.preview({
    operation: "create",
    entity_type: "InboxItem",
    entity_id: "inbox-fed-policy",
    base_revision: 0,
    payload: {
      title: "Fed policy statement",
      status: "new",
      evidence_status: "unverified_external",
      source_type: "fed_rss",
    },
  });

  assert.equal(preview.base_revision, 0);
  assert.equal(preview.entity.revision, 1);
  assert.equal(preview.entity.entity_id, "inbox-fed-policy");
  assert.ok(preview.preview_id.length >= 32);
  assert.ok(preview.diff.some((change) => change.path === "/title"));

  const inboxDirectory = path.join(context.intelRoot, "inbox");
  assert.deepEqual(await readdir(inboxDirectory), [], "preview must not change canonical state");

  const committed = await context.store.commit(preview.preview_id);
  assert.equal(committed.content_sha256.length, 64);
  const markdown = await readFile(path.join(inboxDirectory, "inbox-fed-policy.md"), "utf8");
  assert.match(markdown, /^---\nintel_os_schema: 1/m);
  assert.match(markdown, /<!-- intel-os:canonical:start -->/);
  assert.match(markdown, /"evidence_status": "unverified_external"/);
  assert.equal(await readFile(context.privateSentinel, "utf8"), beforeSentinel);

  const recoveryRoots = await readdir(path.join(context.runtimeRoot, "recovery", "inbox"));
  assert.deepEqual(recoveryRoots, ["inbox-fed-policy"]);
  await assert.rejects(readFile(path.join(context.intelRoot, "recovery", "anything")));
});

test("logical ids reject traversal and roots cannot overlap source Wiki", async (t) => {
  const context = await fixture(t);
  const wikiMarker = path.join(context.wikiRoot, "boundary-marker.md");
  await writeFile(wikiMarker, "source marker remains unchanged\n", "utf8");
  const wikiMarkerBefore = await readFile(wikiMarker, "utf8");
  for (const entityId of ["../wiki-note", "private/private", "..", "A Valid ID", ".hidden"]) {
    await assert.rejects(
      context.store.preview({
        operation: "create",
        entity_type: "InboxItem",
        entity_id: entityId,
        base_revision: 0,
        payload: { title: "Unsafe" },
      }),
      ValidationError,
    );
  }

  await assert.rejects(
    createIntelligenceStore({
      wikiRoot: context.wikiRoot,
      intelRoot: path.join(context.wikiRoot, "generated"),
      runtimeRoot: context.runtimeRoot,
    }),
    ValidationError,
  );
  assert.equal(
    await pathExists(path.join(context.wikiRoot, "generated")),
    false,
    "overlap rejection must happen before creating the configured intelligence root",
  );
  assert.equal(await readFile(wikiMarker, "utf8"), wikiMarkerBefore);
});

test("root preflight rejects a runtime inside the vault without any partial writes", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "intel-os-boundary-runtime-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vaultRoot = path.join(base, "vault");
  const wikiRoot = path.join(vaultRoot, "wiki");
  const intelRoot = path.join(vaultRoot, "intelligence", "live");
  const runtimeRoot = path.join(vaultRoot, "runtime");
  const marker = path.join(wikiRoot, "source-marker.md");
  await mkdir(wikiRoot, { recursive: true });
  await writeFile(marker, "source remains unchanged\n", "utf8");
  const before = await readFile(marker, "utf8");

  await assert.rejects(
    createIntelligenceStore({ vaultRoot, wikiRoot, intelRoot, runtimeRoot }),
    ValidationError,
  );

  assert.equal(await pathExists(intelRoot), false);
  assert.equal(await pathExists(runtimeRoot), false);
  assert.equal(await readFile(marker, "utf8"), before);
});

test("root preflight requires an existing real Wiki before creating writable roots", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "intel-os-boundary-missing-wiki-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vaultRoot = path.join(base, "vault");
  const wikiRoot = path.join(vaultRoot, "wiki");
  const intelRoot = path.join(vaultRoot, "intelligence", "live");
  const runtimeRoot = path.join(base, "runtime");
  await mkdir(vaultRoot, { recursive: true });

  await assert.rejects(
    createIntelligenceStore({ vaultRoot, wikiRoot, intelRoot, runtimeRoot }),
    ValidationError,
  );

  assert.equal(await pathExists(wikiRoot), false);
  assert.equal(await pathExists(intelRoot), false);
  assert.equal(await pathExists(runtimeRoot), false);
});

test("root preflight rejects an intelligence path through a junction before writing", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "intel-os-boundary-junction-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vaultRoot = path.join(base, "vault");
  const wikiRoot = path.join(vaultRoot, "wiki");
  const outsideRoot = path.join(base, "outside");
  const junction = path.join(vaultRoot, "intel-link");
  const intelRoot = path.join(junction, "live");
  const runtimeRoot = path.join(base, "runtime");
  const marker = path.join(outsideRoot, "outside-marker.txt");
  await Promise.all([
    mkdir(wikiRoot, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ]);
  await writeFile(marker, "outside remains unchanged\n", "utf8");
  try {
    await symlink(outsideRoot, junction, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      t.skip("This environment does not permit creating a directory link");
      return;
    }
    throw error;
  }
  const beforeEntries = await readdir(outsideRoot);
  const beforeMarker = await readFile(marker, "utf8");

  await assert.rejects(
    createIntelligenceStore({ vaultRoot, wikiRoot, intelRoot, runtimeRoot }),
    ValidationError,
  );

  assert.equal(await pathExists(path.join(outsideRoot, "live")), false);
  assert.equal(await pathExists(runtimeRoot), false);
  assert.deepEqual(await readdir(outsideRoot), beforeEntries);
  assert.equal(await readFile(marker, "utf8"), beforeMarker);
});

test("runtime layout preflight rejects a later state junction before any startup directory is created", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "intel-os-runtime-layout-junction-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vaultRoot = path.join(base, "vault");
  const wikiRoot = path.join(vaultRoot, "wiki");
  const intelRoot = path.join(vaultRoot, "intelligence", "live");
  const runtimeRoot = path.join(base, "runtime");
  const outsideRoot = path.join(base, "outside");
  const unsafeState = path.join(runtimeRoot, "state");
  await Promise.all([
    mkdir(wikiRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ]);
  try {
    await symlink(outsideRoot, unsafeState, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      t.skip("This environment does not permit creating a directory link");
      return;
    }
    throw error;
  }

  await assert.rejects(
    createIntelligenceStore({ vaultRoot, wikiRoot, intelRoot, runtimeRoot }),
    ValidationError,
  );

  assert.equal(await pathExists(intelRoot), false);
  assert.deepEqual(
    (await readdir(runtimeRoot)).sort(),
    ["state"],
    "preflight must reject the unsafe later child before creating any safe runtime siblings",
  );
  assert.deepEqual(await readdir(outsideRoot), []);
});

test("CAS rejects a stale preview and restart restores list/get from Markdown", async (t) => {
  const context = await fixture(t);
  const createdPreview = await context.store.preview({
    operation: "create",
    entity_type: "Situation",
    entity_id: "us-inflation",
    base_revision: 0,
    payload: situationPayload({
      title: "US inflation and Fed policy",
      status: "active",
      current_assessment: "Disinflation continues",
    }),
  });
  await context.store.commit(createdPreview.preview_id);

  const first = await context.store.preview({
    operation: "update",
    entity_type: "Situation",
    entity_id: "us-inflation",
    base_revision: 1,
    payload: { current_assessment: "Inflation is sticky", material_change: true },
  });
  const stale = await context.store.preview({
    operation: "update",
    entity_type: "Situation",
    entity_id: "us-inflation",
    base_revision: 1,
    payload: { current_assessment: "Disinflation accelerated" },
  });
  const updated = await context.store.commit(first.preview_id);
  assert.equal(updated.revision, 2);
  await assert.rejects(context.store.commit(stale.preview_id), ConflictError);

  const restarted = await createIntelligenceStore({
    vaultRoot: context.vaultRoot,
    wikiRoot: context.wikiRoot,
    intelRoot: context.intelRoot,
    runtimeRoot: context.runtimeRoot,
  });
  const listed = await restarted.list("situations");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].revision, 2);
  assert.equal(listed[0].payload.current_assessment, "Inflation is sticky");
  assert.equal((await restarted.get("Situation", "us-inflation")).entity_id, "us-inflation");

  const recoveryFiles = await readdir(
    path.join(context.runtimeRoot, "recovery", "situations", "us-inflation"),
  );
  assert.ok(recoveryFiles.some((name) => name.endsWith(".before.md")));
  const temporaryFiles = (await readdir(path.join(context.intelRoot, "situations"))).filter(
    (name) => name.endsWith(".tmp"),
  );
  assert.deepEqual(temporaryFiles, []);
});

test("read-back detects visible frontmatter tampering", async (t) => {
  const context = await fixture(t);
  const preview = await context.store.preview({
    operation: "create",
    entity_type: "Review",
    entity_id: "review-first",
    base_revision: 0,
    payload: reviewPayload({ title: "First review", outcome: "No change" }),
  });
  await context.store.commit(preview.preview_id);
  const filename = path.join(context.intelRoot, "reviews", "review-first.md");
  const markdown = await readFile(filename, "utf8");
  await writeFile(filename, markdown.replace("revision: 1", "revision: 999"), "utf8");
  await assert.rejects(context.store.get("Review", "review-first"), CorruptionError);
});

test("remove is CAS-protected and snapshots canonical Markdown outside the vault", async (t) => {
  const context = await fixture(t);
  const preview = await context.store.preview({
    operation: "create",
    entity_type: "InboxItem",
    entity_id: "telegram-forget-me",
    base_revision: 0,
    payload: { title: "User-submitted Telegram item", status: "new" },
  });
  await context.store.commit(preview.preview_id);

  await assert.rejects(
    context.store.remove("InboxItem", "telegram-forget-me", { baseRevision: 2 }),
    ConflictError,
  );
  assert.equal(
    (await context.store.get("InboxItem", "telegram-forget-me")).revision,
    1,
    "a stale removal must leave canonical state intact",
  );

  const removal = await context.store.remove("InboxItem", "telegram-forget-me", {
    baseRevision: 1,
  });
  assert.equal(removal.removed_revision, 1);
  assert.equal(await context.store.list("InboxItem").then((items) => items.length), 0);
  await assert.rejects(
    context.store.remove("InboxItem", "../private", { baseRevision: 1 }),
    ValidationError,
  );

  const recoveryFiles = await readdir(
    path.join(context.runtimeRoot, "recovery", "inbox", "telegram-forget-me"),
  );
  assert.ok(recoveryFiles.some((name) => name.endsWith(".before.md")));
  assert.ok(recoveryFiles.some((name) => name.endsWith(".json")));
});

test("API exposes fixed collections, preview/commit, and Today projection", async (t) => {
  const context = await fixture(t);
  const api = createApiHandler({
    store: context.store,
    connectors: {
      fed: { getHealth: async () => ({ health_state: "healthy" }) },
    },
  });

  const situationPreview = await context.store.preview({
    operation: "create",
    entity_type: "Situation",
    entity_id: "situation-inflation-review",
    base_revision: 0,
    payload: situationPayload({ title: "Inflation review fixture" }),
  });
  await context.store.commit(situationPreview.preview_id);

  const createResult = await apiJson(api, "/api/v1/commands/preview", {
    method: "POST",
    body: {
      command: "mission.create",
      user_confirmation: true,
      data: {
        mission: missionPayload({
          objective: "Review the inflation thesis",
          next_action: "Compare BLS CPI with the manual Truflation snapshot",
          situation_id: "situation-inflation-review",
        }),
      },
    },
  });
  assert.equal(createResult.response.status, 200, JSON.stringify(createResult.json));
  assert.deepEqual(Object.keys(createResult.json), ["data"]);
  assert.deepEqual(
    Object.keys(createResult.json.data),
    ["preview_id", "base_revision", "diff", "entity"],
  );

  const commitResult = await apiJson(api, "/api/v1/commands/commit", {
    method: "POST",
    body: { preview_id: createResult.json.data.preview_id },
  });
  assert.equal(commitResult.response.status, 200);
  assert.deepEqual(Object.keys(commitResult.json.data), ["entity"]);

  const collection = await apiJson(api, "/api/v1/missions");
  assert.equal(collection.response.status, 200);
  assert.ok(Array.isArray(collection.json.data));
  assert.match(collection.json.data[0].entity_id, /^mission-/);
  assert.equal(collection.json.data[0].payload.objective, "Review the inflation thesis");

  const now = await apiJson(api, "/api/v1/now");
  assert.equal(now.response.status, 200);
  assert.deepEqual(Object.keys(now.json.data), [
    "mode",
    "as_of",
    "revision",
    "needs_you",
    "material_changes",
    "next_actions",
      "watching",
      "connector_health",
      "live_signals",
      "briefing",
  ]);
  assert.equal(now.json.data.mode, "live_local");
  assert.equal(Number.isFinite(Date.parse(now.json.data.as_of)), true);
  assert.equal(now.json.data.revision, 2);
  assert.equal(now.json.data.needs_you.length, 0);
  assert.equal(now.json.data.next_actions.length, 1);
  assert.equal(now.json.data.connector_health[0].connector_id, "fed");
  assert.equal(now.json.data.briefing.items.length, 1);
});

test("API returns CAS conflicts and Truflation remains a manual unverified preview", async (t) => {
  const context = await fixture(t);
  const api = createApiHandler({ store: context.store });

  const invalid = await apiJson(api, "/api/v1/commands/preview", {
    method: "POST",
    body: {
      operation: "create",
      entity_type: "InboxItem",
      entity_id: "../outside",
      base_revision: 0,
      payload: { title: "Unsafe" },
    },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.json.error.code, "VALIDATION_ERROR");

  const truflation = await apiJson(
    api,
    "/api/v1/connectors/truflation/manual-observation",
    {
      method: "POST",
      body: {
        base_revision: 0,
        observation_date: "2026-07-29",
        value: 2.31,
        confirmed_by_user: true,
      },
    },
  );
  assert.equal(truflation.response.status, 200);
  assert.equal(truflation.json.data.entity.payload.source_type, "manual_snapshot");
  assert.equal(truflation.json.data.entity.payload.evidence_status, "unverified_external");
  assert.equal(
    truflation.json.data.entity.payload.source_url,
    "https://truflation.com/marketplace/us-inflation-rate",
  );
  assert.deepEqual(await context.store.list("InboxItem"), [], "manual endpoint only previews");

  const missingConnector = await apiJson(api, "/api/v1/connectors/telegram/bootstrap", {
    method: "POST",
    body: {},
  });
  assert.equal(missingConnector.response.status, 503);
  assert.equal(missingConnector.json.error.code, "CONNECTOR_DISABLED");
});

test("v2 API exposes forward projection and keeps forecast writes preview-first", async (t) => {
  const context = await fixture(t);
  const forwardProjection = {
    mode: "forward_intelligence_v2",
    as_of: "2026-08-02T12:00:00.000Z",
    event_radar: [],
    next_event: null,
    live_pulse: [],
    path_map: [],
    decision_gates: [],
    coverage_health: [],
    latency_budget: { deterministic_flash_p95_target_ms: 3_000 },
  };
  const api = createApiHandler({
    store: context.store,
    connectors: {
      forwardIntelligence: {
        getNowProjection: async () => forwardProjection,
        listEventWindows: async () => [],
        getSignal: async () => null,
        getSourcePerformance: async () => [],
        subscribe: () => () => {},
      },
    },
  });
  const situationPreview = await context.store.preview({
    operation: "create",
    entity_type: "Situation",
    entity_id: "situation-v2-forecast",
    base_revision: 0,
    payload: situationPayload({ title: "Forward forecast fixture" }),
  });
  await context.store.commit(situationPreview.preview_id);

  const now = await apiJson(api, "/api/v2/now");
  assert.equal(now.response.status, 200);
  assert.deepEqual(now.json.data.forward_intelligence, forwardProjection);
  const v1 = await apiJson(api, "/api/v1/now");
  assert.equal(Object.hasOwn(v1.json.data, "forward_intelligence"), false, "v1 stays backward compatible");

  const paths = [
    { id: "base", label: "Base", probability: 50, summary: "Base path.", trigger: "Base trigger.", implication: "Base implication.", invalidation: "Base invalidation.", tone: "base" },
    { id: "upside", label: "Upside", probability: 30, summary: "Upside path.", trigger: "Upside trigger.", implication: "Upside implication.", invalidation: "Upside invalidation.", tone: "upside" },
    { id: "stress", label: "Stress", probability: 20, summary: "Stress path.", trigger: "Stress trigger.", implication: "Stress implication.", invalidation: "Stress invalidation.", tone: "stress" },
  ];
  const preview = await apiJson(api, "/api/v2/situations/situation-v2-forecast/forecast", {
    method: "POST",
    body: {
      base_revision: 1,
      user_confirmation: true,
      intelligence_question: "Which path will the next release support?",
      forecast_horizon: "2026-09-01T00:00:00.000Z",
      next_observable: "Next official release.",
      paths,
      method: "empirical_likelihood",
      comparable_event_count: 4,
    },
  });
  assert.equal(preview.response.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.data.entity.payload.forecast_ledger[0].method, "heuristic_pressure");
  assert.equal((await context.store.get("Situation", "situation-v2-forecast")).revision, 1, "preview is not a write");
  await apiJson(api, "/api/v1/commands/commit", {
    method: "POST",
    body: { preview_id: preview.json.data.preview_id },
  });

  const forecast = await apiJson(api, "/api/v2/situations/situation-v2-forecast/forecast");
  assert.equal(forecast.response.status, 200);
  assert.equal(forecast.json.data.paths.reduce((sum, path) => sum + path.probability, 0), 100);
  const forecastId = forecast.json.data.ledger[0].forecast_id;
  const resolution = await apiJson(api, `/api/v2/forecasts/${forecastId}/resolve`, {
    method: "POST",
    body: {
      base_revision: 2,
      user_confirmation: true,
      outcome_path_id: "base",
      resolved_at: "2026-09-01T12:00:00.000Z",
      notes: "The base path resolved.",
    },
  });
  assert.equal(resolution.response.status, 200, JSON.stringify(resolution.json));
  assert.equal(resolution.json.data.entity.payload.forecast_ledger[0].resolution.brier_score, 0.1267);
});

test("typed Inbox commands create a linked Situation and preserve the S0-S8 evidence gate", async (t) => {
  const context = await fixture(t);
  const api = createApiHandler({ store: context.store });
  const inboxPreview = await context.store.preview({
    operation: "create",
    entity_type: "InboxItem",
    entity_id: "inbox-external-lead",
    base_revision: 0,
    payload: {
      title: "Unverified external lead",
      status: "new",
      evidence_status: "unverified_external",
      summary: "A claim that still needs Wiki ingest.",
    },
  });
  await context.store.commit(inboxPreview.preview_id);

  const proposed = await apiJson(api, "/api/v1/commands/preview", {
    method: "POST",
    body: {
      command: "inbox.create_situation",
      user_confirmation: true,
      data: {
        inbox_id: "inbox-external-lead",
        base_revision: 1,
        situation: {
          ...situationPayload({ title: "External lead Situation", domain: "world" }),
          watch_condition: "Review when an independently verified source arrives.",
        },
      },
    },
  });
  assert.equal(proposed.response.status, 200);
  assert.equal(proposed.json.data.preview_ids.length, 2);
  const committed = await apiJson(api, "/api/v1/commands/commit", {
    method: "POST",
    body: { preview_ids: proposed.json.data.preview_ids },
  });
  assert.equal(committed.response.status, 200);
  const situations = await context.store.list("Situation");
  assert.equal(situations.length, 1);
  assert.deepEqual(situations[0].payload.evidence.map((item) => item.kind), ["unknown"]);
  assert.equal(situations[0].payload.evidence[0].source_inbox_id, "inbox-external-lead");
  assert.equal((await context.store.get("InboxItem", "inbox-external-lead")).payload.status, "linked");
  const linkedInbox = await apiJson(api, "/api/v1/inbox");
  assert.equal(linkedInbox.json.data.some((item) => item.entity_id === "inbox-external-lead"), true);

  const rawKnown = await apiJson(api, "/api/v1/commands/preview", {
    method: "POST",
    body: {
      operation: "create",
      entity_type: "Situation",
      entity_id: "unsafe-known",
      base_revision: 0,
      payload: situationPayload({ evidence: [{ kind: "known", text: "Unverified claim" }] }),
    },
  });
  assert.equal(rawKnown.response.status, 400);

  const linkedHandoff = await apiJson(api, "/api/v1/commands/preview", {
    method: "POST",
    body: {
      command: "inbox.send_to_wiki_ingest",
      user_confirmation: true,
      data: { inbox_id: "inbox-external-lead", base_revision: 2 },
    },
  });
  assert.equal(linkedHandoff.response.status, 200, "a linked lead can still enter the S0-S8 handoff");
  await apiJson(api, "/api/v1/commands/commit", {
    method: "POST",
    body: { preview_id: linkedHandoff.json.data.preview_id },
  });
  const linkedPending = await context.store.get("InboxItem", "inbox-external-lead");
  assert.equal(linkedPending.payload.status, "wiki_ingest_pending");
  assert.equal(linkedPending.payload.linked_situation_id, situations[0].entity_id);

  const wikiLeadPreview = await context.store.preview({
    operation: "create",
    entity_type: "InboxItem",
    entity_id: "inbox-wiki-lead",
    base_revision: 0,
    payload: {
      title: "Wiki lead awaiting S0-S8",
      status: "new",
      source_type: "wiki_read_only",
      source_url: "obsidian://open?vault=Obsidian&file=wiki%2Fresearch%2Flead.md",
      content_hash: "a".repeat(64),
      evidence_status: "unverified_external",
      summary: "A Wiki note whose ingest still needs explicit confirmation.",
    },
  });
  await context.store.commit(wikiLeadPreview.preview_id);

  const handoff = await apiJson(api, "/api/v1/commands/preview", {
    method: "POST",
    body: {
      command: "inbox.send_to_wiki_ingest",
      user_confirmation: true,
      data: { inbox_id: "inbox-wiki-lead", base_revision: 1 },
    },
  });
  assert.equal(handoff.response.status, 200);
  await apiJson(api, "/api/v1/commands/commit", {
    method: "POST",
    body: { preview_id: handoff.json.data.preview_id },
  });
  const pending = await context.store.get("InboxItem", "inbox-wiki-lead");
  assert.equal(pending.payload.s0_s8_handoff.state, "pending");
  assert.deepEqual(pending.payload.s0_s8_handoff.stages.map((stage) => stage.stage), ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]);
});

test("canonical Situation schema fails closed for Known evidence without verified S0-S8 provenance", async (t) => {
  const context = await fixture(t);
  const unsafeEvidence = [
    { kind: "known", text: "Missing verification metadata." },
    {
      kind: "known",
      text: "Official proxy is not verified evidence.",
      evidence_status: "official_proxy",
      s0_s8_state: "completed",
    },
    {
      kind: "known",
      text: "Verification without a completed gate is insufficient.",
      evidence_status: "verified",
      s0_s8_state: "pending",
    },
  ];

  for (const [index, evidence] of unsafeEvidence.entries()) {
    await assert.rejects(
      context.store.preview({
        operation: "create",
        entity_type: "Situation",
        entity_id: `unsafe-known-${index}`,
        base_revision: 0,
        payload: situationPayload({ evidence: [evidence] }),
      }),
      /known evidence requires evidence_status verified and a completed S0-S8 gate/,
    );
  }

  const preview = await context.store.preview({
    operation: "create",
    entity_type: "Situation",
    entity_id: "verified-known",
    base_revision: 0,
    payload: situationPayload({
      evidence: [{
        kind: "known",
        text: "The Wiki evidence completed the verification gate.",
        evidence_status: "verified",
        s0_s8_state: "completed",
        source_inbox_id: "inbox-wiki-verified",
      }],
    }),
  });
  const committed = await context.store.commit(preview.preview_id);
  assert.equal(committed.payload.evidence[0].kind, "known");
  assert.equal(committed.payload.evidence[0].evidence_status, "verified");
  assert.equal(committed.payload.evidence[0].s0_s8_state, "completed");
});

test("typed Mission and Review commands enforce relation integrity and explicit completion", async (t) => {
  const context = await fixture(t);
  const api = createApiHandler({ store: context.store });
  const situationPreview = await context.store.preview({
    operation: "create",
    entity_type: "Situation",
    entity_id: "fed-policy",
    base_revision: 0,
    payload: situationPayload({ title: "Fed policy", domain: "macro" }),
  });
  await context.store.commit(situationPreview.preview_id);
  const mission = missionPayload({ situation_id: "fed-policy" });

  const noConfirmation = await apiJson(api, "/api/v1/commands/preview", {
    method: "POST",
    body: { command: "mission.create", data: { mission } },
  });
  assert.equal(noConfirmation.response.status, 400);
  const missionResult = await apiJson(api, "/api/v1/commands/preview", {
    method: "POST",
    body: { command: "mission.create", user_confirmation: true, data: { mission } },
  });
  assert.equal(missionResult.response.status, 200);
  await apiJson(api, "/api/v1/commands/commit", {
    method: "POST",
    body: { preview_id: missionResult.json.data.preview_id },
  });
  const missionId = missionResult.json.data.entity.entity_id;

  const genericObjectiveChange = await apiJson(api, "/api/v1/commands/preview", {
    method: "POST",
    body: {
      operation: "update",
      entity_type: "Mission",
      entity_id: missionId,
      base_revision: 1,
      payload: { objective: "Agent changed objective" },
    },
  });
  assert.equal(genericObjectiveChange.response.status, 400);

  const missingRelation = await apiJson(api, "/api/v1/commands/preview", {
    method: "POST",
    body: {
      command: "review.create",
      user_confirmation: true,
      data: {
        mission_id: "mission-does-not-exist",
        base_revision: 1,
        title: "Impossible review",
        outcome: "None",
        assessment_change: "None",
        next_state: "None",
        mission_transition: "completed",
        reviewed_at: "2026-07-30",
      },
    },
  });
  assert.equal(missingRelation.response.status, 400);

  const reviewResult = await apiJson(api, "/api/v1/commands/preview", {
    method: "POST",
    body: {
      command: "review.create",
      user_confirmation: true,
      data: {
        mission_id: missionId,
        base_revision: 1,
        title: "Review the first loop",
        outcome: "The action completed as expected.",
        assessment_change: "No Change; the original assessment remains bounded.",
        next_state: "Close this Mission and keep the Situation on watch.",
        mission_transition: "completed",
        reviewed_at: "2026-07-30",
      },
    },
  });
  assert.equal(reviewResult.response.status, 200);
  assert.equal(reviewResult.json.data.preview_ids.length, 2);
  await apiJson(api, "/api/v1/commands/commit", {
    method: "POST",
    body: { preview_ids: reviewResult.json.data.preview_ids },
  });
  assert.equal((await context.store.get("Mission", missionId)).payload.status, "completed");
  assert.equal((await context.store.list("Review")).length, 1);
});

test("Truflation manual observations use deterministic same-day deduplication", async (t) => {
  const context = await fixture(t);
  const api = createApiHandler({ store: context.store });
  const body = {
    base_revision: 0,
    observation_date: "2026-07-30",
    value: 2.42,
    confirmed_by_user: true,
  };
  const first = await apiJson(api, "/api/v1/connectors/truflation/manual-observation", { method: "POST", body });
  assert.equal(first.response.status, 200);
  assert.equal(first.json.data.entity.entity_id, "inbox-truflation-us-2026-07-30");
  await apiJson(api, "/api/v1/commands/commit", {
    method: "POST",
    body: { preview_id: first.json.data.preview_id },
  });
  const duplicate = await apiJson(api, "/api/v1/connectors/truflation/manual-observation", { method: "POST", body });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.json.data.no_op, true);
  assert.equal((await context.store.list("InboxItem")).length, 1);
});
