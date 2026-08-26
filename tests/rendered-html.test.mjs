import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the forward intelligence Now view", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-Hant">/i);
  assert.match(html, /<title>個人世界情報系統｜IntelOS Alpha<\/title>/i);
  assert.match(html, /個人世界情報系統/);
  assert.match(html, /SEED · READ ONLY|CONNECTING/);
  assert.match(html, new RegExp("FORWARD INTELLIGENCE / NOW"));
  assert.match(html, /Event Radar/);
  assert.match(html, /Live Pulse/);
  assert.match(html, /Fact → Context → Reaction/);
  assert.match(html, /Path Map/);
  assert.match(html, /Decision Gates/);
  assert.match(html, /Action Control Loop/);
  assert.match(html, /Sensor Coverage/);
  assert.match(html, /NO FABRICATED ODDS/);
  assert.match(html, /FAST LANE CONTRACT/);
  assert.match(html, /href="\/replay"/);
  assert.doesNotMatch(html, /歷史重播/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("preserves the previous pullback radar cockpit at /replay", async () => {
  const response = await render("/replay");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /歷史重播/);
  assert.match(html, /非即時/);
  assert.match(html, /中期回調雷達：休眠/);
  assert.match(html, /跳到 T5 模擬觸發/);
  assert.doesNotMatch(html, /中期回調：抄底條件進入觀察區/);
  assert.doesNotMatch(html, /SHADOW／模擬觸發/);
  assert.doesNotMatch(html, /6／7|7／8|抄底分數/);
  assert.match(html, /TSM CAPEX 上修與毛利率壓力/);
  assert.match(html, /KNOWN/);
  assert.match(html, /INFERENCE/);
  assert.match(html, /UNKNOWN/);
  assert.match(html, /obsidian:\/\/open\?vault=/);
});

test("implements live routes, safe write preview, and read-only fallback", async () => {
  const [page, replay, css, layout, packageJson, previewServer, launcher] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/replay/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../preview-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../啟動情報決策台.cmd", import.meta.url), "utf8"),
  ]);

  for (const route of ["today", "inbox", "situations", "missions", "review"]) {
    assert.match(page, new RegExp(`id: "${route}"`));
  }
  for (const endpoint of [
    "/api/v2/now",
    "/api/v2/evidence-loop/refresh",
    "/api/v2/evidence-loop/sec/setup",
    "/api/v2/evidence-loop/fred/setup",
    "/api/v2/connectors/alpaca/bootstrap",
    "/api/v1/inbox",
    "/api/v1/situations",
    "/api/v1/missions",
    "/api/v1/reviews",
    "/api/v1/connectors/health",
    "/api/v1/signals",
    "/api/v1/connectors/telegram/groups/preview",
    "/api/v1/connectors/telegram/groups/commit",
    "/api/v1/commands/preview",
    "/api/v1/commands/commit",
  ]) {
    assert.match(page, new RegExp(endpoint.replaceAll("/", "\\/")));
  }
  assert.match(page, /\/api\/v2\/stream/);
  assert.match(page, /needsYou\.slice\(0, 3\)/);
  assert.match(page, /materialChanges\.slice\(0, 3\)/);
  assert.match(page, /\.slice\(0, 3\)/);
  assert.match(page, /沒有實質變化/);
  assert.match(page, /Wiki 唯讀/);
  assert.match(page, /unverified_external/);
  assert.match(page, /Link Situation/);
  assert.match(page, /Create Situation/);
  assert.match(page, /左滑沒興趣 · 右滑有興趣/);
  assert.match(page, /inbox\.swipe_batch/);
  assert.match(page, /INTELOS PREDICTS/);
  assert.match(page, /預覽並儲存/);
  assert.match(page, /Wiki S0–S8 待確認/);
  assert.match(page, /發生什麼/);
  assert.match(page, /為什麼出現在這裡/);
  assert.match(page, /仍缺什麼/);
  assert.match(page, /查看原文/);
  assert.match(page, /來源導讀 · 待翻譯/);
  assert.match(page, /factory\.availability/);
  assert.match(page, /targetLanguage: "zh-Hant"/);
  assert.match(page, /啟用\{languageLabel\(item\.sourceLanguage\)\}→繁中/);
  assert.match(page, /裝置端翻譯/);
  assert.match(page, /sourceAwareChineseDigest/);
  assert.match(page, /HUMAN SENSOR NETWORK/);
  assert.match(page, /Live Signals/);
  assert.match(page, /UNVERIFIED LIVE/);
  assert.match(page, /PRIVATE GROUP SENSOR/);
  assert.match(page, /\/monitor \{telegramMonitorCode\}/);
  assert.match(page, /\/consent/);
  assert.match(page, /signals\/dispositions\/preview/);
  assert.match(css, /\.live-swipe-card\.is-current[\s\S]*?touch-action: pan-y/);
  assert.match(css, /\.live-localized-summary/);
  assert.match(css, /\.live-signal-grid/);
  assert.match(page, /BEFORE/);
  assert.match(page, /NOW/);
  assert.match(page, /證據與待驗證線索/);
  assert.match(page, /S0–S8 尚未完成/);
  assert.match(page, /Contradiction/);
  assert.match(page, /Truflation/);
  assert.match(page, /manual_snapshot/);
  assert.match(page, /Sector-first finance panel/);
  assert.match(page, /FORECAST LEDGER · USER CONFIRMED/);
  assert.match(page, /situation\.forecast_update/);
  assert.match(page, /NO FABRICATED ODDS/);
  assert.match(page, /機率是目前證據下的決策權重，不是預言/);
  assert.match(page, /normalizeScenarioPaths\(payload\.scenario_paths\)/);
  assert.match(css, /\.live-scenario-grid/);
  assert.match(page, /payload\.material_change === true/);
  assert.match(page, /normalizeDipBuyingIndicators\(payload\.pullback_indicators\)/);
  assert.match(page, /data-pullback-panel="dormant"/);
  assert.match(page, /MID-TERM PULLBACK MONITOR · DORMANT/);
  assert.match(page, /data-pullback-panel="prominent"/);
  assert.match(page, /MID-TERM PULLBACK DECISION PANEL/);
  assert.match(page, /多證據族群交叉驗證/);
  assert.match(page, /需人工判斷/);
  assert.match(page, /不自動建立 Mission/);
  assert.match(page, /INDICATOR AVAILABILITY/);
  assert.match(page, /CHART STATUS/);
  const pullbackPanel = page.match(/function PullbackDecisionPanel\([\s\S]*?\nfunction SituationsView/);
  assert.ok(pullbackPanel, "pullback decision panel should be present");
  assert.doesNotMatch(pullbackPanel[0], /\bscore\b|總分\s*[:=]|\/\s*8\b/i);
  assert.match(page, /下一個行動/);
  assert.match(page, /Action Control Loop/);
  assert.match(page, /FACT · SEC EDGAR/);
  assert.match(page, /CONTEXT · FRED/);
  assert.match(page, /REACTION · ALPACA/);
  assert.match(page, /Windows DPAPI/);
  assert.match(css, /\.fi-loop-grid/);
  assert.match(page, /requestTypedCommandPreview/);
  assert.match(page, /user_confirmation: userConfirmation/);
  assert.match(page, /base_revision:/);
  assert.match(page, /targetMissionId/);
  assert.match(page, /mission\.accept_adjustment/);
  assert.match(page, /mission\.dismiss_adjustment/);
  assert.match(page, /situation\.dismiss_adjustment/);
  assert.match(page, /decision_mode = "edit"/);
  assert.match(page, /edit_reason = editReason\.trim\(\)/);
  assert.match(page, /Keep current/);
  assert.match(page, /PROPOSED NEXT ACTION/);
  assert.match(page, /body: JSON\.stringify\(\{ preview_ids: pendingPreview\.previewIds \}\)/);
  assert.match(page, /body: JSON\.stringify\(\{ preview_id: previewId \}\)/);
  assert.doesNotMatch(page, /localStorage/);
  assert.match(css, /\.live-shell \{[\s\S]*?font-size: 15px/);
  assert.match(css, /\.live-shell button,[\s\S]*?min-height: 44px/);
  assert.match(css, /@media \(max-width: 390px\)/);
  assert.match(css, /\.live-mobile-nav/);
  assert.match(css, /\.live-cognitive-reader/);
  assert.match(css, /\.live-depth-switcher/);
  assert.match(css, /\.live-memory-handoff/);
  assert.match(layout, /個人世界情報系統｜IntelOS Alpha/);
  assert.match(replay, /export default function ReplayPage/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(previewServer, /from "\.\/dist\/server\/index\.js"/);
  assert.match(previewServer, /127\.0\.0\.1/);
  assert.match(launcher, /node preview-server\.mjs --open/);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("keeps every replay step, event-scoped decision, and pullback signal", async () => {
  const replay = await readFile(new URL("../app/replay/page.tsx", import.meta.url), "utf8");

  for (const step of ["T0", "T1", "T2", "T3", "T4", "T5"]) {
    assert.match(replay, new RegExp(`id: "${step}"`));
  }
  assert.match(replay, /useState\(2\)/);
  assert.match(replay, /intel-cockpit-decisions/);
  assert.match(replay, /const focusStep = selectedEvent\?\.step \?\? currentStep/);
  assert.match(replay, /decision\.eventIds\.includes\(selectedEvent\.id\)/);
  assert.match(replay, /eventIds: \["tsm-q2", "goog-q2"\]/);
  assert.match(replay, /data-mobile-view/);
  assert.match(replay, /data-regime=\{pullbackRadar\.regime\}/);
  assert.match(replay, /triggerStep: 5/);
  assert.match(replay, /currentStep >= pullbackRadar\.triggerStep/);
  assert.match(replay, /pullbackRadar\.active && !pullbackActive/);
  assert.match(replay, /\{pullbackActive && \(/);
  assert.match(replay, /requestAnimationFrame\(\(\) => setPullbackExpanded\(true\)\)/);
  assert.match(replay, /中期回調雷達：休眠/);
  assert.match(replay, /中期回調：抄底條件進入觀察區/);
  assert.match(replay, /SHADOW／模擬觸發/);
  assert.match(replay, /WAIT｜等待高點突破/);
  assert.match(replay, /THESIS GATE/);
  assert.match(replay, /非自動交易訊號/);
  assert.match(replay, /aria-controls="pullback-radar-details"/);
  assert.match(replay, /hidden=\{!pullbackExpanded\}/);

  for (const signal of [
    "估值到便宜位置",
    "市場情緒過低",
    "週線 KDJ.J ≤ 0",
    "QLD／TQQQ 日或週爆量",
    "VIX／VXN 過高",
    "融資餘額過低",
    "融資維持率過低",
    "低點更高＋高點更高",
  ]) {
    assert.match(replay, new RegExp(signal));
  }

  const radarBlock = replay.match(/const pullbackRadar = \{([\s\S]*?)\n\};\n\nconst events/);
  assert.ok(radarBlock, "pullback radar data block should exist");
  const signalIds = [...radarBlock[1].matchAll(/^\s+id: "([^"]+)",$/gm)].map((match) => match[1]);
  assert.equal(signalIds.length, 8);
  assert.equal(new Set(signalIds).size, 8);
});
