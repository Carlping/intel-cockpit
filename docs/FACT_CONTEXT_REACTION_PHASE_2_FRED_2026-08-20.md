# Phase 2 checkpoint｜FRED 背景層

日期：2026-08-20（America/New_York）
狀態：完成

## 已完成

- FRED 固定官方 series allowlist：DFF、DGS2、DGS10、T10YIE、DTWEXBGS、NFCI。
- 每個 series 只取最近兩筆 observation，計算 latest / previous / delta。
- 每筆保存 `observation_date`、`realtime_start`、`realtime_end`、unit、frequency 與 FRED source URL。
- `.` 明確映射為 missing / partial，不轉成 0。
- 無效 envelope、HTTP 錯誤或單一 series 失敗時不以示範資料替代；其餘 series 可形成 partial coverage。
- FRED API key 只保存於 Windows CurrentUser DPAPI；未設定時 fail closed。
- API：`POST /api/v2/evidence-loop/fred/setup`；共用 refresh/projection endpoints。
- Now 頁 Context 欄顯示 series、值、delta、observation date，並連回每個 FRED series 頁。

## 驗收證據

與 Phase 1 相同 focused command：12 tests passed、0 failed。

FRED assertions 覆蓋：

- realtime vintage 欄位原樣保存。
- missing `.` 不冒充數值。
- 六個 allowlisted series 才會發出請求。
- 一個無效 envelope 時回報 degraded / partial，其餘五個 series 照常保留。
- 浮點 delta 正規化到六位小數，避免 `0.049999...` 污染 UI 與去重。

## 邊界與已知限制

- 目前保存的是每次 refresh 的最新背景快照；事件級 immutable macro snapshot 將在 production 使用出現新 SEC event 時進一步封裝。
- FRED 部分 series 可能受第三方授權條款限制；本機畫面只顯示必要數值與官方連結，不做資料再發布。
- Phase 2 當下曾暴露既有 `cognitive-reader` export、seed fixture 與 prediction narrowing 型別問題；發布前品質收尾已修正，最終 `npx tsc --noEmit` 通過。

## 下一階段恢復點

讀 `server/forward-intelligence/market-adapter.mjs` 的 `historicalReaction()`、Now 頁 `EvidenceLoopPanel`，再讀 Phase 3 checkpoint（完成後建立）。
