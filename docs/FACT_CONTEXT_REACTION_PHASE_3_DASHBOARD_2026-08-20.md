# Phase 3 checkpoint｜Alpaca 反應層與閉環 UI

日期：2026-08-20（America/New_York）
狀態：完成

## 已完成

- 保留既有 Alpaca IEX WebSocket fast lane，擴充 watchlist symbols：GOOG、GOOGL、TSLA、TSM、ASML，加上 SPY／QQQ／IWM／TLT／UUP／GLD；總數低於 Basic plan 的 30-symbol 上限。
- 每個新 SEC fact 建立 15 分鐘 reaction job；facts 與 market impact 保存為不同 state，reaction 失敗不會改變 fact state。
- `historicalReaction()` 以 1-minute bars 計算事件窗 return；優先 `feed=sip`，403／422 才重試 `feed=iex`。
- 結果保存 event/window、provider、feed、coverage、benchmark、first/last price、bar count、return 與 abnormal return。
- 無憑證、事件未滿 15 分鐘、bars 不足時回傳 pending/null，不製造零反應。
- Now 頁新增 `Fact → Context → Reaction` 三欄：
  - Fact：SEC form、company、symbols、baseline/novel 狀態與 filing link。
  - Context：FRED 值、delta、observation date 與 source link。
  - Reaction：feed、coverage、window、symbol return、相對 SPY abnormal return。
- 面板顯示 as-of、pending jobs、incomplete reasons，並提供 SEC／FRED／Alpaca 本機設定與手動同步。
- 所有 input 成功後清空；沒有 localStorage 或前端 secret persistence。
- 響應式 breakpoint 讓三欄在窄螢幕改為單欄；沿用既有 Forward Intelligence 視覺系統。

## 驗收證據

Focused：

```powershell
node --test tests/evidence-loop.test.mjs tests/evidence-loop-api.test.mjs tests/forward-intelligence.test.mjs
```

結果：14/14 passed。

完整整合：

```powershell
npm test
```

結果：production build 成功；120/120 tests passed。

Lint：

```powershell
npm run lint
```

結果：0 errors；2 個既有 `LegacyTodayView` 未使用警告。

額外檢查：`git diff --check` 無 whitespace errors；secret pattern scan 只命中程式的 HTTP header 名稱與明確 test fixture values。

## 重要語義

- `iex_proxy` 永遠是 partial proxy，不是 consolidated market。
- `sip_delayed_historical` 代表事件滿 15 分鐘後取得的 historical coverage，不代表即時 SIP。
- market reaction 只能補 impact；不能把 `unverified_external` SEC observation 自動升級為 Known。
- 自動 retry 只處理資料不足或暫時錯誤；不會下單、建立 Mission 或修改使用者 forecast。

## 恢復點

功能面已完成。若需要發布，先讀 final handoff 的 GitHub blocker，再決定 staged scope 與 remote；不要對 dirty worktree 使用 `git add .`。
