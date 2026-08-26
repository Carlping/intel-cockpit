import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CorruptionError,
  NotFoundError,
  createIntelligenceStore,
} from "../server/store/index.mjs";
import { serializeCanonicalMarkdown } from "../server/store/markdown.mjs";

const STORE_MODULE_URL = new URL("../server/store/index.mjs", import.meta.url).href;

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "intel-os-transaction-"));
  const vaultRoot = path.join(base, "vault");
  const wikiRoot = path.join(vaultRoot, "wiki");
  const intelRoot = path.join(vaultRoot, "intelligence", "live");
  const runtimeRoot = path.join(base, "runtime");
  await mkdir(wikiRoot, { recursive: true });
  const options = { vaultRoot, wikiRoot, intelRoot, runtimeRoot };
  const store = await createIntelligenceStore(options);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, vaultRoot, wikiRoot, intelRoot, runtimeRoot, options, store };
}

async function createInbox(store, entityId, title) {
  const preview = await store.preview({
    operation: "create",
    entity_type: "InboxItem",
    entity_id: entityId,
    base_revision: 0,
    payload: { title, status: "new" },
  });
  return store.commit(preview.preview_id);
}

async function updateInboxPreview(store, entityId, baseRevision, title) {
  return store.preview({
    operation: "update",
    entity_type: "InboxItem",
    entity_id: entityId,
    base_revision: baseRevision,
    payload: { title },
  });
}

async function createInboxPreview(store, entityId, title) {
  return store.preview({
    operation: "create",
    entity_type: "InboxItem",
    entity_id: entityId,
    base_revision: 0,
    payload: { title, status: "new" },
  });
}

async function transactionManifests(runtimeRoot) {
  const directory = path.join(runtimeRoot, "transactions", "store");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"))),
  );
}

async function crashBatchAfterCanonical(context, previewIds, crashOperationIndex = 0) {
  const childScript = String.raw`
    const { createIntelligenceStore } = await import(${JSON.stringify(STORE_MODULE_URL)});
    const options = JSON.parse(process.argv[1]);
    const previewIds = JSON.parse(process.argv[2]);
    const crashOperationIndex = Number(process.argv[3]);
    const store = await createIntelligenceStore({
      ...options,
      faultInjector(phase, detail) {
        if (phase === "batch_after_canonical_before_wal" && detail.operation_index === crashOperationIndex) {
          process.exit(91);
        }
      },
    });
    await store.commitBatch(previewIds);
  `;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      childScript,
      JSON.stringify(context.options),
      JSON.stringify(previewIds),
      String(crashOperationIndex),
    ],
    { cwd: path.dirname(fileURLToPath(import.meta.url)), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code, signal] = await once(child, "exit");
  assert.equal(
    code,
    91,
    `child should stop at the power-loss failpoint (signal=${signal}, stdout=${stdout}, stderr=${stderr})`,
  );
}

test("commitBatch records exact before/after hashes and commits all entities", async (t) => {
  const context = await fixture(t);
  await createInbox(context.store, "batch-alpha", "Alpha before");
  await createInbox(context.store, "batch-beta", "Beta before");
  const alpha = await updateInboxPreview(context.store, "batch-alpha", 1, "Alpha after");
  const beta = await updateInboxPreview(context.store, "batch-beta", 1, "Beta after");

  const result = await context.store.commitBatch([alpha.preview_id, beta.preview_id]);

  assert.equal(result.entities.length, 2);
  assert.equal((await context.store.get("InboxItem", "batch-alpha")).revision, 2);
  assert.equal((await context.store.get("InboxItem", "batch-beta")).payload.title, "Beta after");
  const manifests = await transactionManifests(context.runtimeRoot);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].transaction_id, result.transaction_id);
  assert.equal(manifests[0].state, "committed");
  for (const operation of manifests[0].operations) {
    assert.equal(operation.phase, "applied");
    assert.match(operation.before_markdown_sha256, /^[a-f0-9]{64}$/);
    assert.match(operation.after_markdown_sha256, /^[a-f0-9]{64}$/);
    assert.equal(operation.before_revision, 1);
    assert.equal(operation.after_revision, 2);
  }
});

test("restart detects canonical commit missing from WAL and restores exact before Markdown", async (t) => {
  const context = await fixture(t);
  await createInbox(context.store, "power-alpha", "Power before");
  const beforeFilename = path.join(context.intelRoot, "inbox", "power-alpha.md");
  const exactBefore = await readFile(beforeFilename, "utf8");
  const alpha = await updateInboxPreview(context.store, "power-alpha", 1, "Power after");
  const beta = await createInboxPreview(context.store, "power-beta", "Should not exist");

  await crashBatchAfterCanonical(context, [alpha.preview_id, beta.preview_id], 1);
  assert.equal((await context.store.get("InboxItem", "power-alpha")).revision, 2);
  assert.equal((await context.store.get("InboxItem", "power-beta")).revision, 1);

  const restarted = await createIntelligenceStore(context.options);
  assert.equal(await readFile(beforeFilename, "utf8"), exactBefore);
  assert.equal((await restarted.get("InboxItem", "power-alpha")).revision, 1);
  await assert.rejects(restarted.get("InboxItem", "power-beta"), NotFoundError);

  const [manifest] = await transactionManifests(context.runtimeRoot);
  assert.equal(manifest.state, "rolled_back");
  assert.equal(manifest.operations[0].phase, "rolled_back");
  assert.equal(manifest.operations[1].phase, "rolled_back");
  assert.equal(manifest.operations[1].recovery_detected_applied, true);
});

test("recovery refuses to overwrite a canonical state changed after the interrupted batch", async (t) => {
  const context = await fixture(t);
  await createInbox(context.store, "race-alpha", "Race before");
  const alpha = await updateInboxPreview(context.store, "race-alpha", 1, "Batch after");
  const beta = await createInboxPreview(context.store, "race-beta", "Never applied");
  await crashBatchAfterCanonical(context, [alpha.preview_id, beta.preview_id]);

  const batchEntity = await context.store.get("InboxItem", "race-alpha");
  const candidate = structuredClone(batchEntity);
  delete candidate.content_sha256;
  const { markdown: concurrentMarkdown } = serializeCanonicalMarkdown({
    ...candidate,
    revision: 3,
    updated_at: new Date(Date.parse(batchEntity.updated_at) + 1_000).toISOString(),
    payload: { ...batchEntity.payload, title: "Concurrent newer write" },
  });
  const filename = path.join(context.intelRoot, "inbox", "race-alpha.md");
  await writeFile(filename, concurrentMarkdown, "utf8");

  await assert.rejects(context.store.recoverTransactions(), CorruptionError);
  assert.equal(await readFile(filename, "utf8"), concurrentMarkdown);
  assert.equal((await context.store.get("InboxItem", "race-alpha")).revision, 3);
  const [manifest] = await transactionManifests(context.runtimeRoot);
  assert.equal(manifest.state, "recovery_conflict");
  assert.equal(manifest.recovery_conflicts[0].entity_id, "race-alpha");
});

test("single commit, remove, and batch commit serialize through one writer lock", async (t) => {
  const context = await fixture(t);
  await createInbox(context.store, "lock-remove", "Remove me");
  const single = await createInboxPreview(context.store, "lock-single", "Single");
  const batched = await createInboxPreview(context.store, "lock-batch", "Batch");

  let activeWriters = 0;
  let maximumActiveWriters = 0;
  const faultInjector = async (phase) => {
    if (!["single_before_canonical", "remove_before_canonical", "batch_before_canonical"].includes(phase)) {
      return;
    }
    activeWriters += 1;
    maximumActiveWriters = Math.max(maximumActiveWriters, activeWriters);
    await new Promise((resolve) => setTimeout(resolve, 75));
    activeWriters -= 1;
  };
  const [singleStore, removeStore, batchStore] = await Promise.all(
    Array.from({ length: 3 }, () => createIntelligenceStore({ ...context.options, faultInjector })),
  );

  await Promise.all([
    singleStore.commit(single.preview_id),
    removeStore.remove("InboxItem", "lock-remove", { baseRevision: 1 }),
    batchStore.commitBatch([batched.preview_id]),
  ]);

  assert.equal(maximumActiveWriters, 1);
  assert.equal((await context.store.get("InboxItem", "lock-single")).revision, 1);
  assert.equal((await context.store.get("InboxItem", "lock-batch")).revision, 1);
  await assert.rejects(context.store.get("InboxItem", "lock-remove"), NotFoundError);
});
