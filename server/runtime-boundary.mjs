import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export const RUNTIME_DIRECTORY_LAYOUT = Object.freeze([
  "previews",
  "locks",
  "recovery",
  "transactions",
  path.join("transactions", "store"),
  "state",
  "secrets",
  "checkpoints",
  "encrypted-telegram",
  "quarantine",
  path.join("quarantine", "telegram"),
  "cache",
  "queue",
  "backups",
  path.join("backups", "daily"),
  "lint-reports",
  "exports",
]);

export class RuntimeBoundaryError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RuntimeBoundaryError";
    this.code = "RUNTIME_BOUNDARY_ERROR";
  }
}

function pathKey(value) {
  const normalized = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function pathsEqual(left, right) {
  return pathKey(left) === pathKey(right);
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new RuntimeBoundaryError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

export function assertRuntimeOutsideOneDrive(runtimeRoot, { env = process.env } = {}) {
  const resolved = absolutePath(runtimeRoot, "runtimeRoot");
  const oneDriveRoots = [
    env.OneDrive,
    env.OneDriveConsumer,
    env.OneDriveCommercial,
  ]
    .filter((value) => typeof value === "string" && path.isAbsolute(value))
    .map((value) => path.resolve(value));
  const hasOneDriveSegment = resolved
    .split(/[\\/]+/)
    .some((segment) => segment.toLocaleLowerCase("en-US") === "onedrive");
  if (
    hasOneDriveSegment ||
    oneDriveRoots.some((oneDriveRoot) =>
      isInside(oneDriveRoot, resolved) || isInside(resolved, oneDriveRoot))
  ) {
    throw new RuntimeBoundaryError("runtimeRoot must not be stored in OneDrive");
  }
  return resolved;
}

async function inspectDirectoryPath(target, label, { mustExist = false } = {}) {
  const resolvedTarget = absolutePath(target, label);
  let anchor = resolvedTarget;
  let anchorInfo;
  while (true) {
    try {
      anchorInfo = await lstat(anchor);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(anchor);
      if (parent === anchor) throw error;
      anchor = parent;
    }
  }
  if (anchorInfo.isSymbolicLink()) {
    throw new RuntimeBoundaryError(
      `${label} must not traverse a symbolic link, junction, or reparse-point link`,
    );
  }
  if (!anchorInfo.isDirectory()) {
    throw new RuntimeBoundaryError(`${label} must resolve through directories only`);
  }
  let lexicalCursor = anchor;
  let physicalCursor = await realpath(anchor);
  if (!pathsEqual(physicalCursor, anchor)) {
    throw new RuntimeBoundaryError(
      `${label} traverses a junction or reparse point outside its expected path`,
    );
  }
  const missingSegments = [];
  let missing = false;

  for (const segment of path.relative(anchor, resolvedTarget).split(path.sep).filter(Boolean)) {
    lexicalCursor = path.join(lexicalCursor, segment);
    if (missing) {
      missingSegments.push(segment);
      continue;
    }

    let info;
    try {
      info = await lstat(lexicalCursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing = true;
      missingSegments.push(segment);
      continue;
    }

    if (info.isSymbolicLink()) {
      throw new RuntimeBoundaryError(
        `${label} must not traverse a symbolic link, junction, or reparse-point link`,
      );
    }
    if (!info.isDirectory()) {
      throw new RuntimeBoundaryError(`${label} must resolve through directories only`);
    }

    const physical = await realpath(lexicalCursor);
    const expected = path.resolve(physicalCursor, segment);
    if (!pathsEqual(physical, expected)) {
      throw new RuntimeBoundaryError(
        `${label} traverses a junction or reparse point outside its expected path`,
      );
    }
    physicalCursor = physical;
  }

  if (mustExist && missingSegments.length > 0) {
    throw new RuntimeBoundaryError(`${label} must be an existing real directory`);
  }

  return Object.freeze({
    configured: resolvedTarget,
    resolved: path.resolve(physicalCursor, ...missingSegments),
    exists: missingSegments.length === 0,
  });
}

function normalizeDirectories(runtimeRoot, directories) {
  if (!Array.isArray(directories)) {
    throw new TypeError("directories must be an array");
  }
  const unique = new Map();
  for (const value of directories) {
    const directory = absolutePath(value, "runtime directory");
    if (!isInside(runtimeRoot, directory)) {
      throw new RuntimeBoundaryError("Runtime directory escaped runtimeRoot");
    }
    unique.set(pathKey(directory), directory);
  }
  return [...unique.values()].sort((left, right) => {
    const depth = (value) => path.relative(runtimeRoot, value).split(path.sep).filter(Boolean).length;
    return depth(left) - depth(right) || left.localeCompare(right);
  });
}

export async function preflightRuntimeDirectories({
  runtimeRoot,
  directories = [],
  env = process.env,
  mustExist = false,
} = {}) {
  const configuredRoot = assertRuntimeOutsideOneDrive(runtimeRoot, { env });
  const normalizedDirectories = normalizeDirectories(configuredRoot, directories);
  const rootPlan = await inspectDirectoryPath(configuredRoot, "runtimeRoot", { mustExist });
  assertRuntimeOutsideOneDrive(rootPlan.resolved, { env });

  const directoryPlans = [];
  for (const directory of normalizedDirectories) {
    const plan = await inspectDirectoryPath(directory, "runtime directory", { mustExist });
    if (!isInside(rootPlan.resolved, plan.resolved)) {
      throw new RuntimeBoundaryError("Runtime directory escaped the physical runtimeRoot");
    }
    directoryPlans.push(plan);
  }
  return Object.freeze({
    runtimeRoot: rootPlan,
    directories: Object.freeze(directoryPlans),
  });
}

export async function prepareRuntimeDirectories({
  runtimeRoot,
  directories = [],
  env = process.env,
} = {}) {
  const configuredRoot = assertRuntimeOutsideOneDrive(runtimeRoot, { env });
  const normalizedDirectories = normalizeDirectories(configuredRoot, directories);

  // Preflight every requested destination before the first mkdir. This prevents
  // an unsafe later child from leaving an otherwise partially initialized tree.
  const before = await preflightRuntimeDirectories({
    runtimeRoot: configuredRoot,
    directories: normalizedDirectories,
    env,
  });

  await mkdir(configuredRoot, { recursive: true });
  for (const directory of normalizedDirectories) {
    await mkdir(directory, { recursive: true });
  }

  const after = await preflightRuntimeDirectories({
    runtimeRoot: configuredRoot,
    directories: normalizedDirectories,
    env,
    mustExist: true,
  });
  if (!pathsEqual(before.runtimeRoot.resolved, after.runtimeRoot.resolved)) {
    throw new RuntimeBoundaryError("runtimeRoot changed while directories were being prepared");
  }
  for (let index = 0; index < before.directories.length; index += 1) {
    if (!pathsEqual(before.directories[index].resolved, after.directories[index].resolved)) {
      throw new RuntimeBoundaryError(
        "Runtime directory changed while directories were being prepared",
      );
    }
  }
  return after;
}

export async function prepareRuntimeDirectory(runtimeRoot, directory, options = {}) {
  const prepared = await prepareRuntimeDirectories({
    runtimeRoot,
    directories: [directory],
    ...options,
  });
  return prepared.directories[0].resolved;
}

export function runtimeLayoutDirectories(runtimeRoot) {
  const root = absolutePath(runtimeRoot, "runtimeRoot");
  return RUNTIME_DIRECTORY_LAYOUT.map((relative) => path.join(root, relative));
}
