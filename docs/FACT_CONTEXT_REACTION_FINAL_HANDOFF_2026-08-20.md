# 事實—背景—市場反應儀表板｜Final handoff

日期：2026-08-20（America/New_York）
實作狀態：完成
測試狀態：完成

## 交付結果

Now 頁已完成 SEC facts、FRED macro context、Alpaca market reaction 的可追溯閉環。資料源沒有設定或某一段失敗時，畫面顯示缺口而不是示範 live data。完整架構與各階段證據見：

- `FACT_CONTEXT_REACTION_DASHBOARD_PLAN_2026-08-20.md`
- `FACT_CONTEXT_REACTION_PHASE_1_SEC_2026-08-20.md`
- `FACT_CONTEXT_REACTION_PHASE_2_FRED_2026-08-20.md`
- `FACT_CONTEXT_REACTION_PHASE_3_DASHBOARD_2026-08-20.md`

## 主要檔案

- `server/evidence-loop/index.mjs`：SEC/FRED connectors、baseline/dedupe、reaction jobs、projection。
- `server/forward-intelligence/market-adapter.mjs`：IEX stream + historical SIP/IEX backfill。
- `server/runtime.mjs`：DPAPI、runtime state、Inbox routing、scheduler、facade。
- `server/api/router.mjs`：v2 projection/setup/refresh routes。
- `app/page.tsx`、`app/globals.css`：閉環 dashboard、設定表單、responsive UI。
- `tests/evidence-loop.test.mjs`、`tests/evidence-loop-api.test.mjs`、`tests/forward-intelligence.test.mjs`、`tests/rendered-html.test.mjs`：focused、API、market 與 SSR coverage。

## 啟動與設定

```powershell
cd "<CHECKOUT>"
npm run local
```

開啟 `http://127.0.0.1:4173/`，到 `Fact → Context → Reaction` 展開「本機資料源設定」：

1. SEC contact email。
2. FRED API key。
3. Alpaca key id / secret。
4. 按「同步 SEC / FRED / Alpaca」。

Secret 位於 `%LOCALAPPDATA%\IntelOS\secrets` 的 DPAPI files；derived state 位於 `%LOCALAPPDATA%\IntelOS\state\fact-context-reaction.json`。兩者都在 OneDrive／Vault 外，不在 repository tracked files 中。

## 最終驗收

- `npm test`：build success，120 passed，0 failed。
- `npm run lint`：0 errors，2 pre-existing unused warnings。
- `npx tsc --noEmit`：pass。發布前已補齊 cognitive-reader 的明確型別出口、seed fixture completeness 與 Inbox prediction narrowing。
- `git diff --check`：pass。
- 未建立或部署 OpenAI Sites／Vercel／Cloudflare；`.openai/hosting.json` 保持既有刪除狀態。
- 沒有修改 Obsidian Wiki、raw 或使用者自訂的永久排除區。

## 後續可選工作

- 對新 SEC event 建 immutable FRED event-time snapshot，而不只保存最新 series snapshot。
- 支援 SEC `filings.files` 舊分段回補，但仍保持 initial baseline quiet。
- 在合法資料權限允許時增加 OpenFIGI identifier normalization。
- 把 `npx tsc --noEmit` 加入 package script 與未來 CI gate。
