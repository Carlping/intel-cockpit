import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WikiPathSecurityError,
  buildWikiAllowlistIndex,
  createWikiReadOnlyMonitor,
} from "../server/wiki/index.mjs";

const START = new Date("2026-07-29T12:00:00.000Z");

async function makeFixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "intel-os-wiki-"));
  const wikiRoot = path.join(workspace, "wiki");
  await fs.mkdir(wikiRoot, { recursive: true });
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return { workspace, wikiRoot };
}

function createPrivateAccessTrap(wikiRoot) {
  const calls = [];
  const guarded = {};
  for (const method of ["lstat", "readdir", "readFile", "realpath"]) {
    guarded[method] = async (...args) => {
      const target = path.resolve(String(args[0]));
      const relative = path.relative(wikiRoot, target);
      const segments = relative.split(path.sep).filter(Boolean);
      if (segments.some((segment) => segment.toLowerCase() === "private")) {
        throw new Error(`FORBIDDEN_PRIVATE_ACCESS:${method}:${relative}`);
      }
      calls.push({ method, target, relative });
      return fs[method](...args);
    };
  }
  return { fsImpl: guarded, calls };
}

test("initial allowlist indexes only Markdown and never enters the excluded subtree", async (t) => {
  const { wikiRoot } = await makeFixture(t);
  await fs.mkdir(path.join(wikiRoot, "macro"), { recursive: true });
  await fs.mkdir(path.join(wikiRoot, "private"), { recursive: true });
  await fs.writeFile(path.join(wikiRoot, "macro", "fed note.md"), "# Fed\nRates unchanged.\n");
  await fs.writeFile(path.join(wikiRoot, "macro", "ignore.txt"), "not markdown");
  await fs.writeFile(path.join(wikiRoot, "private", "private.md"), "must never be read");

  const { fsImpl, calls } = createPrivateAccessTrap(wikiRoot);
  const index = await buildWikiAllowlistIndex({
    wikiRoot,
    vaultName: "wiki",
    excludedSegments: ["private"],
    fsImpl,
    clock: () => START,
  });

  assert.equal(index.length, 1);
  assert.equal(index[0].relative_path, "macro/fed note.md");
  assert.equal(index[0].size, Buffer.byteLength("# Fed\nRates unchanged.\n"));
  assert.match(index[0].mtime, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(index[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    index[0].obsidian_uri,
    "obsidian://open?vault=wiki&file=macro%2Ffed+note.md",
  );
  assert.ok(calls.every(({ relative }) => !relative.toLowerCase().includes("private")));
});

test("event hints detect add, content modification, metadata-only touch, and deletion", async (t) => {
  const { wikiRoot } = await makeFixture(t);
  const note = path.join(wikiRoot, "note.md");
  await fs.writeFile(note, "alpha");
  let now = START.getTime();
  const monitor = createWikiReadOnlyMonitor({ wikiRoot, excludedSegments: ["private"], clock: () => new Date(now) });

  const initial = await monitor.initialize();
  const alphaHash = initial.allowlist_index[0].sha256;
  assert.equal(initial.mode, "full");
  assert.equal(initial.added.length, 1);

  await fs.writeFile(note, "bravo");
  now += 100;
  const changed = await monitor.reconcile({ hints: ["note.md"] });
  assert.equal(changed.mode, "hint");
  assert.equal(changed.modified.length, 1);
  assert.notEqual(changed.modified[0].after.sha256, alphaHash);
  assert.equal(changed.handoff_drafts.length, 1);
  assert.equal(changed.handoff_drafts[0].status, "draft_requires_human_acceptance");
  assert.equal(changed.handoff_drafts[0].source_content_included, false);
  assert.equal(changed.handoff_drafts[0].source_instructions_are_executable, false);
  assert.equal(changed.handoff_drafts[0].write_target, null);
  assert.deepEqual(
    changed.handoff_drafts[0].pipeline.map(({ step, status }) => [step, status]),
    Array.from({ length: 9 }, (_, index) => [`S${index}`, "pending"]),
  );

  const stableHash = changed.allowlist_index[0].sha256;
  const touchedAt = new Date(START.getTime() + 60_000);
  await fs.utimes(note, touchedAt, touchedAt);
  now += 100;
  const touched = await monitor.reconcile({ hints: [note] });
  assert.equal(touched.modified.length, 0);
  assert.equal(touched.metadata_changed.length, 1);
  assert.equal(touched.allowlist_index[0].sha256, stableHash);
  assert.equal(touched.handoff_drafts.length, 0);

  await fs.mkdir(path.join(wikiRoot, "career"));
  await fs.writeFile(path.join(wikiRoot, "career", "plan.md"), "next action");
  now += 100;
  const added = await monitor.reconcile({ hints: ["career"] });
  assert.deepEqual(added.added.map((entry) => entry.relative_path), ["career/plan.md"]);

  await fs.rm(note);
  now += 100;
  const removed = await monitor.reconcile({ hints: ["note.md"] });
  assert.deepEqual(removed.deleted.map((entry) => entry.relative_path), ["note.md"]);
  assert.deepEqual(
    monitor.getAllowlistIndex().map((entry) => entry.relative_path),
    ["career/plan.md"],
  );
});

test("five-minute full hash reconcile repairs missed watcher events", async (t) => {
  const { wikiRoot } = await makeFixture(t);
  await fs.writeFile(path.join(wikiRoot, "existing.md"), "existing");
  let now = START.getTime();
  const monitor = createWikiReadOnlyMonitor({
    wikiRoot,
    excludedSegments: ["private"],
    clock: () => new Date(now),
    fullReconcileIntervalMs: 5 * 60 * 1_000,
  });
  await monitor.initialize();

  await fs.writeFile(path.join(wikiRoot, "missed.md"), "missed add event");
  now += 4 * 60 * 1_000;
  const notDue = await monitor.reconcile();
  assert.equal(notDue.mode, "hint");
  assert.equal(notDue.added.length, 0);

  now += 60 * 1_000;
  const repairedAdd = await monitor.reconcile();
  assert.equal(repairedAdd.mode, "full");
  assert.deepEqual(repairedAdd.added.map((entry) => entry.relative_path), ["missed.md"]);

  await fs.rm(path.join(wikiRoot, "existing.md"));
  now += 5 * 60 * 1_000;
  const repairedDelete = await monitor.reconcile();
  assert.deepEqual(repairedDelete.deleted.map((entry) => entry.relative_path), ["existing.md"]);
});

test("path traversal and excluded-subtree hints are rejected before filesystem access", async (t) => {
  const { wikiRoot, workspace } = await makeFixture(t);
  await fs.mkdir(path.join(wikiRoot, "private"));
  await fs.writeFile(path.join(wikiRoot, "private", "private.md"), "private");
  await fs.writeFile(path.join(workspace, "outside.md"), "outside");
  const { fsImpl, calls } = createPrivateAccessTrap(wikiRoot);
  const monitor = createWikiReadOnlyMonitor({ wikiRoot, fsImpl, excludedSegments: ["private"], clock: () => START });
  await monitor.initialize();

  const before = calls.length;
  assert.throws(
    () => monitor.recordEventHint("private/private.md"),
    (error) => error instanceof WikiPathSecurityError && error.code === "prohibited_wiki_subtree",
  );
  assert.equal(calls.length, before);
  assert.throws(
    () => monitor.recordEventHint("../outside.md"),
    (error) => error instanceof WikiPathSecurityError && error.code === "wiki_path_escape",
  );
  assert.throws(
    () => monitor.recordEventHint(path.join(workspace, "outside.md")),
    (error) => error instanceof WikiPathSecurityError && error.code === "wiki_path_escape",
  );
});

test("directory links are never followed during full or hinted reconcile", async (t) => {
  const { wikiRoot, workspace } = await makeFixture(t);
  const outside = path.join(workspace, "outside");
  const linked = path.join(wikiRoot, "linked");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.md"), "outside secret");
  await fs.writeFile(path.join(wikiRoot, "safe.md"), "safe");
  try {
    await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("This Windows environment does not permit creating a test junction");
      return;
    }
    throw error;
  }

  const reads = [];
  const fsImpl = {
    ...Object.fromEntries(
      ["lstat", "readdir", "realpath"].map((method) => [
        method,
        async (...args) => fs[method](...args),
      ]),
    ),
    readFile: async (...args) => {
      reads.push(path.resolve(String(args[0])));
      return fs.readFile(...args);
    },
  };
  let now = START.getTime();
  const monitor = createWikiReadOnlyMonitor({ wikiRoot, fsImpl, excludedSegments: ["private"], clock: () => new Date(now) });
  const initial = await monitor.initialize();
  assert.deepEqual(initial.allowlist_index.map((entry) => entry.relative_path), ["safe.md"]);
  assert.deepEqual(initial.rejected, [{ relative_path: "linked", reason: "linked_wiki_path" }]);
  assert.ok(reads.every((readPath) => !readPath.endsWith(path.join("linked", "secret.md"))));

  now += 100;
  const hinted = await monitor.reconcile({ hints: ["linked/secret.md"] });
  assert.deepEqual(hinted.rejected, [
    { relative_path: "linked/secret.md", reason: "linked_wiki_path" },
  ]);
  assert.ok(reads.every((readPath) => !readPath.endsWith(path.join("linked", "secret.md"))));
  assert.deepEqual(hinted.allowlist_index.map((entry) => entry.relative_path), ["safe.md"]);
});
