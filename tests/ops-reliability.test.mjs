import assert from "node:assert/strict";
import {
  access,
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
import {
  createDailyBackup,
  createDisabledTtsAdapter,
  createUnavailableTtsAdapter,
  inspectRuntimeStorageHealth,
  lintCanonicalState,
  maintainRuntimeArtifacts,
  OperationsBoundaryError,
  projectDecisionBrief,
} from "../server/ops/index.mjs";
import { createIntelligenceStore } from "../server/store/index.mjs";
import { serializeCanonicalMarkdown } from "../server/store/markdown.mjs";

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "intel-os-ops-"));
  const vaultRoot = path.join(base, "vault");
  const wikiRoot = path.join(vaultRoot, "wiki");
  const intelRoot = path.join(vaultRoot, "codex-intelligence", "live");
  const runtimeRoot = path.join(base, "local-runtime");
  const privateRoot = path.join(vaultRoot, "private");
  await Promise.all([
    mkdir(wikiRoot, { recursive: true }),
    mkdir(privateRoot, { recursive: true }),
  ]);
  const wikiSentinel = path.join(wikiRoot, "source-note.md");
  const privateSentinel = path.join(privateRoot, "do-not-read.md");
  await Promise.all([
    writeFile(wikiSentinel, "source vault remains read only\n", "utf8"),
    writeFile(privateSentinel, "private sentinel\n", "utf8"),
  ]);
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
    wikiSentinel,
    privateSentinel,
    store,
  };
}

async function createEntity(store, request) {
  const preview = await store.preview({
    operation: "create",
    base_revision: 0,
    ...request,
  });
  return store.commit(preview.preview_id);
}

async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pathExists(filename) {
  try {
    await access(filename);
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

test("daily backup mirrors verified canonical Markdown and JSON outside the vault", async (t) => {
  const context = await fixture(t);
  await createEntity(context.store, {
    entity_type: "Situation",
    entity_id: "fed-policy",
    payload: situationPayload({
      title: "US inflation and Fed policy",
      status: "active",
      current_assessment: "The next decision depends on official inflation data.",
    }),
  });
  await createEntity(context.store, {
    entity_type: "Mission",
    entity_id: "review-cpi",
    payload: missionPayload({
      objective: "Review the CPI evidence",
      status: "active",
      next_action: "Compare BLS CPI with the existing thesis.",
    }),
  });

  const wikiBefore = await readFile(context.wikiSentinel, "utf8");
  const privateBefore = await readFile(context.privateSentinel, "utf8");
  const fixed = new Date("2026-07-29T12:00:00.000Z");
  const backup = await createDailyBackup({
    store: context.store,
    clock: () => fixed,
    timeZone: "America/New_York",
  });

  assert.equal(backup.state, "created");
  assert.equal(backup.snapshot_date, "2026-07-29");
  assert.ok(path.resolve(backup.backup_path).startsWith(path.resolve(context.runtimeRoot)));
  assert.equal(backup.manifest.entity_count, 2);
  assert.equal(backup.manifest.lint.invalid_count, 0);

  const copiedSituation = await readFile(
    path.join(backup.backup_path, "canonical", "situations", "fed-policy.md"),
    "utf8",
  );
  const sourceSituation = await readFile(
    path.join(context.intelRoot, "situations", "fed-policy.md"),
    "utf8",
  );
  assert.equal(copiedSituation, sourceSituation);

  const exported = JSON.parse(await readFile(path.join(backup.backup_path, "export.json"), "utf8"));
  assert.equal(exported.export_type, "intel-os-canonical-json");
  assert.deepEqual(
    exported.entities.map((entity) => entity.entity_id).sort(),
    ["fed-policy", "review-cpi"],
  );
  assert.equal(await readFile(context.wikiSentinel, "utf8"), wikiBefore);
  assert.equal(await readFile(context.privateSentinel, "utf8"), privateBefore);

  const repeated = await createDailyBackup({
    store: context.store,
    clock: () => new Date("2026-07-29T20:00:00.000Z"),
    timeZone: "America/New_York",
  });
  assert.equal(repeated.state, "existing", "a daily run must be idempotent");
  assert.equal(repeated.backup_path, backup.backup_path);
});

test("runtime maintenance bounds finalized artifacts while preserving live and failed recovery state", async (t) => {
  const context = await fixture(t);
  const previewsRoot = path.join(context.runtimeRoot, "previews");
  const walRoot = path.join(context.runtimeRoot, "transactions", "store");
  const recoveryRoot = path.join(
    context.runtimeRoot,
    "recovery",
    "situations",
    "situation-fixture",
  );
  const backupsRoot = path.join(context.runtimeRoot, "backups", "daily");
  const lintReportsRoot = path.join(context.runtimeRoot, "lint-reports");

  const expiredPreview = path.join(previewsRoot, "expired.json");
  const livePreview = path.join(previewsRoot, "live.json");
  await writeJson(expiredPreview, {
    schema_version: 1,
    expires_at: "2026-07-01T00:00:00.000Z",
  });
  await writeJson(livePreview, {
    schema_version: 1,
    expires_at: "2026-09-01T00:00:00.000Z",
  });

  const committedWal = path.join(walRoot, "committed.json");
  const rolledBackWal = path.join(walRoot, "rolled-back.json");
  const pendingWal = path.join(walRoot, "pending.json");
  const conflictWal = path.join(walRoot, "conflict.json");
  await writeJson(committedWal, {
    version: 1,
    state: "committed",
    committed_at: "2026-07-01T00:00:00.000Z",
  });
  await writeJson(rolledBackWal, {
    version: 1,
    state: "rolled_back",
    rolled_back_at: "2026-07-01T00:00:00.000Z",
  });
  await writeJson(pendingWal, {
    version: 1,
    state: "prepared",
    prepared_at: "2026-07-01T00:00:00.000Z",
  });
  await writeJson(conflictWal, {
    version: 1,
    state: "recovery_conflict",
    recovery_conflict_at: "2026-07-01T00:00:00.000Z",
  });

  const committedRecovery = path.join(recoveryRoot, "recovery-old.json");
  const committedSnapshot = path.join(recoveryRoot, "recovery-old.before.md");
  const failedRecovery = path.join(recoveryRoot, "recovery-failed.json");
  const failedSnapshot = path.join(recoveryRoot, "recovery-failed.before.md");
  await mkdir(recoveryRoot, { recursive: true });
  await writeFile(committedSnapshot, "old committed recovery snapshot\n", "utf8");
  await writeJson(committedRecovery, {
    recovery_id: "recovery-old",
    state: "committed",
    committed_at: "2026-07-01T00:00:00.000Z",
    snapshot: "recovery-old.before.md",
  });
  await writeFile(failedSnapshot, "failed recovery must remain\n", "utf8");
  await writeJson(failedRecovery, {
    recovery_id: "recovery-failed",
    state: "rolled_back",
    rolled_back_at: "2026-07-01T00:00:00.000Z",
    snapshot: "recovery-failed.before.md",
    failure: "fixture failure",
  });

  for (let day = 1; day <= 16; day += 1) {
    const snapshotDate = `2026-07-${String(day).padStart(2, "0")}`;
    const directory = path.join(backupsRoot, snapshotDate);
    await writeJson(path.join(directory, "manifest.json"), {
      schema_version: 1,
      backup_type: "daily-local-canonical",
      snapshot_date: snapshotDate,
      created_at: `${snapshotDate}T12:00:00.000Z`,
    });
    await writeFile(path.join(directory, "export.json"), "{}\n", "utf8");
    await writeJson(path.join(lintReportsRoot, `report-${day}.json`), {
      schema_version: 1,
      checked_at: `${snapshotDate}T12:00:00.000Z`,
    });
  }
  await writeJson(path.join(lintReportsRoot, "latest.json"), {
    schema_version: 1,
    checked_at: "2026-07-16T12:00:00.000Z",
  });

  const maintenance = await maintainRuntimeArtifacts({
    store: context.store,
    clock: () => new Date("2026-08-30T12:00:00.000Z"),
    policy: {
      backup_min_keep: 14,
      backup_max_keep: 14,
    },
    statfsImpl: async () => ({
      bsize: 4096n,
      blocks: 10_000_000n,
      bavail: 5_000_000n,
    }),
  });

  assert.deepEqual(maintenance.pruned, {
    preview_files: 1,
    wal_files: 2,
    recovery_records: 1,
    backup_snapshots: 2,
    lint_report_files: 2,
    bytes: maintenance.pruned.bytes,
  });
  assert.ok(maintenance.pruned.bytes > 0);
  assert.equal(await pathExists(expiredPreview), false);
  assert.equal(await pathExists(livePreview), true);
  assert.equal(await pathExists(committedWal), false);
  assert.equal(await pathExists(rolledBackWal), false);
  assert.equal(await pathExists(pendingWal), true);
  assert.equal(await pathExists(conflictWal), true);
  assert.equal(await pathExists(committedRecovery), false);
  assert.equal(await pathExists(committedSnapshot), false);
  assert.equal(await pathExists(failedRecovery), true);
  assert.equal(await pathExists(failedSnapshot), true);
  assert.equal(
    (await readdir(backupsRoot)).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).length,
    14,
  );
  assert.equal((await readdir(lintReportsRoot)).length, 15, "14 dated reports plus latest remain");
  assert.equal(maintenance.health.state, "healthy");
  assert.equal(maintenance.health.scope, "runtime_metadata_only");
  assert.equal(maintenance.health.free_percent, 50);
  assert.equal(maintenance.health.unsafe_entry_count, 0);
});

test("runtime storage reports capacity from metadata only", async (t) => {
  const context = await fixture(t);
  await mkdir(path.join(context.runtimeRoot, "cache"), { recursive: true });
  await writeFile(path.join(context.runtimeRoot, "cache", "fixture.bin"), "1234567890", "utf8");
  const health = await inspectRuntimeStorageHealth({
    store: context.store,
    clock: () => new Date("2026-07-30T12:00:00.000Z"),
    statfsImpl: async () => ({
      bsize: 1024n,
      blocks: 100_000n,
      bavail: 1_000n,
    }),
  });
  assert.equal(health.state, "degraded");
  assert.equal(health.level, "critical");
  assert.equal(health.total_bytes, 102_400_000);
  assert.equal(health.free_bytes, 1_024_000);
  assert.equal(health.runtime_bytes >= 10, true);
  assert.equal(health.scope, "runtime_metadata_only");
});

test("runtime pruning stops before any delete when a symlink or junction is present", async (t) => {
  const context = await fixture(t);
  const expiredPreview = path.join(context.runtimeRoot, "previews", "expired.json");
  await writeJson(expiredPreview, {
    schema_version: 1,
    expires_at: "2026-07-01T00:00:00.000Z",
  });
  const outside = path.join(context.base, "outside-runtime");
  const unsafeLink = path.join(context.runtimeRoot, "recovery", "unsafe-link");
  await mkdir(outside, { recursive: true });
  await mkdir(path.dirname(unsafeLink), { recursive: true });
  try {
    await symlink(outside, unsafeLink, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`This platform cannot create the symlink fixture: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    maintainRuntimeArtifacts({
      store: context.store,
      clock: () => new Date("2026-08-30T12:00:00.000Z"),
    }),
    OperationsBoundaryError,
  );
  assert.equal(
    await pathExists(expiredPreview),
    true,
    "preflight must find every unsafe entry before deleting an otherwise expired preview",
  );
});

test("schema lint snapshots corrupt canonical files only under runtime quarantine", async (t) => {
  const context = await fixture(t);
  await createEntity(context.store, {
    entity_type: "Review",
    entity_id: "review-one",
    payload: reviewPayload({ title: "First review", outcome: "No change" }),
  });
  const canonical = path.join(context.intelRoot, "reviews", "review-one.md");
  const tampered = (await readFile(canonical, "utf8")).replace("revision: 1", "revision: 8");
  await writeFile(canonical, tampered, "utf8");
  const wikiBefore = await readFile(context.wikiSentinel, "utf8");

  const report = await lintCanonicalState({
    store: context.store,
    clock: () => new Date("2026-07-29T13:30:00.000Z"),
    quarantineCorrupt: true,
  });
  assert.equal(report.ok, false);
  assert.equal(report.invalid_count, 1);
  assert.match(report.invalid[0].message, /frontmatter mismatch/i);
  assert.equal(report.invalid[0].quarantine.state, "snapshotted");

  const quarantineSnapshot = path.join(
    context.runtimeRoot,
    "quarantine",
    "canonical",
    "2026-07-29T13-30-00-000Z",
    ...report.invalid[0].quarantine.relative_path.split("/"),
  );
  assert.equal(await readFile(quarantineSnapshot, "utf8"), tampered);
  assert.equal(await readFile(canonical, "utf8"), tampered, "lint must not move or rewrite live state");
  assert.equal(await readFile(context.wikiSentinel, "utf8"), wikiBefore);
  assert.ok(
    (await readdir(path.join(context.runtimeRoot, "lint-reports"))).includes("latest.json"),
  );
});

test("schema lint rejects imported Known evidence that bypassed the verified S0-S8 gate", async (t) => {
  const context = await fixture(t);
  const timestamp = "2026-07-29T12:00:00.000Z";
  const { markdown } = serializeCanonicalMarkdown({
    schema_version: 1,
    entity_type: "Situation",
    entity_id: "unsafe-imported-known",
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
    payload: situationPayload({
      evidence: [{
        kind: "known",
        text: "An imported claim must not bypass canonical verification.",
        evidence_status: "unverified_external",
        s0_s8_state: "completed",
      }],
    }),
  });
  const canonical = path.join(
    context.intelRoot,
    "situations",
    "unsafe-imported-known.md",
  );
  await writeFile(canonical, markdown, "utf8");

  const report = await lintCanonicalState({
    store: context.store,
    clock: () => new Date("2026-07-29T13:45:00.000Z"),
    quarantineCorrupt: false,
    writeReport: false,
  });
  assert.equal(report.ok, false);
  assert.equal(report.invalid_count, 1);
  assert.equal(report.invalid[0].relative_path, "situations/unsafe-imported-known.md");
  assert.match(report.invalid[0].message, /schema validation/i);
});

test("Decision Brief is citation-complete, bounded to 3–6 minutes, and transcript-first", async () => {
  const items = [
    {
      entity_type: "Situation",
      entity_id: "fed-policy",
      revision: 3,
      updated_at: "2026-07-29T11:00:00.000Z",
      payload: {
        title: "美國通膨與 Fed 政策方向",
        current_assessment: "官方通膨降溫，但服務價格與薪資仍讓政策轉向的時間存在不確定性。",
        now: "最新數據改變了降息路徑的機率分布，但還沒有推翻中期判斷。",
        why_it_matters: "利率路徑會同時影響美元、長債、風險偏好與高估值資產的折現率。",
        unknown: "不同來源的 as-of 不同，而且下一次官方數據仍可能反轉目前訊號。",
        next_action: "在下一份 BLS CPI 公布後，更新 Before／Now 並檢查既有 watch condition。",
        sources: [
          {
            title: "BLS CPI",
            href: "https://www.bls.gov/cpi/",
            as_of: "2026-07-29",
          },
        ],
      },
    },
    {
      entity_type: "Mission",
      entity_id: "dogfood-alpha",
      revision: 1,
      updated_at: "2026-07-29T11:05:00.000Z",
      payload: {
        objective: "完成個人情報系統七日 dogfood",
        why_now: "需要用真實工作節奏確認 Today、Inbox、Situation、Mission 與 Review 能否形成閉環。",
        unknown: "目前還不知道提醒密度是否會造成訊息疲勞，也沒有跨休眠週期的完整資料。",
        next_action: "每天只處理最多三個 Needs You，並記錄 No Change 與阻塞原因。",
        sources: [
          {
            title: "Canonical mission state",
            href: "intel-os://entity/Mission/dogfood-alpha?revision=1",
            as_of: "2026-07-29",
          },
        ],
      },
    },
  ];

  const brief = await projectDecisionBrief({
    items,
    ttsAdapter: createDisabledTtsAdapter("Transcript is the Alpha deliverable"),
    clock: () => new Date("2026-07-29T11:30:00.000Z"),
  });
  assert.equal(brief.state, "ready");
  assert.ok(brief.duration_seconds_estimate >= 180);
  assert.ok(brief.duration_seconds_estimate <= 360);
  assert.equal(brief.citation_audit.valid, true);
  assert.equal(brief.citation_audit.source_count, 2);
  assert.equal(brief.audio.state, "disabled");
  assert.equal(brief.audio.can_synthesize, false);
  assert.equal(brief.audio.artifact_path, null);
  assert.deepEqual(
    brief.sources.map((source) => source.href),
    [
      "https://www.bls.gov/cpi/",
      "intel-os://entity/Mission/dogfood-alpha?revision=1",
    ],
  );
  const transcript = brief.transcript.join("\n");
  assert.match(transcript, /\[S1\]/);
  assert.match(transcript, /\[S2\]/);

  const quiet = await projectDecisionBrief({
    items: [],
    ttsAdapter: createUnavailableTtsAdapter(),
  });
  assert.equal(quiet.state, "quiet");
  assert.equal(quiet.sources.length, 0);
  assert.equal(quiet.audio.state, "unavailable");
});

test("Decision Brief replaces private Telegram locators with canonical citations", async () => {
  const brief = await projectDecisionBrief({
    items: [
      {
        entity_type: "InboxItem",
        entity_id: "telegram-explicit-submit-10-20",
        revision: 2,
        updated_at: "2026-07-29T11:00:00.000Z",
        payload: {
          title: "User-submitted lead",
          summary: "An unverified lead awaiting triage.",
          why_it_matters: "The user explicitly submitted it for review.",
          source_type: "telegram",
          source_url: "telegram://chat/10/message/20",
        },
      },
    ],
    ttsAdapter: createDisabledTtsAdapter("Transcript is the Alpha deliverable"),
  });

  assert.equal(brief.state, "ready");
  assert.equal(brief.sources.length, 1);
  assert.equal(
    brief.sources[0].href,
    "intel-os://entity/InboxItem/telegram-explicit-submit-10-20?revision=2",
  );
  assert.doesNotMatch(JSON.stringify(brief), /telegram:\/\/|chat\/10|message\/20/);
});

test("login task templates keep restart semantics and a localhost-only boundary", async () => {
  const install = await readFile(
    new URL("../scripts/install-intelos-login-task.ps1", import.meta.url),
    "utf8",
  );
  const start = await readFile(
    new URL("../scripts/start-intelos-local.ps1", import.meta.url),
    "utf8",
  );
  assert.match(install, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(install, /-RestartCount 6/);
  assert.match(install, /-RestartInterval/);
  assert.match(install, /-MultipleInstances IgnoreNew/);
  assert.match(install, /Get-Command node\.exe/);
  assert.match(install, /-NodePath/);
  assert.match(install, /127\.0\.0\.1/);
  assert.match(start, /127\.0\.0\.1/);
  assert.doesNotMatch(`${install}\n${start}`, /0\.0\.0\.0|--open|webhook/i);
});
