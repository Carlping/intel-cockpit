export const READING_DEPTHS = Object.freeze([
  Object.freeze({ id: "scan", label: "30 秒", task: "定位", minimumLayer: 0 }),
  Object.freeze({ id: "map", label: "3 分鐘", task: "架構", minimumLayer: 1 }),
  Object.freeze({ id: "understand", label: "10 分鐘", task: "建模", minimumLayer: 2 }),
  Object.freeze({ id: "decide", label: "25 分鐘", task: "判斷", minimumLayer: 3 }),
  Object.freeze({ id: "deep", label: "50 分鐘", task: "內化", minimumLayer: 4 }),
]);

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function tagify(value) {
  return text(value)
    .toLocaleLowerCase()
    .replace(/[\s/]+/gu, "-")
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function dayStamp(value) {
  const parsed = Date.parse(text(value));
  if (!Number.isFinite(parsed)) return "undated";
  return new Date(parsed).toISOString().slice(0, 10).replaceAll("-", "");
}

function slug(value) {
  const normalized = tagify(value).slice(0, 42);
  return normalized || "daily-brief";
}

function sourceKey(source) {
  return `${text(source?.href)}|${text(source?.label, text(source?.title))}`;
}

function collectSources(input, situation) {
  const sources = [];
  for (const source of list(input?.briefing?.sources)) {
    if (!text(source?.href)) continue;
    sources.push({
      label: text(source?.label, text(source?.title, "Source")),
      href: text(source.href),
      status: text(source?.status) || undefined,
    });
  }
  for (const evidence of list(situation?.evidence)) {
    if (!text(evidence?.source?.href)) continue;
    sources.push({
      label: text(evidence.source.label, text(evidence.sourceTitle, "Evidence")),
      href: text(evidence.source.href),
      status: text(evidence.evidenceStatus, text(evidence.asOf)) || undefined,
    });
  }
  const seen = new Set();
  return sources.filter((source) => {
    const key = sourceKey(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickPrimarySituation(input) {
  const situations = list(input?.situations);
  const changeTitle = text(list(input?.changes)[0]?.title);
  return situations.find((item) => text(item?.title) === changeTitle)
    ?? situations.find((item) => item?.materialChange === true)
    ?? situations.find((item) => item?.status === "active")
    ?? situations.find((item) => item?.status === "watch")
    ?? situations[0]
    ?? null;
}

export function depthIndex(depthId) {
  const index = READING_DEPTHS.findIndex((item) => item.id === depthId);
  return index < 0 ? 0 : index;
}

export function buildCognitiveBrief(input = {}) {
  const needs = list(input.needsYou);
  const changes = list(input.changes);
  const missions = list(input.missions);
  const watching = list(input.watching);
  const connectors = list(input.connectors);
  const situation = pickPrimarySituation(input);
  const primaryNeed = needs[0] ?? null;
  const primaryChange = changes[0] ?? null;
  const primaryMission = missions[0] ?? null;
  const weakConnectors = connectors.filter((item) => !["healthy", "manual"].includes(item?.state));
  const evidence = list(situation?.evidence).map((item, index) => ({
    id: text(item?.id, `evidence-${index + 1}`),
    kind: text(item?.kind, "unknown"),
    text: text(item?.text, "尚未填寫證據內容"),
    status: text(item?.evidenceStatus),
    asOf: text(item?.asOf, text(item?.observedAt)),
    source: item?.source && text(item.source.href)
      ? { label: text(item.source.label, "Source"), href: text(item.source.href) }
      : undefined,
  }));
  const sources = collectSources(input, situation);

  const state = needs.length
    ? `${needs.length} 件需要你決定`
    : changes.length
      ? `${changes.length} 個實質變化`
      : "目前無需行動";
  const headline = text(
    primaryNeed?.title,
    text(primaryChange?.title, text(situation?.title, "今天沒有需要升級的變化")),
  );
  const significance = text(
    primaryNeed?.summary,
    text(primaryChange?.impact, text(situation?.currentAssessment, "一般更新不會被拿來填滿畫面。")),
  );
  const nextAction = text(
    primaryMission?.nextAction,
    text(watching[0]?.condition, "保持監看；有新證據或明確條件命中時再回來。"),
  );
  const uncertainty = weakConnectors.length
    ? `${weakConnectors.length} 個資料來源不是 healthy；先確認 coverage，再提高信心。`
    : text(
      evidence.find((item) => item.kind === "unknown")?.text,
      text(situation?.stopCondition, "目前沒有會改變行動的重大缺口。"),
    );

  const before = text(primaryChange?.before, text(situation?.before, "尚未建立前一狀態基準。"));
  const now = text(primaryChange?.now, text(situation?.now, text(situation?.currentAssessment, headline)));
  const impact = text(primaryChange?.impact, significance);
  const statusTag = needs.length ? "needs-decision" : changes.length ? "material-change" : "quiet";
  const tags = unique([
    "intel-brief",
    statusTag,
    ...list(input.situations).map((item) => tagify(item?.domain)),
    ...missions.map((item) => tagify(item?.domain)),
  ]).slice(0, 12);

  const retrievalCues = [
    { prompt: "現在和之前相比，真正改變了什麼？", answer: now },
    { prompt: "現在唯一的下一步是什麼？", answer: nextAction },
    {
      prompt: "什麼條件會停止、推翻或重開目前判斷？",
      answer: unique([
        text(situation?.stopCondition),
        text(situation?.reopenCondition),
      ]).join("；") || uncertainty,
    },
  ];

  return {
    title: `今日理解包｜${headline}`,
    asOf: text(input.asOf, text(input?.briefing?.generatedAt, "未標示時間")),
    orientation: { state, headline, significance, nextAction, uncertainty },
    map: {
      question: text(situation?.title, headline),
      before,
      now,
      impact,
      nodes: unique([
        text(situation?.title),
        ...changes.map((item) => text(item?.domain)),
        ...missions.map((item) => text(item?.title)),
        ...watching.map((item) => text(item?.label)),
      ]).slice(0, 5),
    },
    model: {
      assessment: text(situation?.currentAssessment, impact),
      confidence: Number.isFinite(situation?.confidence) ? situation.confidence : null,
      evidence,
      knownCount: evidence.filter((item) => item.kind === "known").length,
      inferenceCount: evidence.filter((item) => item.kind === "inference").length,
      unknownCount: evidence.filter((item) => item.kind === "unknown").length,
      contradictionCount: evidence.filter((item) => item.kind === "contradiction").length,
    },
    decision: {
      missions: missions.map((item) => ({
        id: text(item?.id),
        title: text(item?.title, "Mission"),
        objective: text(item?.objective),
        nextAction: text(item?.nextAction, "尚未定義下一步"),
        doneCondition: text(item?.doneCondition),
        stopCondition: text(item?.stopCondition),
        reviewDate: text(item?.reviewDate),
        status: text(item?.status, "active"),
      })),
      scenarios: list(situation?.scenarioPaths).map((item, index) => ({
        id: text(item?.id, `scenario-${index + 1}`),
        label: text(item?.label, `情境 ${index + 1}`),
        probability: Number.isFinite(item?.probability) ? item.probability : null,
        summary: text(item?.summary),
        trigger: text(item?.trigger),
        implication: text(item?.implication),
        invalidation: text(item?.invalidation),
      })),
      watchCondition: text(situation?.watchCondition, text(watching[0]?.condition)),
      stopCondition: text(situation?.stopCondition),
      reopenCondition: text(situation?.reopenCondition),
      nextReview: text(situation?.nextReview, text(primaryMission?.reviewDate)),
    },
    deepDive: {
      transcript: list(input?.briefing?.transcript).map((item) => text(item)).filter(Boolean),
      sources,
      briefingStatus: text(input?.briefing?.status),
      duration: text(input?.briefing?.duration),
    },
    memory: {
      claims: unique([
        headline,
        now,
        significance,
        ...evidence.filter((item) => ["known", "inference"].includes(item.kind)).map((item) => item.text),
      ]),
      openQuestions: unique([
        ...evidence.filter((item) => item.kind === "unknown").map((item) => item.text),
        uncertainty,
      ]),
      retrievalCues,
      tags,
    },
  };
}

export function buildMemoryPacket(input = {}, depthId = "scan") {
  const brief = buildCognitiveBrief(input);
  const depth = READING_DEPTHS[depthIndex(depthId)];
  const id = `brief-${dayStamp(brief.asOf)}-${slug(brief.orientation.headline)}`;
  const sourceRefs = brief.deepDive.sources.map((source, index) => ({
    id: `source-${index + 1}`,
    title: source.label,
    uri: source.href,
    status: source.status ?? null,
  }));
  const indexText = unique([
    brief.title,
    brief.orientation.headline,
    brief.orientation.significance,
    brief.orientation.nextAction,
    brief.map.before,
    brief.map.now,
    ...brief.map.nodes,
    ...brief.memory.claims,
    ...brief.memory.openQuestions,
    ...brief.memory.tags,
  ]).join(" · ");

  return {
    schema_version: "intel-memory-packet/1",
    provenance: {
      kind: "derived_snapshot",
      source_system: "IntelOS",
      source_revision: input.sourceRevision ?? null,
      canonical_truth: "Canonical Markdown entities; this packet is a derived reading and index artifact.",
    },
    id,
    type: "cognitive_brief",
    title: brief.title,
    as_of: brief.asOf,
    reading_depth: { id: depth.id, label: depth.label, task: depth.task },
    status: brief.orientation.state,
    summary_30s: brief.orientation,
    architecture_3m: brief.map,
    evidence_10m: brief.model,
    decision_25m: brief.decision,
    deep_dive_50m: brief.deepDive,
    memory: brief.memory,
    tags: brief.memory.tags,
    source_refs: sourceRefs,
    index_text: indexText,
  };
}

function yaml(value) {
  return JSON.stringify(value ?? "");
}

function line(value, fallback = "尚未定義") {
  return text(value, fallback).replace(/\r?\n/g, " ");
}

export function serializeMemoryPacket(packet) {
  const claims = list(packet?.memory?.claims);
  const questions = list(packet?.memory?.retrievalCues);
  const evidence = list(packet?.evidence_10m?.evidence);
  const missions = list(packet?.decision_25m?.missions);
  const scenarios = list(packet?.decision_25m?.scenarios);
  const transcript = list(packet?.deep_dive_50m?.transcript);
  const sources = list(packet?.source_refs);
  const tags = list(packet?.tags);
  const architecture = packet?.architecture_3m ?? {};
  const orientation = packet?.summary_30s ?? {};
  const decision = packet?.decision_25m ?? {};

  const rows = [
    "---",
    `schema_version: ${yaml(packet?.schema_version)}`,
    `artifact_kind: ${yaml(packet?.provenance?.kind)}`,
    `source_system: ${yaml(packet?.provenance?.source_system)}`,
    `source_revision: ${yaml(packet?.provenance?.source_revision)}`,
    `id: ${yaml(packet?.id)}`,
    `type: ${yaml(packet?.type)}`,
    `title: ${yaml(packet?.title)}`,
    `as_of: ${yaml(packet?.as_of)}`,
    `reading_depth: ${yaml(packet?.reading_depth?.id)}`,
    `status: ${yaml(packet?.status)}`,
    `tags: ${JSON.stringify(tags)}`,
    `source_count: ${sources.length}`,
    "---",
    "",
    `# ${line(packet?.title, "今日理解包")}`,
    "",
    "## 30 秒｜定位",
    "",
    `- **現在：** ${line(orientation.state)}`,
    `- **一句結論：** ${line(orientation.headline)}`,
    `- **為何重要：** ${line(orientation.significance)}`,
    `- **下一步：** ${line(orientation.nextAction)}`,
    `- **關鍵警告：** ${line(orientation.uncertainty)}`,
    "",
    "## 3 分鐘｜架構",
    "",
    `- **核心問題：** ${line(architecture.question)}`,
    `- **Before：** ${line(architecture.before)}`,
    `- **Now：** ${line(architecture.now)}`,
    `- **影響：** ${line(architecture.impact)}`,
    `- **架構節點：** ${list(architecture.nodes).map((item) => line(item)).join(" → ") || "尚未建立"}`,
    "",
    "## 10 分鐘｜證據與建模",
    "",
    `目前判斷：${line(packet?.evidence_10m?.assessment)}`,
    "",
    ...(evidence.length
      ? evidence.map((item) => `- **${line(item.kind, "unknown")}：** ${line(item.text)}${item.status ? `（${line(item.status)}）` : ""}`)
      : ["- 尚未建立可追溯證據；保持低信心。"]),
    "",
    "## 25 分鐘｜決策與邊界",
    "",
    ...(missions.length
      ? missions.flatMap((mission) => [
        `### ${line(mission.title, "Mission")}`,
        "",
        `- **下一步：** ${line(mission.nextAction)}`,
        `- **完成條件：** ${line(mission.doneCondition)}`,
        `- **停止條件：** ${line(mission.stopCondition)}`,
        `- **複查：** ${line(mission.reviewDate)}`,
        "",
      ])
      : ["目前沒有需要建立的 Mission。", ""]),
    ...(scenarios.length
      ? scenarios.flatMap((scenario) => [
        `- **${line(scenario.label)}${Number.isFinite(scenario.probability) ? `（${scenario.probability}%）` : ""}：** ${line(scenario.summary)}`,
        `  - 觸發：${line(scenario.trigger)}`,
        `  - 失效：${line(scenario.invalidation)}`,
      ])
      : []),
    `- **監看條件：** ${line(decision.watchCondition)}`,
    `- **重開條件：** ${line(decision.reopenCondition)}`,
    "",
    "## 50 分鐘｜深讀、查核與來源",
    "",
    ...(transcript.length
      ? transcript.map((paragraph, index) => `${index + 1}. ${line(paragraph)}`)
      : ["目前沒有完整深讀轉錄。"]),
    "",
    "### 來源",
    "",
    ...(sources.length
      ? sources.map((source) => `- [${line(source.title, source.id)}](${source.uri})${source.status ? ` — ${line(source.status)}` : ""}`)
      : ["- 尚無可引用來源。"]),
    "",
    "## 記憶化｜關閉原文後回想",
    "",
    "### 核心主張",
    "",
    ...(claims.length ? claims.map((claim) => `- ${line(claim)}`) : ["- 尚未建立主張。"]),
    "",
    "### 提取問題",
    "",
    ...(questions.length
      ? questions.flatMap((item, index) => [
        `${index + 1}. ${line(item.prompt)}`,
        `   - 答案：${line(item.answer)}`,
      ])
      : ["1. 這份材料真正改變了什麼？"]),
    "",
    "### 索引文字",
    "",
    line(packet?.index_text),
    "",
  ];
  return rows.join("\n");
}
