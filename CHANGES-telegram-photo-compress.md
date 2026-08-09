# Telegram 相册 "整组消失" 修复 —— 变更记录

对照 `telegram-photo-limit-fix.md` 的排查结论，把里面提到的"通用修复模式"落地到 PKR Issue Hub 全部三处会把图片发去 Telegram 的地方。之前只有 `submit.js` 的单图路径（`sendSingleWithCaption`）在 `sendPhoto` 失败时有 fallback（自动重试成 `sendDocument`），相册路径和转发/回复路径完全没有保护。

## 新增文件

- **`functions/_shared/telegramImageCompress.js`** —— 压缩逻辑本体。
  用 `@cf-wasm/photon`（Rust photon-rs 编译成 WASM，能在 Cloudflare Pages Functions/Workers runtime 里跑，不依赖 Node 的 Sharp/Canvas）。
  策略：只有当图片 > 9.3MB（留了 0.7MB 安全余量，不卡在 Telegram 10MB 整数上）才处理；第一轮只降 JPEG 质量（85）、不改分辨率；仍超标则每轮分辨率 ×0.75 + 质量继续往下走（75→65→55→45→40），最多 6 轮。压缩失败（WASM 抛错等）会被 catch 住并打日志，返回原始字节 —— 不会因为压缩本身出 bug 而把发送流程也搞挂。
- **`package.json`** —— 声明 `@cf-wasm/photon` 依赖（`^0.4.0`，已验证 `npm install` 可用，`workerd` 子路径导出存在），让 Cloudflare Pages 构建时自动安装。之前项目没有 `package.json`。

## 修改文件

- **`functions/api/submit.js`**
  - `sendSingleWithCaption`：发 `sendPhoto` 前先压缩（`sendDocument` 分支不变，因为文档上限本来就是 50MB）。
  - `sendMediaGroup`：**这是本次 bug 的根因所在** —— 相册里每张图在打包进 multipart 请求前都先压缩，避免"一张超标、整组被 Telegram 拒绝、自动退化成纯文字"的情况。
  - 补了两处 `console.error`（相册发送被 Telegram 拒绝时、attachment 整体失败 fallback 成文字时）—— 原来这两处都是纯静默 catch，排查记录里提到的"没日志只能靠猜/找旁证"这个基础设施缺口，顺手一起补了。

- **`functions/api/forward.js`**（"Generate to another Topic" 转发功能）
  - `sendOneFreshUpload` 和 `sendCombinedAttachments` 里的相册分支：只压缩**新上传**的附件（`newAttachments`，有原始字节）；**沿用的 `file_id`**（`fileIds`，来自被转发的原始工单，本来就已经在 Telegram 服务器上）不需要也没法压缩，原样传。
  - 补了 Telegram 发送失败时的 `console.error`。

- **`functions/api/threads/[id].js`**（工单详情页的"回复"功能）
  - `sendReplySingleWithCaption` / `sendReplyMediaGroup`：只压缩 `attachmentKind` 判定为 `"photo"` 的附件；`video`/`document` 走各自的上限，不动。
  - 补了 Telegram 发送失败时的 `console.error`。

## 没有改动的地方（刻意）

- R2 存档（`_shared/r2.js` 的 `uploadAttachmentToR2`）完全没碰 —— 排查记录里明确要求"只压缩发给 Telegram 的那份字节，不影响原始文件在对象存储里的存档质量"，R2 上传发生在压缩逻辑接入点之前，用的还是原始 `attachment.dataUrl`。
- `functions/_shared/telegram.js`（登录 IP 告警用的极简纯文字发送器）—— 本来就不带附件，没有这个问题。

## 建议之后再做（本次没做，超出这次修复范围）

- 排查记录检查清单里提到的"前端对用户上传原始文件大小做限制或提示"——治标层面的东西，这次只做了服务器端兜底（治本），前端提示留给下一步。
