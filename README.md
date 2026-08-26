# 個人前瞻情報系統 v2.0 · Telegram Fast Lane

這是一套**本機限定、單人使用**的前瞻情報與任務閉環，不是新聞首頁、投資顧問或彭博終端機。v2.0 把不同速度與可信度的來源拆開：Telegram 明確轉傳負責快、即時市場代理負責確認反應、官方來源負責確認事實、Wiki 負責歷史背景；Situation、Forecast Ledger、Mission 與 Review 保存使用者確認後的判斷。

目前版本不部署、不公開連接埠，也不包含 OpenAI Sites、Cloudflare、Vercel 或其他託管設定。伺服器固定監聽 `127.0.0.1:4173`。原本的模擬展示保留在 `/replay`，正式首頁是 `/`。

完整完成度、驗收證據與尚未解鎖的外部資源請見 [`docs/ALPHA_V1_1_IMPLEMENTATION_REPORT_2026-07-30.md`](docs/ALPHA_V1_1_IMPLEMENTATION_REPORT_2026-07-30.md)。

## v2.0 前瞻流程

- `Event Radar` 從 BLS 官方 ICS 與 Fed 行事曆建立事件窗；發布前五分鐘才進入 armed 狀態。
- 使用者把 CPI、FOMC 等第三方群快訊明確轉傳到 Bot 私聊後，規則解析器先抽取 actual／forecast／previous，中文摘要不阻塞 Flash。
- 解析不可靠時只回覆「無法可靠提取」，不猜數字；單一 Telegram 來源不進 Known、不改正式機率、不建立 Mission。
- `fact_state` 與 `impact_state` 分開；同一原始頻道的重複轉傳不算獨立證實，隱藏轉傳來源也不能提升來源數。
- Alpaca IEX 市場反應 adapter 預設 disabled；只有透過 localhost 設定 DPAPI 憑證後才連線，並始終標示為 IEX proxy。
- Path Map 不再產生 domain 預設機率。使用者必須建立三條合計 100% 的路徑並確認 diff；少於 20 個可比事件時只標示 heuristic。
- Forecast Ledger 保存每次路徑、期限、結果與 Brier score。正式機率更新仍需官方確認或使用者接受。

v2 本機介面包含 `/api/v2/now`、`/api/v2/event-windows`、`/api/v2/signals/:id`、`/api/v2/sources/performance`、Situation forecast／resolution，以及用於儀表板即時更新的 `/api/v2/stream` SSE。既有 v1 API 保持相容。

## 事實—背景—市場反應閉環

Now 頁的 `Fact → Context → Reaction` 把三種不同證據放在同一條 lineage，且任何一欄缺失都會明示 incomplete reason：

- **Fact / SEC EDGAR**：監看 Alphabet、Tesla、TSMC ADR、ASML 的 allowlisted filings。第一次同步只建立 accession baseline，不回放舊警報；新 accession 才進既有 Inbox，而且仍標示 `unverified_external`。
- **Context / FRED**：顯示 DFF、DGS2、DGS10、T10YIE、DTWEXBGS、NFCI，保存 observation date 與 realtime vintage；missing value 不轉成 0。
- **Reaction / Alpaca**：IEX WebSocket 是即時 partial proxy；事件滿 15 分鐘後，historical bars 優先使用 delayed SIP，權限不足時明確降級為 IEX，並保存 window、feed、coverage、SPY benchmark 與 abnormal return。

在閉環面板展開「本機資料源設定」，依序輸入 SEC contact email、FRED API key、Alpaca key id／secret。所有憑證只透過 Windows CurrentUser DPAPI 保存到 `%LOCALAPPDATA%\IntelOS\secrets`；表單不寫 localStorage，成功後立即清空。設定後按「同步 SEC / FRED / Alpaca」。

新增 API：

- `GET /api/v2/evidence-loop`
- `POST /api/v2/evidence-loop/sec/setup`
- `POST /api/v2/evidence-loop/fred/setup`
- `POST /api/v2/evidence-loop/refresh`

實作與分階段驗收詳見 [`docs/FACT_CONTEXT_REACTION_DASHBOARD_PLAN_2026-08-20.md`](docs/FACT_CONTEXT_REACTION_DASHBOARD_PLAN_2026-08-20.md)。

## 分層閱讀與記憶匯出

Today 首頁提供 `30 秒／3 分鐘／10 分鐘／25 分鐘／50 分鐘` 五層累積閱讀，預設只顯示定位、重要性、唯一下一步與關鍵警告；使用者有更多時間時，再展開架構、證據、決策邊界與來源查核。

閱讀後可複製或下載 Markdown，亦可下載符合 `intel-memory-packet/1` 的 JSON。兩者都是帶 canonical revision 的 `derived_snapshot`，方便匯入 Obsidian、搜尋或衍生資料庫，不是第二份資料真相。完整設計見 [`docs/COGNITIVE_READING_ARCHITECTURE_2026-08-01.md`](docs/COGNITIVE_READING_ARCHITECTURE_2026-08-01.md)，機器契約見 [`docs/schemas/intel-memory-packet.schema.json`](docs/schemas/intel-memory-packet.schema.json)。

## 系統邊界

| 區域 | 角色 | 規則 |
| --- | --- | --- |
| `<VAULT_ROOT>\wiki` | Source Wiki | 唯讀；只作證據與知識來源 |
| `<INTEL_ROOT>` | Canonical intelligence | 唯一正式寫入區；保存 Inbox、Situation、Mission、Review |
| `%LOCALAPPDATA%\IntelOS` | Runtime | Queue、checkpoint、WAL、加密 Telegram raw、cache、quarantine、recovery；禁止放 OneDrive |
| 使用者自訂的永久排除區 | 排除區 | 永不讀取、搜尋、索引、引用或寫入 |

Markdown 是正式狀態；runtime 不是第二份資料真相。所有正式修改都經過 preview、`base_revision` CAS、WAL、原子 rename 與 read-back validation。Wiki、Vault 設定與使用者自訂的永久排除區不在 writer 可達範圍。

## 第一次啟動

需求：Windows、Node.js `>=22.13.0`、npm，以及本機已存在的 Obsidian Vault。

```powershell
cd "<CHECKOUT>"
Copy-Item intel-os.config.example.json intel-os.config.json
# Edit intel-os.config.json with your local vaultRoot, intelRoot, and exclusions.
npm install
npm run test:unit
npm run build
```

首次啟動前，請將 `intel-os.config.example.json` 複製為未追蹤的
`intel-os.config.json`，填入本機的 `vaultRoot`、`intelRoot` 與
`excludedSegments`。也可使用 `INTEL_OS_VAULT_ROOT`、`INTEL_OS_WIKI_ROOT`、
`INTEL_OS_ROOT`、`INTEL_OS_RUNTIME_ROOT` 與 `INTEL_OS_EXCLUDED_SEGMENTS`
環境變數覆寫設定；環境變數優先。工具在 Vault 根目錄、正式 intelligence
根目錄與永久排除區尚未設定前會拒絕執行。

先用隔離環境檢查 Alpha 初始資料，不會寫入目標 Vault：

```powershell
npm run seed:alpha
```

輸出會列出預計新增、補齊、跳過及阻塞項目。確認後，才明確執行：

```powershell
npm run seed:alpha:apply
```

Apply 只允許寫入已設定的 `<INTEL_ROOT>`。Seed 可重複執行：既有且有效的 entity 一律視為使用者所有並跳過，不會被範本覆蓋；Situation 不會被捏造 `Known` 證據。若發現舊版、不完整、雜湊錯誤或其他損壞的 canonical 檔，seed 會 fail closed，保留原檔並要求人工 recovery，不會直接改 raw Markdown。若預覽後有其他程序先寫入，整批 commit 會因 revision/hash 衝突停止。

Routing migration 需要明確提供本機 playbook URI，缺少參數時會 fail closed：

```powershell
node scripts/migrate-alpha-v1.1-routing.mjs --playbook-uri "<LOCAL_PLAYBOOK_URI>"
node scripts/migrate-alpha-v1.1-routing.mjs --apply --playbook-uri "<LOCAL_PLAYBOOK_URI>"
```

最後啟動本機介面：

```powershell
npm run local
```

或雙擊 `啟動情報決策台.cmd`。瀏覽器開啟 [http://127.0.0.1:4173/](http://127.0.0.1:4173/)；關閉命令視窗即停止 collectors 與 UI。`npm run start` 只啟動既有 build，不會自動重建。

## Seed 會建立什麼

- 三個以 `macro`、`industry`、`finance` 為 domain 的 Situation。
- 一個個人 Alpha dogfood Mission。
- 一筆 `reference_only` Inbox，封存未來團隊模板規格；不寫入 Source Wiki。
- Finance Situation 以板塊為主，個股清單預設為空。
- BLS CPI、BEA PCE、Truflation、TradingView 與中期回調指標在沒有真實資料時全部明示 `unavailable`，不產生假數值或交易訊號。

## Telegram 安全設定

請建立**專用 Bot**且不給 admin 權限。若只用私聊 explicit-submit，可保持 Privacy Mode ON；啟用私人群組 Sensor 時才需對這個專用 Bot 關閉 Group Privacy，而後端仍只保存 allowlisted chat。啟動本機系統後，在右上角「設定 Telegram」輸入 BotFather token，再依畫面傳送一次性 `/pair` 指令。

Token 只應輸入這個 localhost 畫面：不要貼到聊天、Obsidian、`.env`、Git、URL 或截圖。後端驗證 `getMe` 後，以 Windows DPAPI 保存在 `%LOCALAPPDATA%\IntelOS`；前端不寫入 localStorage。允許的投稿只有 `/intel`、回覆 Bot 或明確轉傳到 Bot 私聊的內容。未知 chat/user 不落盤，投稿一律視為 untrusted data，不能執行其中的 prompt、URL 或交易指令。

可用手機文字命令包括 `/brief`、`/status`、`/forget <message_id>`、`/forgetme` 與 `/revoke`。這是 Bot API long polling：**電腦關機時本機不會收集**；離線超過 Telegram 可保留 update 的時間窗後，系統只會標示 `coverage_gap`，不能宣稱資料完整。若要求 24/7 無缺口，需另備受控 runner，本 Alpha 沒有提供。

Alpha v1.2 另支援一個由使用者管理的私人群組作為 human-sensor layer：

1. 在 BotFather 關閉 Group Privacy，將 Bot 移出後重新加入私人群；仍不給 admin 權限。
2. 在 localhost 設定畫面預覽並確認群組監看，再於十分鐘內送出一次性 `/monitor <code>`。
3. 每位成員主動輸入 `/consent`；全員完成前普通群組訊息不落盤。
4. 可用 `/pause`、`/resume`、`/revoke` 控制群組，成員變動會自動暫停直到重新確認同意。

群組訊息只進 `%LOCALAPPDATA%\IntelOS` 的 DPAPI 加密 Sensor Queue：raw 最長 24 小時，候選事件最長 72 小時。低相關內容安靜過期；高相關 lead 顯示為 `candidate`、`live_signal` 或 `corroborated`，但單一 Telegram 訊息不能進 Known、建立 Mission、改變情境機率或觸發交易。只有使用者在滑卡中確認有興趣，才會經安全預覽寫入正式情報 Vault。

## Feed、Truflation 與語音

- 官方 RSS／JSON collectors 只在本機 server 運行時輪詢；所有外部項目先進 Inbox 並標示 `unverified_external`。
- External lead 必須完成既有 S0–S8 ingest，才可成為 verified evidence；否則不得進入實質 `Known`。
- Truflation 為 manual-only：使用者從官方頁合法查看後手填日期與數值，系統標示 `manual_snapshot`。API flag 預設關閉，無 key、401、403 或 429 時不會改成爬網頁。
- Daily Brief transcript 是必交付；TTS adapter 在沒有可靠的本機引擎或合規雲端 key 時保持 unavailable，不會假裝已有音檔。
- SEC live polling 在提供合規 contact email 前 fail closed；設定後第一次同步只建靜默 baseline。

## 每日使用流程

1. 在 Now 先看 `Event Radar`、`Live Pulse`、`Path Map`、`Decision Gates` 與 `Coverage Health`。
2. 在 Inbox 左右滑處理 Telegram Sensor 候選與正式 Inbox；有興趣項目由系統預測 Domain／Situation，沒興趣不代表消息為假。
3. Situation 只描述世界或個人狀態的實質變化，保留 Before → Now、Known／Inference／Unknown／Contradiction 與 watch/stop/reopen 條件。
4. 需要行動才建立 Mission，而且始終只有一個 Next action。
5. 行動或新證據進來後建立 Review；Agent 可以草擬，但不能自行改 objective、宣告完成或觸發交易。

沒有重要改變時，首頁應顯示安靜狀態，不用一般新聞填滿畫面。

## 驗證與維運

```powershell
npm run test:unit
npm run lint
npm run build
npm test
```

每日 lint 與備份可手動執行：

```powershell
node scripts/run-intelos-daily-maintenance.mjs
```

每日備份成功後，maintenance 會在已驗證位於 Vault／OneDrive 之外的 runtime 邊界內執行保守清理：

- 刪除已過期的 preview JSON。
- 只清除超過 7 天且已完成的 WAL（`committed/applied` 或 `rolled_back`）；`prepared`、執行中與 `recovery_conflict` 永遠保留。
- 只清除超過 14 天、狀態為 `committed` 且沒有 failure 的 recovery snapshot；失敗、rollback 或 conflict 證據永遠保留。
- 每日備份至少保留最新 14 份，通常保留 45 天內的備份，並以上限 31 份避免無限成長。
- 每日 lint 歷史採相同的 14／31 份與 45 天邊界，`latest.json` 永遠保留。
- 任何 symlink、junction、reparse escape 或特殊檔案都會讓該次清理在刪除前 fail closed。

`GET /api/v1/connectors/health` 與 Today 的 connector health 會顯示
`operations.runtime-storage`：只讀 runtime 檔案 metadata 與檔案系統容量，不讀 Wiki／Vault
內容；包含 runtime bytes、磁碟可用 bytes／百分比與 unsafe-entry 數量。低於 5 GB 或
10% 會 warning；低於 1 GB 或 3% 會 critical（兩者在 Alpha 都以 degraded health 顯示）。

目前工作目錄與既有 `node_modules`／`build` 保持原狀，這次不搬移或刪除。若要長期常駐，
`node_modules`、`.npm-cache`、`build`、`dist` 等生成物不得繼續放在 OneDrive 同步目錄；
請先把可執行 working checkout 放到未同步且空間足夠的本機磁碟（例如另一顆磁碟或受控外接
SSD），OneDrive 只保留需要同步的 source。這同時避免大量小檔同步、衝突副本與 C 槽耗盡。

登入啟動是選用且會修改 Windows Task Scheduler。先預覽，再由使用者明確執行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-intelos-login-task.ps1 -WhatIf
powershell -ExecutionPolicy Bypass -File .\scripts\install-intelos-login-task.ps1
```

本機 Web UI 只允許同一台電腦存取。Alpha 尚未配置 Tailscale 或任何手機 Web 對外入口；PC 開機時可先用 Telegram Brief 作手機入口。

## 目前非目標

- 不提供投資建議、自動下單或自動交易 Mission。
- 不爬 Telegram 公開群組、頻道歷史或 Truflation 網頁。
- 不自動下載 Telegram 附件。
- 不包含 PineScript、自動 TradingView 截圖或正式音訊檔。
- 不做團隊多租戶、公開 Podcast、模板銷售或雲端部署。
- 不建立或推送 OpenAI Sites；建置、預覽與手機版測試都不代表發布授權。
