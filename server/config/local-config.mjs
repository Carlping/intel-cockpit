import { readFileSync as nodeReadFile } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseExcludedSegments, PrivacyConfigurationError } from "../privacy/excluded-segments.mjs";

const REQUIRED_ROOTS = Object.freeze(["vaultRoot", "intelRoot"]);

export function loadLocalConfig({
  env = process.env,
  readFileImpl = nodeReadFile,
  configPath = env.INTEL_OS_CONFIG
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../intel-os.config.json"),
} = {}) {
  let fileConfig = {};
  try {
    const raw = readFileImpl(configPath, "utf8");
    fileConfig = JSON.parse(raw);
    if (!fileConfig || typeof fileConfig !== "object" || Array.isArray(fileConfig)) {
      throw new PrivacyConfigurationError("Local config must contain a JSON object");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof PrivacyConfigurationError) throw error;
      throw new PrivacyConfigurationError("Local config must contain valid JSON");
    }
  }

  const setting = (envName, fileName) => env[envName] ?? fileConfig[fileName];
  const vaultRoot = setting("INTEL_OS_VAULT_ROOT", "vaultRoot");
  const intelRoot = setting("INTEL_OS_ROOT", "intelRoot");
  const excludedSegments = setting("INTEL_OS_EXCLUDED_SEGMENTS", "excludedSegments");
  const missing = REQUIRED_ROOTS.filter((name) =>
    !(name === "vaultRoot" ? vaultRoot : intelRoot));
  if (!missing.length && (excludedSegments === undefined || excludedSegments === null || excludedSegments === "")) {
    missing.push("excludedSegments");
  }
  if (missing.length) {
    throw new PrivacyConfigurationError(
      "Required local configuration is missing; copy intel-os.config.example.json to intel-os.config.json and fill in vaultRoot, intelRoot, and excludedSegments",
    );
  }

  const resolvedVaultRoot = path.resolve(String(vaultRoot));
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return Object.freeze({
    vaultRoot: resolvedVaultRoot,
    wikiRoot: path.resolve(String(env.INTEL_OS_WIKI_ROOT ?? fileConfig.wikiRoot ?? path.join(resolvedVaultRoot, "wiki"))),
    intelRoot: path.resolve(String(intelRoot)),
    runtimeRoot: path.resolve(String(env.INTEL_OS_RUNTIME_ROOT ?? fileConfig.runtimeRoot ?? path.join(localAppData, "IntelOS"))),
    excludedSegments: parseExcludedSegments(excludedSegments),
  });
}
