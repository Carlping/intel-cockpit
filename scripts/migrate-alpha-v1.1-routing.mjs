import { pathToFileURL } from "node:url";
import {
  NotFoundError,
  ValidationError,
  createIntelligenceStore,
  resolveDefaultStorePaths,
  validateEntityPayload,
} from "../server/store/index.mjs";
import { assertSeedBoundaries, buildAlphaSeedDefinitions } from "./seed-alpha-v1.1.mjs";

const ROUTING_FIELDS = Object.freeze(["keywords", "feed_ids", "series_ids"]);
function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function migrationPatch(entity, definition, playbookUri) {
  const patch = {};
  const preserved = [];
  for (const field of ROUTING_FIELDS) {
    const expected = definition.payload[field];
    if (expected === undefined) continue;
    if (entity.payload[field] === undefined) patch[field] = expected;
    else if (!equal(entity.payload[field], expected)) preserved.push(field);
  }

  if (entity.entity_id === "situation-market-midterm-pullback") {
    const currentReference = entity.payload.playbook_reference;
    const currentUri = currentReference?.uri;
    if (!currentReference) {
      patch.playbook_reference = definition.payload.playbook_reference;
    } else if (currentUri !== playbookUri) {
      preserved.push("playbook_reference.uri");
    }
  }
  return { patch, preserved };
}

export async function runAlphaRoutingMigration({
  paths = resolveDefaultStorePaths(),
  apply = false,
  allowTestRoots = false,
  clock = () => new Date(),
  playbookUri,
} = {}) {
  if (typeof playbookUri !== "string" || !playbookUri.trim()) {
    throw new ValidationError("The required --playbook-uri argument is missing");
  }
  const safePaths = assertSeedBoundaries(paths, { allowTestRoots });
  const store = await createIntelligenceStore(safePaths);
  const definitions = buildAlphaSeedDefinitions({ clock })
    .filter((definition) => definition.entity_type === "Situation");
  const planned = [];
  const skipped = [];
  const preserved = [];

  // A migration never hides unrelated corruption in canonical state.
  for (const type of ["InboxItem", "Situation", "Mission", "Review"]) {
    await store.list(type, { limit: 10_000 });
  }

  for (const definition of definitions) {
    let entity;
    try {
      entity = await store.get("Situation", definition.entity_id);
    } catch (error) {
      if (error instanceof NotFoundError) {
        skipped.push({ entity_id: definition.entity_id, reason: "seed_entity_absent" });
        continue;
      }
      throw error;
    }
    const candidate = migrationPatch(entity, definition, playbookUri);
    for (const field of candidate.preserved) {
      preserved.push({
        entity_id: entity.entity_id,
        field,
        reason: "user_owned_value_preserved",
      });
    }
    if (!Object.keys(candidate.patch).length) {
      skipped.push({ entity_id: entity.entity_id, reason: "already_current_or_user_owned" });
      continue;
    }
    validateEntityPayload("Situation", { ...entity.payload, ...candidate.patch });
    planned.push({
      entity_id: entity.entity_id,
      base_revision: entity.revision,
      patch: candidate.patch,
    });
  }

  if (!apply || !planned.length) {
    return {
      mode: apply ? "apply" : "dry-run",
      target: safePaths.intelRoot,
      target_written: false,
      planned,
      skipped,
      preserved,
      committed: [],
    };
  }

  const previews = [];
  for (const operation of planned) {
    const preview = await store.preview({
      operation: "update",
      entity_type: "Situation",
      entity_id: operation.entity_id,
      base_revision: operation.base_revision,
      payload: operation.patch,
    });
    previews.push(preview.preview_id);
  }
  const entities = previews.length === 1
    ? [await store.commit(previews[0])]
    : (await store.commitBatch(previews)).entities;
  return {
    mode: "apply",
    target: safePaths.intelRoot,
    target_written: true,
    planned,
    skipped,
    preserved,
    committed: entities.map((entity) => ({
      entity_id: entity.entity_id,
      revision: entity.revision,
    })),
  };
}

async function main(argv) {
  const playbookIndex = argv.indexOf("--playbook-uri");
  const candidatePlaybookUri = playbookIndex >= 0 ? argv[playbookIndex + 1] : undefined;
  const playbookUri = candidatePlaybookUri && !candidatePlaybookUri.startsWith("--")
    ? candidatePlaybookUri
    : undefined;
  const unknown = argv.filter((argument, index) =>
    argument !== "--apply" && !(index === playbookIndex || index === playbookIndex + 1));
  if (unknown.length) throw new ValidationError(`Unknown migration option: ${unknown[0]}`);
  const result = await runAlphaRoutingMigration({ apply: argv.includes("--apply"), playbookUri });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
