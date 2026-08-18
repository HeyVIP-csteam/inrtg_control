# Activity Logs — 站内审计日志

新增一个站内审计日志功能：记录"谁在什么时候、从哪个 IP、做了什么操作"，
按分类/Agent/关键词筛选，分页浏览，90 天自动清理。覆盖 Auth / Account /
Thread / Config 四大类操作。

## 1. 存储 — 沿用"一条日志一个 KV key"，不踩并发写入的坑

`functions/_shared/activityLog.js` 是新建的核心模块。跟旧版工单列表的
`"index"` 单 key 缓存不同（那个 key 每秒最多写 1 次，多个 agent 同时操作
会被限速），这次每条日志是独立的 KV key：

```
key:      activitylog:<13位毫秒时间戳>:<4位随机字符>
value:    "1"          ← 占位，真正数据不在这
metadata: { ts, category, action, agent, detail, ip }
```

`listActivityLog()` 用 `list()` 拿回每条 key 的 metadata，不用对每条日志
再单独 `get()`。读/写时按 5% 概率抽样触发一次 90 天过期清理
(`sweepExpired`)，不需要额外的 cron。

所有写入都包在 try/catch 里，且统一走 `waitUntil()` 做 fire-and-forget——
日志写失败绝不能拖慢或搞崩真正的业务操作。

## 2. 权限——挂在 OWNER_TOPIC_ITEMS，不是 ADMIN_SECTIONS_LIST

一开始按最初的参考文档打算加进 `ADMIN_SECTIONS_LIST`（IP Access / TG
Routes 那一挂），但这个功能实际要的权限模型是"默认只有 Owner 能看，其他
角色一律看不到，除非 Owner 逐账号勾选、且可以下放给**任意角色**、没有
rank floor"——这跟 `ADMIN_SECTIONS_LIST`（永远要求先过 floorRank 门槛）不
是一回事，反而完全就是本项目里 `OWNER_TOPIC_ITEMS` 已经在用的模型
（Announcements / Active Agents / Integration Portal 那几个）。所以最终把
`activityLogs` 加进了 `OWNER_TOPIC_ITEMS`（`functions/_shared/accounts.js`
+ `public/index.html` 里镜像的客户端副本），走 `canAccessOwnerTopic()`。

服务端 `functions/api/admin/activity-logs.js` 的 GET 接口独立校验一次
`canAccessOwnerTopic(account, "activityLogs")`——前端的隐藏只是"藏起来"
那一半，真正的边界在这。

## 3. 页面 — 三张独立卡片，不是一个大卡片

`public/activity-logs.html`：标题卡 / 筛选栏（单行不换行）/ 结果卡
（表格 + 分页），跟 Promo Code Search 页面一样的卡片节奏。表格列宽照抄
参考文档里"除 Detail 外都 `white-space:nowrap` 不设死宽，Detail 单独吃
剩余空间"的做法，避免长徽章撑破列边界。分页直接复用 IP Access 面板已有
的 `.ipa-page-size` / `.ipa-pagination` / `.row-btn` / `.ipa-page-indicator`
样式，没有重新发明一套。Refresh 按钮复用全站已有的 `.icon-btn
.icon-btn-labeled` 转圈动画（`.icon-btn-glyph.spinning`），没加新 CSS。

页面专属的 `.actlog-*` 样式放在 `activity-logs.html` 自己 `<head>` 里的
`<style>` 块，不是塞进共享的 `public/assets/style.css`——这是本项目
`spa-shell.js` 自己文档里写明的既有惯例（promo.html/deposit-issue.html
都是这么干的：`injectPageStyles()` 只会把每个视图自己 `<head>` 里的
`<style>` 标签复制进主文档，共享表里不需要也不应该塞入页面专属规则）。

## 4. SPA 路由接入 + 一个顺手修的移动端抽屉 bug

`public/assets/spa-shell.js` 里 `ROUTES` 加了一条
`activityLogs: { url: "/activity-logs.html", select: ".actlog-shell" }`
（非 fullBleed——三张卡片的布局，不是带侧栏的 app-shell）。

`public/index.html` 侧边栏 Account Management 展开菜单下加了
`#subActivityLogs`，直接用 `data-route="activityLogs"`，不像同组里其他
子项那样自己写 `addEventListener` 打开 modal。

**顺手发现并修的 bug**：`#hubSidebar` 里原有一个"点了侧边栏任何东西就
关掉移动端抽屉"的冒泡监听器，注释写着"不管是 data-route 的 SPA 视图还是
真实跳转都会关"——但这句话其实是错的：`spa-shell.js` 自己在 `document`
的 **capture** 阶段监听 `[data-route]` 点击，抢在事件冒泡到 sidebar 之前
就用 `stopImmediatePropagation()` 把事件截胡了，sidebar 那个冒泡监听器
根本没机会跑。这次是本项目第一次有 `.sidebar-subitem` 用上
`data-route`，这个坑之前一直没被踩到。修法：不去依赖 sidebar 自己的
冒泡监听器，改成 `spa-shell.js` 的点击处理器里直接、通用地把
`#hubSidebar` / `#sidebarBackdrop` 的 `open` 类摘掉——以后侧边栏里任何
新的 `data-route` 项都自动带上这个行为，不用每次都记得单独处理。

## 5. Agent Profile 的 Topic access 勾选框

`OWNER_TOPIC_ITEMS` 数组本来就是用 `.map()` 动态渲染 Agent Profile 里的
勾选框列表（`ownerTopicChecks`），所以往数组里加一项 `activityLogs`
之后，Owner 就能在每个账号的 Agent Profile 里看到并勾选这个新 topic，
不需要在渲染逻辑那块再写任何新代码。

## 6. 打点覆盖的文件（新建 + 改动）

| 文件 | 改动 |
|---|---|
| `functions/_shared/activityLog.js` | 新建：写入/查询/清理 |
| `functions/_shared/accounts.js` | `activityLogs` 加进 `OWNER_TOPIC_ITEMS` |
| `functions/api/admin/activity-logs.js` | 新建：GET 接口 + 权限校验 |
| `functions/api/auth/login.js` | 登录成功/失败(3种)/自动锁号 |
| `functions/api/account/change-password.js` | 自助改密 |
| `functions/api/admin/accounts.js` | 创建/删除/改角色/改权限(6种)/锁号/解锁 |
| `functions/api/threads/[id].js` | 工单 delete/reply/editRoot/editDetails/recallRoot/editReply/recallReply（solve/unsolve 不打点，见下方追记） |
| `functions/api/submit.js` | 新建工单（一次提交只打一条） |
| `functions/api/admin/routes.js` | TG 路由改/重置 |
| `functions/api/admin/deposit-sheets.js` | Gsheet 路由改/重置 + 本月备份表 |
| `functions/api/admin/offices.js` | Office（含 IP 白名单）增删改 |
| `functions/api/admin/ip-access.js` | approve/reject/block/unblock/manualAdd/remove |
| `functions/api/admin/announcements.js` | 公告增删改 |
| `functions/api/admin/announcement-settings.js` | 公告轮播速度 |
| `functions/api/brand-config.js` + `functions/api/admin/web-links.js` | 品牌链接编辑（两条写入路径都打点，见 `saveLink()` 共用） |
| `functions/api/admin/betting-resources.js` | Betting Resources 链接列表 |
| `functions/api/admin/backfill-mentions.js` | 批量回填（只在最后一页打一条，不是每 100 条打一次） |
| `public/activity-logs.html` | 新建：页面本体 |
| `public/assets/spa-shell.js` | 加 `activityLogs` 路由 + 移动端抽屉修复 |
| `public/index.html` | 侧边栏子项 + `OWNER_TOPIC_ITEMS` 客户端副本 + 可见性判断 |

## 7. 追记：solve/unsolve 不再打点

`Ticket Solved` / `Ticket Reopened` 从活动日志里去掉了 —— 这两个动作是
每张工单都会触发一次的高频常规操作（解决一张工单就打一条),
把日志列表刷成清一色的 "Ticket Solved",反而把真正需要盯的操作
（edit / delete / recall）淹没掉了。现在 Thread 分类下只保留这几种打点:

- `Ticket Deleted`
- `Ticket Edited`（`editRoot`）/ `Ticket Details Synced`（`editDetails`，
  本质也是编辑,所以保留)
- `Ticket Recalled`（`recallRoot`）
- `Reply Edited`（`editReply`）
- `Reply Recalled`（`recallReply`）

改动只在 `functions/api/threads/[id].js` 的 `solve`/`unsolve` 分支里删掉
了 `log(...)` 那一行,其余逻辑(设置已解决状态、返回结果)不变。旧数据
里已经写进 KV 的历史 `Ticket Solved`/`Ticket Reopened` 记录不会被清
除,只是从这次改动往后不会再新增。
