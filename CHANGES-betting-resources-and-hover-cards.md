# 2026-08-13 — HeyVIP Betting Rules topic + Home card hover effects + 3-column grid

## 📋 新增 — "HeyVIP Betting Rules" 主内容区 topic

一个静态资源链接页,不是表单提交模块——首页新增一张卡片,点进去是两个面板:
左边 "HeyVIP Betting Resources"(单条链接),右边 "Results Finding
Websites"(链接列表)。链接内容通过 Account Management → **Betting
Resources Links**(SuperAdmin 权限,跟 TG Group / Channel 同一层级)在网页
上实时编辑,不需要改代码重新部署。

**涉及的文件(7 个,6 个新建)**:
- (新建)`functions/_shared/bettingResources.js` — KV 存储层,复用现有的
  `THREADS_KV`(没有新增 Cloudflare 绑定),单个 JSON blob:
  `{ rules: {name,url}, results: [{name,url},…] }`
- (新建)`functions/api/betting-resources.js` — `GET`,任何已登录 agent
  可读,供 `betting-resources.html` 拉取数据
- (新建)`functions/api/admin/betting-resources.js` — `POST`,保存整份
  链接列表,要求 `bettingLinks` 这个 Admin Section 的 Can-Edit 权限
- (新建)`public/betting-resources.html` — 页面本体,套用项目现有的深色
  starfield 主题、topbar、Back to Home pill,跟 `deposit-backup.html`/
  `promo.html` 同款结构
- `functions/_shared/accounts.js` — `ADMIN_SECTIONS_LIST` 新增
  `bettingLinks`(floorRank: superadmin),同步加进
  `ADMIN_SECTIONS_DEFAULT_SEEN.superadmin`、
  `ADMIN_SECTIONS_DEFAULT_EDIT.superadmin`、`EDITABLE_ADMIN_SECTIONS`
- `functions/_shared/featureStatus.js` — `FEATURE_STATUS_ITEMS` 新增
  `betting_resources`,让这张卡片也能在 Settings 面板里被临时设成
  Maintenance/Coming soon(跟其他工具卡片一样的开关,但这次没有在
  `api/betting-resources.js` 里接服务器端真正拦截——只是登记了 UI 开关,
  真正生效前还需要补一步服务器端检查,已在下面"已知缺口"标注)
- `public/index.html` — Account Management 侧边栏新增
  **🔗 Betting Resources Links** 子项(在 "Deposit Sheet Link" 和
  "Settings" 之间),客户端权限镜像(`ADMIN_SECTIONS_LIST` 等)同步更新;
  新增 `loadBettingLinks()`/`renderBettingLinks()`/
  `acctSaveBettingLinks()` 三个函数,复用弹窗的全局 Save 按钮(不是
  TG Routes 那种按行保存);新增 "HeyVIP Betting Rules" 工具卡片

**⚠️ 部署后需要做的事**:去 Account Management → Betting Resources Links
把真实的链接名称/网址填进去——现在 KV 是空的,页面会显示"No link set
yet." / "No links set yet."。

**踩到并当场修掉的一个坑**:新工具卡片一开始跟其他卡片一样带了
`data-route="bettingResources"`,但 `spa-shell.js` 只认它自己
`ROUTES` 常量里显式登记过的路由——没登记的 `data-route` 点击后会静默
retreat 回首页(`!ROUTES[view]` 分支),等于点了没反应。这张卡片本来就
没打算做成 spa-shell 的原地挂载(不像 TG Reply Threads 那几个已有页
面),所以直接去掉了 `data-route`,让它走普通的整页跳转——没有引入新
bug,只是没有走跟其他卡片一样的"原地切换"效果。

## 🎨 首页工具卡片 — 改成 3 列布局 + 悬停特效

**布局改动**:`.tool-cards` 从 `repeat(2, 1fr)` 改成 `repeat(3, 1fr)`,
`max-width` 从 520px 放宽到 780px,响应式断点新增 860px(3列→2列)、
560px(→1列,跟之前一样)。卡片顺序按业主要求重排:

- 第1行:TG Reply Threads / Deposit Issue / Deposit Backup
- 第2行:Promo Code Search / Announcement / HeyVIP Betting Rules
- 第3行:Active Agents(单独一个)

**悬停特效**(纯 CSS,不依赖 JS,静止状态零开销):
- 卡片浮起(`translateY(-6px)` + 阴影加深)
- 边框流光——一圈 `conic-gradient` 遮罩成细边框,悬停时旋转
  (`animation-play-state` 平时是 `paused`,只有 hover 时才真正跑,
  所以一整屏卡片同时挂着这个规则也不会平白耗性能)
- 表面扫光——一道斜向光带扫过一次,悬停触发的一次性动画
- 悬停时卡片底部浮现 **"Open →"** 按钮,颜色跟随卡片自己的
  `--tool-accent`(每张卡本来就有这个变量,零新增)
- 加了 `prefers-reduced-motion` 兜底,系统开了"减弱动态效果"就直接
  关掉这些动画,只保留卡片本身可点

**紧凑化修订(同一天,业主反馈"卡片太高")**:图标从 36px 缩到 26px,
跟标题挪到同一行(新增 `.t-head` 包一层);描述文字最多显示 2 行、超出
省略(`-webkit-line-clamp`),不会把矮卡片撑得比高卡片矮很多;
"Open →" 按钮从单独一行挪到统计数字(unsolved/active/online)同一行、
右对齐(新增 `.t-bottom-row`,靠 `margin-top:auto` 固定在卡片底部);
`.tool-card` 加了 `min-height: 92px`,让内容少的卡片(比如 Deposit
Issue)不再显得空荡荡、跟内容多的卡片高度差一大截。

**涉及的文件(2 个)**:`public/assets/style.css`(`.tool-card` 整段
重写 + 新增 `.t-open`/两个 `@keyframes`)、`public/index.html`(每张
工具卡片加了 `<span class="t-open">Open →</span>`)。

## 已知缺口 / 待办

1. `betting_resources` 在 `FEATURE_STATUS_ITEMS` 里登记了,Settings 面
   板能看到这张卡片、也能把状态改成 Maintenance/Coming soon,但
   `functions/api/betting-resources.js` 目前**没有**真正检查这个状态
   ——就算在 Settings 里标成 Maintenance,`/api/betting-resources` 照样
   正常返回数据。如果需要这张卡片也支持真正的维护模式拦截,需要照着
   `deposit-issue.js` 之类现有端点的写法,在 `handleGet` 里加一段
   `getFeatureStatus(env, "betting_resources")` 检查。
2. KV 里还没有真实链接数据,需要业主在 Betting Resources Links 面板里
   手动填一遍。
3. 没有真实 Cloudflare/KV 环境可以端到端联调,这次只做了静态语法检查
   (`node --check` 过了所有新建/改动的 `.js` 文件)+ HTML 标签配对检查
   ——正式部署后建议按 README 的流程走一遍真实提交测试。
