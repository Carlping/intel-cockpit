import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildCognitiveBrief,
  buildMemoryPacket,
  depthIndex,
  READING_DEPTHS,
  serializeMemoryPacket,
} from "../app/cognitive-memory.mjs";

const fixture = {
  asOf: "2026-08-01T14:30:00.000Z",
  sourceRevision: 42,
  needsYou: [],
  changes: [{
    id: "change-1",
    domain: "Macro",
    title: "通膨路徑出現實質變化",
    before: "核心通膨黏著。",
    now: "官方序列共同降溫。",
    impact: "政策路徑的基準情境需要重估。",
  }],
  missions: [{
    id: "mission-1",
    domain: "Macro",
    title: "重估基準情境",
    objective: "更新政策路徑判斷",
    nextAction: "比較最近三期 CPI 與 PCE。",
    doneCondition: "形成一份可追溯的 Before → Now。",
    stopCondition: "資料修訂後方向不一致。",
    reviewDate: "2026-08-08",
    status: "active",
  }],
  watching: [{ label: "Fed 路徑", condition: "等待下一次 FOMC 聲明", state: "watching" }],
  connectors: [{ id: "bls", state: "healthy" }, { id: "bea", state: "stale" }],
  situations: [{
    id: "situation-1",
    domain: "Macro",
    title: "通膨路徑出現實質變化",
    status: "active",
    confidence: 68,
    currentAssessment: "降溫方向成立，但仍需下一期資料確認。",
    before: "核心通膨黏著。",
    now: "官方序列共同降溫。",
    watchCondition: "下一期 CPI 與 PCE 同方向。",
    stopCondition: "任一主序列重新加速。",
    reopenCondition: "FOMC 或官方通膨資料更新。",
    nextReview: "2026-08-08",
    evidence: [
      { id: "known-1", kind: "known", text: "CPI 連續兩期降溫。", evidenceStatus: "verified", source: { label: "BLS", href: "https://www.bls.gov/cpi/" } },
      { id: "inference-1", kind: "inference", text: "政策壓力可能下降。" },
      { id: "unknown-1", kind: "unknown", text: "服務通膨是否持續改善仍未知。" },
      { id: "contra-1", kind: "contradiction", text: "薪資增速仍偏高。" },
    ],
    scenarioPaths: [{ id: "base", label: "基準", probability: 60, summary: "緩慢降溫", trigger: "主序列續降", invalidation: "重新加速" }],
  }],
  briefing: {
    generatedAt: "2026-08-01T14:30:00.000Z",
    status: "ready · Audio unavailable",
    duration: "約 4 分鐘",
    transcript: ["通膨路徑值得重估，但尚未形成行動訊號。"],
    sources: [{ label: "BLS", href: "https://www.bls.gov/cpi/", status: "2026-08-01" }],
  },
};

test("cognitive reader exposes five cumulative time budgets", () => {
  assert.deepEqual(
    READING_DEPTHS.map((item) => item.label),
    ["30 秒", "3 分鐘", "10 分鐘", "25 分鐘", "50 分鐘"],
  );
  assert.equal(depthIndex("scan"), 0);
  assert.equal(depthIndex("deep"), 4);
  assert.equal(depthIndex("not-a-depth"), 0);
});

test("cognitive brief keeps action, caveat, evidence kinds, and source identity", () => {
  const brief = buildCognitiveBrief(fixture);
  assert.equal(brief.orientation.state, "1 個實質變化");
  assert.equal(brief.orientation.nextAction, "比較最近三期 CPI 與 PCE。");
  assert.match(brief.orientation.uncertainty, /1 個資料來源不是 healthy/);
  assert.deepEqual(
    [brief.model.knownCount, brief.model.inferenceCount, brief.model.unknownCount, brief.model.contradictionCount],
    [1, 1, 1, 1],
  );
  assert.equal(brief.deepDive.sources.length, 1, "duplicate source URLs should not fork provenance");
  assert.equal(brief.memory.retrievalCues.length, 3);
});

test("memory packet is stable, indexable, and serializes every reading layer", () => {
  const packet = buildMemoryPacket(fixture, "understand");
  const second = buildMemoryPacket(fixture, "understand");
  assert.equal(packet.schema_version, "intel-memory-packet/1");
  assert.equal(packet.provenance.kind, "derived_snapshot");
  assert.equal(packet.provenance.source_revision, 42);
  assert.equal(packet.id, second.id);
  assert.equal(packet.reading_depth.id, "understand");
  assert.match(packet.index_text, /通膨路徑出現實質變化/);
  assert.ok(packet.tags.includes("intel-brief"));
  assert.equal(packet.source_refs[0].uri, "https://www.bls.gov/cpi/");

  const markdown = serializeMemoryPacket(packet);
  for (const heading of [
    "## 30 秒｜定位",
    "## 3 分鐘｜架構",
    "## 10 分鐘｜證據與建模",
    "## 25 分鐘｜決策與邊界",
    "## 50 分鐘｜深讀、查核與來源",
    "## 記憶化｜關閉原文後回想",
  ]) {
    assert.match(markdown, new RegExp(heading));
  }
  assert.match(markdown, /schema_version: "intel-memory-packet\/1"/);
  assert.match(markdown, /\[BLS\]\(https:\/\/www\.bls\.gov\/cpi\/\)/);
  assert.match(markdown, /現在唯一的下一步是什麼/);
});

test("published JSON Schema fixes the packet version, provenance, and five depth ids", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../docs/schemas/intel-memory-packet.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.properties.schema_version.const, "intel-memory-packet/1");
  assert.equal(schema.properties.provenance.properties.kind.const, "derived_snapshot");
  assert.deepEqual(
    schema.properties.reading_depth.properties.id.enum,
    ["scan", "map", "understand", "decide", "deep"],
  );
  for (const field of ["source_refs", "index_text", "memory", "provenance"]) {
    assert.ok(schema.required.includes(field));
  }
});
