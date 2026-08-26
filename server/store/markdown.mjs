import { createHash } from "node:crypto";
import { CorruptionError, ValidationError } from "./errors.mjs";
import {
  normalizeEntityType,
  validateEntityPayload,
  validateLogicalId,
} from "./schema.mjs";

const DATA_START = "<!-- intel-os:canonical:start -->";
const DATA_END = "<!-- intel-os:canonical:end -->";

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function calculateContentHash(entity) {
  const content = { ...entity };
  delete content.content_sha256;
  return sha256(canonicalJson(content));
}

function cleanHeading(value) {
  return String(value ?? "Untitled")
    .replace(/[\r\n]+/g, " ")
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 200);
}

export function finalizeEntity(candidate) {
  const entity = structuredClone(candidate);
  entity.content_sha256 = calculateContentHash(entity);
  return entity;
}

export function serializeCanonicalMarkdown(candidate) {
  const entity = finalizeEntity(candidate);
  const title = cleanHeading(entity.payload?.title ?? entity.payload?.objective);
  const status = entity.payload?.status ? `- Status: \`${entity.payload.status}\`\n` : "";
  const json = JSON.stringify(entity, null, 2);

  return {
    entity,
    markdown: [
      "---",
      "intel_os_schema: 1",
      `entity_type: ${entity.entity_type}`,
      `entity_id: ${entity.entity_id}`,
      `revision: ${entity.revision}`,
      `updated_at: ${entity.updated_at}`,
      `content_sha256: ${entity.content_sha256}`,
      "---",
      "",
      `# ${title}`,
      "",
      `- Type: \`${entity.entity_type}\``,
      `- Revision: \`${entity.revision}\``,
      status.trimEnd(),
      "",
      "> Canonical IntelOS state. Edit through the local preview/commit API to preserve revision safety.",
      "",
      DATA_START,
      "```json",
      json,
      "```",
      DATA_END,
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n"),
  };
}

function extractJson(markdown) {
  const start = markdown.indexOf(DATA_START);
  const end = markdown.indexOf(DATA_END);
  if (start < 0 || end <= start) {
    throw new CorruptionError("Canonical Markdown data markers are missing");
  }

  const block = markdown.slice(start + DATA_START.length, end).trim();
  const match = /^```json\s*\n([\s\S]*?)\n```$/.exec(block);
  if (!match) throw new CorruptionError("Canonical Markdown JSON block is malformed");
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new CorruptionError("Canonical Markdown JSON is invalid", { cause: error });
  }
}

function extractFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new CorruptionError("Canonical Markdown frontmatter is missing");
  const fields = Object.create(null);
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new CorruptionError("Canonical Markdown frontmatter is malformed");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (Object.hasOwn(fields, key)) {
      throw new CorruptionError(`Duplicate canonical frontmatter field: ${key}`);
    }
    fields[key] = value;
  }
  return fields;
}

export function parseCanonicalMarkdown(markdown, expected = {}) {
  if (typeof markdown !== "string") {
    throw new ValidationError("Canonical Markdown must be text");
  }
  const frontmatter = extractFrontmatter(markdown);
  const entity = extractJson(markdown);
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    throw new CorruptionError("Canonical entity must be an object");
  }
  if (entity.schema_version !== 1) {
    throw new CorruptionError(`Unsupported schema version: ${entity.schema_version}`);
  }

  let entityType;
  let entityId;
  try {
    entityType = normalizeEntityType(entity.entity_type);
    entityId = validateLogicalId(entity.entity_id);
    validateEntityPayload(entityType, entity.payload);
  } catch (error) {
    throw new CorruptionError("Canonical entity failed schema validation", { cause: error });
  }

  if (expected.entity_type && entityType !== normalizeEntityType(expected.entity_type)) {
    throw new CorruptionError("Canonical entity type does not match its directory");
  }
  if (expected.entity_id && entityId !== expected.entity_id) {
    throw new CorruptionError("Canonical entity id does not match its filename");
  }
  if (!Number.isSafeInteger(entity.revision) || entity.revision < 1) {
    throw new CorruptionError("Canonical entity revision is invalid");
  }
  if (typeof entity.created_at !== "string" || typeof entity.updated_at !== "string") {
    throw new CorruptionError("Canonical entity timestamps are invalid");
  }

  const calculated = calculateContentHash(entity);
  if (entity.content_sha256 !== calculated) {
    throw new CorruptionError("Canonical entity hash verification failed");
  }
  const expectedFrontmatter = {
    intel_os_schema: String(entity.schema_version),
    entity_type: entity.entity_type,
    entity_id: entity.entity_id,
    revision: String(entity.revision),
    updated_at: entity.updated_at,
    content_sha256: entity.content_sha256,
  };
  for (const [key, value] of Object.entries(expectedFrontmatter)) {
    if (frontmatter[key] !== value) {
      throw new CorruptionError(`Canonical frontmatter mismatch: ${key}`);
    }
  }
  return entity;
}
