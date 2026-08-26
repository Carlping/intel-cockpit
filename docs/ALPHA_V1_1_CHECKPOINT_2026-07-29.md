# Alpha v1.1 實作暫停點

日期：2026-07-29（America/New_York）

狀態：依使用者要求暫停。所有修改已存於本機工作目錄；未部署、未推送、未建立公開託管。

## 已完成／已落盤

- 首頁改為本機 Live 情報台，原展示版保留於 `/replay` 並標示模擬。
- 建立 Markdown canonical store、CAS preview/commit、原子寫入、read-back 與 recovery 基礎。
- 建立 Today、Inbox、Situations、Missions、Reviews 與 connector health API。
- 建立 Wiki 唯讀 watcher、官方 Feed、Telegram explicit-submit、Truflation manual-only 等 connector 基礎。
- 建立 Brief transcript、備份、lint/quarantine 與本機啟動維運基礎。
- 移除 OpenAI Sites 設定、部署路徑與 `sites` Git remote；沒有 push。
- 加強 Situation／Mission／Review 正式資料契約及 TypeScript 型別。

## 尚未完成（明日優先順序）

1. 把 Inbox → Situation → Mission → Review 的 UI 草稿按鈕改成完整 typed forms。
2. 把批次寫入移到 store-level transaction：writer lock、寫入前 WAL、hash-aware crash recovery、無破壞 rollback。
3. 加入 S0–S8 `Known` gate、關係完整性與 Mission 高風險欄位的明確使用者授權。
4. 完成 Telegram bounded retry/dead-letter、Truflation deterministic 去重、官方 Feed baseline 測試。
5. 修正每日維運健康、啟動順序、動態 refresh、Finance/Macro 真實資料／Unavailable 呈現。
6. 更新舊測試 fixture、修正 replay lint、重寫 README。
7. 建立安全 seed/migration，經驗證後才初始化實際 intelligence Vault。
8. 跑 unit、lint、typecheck、build、390×844 與桌面瀏覽器視覺驗收。

## 目前已知驗收狀態

- 最近一次 unit test：36/44 通過，8 個 fixture／流程測試待修。
- 最近一次 lint：2 個 replay 頁面的 `set-state-in-effect` 錯誤待修。
- 最近一次 build：通過；但不代表 Alpha 已達可用驗收門。

## 明日恢復指令

從本檔的「尚未完成」第 1 項開始；先完成資料契約與安全交易，再做 Vault seed 與視覺驗收。不可部署或推送。
