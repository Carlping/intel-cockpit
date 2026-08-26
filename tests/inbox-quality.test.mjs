import assert from "node:assert/strict";
import test from "node:test";

import { activeInboxEntity } from "../server/api/router.mjs";

function inbox(payload) {
  return { entity_type: "InboxItem", payload: { status: "new", ...payload } };
}

test("Inbox quality gate rejects placeholders and keeps decision-grade content", () => {
  assert.equal(activeInboxEntity(inbox({
    source_type: "wiki_read_only",
    summary: "Wiki note modified; review the existing ingest before promoting it into a Situation.",
    source_payload: { source_content_included: false },
  })), false);
  assert.equal(activeInboxEntity(inbox({
    source_type: "wiki_read_only",
    summary: "利率與流動性成為新的跨資產主線，並命中既有 Fed 與回調策略的觀察條件；下一步需要等待官方數字與市場反應。",
    source_payload: { decision_grade: true, source_excerpt_included: true },
  })), true);
  assert.equal(activeInboxEntity(inbox({
    source_type: "official_feed",
    routing_state: "quiet_inbox",
    summary: "This is a long but unrelated automated item that does not match an active decision context.",
  })), false);
  assert.equal(activeInboxEntity(inbox({
    source_type: "official_feed",
    routing_state: "inbox",
    summary: "",
  })), false);
  assert.equal(activeInboxEntity(inbox({
    source_type: "official_feed",
    routing_state: "inbox",
    summary: "The Federal Reserve released a policy statement with enough source detail to evaluate.",
  })), true);
  assert.equal(activeInboxEntity(inbox({
    source_type: "telegram",
    summary: "CPI actual 3.1%, forecast 3.0%, previous 3.0%.",
  })), true);
});
