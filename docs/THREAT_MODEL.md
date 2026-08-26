# IntelOS 威脅模型

## 信任邊界

Telegram 投稿與外部 feed 都是不可信輸入，必須經過解析、去重、驗證與使用者確認，才可進入 canonical Vault 寫入流程。Source Wiki 是唯讀證據來源；canonical Markdown 是正式狀態，兩者之間沒有自動執行外部內容的信任提升。

## 已由程式強制執行的防護

- `server/runtime-boundary.mjs` 拒絕 symbolic link、junction、reparse point，並拒絕 OneDrive runtime 路徑。
- canonical 寫入使用 CAS、WAL、原子更新與 read-back validation。
- HTML 使用 CSP nonce，並設定 `frame-ancestors 'none'`。
- static asset 路徑有 traversal boundary。
- outbound domain 是固定 allowlist，不接受使用者控制的 URL，因此沒有由此產生的 SSRF surface。
- 程式庫中沒有 `dangerouslySetInnerHTML` 或 `eval`。
- Vault 的永久排除 subtree 由本機未提交設定檔指定；缺少設定時 fail closed，匹配的 subtree 不會被讀取、索引、引用或寫入。這項隱私設定是程式強制執行；設定哪些名稱則是使用者的本機責任。

## 憑證生命週期

Windows DPAPI CurrentUser 將憑證保存在 `%LOCALAPPDATA%\IntelOS\secrets`。憑證不進 repo、localStorage 或 logs；DPAPI child process 的 stderr 會丟棄。上述位置與 Windows DPAPI 是程式行為，使用者仍須保護自己的 OS 帳戶。

## 殘餘風險

- local API 沒有 authentication；任何以同一 OS user 執行的 process 都可以驅動它。token file 若同樣可被該 user 讀取，幾乎不會增加保護，因此系統依靠綁定 `127.0.0.1` 的 Host/Origin 檢查，而不是假裝提供身份驗證。
- `vinext@0.0.50` 是 0.0.x framework dependency，API 與相容性仍有變動風險。
- Telegram long-polling 在電腦關機時沒有完整 coverage，離線期間的訊息處理是已知缺口。

以上內容區分程式強制執行的控制與文件化政策；未由程式檢查的作業流程不能視為安全保證。
