# Announcement 功能 — 设置说明

从独立的 spec（`announcement-feature-spec.md`）移植进本项目（INR Issue Hub）后新增/改动的内容。

---

## 1. 新增文件

**后端：**
- `functions/_shared/announcements.js` — KV 数据层（复用现有 `THREADS_KV`，无需新建 namespace）
- `functions/api/announcements.js` — 公共 banner 接口，`GET /api/announcements`，任何已登录账号可调用
- `functions/api/admin/announcements.js` — 管理端 CRUD，`GET/POST /api/admin/announcements`
- `functions/api/admin/announcement-settings.js` — 轮播速度设置，`GET/POST /api/admin/announcement-settings`

**前端：**
- `public/assets/announcement-banner.js` — 每个页面顶部的 amber "REMINDER" banner
- `public/assets/toast.js` — 居中弹出式提示（`window.showToast(message, type)`）
- `public/announcements.html` — 管理页面（左侧列表 + 右侧固定表单）

---

## 2. 改动的现有文件

- `functions/_shared/accounts.js` — 在 `ADMIN_SECTIONS_LIST` 里新增了 `"announcements"`（floor: admin），并在
  `ADMIN_SECTIONS_DEFAULT_SEEN`/`ADMIN_SECTIONS_DEFAULT_EDIT` 的 `admin` 分支里单独给了它「默认可见+可编辑」的档位
  （跟 `whitelistIp` 默认只读不同）。`EDITABLE_ADMIN_SECTIONS` 也加了这一项。
- `functions/_shared/featureStatus.js` — 新增 `announcements` 这个 Maintenance/Coming-soon 可控项，专门用来控制
  banner 接口本身（关掉时 `/api/announcements` 对非 bypass 角色直接返回空数组，不是 403）。
- `public/index.html` —
  - 顶部新增 `#announcementBanner` 挂载点（放在首页的品牌跑马灯下面）
  - Tool cards 网格第一位新增「Announcement」卡片，默认隐藏，按 `canSeeAdminSection("announcements")` 显示；
    有活跃公告时图标会用现成的 `breathe` 动画呼吸
  - Settings 弹窗里新增了「Announcement rotation speed」控制块（跟 Maintenance/Coming-soon 同一个 tab，但权限走
    `"settings"` 这个 section，不是 `"announcements"` —— 管公告内容和管 banner 行为是两件事）
  - 客户端的 `ADMIN_SECTIONS_LIST`/`ADMIN_SECTIONS_DEFAULT_SEEN`/`ADMIN_SECTIONS_DEFAULT_EDIT` 镜像同步加了
    `"announcements"`（纯 UI 体验用，服务端每次请求都会独立重新校验）
- `public/threads.html`、`public/promo.html`、`public/deposit-issue.html`、`public/deposit-backup.html`、
  `public/form.html` — 各自在 `</header>` 后加了 `#announcementBanner` 挂载点，并在 body 末尾引入
  `toast.js` + `announcement-banner.js`
- `public/assets/style.css` — 追加了 banner / toast / 管理页面三块样式，以及一个通用的 `.breathing` 帮助类

---

## 3. 环境变量（可选，仅用于审计日志）

在 Cloudflare Pages 项目设置里新增（跟项目里其他 Google Sheets 集成共用同一个 service account，无需新密钥）：

```
ANNOUNCEMENT_LOG_SHEET_ID   # 可选 —— 从 Sheet 网址里取出的 Sheet ID；不填就完全跳过审计日志
ANNOUNCEMENT_LOG_TAB        # 可选 —— 默认 "Log"
```

日志是 best-effort、非阻塞的：Sheet 写入失败不会导致公告保存/删除失败，应用本身也从不读回这个 Sheet。

---

## 4. 权限模型（谁能看/改公告）

跟账号管理其余 4 项完全一样的模式（见 `_shared/accounts.js` 顶部注释）：
- **floor**：admin 及以上的账号才可能看到「Announcements」这一项
- **默认档位**：admin 默认「可见 + 可编辑」，superadmin 默认「可见 + 可编辑」，owner 永远全权限
- Owner 仍可以对具体账号单独覆盖（`allowedAdminSections` / `adminSectionEditAccess`），比如把某个 admin 降成
  view-only，或者单独给某个 senior 开权限

管理页面本身（`announcements.html`）没有额外的路由保护 —— 依赖 `/api/admin/announcements` 的服务端权限检查；
没有权限的账号打开页面会看到「You don't have access to Announcements.」而不是拿到数据。

---

## 5. 排期（Scheduling）设计

没有 cron job，也不需要。`isEffectivelyActive()` 在每次读取时（每次 banner 轮询）实时计算：

```js
export function isEffectivelyActive(a, now = Date.now()) {
  if (!a.enabled) return false;
  if (a.startAt && now < new Date(a.startAt).getTime()) return false;
  if (a.endAt && now > new Date(a.endAt).getTime()) return false;
  return true;
}
```

`enabled` 是独立的手动总开关，跟排期无关 —— 关掉它会立刻隐藏 banner，不管 startAt/endAt 是什么。
