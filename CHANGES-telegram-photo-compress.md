# Telegram 图片压缩修复 — 应用到 INR 项目的改动记录

把之前给 PKR 项目做的同一个修复（超过 Telegram 图片大小上限时发送失败）搬到了
INR。两个项目此前完全独立、没有共享过任何代码，这是一次单独的移植，不是同步。

## 问题

Telegram `sendPhoto` / `sendMediaGroup` 对单张图片有 10MB 上限，超过直接被
Telegram API 拒绝，且原来项目里对此没有任何处理 —— 失败会直接冒泡成一条不带具体
原因的提交失败提示。这个问题不是 INR 特有的，只是之前从没在这个项目上修过。

## 新增 `functions/_shared/telegramImageCompress.js`

用 `@cf-wasm/photon`（Rust `photon`图片库的 WASM 编译版，能直接在 Cloudflare Pages
Functions 的运行时里跑，不像 Sharp/node-canvas 那样依赖原生模块）实现：

- 只压超过 **9.3MB**（不是 10MB —— 留了余量，因为发送时经过 base64→bytes→multipart
  这几层转换后实际字节数和 Telegram 报错里说的"必须小于 10MB"没有精确对应过，卡在
  刚好 10MB 边缘风险太大）的图，没超过的完全不touch，原图原样发送。
- 六轮递进式压缩：先降 JPEG 质量（85 → 70 → 55），质量降到底还不够，再配合分辨率
  ×0.75 逐轮继续降（第4-6轮）。每一轮都是从原图重新缩放，不是在上一轮已经缩小过的
  图基础上再缩小 —— 避免模糊被逐轮叠加。
- 每一轮结束检查是否已经落在阈值以内，是就立刻停止，不做没必要的进一步压缩。
- 六轮跑完还是超标（极端情况）就发送六轮里最小的那个版本，而不是原图 —— 至少比
  完全不处理更接近能发出去。
- 压缩过程本身出任何异常（无法解码的格式、WASM 报错等）都静默捕获，直接回退发送
  原始字节 —— 压缩是锦上添花，不该成为发送流程新的失败点。

**这个函数本身实际跑过测试**，不是只写完代码没验证：本地用 Pillow 生成了两张噪点
图（噪点图故意选的，因为高频噪点几乎不可压缩，比真实截图更难压，是更严格的测试）：
- 11.2MB 的一张，第一轮（质量85，不缩分辨率）就降到 7.5MB，通过。
- 37.7MB 的一张，质量降到55都还有10.9MB，直到第四轮（质量50 + 分辨率×0.75）才降到
  4.9MB，通过 —— 验证了"质量降不动就上分辨率"这条分支确实会被触发、也确实有效。

（测试是用 `@cf-wasm/photon/node` 这个子入口跑的，不是 `/workerd` —— `/workerd`
子入口直接 `import ... from "./xxx.wasm"`，这种写法只有 wrangler 自己的打包器认识，
本地 `node` 没法直接跑；两个子入口背后调用的是完全相同的 Rust 函数，所以这样测的是
真实会跑的那套压缩算法本身，只是换了个能在本地跑起来的入口。实际部署后 Cloudflare
Pages 走的是 `/workerd` 那个入口，这个已经是 `@cf-wasm/photon` 官方文档里给 Pages/
Workers 场景推荐的标准写法。）

## 接入的三个真正会往 Telegram 发图的地方

之前给 PKR 做这个修复时踩过的一个点：只顾着修用户报出来的那一条路径，漏了其余几处
——这次直接把三个文件里所有真正会发图片字节的路径都过了一遍：

- **`functions/api/submit.js`**
  - `sendSingleWithCaption`（原始工单的单图路径）—— 只在 `isImage` 时压缩，文档类
    附件（`sendDocument`）不受影响，Bot API 对文档的上限本来就高得多。
  - `sendMediaGroup`（相册路径，本次 bug 的根因所在）—— 这里所有附件本来就已经被
    调用方保证是图片（`allImages` 检查在调用前做过），不需要逐项判断类型；顺手把
    这里原来的同步 `attachments.forEach` 改成了 `for...of` + `await` —— 压缩函数是
    异步的，`forEach` 不会等待里面的 `await`，原来的写法会导致压缩根本没生效就已经
    往下发了。
- **`functions/api/forward.js`**（"转发到其他 Topic"）—— 只压缩 `newAttachments`
  （新上传的附件），`fileIds`（沿用自原工单、复用 Telegram 自己 file_id 的部分）
  完全不碰：这些字节早就在 Telegram 服务器上了，没有本地字节可压，压了也没意义。
  `sendCombinedAttachments` 的 2+ 附件分支、以及 `sendOneFreshUpload`（total===1 且
  是新上传时走的单独路径）都接入了。
- **`functions/api/threads/[id].js`**（工单详情页"回复"功能）
  - `sendReplySingleWithCaption` —— 只在 `attachmentKind()` 判定为 `"photo"` 时压
    缩，video 走 `sendVideo`（限制更高）、document 走 `sendDocument`，都不受影响。
  - `sendReplyMediaGroup` —— 这里比较特殊：一个回复相册里 Telegram 允许 photo 和
    video **混在一起**，所以不能像 `submit.js` 的 `sendMediaGroup` 那样整批默认都
    是图片，改成逐项判断 `attachmentKind()`，只有真正是 `"photo"` 的那几项才压缩，
    video 项原样发送。

## 补的日志

三个文件（`submit.js` / `forward.js` / `threads/[id].js`）顶层的兜底 `catch` 原来
都是纯静默 —— 捕获到未预期异常后直接返回 JSON 错误给前端，服务端自己完全没有留下
任何记录，出问题只能凭前端报的错误文案去猜。三处都加了 `console.error`，把真实的
异常堆栈打进 Cloudflare 的 Functions 日志里。

## 新增依赖 → 部署前必须做的一步（仪表盘操作，代码带不过去）

新增了根目录 `package.json`，声明 `@cf-wasm/photon` 依赖 —— 本地 `npm install`
验证过可以正常装上（含 workerd 子路径导出）。

这个项目原来是纯静态站 + 零依赖 Functions，`wrangler.toml` 里从来没配置过 Build
command（Cloudflare 会跳过 `npm install`），之前这样完全没问题，现在有依赖了就会
撞上同一个坑：部署时因为跳过依赖安装，`esbuild` 打包 Functions 时找不到
`@cf-wasm/photon`，构建失败。

修复方式和之前 PKR 那次一样 —— **只能在 Cloudflare 仪表盘手动设置，改代码/推送
带不过去这一步**：

1. Cloudflare 仪表盘 → Workers & Pages → 这个项目 → Settings → Builds & deployments
2. Build command 填 `npm install`
3. Build output directory 保持 `public` 不变
4. 保存后 Retry deployment，或者推一个新 commit 触发重新部署

`wrangler.toml` 顶部和 `README.md` 顶部都加了对应的提醒注释/说明，防止以后又要
重新踩一次坑才想起来。（`wrangler.toml` 里没有加 `[build]` 这个 key —— 之前已经
确认过，这是 Workers 专属概念，Pages 项目的 Wrangler 配置解析器会直接忽略它，
真正生效的只有仪表盘那一步。）

## 涉及改动/新增的文件

- `functions/_shared/telegramImageCompress.js`（新增）
- `functions/api/submit.js`
- `functions/api/forward.js`
- `functions/api/threads/[id].js`
- `package.json`（新增）
- `wrangler.toml`（顶部加注释，未改任何实际配置项/绑定）
- `README.md`（顶部加部署提醒）

所有改动过的 `.js` 文件都跑过 `node --check`，语法上都能正常解析；压缩函数本身
额外用真实生成的超大图片跑过端到端验证（见上）。R2 存档、Sheet 记录等其它逻辑
完全没有改动 —— 确认过 `submit.js` 里 R2 上传（`uploadAttachmentToR2`）用的是最早
那份原始 `attachments` 数组，发生在压缩逻辑之前、也没有共享同一份 `bytes`/`blob`
变量，这次改动只影响"发给 Telegram 的那份字节"，R2 里存的仍然是未压缩的原始文件。
