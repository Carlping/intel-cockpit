# 認知分層閱讀與記憶索引架構

日期：2026-08-01（America/New_York）
狀態：v1 已落地，本機限定，未部署

## 結論

IntelOS 採用「定位 → 架構 → 建模 → 判斷 → 內化」五層累積閱讀。它不是把同一內容重寫成五篇長短摘要，而是讓同一批 canonical entity 依閱讀時間逐層展開；讀者在任何一層停止，都仍知道整體狀態、關鍵限制與下一步。

正式資料真相維持既有 canonical Markdown。介面中的 Memory Packet 是帶 `source_revision` 與 `as_of` 的 `derived_snapshot`，可匯出 Markdown 給人閱讀／Obsidian，或匯出 JSON 給搜尋、資料庫與未來索引器；它不得反向取代 canonical entity。

```text
Inbox／Situation／Mission／Review（canonical Markdown）
                     │
                     ▼
          五層 Cognitive Reader
                     │
                     ▼
    Memory Packet v1（derived snapshot）
          ├─ Markdown → Obsidian／人工整理
          └─ JSON → 搜尋／衍生資料庫／重建索引
```

## 五層累積閱讀

| 累積時間 | 認知任務 | 畫面必須回答 | 退出時應能做到 |
| --- | --- | --- | --- |
| 30 秒 | 定位 | 現在發生什麼、為何重要、唯一下一步、不可漏警告 | 說出主題、結論、下一步 |
| 3 分鐘 | 架構 | Before → Now、影響、3–5 個主節點 | 重畫主架構，不被細節淹沒 |
| 10 分鐘 | 建模 | Known／Inference／Unknown／Contradiction、機制、信心 | 用自己的話解釋原因與邊界 |
| 25 分鐘 | 判斷 | Watch／Stop／Reopen、替代情境、Mission、複查時間 | 比較方案並指出假設 |
| 50 分鐘 | 內化 | 原始來源、完整脈絡、提取問題、可索引記憶單元 | 關閉原文後重建、校正並入庫 |

時間是產品假設，不是認知科學的固定門檻；後續要用實際閱讀時間與回想結果校準。頂層只放 3–5 個有關係的節點，參考工作記憶約 3–4 個 chunk 的研究，但不把它誤用成「任何畫面最多四項」的硬規則。[Cowan 2001](https://memory.psych.missouri.edu/assets/doc/articles/2001/cowan-bbs-2001.pdf)

## 防止過度簡化

- 會改變行動的警告、條件、數字與不確定性必須在 30 秒層出現，不能藏到深層。
- 深層只能補充、限定或修正淺層結論，不能悄悄換掉結論。
- 事實、推論、未知與反證分開；相關性不得改寫成因果。
- 先提供完整骨架，再由使用者控制節奏展開。分段控制有助於建立心智模型；零碎、逐滴揭露反而可能破壞既有理解。[Mayer & Chandler 2001](https://tecfa.unige.ch/tecfa/teaching/methodo/Mayer_Chandler01.pdf)、[Springer & Whittaker 2020](https://doi.org/10.1145/3374218)
- 50 分鐘層必須包含「關閉內容後回想」，不只是再讀一次。提取練習對延遲保留通常優於反覆閱讀。[Roediger & Karpicke 2006](https://www.psychologicalscience.org/journals/psychological-science/j.1467-9280.2006.01693.x/)、[Karpicke & Blunt 2011](https://pubmed.ncbi.nlm.nih.gov/21252317/)

## Memory Packet v1

正式契約見 [`docs/schemas/intel-memory-packet.schema.json`](schemas/intel-memory-packet.schema.json)。核心欄位如下：

- 身分與系譜：`schema_version`、`id`、`type`、`as_of`、`provenance.kind`、`source_revision`。
- 分層內容：`summary_30s`、`architecture_3m`、`evidence_10m`、`decision_25m`、`deep_dive_50m`。
- 記憶化：`claims`、`openQuestions`、`retrievalCues`、`tags`。
- 可追溯性：`source_refs`。
- 索引：`index_text`，讓尚未導入向量資料庫時也能做全文檢索。

匯出的 Markdown 用標題維持相同層級順序，並在 frontmatter 保留 stable ID、schema、來源 revision、狀態與 tags。JSON 用同一資料生成，不由人另外維護，避免兩份內容逐漸漂移。

## 裝置與軟體決策

目前採用既有 React 本機介面作為互動閱讀層，保留 `127.0.0.1` 與 local-first 邊界；手機與桌面使用完全相同的語意資料，只改排版：

- 手機：單欄卡片、橫向時間選擇器、固定底部導覽、44px 以上主要觸控控制；沒有 hover-only 資訊。
- 桌面：側邊主導覽、較寬的 Before／Now 與證據並排區。
- 320 CSS px 寬度不得產生頁面級水平溢位；文字放大與鍵盤操作後續依 [WCAG 2.2](https://www.w3.org/TR/WCAG22/) 持續驗收。

Obsidian 適合作為人類可讀的 Markdown／properties／Bases 層，因 Vault 仍是普通本機檔案，[Bases](https://obsidian.md/help/bases) 也不會把資料搬進另一個封閉資料庫。若未來需要純閱讀的靜態輸出，可評估 [Quartz](https://quartz.jzhao.xyz/) 產生本機 HTML 與 `contentIndex.json`；這只是可選的衍生讀取層，不代表授權部署或公開。SQLite FTS、快取與高頻索引若加入，必須放在 OneDrive 外並能由 Markdown／JSON 重建。

## v1 驗收與下一階段

已完成的工程驗收：

- 五個時間層可切換，深層累積保留前層；30 秒為預設。
- 手機 320px、390px 與桌面 1440px 均無頁面級水平溢位。
- Markdown／JSON 記憶包可產生，包含來源、反證、下一步、提取問題與全文索引。
- JSON Schema、lint、build 與完整單元測試通過。

下一階段應依序做：

1. 以 5–10 次真實閱讀記錄時間、退出層級與是否採取下一步。
2. 做 30 秒立即回想與 7 天後無提示回想；校準每層資訊量。
3. 增加 preview-first 的「存進情報 Vault」流程，而不是直接寫入。
4. 建立可重建的 SQLite FTS／Brief 歷史，但不改變 Markdown canonical truth。
5. 若要讓手機直接存取 Web UI，另行設計受控私人網路、裝置註冊與撤銷；目前不開公開 port、不部署 OpenAI Sites。
