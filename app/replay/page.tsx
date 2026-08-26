"use client";

import { useEffect, useMemo, useState } from "react";

type Tone = "support" | "challenge" | "mixed" | "neutral";
type Priority = "P0" | "P1";
type MobileView = "brief" | "timeline" | "thesis" | "decide";

type SourceRef = {
  label: string;
  path: string;
};

type EventItem = {
  id: string;
  step: number;
  date: string;
  time: string;
  priority: Priority;
  domain: string;
  ticker: string;
  title: string;
  whatChanged: string;
  tone: Tone;
  confidence: number;
  known: string[];
  inference: string[];
  unknown: string[];
  causalChain: string[];
  impacts: Array<{
    thesisId: string;
    tone: Tone;
    label: string;
  }>;
  source: SourceRef;
};

type ThesisState = {
  step: number;
  confidence: number;
  status: "active" | "watch" | "challenged";
  change: number;
  reason: string;
};

type Thesis = {
  id: string;
  short: string;
  title: string;
  horizon: string;
  invalidation: string;
  history: ThesisState[];
  source: SourceRef;
};

type Decision = {
  id: string;
  step: number;
  eventIds: string[];
  priority: Priority;
  title: string;
  question: string;
  action: "research" | "wait" | "no_action";
  actionLabel: string;
  rationale: string;
  decisionBy?: string;
  reviewAt: string;
  reopen: string[];
  source: SourceRef;
};

type PullbackPhase = "setup" | "capitulation" | "confirmation";
type PullbackSignalState = "met" | "watch" | "unmet" | "missing";

type PullbackSignal = {
  id: string;
  phase: PullbackPhase;
  label: string;
  value: string;
  rule: string;
  scope: "US／NDX" | "美股" | "台股";
  role: "主市場" | "外溢背景";
  independenceGroup: string;
  state: PullbackSignalState;
  note: string;
};

const INTEL_VAULT = "<INTEL_ROOT>";
const LAST_STEP = 5;

const steps = [
  { id: "T0", date: "07/14", label: "基準線", note: "建立初始論點" },
  { id: "T1", date: "07/15", label: "ASML", note: "設備需求分化" },
  { id: "T2", date: "07/16", label: "TSM", note: "需求強、毛利承壓" },
  { id: "T3", date: "07/22", label: "CPO", note: "商用化訊號衝突" },
  { id: "T4", date: "07/23", label: "GOOG", note: "AI CAPEX 再確認" },
  { id: "T5", date: "07/24", label: "TSLA", note: "執行風險升高" },
];

const pullbackPhaseMeta: Array<{
  id: PullbackPhase;
  index: string;
  title: string;
  subtitle: string;
  status: string;
}> = [
  {
    id: "setup",
    index: "A",
    title: "估值與超賣",
    subtitle: "SETUP",
    status: "條件集中",
  },
  {
    id: "capitulation",
    index: "B",
    title: "恐慌與去槓桿",
    subtitle: "CAPITULATION",
    status: "恐慌候選",
  },
  {
    id: "confirmation",
    index: "C",
    title: "結構反轉",
    subtitle: "CONFIRMATION",
    status: "等待突破",
  },
];

const pullbackStateLabels: Record<PullbackSignalState, string> = {
  met: "已觸發",
  watch: "觀察中",
  unmet: "未觸發",
  missing: "缺資料",
};

const pullbackRadar = {
  active: true,
  triggerStep: 5,
  regime: "mid_term_pullback",
  dataMode: "simulation",
  asOf: "2026-07-24",
  market: "US",
  benchmark: "Nasdaq-100",
  phase: "REVERSAL WATCH",
  title: "中期回調：抄底條件進入觀察區",
  summary:
    "估值、恐慌與價格確認是三個獨立證據家族，不把八項條件當成八票。超賣與恐慌已集中，但價格結構尚未完成右側確認。",
  decisionGate: "WAIT｜等待高點突破",
  blockedBy: "模擬規則：待收盤突破前高",
  thesisGate: "未接入基本面失效檢查",
  signals: [
    {
      id: "valuation-cheap",
      phase: "setup" as PullbackPhase,
      label: "估值到便宜位置",
      value: "歷史分位 18%",
      rule: "進入策略便宜區（門檻待回測）",
      scope: "US／NDX" as const,
      role: "主市場" as const,
      independenceGroup: "valuation",
      state: "met" as PullbackSignalState,
      note: "需依指數／產業使用不同估值基準。",
    },
    {
      id: "sentiment-low",
      phase: "setup" as PullbackPhase,
      label: "市場情緒過低",
      value: "情緒合成 −1.8σ",
      rule: "低於策略極端區",
      scope: "US／NDX" as const,
      role: "主市場" as const,
      independenceGroup: "panic_oversold",
      state: "met" as PullbackSignalState,
      note: "情緒極端只能證明壓力，不代表反轉。",
    },
    {
      id: "weekly-kdjj",
      phase: "setup" as PullbackPhase,
      label: "週線 KDJ.J ≤ 0",
      value: "J = −4.2",
      rule: "週線 J 值 ≤ 0",
      scope: "US／NDX" as const,
      role: "主市場" as const,
      independenceGroup: "panic_oversold",
      state: "met" as PullbackSignalState,
      note: "依原始清單保留週線作為主要週期。",
    },
    {
      id: "leveraged-etf-volume",
      phase: "capitulation" as PullbackPhase,
      label: "QLD／TQQQ 日或週爆量",
      value: "TQQQ 量比 2.1×",
      rule: "相對自身基準量能異常放大",
      scope: "美股" as const,
      role: "主市場" as const,
      independenceGroup: "panic_oversold",
      state: "met" as PullbackSignalState,
      note: "只作美股恐慌代理，不套用到台股。",
    },
    {
      id: "volatility-high",
      phase: "capitulation" as PullbackPhase,
      label: "VIX／VXN 過高",
      value: "34／38",
      rule: "高於各自策略門檻",
      scope: "美股" as const,
      role: "主市場" as const,
      independenceGroup: "panic_oversold",
      state: "met" as PullbackSignalState,
      note: "需同時檢查期限結構，不能只看現貨點位。",
    },
    {
      id: "margin-balance-low",
      phase: "capitulation" as PullbackPhase,
      label: "融資餘額過低",
      value: "較近三月高點 −12%",
      rule: "進入市場自身低分位",
      scope: "台股" as const,
      role: "外溢背景" as const,
      independenceGroup: "tw_margin_deleveraging",
      state: "met" as PullbackSignalState,
      note: "台股外溢背景；不計入 US／NDX 決策閘門。",
    },
    {
      id: "maintenance-ratio-low",
      phase: "capitulation" as PullbackPhase,
      label: "融資維持率過低",
      value: "132%",
      rule: "接近策略壓力門檻",
      scope: "台股" as const,
      role: "外溢背景" as const,
      independenceGroup: "tw_margin_deleveraging",
      state: "watch" as PullbackSignalState,
      note: "台股外溢背景；資料定義與發布頻率需在正式接流前固定。",
    },
    {
      id: "market-structure",
      phase: "confirmation" as PullbackPhase,
      label: "低點更高＋高點更高",
      value: "低點已墊高；高點未突破",
      rule: "模擬定義：低點墊高且收盤突破前高（待回測）",
      scope: "US／NDX" as const,
      role: "主市場" as const,
      independenceGroup: "price_confirmation",
      state: "watch" as PullbackSignalState,
      note: "這是右側確認，不能由超賣訊號替代。",
    },
  ] satisfies PullbackSignal[],
};

const events: EventItem[] = [
  {
    id: "asml-q2",
    step: 1,
    date: "2026-07-15",
    time: "09:10 ET",
    priority: "P1",
    domain: "半導體設備",
    ticker: "ASML",
    title: "ASML 指引與 EUV 產能上修",
    whatChanged:
      "設備端支持 AI 建置週期，但來源內仍有營收年增率與幣別衝突，正式決策前需要回到公司一手資料核對。",
    tone: "support",
    confidence: 65,
    known: [
      "2Q26 營收 93.27 億歐元、毛利率 54.0%、GAAP EPS €7.58",
      "3Q26 營收指引 110–120 億歐元、毛利率 55–57%",
      "2026 全年營收指引由 360–400 億歐元上修至 430–450 億歐元",
      "2027–2028 年 Low-NA EUV 產能規劃每年增加 30%",
    ],
    inference: [
      "五大 WFE 客戶 2026–2028 可能進入採購上修週期",
      "Intel 可能在 2026–2027 擴大 High-NA EUV 下單",
    ],
    unknown: [
      "來源內營收年增率 13%／21% 不一致",
      "3Q 指引一處幣別疑似誤植，需回到公司一手資料核對",
    ],
    causalChain: ["EUV 指引上修", "先進製程產能擴張", "WFE 採購預期提高", "等待一手驗證"],
    impacts: [
      { thesisId: "ai-capex", tone: "support", label: "核心需求未破壞" },
      { thesisId: "tsm-margin", tone: "neutral", label: "暫無直接改變" },
    ],
    source: {
      label: "事件筆記 · ASML Q2",
      path: "情報系統/events/evt_20260715_asml_q2.md",
    },
  },
  {
    id: "tsm-q2",
    step: 2,
    date: "2026-07-16",
    time: "08:35 ET",
    priority: "P0",
    domain: "晶圓代工",
    ticker: "TSM",
    title: "TSM CAPEX 上修與毛利率壓力",
    whatChanged:
      "同一筆訊號以 CAPEX 上修支持 AI 設備鏈，同時以毛利率低於模型挑戰 TSM 毛利論點。",
    tone: "mixed",
    confidence: 70,
    known: [
      "2026 CAPEX 指引由 560 億美元上修至 600–640 億美元",
      "2Q26 毛利率 67.7%，低於作者模型 69%",
      "3Q26 毛利率指引 65–67%",
      "HPC 營收占比 66%，2nm 首次貢獻 3%",
    ],
    inference: [
      "作者認為估值驅動可能由 EPS 加倍數擴張，降為主要依賴 EPS",
      "Intel 18A 良率與客戶名單屬未確認 channel check",
    ],
    unknown: [
      "下一季實際 N2 毛利率稀釋幅度",
      "定價能否抵銷 N2 與海外廠折舊",
      "當時估值是否已反映上述風險",
    ],
    causalChain: [
      "AI 需求支持 CAPEX",
      "設備鏈研究優先級提高",
      "N2／海外折舊增加",
      "毛利論點受挑戰",
    ],
    impacts: [
      { thesisId: "ai-capex", tone: "support", label: "需求確認，信心上修" },
      { thesisId: "tsm-margin", tone: "challenge", label: "成本壓力，信心下修" },
    ],
    source: {
      label: "事件筆記 · TSM Q2",
      path: "情報系統/events/evt_20260716_tsm_q2.md",
    },
  },
  {
    id: "cpo-chain",
    step: 3,
    date: "2026-07-22",
    time: "10:20 ET",
    priority: "P0",
    domain: "光通訊",
    ticker: "CPO",
    title: "CPO 外置雷射與量產時程衝突",
    whatChanged:
      "外置光源架構支持長期供應鏈角色，但不同來源對商用化與量產時程沒有共識。",
    tone: "mixed",
    confidence: 55,
    known: [
      "外置 CW Laser 有利於更換、散熱與多通道供光",
      "報導描述 FAU 負責把光接入、光源由光通訊業者提供",
      "NPO 可沿用現有可插拔設計，短期量產較務實",
      "報導指出 CPO 小規模導入與早期期待仍有落差",
    ],
    inference: [
      "外置架構支持 LITE／COHR 類光源供應鏈角色，但不等於收入已確認",
      "『COUPE 正式量產』與 Vault 既有保守時程判斷存在衝突",
    ],
    unknown: [
      "明確客戶、量產平台、出貨量與收入開始時間",
      "外置雷射供應商的 design win 與毛利貢獻",
      "不同來源對 Broadcom／台積電方案時程何時收斂",
    ],
    causalChain: ["頻寬／散熱限制", "外置光源架構", "供應鏈角色擴大", "量產時程待交叉確認"],
    impacts: [
      { thesisId: "cpo-adoption", tone: "mixed", label: "方向支持、時點衝突" },
      { thesisId: "ai-capex", tone: "support", label: "網路瓶頸佐證建置需求" },
    ],
    source: {
      label: "事件筆記 · CPO chain",
      path: "情報系統/events/evt_20260722_cpo_chain.md",
    },
  },
  {
    id: "goog-q2",
    step: 4,
    date: "2026-07-23",
    time: "09:05 ET",
    priority: "P1",
    domain: "雲端／平台",
    ticker: "GOOG",
    title: "GOOG AI CAPEX 與 FCF 轉負",
    whatChanged:
      "需求端與資本支出端互相驗證，但投資回收速度成為下一個必須追蹤的變數。",
    tone: "mixed",
    confidence: 70,
    known: [
      "GCP 年增 82%，營業利益率 35.6%",
      "2026 CAPEX 指引由 1,800–1,900 億美元上修至 1,950–2,050 億美元",
      "2Q26 CAPEX 449 億美元，來源稱約 60% 用於 AI 伺服器",
      "管理層表示 2027 年 CAPEX 仍將顯著擴張",
      "2Q26 FCF 約為負 5,900 萬美元",
    ],
    inference: [
      "作者將五大 CSP 2027 CAPEX 年增預估由 30% 上修至 38%",
      "TPU 供應商分工與遠期出貨多含作者模型／channel check",
    ],
    unknown: ["高 CAPEX 何時轉為可持續 FCF 與股東回報", "TPU 供應商實際份額與出貨量"],
    causalChain: ["GCP 需求增長", "AI 伺服器投入", "CAPEX 上修", "FCF 代價浮現"],
    impacts: [
      { thesisId: "ai-capex", tone: "support", label: "跨來源確認，信心上修" },
      { thesisId: "cpo-adoption", tone: "support", label: "網路升級需求獲支持" },
    ],
    source: {
      label: "事件筆記 · GOOG Q2",
      path: "情報系統/events/evt_20260723_goog_q2.md",
    },
  },
  {
    id: "tsla-q2",
    step: 5,
    date: "2026-07-24",
    time: "08:50 ET",
    priority: "P1",
    domain: "電動車／自動駕駛",
    ticker: "TSLA",
    title: "TSLA 交車強但執行與 FCF 仍弱",
    whatChanged:
      "新增訊號沒有形成可執行優勢；進攻型並不等於每個高波動題材都必須出手。",
    tone: "challenge",
    confidence: 65,
    known: [
      "交車 481,260 輛、年增 25%",
      "營收 282.36 億美元、non-GAAP EPS $0.33",
      "整體毛利率 16.8%、營業利益率 1.4%",
      "FSD 活躍訂閱 150 萬、年增 56%；北美新車採用率 55%",
      "2026 CAPEX 維持超過 250 億美元",
      "本季未提供 Robotaxi 營收指引",
    ],
    inference: [
      "來源模型預期 FCF 至少到 2027 年仍為負",
      "Terafab 可能採用 Intel 14A 是作者推論",
      "不具相對 S&P 500 Alpha 是研究判斷",
    ],
    unknown: [
      "Robotaxi／FSD／Optimus 的可重複收入與單位經濟",
      "無監督 FSD 的監管與規模化節點",
      "新業務何時能改善整體毛利率與 FCF",
    ],
    causalChain: ["交車增長", "低毛利／高 CAPEX", "FCF 可見度偏低", "保留選擇權"],
    impacts: [
      { thesisId: "tsla-execution", tone: "challenge", label: "可驗證性下降" },
    ],
    source: {
      label: "事件筆記 · TSLA Q2",
      path: "情報系統/events/evt_20260724_tsla_q2.md",
    },
  },
];

const theses: Thesis[] = [
  {
    id: "ai-capex",
    short: "AI CAPEX",
    title: "AI 基礎設施投資週期延續，但價值捕獲將分化",
    horizon: "6–18 個月",
    invalidation: "三家以上大型雲端商連續下修 AI 資本支出",
    history: [
      { step: 0, confidence: 66, status: "active", change: 0, reason: "基準線" },
      { step: 1, confidence: 69, status: "active", change: 3, reason: "ASML 先進製程需求未破壞" },
      { step: 2, confidence: 76, status: "active", change: 7, reason: "TSM 需求端再確認" },
      { step: 3, confidence: 78, status: "active", change: 2, reason: "網路瓶頸支持持續建置" },
      { step: 4, confidence: 82, status: "active", change: 4, reason: "GOOG CAPEX 與需求交叉確認" },
      { step: 5, confidence: 82, status: "active", change: 0, reason: "本事件無直接改變" },
    ],
    source: { label: "論點筆記", path: "情報系統/theses/th_ai_capex.md" },
  },
  {
    id: "tsm-margin",
    short: "TSM 毛利",
    title: "先進製程組合改善可抵銷海外廠成本稀釋",
    horizon: "2–6 季",
    invalidation: "毛利率連續兩季落在既定壓力情境以下",
    history: [
      { step: 0, confidence: 72, status: "active", change: 0, reason: "基準線" },
      { step: 1, confidence: 72, status: "active", change: 0, reason: "設備訊號中性" },
      { step: 2, confidence: 55, status: "challenged", change: -17, reason: "海外成本稀釋的持續性上升" },
      { step: 3, confidence: 55, status: "challenged", change: 0, reason: "本事件無直接改變" },
      { step: 4, confidence: 55, status: "challenged", change: 0, reason: "本事件無直接改變" },
      { step: 5, confidence: 55, status: "challenged", change: 0, reason: "本事件無直接改變" },
    ],
    source: { label: "論點筆記", path: "情報系統/theses/th_tsm_margin.md" },
  },
  {
    id: "cpo-adoption",
    short: "CPO 採用",
    title: "CPO 將由技術選項轉為 AI 網路的規模化架構",
    horizon: "12–36 個月",
    invalidation: "主要平台延後兩個產品週期且供應鏈設計活動轉弱",
    history: [
      { step: 0, confidence: 54, status: "watch", change: 0, reason: "基準線" },
      { step: 1, confidence: 54, status: "watch", change: 0, reason: "本事件無直接改變" },
      { step: 2, confidence: 56, status: "watch", change: 2, reason: "先進封裝瓶頸提供間接支持" },
      { step: 3, confidence: 58, status: "challenged", change: 2, reason: "方向增強，但量產證據衝突" },
      { step: 4, confidence: 58, status: "challenged", change: 0, reason: "本事件無直接改變" },
      { step: 5, confidence: 58, status: "challenged", change: 0, reason: "本事件無直接改變" },
    ],
    source: { label: "論點筆記", path: "情報系統/theses/th_cpo_adoption.md" },
  },
  {
    id: "tsla-execution",
    short: "TSLA 執行",
    title: "產品與軟體選項可在合理期限內轉為可驗證現金流",
    horizon: "6–24 個月",
    invalidation: "核心產品節奏再度延後，且單位經濟持續惡化",
    history: [
      { step: 0, confidence: 57, status: "watch", change: 0, reason: "基準線" },
      { step: 1, confidence: 57, status: "watch", change: 0, reason: "本事件無直接改變" },
      { step: 2, confidence: 57, status: "watch", change: 0, reason: "本事件無直接改變" },
      { step: 3, confidence: 57, status: "watch", change: 0, reason: "本事件無直接改變" },
      { step: 4, confidence: 57, status: "watch", change: 0, reason: "本事件無直接改變" },
      { step: 5, confidence: 30, status: "challenged", change: -27, reason: "驗證週期拉長、執行風險升高" },
    ],
    source: { label: "論點筆記", path: "情報系統/theses/th_tsla_execution.md" },
  },
];

const decisions: Decision[] = [
  {
    id: "wfe-research",
    step: 2,
    eventIds: ["tsm-q2", "goog-q2"],
    priority: "P0",
    title: "重做 WFE 受益排序",
    question: "要不要因 AI 需求強勁而直接提高半導體設備曝險？",
    action: "research",
    actionLabel: "研究，不立即交易",
    rationale: "需求方向被支持，但 ASML 與 TSM 顯示價值捕獲分化；先拆解節點、客戶與估值。",
    decisionBy: "2026-07-31",
    reviewAt: "2026-08-15",
    reopen: ["設備訂單廣度回升", "先進封裝瓶頸改善", "估值進入既定區間"],
    source: { label: "決策筆記", path: "情報系統/decisions/dec_wfe_research.md" },
  },
  {
    id: "cpo-wait",
    step: 3,
    eventIds: ["cpo-chain"],
    priority: "P0",
    title: "CPO 等待驗證",
    question: "供應鏈設計活動升溫，是否足以建立主題部位？",
    action: "wait",
    actionLabel: "等待，不追逐",
    rationale: "方向正面但量產時點衝突；先等客戶、良率或營收三者至少一項被驗證。",
    reviewAt: "2026-09-30",
    reopen: ["主要客戶正式揭露", "量產良率跨過門檻", "供應商收入開始可追蹤"],
    source: { label: "決策筆記", path: "情報系統/decisions/dec_cpo_wait.md" },
  },
  {
    id: "tsla-no-action",
    step: 5,
    eventIds: ["tsla-q2"],
    priority: "P1",
    title: "TSLA 不行動",
    question: "高波動是否本身構成進攻型投資機會？",
    action: "no_action",
    actionLabel: "不行動，保留選擇權",
    rationale: "現有資訊沒有縮小結果分布；在可驗證性改善前，波動不是資訊優勢。",
    reviewAt: "2026-10-25",
    reopen: ["產品節奏被數據驗證", "單位經濟改善", "風險報酬進入預設區間"],
    source: { label: "決策筆記", path: "情報系統/decisions/dec_tsla_no_action.md" },
  },
];

const toneLabels: Record<Tone, string> = {
  support: "支持",
  challenge: "挑戰",
  mixed: "混合",
  neutral: "中性",
};

const statusLabels: Record<ThesisState["status"], string> = {
  active: "成立",
  watch: "觀察",
  challenged: "受挑戰",
};

function obsidianUrl(source: SourceRef) {
  const file = source.path.replace(/\.md$/i, "");
  return `obsidian://open?vault=${encodeURIComponent(INTEL_VAULT)}&file=${encodeURIComponent(file)}`;
}

function thesisAtStep(thesis: Thesis, step: number) {
  return (
    [...thesis.history].reverse().find((item) => item.step <= step) ??
    thesis.history[0]
  );
}

function changeLabel(value: number) {
  if (value > 0) return `+${value}`;
  return `${value}`;
}

export default function ReplayPage() {
  const [currentStep, setCurrentStep] = useState(2);
  const [selectedEventId, setSelectedEventId] = useState("tsm-q2");
  const [priorityFilter, setPriorityFilter] = useState<"ALL" | Priority>("ALL");
  const [domainFilter, setDomainFilter] = useState("ALL");
  const [playing, setPlaying] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("brief");
  const [decisionStates, setDecisionStates] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [pullbackExpanded, setPullbackExpanded] = useState(true);
  const pullbackActive =
    pullbackRadar.active && currentStep >= pullbackRadar.triggerStep;

  const domains = useMemo(
    () => Array.from(new Set(events.map((event) => event.domain))),
    [],
  );

  const visibleEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          event.step <= currentStep &&
          (priorityFilter === "ALL" || event.priority === priorityFilter) &&
          (domainFilter === "ALL" || event.domain === domainFilter),
      ),
    [currentStep, priorityFilter, domainFilter],
  );

  const selectedEvent =
    visibleEvents.find((event) => event.id === selectedEventId) ??
    visibleEvents[visibleEvents.length - 1] ??
    null;

  const focusStep = selectedEvent?.step ?? currentStep;

  const activeDecision = selectedEvent
    ? [...decisions]
        .reverse()
        .find(
          (decision) =>
            decision.step <= currentStep && decision.eventIds.includes(selectedEvent.id),
        ) ?? null
    : null;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = window.localStorage.getItem("intel-cockpit-decisions");
        if (saved) setDecisionStates(JSON.parse(saved));
      } catch {
        // The interface remains fully usable when browser storage is unavailable.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const latest = visibleEvents[visibleEvents.length - 1];
    const frame = window.requestAnimationFrame(() => setSelectedEventId(latest?.id ?? ""));
    return () => window.cancelAnimationFrame(frame);
  }, [visibleEvents]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setCurrentStep((step) => {
        if (step >= LAST_STEP) {
          setPlaying(false);
          return step;
        }
        return step + 1;
      });
    }, 1800);
    return () => window.clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    if (!pullbackActive) return;
    const frame = window.requestAnimationFrame(() => setPullbackExpanded(true));
    return () => window.cancelAnimationFrame(frame);
  }, [pullbackActive]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        setPlaying(false);
        setCurrentStep((step) => Math.max(0, step - 1));
      }
      if (event.key === "ArrowRight") {
        setPlaying(false);
        setCurrentStep((step) => Math.min(LAST_STEP, step + 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function selectStep(step: number) {
    setPlaying(false);
    setCurrentStep(step);
  }

  function saveDecision(decision: Decision, state: string) {
    const next = { ...decisionStates, [decision.id]: state };
    setDecisionStates(next);
    try {
      window.localStorage.setItem("intel-cockpit-decisions", JSON.stringify(next));
    } catch {
      // Local persistence is an enhancement, not a blocker.
    }
  }

  async function copySource(source: SourceRef) {
    try {
      await navigator.clipboard.writeText(source.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            IO
          </div>
          <div>
            <p className="eyebrow">INTEL OS / DECISION LAYER</p>
            <h1>情報決策台</h1>
          </div>
        </div>

        <div className="status-strip" aria-label="資料狀態">
          <span className="status-dot" />
          <span>歷史重播</span>
          <span className="separator">·</span>
          <span>非即時</span>
          <span className="separator">·</span>
          <span>截至 2026-07-24</span>
        </div>

        <a
          className="open-vault"
          href={obsidianUrl({
            label: "情報系統首頁",
            path: "情報系統/00_command_center.md",
          })}
        >
          開啟 Obsidian <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="replay-bar" aria-label="歷史重播控制">
        <div className="replay-label">
          <span className="live-chip">SIM</span>
          <div>
            <strong>{steps[currentStep].id}</strong>
            <span>{steps[currentStep].label}</span>
          </div>
        </div>

        <div className="replay-track">
          {steps.map((step, index) => (
            <button
              className={`track-step ${index === currentStep ? "is-active" : ""} ${index < currentStep ? "is-past" : ""}`}
              key={step.id}
              onClick={() => selectStep(index)}
              aria-label={`跳到 ${step.id} ${step.label}`}
              aria-current={index === currentStep ? "step" : undefined}
            >
              <span className="track-node">{index}</span>
              <span className="track-copy">
                <strong>{step.id}</strong>
                <small>{step.date}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="replay-actions">
          <button
            className="icon-button"
            onClick={() => selectStep(Math.max(0, currentStep - 1))}
            disabled={currentStep === 0}
            aria-label="上一步"
          >
            ←
          </button>
          <button
            className="play-button"
            onClick={() => {
              if (currentStep === LAST_STEP) setCurrentStep(0);
              setPlaying((value) => !value);
            }}
          >
            <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>
            {playing ? "暫停" : "播放"}
          </button>
          <button
            className="icon-button"
            onClick={() => selectStep(Math.min(LAST_STEP, currentStep + 1))}
            disabled={currentStep === LAST_STEP}
            aria-label="下一步"
          >
            →
          </button>
        </div>
      </section>

      {pullbackRadar.active && !pullbackActive && (
        <section
          className="pullback-standby"
          aria-labelledby="pullback-standby-title"
          aria-live="polite"
        >
          <div>
            <span className="standby-state">RADAR STANDBY</span>
            <h2 id="pullback-standby-title">中期回調雷達：休眠</h2>
            <p>目前重播尚未進入中期回調情境；八項判斷不提前曝光，避免把未來資料帶回 T{currentStep}。</p>
          </div>
          <button type="button" onClick={() => selectStep(pullbackRadar.triggerStep)}>
            跳到 T5 模擬觸發 <span aria-hidden="true">→</span>
          </button>
        </section>
      )}

      {pullbackActive && (
        <section
          className={`pullback-radar ${pullbackExpanded ? "is-expanded" : "is-collapsed"}`}
          data-mode={pullbackRadar.dataMode}
          data-regime={pullbackRadar.regime}
          aria-labelledby="pullback-radar-title"
          aria-live="polite"
        >
          <div className="pullback-beacon" aria-hidden="true">
            <span>!</span>
            <strong>PULLBACK</strong>
            <small>ACTIVE</small>
          </div>

          <div className="pullback-content">
            <div className="pullback-heading">
              <div className="pullback-title-block">
                <div className="pullback-flags">
                  <span className="regime-chip">REGIME ACTIVE</span>
                  <span>{pullbackRadar.market}／{pullbackRadar.benchmark}</span>
                  <span>{pullbackRadar.decisionGate}</span>
                  <span>SHADOW／模擬觸發</span>
                  <span>AS OF {pullbackRadar.asOf}</span>
                </div>
                <p className="section-kicker">STRATEGY RADAR / MID-TERM PULLBACK</p>
                <h2 id="pullback-radar-title">{pullbackRadar.title}</h2>
                <p>{pullbackRadar.summary}</p>
              </div>
              <button
                className="pullback-toggle"
                type="button"
                aria-expanded={pullbackExpanded}
                aria-controls="pullback-radar-details"
                onClick={() => setPullbackExpanded((value) => !value)}
              >
                {pullbackExpanded ? "收合指標" : "展開 8 項指標"}
                <span aria-hidden="true">{pullbackExpanded ? "−" : "+"}</span>
              </button>
            </div>

            <div className="pullback-scoreboard" aria-label="抄底條件摘要">
              <div>
                <span>CURRENT PHASE</span>
                <strong className="phase-watch">WATCH</strong>
                <em>{pullbackRadar.phase}</em>
              </div>
              <div>
                <span>BLOCKED BY</span>
                <strong className="gate-wait">HH</strong>
                <em>{pullbackRadar.blockedBy}</em>
              </div>
              <div>
                <span>THESIS GATE</span>
                <strong className="gate-blocked">BLOCKED</strong>
                <em>{pullbackRadar.thesisGate}</em>
              </div>
              <div>
                <span>DATA QUALITY</span>
                <strong className="mode-sim">SIM</strong>
                <em>門檻尚待回測</em>
              </div>
            </div>

            <div
              id="pullback-radar-details"
              hidden={!pullbackExpanded}
              aria-hidden={!pullbackExpanded}
            >
                <div className="pullback-phases">
                  {pullbackPhaseMeta.map((phase) => {
                    const phaseSignals = pullbackRadar.signals.filter(
                      (signal) => signal.phase === phase.id,
                    );
                    return (
                      <section className={`pullback-phase phase-${phase.id}`} key={phase.id}>
                        <header>
                          <span className="phase-index">{phase.index}</span>
                          <div>
                            <p>{phase.subtitle}</p>
                            <h3>{phase.title}</h3>
                          </div>
                          <span className="phase-status">
                            {phase.status}
                          </span>
                        </header>

                        <div className="pullback-signal-list">
                          {phaseSignals.map((signal) => (
                            <article
                              className={`pullback-signal signal-${signal.state}`}
                              key={signal.id}
                            >
                              <div className="signal-topline">
                                <span className={`signal-state state-${signal.state}`}>
                                  {pullbackStateLabels[signal.state]}
                                </span>
                                <span className="signal-scope">{signal.scope}</span>
                                <span className={`signal-role role-${signal.role === "主市場" ? "primary" : "context"}`}>
                                  {signal.role}
                                </span>
                              </div>
                              <h4>{signal.label}</h4>
                              <strong>{signal.value}</strong>
                              <p>{signal.rule}</p>
                              <small>{signal.note}</small>
                            </article>
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>

                <div className="pullback-warning">
                  <strong>判讀邊界</strong>
                  <p>
                    八項指標不是八張獨立選票；情緒、VIX／VXN、爆量、融資與 KDJ 存在重疊。Setup 與 Confirmation 不互相替代，美股／台股不混成總分；正式接入前需用 point-in-time 資料分市場回測，並排除 look-ahead bias。
                  </p>
                  <span>非自動交易訊號</span>
                </div>
              </div>
          </div>
        </section>
      )}

      <div className="cockpit" data-mobile-view={mobileView}>
        <aside className="panel timeline-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">01 / SIGNALS</p>
              <h2>事件時間軸</h2>
            </div>
            <span className="count-badge">{visibleEvents.length}</span>
          </div>

          <div className="filters">
            <div className="segmented" aria-label="優先級篩選">
              {(["ALL", "P0", "P1"] as const).map((value) => (
                <button
                  key={value}
                  className={priorityFilter === value ? "is-selected" : ""}
                  onClick={() => setPriorityFilter(value)}
                >
                  {value === "ALL" ? "全部" : value}
                </button>
              ))}
            </div>
            <label className="select-wrap">
              <span className="sr-only">領域篩選</span>
              <select value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)}>
                <option value="ALL">所有領域</option>
                {domains.map((domain) => (
                  <option key={domain} value={domain}>
                    {domain}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="event-list">
            {visibleEvents.length > 0 ? (
              visibleEvents.map((event) => (
                <button
                  key={event.id}
                  className={`event-row tone-${event.tone} ${selectedEvent?.id === event.id ? "is-selected" : ""}`}
                  onClick={() => {
                    setSelectedEventId(event.id);
                    setMobileView("brief");
                  }}
                >
                  <span className="event-rail" />
                  <span className="event-meta">
                    <span>{event.date.slice(5)}</span>
                    <span>{event.time}</span>
                  </span>
                  <span className="event-body">
                    <span className="event-tags">
                      <b className={`priority priority-${event.priority.toLowerCase()}`}>{event.priority}</b>
                      <span>{event.ticker}</span>
                    </span>
                    <strong>{event.title}</strong>
                    <small>{event.domain}</small>
                  </span>
                </button>
              ))
            ) : (
              <div className="empty-state">
                <span>∅</span>
                <strong>目前沒有符合事件</strong>
                <button
                  onClick={() => {
                    setPriorityFilter("ALL");
                    setDomainFilter("ALL");
                  }}
                >
                  清除篩選
                </button>
              </div>
            )}
          </div>

          <div className="timeline-note">
            <span>提示</span>
            <p>使用鍵盤 ← → 或上方節點重播；未到時間點的資訊不會提前顯示。</p>
          </div>
        </aside>

        <section className="panel detail-panel">
          {selectedEvent ? (
            <>
              <div className="event-hero">
                <div className="hero-meta">
                  <span className={`priority priority-${selectedEvent.priority.toLowerCase()}`}>
                    {selectedEvent.priority}
                  </span>
                  <span>{selectedEvent.domain}</span>
                  <span>{selectedEvent.date}</span>
                  <span>{selectedEvent.time}</span>
                </div>
                <p className="section-kicker">02 / WHAT CHANGED</p>
                <h2>{selectedEvent.title}</h2>
                <p className="hero-summary">{selectedEvent.whatChanged}</p>

                <div className="hero-stats">
                  <div>
                    <span>判讀</span>
                    <strong className={`text-${selectedEvent.tone}`}>
                      {toneLabels[selectedEvent.tone]}
                    </strong>
                  </div>
                  <div>
                    <span>信心</span>
                    <strong>{selectedEvent.confidence}%</strong>
                  </div>
                  <div>
                    <span>影響論點</span>
                    <strong>{selectedEvent.impacts.length}</strong>
                  </div>
                </div>
              </div>

              <div className="truth-grid">
                <article className="truth-card known-card">
                  <div className="truth-title">
                    <span>K</span>
                    <div>
                      <p>KNOWN</p>
                      <h3>已知事實</h3>
                    </div>
                  </div>
                  <span className="source-caveat">既有研究頁轉述 · 尚未重新核對公司 IR</span>
                  <ul>
                    {selectedEvent.known.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>

                <article className="truth-card inference-card">
                  <div className="truth-title">
                    <span>I</span>
                    <div>
                      <p>INFERENCE</p>
                      <h3>合理推論</h3>
                    </div>
                  </div>
                  <ul>
                    {selectedEvent.inference.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>

                <article className="truth-card unknown-card">
                  <div className="truth-title">
                    <span>?</span>
                    <div>
                      <p>UNKNOWN</p>
                      <h3>仍未知</h3>
                    </div>
                  </div>
                  <ul>
                    {selectedEvent.unknown.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>
              </div>

              <section className="causal-section">
                <div className="section-heading-row">
                  <div>
                    <p className="section-kicker">CAUSAL CHAIN</p>
                    <h3>影響如何傳導</h3>
                  </div>
                  <span className="evidence-label">因果假設，不等於事實</span>
                </div>
                <div className="causal-flow">
                  {selectedEvent.causalChain.map((item, index) => (
                    <div className="causal-node" key={item}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{item}</strong>
                      {index < selectedEvent.causalChain.length - 1 && (
                        <i aria-hidden="true">→</i>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <section className="source-section">
                <div>
                  <p className="section-kicker">SOURCE LINEAGE</p>
                  <strong>{selectedEvent.source.label}</strong>
                  <code>{selectedEvent.source.path}</code>
                </div>
                <div className="source-actions">
                  <button onClick={() => copySource(selectedEvent.source)}>
                    {copied ? "已複製" : "複製路徑"}
                  </button>
                  <a href={obsidianUrl(selectedEvent.source)}>回到證據 ↗</a>
                </div>
              </section>
            </>
          ) : (
            <div className="empty-detail">
              <span>FILTERED</span>
              <h2>目前時間點沒有符合條件的情報</h2>
              <p>調整左側篩選，或前進到下一個歷史節點。</p>
            </div>
          )}
        </section>

        <aside className="panel thesis-panel">
          <section className="thesis-zone">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">03 / THESES</p>
                <h2>論點變化</h2>
              </div>
              <span className="as-of">AS OF {steps[focusStep].id}</span>
            </div>

            <div className="thesis-list">
              {theses.map((thesis) => {
                const state = thesisAtStep(thesis, focusStep);
                const isImpacted = selectedEvent?.impacts.some(
                  (impact) => impact.thesisId === thesis.id,
                );
                return (
                  <article
                    className={`thesis-card ${isImpacted ? "is-impacted" : ""}`}
                    key={thesis.id}
                  >
                    <div className="thesis-topline">
                      <span>{thesis.short}</span>
                      <span className={`status status-${state.status}`}>
                        {statusLabels[state.status]}
                      </span>
                    </div>
                    <h3>{thesis.title}</h3>
                    <div className="confidence-row">
                      <div className="confidence-track">
                        <span style={{ width: `${state.confidence}%` }} />
                      </div>
                      <strong>{state.confidence}</strong>
                      <span className={state.change > 0 ? "delta-up" : state.change < 0 ? "delta-down" : "delta-flat"}>
                        {changeLabel(state.change)}
                      </span>
                    </div>
                    <p className="state-reason">{state.reason}</p>
                    <details>
                      <summary>查看失效條件</summary>
                      <p>{thesis.invalidation}</p>
                      <a href={obsidianUrl(thesis.source)}>開啟論點筆記 ↗</a>
                    </details>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="decision-zone">
            <div className="decision-heading">
              <p className="section-kicker">04 / DECIDE</p>
              <h2>當下要做什麼</h2>
            </div>

            {activeDecision ? (
              <article className="decision-card">
                <div className="decision-topline">
                  <span className={`priority priority-${activeDecision.priority.toLowerCase()}`}>
                    {activeDecision.priority}
                  </span>
                  <span>{activeDecision.action}</span>
                </div>
                <h3>{activeDecision.title}</h3>
                <p className="decision-question">{activeDecision.question}</p>
                <div className="recommended-action">
                  <span>建議動作</span>
                  <strong>{activeDecision.actionLabel}</strong>
                </div>
                <div className="decision-dates">
                  {activeDecision.decisionBy && (
                    <div>
                      <span>決策期限</span>
                      <strong>{activeDecision.decisionBy}</strong>
                    </div>
                  )}
                  <div>
                    <span>重審日</span>
                    <strong>{activeDecision.reviewAt}</strong>
                  </div>
                </div>
                <p className="decision-rationale">{activeDecision.rationale}</p>

                <div className="reopen-block">
                  <span>重新打開條件</span>
                  <ul>
                    {activeDecision.reopen.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>

                <div className="decision-controls" aria-label="本機決策紀錄">
                  {["採納", "觀察", "略過"].map((state) => (
                    <button
                      key={state}
                      className={decisionStates[activeDecision.id] === state ? "is-selected" : ""}
                      onClick={() => saveDecision(activeDecision, state)}
                    >
                      {state}
                    </button>
                  ))}
                </div>
                <div className="local-note">
                  <span className="local-dot" />
                  本機模擬：只保存在這個瀏覽器，尚未寫回 Obsidian
                </div>
                <a className="decision-source" href={obsidianUrl(activeDecision.source)}>
                  開啟決策筆記 ↗
                </a>
              </article>
            ) : (
              <div className="baseline-decision">
                <span>{steps[focusStep].id}</span>
                <h3>{selectedEvent ? "尚無對應的正式決策卡" : "先建立基準線，不急著下結論"}</h3>
                <p>
                  {selectedEvent
                    ? "這筆事件先留在驗證與研究佇列，不把其他事件的決策錯接到這裡。"
                    : "新的事件進來後，再觀察哪些論點被支持、挑戰或維持不變。"}
                </p>
              </div>
            )}
          </section>
        </aside>
      </div>

      <nav className="mobile-nav" aria-label="手機版主要區域">
        {(
          [
            ["brief", "Brief", "摘要"],
            ["timeline", "Timeline", "時間軸"],
            ["thesis", "Thesis", "論點"],
            ["decide", "Decide", "決策"],
          ] as Array<[MobileView, string, string]>
        ).map(([value, label, zh]) => (
          <button
            key={value}
            className={mobileView === value ? "is-active" : ""}
            onClick={() => setMobileView(value)}
          >
            <strong>{label}</strong>
            <span>{zh}</span>
          </button>
        ))}
      </nav>

      <footer className="app-footer">
        <span>IntelOS MVP / Replay dataset v0.1</span>
        <span>模擬情報，非投資建議</span>
      </footer>
    </main>
  );
}
