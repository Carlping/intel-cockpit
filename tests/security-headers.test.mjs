import assert from "node:assert/strict";
import test from "node:test";
import { addScriptNonces, contentSecurityPolicy } from "../server/security-headers.mjs";

test("adds a nonce to every bootstrap script without weakening script-src", () => {
  const nonce = "fixed-test-nonce";
  const html = '<html><script>boot()</script><script src="/app.js"></script></html>';
  const secured = addScriptNonces(html, nonce);

  assert.equal((secured.match(/nonce="fixed-test-nonce"/g) ?? []).length, 2);
  assert.match(contentSecurityPolicy(nonce), /script-src 'self' 'nonce-fixed-test-nonce'/);
  assert.doesNotMatch(contentSecurityPolicy(nonce), /script-src[^;]*'unsafe-inline'/);
});

test("does not duplicate an existing script nonce", () => {
  const html = '<script nonce="existing">boot()</script>';
  assert.equal(addScriptNonces(html, "new"), html);
});

test("keeps non-document responses on a self-only script policy", () => {
  assert.match(contentSecurityPolicy(), /script-src 'self'/);
  assert.doesNotMatch(contentSecurityPolicy(), /nonce-/);
});
