import assert from "node:assert/strict";
import test from "node:test";
import { containsExcludedSegment, parseExcludedSegments, PrivacyConfigurationError } from "../server/privacy/excluded-segments.mjs";
import { loadLocalConfig } from "../server/config/local-config.mjs";

test("excluded segments normalize, deduplicate, and freeze", () => {
  const segments = parseExcludedSegments(" Private,PRIVATE, work ");
  assert.deepEqual(segments, ["private", "work"]);
  assert.ok(Object.isFrozen(segments));
  assert.equal(containsExcludedSegment("notes\\PRIVATE\\x.md", segments), true);
  assert.equal(containsExcludedSegment("notes/public.md", segments), false);
});

test("excluded segments fail closed for invalid or empty configuration", () => {
  for (const value of ["", [".", ""] , ["private/sub"]]) {
    assert.throws(() => parseExcludedSegments(value), (error) => {
      assert.ok(error instanceof PrivacyConfigurationError);
      assert.equal(error.code, "privacy_configuration_error");
      return true;
    });
  }
});

test("local config requires roots and exclusions and honors environment precedence", () => {
  const config = loadLocalConfig({
    env: {
      INTEL_OS_VAULT_ROOT: "/env/vault",
      INTEL_OS_ROOT: "/env/intel",
      INTEL_OS_EXCLUDED_SEGMENTS: "private,archive",
      LOCALAPPDATA: "/env/local",
    },
    readFileImpl: () => JSON.stringify({
      vaultRoot: "/file/vault",
      intelRoot: "/file/intel",
      excludedSegments: ["file-only"],
    }),
    configPath: "/config/intel-os.config.json",
  });
  assert.equal(config.vaultRoot, "/env/vault");
  assert.equal(config.intelRoot, "/env/intel");
  assert.deepEqual(config.excludedSegments, ["private", "archive"]);
  assert.equal(config.wikiRoot, "/env/vault/wiki");
  assert.equal(config.runtimeRoot, "/env/local/IntelOS");
});

test("local config fails closed when required values are absent", () => {
  assert.throws(
    () => loadLocalConfig({ env: {}, readFileImpl: () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; } }),
    /copy intel-os\.config\.example\.json/,
  );
});
