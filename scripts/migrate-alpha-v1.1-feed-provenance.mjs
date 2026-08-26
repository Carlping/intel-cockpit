import { pathToFileURL } from "node:url";
import { listOfficialFeedSpecs } from "../server/connectors/official-feeds.mjs";
import {
  ValidationError,
  createIntelligenceStore,
  resolveDefaultStorePaths,
  validateEntityPayload,
} from "../server/store/index.mjs";
import { assertSeedBoundaries } from "./seed-alpha-v1.1.mjs";

const OFFICIAL_FEED_IDS = Object.freeze(
  listOfficialFeedSpecs().map((spec) => spec.feed_id).sort((left, right) => right.length - left.length),
);

function inferOfficialFeedId(payload) {
  if (payload.source_type !== "official_feed" || typeof payload.external_event_id !== "string") return undefined;
  return OFFICIAL_FEED_IDS.find((feedId) => payload.external_event_id.startsWith(`${feedId}:`));
}

export async function runAlphaFeedProvenanceMigration({
  paths = resolveDefaultStorePaths(),
  apply = false,
  allowTestRoots = false,
} = {}) {
  const safePaths = assertSeedBoundaries(paths, { allowTestRoots });
  const store = await createIntelligenceStore(safePaths);

  // Do not hide corruption in any canonical collection behind a targeted migration.
  for (const type of ["InboxItem", "Situation", "Mission", "Review"]) {
    await store.list(type, { limit: 10_000 });
  }

  const planned = [];
  const skipped = [];
  for (const entity of await store.list("InboxItem", { limit: 10_000 })) {
    if (typeof entity.payload.feed_id === "string" && entity.payload.feed_id) {
      skipped.push({ entity_id: entity.entity_id, reason: "feed_id_present" });
      continue;
    }
    const feedId = inferOfficialFeedId(entity.payload);
    if (!feedId) {
      skipped.push({ entity_id: entity.entity_id, reason: "not_recognized_official_feed" });
      continue;
    }
    validateEntityPayload("InboxItem", { ...entity.payload, feed_id: feedId });
    planned.push({
      entity_id: entity.entity_id,
      base_revision: entity.revision,
      patch: { feed_id: feedId },
    });
  }

  if (!apply || !planned.length) {
    return {
      mode: apply ? "apply" : "dry-run",
      target: safePaths.intelRoot,
      target_written: false,
      planned,
      skipped,
      committed: [],
    };
  }

  const previewIds = [];
  for (const operation of planned) {
    const preview = await store.preview({
      operation: "update",
      entity_type: "InboxItem",
      entity_id: operation.entity_id,
      base_revision: operation.base_revision,
      payload: operation.patch,
    });
    previewIds.push(preview.preview_id);
  }
  const entities = previewIds.length === 1
    ? [await store.commit(previewIds[0])]
    : (await store.commitBatch(previewIds)).entities;
  return {
    mode: "apply",
    target: safePaths.intelRoot,
    target_written: true,
    planned,
    skipped,
    committed: entities.map((entity) => ({ entity_id: entity.entity_id, revision: entity.revision })),
  };
}

async function main(argv) {
  const unknown = argv.filter((argument) => argument !== "--apply");
  if (unknown.length) throw new ValidationError(`Unknown migration option: ${unknown[0]}`);
  const result = await runAlphaFeedProvenanceMigration({ apply: argv.includes("--apply") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
