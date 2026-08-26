# Alpha v1.1 實作與驗收報告

日期：2026-07-30（America/New_York）

結論：**已達單人、本機、PC-on 的 dogfood 門檻；尚未達 10 人團隊產品或 24/7 服務門檻。**

這一版已經不是單純儀表板展示。正式資料流與控制迴路為：

`InboxItem → Situation → Mission → Action result → Review → Situation`

`Today` 與 `Decision Brief` 都只投影上述正式狀態；沒有 material change 時保持安靜，不用一般新聞或模擬資料填充。

## 已完成

### 產品與 UX

- `/` 為本機 Live 情報台，包含 Today、Inbox、Situations、Missions、Review。
- `/replay` 保留原先歷史模擬，明確標示「歷史重播／非即時」。
- Today 的 Needs You、Material changes、Mission next actions 各最多三項。
- Inbox 完成 Link／Create Situation、Reference only、Watch、Not relevant、Send to Wiki ingest 等 typed workflow。
- Situation 呈現 Before → Now、Known／Inference／Unknown／Contradiction、timeline、watch／stop／reopen、Related Missions。
- Finance 預設以板塊／族群顯示；沒有使用者持倉、觀察清單或明確個股資料時不展開個股。
- 中期回調面板納入八項條件；沒有已接受的實質變化時保持 DORMANT，不製造抄底分數或交易訊號。
- Macro 面板可並列 BLS CPI、BEA PCE 與 Truflation；不同單位分開縮放，沒有真實 observation 時明示 unavailable。
- 每日 Brief 為引用完整的 3–6 分鐘 transcript；TTS 資源不可用時清楚標示 Audio disabled。
- 390×844 手機版有固定底部導覽，實測無頁面水平溢位。

### 資料真相與控制迴路

- Markdown canonical store、唯一 writer、`base_revision` CAS、preview → commit、WAL、原子 rename、read-back validation 與 crash recovery 已完成。
- Batch command 可在同一交易內更新 Inbox／Situation 或 Mission／Situation，避免只完成半套狀態。
- 已處理的 Inbox 不再回到待分流列表；重複分流會被拒絕。
- External lead 完成 S0–S8 並通過已保存的 Wiki allowlist／hash 驗證前，只能保持 `unverified_external` 或 Unknown。
- `Known` 是 canonical schema invariant：任何 writer、手工匯入或舊資料只要缺少 `verified` 與 completed S0–S8 gate，store reload／schema lint 都會 fail closed。
- Agent 可以草擬 Situation／Mission adjustment，但不能自行更改 Mission objective、宣告 completed／cancelled 或觸發交易。
- Mission action result 若造成 changed／blocked，會草擬相關 Situation 的 Before → Now；No Change 則保持安靜。
- Material change 必須由使用者明確 acknowledge 才從 Today 清除，並保留 history。

### Connector 與維運

- Wiki watcher 採事件提示加五分鐘 hash reconcile，只讀 Markdown，硬性排除使用者自訂的永久排除區。
- Fed、BLS、Treasury Fiscal Data、Federal Register、CISA、UN、USGS collectors 已接上；第一次 poll 只建立 baseline，之後只提交 novel observations。
- BEA 在沒有 API key 時關閉；SEC 在沒有合規 contact email 時關閉。
- Telegram 採 Bot API long polling、explicit-submit、allowlist、checkpoint、edit 去重、24 小時 coverage gap、forget／revoke、DPAPI 加密與 bounded retry／quarantine。
- 敏感資訊、疑似 MNPI、付費全文或個資只進加密 quarantine，不進 canonical Inbox／Brief。
- `/forget`／`/forgetme` 會移除混合來源 entity 中對應的 evidence／timeline，redact 相同投稿片段，並留下不含原文的 entity ID／hash invalidation trace。
- Truflation 保持 manual-only；API、export、team display、audio license gate 預設關閉，失敗時不降級爬網頁。
- Daily maintenance、backup、schema lint、runtime retention、磁碟空間健康與登入啟動腳本已備妥。

### 邊界與發布

- Source Wiki 保持唯讀；正式衍生情報只寫入 `<INTEL_ROOT>`。
- Runtime 位於 `%LOCALAPPDATA%\IntelOS`，不放 OneDrive。
- 全部 runtime layout 會在第一個 `mkdir` 前整批做 lexical／realpath／junction／reparse preflight；敏感 read、write、remove、forget 與 purge 也會在每次操作前重新 guard。
- 實際 seed 已建立三個 Situation、一個個人 dogfood Mission 與一筆封存的 reference-only Inbox；routing migration 已套用且二次 dry-run 為 no-op。
- 伺服器只監聽 `127.0.0.1:4173`，限制 Host／Origin，拒絕任意 filesystem path。
- 已移除 `.openai/hosting.json`、Sites plugin 與 deploy 路徑；沒有 Git remote、push 或公開託管。
- HTML bootstrap 使用逐回應 CSP nonce；`script-src` 沒有加入 `unsafe-inline`。

## 驗收結果

| Gate | 結果 |
| --- | --- |
| Production build | 通過 |
| Unit／integration tests | 94／94 通過 |
| ESLint | 通過，0 error |
| TypeScript `--noEmit` | 通過 |
| Source vault／runtime／path traversal 邊界 | 通過 |
| CAS、WAL、batch transaction、crash recovery | 通過 |
| Telegram 去重、敏感資料、forget、coverage gap | 通過 |
| Truflation fail-closed 與 deterministic dedupe | 通過 |
| Desktop Live UI 與五個主流程 | 通過 |
| `/replay` 模擬標示與互動 | 通過 |
| 390×844 responsive／底部導覽／水平溢位 | 通過 |
| 瀏覽器 console errors | 0 |
| CSP hydration／API 同步 | 通過；Live · Local |

獨立 release re-audit 已重新檢查 runtime junction、Telegram mixed-source forget 與 Known schema gate，三項 P1 均關閉；未發現新 P0。

### 最終實機狀態

- 本機 server 正在 `127.0.0.1:4173` 以 collectors ON 模式運行。
- Wiki watcher 已索引 196 份合格 Markdown，0 changed／0 deleted，排除區未進索引。
- Fed、BLS、Treasury、Federal Register、CISA、UN、USGS 均為 healthy；Truflation 為 healthy／manual-only。
- BEA、SEC、Telegram 依資源 gate 保持 disabled。
- 目前 Today 為 0 Needs You、0 Material changes；官方來源只進 Inbox，未冒充已驗證結論。
- 既有官方 Inbox 的 `feed_id` provenance 已用 CAS/WAL migration 補齊；第二次 dry-run 為 no-op。

## 尚未解鎖的外部資源

以下不是程式阻斷，而是使用者資源或產品範圍 gate：

- Telegram：需要使用者在 localhost 設定畫面輸入專用 bot token，完成 `/pair`；token 不可貼到聊天或 Vault。
- 24/7：目前為 PC-on；若電腦關機仍要無缺口收集，需要受控 runner。
- BEA PCE：需要 BEA API key。
- SEC：需要合規 contact email。
- Audio：需要可靠的本機 TTS 或合規雲端 TTS key；目前 transcript-only。
- Truflation 自動化：需要 API subscription 與明確 Data License；Alpha 不建議購買。
- 手機完整 Web UI：尚未配置 Tailscale；目前可先用 Telegram `/brief`、`/status`。
- Windows 登入自啟：安裝腳本已提供，但尚未替使用者修改 Task Scheduler。
- TradingView 圖表／PineScript／自動截圖：依 Alpha 範圍留待後續；現階段只接收使用者明確提供的圖表。

## 實際營運風險

- C 槽目前仍低於 10% 可用空間，系統會顯示 runtime storage degraded；這不是立即資料損壞，但不適合在 OneDrive 工作目錄長期堆積 `node_modules`、build cache 與其他生成物。
- Pathname-based filesystem guard 仍有極短的 TOCTOU 視窗；需同一 Windows 使用者在檢查與操作間惡意置換目錄才可能利用，列為單人 Alpha 可接受的 P2。
- `/forgetme` 能移除可追溯引用與相同文字片段，但無法數學保證找出人工改寫後、已失去 lineage 的語意性轉述；後續團隊版需更嚴格的 field-level provenance。
- 長期常駐前，應把可執行 checkout／生成物移到非 OneDrive 且空間足夠的磁碟；OneDrive 只保留真正需要同步的 source／canonical Markdown。
- 本版本可開始 7–14 天個人 dogfood，但在完成 20 個 Inbox、3 個 Domain、3 個 Situations、3 個 Missions、1 個完整 Review 與 2 次正式 No Action 前，不應宣稱已驗證日常價值。

## 使用方式

雙擊 `啟動情報決策台.cmd`，或在專案目錄執行：

```powershell
npm run local
```

開啟 <http://127.0.0.1:4173/>。關閉命令視窗即停止 UI 與 collectors。
