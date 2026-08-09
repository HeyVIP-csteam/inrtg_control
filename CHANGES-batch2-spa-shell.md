# 第二批优化：index.html 变成常驻 SPA 壳

解决的问题：点击 "TG Reply Threads" 等工具卡片时，整个页面会真的重新加载
（Topbar/侧边栏跟着一起消失重来），用户反馈"感觉像跳转到了另一个页面"、
"logo 会闪一下不见"——根因是这个项目一直是纯多页应用（每个页面是独立
static HTML 文件），不是 SPA。这次把 `index.html` 改造成常驻壳，参考
`spa-shell-pattern-guide.md` 的模式落地。

---

## 核心改动

**新增 `public/assets/spa-shell.js`**（只在 `index.html` 里加载）：

点击任何 `[data-route]` 元素时，不再是真实的 `<a href>` 跳转，而是：
1. `fetch()` 目标页面的完整 HTML
2. 用 `DOMParser` 解析，只挑出该页面**独有**的内容节点（比如
   `threads.html` 的 `.threads-sidebar` + `.threads-right-col`，
   `form.html` 的 `.subpage-right-col`）——**不**包含它们自己的
   Topbar/导航栏（那些是每个子页面独立访问时才需要的，SPA 模式下复用
   壳自己的）
3. 挂进 `#spaMount`，`new Function()` 重新执行该页面自己的 `<script>`
   （包括 `/assets/app.js` 这种外部但页面专属的脚本）

```js
const ROUTES = {
  threads: { url: "/threads.html", select: ["#attachLightbox", ".threads-sidebar", ".threads-right-col"] },
  announcements: { url: "/announcements.html", select: [".threads-sidebar", ".threads-right-col"] },
  promo: { url: "/promo.html", select: [".subpage-right-col"] },
  deposit_issue: { url: "/deposit-issue.html", select: ["#imgLightbox", ".subpage-right-col"] },
  deposit_backup: { url: "/deposit-backup.html", select: ["#imgLightbox", ".subpage-right-col"] },
  form: { url: "/form.html", select: [".subpage-right-col"] },
};
```

**URL 规则**（照抄 spa-shell-pattern-guide.md 踩过的坑）：`pushState`
永远只改 `/` 这个壳自己的路径 + query string（`/?view=threads`、
`/?view=form&module=qa`），绝不指向某个子页面的真实文件路径——这样
**刷新页面永远还是加载这个壳**，不会掉回一个没有壳的独立页面。壳的
`DOMContentLoaded` 里会读这个 `?view=` 自动恢复对应视图。

**index.html 自身的改动**：
- `.hub-layout` 里原本的 `.hub-right-col`（首页内容）加了 `id="viewHome"`
- 新增一个 `id="spaMount"`，平时 `display:none`，切视图时和 `viewHome`
  互相切换显示/隐藏
- 侧边栏的 Home 链接、5 张工具卡片（TG Reply Threads / Promo / Deposit
  Issue / Deposit Backup / Announcement）都加上了 `data-route`
- 动态生成的模块链接（QA / Account Issue / … 那一串）从"点击后延迟
  200ms 再整页跳转"改成 `data-route="form" data-module="<id>"`，交给
  `spa-shell.js` 的统一点击拦截处理
- 所有这些元素的 `href` **依然保留**（依然是真实可用的链接，只是普通
  左键点击会被拦截走 SPA 路径；Ctrl/Cmd+点击、中键新开标签、右键复制
  链接都还是原生浏览器行为，不受影响）

---

## 过程中修的两个真实 bug

### 1. `initThemeToggle()` / `initClock()` 重复绑定监听器

每个子页面自己的 `<script>` 里都会调用 `window.initThemeToggle()`。
以前每个页面只加载一次，天然没事；但 SPA 模式下同一个 Topbar 按钮/
时钟元素全程不销毁，反复切换视图 = 反复调用这两个函数 = **在同一个
按钮上越叠越多click监听器**。实测：连续切 3 次视图后点一次主题切换
按钮，因为叠加了偶数个监听器，点了跟没点一样（互相抵消）。

**修复**：给这两个函数加了"已经绑定过就不再绑第二次"的 guard
（`btn.dataset.wired` 标记），`assets/theme.js`：
```diff
   setLabel();
+  if (btn.dataset.wired) return;
+  btn.dataset.wired = "1";
   btn.addEventListener("click", () => { ... });
```
`initClock()` 同样处理。Playwright 验证：连续切 3 次视图后点一次主题
按钮，确认正确切换（不再抵消）。

### 2. 图片预览弹窗（lightbox）被裁到 Topbar 下面

`threads.html` 的 `#attachLightbox`、`deposit-issue.html`/
`deposit-backup.html` 的 `#imgLightbox` 都是 `position:fixed; inset:0`
的全屏浮层，挂进 SPA 壳之后一度量出来只有 `top:57`（卡在 Topbar 下面），
不是覆盖整个视口。

根因：`.hub-layout` 有一个 `page-slide-in` 入场动画 class，动画用
`animation-fill-mode: forwards`，结束后 `transform: translateX(0)`
永久留在元素上——即使数值上"没有位移"，**光是存在 `transform` 属性
就会让这个元素变成它内部所有 `position:fixed` 后代的新定位基准**，
而不是真正的浏览器视口。这个副作用以前从来没暴露过，因为 `.hub-layout`
内部从来没有任何 `fixed` 定位的元素——直到这次把两个 lightbox 挂进来。

**修复**：入场动画播完之后（350ms，比动画时长 0.28s 留一点余量）
自动把 `page-slide-in` 这个 class 摘掉，视觉上没有任何变化，只是不再
继续充当"定位容器"：
```js
const layout = document.querySelector(".hub-layout");
if (layout) setTimeout(() => layout.classList.remove("page-slide-in"), 350);
```
Playwright 验证：两个 lightbox 打开后量出来都是 `top:0, height:800`
（完整视口），不再被裁切。

---

## 验证方法（Playwright，全部通过）

- 在 `window` 上打一个标记，点击 TG Reply Threads → QA 表单 → 浏览器
  后退两次，标记全程存活 → 证明**从未发生真正的整页刷新**
- URL 正确变化：`/` → `/?view=threads` → `/?view=form&module=qa`，
  浏览器前进/后退按钮工作正常
- 强制刷新（F5）停留在 `?view=threads`，内容、侧边栏、logo 全部正确
  恢复（这正是用户最初反馈的"logo 消失/像跳转页面"的场景）
- 6 个路由挂载后经过短暂 loading 态都能正确渲染各自的独有内容
- 两个 lightbox 挂载后位置/尺寸正确（见上）
- 主题切换按钮在反复视图切换后依然正确工作（见上）
- 全程 0 条 JS 报错

---

## 已知的取舍/限制

- 只有**从壳内部点击**才会走 SPA 路径。直接在地址栏输入
  `/threads.html`、书签、外部链接打开某个子页面，依然是完全独立、
  完整可用的一次真实页面加载（这些子页面本身没有任何改动，
  `hub-nav.js` 那套独立导航栏还在，Account Management 的 `/?admin=`
  深链机制也还在）——SPA 只是"锦上添花"的体验优化，不是这些页面唯一
  能工作的方式，出问题可以直接把 `data-route` 属性删掉整体回滚，不
  影响任何页面独立可用。
- 每次切视图都会重新执行该页面的 `<script>`（包括重新 fetch 一次数据），
  不是"保留状态"式的 SPA——比如从工单详情切到别处再切回来，会重新
  拉取最新的工单列表，而不是恢复切走前的滚动位置/选中状态。这是有意
  的简化，换取更低的实现复杂度和更少的潜在 bug（详见 spa-shell.js 里
  关于 setInterval/事件监听器清理的注释）。

---

## 追加修复（2026-08-09）：SPA 挂载后工单列表空白

**症状**：部署后点击 TG Reply Threads（以及其余所有走 SPA 的路由）看不到任何工单/内容，看起来像是"坏了"。

**根因**：`spa-shell.js` 的 `SHELL_OWNED_SCRIPTS` 把 `/assets/hub-nav.js` 误列为
"壳已经加载过，不用再执行"——但 index.html（壳本身）其实从来没有引入过
`hub-nav.js`，它只是 threads.html / announcements.html / promo.html /
deposit-issue.html / deposit-backup.html / form.html 这些**独立子页面**
用来渲染自己那份侧边栏的公用组件。

这些子页面的 `<script>` 开头无一例外都是：
```js
window.HubNav.mount("hubNavMount", {});
```
SPA 模式下 `window.HubNav` 从未被定义，这一行直接抛 `TypeError`，而这行
代码和后面加载工单列表/表单字段等全部逻辑都写在**同一个 `<script>`
标签**里——一崩全崩，后面的代码一行都没跑,所以看起来"选了 TG Reply
Threads 但什么都没有"。6 个路由全部受影响，不只是 threads。

**修复**：把 `/assets/hub-nav.js` 从 `SHELL_OWNED_SCRIPTS` 里移除，让它
在每次 SPA 挂载时正常加载执行。`HubNav.mount()` 本身在目标元素
（`#hubNavMount`）不存在时会直接 no-op 返回（SPA 模式下这个元素确实不
存在，因为壳用自己常驻的侧边栏，`#hubNavMount` 被故意排除在每个路由的
`select` 列表之外）——所以这个改动不会产生重复侧边栏，只是让脚本不再
一开局就崩溃。

**验证**：本地起了一个模拟后端 + Playwright，覆盖：
- 6 个路由（threads/announcements/promo/deposit_issue/deposit_backup/form）
  逐个点击挂载，0 条 JS 报错
- 点开一个工单，标题/元信息/对话内容正确渲染
- 浏览器后退正常回到上一视图
- 停留在 `?view=threads` 时强制刷新，URL 不变、工单列表正确重新显示
  （这正是最初反馈的"logo 消失/像跳转"场景的姊妹问题——同一批改动引入，
  现在一起验证过了）

---

## 追加修复 2（2026-08-09）：点击 Topic 进入表单偶尔卡在 Loading

**症状**：点击侧边栏的某个 Topic（QA / Account Issue / …）进入表单，有时候正常，
有时候画面停在"Loading…"不动，没有任何报错提示，也点不出别的反应。

**根因**：`spa-shell.js` 的 `mount()` 函数里，`await getDoc(view)`（拉取目标
页面 HTML）和 `await getScriptText(path)`（拉取该页面自己的脚本文件）完全
没有错误处理。这两次网络请求只要有一次失败——哪怕只是一次偶发的网络抖动、
Cloudflare 边缘节点的瞬时问题——`mount()` 这个 Promise 就直接 reject，而
此时界面已经被设成 `<div class="spa-loading">Loading…</div>`，reject 之后
没有任何代码去处理这个状态，画面就永远卡在这里，唯一的痕迹是控制台里一条
不会被任何人看到的 `mount failed: TypeError: Failed to fetch`。用 Playwright
模拟了一次请求失败，完整复现了这个"卡住不动"的现象——6 个 SPA 路由全部有
这个隐患，不只是表单。

**修复**：把整个"拉取页面 + 拉取并执行脚本"的流程包进一个 try/catch。失败
时不再留一个死掉的"Loading…"，而是换成明确的错误提示 + "Retry" 按钮，点击
后会重新走一遍 `mount()`（复用同样的 view/module 参数），网络恢复后立刻能
接着用，不需要整页刷新。脚本内部自身的运行时错误（跟网络无关的 bug）依然
只影响那一个脚本、不影响同一视图里其它脚本继续执行——这部分行为没有变。

**验证**：
- 模拟 `/form.html` 请求失败一次：确认界面正确显示"Couldn't load this
  page. Check your connection and try again." + Retry 按钮，而不是卡死的
  Loading
- 点击 Retry 后成功重新拉取并正常渲染表单（QA 模块标题/字段正确出现）
- 完整跑了一遍此前的回归测试（6 个路由挂载 + 打开工单看消息 + 前进后退 +
  停留在 threads 强制刷新），全部依旧正常，这次修复没有引入新问题
