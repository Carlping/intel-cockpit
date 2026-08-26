# Phase 1 checkpoint｜SEC 事實層

日期：2026-08-20（America/New_York）
狀態：完成

## 已完成

- `server/evidence-loop/index.mjs` 新增 SEC EDGAR submissions connector。
- 固定 watchlist：Alphabet、Tesla、TSMC ADR、ASML；每家公司以明確 CIK 查詢。
- 固定 form allowlist：10-K、10-Q、8-K、20-F、6-K、Form 4、13F-HR 與 amendments。
- 每筆 observation 保存 CIK、accession number、form、filing/report/acceptance date、primary document 與 SEC Archive URL。
- contact email 只保存於既有 Windows CurrentUser DPAPI secret store；未設定時 fail closed，不發出網路請求。
- request 使用描述性 `User-Agent: IntelOS local research <contact>`，逐公司串行請求，遠低於 SEC 目前的 10 req/s 上限。
- 每 CIK 第一次成功 poll 只建立 accession baseline；既有申報可顯示為 `baseline_only`，但不進 Inbox、不建立 reaction job。
- 後續只對未見 accession 建立 observation、reaction job，並沿用既有 routing / Inbox；API observation 仍是 `unverified_external`，不會自動升級 Known。
- runtime baseline、facts 與 jobs 保存於 `%LOCALAPPDATA%\IntelOS\state\fact-context-reaction.json`，不進 OneDrive。
- API：
  - `POST /api/v2/evidence-loop/sec/setup`
  - `POST /api/v2/evidence-loop/refresh`
  - `GET /api/v2/evidence-loop`
- Now 頁「本機資料源設定」可輸入 SEC contact email；欄位成功後清空，不在瀏覽器持久化。

## 驗收證據

執行：

```powershell
node --test tests/evidence-loop.test.mjs tests/forward-intelligence.test.mjs
```

結果：12 tests passed、0 failed。

覆蓋：

- 8-K 保留完整 lineage，S-8 被 allowlist 排除。
- 無 contact email 時沒有網路請求。
- 第一次 poll 建 baseline 且不 emit。
- 第二次 poll 只 emit 新 8-K。
- state 重啟後同一 accession 不重送。

## 邊界與已知限制

- 尚未抓取 filing 文件全文或 exhibits；事實層目前是 submissions metadata。
- SEC 官方 submissions 的舊檔案分段（`filings.files`）尚未回補；目前以 recent window 監控新事件。
- watchlist 目前是 code allowlist，不接受任意 CIK，避免意外放大抓取範圍。

## 下一階段恢復點

讀 `server/evidence-loop/index.mjs` 的 `refreshFred()` 與 `tests/evidence-loop.test.mjs`，再讀 Phase 2 checkpoint。
