# shopline-proxy

Meta 廣告成效 + SHOPLINE 訂單/折扣碼代理 Worker,給 speedingscs / H-J 兩個品牌報表網站共用讀取。

## 部署方式

接上 GitHub 後,push 到 main 分支就會自動部署,不用再到 Cloudflare Dashboard 手動貼 Quick Edit。

## 重要:Secrets 與 KV 綁定

接上 Git 部署後,以下設定需要在 Cloudflare Dashboard 手動確認一次(接Git不會自動帶入):

- **Secrets**(Settings → Variables and Secrets):
  - `SHOPLINE_TOKEN`
  - `SHOPLINE_USER_AGENT`
  - `META_TOKEN`
  - `PROXY_SECRET`
- **KV 命名空間繫結**(Settings → Bindings):
  - 變數名稱 `REPORT_KV` → 指向 `report-kv` 命名空間(id: `d283e1d9fa8f4ec1b1a64f2818649cb0`)

## 2026-07-30 更新

修正高流量帳號(H&J 一頁業績)整月查詢常常失敗(錯誤代碼 1/99)的問題:
1. 查詢範圍超過 20 天時自動切成兩段各自查詢再合併,降低單次 Meta insights 查詢複雜度
2. 整月查詢(relax=false)時,只對「花費有機會達標」的廣告抓細節,減少對 Meta 的請求次數
3. 切段合併時依 ad_id 正確加總花費/成果,避免花費平均分散在兩段導致誤判排除
