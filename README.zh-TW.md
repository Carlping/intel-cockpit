# IntelOS Cockpit

**本機優先的情報決策台：把雜訊般的外部資料流轉成帶 provenance 的證據，並在「必須由人決定」的那一步停下來。**

[English](README.md) · 繁體中文（本檔）

---

## 這是什麼

IntelOS Cockpit 會收進官方統計發布、法規申報、市場反應資料，以及使用者明確轉傳的
Telegram 訊息，依**速度**與**可信度**分流，最後呈現為同一條 `Fact → Context → Reaction`
lineage。每個主張都帶有來源、vintage 與驗證狀態。沒有經過人類明確確認的東西，不會變成決策。

它**不是**新聞首頁、投資顧問、自動交易機器人，也不是彭博終端機的複製品。它只跑在一台
電腦上，固定監聽 `127.0.0.1:4173`，沒有任何對外部署的執行實例。

## 為什麼做這個

這個 repo 是一個工程主張的實作證據：個人指揮 AI agent，可以做出一條**認識論**與管線本身
一樣被仔細設計的資料流。所以真正值得看的不是圖表，而是那些限制：

- **Provenance 是結構，不是裝飾。** `fact_state` 與 `impact_state` 是分開的欄位；同一原始
  頻道的轉傳不算第二個獨立來源；缺失的觀測值就保持缺失，不會變成 `0`。
- **只有人類是決策權威。** Agent 可以草擬，但不能修改 objective、宣告 Mission 完成、把外部
  內容升級成 `Known`、改動機率，或觸發交易。
- **失敗一律 fail closed。** 未設定的路徑、不可靠的解析、缺少的憑證、損壞的 canonical 檔案，
  都會讓流程停下並說明原因，而不是吐出一個看起來合理的數字。
- **規格就放在 repo 裡。** [`docs/`](docs/) 收錄各階段計畫、實作報告與驗收證據，也包含誠實
  記載「哪些問題還沒解決」的威脅模型。

## 架構概觀

```text
  external streams              ingest & classification          human loop             canonical state
┌────────────────────┐        ┌───────────────────────┐      ┌────────────────┐      ┌──────────────────┐
│ SEC EDGAR          │        │ Inbox                 │      │ swipe triage   │      │ <INTEL_ROOT>     │
│ FRED / BLS / BEA   │ fixed  │  unverified_external  │      │ confirm intent │      │  Situation       │
│ Treasury / CISA    │ egress │ S0–S8 ingest checks   │      │ set path %     │      │  Mission         │
│ Alpaca (IEX proxy) │ allow- │ fact_state            │      │ accept diff    │      │  Review          │
│ Telegram (opt-in)  │ list   │ impact_state          │      │                │      │  Forecast Ledger │
└────────────────────┘   ───▶ └──────────┬────────────┘ ───▶ └────────────────┘ ───▶ └──────────────────┘
                                         ▲                                            CAS + WAL + atomic
                              ┌──────────┴─────────┐                                  rename + read-back
                              │ <VAULT_ROOT>\wiki  │                                  Markdown = truth
                              │ read-only evidence │
                              └────────────────────┘
```

| 區域 | 角色 | 規則 |
| --- | --- | --- |
| `<VAULT_ROOT>\wiki` | Source Wiki | 唯讀；只作證據與背景知識來源 |
| `<INTEL_ROOT>` | Canonical intelligence | 唯一正式寫入區 |
| `%LOCALAPPDATA%\IntelOS` | Runtime | Queue、checkpoint、WAL、加密 Telegram raw、cache、quarantine、recovery；禁止放在 OneDrive |
| 本機設定的永久排除區 | 私人區 | 永不讀取、搜尋、索引、引用或寫入 |

`<INTEL_ROOT>` 的 Markdown 是正式狀態；runtime 永遠不是第二份資料真相。所有正式寫入都經過
preview → `base_revision` CAS → WAL → 原子 rename → read-back validation。

## 證據閉環

`Fact → Context → Reaction` 面板刻意讓三欄取自三種不同性質的證據，任何一欄缺失都會明示
incomplete reason：

- **Fact — SEC EDGAR**：監看 Alphabet、Tesla、TSMC ADR、ASML 的 allowlisted filings。第一次
  同步只建立 accession baseline，不把舊 filing 當成新警報回放。
- **Context — FRED**：`DFF`、`DGS2`、`DGS10`、`T10YIE`、`DTWEXBGS`、`NFCI`，同時保存 observation
  date 與 realtime vintage。
- **Reaction — Alpaca**：IEX WebSocket 只被視為**部分**即時 proxy。事件滿 15 分鐘後，historical
  bars 優先使用 delayed SIP，權限不足時明確降級為 IEX，並保存 window、feed、coverage、SPY
  benchmark 與 abnormal return。

相關 endpoint：`GET /api/v2/now`、`/api/v2/event-windows`、`/api/v2/signals/:id`、
`/api/v2/sources/performance`、`/api/v2/evidence-loop`，以及 `/api/v2/stream`（SSE）。既有 v1
API 保持相容。設計與分階段驗收見
[`docs/FACT_CONTEXT_REACTION_DASHBOARD_PLAN_2026-08-20.md`](docs/FACT_CONTEXT_REACTION_DASHBOARD_PLAN_2026-08-20.md)。

## 程式強制執行的決策邊界

- 單一 Telegram 訊息不能進 `Known`、不能建立 Mission、不能改動情境機率、不能觸發交易——不論
  它看起來多可信。
- 規則解析器無法可靠抽出 actual／forecast／previous 時，只回覆「無法可靠提取」，不猜數字。
- `Path Map` 拒絕生成 domain 預設機率：使用者必須建立三條合計 100% 的路徑並確認 diff；可比
  事件少於 20 個時一律標示 `heuristic`。
- `Forecast Ledger` 記錄每次路徑、期限、結果與 Brier score，讓系統自身的校準可被回頭審計。
- Truflation 為 manual-only。API flag 關閉或回傳 401／403／429 時，系統**不會**改去爬網頁。
- TTS 在沒有可靠引擎時保持 `unavailable`，不假裝已有音檔。

## 安全性

完整分析見 [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)；回報方式見 [`SECURITY.md`](SECURITY.md)。

程式強制執行的部分：canonical 寫入邊界；runtime containment 並拒絕 symlink、junction 與
reparse point；拒絕把 runtime 放在 OneDrive；每次寫入都有 CAS + WAL + read-back；每個 response
的 CSP nonce 與 `frame-ancestors 'none'`；靜態資源 path traversal 防護；固定的 outbound domain
allowlist（不接受使用者指定的 fetch 目標）；憑證只透過 Windows CurrentUser DPAPI 保存於
`%LOCALAPPDATA%\IntelOS\secrets`，不進 `localStorage`、`.env` 或 log；以及所有會改變狀態的
`/api` 請求都必須帶合法且相符的 `Origin`。

誠實說明尚未解決的部分：localhost API **沒有身分驗證**，任何以同一 OS 使用者身分執行的行程
都能驅動它。曾考慮 local token 檔案但刻意不做——同一個行程照樣讀得到那個 token，只會增加儀式
感而不會多出邊界。Telegram 採 long polling，電腦關機期間不會收集；系統會標示 `coverage_gap`，
不會宣稱資料完整。

## 第一次啟動

需求：Windows、Node.js `>=22.13.0`、npm，以及本機已存在的 Obsidian Vault。

```powershell
cd "<CHECKOUT>"
Copy-Item intel-os.config.example.json intel-os.config.json
# 填入這台機器的 vaultRoot、intelRoot 與 excludedSegments。
npm install
npm run build
npm run test:unit
```

`intel-os.config.json` 不進版控。`INTEL_OS_VAULT_ROOT`、`INTEL_OS_WIKI_ROOT`、`INTEL_OS_ROOT`、
`INTEL_OS_RUNTIME_ROOT`、`INTEL_OS_EXCLUDED_SEGMENTS` 可覆寫檔案設定，環境變數優先。在 Vault
根目錄、正式 intelligence 根目錄與永久排除區設定完成前，工具會**拒絕執行**。

Alpha 初始資料先在隔離環境預覽，不會寫入目標 Vault：

```powershell
npm run seed:alpha         # 預覽：新增、補齊、跳過、阻塞
npm run seed:alpha:apply   # 明確執行，且只允許寫入 <INTEL_ROOT>
```

Seed 可重複執行：既有且有效的 entity 一律視為使用者所有並跳過，不會被範本覆蓋，Situation 也
不會被捏造 `Known` 證據。若發現舊版、不完整、雜湊錯誤或其他損壞的 canonical 檔，seed 會 fail
closed 並要求人工 recovery，而不是直接改寫 raw Markdown。

Routing migration 必須明確提供本機 playbook URI，缺少參數時 fail closed：

```powershell
node scripts/migrate-alpha-v1.1-routing.mjs --playbook-uri "<LOCAL_PLAYBOOK_URI>"
node scripts/migrate-alpha-v1.1-routing.mjs --apply --playbook-uri "<LOCAL_PLAYBOOK_URI>"
```

最後以 `npm run local`（或內附的 `.cmd` 啟動器）啟動本機介面，開啟
[http://127.0.0.1:4173/](http://127.0.0.1:4173/)。關閉命令視窗即停止 collectors 與 UI。
`npm run start` 只提供既有 build，不會重新建置。

### Telegram（選用）

請建立**專用 Bot**且不給 admin 權限。只用私聊 explicit submit 時可保持 Privacy Mode ON；只有
選用的私人群組 Sensor 才需要關閉 Group Privacy，而後端仍只保存 allowlisted chat。BotFather
token 只能輸入 localhost 設定畫面——不要貼到聊天、Vault 筆記、`.env`、Git、URL 或截圖。後端
驗證 `getMe` 後即以 DPAPI 封存。

允許的投稿只有 `/intel`、回覆 Bot，以及明確轉傳到 Bot 私聊的內容；全部視為 untrusted data，
其中的 prompt、URL 與交易指令一律不執行。群組訊息只進 DPAPI 加密的 Sensor Queue（raw ≤24 小時、
候選事件 ≤72 小時），且需每位成員 `/consent`；手機端可用 `/pause`、`/resume`、`/revoke`、
`/forget <message_id>`、`/forgetme`。

## 驗證

```powershell
npm run lint
npm run build
npm run test:unit   # build 必須先跑：rendered-HTML 測試會 import dist/
npm test
```

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）在每次 push 與 pull request 執行
lint、build 與 unit suite，另有 non-blocking 的 `npm audit --audit-level=high`；Dependabot 每週
提出分組更新。請注意 runtime 是 Windows-only：CI 驗證的是與平台無關的邏輯，不含 DPAPI 或
Task Scheduler 路徑。

每日維護（`node scripts/run-intelos-daily-maintenance.mjs`）刻意保守：只清除已過期的 preview、
超過 7 天且已進入終態的 WAL（`prepared`、執行中與 `recovery_conflict` 永遠保留），以及超過
14 天、`committed` 且無 failure 的 recovery snapshot。任何 symlink、junction 或 reparse escape
都會讓該次清理在刪除任何東西之前中止。

## 目前非目標

不提供投資建議、不自動下單、不做自動交易 Mission。不爬 Telegram 公開群組或頻道歷史、不爬
Truflation、不自動下載附件。不含 PineScript 與自動 TradingView 截圖。不做多租戶、不做雲端
部署、不提供公開 demo 實例。

## 授權

[MIT](LICENSE) — Copyright (c) 2026 Carlping。
