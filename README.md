# Account Issue → Telegram Bot（工单双向同步）

网页提交 Account Issue 工单 → 自动发到 Telegram 群 → 客服在群里回复 → 自动同步回网页。

## 项目结构

```
account-issue-bot/
├── public/                    # 静态前端
│   ├── index.html
│   ├── style.css
│   └── app.js
├── functions/
│   └── api/
│       ├── submit.js              # POST 提交工单 -> 发送到 TG
│       ├── telegram-webhook.js    # 接收 TG 群回复
│       └── ticket/[id].js         # GET 工单详情（前端轮询用）
├── schema.sql                 # D1 数据库表结构
├── wrangler.toml
└── README.md
```

## 第一步：创建 Telegram Bot

1. 在 Telegram 里找 **@BotFather**，发送 `/newbot`，按提示起名字，拿到 **Bot Token**（形如 `123456:ABC-DEF...`）。
2. 把这个 Bot 拉进你的客服 TG 群。
3. 关闭群里的隐私模式，这样 Bot 才能读取群消息：对 @BotFather 发送 `/setprivacy` → 选择你的 Bot → 选 **Disable**。
4. 获取群的 **Chat ID**（通常是负数，如 `-1001234567890`）：
   - 把 Bot 拉进群后，在群里发一条消息，然后访问：
     `https://api.telegram.org/bot<你的TOKEN>/getUpdates`
   - 在返回的 JSON 里找 `"chat":{"id": ...}`。

## 第二步：把代码推到 GitHub

```bash
cd account-issue-bot
git init
git add .
git commit -m "init: account issue bot"
git branch -M main
git remote add origin https://github.com/<你的用户名>/account-issue-bot.git
git push -u origin main
```

## 第三步：创建 Cloudflare D1 数据库

```bash
npx wrangler login
npx wrangler d1 create account-issue-db
```

把命令返回的 `database_id` 填到 `wrangler.toml` 里的 `database_id = "..."`。

导入表结构：

```bash
npx wrangler d1 execute account-issue-db --remote --file=./schema.sql
```

## 第四步：在 Cloudflare Pages 里连接 GitHub 仓库

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**，选择你刚推送的仓库。
2. Build 设置：
   - **Build command**：留空（纯静态文件不需要构建）
   - **Build output directory**：`public`
3. 部署完成后会得到一个域名，例如 `https://account-issue-bot.pages.dev`。
4. 进入项目 → **Settings** → **Functions** → **D1 database bindings**，绑定：
   - Variable name: `DB`
   - D1 database: 选择 `account-issue-db`
5. 进入项目 → **Settings** → **Environment variables**，添加（建议加密/Secret）：
   - `TELEGRAM_BOT_TOKEN` = 你的 Bot Token
   - `TELEGRAM_CHAT_ID` = 你的群 Chat ID
   - `TELEGRAM_WEBHOOK_SECRET` = 自己随便设一个字符串（用于校验 Webhook 请求，防止被人伪造调用）

修改环境变量后需要重新部署一次（Deployments → Retry deployment）才会生效。

## 第五步：给 Bot 设置 Webhook

让 Telegram 把群里的新消息推送到你的网站：

```bash
curl -X POST "https://api.telegram.org/bot<你的TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://account-issue-bot.pages.dev/api/telegram-webhook",
    "secret_token": "<和上面 TELEGRAM_WEBHOOK_SECRET 一致的值>"
  }'
```

返回 `{"ok":true, ...}` 即成功。可以用下面命令检查状态：

```bash
curl "https://api.telegram.org/bot<你的TOKEN>/getWebhookInfo"
```

## 使用流程

1. 用户在网页填写 Account Issue 表单并提交。
2. 网站生成工单号（如 `ACC-XXXXXX`），把内容发到 TG 群，并把这条消息的 `message_id` 存进数据库。
3. 客服在 TG 群里，**长按/右键该消息 → 回复（Reply）**，输入回复内容发送。
4. Telegram 把这条回复推送到 Webhook，网站根据 `reply_to_message.message_id` 找到对应工单，把回复存进数据库。
5. 网页每 5 秒轮询一次，自动把回复显示在"我的工单"里。
6. 客服如果回复内容以 `/close` 开头，工单会自动标记为"已解决"。

## 本地开发

```bash
npm install -g wrangler   # 如果还没装
wrangler pages dev public --d1=DB --binding TELEGRAM_BOT_TOKEN=xxx --binding TELEGRAM_CHAT_ID=xxx
```

## 后续可扩展

- 目前只做了 **Account Issues** 一个分类，其余分类（Deposit Issue、Withdraw Issue、Risk Issues 等）可以复制 `submit.js` 的逻辑，按类别区分 `issue_type` 前缀或者用不同的 TG 群/话题（Topic）。
- 如果 TG 群开启了 **Topics（话题）**功能，可以把 `chat_id` + `message_thread_id` 也存进数据库，按分类发到不同话题里。
- "我的工单"目前基于浏览器 localStorage 识别，如果需要跨设备查看，需要加登录/账号体系。
- 9 个问题类型目前是占位内容（无法登录 / 密码重置 / KYC 等），可以在 `public/index.html` 的 `<select>` 里按实际业务改。
