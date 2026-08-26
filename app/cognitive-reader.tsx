"use client";

import { useMemo, useState } from "react";
import {
  buildCognitiveBrief,
  buildMemoryPacket,
  depthIndex,
  READING_DEPTHS,
  serializeMemoryPacket,
} from "./cognitive-memory.mjs";

export type ReadingDepthId = "scan" | "map" | "understand" | "decide" | "deep";

export type CognitiveReaderInput = {
  asOf: string;
  sourceRevision: string | number;
  needsYou: unknown[];
  changes: unknown[];
  missions: unknown[];
  watching: unknown[];
  connectors: unknown[];
  situations: unknown[];
  briefing: unknown;
};

type CognitiveReaderProps = {
  input: CognitiveReaderInput;
  depth: ReadingDepthId;
  onDepthChange: (depth: ReadingDepthId) => void;
};

type ReaderEvidence = {
  id: string;
  kind: string;
  text: string;
  source?: { label: string; href: string };
};

type ReaderMission = {
  id: string;
  title: string;
  status: string;
  nextAction: string;
  doneCondition: string;
};

type ReaderScenario = {
  id: string;
  label: string;
  probability: number | null;
  summary: string;
  trigger: string;
  invalidation: string;
};

type RetrievalCue = { prompt: string; answer: string };

const kindLabels: Record<string, string> = {
  known: "已知",
  inference: "推論",
  unknown: "未知",
  contradiction: "反證",
};

function download(name: string, contents: string, mime: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function CognitiveReader({ input, depth, onDepthChange }: CognitiveReaderProps) {
  const brief = useMemo(() => buildCognitiveBrief(input), [input]);
  const packet = useMemo(() => buildMemoryPacket(input, depth), [depth, input]);
  const markdown = useMemo(() => serializeMemoryPacket(packet), [packet]);
  const [notice, setNotice] = useState("");
  const activeIndex = depthIndex(depth);
  const nextDepth = READING_DEPTHS[activeIndex + 1];

  async function copyMarkdown() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(markdown);
      setNotice("已複製 Markdown；可直接貼進 Obsidian 或其他記憶庫。");
    } catch {
      setNotice("瀏覽器未開放剪貼簿；請展開下方預覽後手動複製。");
    }
  }

  return (
    <section className="live-cognitive-reader" aria-labelledby="cognitive-reader-title">
      <header className="live-cognitive-head">
        <div>
          <span>COGNITIVE READING PATH</span>
          <h3 id="cognitive-reader-title">同一份情報，依你現在的時間展開</h3>
          <p>先保留完整骨架，再增加證據與細節；深層內容只補充或修正，不偷換淺層結論。</p>
        </div>
        <a href="#memory-handoff">整理進記憶庫</a>
      </header>

      <div className="live-depth-switcher" aria-label="選擇可用閱讀時間">
        {READING_DEPTHS.map((item, index) => (
          <button
            type="button"
            key={item.id}
            className={item.id === depth ? "is-active" : index < activeIndex ? "is-complete" : ""}
            aria-pressed={item.id === depth}
            onClick={() => onDepthChange(item.id)}
          >
            <span>{item.label}</span>
            <strong>{item.task}</strong>
          </button>
        ))}
      </div>

      <div className="live-depth-context">
        <span>目前深度 · {READING_DEPTHS[activeIndex].label}</span>
        <p>{activeIndex === 0 ? "讀完只要能說出：發生什麼、為何重要、下一步。" : `前 ${activeIndex + 1} 層全部保留；現在加入「${READING_DEPTHS[activeIndex].task}」所需資訊。`}</p>
      </div>

      <section className="live-cognitive-layer is-orientation" aria-labelledby="layer-orientation-title">
        <div className="live-layer-label"><span>01</span><div><strong id="layer-orientation-title">30 秒｜定位</strong><small>現在、意義、行動、警告</small></div></div>
        <div className="live-orientation-grid">
          <article className="is-state"><span>現在</span><strong>{brief.orientation.state}</strong><p>{brief.orientation.headline}</p></article>
          <article><span>為何重要</span><p>{brief.orientation.significance}</p></article>
          <article className="is-action"><span>唯一下一步</span><p>{brief.orientation.nextAction}</p></article>
          <article className="is-caveat"><span>不可漏掉</span><p>{brief.orientation.uncertainty}</p></article>
        </div>
      </section>

      <section className="live-cognitive-layer" aria-labelledby="layer-map-title" hidden={activeIndex < 1}>
        <div className="live-layer-label"><span>02</span><div><strong id="layer-map-title">3 分鐘｜建立架構</strong><small>{brief.map.nodes.length} 個可掛載細節的節點</small></div></div>
        <div className="live-architecture-grid">
          <article><span>BEFORE</span><p>{brief.map.before}</p></article>
          <i aria-hidden="true">→</i>
          <article><span>NOW</span><p>{brief.map.now}</p></article>
        </div>
        <div className="live-node-map" aria-label="主架構節點">
          {brief.map.nodes.length
            ? brief.map.nodes.map((node: string, index: number) => <span key={`${node}-${index}`}><b>{String(index + 1).padStart(2, "0")}</b>{node}</span>)
            : <p>尚未建立架構節點；先不要把零碎更新誤認成完整理解。</p>}
        </div>
        <p className="live-layer-takeaway"><span>影響</span>{brief.map.impact}</p>
      </section>

      <section className="live-cognitive-layer" aria-labelledby="layer-model-title" hidden={activeIndex < 2}>
        <div className="live-layer-label"><span>03</span><div><strong id="layer-model-title">10 分鐘｜證據與建模</strong><small>把事實、推論、未知與反證拆開</small></div></div>
        <div className="live-evidence-meter">
          <span><b>{brief.model.knownCount}</b> 已知</span>
          <span><b>{brief.model.inferenceCount}</b> 推論</span>
          <span><b>{brief.model.unknownCount}</b> 未知</span>
          <span><b>{brief.model.contradictionCount}</b> 反證</span>
          <span><b>{brief.model.confidence ?? "—"}</b> 信心</span>
        </div>
        <p className="live-model-assessment">{brief.model.assessment}</p>
        <div className="live-cognitive-evidence">
          {brief.model.evidence.length ? brief.model.evidence.slice(0, 8).map((item: ReaderEvidence) => (
            <article key={item.id} className={`is-${item.kind}`}>
              <span>{kindLabels[item.kind] ?? item.kind}</span>
              <p>{item.text}</p>
              {item.source?.href && <a href={item.source.href} target="_blank" rel="noreferrer">{item.source.label}</a>}
            </article>
          )) : <p className="live-empty-line">目前沒有可追溯證據；不要因版面完整而提高信心。</p>}
        </div>
      </section>

      <section className="live-cognitive-layer" aria-labelledby="layer-decision-title" hidden={activeIndex < 3}>
        <div className="live-layer-label"><span>04</span><div><strong id="layer-decision-title">25 分鐘｜判斷與邊界</strong><small>替代情境、停止條件與複查時間</small></div></div>
        <div className="live-decision-rail">
          <article><span>WATCH</span><p>{brief.decision.watchCondition || "尚未定義監看條件"}</p></article>
          <article><span>STOP</span><p>{brief.decision.stopCondition || "尚未定義停止條件"}</p></article>
          <article><span>REOPEN</span><p>{brief.decision.reopenCondition || "尚未定義重開條件"}</p></article>
          <article><span>REVIEW</span><p>{brief.decision.nextReview || "有新證據時"}</p></article>
        </div>
        {brief.decision.missions.length ? <div className="live-cognitive-missions">
          {brief.decision.missions.map((mission: ReaderMission) => (
            <article key={mission.id || mission.title}><span>{mission.status}</span><h4>{mission.title}</h4><p>{mission.nextAction}</p><small>Done · {mission.doneCondition || "尚未定義"}</small></article>
          ))}
        </div> : <p className="live-empty-line">目前沒有 Mission；沒有行動理由時，不把閱讀變成待辦清單。</p>}
        {brief.decision.scenarios.length > 0 && <div className="live-cognitive-scenarios">
          {brief.decision.scenarios.map((scenario: ReaderScenario) => (
            <article key={String(scenario.id)}><span>{scenario.probability === null ? "—" : `${scenario.probability}%`}</span><h4>{scenario.label}</h4><p>{scenario.summary}</p><small>觸發 · {scenario.trigger || "未定義"}</small><small>失效 · {scenario.invalidation || "未定義"}</small></article>
          ))}
        </div>}
      </section>

      <section className="live-cognitive-layer" aria-labelledby="layer-deep-title" hidden={activeIndex < 4}>
        <div className="live-layer-label"><span>05</span><div><strong id="layer-deep-title">50 分鐘｜查核與內化</strong><small>深讀不是多看一次，而是關閉原文後重建</small></div></div>
        <div className="live-deep-grid">
          <article>
            <span>SOURCE CHECK</span>
            <strong>{brief.deepDive.sources.length} 個來源</strong>
            <p>逐一確認日期、適用範圍與主張是否真的被來源支持。</p>
          </article>
          <article>
            <span>RETRIEVAL PRACTICE</span>
            <strong>{brief.memory.retrievalCues.length} 個提取問題</strong>
            <p>先關閉內容，用自己的話重建，再回來校正錯漏。</p>
          </article>
          <article>
            <span>MEMORY UNITS</span>
            <strong>{brief.memory.claims.length} 個核心主張</strong>
            <p>主張、證據、反證、下一步與來源一起入庫，避免只存摘要。</p>
          </article>
        </div>
        <ol className="live-retrieval-list">
          {brief.memory.retrievalCues.map((cue: RetrievalCue, index: number) => <li key={cue.prompt}><span>{index + 1}</span><div><strong>{cue.prompt}</strong><details><summary>核對答案</summary><p>{cue.answer}</p></details></div></li>)}
        </ol>
      </section>

      {nextDepth && <button type="button" className="live-next-depth" onClick={() => onDepthChange(nextDepth.id)}>
        <span>還有時間？</span><strong>進入 {nextDepth.label} · {nextDepth.task}</strong><i aria-hidden="true">→</i>
      </button>}

      <section className="live-memory-handoff" id="memory-handoff" aria-labelledby="memory-handoff-title">
        <div>
          <span>MEMORY HANDOFF · MARKDOWN + JSON</span>
          <h3 id="memory-handoff-title">閱讀完，不只收藏：留下可再次找回的記憶包</h3>
          <p>同一份內容包含 stable ID、時間、狀態、來源、主張、未知、下一步、提取問題與全文索引文字。</p>
        </div>
        <div className="live-memory-actions">
          <button type="button" className="is-primary" onClick={() => void copyMarkdown()}>複製 Markdown</button>
          <button type="button" onClick={() => download(`${packet.id}.md`, markdown, "text/markdown;charset=utf-8")}>下載 .md</button>
          <button type="button" onClick={() => download(`${packet.id}.json`, `${JSON.stringify(packet, null, 2)}\n`, "application/json;charset=utf-8")}>下載 JSON</button>
        </div>
        <p className="live-memory-notice" aria-live="polite">{notice || "Markdown 適合人讀與 Obsidian；JSON 適合資料庫、搜尋與未來重建索引。"}</p>
        <details className="live-memory-preview">
          <summary>檢查記憶包與手動複製</summary>
          <dl>
            <div><dt>ID</dt><dd>{packet.id}</dd></div>
            <div><dt>Schema</dt><dd>{packet.schema_version}</dd></div>
            <div><dt>Tags</dt><dd>{packet.tags.join(" · ") || "—"}</dd></div>
            <div><dt>Sources</dt><dd>{packet.source_refs.length}</dd></div>
          </dl>
          <textarea aria-label="Markdown 記憶包預覽" readOnly value={markdown} />
        </details>
      </section>
    </section>
  );
}
