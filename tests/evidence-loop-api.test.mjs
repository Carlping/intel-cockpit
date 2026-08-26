import assert from "node:assert/strict";
import test from "node:test";
import { createApiHandler } from "../server/api/index.mjs";

async function request(api, pathname, { method = "GET", body } = {}) {
  const response = await api.fetch(new Request(`http://127.0.0.1${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { response, value: await response.json() };
}

test("v2 evidence-loop API projects closure state and forwards local setup commands", async () => {
  const calls = [];
  const projection = {
    mode: "fact_context_reaction_v1",
    facts: [{ external_event_id: "sec:one" }],
    macro_background: [{ series_id: "DFF" }],
    market_reactions: [],
  };
  const store = {
    list: async () => [],
    preview: async () => { throw new Error("not used"); },
  };
  const api = createApiHandler({
    store,
    connectors: {
      evidenceLoop: {
        getProjection: async () => projection,
        setupSec: async (body) => { calls.push(["sec", body]); return { configured: true }; },
        setupFred: async (body) => { calls.push(["fred", body]); return { configured: true }; },
        refresh: async (body) => { calls.push(["refresh", body]); return { ok: true }; },
      },
    },
  });

  const direct = await request(api, "/api/v2/evidence-loop");
  assert.equal(direct.response.status, 200);
  assert.equal(direct.value.data.mode, "fact_context_reaction_v1");

  const now = await request(api, "/api/v2/now");
  assert.deepEqual(now.value.data.evidence_loop, projection);
  const legacy = await request(api, "/api/v1/now");
  assert.equal(legacy.value.data.evidence_loop, undefined);

  assert.equal((await request(api, "/api/v2/evidence-loop/sec/setup", { method: "POST", body: { contact_email: "a@example.com" } })).response.status, 200);
  assert.equal((await request(api, "/api/v2/evidence-loop/fred/setup", { method: "POST", body: { api_key: "key" } })).response.status, 200);
  assert.equal((await request(api, "/api/v2/evidence-loop/refresh", { method: "POST", body: {} })).response.status, 200);
  assert.deepEqual(calls, [
    ["sec", { contact_email: "a@example.com" }],
    ["fred", { api_key: "key" }],
    ["refresh", {}],
  ]);
});
