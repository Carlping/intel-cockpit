"use client";

import { type CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import CognitiveReader, { type CognitiveReaderInput, type ReadingDepthId } from "./cognitive-reader";

type View = "today" | "inbox" | "situations" | "missions" | "review";
type ApiState = "loading" | "live" | "partial" | "fallback";
type HealthState = "healthy" | "stale" | "offline" | "disabled" | "manual";
type EvidenceKind = "known" | "inference" | "unknown" | "contradiction";
type EvidenceView = EvidenceKind | "pending";
type CommandNoticeTone = "info" | "refreshing" | "success" | "warning" | "error";

type SourceRef = {
  label: string;
  href: string;
  status?: string;
};

type AttentionItem = {
  id: string;
  revision?: number;
  entityType?: string;
  eyebrow: string;
  title: string;
  summary: string;
  due?: string;
  priority: "P0" | "P1" | "P2";
  source?: SourceRef;
  targetSituationId?: string;
  targetMissionId?: string;
  draftBefore?: string;
  draftNow?: string;
  draftImpact?: string;
  draftRationale?: string;
  draftNextAction?: string;
  draftReviewDate?: string;
  draftStatus?: "active" | "blocked";
};

type ChangeItem = {
  id: string;
  revision?: number;
  domain: string;
  title: string;
  before: string;
  now: string;
  impact: string;
  observedAt: string;
  evidenceStatus: string;
  source?: SourceRef;
};

type InboxItem = {
  id: string;
  revision?: number;
  status: string;
  domain: string;
  sourceType: string;
  sourceLabel: string;
  title: string;
  summary: string;
  originalSummary: string;
  sourceLanguage: "zh-Hant" | "en" | "ja" | "ko" | "other";
  summaryKind: "original_chinese" | "canonical_chinese" | "source_aware_fallback";
  translationInput?: string;
  whatChanged: string;
  whyRelevant: string;
  stillUnknown: string;
  observedAt: string;
  evidenceStatus: string;
  matchedInterests: string[];
  source?: SourceRef;
  contentHash?: string;
  origin?: "canonical" | "signal";
  signalId?: string;
  signalStatus?: "candidate" | "live_signal" | "corroborated";
  signalScore?: number;
  mentionCount?: number;
  independentSourceCount?: number;
  velocityLabel?: string;
};

type LiveSignal = {
  id: string;
  status: "candidate" | "live_signal" | "corroborated";
  title: string;
  summary: string;
  sourceLanguage: InboxItem["sourceLanguage"];
  firstSeenAt: string;
  lastSeenAt: string;
  mentionCount: number;
  independentSourceCount: number;
  velocityLabel: string;
  score: number;
  matchedInterestIds: string[];
  source?: SourceRef;
  decisionPreview?: {
    situationId: string;
    situationTitle: string;
    before: string;
    newSignal: string;
    verification: string;
    scenarioProbabilities: Array<{ label: string; probability: number }>;
    probabilityChange: string;
  };
};

type ForwardEventWindow = {
  id: string;
  title: string;
  releaseType: string;
  priority: string;
  scheduledAt: string;
  opensAt: string;
  closesAt: string;
  state: "scheduled" | "armed" | "live" | "closed";
  secondsToRelease: number;
  consensusState: string;
  source?: SourceRef;
};

type ForwardPulse = {
  id: string;
  title: string;
  factState: "unverified" | "source_matched" | "official_confirmed" | "conflicted";
  impactState: "not_observed" | "market_reacting" | "mixed" | "contradictory";
  firstSeenAt: string;
  lastSeenAt: string;
  independentSourceCount: number;
  mentionCount: number;
  sourceLabel: string;
  source?: SourceRef;
  claim?: {
    metricLabel: string;
    actual?: number;
    forecast?: number;
    previous?: number;
    surprise?: number;
    unit: string;
    pressureLabel: string;
    confidence: number;
  };
};

type ForwardPathMap = {
  situationId: string;
  situationTitle: string;
  intelligenceQuestion: string;
  horizon: string;
  calibrationState: "heuristic" | "calibrating" | "calibrated";
  comparableEventCount: number;
  nextObservable?: string;
  paths: ScenarioPath[];
};

type ForwardDecisionGate = {
  id: string;
  kind: "signal" | "situation" | "mission";
  title: string;
  state: string;
  reason: string;
  dueAt?: string;
  signalId?: string;
  situationId?: string;
  missionId?: string;
};

type ForwardCoverage = {
  id: string;
  label: string;
  state: HealthState;
  coverageState: string;
  detail: string;
  checkedAt?: string;
};

type ForwardNowModel = {
  mode: string;
  asOf: string;
  eventRadar: ForwardEventWindow[];
  nextEvent?: ForwardEventWindow;
  livePulse: ForwardPulse[];
  pathMap: ForwardPathMap[];
  decisionGates: ForwardDecisionGate[];
  coverageHealth: ForwardCoverage[];
  latencyTargetMs: number;
};

type EvidenceReactionMove = {
  symbol: string;
  returnPercent: number;
  abnormalReturnPercent?: number;
};

type EvidenceLoopFact = {
  id: string;
  title: string;
  company: string;
  form: string;
  symbols: string[];
  publishedAt: string;
  source?: SourceRef;
  baselineOnly: boolean;
  reactionState: string;
  reaction?: {
    feed: string;
    coverage: string;
    windowMinutes: number;
    benchmark: string;
    moves: EvidenceReactionMove[];
  };
};

type EvidenceMacro = {
  id: string;
  label: string;
  value?: number;
  previousValue?: number;
  delta?: number;
  unit: string;
  observationDate: string;
  realtimeStart: string;
  realtimeEnd: string;
  coverageState: string;
  source?: SourceRef;
};

type EvidenceLoopModel = {
  mode: string;
  asOf: string;
  facts: EvidenceLoopFact[];
  macro: EvidenceMacro[];
  pendingReactionCount: number;
  incompleteReasons: string[];
};

type BrowserTranslator = {
  translate: (input: string) => Promise<string>;
};

type BrowserTranslatorFactory = {
  availability: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
  create: (options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: { addEventListener: (type: "downloadprogress", listener: (event: { loaded: number }) => void) => void }) => void;
  }) => Promise<BrowserTranslator>;
};

type Evidence = {
  id: string;
  kind: EvidenceKind;
  text: string;
  source?: SourceRef;
  sourceInboxId?: string;
  sourceTitle?: string;
  evidenceStatus?: string;
  s0S8State?: string;
  asOf?: string;
  observedAt?: string;
};

type CommandNotice = {
  id: number;
  tone: CommandNoticeTone;
  message: string;
};

type TimelinePoint = {
  id: string;
  date: string;
  label: string;
  detail: string;
  status: "verified" | "external" | "manual";
};

type DipBuyingIndicator = {
  id: string;
  label: string;
  state: string;
  asOf: string;
  value?: string;
  reason: string;
};

type PullbackChart = {
  label: string;
  state: string;
  asOf: string;
  value?: string;
  reason: string;
};

type ScenarioPath = {
  id: string;
  label: string;
  probability: number;
  summary: string;
  trigger: string;
  implication: string;
  invalidation: string;
  tone: "base" | "upside" | "stress";
};

type InboxRoutePrediction = {
  group: string;
  situationId?: string;
  situationTitle?: string;
  confidence: number;
  reason: string;
};

type InboxSwipeDecision = {
  origin: "canonical" | "signal";
  inbox_id?: string;
  signal_id?: string;
  base_revision: number;
  interested: boolean;
  situation_id?: string;
  system_group: string;
  classification_confidence: number;
  classification_reason: string;
};

type Situation = {
  id: string;
  revision?: number;
  domain: string;
  title: string;
  status: "active" | "watch" | "quiet";
  confidence: number;
  currentAssessment: string;
  before: string;
  now: string;
  watchCondition: string;
  stopCondition: string;
  reopenCondition: string;
  nextReview: string;
  evidence: Evidence[];
  timeline: TimelinePoint[];
  sectorGroups: Array<{ name: string; state: string; note: string; members: string[] }>;
  indicatorSeries: Array<{ label: string; value?: number; unit: string; asOf: string; status: string }>;
  materialChange: boolean;
  dipBuyingIndicators: DipBuyingIndicator[];
  chart?: PullbackChart;
  scenarioPaths: ScenarioPath[];
  intelligenceQuestion?: string;
  forecastHorizon?: string;
  nextObservable?: string;
};

type Mission = {
  id: string;
  revision?: number;
  domain: string;
  title: string;
  objective: string;
  whyNow: string;
  nextAction: string;
  doneCondition: string;
  reviewDate: string;
  stopCondition: string;
  status: "active" | "blocked" | "watch" | "completed" | "cancelled";
  situationId?: string;
  adjustmentDraft?: {
    rationale: string;
    nextAction: string;
    reviewDate: string;
    proposedStatus: "active" | "blocked";
  };
};

type Review = {
  id: string;
  revision?: number;
  missionTitle: string;
  date: string;
  outcome: string;
  assessmentChange: string;
  nextState: string;
};

type ConnectorHealth = {
  id: string;
  label: string;
  state: HealthState;
  detail: string;
  lastSeen?: string;
};

type WatchItem = {
  id: string;
  label: string;
  condition: string;
  state: "watching" | "triggered" | "paused";
  nextCheck?: string;
};

type Briefing = {
  generatedAt: string;
  status: string;
  duration: string;
  transcript: string[];
  sources: SourceRef[];
};

type WorkspaceData = {
  revision: string | number;
  asOf: string;
  mode: string;
  needsYou: AttentionItem[];
  materialChanges: ChangeItem[];
  inbox: InboxItem[];
  situations: Situation[];
  missions: Mission[];
  nextActions?: Mission[];
  watching?: WatchItem[];
  reviews: Review[];
  connectors: ConnectorHealth[];
  briefing: Briefing;
  signals: LiveSignal[];
  forward: ForwardNowModel;
  evidenceLoop: EvidenceLoopModel;
};

type PendingPreview = {
  command: string;
  label: string;
  previewId?: string;
  previewIds?: string[];
  baseRevision: number;
  payload: Record<string, unknown>;
  diff: string[];
  commitEndpoint?: string;
  commitBody?: Record<string, unknown>;
};

type TelegramGroupMonitor = {
  chatId: string;
  status: string;
  consentCount: number;
  memberCount?: number;
  privacyReadable: boolean;
  pausedReason?: string;
  lastMessageAt?: string;
};

type WorkflowKind =
  | "link_situation"
  | "create_situation"
  | "create_mission"
  | "record_result"
  | "mission_adjustment"
  | "situation_adjustment"
  | "forecast_update"
  | "create_review";

type WorkflowDialogState = {
  kind: WorkflowKind;
  inbox?: InboxItem;
  situation?: Situation;
  mission?: Mission;
};

const navigation: Array<{ id: View; label: string; helper: string }> = [
  { id: "today", label: "Now", helper: "預警、路徑、決策門" },
  { id: "inbox", label: "Inbox", helper: "等待分流" },
  { id: "situations", label: "Situations", helper: "正在發展的局勢" },
  { id: "missions", label: "Missions", helper: "下一個行動" },
  { id: "review", label: "Review", helper: "結果與修正" },
];

const dipBuyingIndicatorLabels: Record<string, string> = {
  valuation: "估值到便宜位置",
  sentiment: "市場情緒過低",
  "price-structure": "底底高＋高點更高",
  "leveraged-etf-volume": "QLD／TQQQ 日或週爆量",
  "vix-vxn": "VIX／VXN 太高",
  "margin-balance": "融資餘額太低",
  "margin-maintenance": "融資維持率太低",
  "weekly-kdj-j": "KDJ J（週）≤ 0",
};

const seedData: WorkspaceData = {
  revision: "seed-alpha-1",
  asOf: "等待本機資料服務",
  mode: "read_only_seed",
  needsYou: [
    {
      id: "seed-attention-telegram",
      eyebrow: "CONNECTOR SETUP",
      title: "確認 Telegram 私人投稿邊界",
      summary: "先用 Privacy Mode ON 的專用 bot 與私人測試群，只接受 /intel、回覆與明確轉傳。",
      due: "啟用 Connector 前",
      priority: "P1",
    },
    {
      id: "seed-attention-inflation",
      eyebrow: "SITUATION REVIEW",
      title: "建立第一個美國通膨基準線",
      summary: "BLS／BEA 是官方主序列；Truflation 在 Alpha 僅能手動記錄並標示替代估計。",
      due: "首次同步後",
      priority: "P1",
    },
  ],
  materialChanges: [],
  signals: [],
  forward: {
    mode: "read_only_seed",
    asOf: "等待本機 v2 服務",
    eventRadar: [],
    livePulse: [],
    pathMap: [],
    decisionGates: [],
    coverageHealth: [],
    latencyTargetMs: 3_000,
  },
  evidenceLoop: {
    mode: "fact_context_reaction_v1",
    asOf: "等待本機 v2 服務",
    facts: [],
    macro: [],
    pendingReactionCount: 0,
    incompleteReasons: ["SEC、FRED、Alpaca 尚未連線"],
  },
  inbox: [
    {
      id: "seed-inbox-fed",
      status: "new",
      domain: "Macro",
      sourceType: "official_feed",
      sourceLabel: "Federal Reserve RSS",
      title: "等待第一次官方 Feed 同步",
      summary: "同步後，只有和 Active Situation、Mission、Watch 或最近互動匹配的項目才會進 Today。",
      originalSummary: "同步後，只有和 Active Situation、Mission、Watch 或最近互動匹配的項目才會進 Today。",
      sourceLanguage: "zh-Hant",
      summaryKind: "original_chinese",
      whatChanged: "等待第一次官方 Feed 同步。",
      whyRelevant: "建立美國通膨與 Fed 路徑的可追溯基準線。",
      stillUnknown: "尚未取得本機 observation 與 coverage 狀態。",
      observedAt: "尚未同步",
      evidenceStatus: "unverified_external",
      matchedInterests: ["美國通膨", "Fed 政策"],
      source: {
        label: "Federal Reserve RSS",
        href: "https://www.federalreserve.gov/feeds/press_all.xml",
      },
    },
    {
      id: "seed-inbox-truflation",
      status: "new",
      domain: "Macro",
      sourceType: "manual_snapshot",
      sourceLabel: "Truflation",
      title: "尚未輸入替代通膨觀察值",
      summary: "不爬網站、不把替代估計冒充官方 CPI；輸入時必須附 as-of 日期與來源。",
      originalSummary: "不爬網站、不把替代估計冒充官方 CPI；輸入時必須附 as-of 日期與來源。",
      sourceLanguage: "zh-Hant",
      summaryKind: "original_chinese",
      whatChanged: "尚未輸入替代通膨觀察值。",
      whyRelevant: "只在來源與日期完整時提供官方通膨序列的替代背景。",
      stillUnknown: "目前沒有可驗證的 Truflation snapshot。",
      observedAt: "待使用者輸入",
      evidenceStatus: "unverified_external",
      matchedInterests: ["美國通膨"],
      source: {
        label: "Truflation US Inflation Rate",
        href: "https://truflation.com/marketplace/us-inflation-rate",
      },
    },
  ],
  situations: [
    {
      id: "sit-us-inflation",
      domain: "Macro",
      title: "美國通膨與 Fed 政策路徑",
      status: "watch",
      confidence: 42,
      currentAssessment: "系統邊界已定義；在官方序列完成首次同步前，不形成方向性結論。",
      before: "資訊分散在新聞、研究筆記與聊天紀錄，缺少共同 as-of。",
      now: "官方 CPI／PCE 為主序列，Truflation 僅作帶標籤的替代估計。",
      watchCondition: "官方核心通膨、勞動市場與 Fed 溝通出現一致方向變化。",
      stopCondition: "資料過期、來源授權不明或僅有單一替代指標。",
      reopenCondition: "下一次 BLS、BEA 或 FOMC 一手資料更新。",
      nextReview: "首次 Feed 同步後",
      evidence: [
        {
          id: "ev-known-boundary",
          kind: "known",
          text: "BLS／BEA 被指定為官方代理序列；Truflation API 在 Alpha 預設關閉。",
        },
        {
          id: "ev-inference-policy",
          kind: "inference",
          text: "只有通膨、就業與政策語氣共同移動，才值得升級為決策問題。",
        },
        {
          id: "ev-unknown-first-sync",
          kind: "unknown",
          text: "尚未取得這台電腦的首次 live observation 與 coverage 狀態。",
        },
        {
          id: "ev-contradiction-alt",
          kind: "contradiction",
          text: "替代估計可能早於官方發布，但方法、修訂與授權不可與 CPI 混為一談。",
        },
      ],
      timeline: [
        {
          id: "tl-boundary",
          date: "ALPHA 1.1",
          label: "來源邊界鎖定",
          detail: "官方資料優先；外部資料先進 Inbox，再經驗證。",
          status: "verified",
        },
        {
          id: "tl-first-sync",
          date: "NEXT",
          label: "等待首次同步",
          detail: "完成後才建立可比較的 Before → Now。",
          status: "external",
        },
      ],
      sectorGroups: [],
      indicatorSeries: [],
      materialChange: false,
      dipBuyingIndicators: [],
      scenarioPaths: [],
    },
    {
      id: "sit-ai-capex",
      domain: "Industry",
      title: "AI 基礎建設投資循環",
      status: "quiet",
      confidence: 55,
      currentAssessment: "舊版 Replay 保留既有研究脈絡；Live 層等待新的已 ingest 證據。",
      before: "以個股事件串聯 CAPEX 與設備需求。",
      now: "改以算力、晶圓製造、設備、網通等板塊為主，個股只在展開時出現。",
      watchCondition: "板塊需求、供給或資本紀律出現可驗證改變。",
      stopCondition: "只有價格波動，沒有基本面或週期證據。",
      reopenCondition: "財報、官方指引或供應鏈一手資料更新。",
      nextReview: "有新證據時",
      evidence: [],
      timeline: [],
      sectorGroups: [],
      indicatorSeries: [],
      materialChange: false,
      dipBuyingIndicators: [],
      scenarioPaths: [],
    },
    {
      id: "sit-market-pullback",
      domain: "Finance",
      title: "市場中期回調與風險偏好",
      status: "watch",
      confidence: 50,
      currentAssessment: "Finance 面板預設看板塊，不以陌生個股填滿畫面；技術雷達保留在 Replay。",
      before: "八個抄底條件容易被誤讀成總分。",
      now: "估值／超賣、恐慌／去槓桿、價格確認分成獨立證據家族。",
      watchCondition: "板塊廣度、波動、價格結構與使用者關注名單共同觸發。",
      stopCondition: "只有單一超賣訊號，或不同市場資料被混算。",
      reopenCondition: "使用者提供 TradingView 圖或 Watchlist 資料。",
      nextReview: "下一次中期回調",
      evidence: [],
      timeline: [],
      sectorGroups: [],
      indicatorSeries: [],
      materialChange: false,
      dipBuyingIndicators: Object.entries(dipBuyingIndicatorLabels).map(([id, label]) => ({
        id,
        label,
        state: "unavailable",
        asOf: "—",
        reason: "等待有時間戳、可追溯的使用者資料或圖表。",
      })),
      chart: {
        label: "TradingView 多指標圖表",
        state: "unavailable",
        asOf: "—",
        reason: "使用者尚未提供圖表；Alpha 不含自動截圖。",
      },
      scenarioPaths: [],
    },
  ],
  missions: [
    {
      id: "mission-baseline",
      domain: "System",
      title: "完成第一個可重審的 Situation",
      objective: "讓一個世界事件從 Inbox 走完 Situation、Mission 與 Review。",
      whyNow: "先驗證閉環，避免系統退化成新聞儀表板。",
      nextAction: "同步第一批官方 Feed，選一筆建立 Before → Now。",
      doneCondition: "至少一個 Review 能指出原判斷如何被結果修正。",
      reviewDate: "首次同步後 7 天",
      stopCondition: "資料無法追溯到來源或寫入未通過 preview。",
      status: "active",
      situationId: "sit-us-inflation",
    },
  ],
  watching: [
    {
      id: "watch-first-sync",
      label: "美國通膨與 Fed 政策路徑",
      condition: "等待 BLS／BEA／Fed 一手資料形成共同方向變化",
      state: "watching",
      nextCheck: "首次 Feed 同步後",
    },
    {
      id: "watch-pullback",
      label: "市場中期回調",
      condition: "板塊廣度、恐慌與價格確認必須分開判讀",
      state: "paused",
      nextCheck: "使用者提供圖表或 Watchlist 後",
    },
  ],
  reviews: [],
  connectors: [
    { id: "wiki", label: "Wiki source", state: "manual", detail: "唯讀；等待本機 index", lastSeen: "—" },
    { id: "official", label: "Official feeds", state: "offline", detail: "尚未連上本機 collector", lastSeen: "—" },
    { id: "telegram", label: "Telegram", state: "disabled", detail: "未設定 token／allowlist", lastSeen: "—" },
    { id: "truflation", label: "Truflation", state: "manual", detail: "manual-only；API OFF", lastSeen: "—" },
  ],
  briefing: {
    generatedAt: "等待第一份正式 Brief",
    status: "Transcript ready · Audio unavailable",
    duration: "預計 3–6 分鐘",
    transcript: [
      "今天沒有已驗證的重大變化。系統目前以唯讀示範資料呈現，不能被視為即時情報。",
      "第一個需要完成的決策前工作，是建立美國通膨 Situation 的官方基準線，並確認 Telegram 投稿範圍。",
      "在來源同步完成前，保持 No Action；不以一般新聞填充版面。",
    ],
    sources: [
      { label: "Alpha 1.1 架構決策", href: "/replay", status: "product decision" },
      { label: "Truflation 官方頁", href: "https://truflation.com/marketplace/us-inflation-rate", status: "external reference" },
    ],
  },
};

const kindLabels: Record<EvidenceKind, string> = {
  known: "Known",
  inference: "Inference",
  unknown: "Unknown",
  contradiction: "Contradiction",
};

const evidenceViewMeta: Record<EvidenceView, { label: string; helper: string }> = {
  pending: { label: "待驗證", helper: "已收到來源，尚未完成 Wiki S0–S8" },
  contradiction: { label: "矛盾證據", helper: "直接挑戰目前判斷" },
  inference: { label: "推論", helper: "分析判斷，尚非已證實事實" },
  known: { label: "已知", helper: "可追溯且完成驗證" },
  unknown: { label: "待回答", helper: "目前真正缺少的答案或資料" },
};

const healthLabels: Record<HealthState, string> = {
  healthy: "Healthy",
  stale: "Stale",
  offline: "Offline",
  disabled: "Disabled",
  manual: "Manual",
};

function unwrap(value: unknown): Record<string, unknown> | unknown[] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = record.data ?? record.payload;
  if (nested && typeof nested === "object") return nested as Record<string, unknown> | unknown[];
  return record;
}

function readList<T>(value: unknown, keys: string[]): T[] | undefined {
  const payload = unwrap(value);
  if (Array.isArray(payload)) return payload as T[];
  if (!payload) return undefined;
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key] as T[];
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  const payload = unwrap(value);
  return payload && !Array.isArray(payload) ? payload : undefined;
}

type CanonicalRecord = {
  entity_id: string;
  entity_type?: string;
  revision?: number;
  created_at?: string;
  updated_at?: string;
  payload: Record<string, unknown>;
};

function asString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asCanonical(value: unknown): CanonicalRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.entity_id !== "string" || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) return undefined;
  return record as unknown as CanonicalRecord;
}

function cleanSourceText(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#039;", "'")
    .replaceAll("&quot;", '"')
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectSourceLanguage(value: string): InboxItem["sourceLanguage"] {
  if (/[\u3040-\u30ff]/u.test(value)) return "ja";
  if (/[\uac00-\ud7af]/u.test(value)) return "ko";
  const han = value.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  const latin = value.match(/[a-z]/giu)?.length ?? 0;
  if (han >= 4 && han >= latin * 0.25) return "zh-Hant";
  if (latin >= 4) return "en";
  return "other";
}

function boundedForeignExcerpt(title: string, summary: string) {
  const cleaned = cleanSourceText(summary);
  const input = cleaned && cleaned !== title ? cleaned : cleanSourceText(title);
  const sentences = input.match(/[^.!?。！？]+[.!?。！？]+/gu) ?? [];
  const excerpt = sentences.slice(0, 2).join(" ").trim() || input;
  return excerpt.slice(0, 720).trim();
}

function sourceAwareChineseDigest({
  feedId,
  title,
  summary,
  sourceLabel,
  sourcePayload,
  language,
}: {
  feedId: string;
  title: string;
  summary: string;
  sourceLabel: string;
  sourcePayload: Record<string, unknown>;
  language: InboxItem["sourceLanguage"];
}) {
  const text = `${title} ${summary}`.toLocaleLowerCase("en-US");
  if (feedId === "cisa.advisories") {
    const impacts = [
      ["remote code execution", "遠端程式碼執行"],
      ["denial of service", "拒絕服務"],
      ["authentication bypass", "繞過身分驗證"],
      ["credential", "憑證外洩"],
      ["password", "密碼風險"],
      ["information disclosure", "資訊洩露"],
      ["manipulate industrial control", "未授權操控工業控制設備"],
    ].filter(([needle]) => text.includes(needle)).map(([, label]) => label);
    const impact = impacts.length ? `可能造成${[...new Set(impacts)].slice(0, 3).join("、")}` : "涉及工控或關鍵基礎設施弱點";
    return `CISA 發布「${title}」資安公告，${impact}。受影響版本、風險分數與修補／緩解方式請以原文公告為準。`;
  }
  if (feedId === "fed.monetary-policy") {
    if (text.includes("minutes")) return `美國聯準會公布「${title}」會議紀要；重點應與通膨、就業及利率路徑的既有 Situation 交叉驗證。`;
    if (text.includes("projection")) return `美國聯準會發布「${title}」經濟預測資料，涉及成長、通膨、失業率與政策利率路徑。`;
    if (text.includes("fomc statement")) return "美國聯準會發布 FOMC 政策聲明，內容涉及當次利率決策與經濟評估；需和目前的 Fed／通膨 Situation 比較前後差異。";
    return `美國聯準會發布一則貨幣政策資料，原文主題為「${title}」；應併入 Fed 政策方向的證據時間線。`;
  }
  if (feedId === "federal-register.latest") {
    const type = asString(sourcePayload.type, "政策文件");
    const typeLabel = type === "Rule" ? "正式規則" : type === "Proposed Rule" ? "規則草案" : type === "Presidential Document" ? "總統文件" : type;
    return `美國《聯邦公報》發布一則${typeLabel}，原文主題為「${title}」。適用範圍、生效日期與正式要求請查看原始文件。`;
  }
  if (feedId === "treasury.debt-to-penny") {
    const value = asString(sourcePayload.tot_pub_debt_out_amt);
    const date = asString(sourcePayload.record_date);
    return `美國財政部 Debt to the Penny 資料顯示${date ? `，截至 ${date}` : ""}${value ? `公共債務總額為 ${value} 美元` : "公共債務數據已有更新"}。`;
  }
  if (feedId === "bls.us-cpi") return `美國勞工統計局更新 CPI 觀察值，原始資料為「${title}」；指數水準不可直接當成年增率解讀。`;
  if (feedId === "usgs.significant-earthquakes") return `USGS 發布顯著地震事件資料，原文事件為「${title}」；規模、位置與警示狀態以原始事件頁為準。`;
  if (feedId === "cnn.world-news") return `CNN 日本版發布一則國際新聞，原文標題為「${title}」。目前 Feed 僅提供標題，事件細節需由原文頁面確認。`;
  if (feedId.startsWith("telegram.")) return `這是一則你主動提交的${language === "ja" ? "日文" : language === "en" ? "英文" : "非中文"}情報；裝置端翻譯完成前，系統不會自行補寫原文沒有的細節。`;
  return `這是來自「${sourceLabel}」的${language === "ja" ? "日文" : language === "en" ? "英文" : language === "ko" ? "韓文" : "非中文"}資料，主題為「${title}」。內容細節請以原文連結為準。`;
}

function normalizeInbox(value: unknown): InboxItem | undefined {
  const entity = asCanonical(value);
  if (!entity) return value && typeof value === "object" && "id" in value ? value as InboxItem : undefined;
  const payload = entity.payload;
  const sourceUrl = asString(payload.source_url);
  const sourcePayload = payload.source_payload && typeof payload.source_payload === "object" && !Array.isArray(payload.source_payload)
    ? payload.source_payload as Record<string, unknown>
    : {};
  const sourceType = asString(payload.source_type, "manual");
  const routingState = asString(payload.routing_state);
  const rawSummary = asString(payload.summary);
  if (
    sourceType === "wiki_read_only"
    && !(sourcePayload.decision_grade === true && sourcePayload.source_excerpt_included === true)
  ) return undefined;
  if (sourceType === "official_feed" && (routingState === "quiet_inbox" || rawSummary.length < 40)) {
    return undefined;
  }
  const title = asString(payload.title, "未命名 Inbox item");
  const originalSummary = rawSummary || "這筆人工投稿尚未加入可判斷的摘要。";
  const sourceLabel = asString(
    payload.source_label,
    asString(payload.feed_id, asString(payload.external_event_id).split(":")[0] || "Local intelligence"),
  );
  const feedId = asString(payload.feed_id);
  const sourceLanguage = detectSourceLanguage(`${title}\n${originalSummary}`);
  const canonicalChinese = asString(payload.summary_zh);
  const matchedInterests = asStringList(payload.matched_interest_ids);
  const summary = sourceLanguage === "zh-Hant"
    ? originalSummary
    : canonicalChinese || sourceAwareChineseDigest({ feedId, title, summary: originalSummary, sourceLabel, sourcePayload, language: sourceLanguage });
  const whatChanged = asString(sourcePayload.what_changed, summary);
  const whyRelevant = asString(
    sourcePayload.why_relevant,
    matchedInterests.length
      ? `命中你正在追蹤的 Situation／Mission／Watch：${matchedInterests.slice(0, 3).join("、")}。`
      : `系統判定這筆內容與 ${asString(payload.domain, "world")} 情報範圍相關，但尚未連結到特定 Situation。`,
  );
  const stillUnknown = asString(
    sourcePayload.still_unknown,
    asString(payload.evidence_status, "unverified_external") === "verified"
      ? "尚未判定這項事實是否足以改變既有路徑或行動。"
      : "來源內容尚未完成獨立交叉驗證；右滑只代表有興趣，不代表消息為真。",
  );
  return {
    id: entity.entity_id,
    revision: entity.revision,
    status: asString(payload.status, "new"),
    domain: asString(payload.domain, "world"),
    sourceType,
    sourceLabel,
    title,
    summary,
    originalSummary,
    sourceLanguage,
    summaryKind: sourceLanguage === "zh-Hant" ? "original_chinese" : canonicalChinese ? "canonical_chinese" : "source_aware_fallback",
    ...(sourceLanguage === "zh-Hant" ? {} : { translationInput: boundedForeignExcerpt(title, originalSummary) }),
    whatChanged,
    whyRelevant,
    stillUnknown,
    observedAt: asString(payload.observed_at, entity.updated_at ?? "—"),
    evidenceStatus: asString(payload.evidence_status, "unverified_external"),
    matchedInterests,
    contentHash: asString(payload.content_hash, asString(sourcePayload.wiki_sha256)) || undefined,
    source: sourceUrl ? { label: asString(payload.source_label, /^https?:\/\//i.test(sourceUrl) ? "查看原文" : "開啟來源"), href: sourceUrl } : undefined,
  };
}

function normalizeSignal(value: unknown): LiveSignal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const id = asString(item.id);
  const rawStatus = asString(item.status);
  if (!id || !["candidate", "live_signal", "corroborated"].includes(rawStatus)) return undefined;
  const sourceUrl = asString(item.source_url);
  const title = asString(item.title, "Telegram 群組訊號");
  const summary = asString(item.summary, "這則訊號尚未包含可顯示的文字。");
  const preview = item.decision_preview && typeof item.decision_preview === "object" && !Array.isArray(item.decision_preview)
    ? item.decision_preview as Record<string, unknown>
    : undefined;
  const scenarios = Array.isArray(preview?.scenario_probabilities)
    ? preview.scenario_probabilities.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const entry = value as Record<string, unknown>;
        return { label: asString(entry.label, "情境"), probability: asNumber(entry.probability, 0) };
      }).filter((entry): entry is { label: string; probability: number } => Boolean(entry))
    : [];
  return {
    id,
    status: rawStatus as LiveSignal["status"],
    title,
    summary,
    sourceLanguage: detectSourceLanguage(`${title}\n${summary}`),
    firstSeenAt: asString(item.first_seen_at, "—"),
    lastSeenAt: asString(item.last_seen_at, "—"),
    mentionCount: asNumber(item.mention_count, 1),
    independentSourceCount: asNumber(item.independent_source_count, 1),
    velocityLabel: asString(item.velocity_label, "單一來源"),
    score: asNumber(item.score, 0),
    matchedInterestIds: asStringList(item.matched_interest_ids),
    source: sourceUrl ? { label: "開啟 Telegram 來源", href: sourceUrl } : undefined,
    decisionPreview: preview ? {
      situationId: asString(preview.situation_id),
      situationTitle: asString(preview.situation_title, "關聯 Situation"),
      before: asString(preview.before, "尚未建立基準"),
      newSignal: asString(preview.new_signal, summary),
      verification: asString(preview.verification, "unverified_group_lead"),
      scenarioProbabilities: scenarios,
      probabilityChange: asString(preview.probability_change, "尚未套用"),
    } : undefined,
  };
}

function signalAsInbox(signal: LiveSignal): InboxItem {
  return {
    id: signal.id,
    revision: 0,
    status: "new",
    domain: signal.decisionPreview?.situationTitle ?? "World / General",
    sourceType: "telegram sensor",
    sourceLabel: "Telegram 私人群組",
    title: signal.title,
    summary: signal.sourceLanguage === "zh-Hant"
      ? signal.summary
      : `這是一則 Telegram 群組中的${signal.sourceLanguage === "ja" ? "日文" : signal.sourceLanguage === "en" ? "英文" : "非中文"}即時訊號；裝置端翻譯完成前不補寫原文沒有的細節。`,
    originalSummary: signal.summary,
    sourceLanguage: signal.sourceLanguage,
    summaryKind: signal.sourceLanguage === "zh-Hant" ? "original_chinese" : "source_aware_fallback",
    ...(signal.sourceLanguage === "zh-Hant" ? {} : { translationInput: boundedForeignExcerpt(signal.title, signal.summary) }),
    whatChanged: signal.summary,
    whyRelevant: signal.matchedInterestIds.length
      ? `這則即時訊號命中 ${signal.matchedInterestIds.slice(0, 3).join("、")}；目前只要求你判斷是否值得繼續追蹤。`
      : "這是 Telegram Fast Lane 的高時效候選；尚未連結到既有 Situation。",
    stillUnknown: `${signal.independentSourceCount} 個獨立來源；尚未完成官方或市場反應驗證。`,
    observedAt: signal.lastSeenAt,
    evidenceStatus: "unverified_external",
    matchedInterests: signal.matchedInterestIds,
    source: signal.source,
    origin: "signal",
    signalId: signal.id,
    signalStatus: signal.status,
    signalScore: signal.score,
    mentionCount: signal.mentionCount,
    independentSourceCount: signal.independentSourceCount,
    velocityLabel: signal.velocityLabel,
  };
}

function normalizeEvidence(value: unknown, index: number): Evidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const kind = asString(item.kind, "unknown") as EvidenceKind;
  if (!Object.hasOwn(kindLabels, kind)) return undefined;
  const href = asString(item.source_url);
  return {
    id: asString(item.id, `evidence-${index}`),
    kind,
    text: asString(item.text, asString(item.summary, "未命名證據")),
    sourceInboxId: asString(item.source_inbox_id) || undefined,
    sourceTitle: asString(item.source_title) || undefined,
    evidenceStatus: asString(item.evidence_status) || undefined,
    s0S8State: asString(item.s0_s8_state) || undefined,
    asOf: asString(item.as_of) || undefined,
    observedAt: asString(item.observed_at) || undefined,
    source: href ? { label: asString(item.source_label, "開啟來源"), href } : undefined,
  };
}

function normalizeTimeline(value: unknown, index: number): TimelinePoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const rawStatus = asString(item.status, "external");
  const status = (["verified", "external", "manual"].includes(rawStatus) ? rawStatus : "external") as TimelinePoint["status"];
  return {
    id: asString(item.id, `timeline-${index}`),
    date: asString(item.date, asString(item.observed_at, "—")),
    label: asString(item.label, asString(item.title, "Observation")),
    detail: asString(item.detail, asString(item.summary, "")),
    status,
  };
}

function normalizeObservedValue(item: Record<string, unknown>) {
  const rawValue = item.value;
  const value = typeof rawValue === "number" && Number.isFinite(rawValue)
    ? String(rawValue)
    : asString(rawValue);
  if (!value) return undefined;
  const unit = asString(item.unit);
  return unit ? `${value} ${unit}` : value;
}

function normalizeDipBuyingIndicators(value: unknown): DipBuyingIndicator[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const id = asString(item.id);
    if (!Object.hasOwn(dipBuyingIndicatorLabels, id) || byId.has(id)) continue;
    byId.set(id, item);
  }
  return Object.entries(dipBuyingIndicatorLabels).flatMap(([id, label]) => {
    const item = byId.get(id);
    if (!item) return [];
    return [{
      id,
      label,
      state: asString(item.state, "unavailable"),
      asOf: asString(item.as_of, "—"),
      value: normalizeObservedValue(item),
      reason: asString(item.reason, "未提供判讀理由。"),
    }];
  });
}

function normalizePullbackChart(value: unknown): PullbackChart | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  return {
    label: asString(item.label, "TradingView 多指標圖表"),
    state: asString(item.state, "unavailable"),
    asOf: asString(item.as_of, "—"),
    value: normalizeObservedValue(item),
    reason: asString(item.reason, "尚未提供圖表狀態說明。"),
  };
}

function normalizeScenarioPaths(value: unknown): ScenarioPath[] {
  if (!Array.isArray(value) || value.length !== 3) return [];
  const paths = value.slice(0, 3).flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    const probability = Math.max(0, Math.min(100, asNumber(item.probability, 0)));
    const rawTone = asString(item.tone, index === 0 ? "base" : index === 1 ? "stress" : "upside");
    const tone = (["base", "upside", "stress"].includes(rawTone) ? rawTone : "base") as ScenarioPath["tone"];
    return [{
      id: asString(item.id, `path-${index + 1}`),
      label: asString(item.label, `路徑 ${index + 1}`),
      probability,
      summary: asString(item.summary, "尚未加入路徑摘要。"),
      trigger: asString(item.trigger, "尚未設定觸發條件。"),
      implication: asString(item.implication, "尚未設定決策含義。"),
      invalidation: asString(item.invalidation, "尚未設定失效條件。"),
      tone,
    }];
  });
  if (paths.length !== 3) return [];
  const total = paths.reduce((sum, path) => sum + path.probability, 0);
  if (Math.abs(total - 100) > 0.001) return [];
  return paths;
}

function normalizeSituation(value: unknown): Situation | undefined {
  const entity = asCanonical(value);
  if (!entity) return value && typeof value === "object" && "id" in value ? value as Situation : undefined;
  const payload = entity.payload;
  const domain = asString(payload.domain, "General");
  const rawStatus = asString(payload.status, "watch");
  const status = rawStatus === "closed" ? "quiet" : (["active", "watch", "quiet"].includes(rawStatus) ? rawStatus : "watch") as Situation["status"];
  const watchConditions = asStringList(payload.watch_conditions);
  const evidence = Array.isArray(payload.evidence) ? payload.evidence.map(normalizeEvidence).filter((item): item is Evidence => Boolean(item)) : [];
  const timeline = Array.isArray(payload.timeline) ? payload.timeline.map(normalizeTimeline).filter((item): item is TimelinePoint => Boolean(item)) : [];
  const sectorGroups = Array.isArray(payload.sector_groups) ? payload.sector_groups.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const name = asString(item.name, asString(item.label));
    if (!name) return [];
    return [{
      name,
      state: asString(item.state, "watch").toUpperCase(),
      note: asString(item.note, "尚未加入判讀"),
      members: asStringList(item.members),
    }];
  }) : [];
  const indicatorAvailability = payload.indicator_availability
    && typeof payload.indicator_availability === "object"
    && !Array.isArray(payload.indicator_availability)
    ? payload.indicator_availability as Record<string, unknown>
    : undefined;
  const rawIndicatorSeries = [
    ...(Array.isArray(indicatorAvailability?.indicators) ? indicatorAvailability.indicators : []),
    ...(Array.isArray(payload.indicator_series) ? payload.indicator_series : []),
  ];
  const normalizedIndicatorSeries = rawIndicatorSeries.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const label = asString(item.label, asString(item.series_id));
    if (!label) return [];
    const rawFamily = asString(item.series_id, asString(item.series, asString(item.id, label)))
      .toLocaleLowerCase();
    const family = rawFamily.includes("cuur0000sa0") || rawFamily.includes("bls")
      ? "bls-cpi"
      : rawFamily.includes("trucpi") || rawFamily.includes("truflation")
        ? "truflation-us"
        : rawFamily.includes("pce") || rawFamily.includes("bea")
          ? "bea-pce"
          : rawFamily;
    return [{
      family,
      label,
      value: typeof item.value === "number" && Number.isFinite(item.value) ? item.value : undefined,
      unit: asString(item.unit, "unit unavailable"),
      asOf: asString(item.as_of, "—"),
      status: asString(item.evidence_status, asString(item.status, asString(item.state, "unavailable"))),
    }];
  });
  const latestByFamily = new Map<string, (typeof normalizedIndicatorSeries)[number]>();
  for (const candidate of normalizedIndicatorSeries) {
    const current = latestByFamily.get(candidate.family);
    const candidateTime = Date.parse(candidate.asOf);
    const currentTime = Date.parse(current?.asOf ?? "");
    if (
      !current
      || (candidate.value !== undefined && current.value === undefined)
      || (candidate.value !== undefined && current.value !== undefined
        && Number.isFinite(candidateTime)
        && (!Number.isFinite(currentTime) || candidateTime >= currentTime))
    ) {
      latestByFamily.set(candidate.family, candidate);
    }
  }
  const indicatorSeries = [...latestByFamily.values()].map((series) => ({
    label: series.label,
    value: series.value,
    unit: series.unit,
    asOf: series.asOf,
    status: series.status,
  }));
  return {
    id: entity.entity_id,
    revision: entity.revision,
    domain,
    title: asString(payload.title, "未命名 Situation"),
    status,
    confidence: asNumber(payload.confidence, 50),
    currentAssessment: asString(payload.current_assessment, "尚未形成 current assessment。"),
    before: asString(payload.before, "尚未建立基準線。"),
    now: asString(payload.now, "等待新證據。"),
    watchCondition: watchConditions.join("；") || asString(payload.watch_condition, "尚未設定"),
    stopCondition: asString(payload.stop_condition, "尚未設定"),
    reopenCondition: asString(payload.reopen_condition, "尚未設定"),
    nextReview: asString(payload.next_review_at, "條件命中時"),
    evidence,
    timeline,
    sectorGroups,
    indicatorSeries,
    materialChange: payload.material_change === true,
    dipBuyingIndicators: normalizeDipBuyingIndicators(payload.pullback_indicators),
    chart: normalizePullbackChart(payload.chart),
    scenarioPaths: normalizeScenarioPaths(payload.scenario_paths),
    intelligenceQuestion: asString(payload.intelligence_question) || undefined,
    forecastHorizon: asString(payload.forecast_horizon) || undefined,
    nextObservable: asString(payload.next_observable) || undefined,
  };
}

function normalizeMission(value: unknown): Mission | undefined {
  const entity = asCanonical(value);
  if (!entity) return value && typeof value === "object" && "id" in value ? value as Mission : undefined;
  const payload = entity.payload;
  const rawStatus = asString(payload.status, "active");
  const status = (["active", "blocked", "completed", "cancelled", "watch"].includes(rawStatus) ? rawStatus : "watch") as Mission["status"];
  const rawDraft = payload.adjustment_draft && typeof payload.adjustment_draft === "object" && !Array.isArray(payload.adjustment_draft)
    ? payload.adjustment_draft as Record<string, unknown>
    : undefined;
  const draftStatus = asString(rawDraft?.proposed_status);
  const adjustmentDraft = rawDraft ? {
    rationale: asString(rawDraft.rationale),
    nextAction: asString(rawDraft.next_action),
    reviewDate: asString(rawDraft.review_date),
    proposedStatus: (draftStatus === "blocked" ? "blocked" : "active") as "active" | "blocked",
  } : undefined;
  return {
    id: entity.entity_id,
    revision: entity.revision,
    domain: asString(payload.domain, "General"),
    title: asString(payload.title, asString(payload.objective, "未命名 Mission")),
    objective: asString(payload.objective, "尚未定義"),
    whyNow: asString(payload.why_now, "尚未補充"),
    nextAction: asString(payload.next_action, "尚未設定下一個行動"),
    doneCondition: asString(payload.done_condition, "尚未設定"),
    reviewDate: asString(payload.review_date, "條件命中時"),
    stopCondition: [asString(payload.stop_condition), asString(payload.reopen_condition)].filter(Boolean).join("／") || "尚未設定",
    status,
    situationId: asString(payload.situation_id) || undefined,
    adjustmentDraft,
  };
}

function normalizeReview(value: unknown): Review | undefined {
  const entity = asCanonical(value);
  if (!entity) return value && typeof value === "object" && "id" in value ? value as Review : undefined;
  const payload = entity.payload;
  return {
    id: entity.entity_id,
    revision: entity.revision,
    missionTitle: asString(payload.mission_title, asString(payload.title, "Review")),
    date: asString(payload.reviewed_at, entity.updated_at ?? "—"),
    outcome: asString(payload.outcome, "尚未記錄"),
    assessmentChange: asString(payload.assessment_change, asStringList(payload.lessons).join("；") || "尚未記錄"),
    nextState: asString(payload.next_state, "待確認"),
  };
}

function normalizeAttention(value: unknown, validSituationIds = new Set<string>()): AttentionItem | undefined {
  const entity = asCanonical(value);
  if (!entity) return value && typeof value === "object" && "id" in value ? value as AttentionItem : undefined;
  const payload = entity.payload;
  const priority = asString(payload.priority, "P1");
  const draft = payload.adjustment_draft && typeof payload.adjustment_draft === "object" && !Array.isArray(payload.adjustment_draft)
    ? payload.adjustment_draft as Record<string, unknown>
    : {};
  const sourceUrl = asString(payload.source_url);
  const structuredTarget = Array.isArray(payload.matched_context) ? payload.matched_context.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const match = value as Record<string, unknown>;
    const id = asString(match.id);
    return asString(match.kind).toLocaleLowerCase() === "situation" && validSituationIds.has(id) ? [id] : [];
  })[0] : undefined;
  const linkedTarget = asString(payload.linked_situation_id);
  return {
    id: entity.entity_id,
    revision: entity.revision,
    entityType: entity.entity_type,
    eyebrow: `${entity.entity_type ?? "INTELLIGENCE"} · NEEDS YOU`,
    title: asString(payload.title, asString(payload.objective, "需要確認")),
    summary: asString(payload.summary, asString(payload.current_assessment, asString(payload.why_now, asString(payload.next_action, "需要使用者決定下一步。")))),
    due: asString(payload.review_date, asString(payload.next_review_at)) || undefined,
    priority: (["P0", "P1", "P2"].includes(priority) ? priority : "P1") as AttentionItem["priority"],
    source: sourceUrl ? { label: asString(payload.source_label, "開啟來源"), href: sourceUrl } : undefined,
    targetSituationId: entity.entity_type === "Situation" && validSituationIds.has(entity.entity_id)
      ? entity.entity_id
      : structuredTarget
      ?? (validSituationIds.has(linkedTarget) ? linkedTarget : undefined)
      ?? asStringList(payload.matched_interest_ids).find((id) => validSituationIds.has(id)),
    targetMissionId: entity.entity_type === "Mission" ? entity.entity_id : undefined,
    draftBefore: asString(draft.before) || undefined,
    draftNow: asString(draft.now) || undefined,
    draftImpact: asString(draft.impact) || undefined,
    draftRationale: asString(draft.rationale) || undefined,
    draftNextAction: asString(draft.next_action) || undefined,
    draftReviewDate: asString(draft.review_date) || undefined,
    draftStatus: asString(draft.proposed_status) === "blocked" ? "blocked" : asString(draft.proposed_status) === "active" ? "active" : undefined,
  };
}

function normalizeChange(value: unknown): ChangeItem | undefined {
  const entity = asCanonical(value);
  if (!entity) return value && typeof value === "object" && "id" in value ? value as ChangeItem : undefined;
  const payload = entity.payload;
  return {
    id: entity.entity_id,
    revision: entity.revision,
    domain: asString(payload.domain, "General"),
    title: asString(payload.title, "Material change"),
    before: asString(payload.before, "尚未建立基準線"),
    now: asString(payload.now, asString(payload.current_assessment, "等待更新")),
    impact: asString(payload.impact, "需要重新評估 Situation"),
    observedAt: asString(payload.observed_at, entity.updated_at ?? "—"),
    evidenceStatus: asString(payload.evidence_status, "derived_assessment"),
  };
}

function normalizeWatch(value: unknown): WatchItem | undefined {
  const entity = asCanonical(value);
  if (!entity) return value && typeof value === "object" && "id" in value ? value as WatchItem : undefined;
  const payload = entity.payload;
  const conditions = asStringList(payload.watch_conditions);
  return {
    id: entity.entity_id,
    label: asString(payload.title, "Watch condition"),
    condition: conditions.join("；") || asString(payload.watch_condition, "等待條件定義"),
    state: "watching",
    nextCheck: asString(payload.next_review_at) || undefined,
  };
}

function normalizeConnector(value: unknown): ConnectorHealth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if ("id" in item && "state" in item && "label" in item) return item as unknown as ConnectorHealth;
  const raw = asString(item.health_state, asString(item.state, "offline"));
  const state: HealthState = raw === "healthy" ? "healthy" : raw === "disabled" ? "disabled" : raw === "stale" || raw === "degraded" || raw === "coverage_gap" ? "stale" : "offline";
  return {
    id: asString(item.connector_id, asString(item.feed_id, "connector")),
    label: asString(item.label, asString(item.connector_id, asString(item.feed_id, "Connector"))),
    state,
    detail: asString(item.message, asString(item.disabled_reason, asString(item.coverage_state, raw))),
    lastSeen: asString(item.last_success_at, asString(item.checked_at)) || undefined,
  };
}

function normalizeForwardEvent(value: unknown): ForwardEventWindow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const id = asString(item.id);
  const scheduledAt = asString(item.scheduled_at);
  if (!id || !scheduledAt) return undefined;
  const rawState = asString(item.state, "scheduled");
  const state = (["scheduled", "armed", "live", "closed"].includes(rawState) ? rawState : "scheduled") as ForwardEventWindow["state"];
  const sourceUrl = asString(item.source_url);
  return {
    id,
    title: asString(item.title, asString(item.release_type, "Scheduled event")),
    releaseType: asString(item.release_type, "event"),
    priority: asString(item.priority, "high"),
    scheduledAt,
    opensAt: asString(item.opens_at, scheduledAt),
    closesAt: asString(item.closes_at, scheduledAt),
    state,
    secondsToRelease: asNumber(item.seconds_to_release, 0),
    consensusState: asString(item.consensus_state, "missing_legal_source"),
    source: sourceUrl ? { label: "官方行事曆", href: sourceUrl } : undefined,
  };
}

function normalizeForwardPulse(value: unknown): ForwardPulse | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const id = asString(item.id);
  if (!id) return undefined;
  const factRaw = asString(item.fact_state, "unverified");
  const impactRaw = asString(item.impact_state, "not_observed");
  const factState = (["unverified", "source_matched", "official_confirmed", "conflicted"].includes(factRaw) ? factRaw : "unverified") as ForwardPulse["factState"];
  const impactState = (["not_observed", "market_reacting", "mixed", "contradictory"].includes(impactRaw) ? impactRaw : "not_observed") as ForwardPulse["impactState"];
  const rawClaim = item.parsed_claim && typeof item.parsed_claim === "object" && !Array.isArray(item.parsed_claim)
    ? item.parsed_claim as Record<string, unknown>
    : undefined;
  const numberOrUndefined = (candidate: unknown) => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
  const sourceUrl = asString(item.source_url);
  return {
    id,
    title: asString(item.title, asString(rawClaim?.metric_label, "Telegram Flash")),
    factState,
    impactState,
    firstSeenAt: asString(item.first_seen_at, "—"),
    lastSeenAt: asString(item.last_seen_at, "—"),
    independentSourceCount: asNumber(item.independent_source_count, 0),
    mentionCount: asNumber(item.mention_count, 1),
    sourceLabel: asString(item.source_label, "轉傳來源未公開"),
    source: sourceUrl ? { label: "開啟投稿", href: sourceUrl } : undefined,
    claim: rawClaim ? {
      metricLabel: asString(rawClaim.metric_label, "經濟指標"),
      actual: numberOrUndefined(rawClaim.actual),
      forecast: numberOrUndefined(rawClaim.forecast),
      previous: numberOrUndefined(rawClaim.previous),
      surprise: numberOrUndefined(rawClaim.surprise),
      unit: asString(rawClaim.unit, "number"),
      pressureLabel: asString(rawClaim.pressure_label, "方向待判讀"),
      confidence: asNumber(rawClaim.extraction_confidence, 0),
    } : undefined,
  };
}

function normalizeForwardNow(value: unknown): ForwardNowModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return seedData.forward;
  const item = value as Record<string, unknown>;
  const eventRadar = (Array.isArray(item.event_radar) ? item.event_radar : [])
    .map(normalizeForwardEvent)
    .filter((entry): entry is ForwardEventWindow => Boolean(entry));
  const nextEvent = normalizeForwardEvent(item.next_event);
  const livePulse = (Array.isArray(item.live_pulse) ? item.live_pulse : [])
    .map(normalizeForwardPulse)
    .filter((entry): entry is ForwardPulse => Boolean(entry));
  const pathMap = (Array.isArray(item.path_map) ? item.path_map : []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const path = candidate as Record<string, unknown>;
    const paths = normalizeScenarioPaths(path.paths);
    if (paths.length !== 3) return [];
    const calibration = asString(path.calibration_state, "heuristic");
    return [{
      situationId: asString(path.situation_id),
      situationTitle: asString(path.situation_title, "Situation"),
      intelligenceQuestion: asString(path.intelligence_question, "哪個 observable 會改變目前路徑？"),
      horizon: asString(path.horizon, "未設定"),
      calibrationState: (["heuristic", "calibrating", "calibrated"].includes(calibration) ? calibration : "heuristic") as ForwardPathMap["calibrationState"],
      comparableEventCount: asNumber(path.comparable_event_count, 0),
      nextObservable: asString(path.next_observable) || undefined,
      paths,
    }];
  });
  const decisionGates = (Array.isArray(item.decision_gates) ? item.decision_gates : []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const gate = candidate as Record<string, unknown>;
    const kind = asString(gate.kind, "signal");
    if (!["signal", "situation", "mission"].includes(kind)) return [];
    return [{
      id: asString(gate.id),
      kind: kind as ForwardDecisionGate["kind"],
      title: asString(gate.title, "Decision gate"),
      state: asString(gate.state, "pending"),
      reason: asString(gate.reason, "等待使用者判斷。"),
      dueAt: asString(gate.due_at) || undefined,
      signalId: asString(gate.signal_id) || undefined,
      situationId: asString(gate.situation_id) || undefined,
      missionId: asString(gate.mission_id) || undefined,
    }];
  });
  const coverageHealth = (Array.isArray(item.coverage_health) ? item.coverage_health : []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const coverage = candidate as Record<string, unknown>;
    const raw = asString(coverage.state, "offline");
    const state: HealthState = raw === "healthy" ? "healthy" : raw === "disabled" ? "disabled" : raw === "degraded" || raw === "stale" ? "stale" : "offline";
    return [{
      id: asString(coverage.feed_id, "forward-coverage"),
      label: asString(coverage.label, asString(coverage.feed_id, "Coverage")),
      state,
      coverageState: asString(coverage.coverage_state, "unknown"),
      detail: asString(coverage.message, raw),
      checkedAt: asString(coverage.checked_at) || undefined,
    }];
  });
  const latency = item.latency_budget && typeof item.latency_budget === "object" && !Array.isArray(item.latency_budget)
    ? item.latency_budget as Record<string, unknown>
    : {};
  return {
    mode: asString(item.mode, "forward_intelligence_v2"),
    asOf: asString(item.as_of, "—"),
    eventRadar,
    nextEvent,
    livePulse,
    pathMap,
    decisionGates,
    coverageHealth,
    latencyTargetMs: asNumber(latency.deterministic_flash_p95_target_ms, 3_000),
  };
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeEvidenceLoop(value: unknown): EvidenceLoopModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return seedData.evidenceLoop;
  const item = value as Record<string, unknown>;
  const facts = (Array.isArray(item.facts) ? item.facts : []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const fact = candidate as Record<string, unknown>;
    const payload = fact.payload && typeof fact.payload === "object" && !Array.isArray(fact.payload)
      ? fact.payload as Record<string, unknown>
      : {};
    const reactionRecord = fact.reaction && typeof fact.reaction === "object" && !Array.isArray(fact.reaction)
      ? fact.reaction as Record<string, unknown>
      : undefined;
    const moves = (Array.isArray(reactionRecord?.moves) ? reactionRecord.moves : []).flatMap((move) => {
      if (!move || typeof move !== "object" || Array.isArray(move)) return [];
      const entry = move as Record<string, unknown>;
      const symbol = asString(entry.symbol);
      const returnPercent = optionalFiniteNumber(entry.return_percent);
      if (!symbol || returnPercent === undefined) return [];
      return [{
        symbol,
        returnPercent,
        abnormalReturnPercent: optionalFiniteNumber(entry.abnormal_return_percent),
      }];
    });
    const sourceUrl = asString(fact.source_url, asString(payload.sec_archive_url));
    return [{
      id: asString(fact.external_event_id, asString(fact.content_hash)),
      title: asString(fact.title, "SEC filing"),
      company: asString(payload.company, "Watchlist company"),
      form: asString(payload.form, "FILING"),
      symbols: Array.isArray(payload.symbols) ? payload.symbols.map((symbol) => asString(symbol)).filter(Boolean) : [],
      publishedAt: asString(fact.published_at, asString(fact.observed_at, "—")),
      source: sourceUrl ? { label: "SEC filing", href: sourceUrl } : undefined,
      baselineOnly: payload.baseline_only === true,
      reactionState: asString(fact.reaction_state, "not_scheduled"),
      reaction: reactionRecord ? {
        feed: asString(reactionRecord.feed, "unknown"),
        coverage: asString(reactionRecord.coverage, "unknown"),
        windowMinutes: asNumber(reactionRecord.window_minutes, 15),
        benchmark: asString(reactionRecord.benchmark, "SPY"),
        moves,
      } : undefined,
    }];
  });
  const macro = (Array.isArray(item.macro_background) ? item.macro_background : []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const entry = candidate as Record<string, unknown>;
    const id = asString(entry.series_id);
    if (!id) return [];
    const sourceUrl = asString(entry.source_url);
    return [{
      id,
      label: asString(entry.label, id),
      value: optionalFiniteNumber(entry.value),
      previousValue: optionalFiniteNumber(entry.previous_value),
      delta: optionalFiniteNumber(entry.delta),
      unit: asString(entry.unit, "number"),
      observationDate: asString(entry.observation_date, "—"),
      realtimeStart: asString(entry.realtime_start, "—"),
      realtimeEnd: asString(entry.realtime_end, "—"),
      coverageState: asString(entry.coverage_state, "unknown"),
      source: sourceUrl ? { label: `FRED ${id}`, href: sourceUrl } : undefined,
    }];
  });
  return {
    mode: asString(item.mode, "fact_context_reaction_v1"),
    asOf: asString(item.as_of, "—"),
    facts,
    macro,
    pendingReactionCount: asNumber(item.pending_reaction_count, 0),
    incompleteReasons: Array.isArray(item.incomplete_reasons)
      ? item.incomplete_reasons.map((reason) => asString(reason)).filter(Boolean)
      : [],
  };
}

function normalizeBriefing(value: unknown): Briefing | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (Array.isArray(item.transcript)) {
    const audio = item.audio && typeof item.audio === "object" ? item.audio as Record<string, unknown> : {};
    const seconds = typeof item.duration_seconds_estimate === "number" ? item.duration_seconds_estimate : 0;
    const sources = Array.isArray(item.sources) ? item.sources.flatMap((source) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) return [];
      const record = source as Record<string, unknown>;
      const href = asString(record.href);
      return href ? [{ label: asString(record.title, "Source"), href, status: asString(record.as_of) || undefined }] : [];
    }) : [];
    return {
      generatedAt: asString(item.generated_at, "即時投影"),
      status: `${asString(item.state, "quiet")} · Audio ${asString(audio.state, "unavailable")}`,
      duration: seconds ? `約 ${Math.max(1, Math.round(seconds / 60))} 分鐘` : "安靜模式",
      transcript: item.transcript.map((paragraph) => asString(paragraph)).filter(Boolean),
      sources,
    };
  }
  const entities = Array.isArray(item.items) ? item.items.map(asCanonical).filter((entry): entry is CanonicalRecord => Boolean(entry)) : [];
  return {
    generatedAt: asString(item.generated_at, asString(item.latest_review_at, "即時投影")),
    status: `${asString(item.status, "quiet")} · Audio unavailable`,
    duration: entities.length ? "預計 3–6 分鐘" : "安靜模式",
    transcript: entities.length
      ? entities.slice(0, 3).map((entity) => asString(entity.payload.summary, asString(entity.payload.current_assessment, asString(entity.payload.next_action, asString(entity.payload.title, asString(entity.payload.objective, "待處理情報"))))))
      : ["今天沒有需要升級的重大變化；一般新聞不會用來填滿 Brief。"],
    sources: entities.map((entity) => ({ label: asString(entity.payload.title, entity.entity_id), href: asString(entity.payload.source_url, "#") })),
  };
}

async function getJson(path: string) {
  const response = await fetch(path, { cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function requestTypedCommandPreview(
  command: string,
  data: Record<string, unknown>,
  { userConfirmation = false }: { userConfirmation?: boolean } = {},
) {
  const response = await fetch("/api/v1/commands/preview", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ command, data, user_confirmation: userConfirmation }),
  });
  const raw = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = readRecord(raw.error);
    throw new Error(asString(error?.message, `preview returned ${response.status}`));
  }
  const body = readRecord(raw) ?? raw;
  const previewId = asString(body.preview_id) || undefined;
  const previewIds = Array.isArray(body.preview_ids) ? body.preview_ids.filter((value): value is string => typeof value === "string" && Boolean(value)) : [];
  if (!previewId && previewIds.length === 0) throw new Error("preview response did not include a preview token");
  return {
    previewId,
    previewIds,
    baseRevision: typeof body.base_revision === "number" ? body.base_revision : 0,
    diff: Array.isArray(body.diff) ? body.diff.map(formatDiffLine) : [],
    operationCount: typeof body.operation_count === "number" ? body.operation_count : 1,
  };
}

function dateInput(daysFromNow = 7) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

function dateInputFrom(value: string | undefined, daysFromNow = 7) {
  const match = value?.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? dateInput(daysFromNow);
}

function displayDate(value: string | undefined) {
  const match = value?.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : value || "—";
}

function formatDiffLine(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    if (typeof item.path === "string") {
      return `${item.path}: ${JSON.stringify(item.before ?? null)} → ${JSON.stringify(item.after ?? null)}`;
    }
  }
  return JSON.stringify(value);
}

function sourceLink(source?: SourceRef) {
  if (!source) return null;
  const external = /^https?:\/\//i.test(source.href);
  return (
    <a className="live-source-link" href={source.href} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined}>
      {source.label} <span aria-hidden="true">↗</span>
    </a>
  );
}

function WorkflowDialog({
  state,
  situations,
  onClose,
  onSubmit,
}: {
  state: WorkflowDialogState;
  situations: Situation[];
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const titles: Record<WorkflowKind, { kicker: string; title: string; submit: string }> = {
    link_situation: { kicker: "RELATION", title: "連結既有 Situation", submit: "預覽連結" },
    create_situation: { kicker: "INBOX → SITUATION", title: "建立可持續追蹤的 Situation", submit: "預覽 Situation＋Inbox" },
    create_mission: { kicker: "SITUATION → MISSION", title: "建立唯一下一步", submit: "預覽 Mission" },
    record_result: { kicker: "ACTION RESULT", title: "記錄行動結果", submit: "預覽結果" },
    mission_adjustment: { kicker: "AGENT DRAFT", title: "草擬 Mission 調整", submit: "預覽草稿" },
    situation_adjustment: { kicker: "BEFORE → NOW", title: "草擬 Situation 調整", submit: "預覽草稿" },
    forecast_update: { kicker: "FORECAST LEDGER", title: "建立三路徑預測", submit: "預覽機率與路徑" },
    create_review: { kicker: "CLOSE THE LOOP", title: "建立 Review 並決定 Mission 狀態", submit: "預覽 Review＋Mission" },
  };
  const copy = titles[state.kind];
  const mission = state.mission;
  const situation = state.situation;
  const inbox = state.inbox;
  return (
    <div className="live-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="live-telegram-dialog live-workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-title">
        <header>
          <div><span>{copy.kicker}</span><h2 id="workflow-title">{copy.title}</h2></div>
          <button type="button" aria-label="關閉工作流程" onClick={onClose}>×</button>
        </header>
        <div className="live-telegram-boundary">
          <strong>{inbox?.title ?? mission?.title ?? situation?.title ?? "使用者主動建立"}</strong>
          <p>所有必填欄位完成後只會產生 diff；再次確認才寫入 canonical intelligence。</p>
        </div>
        <form key={`${state.kind}-${inbox?.id ?? mission?.id ?? situation?.id ?? "new"}`} onSubmit={onSubmit}>
          {state.kind === "link_situation" && (
            <label><span>Situation</span><select name="situation_id" required defaultValue=""><option value="" disabled>選擇 Situation</option>{situations.map((item) => <option key={item.id} value={item.id}>{item.domain} · {item.title}</option>)}</select></label>
          )}

          {state.kind === "create_situation" && inbox && <>
            <div className="live-form-grid"><label><span>Title</span><input name="title" required defaultValue={inbox.title} /></label><label><span>Domain</span><input name="domain" required defaultValue="world" /></label></div>
            <label><span>Current assessment</span><textarea name="current_assessment" rows={3} required defaultValue={inbox.summary} /></label>
            <div className="live-form-grid"><label><span>Before · 原基準</span><textarea name="before" rows={3} required defaultValue="尚未建立可比較的基準線。" /></label><label><span>Now · 目前判斷</span><textarea name="now" rows={3} required defaultValue={inbox.summary} /></label></div>
            <label><span>Watch condition</span><textarea name="watch_condition" rows={2} required placeholder="什麼條件命中時要重新看？" /></label>
            <div className="live-form-grid"><label><span>Stop condition</span><textarea name="stop_condition" rows={2} required placeholder="什麼情況停止採用此判斷？" /></label><label><span>Reopen condition</span><textarea name="reopen_condition" rows={2} required placeholder="什麼新證據會重新開啟？" /></label></div>
            <div className="live-form-grid"><label><span>Next review</span><input name="next_review_at" type="date" required defaultValue={dateInput(7)} /></label><label><span>Confidence · 0–100</span><input name="confidence" type="number" min="0" max="100" required defaultValue="40" /></label></div>
            <small>此外部來源會先列為 Unknown，未完成 S0–S8 前不能進 Known。</small>
          </>}

          {state.kind === "create_mission" && <>
            <div className="live-form-grid"><label><span>Title</span><input name="title" required /></label><label><span>Domain</span><input name="domain" required defaultValue={situation?.domain ?? "general"} /></label></div>
            <label><span>Related Situation</span><select name="situation_id" defaultValue={situation?.id ?? ""}><option value="">不連結 Situation</option>{situations.map((item) => <option key={item.id} value={item.id}>{item.domain} · {item.title}</option>)}</select></label>
            <label><span>Objective</span><textarea name="objective" rows={2} required placeholder="這個 Mission 要改變什麼結果？" /></label>
            <label><span>Why now</span><textarea name="why_now" rows={2} required placeholder="為什麼現在值得行動？" /></label>
            <label><span>唯一 Next action</span><textarea name="next_action" rows={2} required /></label>
            <label><span>Done condition</span><textarea name="done_condition" rows={2} required /></label>
            <div className="live-form-grid"><label><span>Stop condition</span><textarea name="stop_condition" rows={2} required /></label><label><span>Reopen condition</span><textarea name="reopen_condition" rows={2} required /></label></div>
            <label><span>Review date</span><input name="review_date" type="date" required defaultValue={dateInput(7)} /></label>
          </>}

          {state.kind === "record_result" && mission && <>
            <label><span>Result · 實際發生什麼</span><textarea name="result" rows={4} required /></label>
            <label><span>Impact</span><select name="result_state" required defaultValue="no_change"><option value="no_change">No Change · 不改原判斷</option><option value="changed">Changed · 需要重評估</option><option value="blocked">Blocked · 行動受阻</option></select></label>
            <label><span>下一個唯一行動</span><textarea name="next_action" rows={2} required defaultValue={mission.nextAction} /></label>
            <label><span>Next review</span><input name="review_date" type="date" required defaultValue={dateInput(7)} /></label>
          </>}

          {state.kind === "mission_adjustment" && mission && <>
            <label><span>Objective · 不可由草稿修改</span><textarea rows={2} value={mission.objective} readOnly /></label>
            <label><span>Rationale</span><textarea name="rationale" rows={3} required placeholder="什麼新證據造成調整？" defaultValue={mission.adjustmentDraft?.rationale} /></label>
            <label><span>Proposed next action</span><textarea name="next_action" rows={2} required defaultValue={mission.adjustmentDraft?.nextAction ?? mission.nextAction} /></label>
            <div className="live-form-grid"><label><span>Proposed status</span><select name="proposed_status" defaultValue={mission.adjustmentDraft?.proposedStatus ?? (mission.status === "blocked" ? "blocked" : "active")}><option value="active">Active</option><option value="blocked">Blocked</option></select></label><label><span>Review date</span><input name="review_date" type="date" required defaultValue={dateInputFrom(mission.adjustmentDraft?.reviewDate ?? mission.reviewDate)} /></label></div>
            <small>草稿不會修改 Objective，也不能宣告 completed／cancelled。</small>
          </>}

          {state.kind === "situation_adjustment" && situation && <>
            <label><span>Before</span><textarea name="before" rows={3} required defaultValue={situation.now || situation.currentAssessment} /></label>
            <label><span>Now · 新判斷</span><textarea name="now" rows={4} required /></label>
            <label><span>Why it matters</span><textarea name="impact" rows={3} required /></label>
            <small>這一步只建立 adjustment draft；不會直接覆寫 Current assessment。</small>
          </>}

          {state.kind === "forecast_update" && situation && <>
            <div className="live-forecast-rule">
              <strong>這是一筆可稽核預測，不是裝飾性機率。</strong>
              <p>三條路徑必須合計 100%；未累積 20 個可比事件前會明確標示 heuristic，並保存到 Forecast Ledger。</p>
            </div>
            <label><span>Intelligence question</span><textarea name="intelligence_question" rows={2} required defaultValue={situation.intelligenceQuestion ?? `${situation.title} 接下來最可能沿哪條路徑發展？`} /></label>
            <div className="live-form-grid"><label><span>Forecast horizon</span><input name="forecast_horizon" type="date" required defaultValue={situation.forecastHorizon ? dateInputFrom(situation.forecastHorizon) : dateInput(30)} /></label><label><span>Next observable</span><input name="next_observable" required defaultValue={situation.nextObservable ?? "下一個可證明或否定路徑的事件／數字"} /></label></div>
            {([
              { prefix: "base", tone: "base", name: "Base path", path: situation.scenarioPaths.find((item) => item.tone === "base") },
              { prefix: "upside", tone: "upside", name: "Upside path", path: situation.scenarioPaths.find((item) => item.tone === "upside") },
              { prefix: "stress", tone: "stress", name: "Downside / stress path", path: situation.scenarioPaths.find((item) => item.tone === "stress") },
            ] as const).map(({ prefix, tone, name, path }) => (
              <fieldset className={`live-forecast-path is-${tone}`} key={prefix}>
                <legend>{name}</legend>
                <div className="live-form-grid"><label><span>Label</span><input name={`${prefix}_label`} required defaultValue={path?.label ?? name} /></label><label><span>Probability · %</span><input name={`${prefix}_probability`} type="number" min="0" max="100" step="1" required defaultValue={path?.probability ?? ""} placeholder="三條合計 100" /></label></div>
                <label><span>Path summary</span><textarea name={`${prefix}_summary`} rows={2} required defaultValue={path?.summary ?? ""} /></label>
                <div className="live-form-grid"><label><span>Trigger / observable</span><textarea name={`${prefix}_trigger`} rows={2} required defaultValue={path?.trigger ?? ""} /></label><label><span>Invalid if</span><textarea name={`${prefix}_invalidation`} rows={2} required defaultValue={path?.invalidation ?? ""} /></label></div>
                <label><span>Decision implication</span><textarea name={`${prefix}_implication`} rows={2} required defaultValue={path?.implication ?? ""} /></label>
              </fieldset>
            ))}
          </>}

          {state.kind === "create_review" && mission && <>
            <label><span>Title</span><input name="title" required defaultValue={`Review · ${mission.title}`} /></label>
            <label><span>Reviewed at</span><input name="reviewed_at" type="date" required defaultValue={dateInput(0)} /></label>
            <label><span>Outcome</span><textarea name="outcome" rows={4} required placeholder="預期與實際結果有何差異？" /></label>
            <label><span>Assessment change</span><textarea name="assessment_change" rows={3} required placeholder="原判斷如何被修正？若沒有，明確寫 No Change。" /></label>
            <label><span>Next state</span><textarea name="next_state" rows={2} required placeholder="接下來維持、停止或重新開啟什麼？" /></label>
            <label><span>Mission transition · 由你決定</span><select name="mission_transition" required defaultValue="active"><option value="active">保持 Active</option><option value="blocked">改為 Blocked</option><option value="completed">標記 Completed</option><option value="cancelled">標記 Cancelled</option></select></label>
            <label><span>Next action（完成／取消時忽略）</span><textarea name="next_action" rows={2} required defaultValue={mission.nextAction} /></label>
            <label><span>Next review（完成／取消時忽略）</span><input name="review_date" type="date" required defaultValue={dateInput(7)} /></label>
            <small>完成或取消是受限動作，只能由這個互動式 Review 明確授權。</small>
          </>}

          <div className="live-workflow-actions"><button type="button" className="is-secondary" onClick={onClose}>取消</button><button type="submit">{copy.submit}</button></div>
        </form>
      </section>
    </div>
  );
}

export default function LiveIntelligencePage() {
  const [view, setView] = useState<View>("today");
  const [data, setData] = useState<WorkspaceData>(seedData);
  const [apiState, setApiState] = useState<ApiState>("loading");
  const [loadMessage, setLoadMessage] = useState("正在連接本機資料服務…");
  const [selectedSituationId, setSelectedSituationId] = useState(seedData.situations[0].id);
  const [pendingPreview, setPendingPreview] = useState<PendingPreview | null>(null);
  const [commandState, setCommandState] = useState<"idle" | "previewing" | "committing" | "refreshing">("idle");
  const [commandNotice, setCommandNotice] = useState<CommandNotice | null>(null);
  const commandNoticeId = useRef(0);
  const [truflationOpen, setTruflationOpen] = useState(false);
  const [truflationDate, setTruflationDate] = useState("");
  const [truflationValue, setTruflationValue] = useState("");
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramConnecting, setTelegramConnecting] = useState(false);
  const [telegramMessage, setTelegramMessage] = useState("");
  const [telegramPairing, setTelegramPairing] = useState<{ code: string; username?: string } | null>(null);
  const [telegramGroups, setTelegramGroups] = useState<TelegramGroupMonitor[]>([]);
  const [telegramGroupPreview, setTelegramGroupPreview] = useState<{ previewId: string; code: string; diff: string[] } | null>(null);
  const [telegramMonitorCode, setTelegramMonitorCode] = useState("");
  const [telegramGroupBusy, setTelegramGroupBusy] = useState(false);
  const [adjustmentEdit, setAdjustmentEdit] = useState<AttentionItem | null>(null);
  const [adjustmentNow, setAdjustmentNow] = useState("");
  const [adjustmentImpact, setAdjustmentImpact] = useState("");
  const [adjustmentEditReason, setAdjustmentEditReason] = useState("");
  const [lastSuccessfulSync, setLastSuccessfulSync] = useState<string | null>(null);
  const [workflowDialog, setWorkflowDialog] = useState<WorkflowDialogState | null>(null);

  const showCommandNotice = useCallback((message: string, tone: CommandNoticeTone = "info") => {
    commandNoticeId.current += 1;
    setCommandNotice({ id: commandNoticeId.current, tone, message });
  }, []);

  const loadWorkspace = useCallback(async () => {
    const paths = [
      "/api/v2/now",
      "/api/v1/inbox",
      "/api/v1/situations",
      "/api/v1/missions",
      "/api/v1/reviews",
      "/api/v1/connectors/health",
      "/api/v1/signals",
    ];
    const results = await Promise.allSettled(paths.map(getJson));
    const successes = results.filter((result) => result.status === "fulfilled");
    if (successes.length === 0) {
      setData(seedData);
      setApiState("fallback");
      setLoadMessage("本機資料服務未連線；以下為唯讀示範，不會寫回 Vault。");
      return { canonicalComplete: false, endpointSuccesses: 0 };
    }

    const fulfilled = (index: number) =>
      results[index].status === "fulfilled" ? results[index].value : undefined;
    const nowRecord = readRecord(fulfilled(0));
    const normalizedInbox = (readList<unknown>(fulfilled(1), ["inbox", "items"]) ?? []).map(normalizeInbox).filter((item): item is InboxItem => Boolean(item));
    const normalizedSituations = (readList<unknown>(fulfilled(2), ["situations", "items"]) ?? []).map(normalizeSituation).filter((item): item is Situation => Boolean(item));
    const normalizedMissions = (readList<unknown>(fulfilled(3), ["missions", "items"]) ?? []).map(normalizeMission).filter((item): item is Mission => Boolean(item));
    const normalizedReviews = (readList<unknown>(fulfilled(4), ["reviews", "items"]) ?? []).map(normalizeReview).filter((item): item is Review => Boolean(item));
    const situationIds = new Set(normalizedSituations.map((item) => item.id));
    const nowAttention = (readList<unknown>(nowRecord, ["needsYou", "needs_you", "attention"]) ?? []).map((item) => normalizeAttention(item, situationIds)).filter((item): item is AttentionItem => Boolean(item));
    const nowChanges = (readList<unknown>(nowRecord, ["materialChanges", "material_changes", "changes"]) ?? []).map(normalizeChange).filter((item): item is ChangeItem => Boolean(item));
    const nowActions = (readList<unknown>(nowRecord, ["nextActions", "next_actions"]) ?? []).map(normalizeMission).filter((item): item is Mission => Boolean(item));
    const nowWatching = (readList<unknown>(nowRecord, ["watching", "watches"]) ?? []).map(normalizeWatch).filter((item): item is WatchItem => Boolean(item));
    const connectorItems = (readList<unknown>(fulfilled(5), ["connectors", "items", "health"]) ?? readList<unknown>(nowRecord, ["connectors", "connector_health"]) ?? []).map(normalizeConnector).filter((item): item is ConnectorHealth => Boolean(item));
    const normalizedSignals = (readList<unknown>(fulfilled(6), ["signals", "items", "live_signals"]) ?? readList<unknown>(nowRecord, ["live_signals"]) ?? []).map(normalizeSignal).filter((item): item is LiveSignal => Boolean(item));
    const forward = normalizeForwardNow(nowRecord?.forward_intelligence);
    const evidenceLoop = normalizeEvidenceLoop(nowRecord?.evidence_loop);
    const unavailableBrief: Briefing = {
      generatedAt: "端點不可用",
      status: "unavailable · Audio unavailable",
      duration: "不可用",
      transcript: ["Briefing 端點目前不可用；系統不會以示範資料冒充即時情報。"],
      sources: [],
    };
    const next: WorkspaceData = {
      revision: typeof nowRecord?.revision === "string" || typeof nowRecord?.revision === "number" ? nowRecord.revision : "unavailable",
      asOf: typeof nowRecord?.as_of === "string" ? nowRecord.as_of : typeof nowRecord?.asOf === "string" ? nowRecord.asOf : "部分端點不可用",
      mode: typeof nowRecord?.mode === "string" ? nowRecord.mode : "partial_local",
      needsYou: results[0].status === "fulfilled" ? nowAttention : [],
      materialChanges: results[0].status === "fulfilled" ? nowChanges : [],
      nextActions: results[0].status === "fulfilled" ? nowActions : [],
      watching: results[0].status === "fulfilled" ? nowWatching : [],
      briefing: results[0].status === "fulfilled" ? normalizeBriefing(nowRecord?.briefing) ?? unavailableBrief : unavailableBrief,
      inbox: results[1].status === "fulfilled" ? normalizedInbox : [],
      situations: results[2].status === "fulfilled" ? normalizedSituations : [],
      missions: results[3].status === "fulfilled" ? normalizedMissions : [],
      reviews: results[4].status === "fulfilled" ? normalizedReviews : [],
      connectors: results[5].status === "fulfilled" ? connectorItems : [],
      signals: results[6].status === "fulfilled" || results[0].status === "fulfilled" ? normalizedSignals : [],
      forward,
      evidenceLoop,
    };
    setData(next);
    setSelectedSituationId((current) =>
      next.situations.some((item) => item.id === current) ? current : next.situations[0]?.id ?? "",
    );
    setApiState(successes.length === paths.length ? "live" : "partial");
    setLoadMessage(successes.length === paths.length ? "本機資料已同步" : `部分同步：${successes.length}/${paths.length} 個端點可用；缺失面板不顯示示範資料`);
    setLastSuccessfulSync(new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    return {
      canonicalComplete: results.slice(0, 5).every((result) => result.status === "fulfilled"),
      endpointSuccesses: successes.length,
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadWorkspace();
    }, 60_000);
    const refreshOnFocus = () => void loadWorkspace();
    const refreshOnVisibility = () => {
      if (document.visibilityState === "visible") void loadWorkspace();
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
    };
  }, [loadWorkspace]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const stream = new EventSource("/api/v2/stream");
    let refreshTimer: number | undefined;
    stream.addEventListener("change", () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void loadWorkspace(), 120);
    });
    return () => {
      window.clearTimeout(refreshTimer);
      stream.close();
    };
  }, [loadWorkspace]);

  useEffect(() => {
    if (commandNotice?.tone !== "success") return;
    const noticeId = commandNotice.id;
    const timer = window.setTimeout(() => {
      setCommandNotice((current) => current?.id === noticeId ? null : current);
    }, 2200);
    return () => window.clearTimeout(timer);
  }, [commandNotice]);

  const selectedSituation = useMemo(
    () => data.situations.find((item) => item.id === selectedSituationId) ?? data.situations[0],
    [data.situations, selectedSituationId],
  );

  const needsYou = data.needsYou.slice(0, 3);
  const materialChanges = data.materialChanges.slice(0, 3);
  const nextActions = (data.nextActions ?? data.missions).filter((mission) => mission.status !== "watch").slice(0, 3);

  async function stageTypedPreview(
    command: string,
    label: string,
    payload: Record<string, unknown>,
    { userConfirmation = true }: { userConfirmation?: boolean } = {},
  ) {
    setCommandState("previewing");
    setCommandNotice(null);
    try {
      const preview = await requestTypedCommandPreview(command, payload, { userConfirmation });
      setPendingPreview({
        command,
        label,
        previewId: preview.previewId,
        previewIds: preview.previewIds.length ? preview.previewIds : preview.previewId ? [preview.previewId] : [],
        baseRevision: preview.baseRevision,
        payload,
        diff: preview.diff.length ? preview.diff : [`將執行：${label}`, `目標：${JSON.stringify(payload)}`],
      });
      showCommandNotice("這只是預覽；確認後才會寫入。", "info");
      return true;
    } catch (error) {
      setPendingPreview(null);
      showCommandNotice(error instanceof Error ? `無法建立安全預覽：${error.message}` : "無法取得安全寫入預覽，因此沒有寫入任何資料。", "error");
      return false;
    } finally {
      setCommandState("idle");
    }
  }

  async function previewCommand(command: string, label: string, payload: Record<string, unknown>) {
    const inboxId = asString(payload.inbox_id);
    const inbox = data.inbox.find((item) => item.id === inboxId);
    if (!inbox || inbox.revision === undefined) {
      showCommandNotice("找不到最新 Inbox revision；請先重新同步。", "error");
      return;
    }
    await stageTypedPreview(command, label, {
      ...payload,
      inbox_id: inbox.id,
      base_revision: inbox.revision,
    });
  }

  async function previewInboxSwipeBatch(decisions: InboxSwipeDecision[]) {
    const interested = decisions.filter((decision) => decision.interested).length;
    const notInterested = decisions.length - interested;
    const signalDecisions = decisions.filter((decision) => decision.origin === "signal");
    if (signalDecisions.length) {
      if (signalDecisions.length !== decisions.length) {
        showCommandNotice("群組 Sensor 與正式 Inbox 會分批預覽，請先儲存目前的 Sensor 判斷。", "warning");
        return false;
      }
      setCommandState("previewing");
      setCommandNotice(null);
      try {
        const response = await fetch("/api/v1/signals/dispositions/preview", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ decisions: signalDecisions.map((decision) => ({
            signal_id: decision.signal_id,
            action: decision.interested
              ? decision.situation_id ? "link_situation" : "watch"
              : "not_interested",
            ...(decision.situation_id ? { situation_id: decision.situation_id } : {}),
          })) }),
        });
        const raw = (await response.json()) as Record<string, unknown>;
        const body = readRecord(raw) ?? raw;
        if (!response.ok) throw new Error(asString(readRecord(raw.error)?.message, "signal preview failed"));
        const previewId = asString(body.preview_id);
        if (!previewId) throw new Error("signal preview missing token");
        setPendingPreview({
          command: "signals.dispositions",
          label: `儲存 ${decisions.length} 筆 Telegram Sensor 興趣判斷`,
          previewId,
          previewIds: [],
          baseRevision: 0,
          payload: {},
          diff: Array.isArray(body.diff) ? body.diff.map(formatDiffLine) : [],
          commitEndpoint: "/api/v1/signals/dispositions/commit",
          commitBody: { preview_id: previewId },
        });
        showCommandNotice(`預覽已建立：有興趣 ${interested}、沒興趣 ${notInterested}；只有有興趣項目會寫入正式情報 Vault。`, "info");
        return true;
      } catch (error) {
        setPendingPreview(null);
        showCommandNotice(error instanceof Error ? `無法建立 Sensor 預覽：${error.message}` : "無法建立 Sensor 預覽。", "error");
        return false;
      } finally {
        setCommandState("idle");
      }
    }
    const canonicalDecisions = decisions.map((decision) => ({
      inbox_id: decision.inbox_id,
      base_revision: decision.base_revision,
      interested: decision.interested,
      ...(decision.situation_id ? { situation_id: decision.situation_id } : {}),
      system_group: decision.system_group,
      classification_confidence: decision.classification_confidence,
      classification_reason: decision.classification_reason,
    }));
    return stageTypedPreview(
      "inbox.swipe_batch",
      `儲存 ${decisions.length} 筆興趣分流`,
      { decisions: canonicalDecisions },
      { userConfirmation: true },
    ).then((ready) => {
      if (ready) showCommandNotice(`預覽已建立：有興趣 ${interested}、沒興趣 ${notInterested}；確認後才寫入。`, "info");
      return ready;
    });
  }

  async function previewMaterialChangeAcknowledgement(change: ChangeItem) {
    if (change.revision === undefined) {
      showCommandNotice("找不到最新 Situation revision；請先重新同步。", "error");
      return;
    }
    await stageTypedPreview(
      "situation.acknowledge_material_change",
      `已讀並清除 Material change：${change.title}`,
      { situation_id: change.id, base_revision: change.revision },
    );
  }

  async function submitWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workflowDialog) return;
    const form = new FormData(event.currentTarget);
    const value = (name: string) => asString(form.get(name));
    const closeWhenReady = async (command: string, label: string, payload: Record<string, unknown>, userConfirmation = true) => {
      if (await stageTypedPreview(command, label, payload, { userConfirmation })) setWorkflowDialog(null);
    };

    if (workflowDialog.kind === "link_situation" && workflowDialog.inbox) {
      await closeWhenReady("inbox.link_situation", `Link Situation：${workflowDialog.inbox.title}`, {
        inbox_id: workflowDialog.inbox.id,
        base_revision: workflowDialog.inbox.revision,
        situation_id: value("situation_id"),
      });
      return;
    }
    if (workflowDialog.kind === "create_situation" && workflowDialog.inbox) {
      await closeWhenReady("inbox.create_situation", `Create Situation：${value("title")}`, {
        inbox_id: workflowDialog.inbox.id,
        base_revision: workflowDialog.inbox.revision,
        situation: {
          title: value("title"),
          domain: value("domain"),
          current_assessment: value("current_assessment"),
          before: value("before"),
          now: value("now"),
          watch_condition: value("watch_condition"),
          stop_condition: value("stop_condition"),
          reopen_condition: value("reopen_condition"),
          next_review_at: value("next_review_at"),
          confidence: Number(value("confidence")),
        },
      });
      return;
    }
    if (workflowDialog.kind === "create_mission") {
      await closeWhenReady("mission.create", `Create Mission：${value("title")}`, {
        mission: {
          title: value("title"),
          domain: value("domain"),
          situation_id: value("situation_id") || undefined,
          objective: value("objective"),
          why_now: value("why_now"),
          next_action: value("next_action"),
          done_condition: value("done_condition"),
          review_date: value("review_date"),
          stop_condition: value("stop_condition"),
          reopen_condition: value("reopen_condition"),
        },
      });
      return;
    }
    if (workflowDialog.kind === "record_result" && workflowDialog.mission) {
      await closeWhenReady("mission.record_result", `記錄結果：${workflowDialog.mission.title}`, {
        mission_id: workflowDialog.mission.id,
        base_revision: workflowDialog.mission.revision,
        result: value("result"),
        result_state: value("result_state"),
        next_action: value("next_action"),
        review_date: value("review_date"),
      });
      return;
    }
    if (workflowDialog.kind === "mission_adjustment" && workflowDialog.mission) {
      await closeWhenReady("mission.propose_adjustment", `草擬調整：${workflowDialog.mission.title}`, {
        mission_id: workflowDialog.mission.id,
        base_revision: workflowDialog.mission.revision,
        rationale: value("rationale"),
        next_action: value("next_action"),
        review_date: value("review_date"),
        proposed_status: value("proposed_status"),
      }, false);
      return;
    }
    if (workflowDialog.kind === "situation_adjustment" && workflowDialog.situation) {
      await closeWhenReady("situation.propose_adjustment", `草擬調整：${workflowDialog.situation.title}`, {
        situation_id: workflowDialog.situation.id,
        base_revision: workflowDialog.situation.revision,
        before: value("before"),
        now: value("now"),
        impact: value("impact"),
      }, false);
      return;
    }
    if (workflowDialog.kind === "forecast_update" && workflowDialog.situation) {
      const prefixes = [
        { prefix: "base", tone: "base" },
        { prefix: "upside", tone: "upside" },
        { prefix: "stress", tone: "stress" },
      ] as const;
      const paths = prefixes.map(({ prefix, tone }) => ({
        id: `${workflowDialog.situation?.id}-${tone}`,
        tone,
        label: value(`${prefix}_label`),
        probability: Number(value(`${prefix}_probability`)),
        summary: value(`${prefix}_summary`),
        trigger: value(`${prefix}_trigger`),
        implication: value(`${prefix}_implication`),
        invalidation: value(`${prefix}_invalidation`),
      }));
      const total = paths.reduce((sum, path) => sum + path.probability, 0);
      if (Math.abs(total - 100) > 0.001) {
        showCommandNotice(`三條路徑目前合計 ${total}%；必須剛好為 100%。`, "error");
        return;
      }
      await closeWhenReady("situation.forecast_update", `更新 Forecast：${workflowDialog.situation.title}`, {
        situation_id: workflowDialog.situation.id,
        base_revision: workflowDialog.situation.revision,
        intelligence_question: value("intelligence_question"),
        forecast_horizon: value("forecast_horizon"),
        next_observable: value("next_observable"),
        paths,
        method: "user_prior",
        comparable_event_count: 0,
      });
      return;
    }
    if (workflowDialog.kind === "create_review" && workflowDialog.mission) {
      const transition = value("mission_transition");
      await closeWhenReady("review.create", `Review：${workflowDialog.mission.title}`, {
        mission_id: workflowDialog.mission.id,
        base_revision: workflowDialog.mission.revision,
        title: value("title"),
        reviewed_at: value("reviewed_at"),
        outcome: value("outcome"),
        assessment_change: value("assessment_change"),
        next_state: value("next_state"),
        mission_transition: transition,
        next_action: value("next_action"),
        review_date: value("review_date"),
      });
    }
  }

  async function commitPreview() {
    if (!pendingPreview) return;
    setCommandState("committing");
    setCommandNotice(null);
    const previewIds = pendingPreview.previewIds ?? (pendingPreview.previewId ? [pendingPreview.previewId] : []);
    let committed = 0;
    try {
      if (pendingPreview.commitEndpoint) {
        const response = await fetch(pendingPreview.commitEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(pendingPreview.commitBody ?? { preview_id: pendingPreview.previewId }),
        });
        if (!response.ok) throw new Error(`custom commit returned ${response.status}`);
        committed = 1;
      } else if ((pendingPreview.previewIds?.length ?? 0) > 1) {
        const response = await fetch("/api/v1/commands/commit", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ preview_ids: pendingPreview.previewIds }),
        });
        if (!response.ok) throw new Error(`batch commit returned ${response.status}`);
        committed = previewIds.length;
      }
      for (const previewId of pendingPreview.commitEndpoint || previewIds.length > 1 ? [] : previewIds) {
        const response = await fetch("/api/v1/commands/commit", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ preview_id: previewId }),
        });
        if (!response.ok) throw new Error(`commit returned ${response.status}`);
        committed += 1;
      }
    } catch {
      setPendingPreview(null);
      showCommandNotice(committed
        ? `已完成 ${committed}/${previewIds.length} 個寫入；其餘 revision 已變動。資料已重新載入，請確認後再試。`
        : "寫入未完成。預覽可能已過期或 revision 已改變；請重新載入後再試。", committed ? "warning" : "error");
      await loadWorkspace();
      setCommandState("idle");
      return;
    }

    setPendingPreview(null);
    setCommandState("refreshing");
    showCommandNotice("寫入完成，正在同步最新狀態…", "refreshing");
    try {
      const refresh = await loadWorkspace();
      if (refresh.canonicalComplete) {
        showCommandNotice("已安全寫入，畫面已更新。", "success");
      } else {
        showCommandNotice("資料已寫入，但部分畫面尚未同步；請按右上角「重新同步」。", "warning");
      }
    } catch {
      showCommandNotice("資料已寫入，但畫面重新同步失敗；請按右上角「重新同步」。", "warning");
    } finally {
      setCommandState("idle");
    }
  }

  function submitTruflation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(truflationValue);
    if (!truflationDate || !Number.isFinite(value)) {
      showCommandNotice("請輸入有效的 as-of 日期與通膨百分比。", "error");
      return;
    }
    void previewTruflation(value);
  }

  async function previewTruflation(value: number) {
    setCommandState("previewing");
    setCommandNotice(null);
    try {
      const response = await fetch("/api/v1/connectors/truflation/manual-observation", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          base_revision: 0,
          confirmed_by_user: true,
          observation_date: truflationDate,
          value,
          unit: "percent_yoy",
        }),
      });
      if (!response.ok) throw new Error(`Truflation preview returned ${response.status}`);
      const raw = (await response.json()) as Record<string, unknown>;
      const body = readRecord(raw) ?? raw;
      if (body.no_op === true) {
        setPendingPreview(null);
        showCommandNotice("同一天、同數值的 Truflation 快照已存在；去重後不需要寫入。", "success");
        return;
      }
      const previewId = asString(body.preview_id);
      if (!previewId) throw new Error("preview response did not include preview_id");
      const diffValue = body.diff;
      setPendingPreview({
        command: "truflation.manual_observation",
        label: "新增 Truflation 手動觀察值",
        previewId,
        baseRevision: 0,
        payload: { observation_date: truflationDate, value, unit: "percent_yoy" },
        diff: Array.isArray(diffValue) ? diffValue.map(formatDiffLine) : [`建立 manual_snapshot：${truflationDate} · ${value}% YoY`],
      });
      showCommandNotice("這只是預覽；確認後才會建立 unverified_external Inbox item。", "info");
    } catch {
      setPendingPreview(null);
      showCommandNotice("無法建立 Truflation 安全預覽，因此沒有寫入任何觀察值。", "error");
    } finally {
      setCommandState("idle");
    }
  }

  async function submitTelegramSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = telegramToken.trim();
    if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      setTelegramMessage("Token 格式不完整；它不會離開這台電腦，也不會寫入瀏覽器儲存空間。");
      return;
    }
    setTelegramConnecting(true);
    setTelegramMessage("正在以 Telegram getMe 驗證…");
    setTelegramPairing(null);
    try {
      const response = await fetch("/api/v1/connectors/telegram/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token }),
      });
      const raw = (await response.json()) as Record<string, unknown>;
      const body = readRecord(raw) ?? raw;
      if (!response.ok || body.ok !== true) throw new Error("telegram bootstrap failed");
      const bot = body.bot && typeof body.bot === "object" ? body.bot as Record<string, unknown> : {};
      const code = asString(body.pairing_code);
      if (!code) throw new Error("pairing code missing");
      setTelegramPairing({ code, username: asString(bot.username) || undefined });
      setTelegramMessage("Bot 已通過驗證。完成一次性配對後，才會接受你的明確投稿。");
      await loadWorkspace();
    } catch {
      setTelegramMessage("驗證失敗；Token 未寫入 Vault、Git、URL 或瀏覽器永久儲存。請檢查 Token 與網路後重試。");
    } finally {
      setTelegramToken("");
      setTelegramConnecting(false);
    }
  }

  async function loadTelegramGroups() {
    try {
      const raw = await getJson("/api/v1/connectors/telegram/groups");
      const items = readList<Record<string, unknown>>(raw, ["groups", "items"]) ?? [];
      setTelegramGroups(items.map((item) => ({
        chatId: asString(item.chat_id),
        status: asString(item.status, "pending_consent"),
        consentCount: asNumber(item.consent_count, 0),
        memberCount: typeof item.member_count === "number" ? item.member_count : undefined,
        privacyReadable: item.privacy_readable === true,
        pausedReason: asString(item.paused_reason) || undefined,
        lastMessageAt: asString(item.last_message_at) || undefined,
      })).filter((item) => item.chatId));
    } catch {
      setTelegramGroups([]);
    }
  }

  async function previewTelegramGroupMonitor() {
    setTelegramGroupBusy(true);
    setTelegramMonitorCode("");
    setTelegramMessage("正在建立私人群組監看預覽…");
    try {
      const response = await fetch("/api/v1/connectors/telegram/groups/preview", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action: "monitor" }),
      });
      const raw = (await response.json()) as Record<string, unknown>;
      const body = readRecord(raw) ?? raw;
      if (!response.ok) throw new Error("group preview failed");
      const previewId = asString(body.preview_id);
      const code = asString(body.code);
      if (!previewId || !code) throw new Error("group preview missing code");
      setTelegramGroupPreview({
        previewId,
        code,
        diff: Array.isArray(body.diff) ? body.diff.map(formatDiffLine) : [],
      });
      setTelegramMessage("監看設定尚未生效；確認安全邊界後才會啟用一次性代碼。");
    } catch {
      setTelegramGroupPreview(null);
      setTelegramMessage("無法建立群組監看預覽；目前設定沒有改變。");
    } finally {
      setTelegramGroupBusy(false);
    }
  }

  async function commitTelegramGroupMonitor() {
    if (!telegramGroupPreview) return;
    setTelegramGroupBusy(true);
    setTelegramMessage("正在啟用一次性群組監看碼…");
    try {
      const response = await fetch("/api/v1/connectors/telegram/groups/commit", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ preview_id: telegramGroupPreview.previewId }),
      });
      const raw = (await response.json()) as Record<string, unknown>;
      const body = readRecord(raw) ?? raw;
      if (!response.ok || body.committed !== true) throw new Error("group commit failed");
      setTelegramMonitorCode(asString(body.monitor_code, telegramGroupPreview.code));
      setTelegramGroupPreview(null);
      setTelegramMessage("監看碼已啟用，十分鐘內到你管理的私人群組完成登記。");
      await loadTelegramGroups();
    } catch {
      setTelegramMessage("監看設定未啟用；預覽可能已過期，請重新產生。");
    } finally {
      setTelegramGroupBusy(false);
    }
  }

  async function previewAdjustment(
    item: AttentionItem,
    mode: "accepted" | "accepted_after_edit",
    now = item.draftNow ?? item.summary,
    impact = item.draftImpact ?? "需要重新評估 Situation",
    editReason = adjustmentEditReason,
  ) {
    const situation = data.situations.find((candidate) => candidate.id === item.targetSituationId);
    const inbox = data.inbox.find((candidate) => candidate.id === item.id);
    const requiresInbox = item.entityType === "InboxItem";
    if (!situation || situation.revision === undefined || (requiresInbox && (!inbox || inbox.revision === undefined))) {
      showCommandNotice("找不到可安全更新的 Situation／Inbox revision；請先重新同步。", "error");
      return;
    }
    setCommandState("previewing");
    setCommandNotice(null);
    try {
      const situationPayload: Record<string, unknown> = {
        situation_id: situation.id,
        base_revision: situation.revision,
      };
      if (inbox) {
        situationPayload.inbox_id = inbox.id;
        situationPayload.inbox_base_revision = inbox.revision;
      }
      if (mode === "accepted_after_edit") {
        situationPayload.decision_mode = "edit";
        situationPayload.edit_reason = editReason.trim();
        situationPayload.before = item.draftBefore ?? situation.now ?? situation.currentAssessment;
        situationPayload.now = now;
        situationPayload.impact = impact;
      }
      const batch = await requestTypedCommandPreview("situation.accept_adjustment", situationPayload, { userConfirmation: true });
      setPendingPreview({
        command: "situation.accept_adjustment",
        label: `${mode === "accepted_after_edit" ? "編輯並接受" : "接受"}：${item.title}`,
        previewId: batch.previewId,
        previewIds: batch.previewIds.length ? batch.previewIds : batch.previewId ? [batch.previewId] : [],
        baseRevision: situation.revision ?? 0,
        payload: situationPayload,
        diff: batch.diff,
      });
      showCommandNotice(inbox
        ? "這是 Situation＋Inbox 相依寫入的完整預覽；Server 會整批提交，任一失敗就自動回復。"
        : "這只是 Situation 決策 diff；確認後才會正式套用草稿。", "info");
    } catch {
      setPendingPreview(null);
      showCommandNotice("無法建立 Situation 調整的安全預覽，因此沒有寫入任何資料。", "error");
    } finally {
      setCommandState("idle");
    }
  }

  async function previewSituationDismiss(item: AttentionItem) {
    const situation = data.situations.find((candidate) => candidate.id === item.targetSituationId);
    if (!situation || situation.revision === undefined) {
      showCommandNotice("找不到最新 Situation revision；請先重新同步。", "error");
      return;
    }
    await stageTypedPreview("situation.dismiss_adjustment", `Keep current：${item.title}`, {
      situation_id: situation.id,
      base_revision: situation.revision,
    });
  }

  async function previewMissionAdjustmentDecision(item: AttentionItem, decision: "accept" | "dismiss") {
    const mission = data.missions.find((candidate) => candidate.id === item.targetMissionId);
    if (!mission || mission.revision === undefined) {
      showCommandNotice("找不到最新 Mission revision；請先重新同步。", "error");
      return;
    }
    await stageTypedPreview(
      decision === "accept" ? "mission.accept_adjustment" : "mission.dismiss_adjustment",
      `${decision === "accept" ? "Accept" : "Keep current"}：${item.title}`,
      { mission_id: mission.id, base_revision: mission.revision },
    );
  }

  function openAdjustmentEditor(item: AttentionItem) {
    setAdjustmentEdit(item);
    setAdjustmentNow(item.draftNow ?? item.summary);
    setAdjustmentImpact(item.draftImpact ?? "需要重新評估 Situation");
    setAdjustmentEditReason("");
  }

  function openMissionAdjustmentEditor(item: AttentionItem) {
    const mission = data.missions.find((candidate) => candidate.id === item.targetMissionId);
    if (!mission) {
      showCommandNotice("找不到可編輯的 Mission；請先重新同步。", "error");
      return;
    }
    setWorkflowDialog({ kind: "mission_adjustment", mission });
  }

  function submitAdjustmentEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adjustmentEdit || !adjustmentNow.trim() || !adjustmentImpact.trim() || !adjustmentEditReason.trim()) return;
    const item = adjustmentEdit;
    setAdjustmentEdit(null);
    void previewAdjustment(item, "accepted_after_edit", adjustmentNow.trim(), adjustmentImpact.trim(), adjustmentEditReason.trim());
  }

  return (
    <main className="live-shell" data-api-state={apiState}>
      <header className="live-topbar">
        <div className="live-brand">
          <span className="live-brand-mark" aria-hidden="true">IO</span>
          <div>
            <p>PERSONAL WORLD INTELLIGENCE</p>
            <h1>個人世界情報系統</h1>
          </div>
        </div>
        <div className={`live-sync-state is-${apiState}`} role="status" aria-live="polite">
          <span />
          <div>
            <strong>{apiState === "live" ? "LIVE · LOCAL" : apiState === "partial" ? "PARTIAL · LOCAL" : apiState === "loading" ? "CONNECTING" : "SEED · READ ONLY"}</strong>
            <small>{loadMessage}{lastSuccessfulSync ? ` · ${lastSuccessfulSync}` : ""}</small>
          </div>
        </div>
        <div className="live-top-actions">
          <button className="is-sync" type="button" onClick={() => void loadWorkspace()} disabled={apiState === "loading"}>重新同步</button>
          <button className="is-telegram" type="button" onClick={() => { setTelegramOpen(true); void loadTelegramGroups(); }}>設定 Telegram</button>
          <a href="/replay">開啟 Replay <span aria-hidden="true">↗</span></a>
        </div>
      </header>

      <div className="live-layout">
        <aside className="live-sidebar">
          <div className="live-asof">
            <span>AS OF</span>
            <strong>{data.asOf}</strong>
            <small>revision {data.revision}</small>
          </div>
          <nav aria-label="情報系統主要區域">
            {navigation.map((item, index) => (
              <button key={item.id} className={view === item.id ? "is-active" : ""} onClick={() => setView(item.id)}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{item.label}</strong><small>{item.helper}</small></div>
                <i aria-hidden="true">→</i>
              </button>
            ))}
          </nav>
          <div className="live-boundary">
            <span>BOUNDARY</span>
            <p>Wiki 唯讀。情報寫入需先預覽 diff，再由你確認。</p>
          </div>
        </aside>

        <section className="live-workspace">
          {view === "today" && (
            <ForwardNowView
              needsYou={needsYou}
              sourceRevision={data.revision}
              changes={materialChanges}
              missions={nextActions}
              connectors={data.connectors}
              watching={data.watching ?? []}
              situations={data.situations}
              briefing={data.briefing}
              signals={data.signals}
              forward={data.forward}
              evidenceLoop={data.evidenceLoop}
              onReload={loadWorkspace}
              onOpen={(next) => setView(next)}
              onPreview={previewCommand}
              onAcknowledgeChange={(change) => void previewMaterialChangeAcknowledgement(change)}
              onAcceptAdjustment={(item) => void previewAdjustment(item, "accepted")}
              onEditAdjustment={openAdjustmentEditor}
              onDismissSituationAdjustment={(item) => void previewSituationDismiss(item)}
              onAcceptMissionAdjustment={(item) => void previewMissionAdjustmentDecision(item, "accept")}
              onEditMissionAdjustment={openMissionAdjustmentEditor}
              onDismissMissionAdjustment={(item) => void previewMissionAdjustmentDecision(item, "dismiss")}
              onOpenWorkflow={setWorkflowDialog}
            />
          )}
          {view === "inbox" && <InboxView items={data.inbox} signals={data.signals} situations={data.situations} onPreview={previewCommand} onSwipeBatch={previewInboxSwipeBatch} busy={commandState !== "idle" || Boolean(pendingPreview)} />}
          {view === "situations" && (
            <SituationsView
              situations={data.situations}
              missions={data.missions}
              inbox={data.inbox}
              selected={selectedSituation}
              onSelect={setSelectedSituationId}
              truflationOpen={truflationOpen}
              onToggleTruflation={() => setTruflationOpen((open) => !open)}
              truflationDate={truflationDate}
              truflationValue={truflationValue}
              onTruflationDate={setTruflationDate}
              onTruflationValue={setTruflationValue}
              onSubmitTruflation={submitTruflation}
              onPreview={previewCommand}
              onOpenWorkflow={setWorkflowDialog}
            />
          )}
          {view === "missions" && <MissionsView missions={data.missions} situations={data.situations} onOpenWorkflow={setWorkflowDialog} />}
          {view === "review" && <ReviewView reviews={data.reviews} missions={data.missions} onOpenWorkflow={setWorkflowDialog} />}
        </section>
      </div>

      {(pendingPreview || commandNotice) && (
        <aside
          className={`live-command-drawer ${pendingPreview ? "is-preview" : "is-notice"} is-${commandNotice?.tone ?? "info"}`}
          aria-live={commandNotice?.tone === "error" ? "assertive" : "polite"}
          aria-label={pendingPreview ? "安全寫入預覽" : "寫入結果"}
        >
          <div className="live-command-head">
            <div>
              <span>{pendingPreview ? "SAFE WRITE" : commandNotice?.tone === "success" ? "SAVED" : commandNotice?.tone === "warning" ? "SYNC WARNING" : commandNotice?.tone === "error" ? "WRITE ERROR" : "SYNCING"}</span>
              <strong>{pendingPreview?.label ?? (commandNotice?.tone === "success" ? "已完成" : "寫入狀態")}</strong>
            </div>
            <button
              type="button"
              aria-label="關閉寫入狀態"
              disabled={commandState === "committing" || commandState === "refreshing"}
              onClick={() => { setPendingPreview(null); setCommandNotice(null); }}
            >×</button>
          </div>
          {pendingPreview && (
            <div className="live-diff">
              {pendingPreview.diff.map((line, index) => <code key={`${line}-${index}`}>+ {line}</code>)}
            </div>
          )}
          {commandNotice && <p>{commandNotice.message}</p>}
          {pendingPreview && (
            <div className="live-command-actions">
              <button type="button" className="is-secondary" onClick={() => setPendingPreview(null)}>取消</button>
              <button type="button" onClick={() => void commitPreview()} disabled={commandState === "committing"}>
                {commandState === "committing" ? "寫入中…" : "確認並寫入"}
              </button>
            </div>
          )}
        </aside>
      )}

      {telegramOpen && (
        <div className="live-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setTelegramOpen(false);
        }}>
          <section className="live-telegram-dialog" role="dialog" aria-modal="true" aria-labelledby="telegram-setup-title">
            <header>
              <div><span>LOCAL SECRET SETUP</span><h2 id="telegram-setup-title">Telegram 情報入口</h2></div>
              <button type="button" aria-label="關閉 Telegram 設定" onClick={() => setTelegramOpen(false)}>×</button>
            </header>
            <div className="live-telegram-boundary">
              <strong>安全邊界</strong>
              <p>私聊維持明確投稿；私人群組監看使用同一個專用 Bot、無 admin 權限，但需關閉 Group Privacy 並取得每位成員主動同意。未知群組與未同意 sender 不落盤。</p>
            </div>
            {!telegramPairing ? (
              <form onSubmit={submitTelegramSetup}>
                <label htmlFor="telegram-token">BotFather token</label>
                <input
                  id="telegram-token"
                  type="password"
                  value={telegramToken}
                  onChange={(event) => setTelegramToken(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="只在本機輸入，不要貼到聊天"
                  required
                />
                <small>提交後由 Windows DPAPI 加密，保存在 OneDrive 與 Vault 之外。</small>
                <button type="submit" disabled={telegramConnecting}>{telegramConnecting ? "驗證中…" : "驗證並產生配對碼"}</button>
              </form>
            ) : (
              <div className="live-pairing-result">
                <span>ONE-TIME PAIRING</span>
                <p>在 {telegramPairing.username ? `@${telegramPairing.username}` : "你的 Bot 私聊"} 傳送：</p>
                <code>/pair {telegramPairing.code}</code>
                <small>配對碼首次成功使用後立即失效。之後以 <code>/intel 內容</code> 投稿。</small>
              </div>
            )}
            <section className="live-group-monitor-setup">
              <header><div><span>PRIVATE GROUP SENSOR</span><h3>授權私人群組監看</h3></div><b>LOCAL ONLY</b></header>
              <ol>
                <li>在 BotFather 關閉 Group Privacy，將 Bot 移出後重新加入你管理的私人群。</li>
                <li>在這裡預覽並啟用一次性監看碼，再到群組輸入 <code>/monitor code</code>。</li>
                <li>每位群成員輸入 <code>/consent</code>；全員完成前不保存普通訊息。</li>
              </ol>
              {!telegramMonitorCode && !telegramGroupPreview && (
                <button type="button" disabled={telegramGroupBusy} onClick={() => void previewTelegramGroupMonitor()}>
                  {telegramGroupBusy ? "建立預覽中…" : "預覽私人群組監看"}
                </button>
              )}
              {telegramGroupPreview && (
                <div className="live-group-preview">
                  <span>SAFE SETTINGS PREVIEW</span>
                  {telegramGroupPreview.diff.map((line) => <code key={line}>+ {line}</code>)}
                  <div><button type="button" className="is-secondary" onClick={() => setTelegramGroupPreview(null)}>取消</button><button type="button" disabled={telegramGroupBusy} onClick={() => void commitTelegramGroupMonitor()}>確認並啟用代碼</button></div>
                </div>
              )}
              {telegramMonitorCode && (
                <div className="live-pairing-result is-monitor">
                  <span>TEN-MINUTE GROUP CODE</span>
                  <p>到你管理的私人群組傳送：</p>
                  <code>/monitor {telegramMonitorCode}</code>
                  <small>首次成功使用後立即失效。接著所有成員需輸入 <code>/consent</code>。</small>
                </div>
              )}
              {telegramGroups.length > 0 && (
                <div className="live-monitored-groups">
                  {telegramGroups.map((group) => <article key={group.chatId}>
                    <div><span>CHAT · …{group.chatId.slice(-5)}</span><b className={`is-${group.status}`}>{group.status.replaceAll("_", " ")}</b></div>
                    <p>{group.privacyReadable ? "Group Privacy 已關閉" : "Privacy mode blocking"} · 同意 {group.consentCount}/{group.memberCount ? Math.max(0, group.memberCount - 1) : "?"}</p>
                    <small>Last signal · {group.lastMessageAt ? displayDate(group.lastMessageAt) : "尚未收到"}{group.pausedReason ? ` · ${group.pausedReason}` : ""}</small>
                  </article>)}
                </div>
              )}
            </section>
            {telegramMessage && <p className="live-telegram-message" aria-live="polite">{telegramMessage}</p>}
          </section>
        </div>
      )}

      {adjustmentEdit && (
        <div className="live-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setAdjustmentEdit(null);
        }}>
          <section className="live-telegram-dialog live-adjustment-dialog" role="dialog" aria-modal="true" aria-labelledby="adjustment-edit-title">
            <header>
              <div><span>HUMAN REVIEW</span><h2 id="adjustment-edit-title">編輯 Before → Now</h2></div>
              <button type="button" aria-label="關閉調整編輯" onClick={() => setAdjustmentEdit(null)}>×</button>
            </header>
            <div className="live-telegram-boundary">
              <strong>{adjustmentEdit.title}</strong>
              <p>{adjustmentEdit.draftBefore ?? "保留既有 Situation 判斷，尚未自動改寫。"}</p>
            </div>
            <form onSubmit={submitAdjustmentEdit}>
              <label htmlFor="adjustment-now">NOW · 新判斷</label>
              <textarea id="adjustment-now" value={adjustmentNow} onChange={(event) => setAdjustmentNow(event.target.value)} rows={5} required />
              <label htmlFor="adjustment-impact">WHY IT MATTERS · 影響</label>
              <textarea id="adjustment-impact" value={adjustmentImpact} onChange={(event) => setAdjustmentImpact(event.target.value)} rows={3} required />
              <label htmlFor="adjustment-edit-reason">EDIT REASON · 為什麼修改 Agent 草稿</label>
              <textarea id="adjustment-edit-reason" value={adjustmentEditReason} onChange={(event) => setAdjustmentEditReason(event.target.value)} rows={2} required />
              <small>送出後仍只會產生 Situation 決策 diff；若源自 Inbox，會一併預覽 Inbox 狀態。你再次確認才會正式寫入。</small>
              <button type="submit">預覽 Edit＋Accept</button>
            </form>
          </section>
        </div>
      )}

      {workflowDialog && (
        <WorkflowDialog
          state={workflowDialog}
          situations={data.situations}
          onClose={() => setWorkflowDialog(null)}
          onSubmit={submitWorkflow}
        />
      )}

      <nav className="live-mobile-nav" aria-label="手機版主要區域">
        {navigation.map((item) => (
          <button key={item.id} className={view === item.id ? "is-active" : ""} onClick={() => setView(item.id)}>
            <strong>{item.label}</strong><span>{item.helper}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}

function SectionHeading({ kicker, title, detail, action }: { kicker: string; title: string; detail?: string; action?: React.ReactNode }) {
  return (
    <div className="live-section-heading">
      <div><p>{kicker}</p><h2>{title}</h2>{detail && <span>{detail}</span>}</div>
      {action}
    </div>
  );
}

function formatForwardCountdown(seconds: number) {
  if (!Number.isFinite(seconds)) return "時間未知";
  if (seconds <= 0 && seconds >= -15 * 60) return `T+${Math.abs(Math.round(seconds))}s`;
  if (seconds < 0) return "已結束";
  if (seconds < 60) return `T-${Math.round(seconds)}s`;
  if (seconds < 60 * 60) return `T-${Math.ceil(seconds / 60)}m`;
  if (seconds < 24 * 60 * 60) return `T-${Math.ceil(seconds / 3600)}h`;
  return `T-${Math.ceil(seconds / 86400)}d`;
}

function formatForwardValue(value: number | undefined, unit: string) {
  if (value === undefined) return "—";
  const suffix = unit === "percent" ? "%" : unit === "basis_points" ? "bp" : unit === "thousands" ? "K" : "";
  return `${value}${suffix}`;
}

const forwardFactLabels: Record<ForwardPulse["factState"], string> = {
  unverified: "未驗證 Flash",
  source_matched: "第二來源吻合",
  official_confirmed: "官方確認",
  conflicted: "來源衝突",
};

const forwardImpactLabels: Record<ForwardPulse["impactState"], string> = {
  not_observed: "市場反應待觀察",
  market_reacting: "市場正在反應",
  mixed: "市場反應分歧",
  contradictory: "市場反應相反",
};

function percentLabel(value: number | undefined) {
  if (value === undefined) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function EvidenceLoopPanel({ model, onReload }: { model: EvidenceLoopModel; onReload: () => Promise<unknown> }) {
  const [secContact, setSecContact] = useState("");
  const [fredKey, setFredKey] = useState("");
  const [alpacaKey, setAlpacaKey] = useState("");
  const [alpacaSecret, setAlpacaSecret] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const latestFact = model.facts[0];
  const reactedFact = model.facts.find((fact) => fact.reaction);

  const submit = async (endpoint: string, body: Record<string, unknown>, label: string) => {
    setBusy(label);
    setMessage("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${label}失敗（HTTP ${response.status}）`);
      setMessage(`${label}完成；憑證只保存於 Windows DPAPI。`);
      setSecContact("");
      setFredKey("");
      setAlpacaKey("");
      setAlpacaSecret("");
      await onReload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${label}失敗`);
    } finally {
      setBusy("");
    }
  };

  const refresh = () => submit("/api/v2/evidence-loop/refresh", {}, "閉環同步");
  return (
    <section className="fi-evidence-loop" aria-labelledby="fi-evidence-loop-title">
      <header className="fi-section-title">
        <div><span>03 / CLOSE THE LOOP</span><h3 id="fi-evidence-loop-title">Fact → Context → Reaction</h3></div>
        <button type="button" onClick={() => void refresh()} disabled={Boolean(busy)}>{busy === "閉環同步" ? "同步中…" : "同步 SEC / FRED / Alpaca"}</button>
      </header>
      <div className="fi-loop-grid">
        <article className="fi-loop-column is-fact">
          <header><span>01</span><div><b>FACT · SEC EDGAR</b><small>新 accession 才進 Inbox</small></div></header>
          {latestFact ? <>
            <div className="fi-loop-primary"><span>{latestFact.form} · {latestFact.symbols.join(" / ")}</span><h4>{latestFact.company}</h4><p>{latestFact.baselineOnly ? "既有申報基準線；未回放成警報。" : "新申報已建立未驗證 observation，等待你的判讀。"}</p></div>
            <footer><small>{displayDate(latestFact.publishedAt)}</small>{sourceLink(latestFact.source)}</footer>
          </> : <div className="fi-loop-empty"><strong>尚無 SEC 基準線</strong><p>設定 contact email 後才會向 data.sec.gov 發送請求。</p></div>}
        </article>

        <article className="fi-loop-column is-context">
          <header><span>02</span><div><b>CONTEXT · FRED</b><small>保存 realtime vintage</small></div></header>
          {model.macro.length ? <div className="fi-macro-tape">{model.macro.map((macro) => <div key={macro.id}>
            <span>{macro.id}</span><strong>{macro.value === undefined ? "—" : `${macro.value.toFixed(2)}${macro.unit === "%" ? "%" : ""}`}</strong>
            <small className={(macro.delta ?? 0) > 0 ? "is-up" : (macro.delta ?? 0) < 0 ? "is-down" : ""}>{macro.delta === undefined ? "missing" : `${macro.delta > 0 ? "+" : ""}${macro.delta.toFixed(2)}`} · {macro.observationDate}</small>
            {sourceLink(macro.source)}
          </div>)}</div> : <div className="fi-loop-empty"><strong>尚無總經背景</strong><p>設定 FRED API key 後載入利率、美元、通膨預期與金融條件。</p></div>}
        </article>

        <article className="fi-loop-column is-reaction">
          <header><span>03</span><div><b>REACTION · ALPACA</b><small>IEX fast lane / historical backfill</small></div></header>
          {reactedFact?.reaction ? <>
            <div className="fi-reaction-meta"><span>{reactedFact.form} · {reactedFact.reaction.windowMinutes}m</span><b>{reactedFact.reaction.feed.toUpperCase()}</b><small>coverage: {reactedFact.reaction.coverage}</small></div>
            <div className="fi-reaction-tape">{reactedFact.reaction.moves.map((move) => <div key={move.symbol}><span>{move.symbol}</span><strong>{percentLabel(move.returnPercent)}</strong><small>vs {reactedFact.reaction?.benchmark} {percentLabel(move.abnormalReturnPercent)}</small></div>)}</div>
          </> : <div className="fi-loop-empty"><strong>市場反應尚未完成</strong><p>{latestFact ? `狀態：${latestFact.reactionState}；滿 15 分鐘後回補 historical bars。` : "SEC 新事件出現後才建立 reaction job。"}</p></div>}
        </article>
      </div>

      <div className="fi-loop-status">
        <div><span>AS OF</span><strong>{displayDate(model.asOf)}</strong><small>{model.pendingReactionCount} reaction job(s) pending</small></div>
        <div><span>INCOMPLETE</span>{model.incompleteReasons.length ? model.incompleteReasons.map((reason) => <small key={reason}>{reason}</small>) : <strong>閉環資料源已連線</strong>}</div>
      </div>

      <details className="fi-loop-setup">
        <summary>本機資料源設定</summary>
        <div>
          <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void submit("/api/v2/evidence-loop/sec/setup", { contact_email: secContact }, "SEC 設定"); }}>
            <label htmlFor="sec-contact">SEC contact email</label><input id="sec-contact" type="email" required autoComplete="email" value={secContact} onChange={(event) => setSecContact(event.target.value)} placeholder="name@example.com" />
            <button disabled={Boolean(busy)}>儲存 SEC contact</button>
          </form>
          <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void submit("/api/v2/evidence-loop/fred/setup", { api_key: fredKey }, "FRED 設定"); }}>
            <label htmlFor="fred-key">FRED API key</label><input id="fred-key" type="password" required autoComplete="off" value={fredKey} onChange={(event) => setFredKey(event.target.value)} />
            <button disabled={Boolean(busy)}>儲存 FRED key</button>
          </form>
          <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void submit("/api/v2/connectors/alpaca/bootstrap", { key_id: alpacaKey, secret_key: alpacaSecret }, "Alpaca 設定"); }}>
            <label htmlFor="alpaca-key">Alpaca key id</label><input id="alpaca-key" type="password" required autoComplete="off" value={alpacaKey} onChange={(event) => setAlpacaKey(event.target.value)} />
            <label htmlFor="alpaca-secret">Alpaca secret</label><input id="alpaca-secret" type="password" required autoComplete="off" value={alpacaSecret} onChange={(event) => setAlpacaSecret(event.target.value)} />
            <button disabled={Boolean(busy)}>連線 Alpaca</button>
          </form>
        </div>
        {message && <p role="status">{message}</p>}
      </details>
    </section>
  );
}

function ForwardNowView({
  needsYou,
  sourceRevision,
  changes,
  missions,
  connectors,
  watching,
  situations,
  forward,
  evidenceLoop,
  onReload,
  onOpen,
  onPreview,
  onAcknowledgeChange,
  onAcceptAdjustment,
  onEditAdjustment,
  onDismissSituationAdjustment,
  onAcceptMissionAdjustment,
  onEditMissionAdjustment,
  onDismissMissionAdjustment,
  onOpenWorkflow,
}: {
  needsYou: AttentionItem[];
  sourceRevision: string | number;
  changes: ChangeItem[];
  missions: Mission[];
  connectors: ConnectorHealth[];
  watching: WatchItem[];
  situations: Situation[];
  briefing: Briefing;
  signals: LiveSignal[];
  forward: ForwardNowModel;
  evidenceLoop: EvidenceLoopModel;
  onReload: () => Promise<unknown>;
  onOpen: (view: View) => void;
  onPreview: (command: string, label: string, payload: Record<string, unknown>) => Promise<void>;
  onAcknowledgeChange: (change: ChangeItem) => void;
  onAcceptAdjustment: (item: AttentionItem) => void;
  onEditAdjustment: (item: AttentionItem) => void;
  onDismissSituationAdjustment: (item: AttentionItem) => void;
  onAcceptMissionAdjustment: (item: AttentionItem) => void;
  onEditMissionAdjustment: (item: AttentionItem) => void;
  onDismissMissionAdjustment: (item: AttentionItem) => void;
  onOpenWorkflow: (state: WorkflowDialogState) => void;
}) {
  const radarEvents = forward.eventRadar.length
    ? forward.eventRadar
    : forward.nextEvent ? [forward.nextEvent] : [];
  const combinedCoverage = [
    ...forward.coverageHealth,
    ...connectors
      .filter((connector) => !forward.coverageHealth.some((item) => item.id.includes(connector.id)))
      .slice(0, Math.max(0, 6 - forward.coverageHealth.length))
      .map((connector) => ({
        id: connector.id,
        label: connector.label,
        state: connector.state,
        coverageState: connector.state,
        detail: connector.detail,
        checkedAt: connector.lastSeen,
      })),
  ].slice(0, 6);
  return (
    <div className="live-view fi-now">
      <section className="fi-command-header">
        <div>
          <p>FORWARD INTELLIGENCE / NOW</p>
          <h2>先看下一個變化，<br />再決定要不要動。</h2>
        </div>
        <div className="fi-latency-contract">
          <span>FAST LANE CONTRACT</span>
          <strong>&lt; {Math.round(forward.latencyTargetMs / 1000)} 秒</strong>
          <small>從 Bot 收到轉傳開始；官方確認不承諾秒級</small>
        </div>
        <div className="fi-asof">
          <span>V2 ENGINE</span>
          <strong>{forward.mode === "forward_intelligence_v2" ? "ARMED" : "WAITING"}</strong>
          <small>{displayDate(forward.asOf)} · r{sourceRevision}</small>
        </div>
      </section>

      <section className="fi-radar" aria-labelledby="fi-radar-title">
        <header className="fi-section-title">
          <div><span>01 / ANTICIPATE</span><h3 id="fi-radar-title">Event Radar</h3></div>
          <p>官方日曆先部署，不等新聞出現才開始工作</p>
        </header>
        {radarEvents.length ? (
          <div className="fi-event-track">
            {radarEvents.map((event, index) => (
              <article key={event.id} className={`is-${event.state}`}>
                <div className="fi-event-node"><span>{String(index + 1).padStart(2, "0")}</span></div>
                <div className="fi-event-time">
                  <strong>{formatForwardCountdown(event.secondsToRelease)}</strong>
                  <small>{new Date(event.scheduledAt).toLocaleString("zh-TW", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} ET</small>
                </div>
                <div className="fi-event-copy">
                  <span>{event.releaseType.toUpperCase()} · {event.state}</span>
                  <h4>{event.title}</h4>
                  <p>{event.consensusState === "missing_legal_source" ? "Consensus 尚無合法自動來源；等待快訊中的 actual / forecast / previous。" : "Consensus snapshot 已備妥。"}</p>
                </div>
                {sourceLink(event.source)}
              </article>
            ))}
          </div>
        ) : (
          <div className="fi-empty"><span>RADAR CLEAR</span><strong>未來 24 小時沒有已武裝的事件窗口</strong><p>系統保持安靜；下一個官方事件同步後會在這裡出現。</p></div>
        )}
      </section>

      <section className="fi-pulse" aria-labelledby="fi-pulse-title">
        <header className="fi-section-title">
          <div><span>02 / DETECT</span><h3 id="fi-pulse-title">Live Pulse</h3></div>
          <p>事實可信度與市場影響分開，不把速度冒充真實</p>
        </header>
        {forward.livePulse.length ? (
          <div className="fi-pulse-grid">
            {forward.livePulse.map((pulse) => (
              <article key={pulse.id} className={`is-${pulse.factState}`}>
                <header>
                  <span className="fi-pulse-beacon" aria-hidden="true" />
                  <b>{forwardFactLabels[pulse.factState]}</b>
                  <small>{displayDate(pulse.lastSeenAt)}</small>
                </header>
                <div className="fi-pulse-title"><span>{pulse.sourceLabel}</span><h4>{pulse.claim?.metricLabel ?? pulse.title}</h4></div>
                {pulse.claim ? (
                  <div className="fi-release-tape">
                    <div><span>ACTUAL</span><strong>{formatForwardValue(pulse.claim.actual, pulse.claim.unit)}</strong></div>
                    <div><span>FORECAST</span><strong>{formatForwardValue(pulse.claim.forecast, pulse.claim.unit)}</strong></div>
                    <div><span>PREVIOUS</span><strong>{formatForwardValue(pulse.claim.previous, pulse.claim.unit)}</strong></div>
                    <div className="is-surprise"><span>SURPRISE</span><strong>{pulse.claim.surprise !== undefined && pulse.claim.surprise > 0 ? "+" : ""}{formatForwardValue(pulse.claim.surprise, pulse.claim.unit)}</strong></div>
                  </div>
                ) : <p>訊息已收到，但無法可靠提取結構化數字。</p>}
                <div className="fi-pulse-verification">
                  <span>{pulse.claim?.pressureLabel ?? "方向待判讀"}</span>
                  <span>{forwardImpactLabels[pulse.impactState]}</span>
                  <span>{pulse.independentSourceCount} independent · {pulse.mentionCount} mentions</span>
                </div>
                <footer>{sourceLink(pulse.source)}<button type="button" onClick={() => onOpen("situations")}>檢視路徑壓力</button></footer>
              </article>
            ))}
          </div>
        ) : (
          <div className="fi-empty"><span>FAST LANE LISTENING</span><strong>目前沒有進行中的 Flash</strong><p>將 CPI、FOMC 等快訊直接轉傳給 Bot；普通文章仍留在 Inbox。</p></div>
        )}
      </section>

      <EvidenceLoopPanel model={evidenceLoop} onReload={onReload} />

      <div className="fi-strategy-grid">
        <section className="fi-path-map" aria-labelledby="fi-path-title">
          <header className="fi-section-title">
            <div><span>03 / FORECAST</span><h3 id="fi-path-title">Path Map</h3></div>
            <button type="button" onClick={() => situations[0] ? onOpenWorkflow({ kind: "forecast_update", situation: situations[0] }) : onOpen("situations")}>建立／校準路徑</button>
          </header>
          {forward.pathMap.length ? forward.pathMap.slice(0, 2).map((map) => (
            <article className="fi-path-card" key={map.situationId}>
              <header><div><span>{map.situationTitle}</span><h4>{map.intelligenceQuestion}</h4></div><b className={`is-${map.calibrationState}`}>{map.calibrationState}</b></header>
              <div className="fi-path-bars">
                {map.paths.map((path) => (
                  <div key={path.id} className={`is-${path.tone}`}>
                    <div><span>{path.label}</span><strong>{path.probability}%</strong></div>
                    <i style={{ "--fi-path-width": `${path.probability}%` } as CSSProperties} />
                    <p>{path.summary}</p>
                    <small>觸發：{path.trigger}</small>
                  </div>
                ))}
              </div>
              <footer><span>NEXT OBSERVABLE</span><strong>{map.nextObservable ?? "尚未設定"}</strong><small>{map.comparableEventCount} comparable events · {displayDate(map.horizon)}</small><button type="button" onClick={() => {
                const situation = situations.find((item) => item.id === map.situationId);
                if (situation) onOpenWorkflow({ kind: "forecast_update", situation });
              }}>重新校準</button></footer>
            </article>
          )) : (
            <div className="fi-empty is-warning"><span>NO FABRICATED ODDS</span><strong>尚未建立正式三路徑 Forecast</strong><p>系統已停止用 domain 預設值捏造 45/35/20；建立三條合計 100% 的可稽核路徑後才顯示機率。</p>{situations[0] && <button type="button" onClick={() => onOpenWorkflow({ kind: "forecast_update", situation: situations[0] })}>為 {situations[0].title} 建立路徑</button>}</div>
          )}
        </section>

        <section className="fi-gates" aria-labelledby="fi-gates-title">
          <header className="fi-section-title">
            <div><span>04 / DECIDE</span><h3 id="fi-gates-title">Decision Gates</h3></div>
            <span>{forward.decisionGates.length + needsYou.length} open</span>
          </header>
          <div className="fi-gate-list">
            {forward.decisionGates.map((gate) => (
              <article key={gate.id} className={`is-${gate.state}`}>
                <div><span>{gate.kind.toUpperCase()}</span><b>{gate.state}</b></div>
                <h4>{gate.title}</h4><p>{gate.reason}</p>
                <footer><small>{gate.dueAt ? displayDate(gate.dueAt) : "條件命中"}</small><button type="button" onClick={() => onOpen(gate.kind === "mission" ? "missions" : "situations")}>開啟</button></footer>
              </article>
            ))}
            {needsYou.map((item) => (
              <article key={item.id} className="is-needs-user">
                <div><span>{item.eyebrow}</span><b>{item.priority}</b></div>
                <h4>{item.title}</h4><p>{item.draftNow ?? item.draftNextAction ?? item.summary}</p>
                <footer>
                  <small>{item.due ? displayDate(item.due) : "等待決定"}</small>
                  <div className="fi-gate-actions">
                    {item.entityType === "Mission" && item.targetMissionId ? <>
                      <button type="button" onClick={() => onAcceptMissionAdjustment(item)}>Accept</button>
                      <button type="button" onClick={() => onEditMissionAdjustment(item)}>Edit</button>
                      <button type="button" onClick={() => onDismissMissionAdjustment(item)}>Keep</button>
                    </> : item.entityType === "Situation" && item.targetSituationId ? <>
                      <button type="button" onClick={() => onAcceptAdjustment(item)}>Accept</button>
                      <button type="button" onClick={() => onEditAdjustment(item)}>Edit</button>
                      <button type="button" onClick={() => onDismissSituationAdjustment(item)}>Keep</button>
                    </> : item.entityType === "InboxItem" ? <>
                      <button type="button" onClick={() => onAcceptAdjustment(item)}>Accept</button>
                      <button type="button" onClick={() => void onPreview("inbox.watch", `Watch：${item.title}`, { inbox_id: item.id, status: "watch", requires_decision: false })}>Watch</button>
                    </> : <button type="button" onClick={() => onOpen("inbox")}>處理</button>}
                  </div>
                </footer>
              </article>
            ))}
            {!forward.decisionGates.length && !needsYou.length && <div className="fi-empty"><span>NO DECISION DUE</span><strong>目前沒有需要你批准的變更</strong><p>Flash 可以先出現，但沒有通過門檻就不會推動 Mission。</p></div>}
          </div>
        </section>
      </div>

      <section className="fi-execution">
        <header className="fi-section-title"><div><span>05 / EXECUTE</span><h3>Action Control Loop</h3></div><p>情報只有在改變判斷或行動時才離開這裡</p></header>
        <div className="fi-execution-grid">
          <div className="fi-change-column">
            <div className="fi-column-head"><span>MATERIAL DELTAS</span><button type="button" onClick={() => onOpen("situations")}>全部</button></div>
            {changes.length ? changes.map((change) => <article key={change.id}>
              <span>{change.domain} · {displayDate(change.observedAt)}</span><h4>{change.title}</h4>
              <div><p><b>BEFORE</b>{change.before}</p><i>→</i><p><b>NOW</b>{change.now}</p></div>
              <footer><strong>{change.impact}</strong><button type="button" onClick={() => onAcknowledgeChange(change)}>已讀，保持監看</button></footer>
            </article>) : <div className="fi-empty"><span>NO MATERIAL DELTA</span><strong>沒有實質變化</strong><p>一般新聞不會填滿這裡。</p></div>}
          </div>
          <div className="fi-mission-column">
            <div className="fi-column-head"><span>MISSION NEXT ACTION</span><button type="button" onClick={() => onOpen("missions")}>全部</button></div>
            {missions.length ? missions.map((mission) => <article key={mission.id}>
              <div><span>{mission.domain}</span><b>{mission.status}</b></div><h4>{mission.title}</h4><p>{mission.nextAction}</p>
              <footer><small>Review · {displayDate(mission.reviewDate)}</small><button type="button" onClick={() => onOpenWorkflow({ kind: "record_result", mission })}>記錄結果</button></footer>
            </article>) : <div className="fi-empty"><span>NO ACTIVE MISSION</span><strong>沒有待辦 Mission</strong><p>Inbox 與單一快訊不會自動建立任務。</p></div>}
          </div>
        </div>
      </section>

      <section className="fi-coverage">
        <header className="fi-section-title"><div><span>06 / COVERAGE</span><h3>Sensor Coverage</h3></div><p>看得見缺口，才不會把安靜誤認成世界沒變</p></header>
        <div className="fi-coverage-grid">
          {combinedCoverage.map((item) => <article key={item.id} className={`is-${item.state}`}>
            <header><span /><strong>{item.label}</strong><b>{item.state}</b></header><p>{item.detail}</p><footer><span>{item.coverageState}</span><small>{item.checkedAt ? displayDate(item.checkedAt) : "—"}</small></footer>
          </article>)}
        </div>
        {watching.length > 0 && <div className="fi-watchline"><span>WATCHBOOK</span>{watching.slice(0, 4).map((watch) => <button type="button" key={watch.id} onClick={() => onOpen("situations")}><b>{watch.label}</b><small>{watch.condition}</small></button>)}</div>}
      </section>
    </div>
  );
}

function LegacyTodayView({
  needsYou,
  sourceRevision,
  changes,
  missions,
  connectors,
  watching,
  situations,
  briefing,
  signals,
  forward,
  onOpen,
  onPreview,
  onAcknowledgeChange,
  onAcceptAdjustment,
  onEditAdjustment,
  onDismissSituationAdjustment,
  onAcceptMissionAdjustment,
  onEditMissionAdjustment,
  onDismissMissionAdjustment,
  onOpenWorkflow,
}: {
  needsYou: AttentionItem[];
  sourceRevision: string | number;
  changes: ChangeItem[];
  missions: Mission[];
  connectors: ConnectorHealth[];
  watching: WatchItem[];
  situations: Situation[];
  briefing: Briefing;
  signals: LiveSignal[];
  forward: ForwardNowModel;
  onOpen: (view: View) => void;
  onPreview: (command: string, label: string, payload: Record<string, unknown>) => Promise<void>;
  onAcknowledgeChange: (change: ChangeItem) => void;
  onAcceptAdjustment: (item: AttentionItem) => void;
  onEditAdjustment: (item: AttentionItem) => void;
  onDismissSituationAdjustment: (item: AttentionItem) => void;
  onAcceptMissionAdjustment: (item: AttentionItem) => void;
  onEditMissionAdjustment: (item: AttentionItem) => void;
  onDismissMissionAdjustment: (item: AttentionItem) => void;
  onOpenWorkflow: (state: WorkflowDialogState) => void;
}) {
  const quiet = changes.length === 0;
  const [readingDepth, setReadingDepth] = useState<ReadingDepthId>("scan");
  const progressiveLevel = { scan: 0, map: 1, understand: 2, decide: 3, deep: 4 }[readingDepth];
  const cognitiveInput = useMemo<CognitiveReaderInput>(() => ({
    asOf: briefing.generatedAt,
    sourceRevision,
    needsYou,
    changes,
    missions,
    watching,
    connectors,
    situations,
    briefing,
  }), [briefing, changes, connectors, missions, needsYou, situations, sourceRevision, watching]);
  return (
    <div className="live-view live-today">
      <SectionHeading kicker="01 / TODAY" title="今天需要你做什麼？" detail="先選可用時間；同一份情報會保留骨架，再逐層增加證據與細節。" />

      <CognitiveReader input={cognitiveInput} depth={readingDepth} onDepthChange={setReadingDepth} />

      <section className="live-needs" aria-labelledby="needs-title" hidden={progressiveLevel < 1}>
        <div className="live-subhead"><h3 id="needs-title">Needs You</h3><span>{needsYou.length} / 3</span></div>
        {needsYou.length ? (
          <div className="live-card-grid">
            {needsYou.map((item) => (
              <article className="live-attention-card" key={item.id}>
                <div className="live-card-meta"><span>{item.eyebrow}</span><b className={`is-${item.priority.toLowerCase()}`}>{item.priority}</b></div>
                <h3>{item.title}</h3><p>{item.summary}</p>
                {item.entityType === "Situation" && item.draftNow && (
                  <div className="live-adjustment-proposal">
                    <span>PROPOSED NOW</span>
                    <strong>{item.draftNow}</strong>
                    {item.draftImpact && <small>{item.draftImpact}</small>}
                  </div>
                )}
                {item.entityType === "Mission" && item.draftNextAction && (
                  <div className="live-adjustment-proposal">
                    <span>PROPOSED NEXT ACTION</span>
                    <strong>{item.draftNextAction}</strong>
                    <small>{item.draftStatus ?? "active"} · Review {dateInputFrom(item.draftReviewDate)}</small>
                    {item.draftRationale && <p>{item.draftRationale}</p>}
                  </div>
                )}
                <footer><small>{item.due ?? "沒有硬期限"}</small>{sourceLink(item.source)}</footer>
                {item.entityType === "InboxItem" && item.targetSituationId && (
                  <div className="live-adjustment-actions" aria-label={`${item.title} 調整決策`}>
                    <button type="button" onClick={() => onAcceptAdjustment(item)}>Accept</button>
                    <button type="button" onClick={() => onEditAdjustment(item)}>Edit</button>
                    <button type="button" onClick={() => void onPreview("inbox.watch", `Watch：${item.title}`, { inbox_id: item.id, status: "watch", requires_decision: false })}>Watch</button>
                    <button type="button" onClick={() => void onPreview("inbox.not_relevant", `Dismiss：${item.title}`, { inbox_id: item.id, status: "not_relevant", requires_decision: false })}>Dismiss</button>
                  </div>
                )}
                {item.entityType === "Situation" && item.targetSituationId && item.draftNow && (
                  <div className="live-adjustment-actions is-three" aria-label={`${item.title} Situation 調整決策`}>
                    <button type="button" onClick={() => onAcceptAdjustment(item)}>Accept</button>
                    <button type="button" onClick={() => onEditAdjustment(item)}>Edit</button>
                    <button type="button" onClick={() => onDismissSituationAdjustment(item)}>Keep current</button>
                  </div>
                )}
                {item.entityType === "Mission" && item.targetMissionId && item.draftNextAction && (
                  <div className="live-adjustment-actions is-three" aria-label={`${item.title} Mission 調整決策`}>
                    <button type="button" onClick={() => onAcceptMissionAdjustment(item)}>Accept</button>
                    <button type="button" onClick={() => onEditMissionAdjustment(item)}>Edit</button>
                    <button type="button" onClick={() => onDismissMissionAdjustment(item)}>Keep current</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : <QuietState title="目前沒有需要你決定的事項" detail="系統會保持安靜，直到 watch condition 或期限被觸發。" />}
      </section>

      <section className="live-signals-section" aria-labelledby="live-signals-title" hidden={progressiveLevel < 2}>
        <div className="live-subhead">
          <div><span>HUMAN SENSOR NETWORK</span><h3 id="live-signals-title">Live Signals</h3></div>
          <button type="button" onClick={() => onOpen("inbox")}>{signals.length ? "前往滑卡分流" : "查看 Inbox"}</button>
        </div>
        {signals.length ? (
          <div className="live-signal-grid">
            {signals.slice(0, 3).map((signal) => (
              <article key={signal.id} className={`is-${signal.status}`}>
                <header>
                  <span>{signal.status === "corroborated" ? "MULTI-SOURCE LEAD" : signal.status === "live_signal" ? "UNVERIFIED LIVE" : "CANDIDATE"}</span>
                  <b>{signal.score}</b>
                </header>
                <h3>{signal.title}</h3>
                <p>{signal.sourceLanguage === "zh-Hant" ? signal.summary : "非中文群組訊號；進入 Inbox 後提供裝置端繁中摘要與原文。"}</p>
                <div className="live-signal-metrics">
                  <span><strong>{signal.independentSourceCount}</strong> 獨立來源</span>
                  <span><strong>{signal.mentionCount}</strong> 次提及</span>
                  <span>{signal.velocityLabel}</span>
                </div>
                {signal.decisionPreview && (
                  <div className="live-signal-preview">
                    <span>{signal.decisionPreview.situationTitle}</span>
                    <p><b>BEFORE</b>{signal.decisionPreview.before}</p>
                    <i>→</i>
                    <p><b>NEW SIGNAL</b>{signal.decisionPreview.newSignal}</p>
                    {signal.decisionPreview.scenarioProbabilities.length > 0 && (
                      <div>{signal.decisionPreview.scenarioProbabilities.map((path) => <small key={path.label}>{path.label} {path.probability}%</small>)}</div>
                    )}
                    <em>{signal.decisionPreview.probabilityChange}</em>
                  </div>
                )}
                <footer><small>First seen · {displayDate(signal.firstSeenAt)}</small>{sourceLink(signal.source)}</footer>
              </article>
            ))}
          </div>
        ) : <QuietState title="目前沒有值得打擾你的即時群組訊號" detail="普通聊天會留在加密 Sensor Queue；低相關與重複內容不進正式 Inbox。" />}
      </section>

      <div className="live-today-split" hidden={progressiveLevel < 1}>
        <section className="live-today-panel is-material">
          <div className="live-subhead"><div><span>DECISION SIGNAL</span><h3>Material changes</h3></div><button onClick={() => onOpen("situations")}>查看全部</button></div>
          <div className="live-today-panel-body">
            {quiet ? <QuietState title="沒有實質變化" detail="一般新聞不會拿來填滿這裡；未匹配情報仍留在 Inbox。" /> : (
              <div className="live-change-list">
              {changes.map((change) => (
                <article key={change.id}>
                  <div><span>{change.domain}</span><small>{change.observedAt}</small></div>
                  <h3>{change.title}</h3>
                  <div className="live-before-now"><p><span>BEFORE</span>{change.before}</p><i>→</i><p><span>NOW</span>{change.now}</p></div>
                  <footer><strong>{change.impact}</strong><div>{sourceLink(change.source)}<button onClick={() => onAcknowledgeChange(change)}>已讀，保持監看</button></div></footer>
                </article>
              ))}
              </div>
            )}
          </div>
        </section>

        <section className="live-today-panel is-mission">
          <div className="live-subhead"><div><span>EXECUTION</span><h3>Mission next actions</h3></div><button onClick={() => onOpen("missions")}>管理全部</button></div>
          <div className="live-today-panel-body">
            {missions.length ? <div className="live-next-action-list">{missions.map((mission) => (
              <article className="live-next-action" key={mission.id}>
                <div><span>{mission.domain}</span><b className={`is-${mission.status}`}>{mission.status}</b></div>
                <h3>{mission.title}</h3><p>{mission.nextAction}</p>
                <footer><small>Review · {displayDate(mission.reviewDate)}</small><button onClick={() => onOpenWorkflow({ kind: "record_result", mission })}>記錄結果</button></footer>
              </article>
            ))}</div> : <QuietState title="沒有待辦 Mission" detail="Inbox 不會自動建立任務。" />}
          </div>
        </section>
      </div>

      <section className="live-watching-section" hidden={progressiveLevel < 2}>
        <div className="live-subhead"><h3>Watching now</h3><span>{watching.length} 個明確條件</span></div>
        {watching.length ? <div className="live-watch-strip">{watching.slice(0, 4).map((item) => (
          <article key={item.id} className={`is-${item.state}`}><span>{item.state}</span><strong>{item.label}</strong><p>{item.condition}</p><small>Next check · {item.nextCheck ?? "條件命中時"}</small></article>
        ))}</div> : <QuietState title="沒有啟用中的 Watch" detail="沒有條件就不假裝正在監控。" />}
      </section>

      <section className="live-connector-section" hidden={progressiveLevel < 2}>
        <div className="live-subhead"><h3>Coverage & connector health</h3><span>完整性比即時感重要</span></div>
        <div className="live-health-grid">
          {connectors.map((connector) => (
            <article key={connector.id} className={`is-${connector.state}`}>
              <div><span className="live-health-dot" /><strong>{connector.label}</strong><b>{healthLabels[connector.state] ?? connector.state}</b></div>
              <p>{connector.detail}</p><small>Last seen · {connector.lastSeen ?? "—"}</small>
            </article>
          ))}
        </div>
      </section>

      <div hidden={progressiveLevel < 4}><BriefingCard briefing={briefing} /></div>
    </div>
  );
}

function QuietState({ title, detail }: { title: string; detail: string }) {
  return <div className="live-quiet"><span aria-hidden="true">✓</span><div><strong>{title}</strong><p>{detail}</p></div></div>;
}

function BriefingCard({ briefing }: { briefing: Briefing }) {
  return (
    <section className="live-briefing">
      <div className="live-briefing-rail"><span>DAILY</span><strong>BRIEF</strong><small>{briefing.duration}</small></div>
      <div className="live-briefing-body">
        <div className="live-subhead"><div><h3>Decision briefing transcript</h3><span>{briefing.generatedAt}</span></div><b>TRANSCRIPT ONLY</b></div>
        <div className="live-transcript">
          {briefing.transcript.map((paragraph, index) => <p key={`${paragraph}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span>{paragraph}</p>)}
        </div>
        <footer>
          <div>{briefing.sources.map((source) => <span key={source.href}>{sourceLink(source)}</span>)}</div>
          <span className="live-audio-status">◌ {briefing.status}</span>
        </footer>
      </div>
    </section>
  );
}

const routeKeywordFamilies = [
  { group: "Macro", words: ["fed", "fomc", "inflation", "cpi", "pce", "rate", "treasury", "yield", "通膨", "利率", "聯準會"] },
  { group: "Finance", words: ["market", "stock", "vix", "fear", "greed", "liquidity", "selloff", "correction", "股市", "回調", "風險", "流動性"] },
  { group: "AI / Industry", words: ["artificial intelligence", " ai ", "semiconductor", "chip", "cloud", "data center", "capex", "gpu", "晶片", "資料中心", "資本支出", "能源"] },
  { group: "Geopolitics", words: ["war", "sanction", "tariff", "geopolit", "supply chain", "戰爭", "制裁", "關稅", "地緣", "供應鏈"] },
  { group: "Personal", words: ["career", "learning", "product", "project", "職涯", "學習", "產品", "專案"] },
] as const;

function predictInboxRoute(item: InboxItem, situations: Situation[]): InboxRoutePrediction {
  const haystack = ` ${item.domain} ${item.title} ${item.summary} ${item.matchedInterests.join(" ")} `.toLocaleLowerCase();
  const family = routeKeywordFamilies
    .map((candidate) => ({ ...candidate, hits: candidate.words.filter((word) => haystack.includes(word)).length }))
    .sort((left, right) => right.hits - left.hits)[0];
  const fallbackDomain = item.domain && !["world", "general"].includes(item.domain.toLocaleLowerCase()) ? item.domain : "World / General";
  const group = family?.hits ? family.group : fallbackDomain;
  const scored = situations.map((situation) => {
    const situationDomain = situation.domain.toLocaleLowerCase();
    const title = situation.title.toLocaleLowerCase();
    let score = 0;
    const reasons: string[] = [];
    if (item.matchedInterests.includes(situation.id)) {
      score += 70;
      reasons.push("既有 interest 已對應");
    }
    const groupTokens = group.toLocaleLowerCase().split(/\s*\/\s*|\s+/).filter((token) => token.length > 2);
    if (groupTokens.some((token) => situationDomain.includes(token) || title.includes(token))) {
      score += 35;
      reasons.push("領域相符");
    }
    if (item.domain && situationDomain.includes(item.domain.toLocaleLowerCase())) {
      score += 25;
      reasons.push("來源 Domain 相符");
    }
    const titleTerms = title.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 4);
    const overlaps = titleTerms.filter((token) => haystack.includes(token)).length;
    if (overlaps) {
      score += Math.min(24, overlaps * 8);
      reasons.push("主題詞重疊");
    }
    return { situation, score, reasons };
  }).sort((left, right) => right.score - left.score)[0];
  const hasSituation = Boolean(scored && scored.score >= 35);
  const confidence = hasSituation ? Math.min(94, 62 + Math.round(scored.score / 3)) : Math.min(64, 54 + (family?.hits ?? 0) * 3);
  return {
    group,
    ...(hasSituation ? { situationId: scored.situation.id, situationTitle: scored.situation.title } : {}),
    confidence,
    reason: hasSituation
      ? `${scored.reasons.join("、")}；有興趣時連結既有 Situation。`
      : `${family?.hits ? `命中 ${family.hits} 個 ${group} 主題詞` : "目前沒有足夠的既有脈絡"}；有興趣時先放入 ${group} Watch。`,
  };
}

const browserTranslatorCache = new Map<string, BrowserTranslator>();

function browserTranslatorFactory() {
  return (globalThis as unknown as { Translator?: BrowserTranslatorFactory }).Translator;
}

function languageLabel(language: InboxItem["sourceLanguage"]) {
  return language === "zh-Hant" ? "繁中" : language === "en" ? "英文" : language === "ja" ? "日文" : language === "ko" ? "韓文" : "其他語言";
}

function LocalizedInboxSummary({ item }: { item: InboxItem }) {
  const needsTranslation = item.summaryKind === "source_aware_fallback" && Boolean(item.translationInput) && item.sourceLanguage !== "other";
  const [translated, setTranslated] = useState("");
  const [translationState, setTranslationState] = useState<"checking" | "ready_to_enable" | "downloading" | "translating" | "ready" | "unsupported" | "error">(
    needsTranslation ? "checking" : "unsupported",
  );
  const [progress, setProgress] = useState(0);
  const cacheKey = `${item.sourceLanguage}:zh-Hant`;

  useEffect(() => {
    if (!needsTranslation || !item.translationInput) return;
    let cancelled = false;
    void (async () => {
      const cached = browserTranslatorCache.get(cacheKey);
      if (cached) {
        setTranslationState("translating");
        try {
          const result = await cached.translate(item.translationInput as string);
          if (!cancelled) {
            setTranslated(result.trim());
            setTranslationState("ready");
          }
        } catch {
          if (!cancelled) setTranslationState("error");
        }
        return;
      }
      const factory = browserTranslatorFactory();
      if (!factory) {
        if (!cancelled) setTranslationState("unsupported");
        return;
      }
      try {
        const availability = await factory.availability({ sourceLanguage: item.sourceLanguage, targetLanguage: "zh-Hant" });
        if (!cancelled) setTranslationState(availability === "unavailable" ? "unsupported" : "ready_to_enable");
      } catch {
        if (!cancelled) setTranslationState("unsupported");
      }
    })();
    return () => { cancelled = true; };
  }, [cacheKey, item.sourceLanguage, item.translationInput, needsTranslation]);

  async function enableLocalTranslation() {
    if (!item.translationInput) return;
    const factory = browserTranslatorFactory();
    if (!factory) {
      setTranslationState("unsupported");
      return;
    }
    try {
      let translator = browserTranslatorCache.get(cacheKey);
      if (!translator) {
        setTranslationState("downloading");
        translator = await factory.create({
          sourceLanguage: item.sourceLanguage,
          targetLanguage: "zh-Hant",
          monitor(monitor) {
            monitor.addEventListener("downloadprogress", (event) => setProgress(Math.round(event.loaded * 100)));
          },
        });
        browserTranslatorCache.set(cacheKey, translator);
      }
      setTranslationState("translating");
      const result = await translator.translate(item.translationInput);
      setTranslated(result.trim());
      setTranslationState("ready");
    } catch {
      setTranslationState("error");
    }
  }

  const summary = translated || item.whatChanged;
  const badge = item.summaryKind === "original_chinese"
    ? "來源原文 · 中文"
    : item.summaryKind === "canonical_chinese"
      ? "已儲存繁中摘要"
      : translated
        ? `裝置端翻譯 · ${languageLabel(item.sourceLanguage)} → 繁中`
        : "來源導讀 · 待翻譯";
  return (
    <section className="live-localized-summary">
      <header><span>發生什麼</span><b>{badge}</b></header>
      <p>{summary}</p>
      {needsTranslation && !translated && (
        <footer>
          {translationState === "checking" && <small>正在檢查本機翻譯能力…</small>}
          {translationState === "ready_to_enable" && <button type="button" onClick={() => void enableLocalTranslation()}>啟用{languageLabel(item.sourceLanguage)}→繁中</button>}
          {translationState === "downloading" && <small>首次下載本機語言包… {progress ? `${progress}%` : ""}</small>}
          {translationState === "translating" && <small>正在裝置端產生繁中摘要…</small>}
          {translationState === "unsupported" && <small>此瀏覽器不支援裝置端翻譯；目前顯示來源導讀。</small>}
          {translationState === "error" && <><small>本機翻譯暫時失敗；目前顯示來源導讀。</small><button type="button" onClick={() => void enableLocalTranslation()}>重試</button></>}
        </footer>
      )}
    </section>
  );
}

function InboxDecisionContext({ item }: { item: InboxItem }) {
  return (
    <section className="live-inbox-decision-context" aria-label="判斷所需脈絡">
      <article>
        <span>為什麼出現在這裡</span>
        <p>{item.whyRelevant}</p>
      </article>
      <article>
        <span>仍缺什麼</span>
        <p>{item.stillUnknown}</p>
      </article>
    </section>
  );
}

function InboxView({
  items,
  signals,
  situations,
  onPreview,
  onSwipeBatch,
  busy,
}: {
  items: InboxItem[];
  signals: LiveSignal[];
  situations: Situation[];
  onPreview: (command: string, label: string, payload: Record<string, unknown>) => Promise<void>;
  onSwipeBatch: (decisions: InboxSwipeDecision[]) => Promise<boolean>;
  busy: boolean;
}) {
  const [decisions, setDecisions] = useState<InboxSwipeDecision[]>([]);
  const [dragX, setDragX] = useState(0);
  const pointerOrigin = useRef<number | null>(null);
  const pointerDelta = useRef(0);
  const sensorQueue = signals.map(signalAsInbox);
  const canonicalQueue = items.filter((item) => item.status === "new").map((item) => ({ ...item, origin: "canonical" as const }));
  // Keep each preview atomic: finish the ephemeral Sensor batch before canonical Inbox items.
  const queueItems = sensorQueue.length ? sensorQueue : canonicalQueue;
  const verificationItems = items.filter((item) => item.status === "wiki_ingest_pending");
  const validDecisions = decisions.filter((decision) =>
    queueItems.some((item) =>
      item.id === (decision.origin === "signal" ? decision.signal_id : decision.inbox_id)
      && item.revision === decision.base_revision));
  const decidedIds = new Set(validDecisions.map((decision) => decision.signal_id ?? decision.inbox_id));
  const remaining = queueItems.filter((item) => !decidedIds.has(item.id));
  const current = remaining[0];
  const next = remaining[1];
  const prediction = useMemo(() => current ? predictInboxRoute(current, situations) : undefined, [current, situations]);

  function decide(interested: boolean) {
    if (!current || !prediction || current.revision === undefined || validDecisions.length >= 20 || busy) return;
    setDecisions([...validDecisions, {
      origin: current.origin ?? "canonical",
      ...(current.origin === "signal" ? { signal_id: current.signalId ?? current.id } : { inbox_id: current.id }),
      base_revision: current.revision as number,
      interested,
      ...(interested && prediction.situationId ? { situation_id: prediction.situationId } : {}),
      system_group: prediction.group,
      classification_confidence: prediction.confidence,
      classification_reason: prediction.reason,
    }]);
    setDragX(0);
    pointerDelta.current = 0;
    pointerOrigin.current = null;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (busy) return;
    pointerOrigin.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    if (pointerOrigin.current === null) return;
    const nextDelta = Math.max(-180, Math.min(180, event.clientX - pointerOrigin.current));
    pointerDelta.current = nextDelta;
    setDragX(nextDelta);
  }

  function handlePointerEnd() {
    if (Math.abs(pointerDelta.current) >= 90) decide(pointerDelta.current > 0);
    else setDragX(0);
    pointerDelta.current = 0;
    pointerOrigin.current = null;
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.currentTarget !== event.target) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      decide(false);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      decide(true);
    }
  }

  return (
    <div className="live-view">
      <SectionHeading kicker="02 / INBOX" title="快速判斷：我有沒有興趣？" detail="你只做興趣判斷；IntelOS 預測 Domain／Situation。Inbox 永遠不會自動建立 Mission。" />
      <div className="live-inbox-summary"><span>{remaining.length}</span><p>{sensorQueue.length ? "Telegram Sensor 候選" : "等待興趣分流"}</p><i /><small>左滑沒興趣 · 右滑有興趣 · ←／→ 鍵也能操作</small></div>

      {current && prediction ? (
        <section className="live-swipe-workspace" aria-label="Inbox 興趣分流">
          <div className="live-swipe-stage">
            {next && <article className="live-swipe-card is-next" aria-hidden="true"><span>{next.sourceLabel}</span><h3>{next.title}</h3></article>}
            <article
              className={`live-swipe-card is-current ${dragX < -35 ? "is-rejecting" : dragX > 35 ? "is-accepting" : ""}`}
              style={{ transform: `translateX(${dragX}px) rotate(${dragX / 24}deg)` }}
              tabIndex={0}
              onKeyDown={handleKeyDown}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
            >
              <div className="live-swipe-verdict is-no">沒興趣</div>
              <div className="live-swipe-verdict is-yes">有興趣</div>
              <header>
                <div><span>{current.sourceType}</span><strong>{current.sourceLabel}</strong></div>
                <time>{displayDate(current.observedAt)}</time>
              </header>
              <div className="live-swipe-tags"><b>{current.evidenceStatus.replaceAll("_", " ")}</b><span>{current.domain}</span><span>原文 · {languageLabel(current.sourceLanguage)}</span></div>
              {current.origin === "signal" && (
                <div className="live-sensor-ribbon">
                  <span>{current.signalStatus?.replaceAll("_", " ")}</span>
                  <strong>Signal {current.signalScore}</strong>
                  <small>{current.independentSourceCount} 獨立來源 · {current.mentionCount} 次提及 · {current.velocityLabel}</small>
                </div>
              )}
              <h2>{current.title}</h2>
              <LocalizedInboxSummary key={current.id} item={current} />
              <InboxDecisionContext item={current} />
              <div className="live-route-prediction">
                <div><span>INTELOS PREDICTS</span><strong>{prediction.situationTitle ?? prediction.group}</strong></div>
                <b>{prediction.confidence}%</b>
                <p>{prediction.situationTitle ? `${prediction.group} → ${prediction.situationTitle}` : `${prediction.group} → Watch`}</p>
                <small>{prediction.reason}</small>
              </div>
              {sourceLink(current.source)}
            </article>
          </div>
          <div className="live-swipe-actions" aria-label={`${current.title} 興趣判斷`}>
            <button type="button" className="is-no" disabled={busy || current.revision === undefined} onClick={() => decide(false)}><span>←</span> 沒興趣</button>
            <button type="button" className="is-undo" disabled={busy || validDecisions.length === 0} onClick={() => setDecisions(validDecisions.slice(0, -1))}>↶ 復原</button>
            <button type="button" className="is-yes" disabled={busy || current.revision === undefined} onClick={() => decide(true)}>有興趣 <span>→</span></button>
          </div>
        </section>
      ) : validDecisions.length ? (
        <QuietState title="這一批已判斷完成" detail="先預覽 IntelOS 的歸類結果，確認後才會正式寫入。" />
      ) : <QuietState title="Inbox 已清空" detail="新的來源會先在此等待你判斷是否有興趣。" />}

      {validDecisions.length > 0 && (
        <aside className="live-swipe-batch" aria-live="polite">
          <div><span>UNSAVED SWIPES</span><strong>{validDecisions.length} / 20</strong><small>有興趣 {validDecisions.filter((decision) => decision.interested).length} · 沒興趣 {validDecisions.filter((decision) => !decision.interested).length}</small></div>
            <button type="button" disabled={busy} onClick={() => void onSwipeBatch(validDecisions)}>預覽並儲存 {validDecisions.length} 筆</button>
        </aside>
      )}

      {verificationItems.length > 0 && (
        <section className="live-verification-queue">
          <div className="live-subhead"><div><span>VERIFICATION QUEUE</span><h3>Wiki S0–S8 待確認</h3></div><b>{verificationItems.length}</b></div>
          {verificationItems.map((item) => {
            const ready = item.sourceType === "wiki_read_only" && item.source?.href.startsWith("obsidian:") && Boolean(item.contentHash);
            return <article key={item.id}>
              <div><span>{item.sourceLabel}</span><strong>{item.title}</strong><small>{ready ? "URI 與 SHA-256 可供核對" : "缺少可驗證的 Wiki URI 或 SHA-256"}</small></div>
              <button disabled={busy || !ready} onClick={() => void onPreview(
                "inbox.complete_wiki_ingest",
                `確認 S0–S8 完成：${item.title}`,
                { inbox_id: item.id, source_uri: item.source?.href, source_hash: item.contentHash },
              )}>確認 S0–S8 已完成</button>
            </article>;
          })}
        </section>
      )}
    </div>
  );
}

function pullbackStateTone(state: string) {
  const normalized = state.toLocaleLowerCase();
  if (normalized.includes("unavailable") || normalized.includes("unknown") || normalized.includes("stale")) return "is-unavailable";
  if (normalized.includes("trigger") || normalized.includes("confirm") || normalized.includes("ready")) return "is-triggered";
  return "is-watch";
}

function PullbackDecisionPanel({ situation }: { situation: Situation }) {
  if (!situation.dipBuyingIndicators.length) return null;
  const chart = situation.chart;

  if (!situation.materialChange) {
    return (
      <section className="live-pullback-dormant" data-pullback-panel="dormant" aria-label="中期回調決策面板目前休眠">
        <i aria-hidden="true" />
        <div>
          <span>MID-TERM PULLBACK MONITOR · DORMANT</span>
          <h3>八項回調條件保持監看</h3>
          <p>目前沒有使用者已接受的實質變化，因此不展開指標卡、不形成抄底結論，也不自動建立 Mission。</p>
        </div>
        <small>CHART · {chart?.state.toUpperCase() ?? "UNAVAILABLE"} · AS OF {chart?.asOf ?? "—"}</small>
      </section>
    );
  }

  return (
    <section className="live-pullback-decision-panel" data-pullback-panel="prominent" aria-label="中期回調決策面板已觸發人工複核">
      <header>
        <div>
          <span>ACCEPTED MATERIAL CHANGE</span>
          <h3>MID-TERM PULLBACK DECISION PANEL</h3>
          <p>已接受的實質變化使八項條件進入顯眼複核；這是人工判斷入口，不是交易訊號。</p>
        </div>
        <strong>HUMAN REVIEW</strong>
      </header>

      <div className="live-pullback-guardrails" aria-label="決策護欄">
        <span>多證據族群交叉驗證</span>
        <span>需人工判斷</span>
        <span>不自動建立 Mission</span>
      </div>

      <div className="live-pullback-availability">
        <span>INDICATOR AVAILABILITY</span>
        <small>資料可用性逐卡顯示；不合併為總分</small>
      </div>
      <div className="live-pullback-grid">
        {situation.dipBuyingIndicators.map((indicator) => (
          <article className={pullbackStateTone(indicator.state)} key={indicator.id}>
            <h4>{indicator.label}</h4>
            <dl>
              <div><dt>STATE</dt><dd>{indicator.state}</dd></div>
              <div><dt>AS OF</dt><dd>{indicator.asOf}</dd></div>
              <div><dt>VALUE</dt><dd>{indicator.value ?? "—"}</dd></div>
              <div><dt>REASON</dt><dd>{indicator.reason}</dd></div>
            </dl>
          </article>
        ))}
      </div>

      <article className={`live-pullback-chart-status ${pullbackStateTone(chart?.state ?? "unavailable")}`}>
        <div><span>CHART STATUS</span><h4>{chart?.label ?? "TradingView 多指標圖表"}</h4></div>
        <dl>
          <div><dt>STATE</dt><dd>{chart?.state ?? "unavailable"}</dd></div>
          <div><dt>AS OF</dt><dd>{chart?.asOf ?? "—"}</dd></div>
          <div><dt>VALUE</dt><dd>{chart?.value ?? "—"}</dd></div>
          <div><dt>REASON</dt><dd>{chart?.reason ?? "Situation 尚未提供圖表。"}</dd></div>
        </dl>
      </article>

      <footer>人工決策支援 · 非投資建議 · 非自動交易訊號 · 不自動建立 Mission</footer>
    </section>
  );
}

function evidenceView(item: Evidence): EvidenceView {
  const verified = item.evidenceStatus === "verified" && item.s0S8State === "completed";
  if (item.sourceInboxId && !verified) return "pending";
  return item.kind;
}

function EvidencePanel({
  evidence,
  inbox,
  onQueueIngest,
  onDraftAdjustment,
}: {
  evidence: Evidence[];
  inbox: InboxItem[];
  onQueueIngest: (item: InboxItem) => void;
  onDraftAdjustment: () => void;
}) {
  const [filter, setFilter] = useState<EvidenceView | "all">("all");
  const order: EvidenceView[] = ["contradiction", "pending", "inference", "known", "unknown"];
  const counts = Object.fromEntries(order.map((kind) => [kind, evidence.filter((item) => evidenceView(item) === kind).length])) as Record<EvidenceView, number>;
  const visible = evidence
    .filter((item) => filter === "all" || evidenceView(item) === filter)
    .sort((left, right) => order.indexOf(evidenceView(left)) - order.indexOf(evidenceView(right)));

  return (
    <section className="live-evidence-section">
      <div className="live-subhead">
        <div><span>EVIDENCE LEDGER</span><h3>證據與待驗證線索</h3><p>待驗證代表已收到來源，但尚未完成 Wiki S0–S8；真正不知道的問題才放在「待回答」。</p></div>
        <button onClick={onDraftAdjustment}>草擬調整</button>
      </div>

      {counts.pending > 0 && (
        <div className="live-verification-gate">
          <span aria-hidden="true">↳</span>
          <div><strong>{counts.pending} 筆來源已連結，尚未成為 Known</strong><p>Link Situation 只建立關聯。完成來源整理與驗證前，它們不會改寫正式判斷。</p></div>
        </div>
      )}

      <div className="live-evidence-summary" aria-label="證據分類篩選">
        <button type="button" aria-pressed={filter === "all"} className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}><span>全部</span><strong>{evidence.length}</strong></button>
        {order.map((kind) => <button type="button" key={kind} aria-pressed={filter === kind} className={`${filter === kind ? "is-active" : ""} is-${kind}`} onClick={() => setFilter(kind)}><span>{evidenceViewMeta[kind].label}</span><strong>{counts[kind]}</strong></button>)}
      </div>

      <div className="live-evidence-list">
        {visible.length ? visible.map((item) => {
          const view = evidenceView(item);
          const sourceInbox = item.sourceInboxId ? inbox.find((candidate) => candidate.id === item.sourceInboxId) : undefined;
          return (
            <article key={item.id} className={`is-${view}`}>
              <div className="live-evidence-kind"><span>{evidenceViewMeta[view].label}</span><small>{evidenceViewMeta[view].helper}</small></div>
              <div className="live-evidence-copy">
                <h4>{item.sourceTitle ?? item.text}</h4>
                {item.sourceTitle && item.sourceTitle !== item.text && <p>{item.text}</p>}
                <div className="live-evidence-meta">
                  {item.evidenceStatus && <span>{item.evidenceStatus.replaceAll("_", " ")}</span>}
                  {view === "pending" && <span>{item.s0S8State === "completed" ? "S0–S8 completed" : "S0–S8 尚未完成"}</span>}
                  {(item.asOf || item.observedAt) && <span>AS OF {displayDate(item.asOf ?? item.observedAt)}</span>}
                  {sourceLink(item.source)}
                </div>
              </div>
              {view === "pending" && sourceInbox && (
                <div className="live-evidence-action">
                  {sourceInbox.status === "linked" ? <button type="button" onClick={() => onQueueIngest(sourceInbox)}>加入 Wiki 整理待辦</button> : <span>{sourceInbox.status === "wiki_ingest_pending" ? "已加入來源整理" : "保持待驗證"}</span>}
                </div>
              )}
            </article>
          );
        }) : <div className="live-evidence-empty"><strong>這個分類目前沒有項目</strong><p>空分類不再佔據大面積卡片。</p></div>}
      </div>
    </section>
  );
}

function ScenarioPathAnalysis({ situation, onEdit }: { situation: Situation; onEdit: () => void }) {
  const total = situation.scenarioPaths.reduce((sum, path) => sum + path.probability, 0);
  return (
    <section className="live-scenario-analysis" aria-label="模擬情境路徑與機率">
      <header>
        <div><span>FORECAST LEDGER · USER CONFIRMED</span><h3>接下來可能怎麼走？</h3><p>機率是目前證據下的決策權重，不是預言；命中 trigger 或 invalidation 時重新校準。</p></div>
        <div><strong>{situation.scenarioPaths.length ? `${total}%` : "—"}</strong><small>{situation.scenarioPaths.length ? "HEURISTIC" : "NOT SET"}</small><button type="button" onClick={onEdit}>{situation.scenarioPaths.length ? "重新校準" : "建立三路徑"}</button></div>
      </header>
      {situation.scenarioPaths.length ? <div className="live-scenario-grid">
        {situation.scenarioPaths.map((path, index) => (
          <article className={`is-${path.tone}`} key={path.id}>
            <div className="live-scenario-rank"><span>0{index + 1}</span><b>{path.probability}%</b></div>
            <h4>{path.label}</h4>
            <p>{path.summary}</p>
            <div className="live-scenario-bar" aria-label={`${path.probability}%`}><i style={{ width: `${path.probability}%` }} /></div>
            <dl>
              <div><dt>TRIGGER</dt><dd>{path.trigger}</dd></div>
              <div><dt>DECISION IMPACT</dt><dd>{path.implication}</dd></div>
              <div><dt>INVALID IF</dt><dd>{path.invalidation}</dd></div>
            </dl>
          </article>
        ))}
      </div> : <div className="fi-empty is-warning"><span>NO FABRICATED ODDS</span><strong>尚未有使用者確認的路徑機率</strong><p>建立 Base、Upside 與 Downside 三條路徑後，系統才會在新訊號出現時提出機率變化預覽。</p></div>}
      <footer><span>預測期限</span><strong>{displayDate(situation.forecastHorizon ?? situation.nextReview)}</strong><small>少於 20 個可比事件時只標示 heuristic pressure</small></footer>
    </section>
  );
}

function SituationsView({
  situations,
  missions,
  inbox,
  selected,
  onSelect,
  truflationOpen,
  onToggleTruflation,
  truflationDate,
  truflationValue,
  onTruflationDate,
  onTruflationValue,
  onSubmitTruflation,
  onPreview,
  onOpenWorkflow,
}: {
  situations: Situation[];
  missions: Mission[];
  inbox: InboxItem[];
  selected?: Situation;
  onSelect: (id: string) => void;
  truflationOpen: boolean;
  onToggleTruflation: () => void;
  truflationDate: string;
  truflationValue: string;
  onTruflationDate: (value: string) => void;
  onTruflationValue: (value: string) => void;
  onSubmitTruflation: (event: FormEvent<HTMLFormElement>) => void;
  onPreview: (command: string, label: string, payload: Record<string, unknown>) => Promise<void>;
  onOpenWorkflow: (state: WorkflowDialogState) => void;
}) {
  if (!selected) return <QuietState title="尚未建立 Situation" detail="先從 Inbox 建立一個可持續追蹤的問題。" />;
  const domainKey = selected.domain.toLocaleLowerCase();
  const relatedMissions = missions.filter((mission) => mission.situationId === selected.id);
  return (
    <div className="live-view">
      <SectionHeading kicker="03 / SITUATIONS" title="世界發生了什麼改變？" detail="跨來源、跨時間維持同一個問題的狀態。" />
      <div className="live-situation-tabs" role="tablist" aria-label="Situation 清單">
        {situations.map((situation) => <button role="tab" aria-selected={situation.id === selected.id} className={situation.id === selected.id ? "is-active" : ""} key={situation.id} onClick={() => onSelect(situation.id)}><span>{situation.domain}</span><strong>{situation.title}</strong><small>{situation.status} · {situation.confidence}%</small></button>)}
      </div>

      <article className="live-situation-hero">
        <div className="live-situation-title"><div><span>{selected.domain} / {selected.status}</span><h2>{selected.title}</h2></div><div><small>CONFIDENCE</small><strong>{selected.confidence}</strong></div></div>
        <p>{selected.currentAssessment}</p>
        <div className="live-assessment-change"><section><span>BEFORE</span><p>{selected.before}</p></section><i aria-hidden="true">→</i><section><span>NOW</span><p>{selected.now}</p></section></div>
      </article>

      <ScenarioPathAnalysis situation={selected} onEdit={() => onOpenWorkflow({ kind: "forecast_update", situation: selected })} />

      {domainKey === "macro" && (
        <section className="live-macro-panel">
          <div className="live-subhead"><div><span>MACRO SNAPSHOTS</span><h3>通膨觀察值</h3><p>先看來源、單位與日期；至少兩期同單位資料後才繪製趨勢。</p></div><button onClick={onToggleTruflation}>{truflationOpen ? "收起輸入" : "＋ 手動記錄 Truflation"}</button></div>
          {selected.indicatorSeries.length ? (
            <div className="live-series-chart" aria-label="通膨指標最新觀察值">
              {selected.indicatorSeries.map((series) => (
                <article key={`${series.label}-${series.asOf}`} className={`${series.status.includes("manual") ? "is-alternative" : ""} ${typeof series.value === "number" ? "has-value" : "is-unavailable"}`}>
                  <header><span>{series.label}</span><b>{series.status.replaceAll("_", " ")}</b></header>
                  <div><strong>{typeof series.value === "number" ? series.value : "—"}</strong><span>{typeof series.value === "number" ? series.unit : "資料不可用"}</span></div>
                  <footer><span>AS OF</span><time>{displayDate(series.asOf)}</time></footer>
                </article>
              ))}
            </div>
          ) : <QuietState title="尚無可比較的通膨觀察值" detail="完成 BLS／BEA 同步或手動輸入 Truflation 後才繪圖；目前不以裝飾線條冒充數據。" />}
          <p className="live-chart-note">BLS CPI index 不會被當成 % YoY；未驗證 observation 只作為待驗證線索，不會自行改寫 Situation 判斷。</p>
          {truflationOpen && <form className="live-truflation-form" onSubmit={onSubmitTruflation}>
            <label><span>As-of date</span><input type="date" value={truflationDate} onChange={(event) => onTruflationDate(event.target.value)} required /></label>
            <label><span>US inflation rate · % YoY</span><input type="number" step="0.01" inputMode="decimal" value={truflationValue} onChange={(event) => onTruflationValue(event.target.value)} placeholder="例如 2.45" required /></label>
            <div><a href="https://truflation.com/marketplace/us-inflation-rate" target="_blank" rel="noreferrer">先開啟官方頁核對 ↗</a><button type="submit">預覽寫入</button></div>
            <small>將標示為 manual_snapshot／unverified_external；不會單獨建立 Mission。</small>
          </form>}
        </section>
      )}

      {domainKey === "finance" && (
        <section className="live-sector-panel">
          <div className="live-subhead"><div><h3>Sector-first finance panel</h3><span>個股只在持倉、Watchlist 或明確資料內展開</span></div><a href="/replay">打開技術雷達 Replay ↗</a></div>
          {selected.sectorGroups.length ? <div className="live-sector-map">
            {selected.sectorGroups.map((sector) => <article key={sector.name}><span>{sector.state}</span><h4>{sector.name}</h4><p>{sector.note}</p>{sector.members.length > 0 && <small>{sector.members.join(" · ")}</small>}<i /></article>)}
          </div> : <QuietState title="尚無板塊觀察資料" detail="只有持倉、Watchlist 或明確提供的族群資料才會展開；系統不自動填入陌生個股。" />}
          <p className="live-chart-note">中期回調條件以獨立觀察值呈現；不合併為單一抄底分數。</p>
        </section>
      )}

      {domainKey === "finance" && <PullbackDecisionPanel situation={selected} />}

      <EvidencePanel
        key={selected.id}
        evidence={selected.evidence}
        inbox={inbox}
        onQueueIngest={(item) => void onPreview("inbox.send_to_wiki_ingest", `加入 Wiki 整理待辦：${item.title}`, { inbox_id: item.id })}
        onDraftAdjustment={() => onOpenWorkflow({ kind: "situation_adjustment", situation: selected })}
      />

      <div className="live-situation-bottom">
        <section className="live-watch-card"><h3>Control conditions</h3><dl><div><dt>WATCH</dt><dd>{selected.watchCondition}</dd></div><div><dt>STOP</dt><dd>{selected.stopCondition}</dd></div><div><dt>REOPEN</dt><dd>{selected.reopenCondition}</dd></div><div><dt>NEXT REVIEW</dt><dd>{selected.nextReview}</dd></div></dl></section>
        <section className="live-timeline"><h3>Evidence timeline</h3>{selected.timeline.length ? selected.timeline.map((point) => <article key={point.id}><i className={`is-${point.status}`} /><span>{point.date}</span><div><strong>{point.label}</strong><p>{point.detail}</p></div></article>) : <QuietState title="尚無時間線" detail="第一筆可追溯證據進入後開始累積。" />}</section>
      </div>
      <section className="live-related-missions">
        <div className="live-subhead"><h3>Related Missions</h3><span>{relatedMissions.length}</span></div>
        {relatedMissions.length ? relatedMissions.map((mission) => <article key={mission.id}><div><span>{mission.status}</span><strong>{mission.title}</strong></div><p>{mission.nextAction}</p><small>Review · {mission.reviewDate}</small></article>) : <QuietState title="目前沒有關聯 Mission" detail="Situation 可以保持 Watch／No Action；只有需要行動時才建立 Mission。" />}
      </section>
    </div>
  );
}

function MissionsView({ missions, situations, onOpenWorkflow }: { missions: Mission[]; situations: Situation[]; onOpenWorkflow: (state: WorkflowDialogState) => void }) {
  return (
    <div className="live-view">
      <SectionHeading kicker="04 / MISSIONS" title="把情報變成下一個行動" detail="每個 Mission 只有一個 Next action；Agent 只能草擬調整。" action={<button className="live-primary-action" onClick={() => onOpenWorkflow({ kind: "create_mission", situation: situations[0] })}>＋ 建立 Mission</button>} />
      {missions.length ? <div className="live-mission-grid">{missions.map((mission) => <article key={mission.id} className={`is-${mission.status}`}>
        <header><div><span>{mission.domain}</span><b>{mission.status}</b></div><h2>{mission.title}</h2></header>
        <dl><div><dt>OBJECTIVE</dt><dd>{mission.objective}</dd></div><div><dt>WHY NOW</dt><dd>{mission.whyNow}</dd></div></dl>
        <section><span>NEXT ACTION</span><strong>{mission.nextAction}</strong></section>
        <dl><div><dt>DONE WHEN</dt><dd>{mission.doneCondition}</dd></div><div><dt>STOP／REOPEN</dt><dd>{mission.stopCondition}</dd></div></dl>
        <footer><span>Review · {mission.reviewDate}</span><div><button onClick={() => onOpenWorkflow({ kind: "record_result", mission })}>記錄結果</button><button onClick={() => onOpenWorkflow({ kind: "mission_adjustment", mission })}>草擬調整</button><button onClick={() => onOpenWorkflow({ kind: "create_review", mission })}>Review</button></div></footer>
      </article>)}</div> : <QuietState title="目前沒有 Mission" detail="有決策價值的 Situation 才值得建立任務。" />}
    </div>
  );
}

function ReviewView({ reviews, missions, onOpenWorkflow }: { reviews: Review[]; missions: Mission[]; onOpenWorkflow: (state: WorkflowDialogState) => void }) {
  return (
    <div className="live-view">
      <SectionHeading kicker="05 / REVIEW" title="結果如何改變下一輪判斷？" detail="保留錯誤模型與 No Change，不把 Review 當績效裝飾。" />
      <div className="live-review-loop" aria-label="Action Control Loop"><span>Evidence</span><i>→</i><span>Situation</span><i>→</i><span>Mission</span><i>→</i><span>Action</span><i>→</i><strong>Review</strong><i>↺</i></div>
      {reviews.length ? <div className="live-review-list">{reviews.map((review) => <article key={review.id}><div><span>{review.date}</span><strong>{review.missionTitle}</strong></div><dl><div><dt>OUTCOME</dt><dd>{review.outcome}</dd></div><div><dt>ASSESSMENT CHANGE</dt><dd>{review.assessmentChange}</dd></div><div><dt>NEXT STATE</dt><dd>{review.nextState}</dd></div></dl></article>)}</div> : (
        <section className="live-review-empty"><span>NO COMPLETED LOOP YET</span><h2>第一個 Review 應該回答「我們學到了什麼」</h2><p>完成 Mission 行動後，比較原本假設、實際結果與新的 Situation 狀態。若沒有實質改變，也正式記錄 No Change。</p><div>{missions.slice(0, 3).map((mission) => <button key={mission.id} onClick={() => onOpenWorkflow({ kind: "create_review", mission })}>Review · {mission.title}</button>)}</div></section>
      )}
    </div>
  );
}
