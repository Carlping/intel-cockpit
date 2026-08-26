import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CorruptionError,
  ValidationError,
  createIntelligenceStore,
} from "../server/store/index.mjs";
import { serializeCanonicalMarkdown } from "../server/store/markdown.mjs";
import {
  assertSeedBoundaries,
  buildAlphaSeedDefinitions,
  runAlphaSeed,
} from "../scripts/seed-alpha-v1.1.mjs";
import { runAlphaRoutingMigration } from "../scripts/migrate-alpha-v1.1-routing.mjs";
import { runAlphaFeedProvenanceMigration } from "../scripts/migrate-alpha-v1.1-feed-provenance.mjs";

const FIXED_NOW = new Date("2026-07-30T12:00:00.000Z");

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "intel-os-seed-test-"));
  const vaultRoot = path.join(base, "vault");
  const wikiRoot = path.join(vaultRoot, "wiki");
  const intelRoot = path.join(vaultRoot, "intelligence", "live");
  const runtimeRoot = path.join(base, "runtime");
  await mkdir(wikiRoot, { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));
  return {
    base,
    paths: { vaultRoot, wikiRoot, intelRoot, runtimeRoot, excludedSegments: ["private"] },
  };
}

const runOptions = (context, apply) => ({
  paths: context.paths,
  apply,
  allowTestRoots: true,
  playbookUri: "obsidian://open?vault=IntelOS&file=wiki%2Fplaybook.md",
  clock: () => new Date(FIXED_NOW),
});

test("default seed run is isolated and leaves the configured target untouched", async (t) => {
  const context = await fixture(t);
  const sentinel = path.join(context.base, "target-sentinel.txt");
  await writeFile(sentinel, "unchanged\n", "utf8");

  const result = await runAlphaSeed(runOptions(context, false));

  assert.equal(result.mode, "dry-run");
  assert.equal(result.target_written, false);
  assert.equal(result.planned.length, 5);
  assert.equal(result.committed.length, 0, "dry-run must never report a target commit");
  assert.equal(result.validated_in_staging.length, 5);
  await assert.rejects(stat(context.paths.intelRoot), { code: "ENOENT" });
  assert.equal(await readFile(sentinel, "utf8"), "unchanged\n");
});

test("apply seeds three domains and is byte-stable on a second run", async (t) => {
  const context = await fixture(t);

  const first = await runAlphaSeed(runOptions(context, true));
  assert.equal(first.mode, "apply");
  assert.equal(first.transaction.mode, "batch");
  assert.equal(first.committed.length, 5);

  const store = await createIntelligenceStore(context.paths);
  const situations = await store.list("Situation");
  assert.deepEqual(
    new Set(situations.map((entity) => entity.payload.domain)),
    new Set(["macro", "industry", "finance"]),
  );
  assert.ok(
    situations.every((entity) => entity.payload.evidence.every((item) => item.kind !== "known")),
    "seed must not invent Known evidence",
  );

  const finance = await store.get("Situation", "situation-market-midterm-pullback");
  assert.ok(finance.payload.sector_groups.length >= 3);
  assert.ok(finance.payload.sector_groups.every((group) => group.members.length === 0));
  assert.equal(finance.payload.pullback_indicators.length, 8);
  assert.ok(finance.payload.pullback_indicators.every((indicator) => indicator.state === "unavailable"));
  assert.deepEqual(
    finance.payload.pullback_indicators.map((indicator) => indicator.label),
    [
      "估值到便宜位置",
      "市場情緒過低",
      "底底高＋高點更高",
      "QLD／TQQQ 日或週爆量",
      "VIX／VXN 太高",
      "融資餘額太低",
      "融資維持率太低",
      "KDJ J（週）≤ 0",
    ],
  );
  assert.equal(
    finance.payload.playbook_reference.uri,
    "obsidian://open?vault=IntelOS&file=wiki%2Fplaybook.md",
  );
  const macro = await store.get("Situation", "situation-us-inflation-fed");
  assert.ok(macro.payload.indicator_availability.indicators.every((indicator) => indicator.state === "unavailable"));
  assert.ok(macro.payload.keywords.includes("FOMC"));
  assert.ok(macro.payload.feed_ids.includes("fed.monetary-policy"));
  assert.ok(macro.payload.feed_ids.includes("bls.us-cpi"));
  assert.ok(macro.payload.series_ids.includes("CUUR0000SA0"));
  const industry = await store.get("Situation", "situation-ai-infrastructure-cycle");
  assert.ok(industry.payload.keywords.includes("AI infrastructure"));
  assert.deepEqual(industry.payload.feed_ids, []);
  const pullback = await store.get("Situation", "situation-market-midterm-pullback");
  assert.ok(pullback.payload.keywords.includes("VIX"));
  assert.ok(pullback.payload.series_ids.includes("VXN"));

  const filenames = [
    path.join(context.paths.intelRoot, "situations", "situation-us-inflation-fed.md"),
    path.join(context.paths.intelRoot, "missions", "mission-alpha-dogfood.md"),
    path.join(context.paths.intelRoot, "inbox", "inbox-team-template-plan-archive.md"),
  ];
  const before = await Promise.all(filenames.map((filename) => readFile(filename, "utf8")));
  const second = await runAlphaSeed(runOptions(context, true));
  const after = await Promise.all(filenames.map((filename) => readFile(filename, "utf8")));

  assert.equal(second.target_written, false);
  assert.equal(second.planned.length, 0);
  assert.equal(second.skipped.length, 5);
  assert.deepEqual(after, before);
});

test("legacy or incomplete Alpha entity fails closed without changing raw Markdown", async (t) => {
  const context = await fixture(t);
  const directory = path.join(context.paths.intelRoot, "situations");
  await mkdir(directory, { recursive: true });
  const createdAt = "2026-07-01T12:00:00.000Z";
  const { markdown } = serializeCanonicalMarkdown({
    schema_version: 1,
    entity_type: "Situation",
    entity_id: "situation-legacy-unrelated",
    revision: 7,
    created_at: createdAt,
    updated_at: "2026-07-29T12:00:00.000Z",
    payload: {
      title: "使用者保留的通膨標題",
      status: "watch",
      domain: "macro",
      current_assessment: "使用者較新的判斷，不得被 seed 覆蓋。",
    },
  });
  await writeFile(
    path.join(directory, "situation-legacy-unrelated.md"),
    markdown,
    "utf8",
  );

  const filename = path.join(directory, "situation-legacy-unrelated.md");
  const before = await readFile(filename, "utf8");
  await assert.rejects(runAlphaSeed(runOptions(context, true)), CorruptionError);
  assert.equal(await readFile(filename, "utf8"), before);
  await assert.rejects(
    stat(path.join(context.paths.intelRoot, "missions", "mission-alpha-dogfood.md")),
    { code: "ENOENT" },
  );
});

test("an existing valid entity is user-owned and remains a no-op", async (t) => {
  const context = await fixture(t);
  await runAlphaSeed(runOptions(context, true));
  const store = await createIntelligenceStore(context.paths);
  const existing = await store.get("Situation", "situation-us-inflation-fed");
  const preview = await store.preview({
    operation: "update",
    entity_type: "Situation",
    entity_id: existing.entity_id,
    base_revision: existing.revision,
    payload: {
      title: "使用者較新的通膨標題",
      current_assessment: "使用者較新的有效判斷。",
    },
  });
  await store.commit(preview.preview_id);

  const result = await runAlphaSeed(runOptions(context, true));
  const after = await store.get("Situation", "situation-us-inflation-fed");
  assert.equal(result.target_written, false);
  assert.equal(result.skipped.length, 5);
  assert.equal(after.revision, 2);
  assert.equal(after.payload.title, "使用者較新的通膨標題");
  assert.equal(after.payload.current_assessment, "使用者較新的有效判斷。");
});

test("routing migration is preview-first, repairs only missing seed fields, and is idempotent", async (t) => {
  const context = await fixture(t);
  await runAlphaSeed(runOptions(context, true));
  const store = await createIntelligenceStore(context.paths);
  const finance = await store.get("Situation", "situation-market-midterm-pullback");
  const preview = await store.preview({
    operation: "update",
    entity_type: "Situation",
    entity_id: finance.entity_id,
    base_revision: finance.revision,
    payload: {
      keywords: null,
      feed_ids: null,
      series_ids: null,
      playbook_reference: {
        ...finance.payload.playbook_reference,
        uri: "obsidian://open?vault=IntelOS&file=wiki%2Fplaybook.md",
      },
    },
  });
  await store.commit(preview.preview_id);

  const dryRun = await runAlphaRoutingMigration(runOptions(context, false));
  assert.equal(dryRun.target_written, false);
  assert.equal(dryRun.planned.some((item) => item.entity_id === finance.entity_id), true);
  assert.equal((await store.get("Situation", finance.entity_id)).revision, 2);

  const applied = await runAlphaRoutingMigration(runOptions(context, true));
  assert.equal(applied.target_written, true);
  const migrated = await store.get("Situation", finance.entity_id);
  assert.equal(migrated.revision, 3);
  assert.ok(migrated.payload.keywords.includes("VIX"));
  assert.ok(migrated.payload.series_ids.includes("VXN"));
  assert.equal(
    migrated.payload.playbook_reference.uri,
    "obsidian://open?vault=IntelOS&file=wiki%2Fplaybook.md",
  );

  const repeated = await runAlphaRoutingMigration(runOptions(context, true));
  assert.equal(repeated.target_written, false);
  assert.equal((await store.get("Situation", finance.entity_id)).revision, 3);
});

test("feed provenance migration is preview-first and only repairs recognized official Inbox items", async (t) => {
  const context = await fixture(t);
  const store = await createIntelligenceStore(context.paths);
  const preview = await store.preview({
    operation: "create",
    entity_type: "InboxItem",
    entity_id: "inbox-fed-provenance",
    base_revision: 0,
    payload: {
      title: "FOMC statement",
      status: "new",
      source_type: "official_feed",
      external_event_id: "fed.monetary-policy:fixture",
      evidence_status: "unverified_external",
    },
  });
  await store.commit(preview.preview_id);

  const dryRun = await runAlphaFeedProvenanceMigration(runOptions(context, false));
  assert.equal(dryRun.target_written, false);
  assert.deepEqual(dryRun.planned[0].patch, { feed_id: "fed.monetary-policy" });
  assert.equal((await store.get("InboxItem", "inbox-fed-provenance")).revision, 1);

  const applied = await runAlphaFeedProvenanceMigration(runOptions(context, true));
  assert.equal(applied.target_written, true);
  const migrated = await store.get("InboxItem", "inbox-fed-provenance");
  assert.equal(migrated.revision, 2);
  assert.equal(migrated.payload.feed_id, "fed.monetary-policy");

  const repeated = await runAlphaFeedProvenanceMigration(runOptions(context, true));
  assert.equal(repeated.target_written, false);
  assert.equal((await store.get("InboxItem", "inbox-fed-provenance")).revision, 2);
});

test("seed boundaries reject Wiki and excluded targets while allowing configured roots", async (t) => {
  const context = await fixture(t);
  assert.throws(
    () => assertSeedBoundaries({
      ...context.paths,
      intelRoot: path.join(context.paths.wikiRoot, "generated"),
    }, { allowTestRoots: true }),
    ValidationError,
  );
  assert.throws(
    () => assertSeedBoundaries({
      ...context.paths,
      intelRoot: path.join(context.paths.vaultRoot, "private", "live"),
    }, { allowTestRoots: true }),
    ValidationError,
  );
  assert.doesNotThrow(() => assertSeedBoundaries(context.paths));
});

test("seed definitions archive the team plan locally and do not refer to private data", () => {
  const definitions = buildAlphaSeedDefinitions({ clock: () => new Date(FIXED_NOW) });
  const archive = definitions.find((item) => item.entity_id === "inbox-team-template-plan-archive");
  assert.equal(archive.entity_type, "InboxItem");
  assert.equal(archive.payload.status, "reference_only");
  assert.equal(archive.payload.distribution_scope, "local_only");
  assert.doesNotMatch(JSON.stringify(definitions), /private/i);
});
