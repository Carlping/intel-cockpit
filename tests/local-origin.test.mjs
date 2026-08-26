import assert from "node:assert/strict";
import test from "node:test";
import { localRequestAllowed } from "../server/local-origin.mjs";

const options = {
  allowedHosts: ["127.0.0.1:4173", "localhost:4173"],
  allowedOrigins: ["http://127.0.0.1:4173", "http://localhost:4173"],
};

test("local origin policy always requires an allowed Host", () => {
  assert.equal(localRequestAllowed({ ...options, host: "evil.test", pathname: "/" }), false);
  assert.equal(localRequestAllowed({ ...options, host: "127.0.0.1:4173", pathname: "/" }), true);
});

test("state-changing API requests require a matching Origin", () => {
  const base = { ...options, host: "127.0.0.1:4173", pathname: "/api/v2/commands/preview", method: "POST" };
  assert.equal(localRequestAllowed(base), false);
  assert.equal(localRequestAllowed({ ...base, origin: "http://evil.test" }), false);
  assert.equal(localRequestAllowed({ ...base, origin: "http://127.0.0.1:4173" }), true);
});

test("safe API requests tolerate a missing Origin but reject mismatches", () => {
  const base = { ...options, host: "localhost:4173", pathname: "/api/v1/now", method: "GET" };
  assert.equal(localRequestAllowed(base), true);
  assert.equal(localRequestAllowed({ ...base, origin: "http://evil.test" }), false);
});
