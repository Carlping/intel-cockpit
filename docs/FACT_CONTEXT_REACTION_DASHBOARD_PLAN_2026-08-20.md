# 事實—背景—市場反應儀表板｜總計畫與交接

日期：2026-08-20（America/New_York）
狀態：Phase 0–4 實作與驗收完成；GitHub private remote、認證與發布範圍已確認
產品邊界：local-only、單人使用、不部署、不自動交易

## 最終目標

在既有 `intel-cockpit` 的 Now 頁完成一個可追溯閉環：

1. **事實（SEC EDGAR）**：watchlist 公司出現 10-K、10-Q、8-K、20-F、6-K、Form 4 或 13F 時，建立去重、可追溯的 observation。
2. **背景（FRED）**：保留事件當下的利率、美元、通膨預期與金融條件，且保存 observation/realtime date，不用最新修訂覆蓋歷史認知。
3. **市場反應（Alpaca）**：IEX 只作即時 partial proxy；事件滿 15 分鐘後以 historical bars 回補，並把 coverage 與 fact state 分開。
4. **儀表板閉環**：同一事件能在一個畫面回答「發生什麼、背景是什麼、市場如何反應、還缺什麼」。

## 現況證據

- `app/page.tsx` 已有 Event Radar、Live Pulse、Path Map、Decision Gates 與 Coverage Health。
- `server/forward-intelligence/engine.mjs` 已把 `fact_state` 與 `impact_state` 分開。
- `server/forward-intelligence/market-adapter.mjs` 已有 credential-gated Alpaca IEX WebSocket adapter，且 coverage 標為 `iex_proxy`。
- `server/connectors/official-feeds.mjs` 已有 `sec.submissions` spec，但固定 disabled，且 JSON parser 沒有 SEC case。
- FRED 尚未有 connector。
- runtime、checkpoint、secret 與 raw 資料已有 OneDrive 外邊界與 DPAPI secret store。
- `intel-cockpit` 工作樹含大量既有未提交變更；本工作只做增量修改，不重設、不清除、不還原使用者檔案。
- 目前 branch 是 `main`，本機 repo 沒有 Git remote。最終 push 前必須取得或建立明確的 GitHub remote。

## 目標架構

```text
SEC connector ─┐
               ├─> EvidenceLoopEngine ─> /api/v2/evidence-loop ─> Now dashboard
FRED connector ┘             │
                             ├─> new SEC facts -> existing routing -> Inbox
Alpaca adapter <─ reaction jobs
```

### Runtime state

- Secret：SEC contact email、FRED API key、Alpaca key/secret，只經既有 DPAPI store。
- Derived runtime state：recent facts、macro snapshots、reaction jobs、coverage 與 checkpoints，放 `%LOCALAPPDATA%\IntelOS` 邊界。
- Canonical intelligence：仍是使用者確認後的 Markdown entity；API 資料不得直接升級為 `Known`。

## 階段與驗收

### Phase 1｜SEC 事實層

- 新增 credential-gated SEC connector、watchlist、submissions parser、節流與健康狀態。
- 初次 poll 只建 baseline；新 accession 才進 evidence loop 與既有 Inbox routing。
- API 與 UI 可在本機設定 contact email、手動 refresh。
- 單元測試覆蓋 10-Q／8-K／6-K、重啟去重、無 contact email fail closed。
- 完成後新增 `docs/FACT_CONTEXT_REACTION_PHASE_1_SEC_2026-08-20.md`。

### Phase 2｜FRED 背景層

- 新增 FRED connector、官方 series allowlist、revision-aware snapshot。
- API 與 UI 可在本機設定 API key。
- Dashboard 顯示值、delta、as-of、realtime range、coverage。
- 單元測試覆蓋 missing value、revision、429／invalid envelope。
- 完成後新增 `docs/FACT_CONTEXT_REACTION_PHASE_2_FRED_2026-08-20.md`。

### Phase 3｜Alpaca 反應層與閉環 UI

- 保留 IEX fast lane；加入 REST historical reaction backfill。
- 事件、symbol、benchmark、window、feed 與 abnormal return 有清楚 lineage。
- Now 顯示三欄閉環與 incomplete reason；market reaction 永遠不改 fact state。
- 單元、API、rendered HTML、build 與 lint 通過。
- 完成後新增 `docs/FACT_CONTEXT_REACTION_PHASE_3_DASHBOARD_2026-08-20.md`。

### Phase 4｜完成與交接

- 連續執行完整測試與 build。
- 核對不含 secrets、runtime data、OneDrive 外資料或部署設定。
- 新增 `docs/FACT_CONTEXT_REACTION_FINAL_HANDOFF_2026-08-20.md`，列出設定步驟、已知限制、驗收證據與後續工作。
- 逐檔確認 staged scope，再 commit、push 到明確 GitHub remote。

## 不做

- 不部署 OpenAI Sites、Vercel、Cloudflare 或公開入口。
- 不建立自動交易或券商下單。
- 不用新聞 feed 填滿空狀態。
- 不在沒有使用者 contact email／API key 時模擬 live data。
- 不把 IEX 稱為全市場 consolidated price。
- 不修改 Obsidian source wiki、`raw/` 或使用者自訂的永久排除區。

## 恢復工作時的第一個動作

1. 讀本文件與最近一份 Phase checkpoint。
2. 執行 `git status --short`，確認既有 dirty worktree 沒有被清理。
3. 執行已完成 Phase 的 focused tests，再開始下一 Phase。
