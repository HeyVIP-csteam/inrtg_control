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

---

## 追加修复 3（2026-08-09）：Announcement 提示条不显示 + Promo/Deposit 页面样式丢失

**症状 A**：切到 TG Reply Threads / 表单 / 其他任意 SPA 页面后，顶部原本该
显示"FRIENDLY REMINDER"之类提示条的位置一直空白。

**根因 A**：`announcement-banner.js` 是壳（index.html）加载时只跑一次的脚本，
内部用 `document.getElementById("announcementBanner")` 去找挂载点。首页自己
（隐藏时也不会被移除）和每个 SPA 挂载页面各自都有一个 `id="announcementBanner"`
的容器——`getElementById` 在有重复 id 时永远只返回文档里第一个，也就是首页
那个（此时是隐藏的），内容全渲染进了看不见的地方，当前可见页面的那个容器
永远是空的。

**修复 A**：把脚本从"只认第一个 id"改成"当前 DOM 里所有同 id 容器都独立
渲染"（`document.querySelectorAll('[id="announcementBanner"]')` + 每次查找都
用 `slot.querySelector(...)` 限定在对应容器内部，避免多个容器共用同一批
`#annTextA` 等内部 id 时互相打架）。另外 `spa-shell.js` 现在每次挂载新页面
成功后，会立刻调用一次 `window.refreshAnnouncementBanner()`，让刚挂载出来的
容器马上补上内容，不用等最长 60 秒的下一次轮询。

**症状 B**：Promo Code Search / Deposit Issue / Deposit Backup 这三个页面切
进去后完全没有卡片样式，看起来像纯文字堆在左上角。

**根因 B**：这三个页面各自在自己的 `<head>` 里有一段页面专属的 `<style>`
（`.promo-shell`/`.promo-header-card`、`.dep-header-card` 等，不在公共
style.css 里）。`spa-shell.js` 挂载时只从抓回来的文档里选取 body 部分的
几个节点搬进 `#spaMount`，从没把这些页面专属的 `<style>` 标签一起搬过去，
所以这几个页面在 SPA 模式下渲染出来完全没有样式。threads/announcements/
form 因为所有样式都在公共 style.css 里，没有这个问题，之前没暴露出来。

**修复 B**：`mount()` 现在会在首次挂载某个路由时，把该路由文档里所有
`<style>` 标签克隆一份插进壳自己的 `<head>`（每个路由只插入一次，重复访问
不会重复插入）。

**验证**：模拟环境下确认 Home / Threads / Promo 三处的提示条内容完全一致
地正确出现；Promo 的 `.promo-shell`（max-width/padding）、`.promo-header-card`
（圆角/背景色）以及 Deposit Issue / Deposit Backup 的 `.dep-header-card`
计算样式均正确生效。又完整跑了一遍此前全部回归测试（6 路由挂载、工单消息、
前进后退、强制刷新），全部依旧正常。

---

## 追加优化（2026-08-09）：品牌 logo / 背景图瘦身

之前一直识别出但没动手改的性能问题，现在处理了。

**改了什么**：4 张品牌 logo（原始都是 640×640，但实际显示最大只有 32px）+
1 张背景图，只做了尺寸/压缩调整，没碰任何代码、文件名、路径：

| 文件 | 改动前 | 改动后 |
|---|---|---|
| `brands/kv8.png` | 339KB (640×640) | 17KB (128×128) |
| `brands/superbaji.png` | 149KB (640×640) | 16KB (128×128) |
| `brands/heybaji.png` | 140KB (640×640) | 11KB (128×128) |
| `brands/darazplay.png` | 142KB (640×640) | 10KB (128×128) |
| `bg-space.jpg` | 251KB | 202KB（quality 78→62，背景上一直盖着最深 75% 透明度的暗色渐变，肉眼看不出差别） |

128×128 是给这几个 logo 留的安全余量——它们目前最大的实际显示尺寸是
`.dep-brand-img`（Deposit Issue/Backup 页面）的 32px，128px 在 4 倍视网膜屏
下依然清晰,不会糊。文件名、路径完全没变（`DEFAULT_LOGOS`
`functions/api/brand-config.js`、`logoPath()` 这些引用都不用动）。

**总体积**：这 5 个文件合计从 ~1004KB 降到 ~255KB（省了 75%）。首页跑马灯
把 4 张大 logo 各重复渲染 4 份（36 个 `<img>` 里有 16 个是这几张大图），
之前每次加载/解码这些图片是实打实的主线程开销——这也是之前诊断"跑马灯
偶尔像加速/整体卡顿"最可能的根因,现在应该会明显缓解。

**验证**：跑了完整回归测试（6 路由挂载、工单消息、前进后退、强制刷新、
Announcement 提示条、Promo/Deposit 页面样式），全部依旧正常；跑马灯测速
在压缩后依旧稳定在 ~94px/s，没有引入新问题。压缩后的 logo 目视检查过，
清晰度没有明显损失。

---

## 关键修复（2026-08-09）：一直没重新生成资源版本号，导致改动实际没生效

**这是这几轮反复出现"修了但好像没生效/这次又不一样"的真正病根，我这边的操作疏漏。**

这个项目对 `/assets/*`（JS、CSS、图片全部在内）设置了一年不过期的强缓存
（见 `public/_headers`：`Cache-Control: public, max-age=31536000, immutable`）。
为了避免"文件改了但浏览器还在用旧缓存"，项目自带一个
`update-asset-versions.js` 脚本——每次改完 `assets/*.js`/`*.css` 都要手动
跑一次 `node update-asset-versions.js`，给引用的 URL 加上内容哈希
（`?v=xxxxxxxx`），文件内容一变哈希就变，URL 变了浏览器才会去请求新版本。

**我这几轮修改 `spa-shell.js`、`announcement-banner.js`、`style.css` 的时候
一直没有重新跑这个脚本。** 也就是说代码内容确实改了、也确实打进了压缩包，
但 HTML 里引用的 `?v=` 还是最早那一版的哈希——任何已经打开过一次网站的
浏览器，会一直复用缓存里的旧版本文件，不管重新部署多少次都不会自动更新，
除非手动强制刷新（Ctrl+Shift+R）清掉这几个具体文件的缓存。这就是为什么
"部署了却感觉没变化"反复出现。

**已修复**：跑了 `node update-asset-versions.js`，9 个 HTML 文件全部拿到
了正确的新哈希（例如 `spa-shell.js?v=a1356f9b` → `?v=48f41a93`，
`announcement-banner.js?v=1fe18b8d` → `?v=26c15118`，
`style.css?v=e4adca1a` → `?v=d4b055c1`）——这次部署之后，浏览器会自动去
拿最新版本，不需要用户手动强制刷新这几个文件。

**⚠️ 图片是个例外，仍然需要手动强制刷新一次**：`update-asset-versions.js`
只覆盖 `assets/` 目录下的 `.js`/`.css` 文件，不处理 `assets/img/` 下的图片
——上一轮压缩的 4 张品牌 logo + 背景图，URL 完全没变（还是原来的文件名，
没有 `?v=`），所以这几张图**依然会被浏览器按旧的一年缓存策略处理**。这次
部署之后，请所有坐席至少做一次 `Ctrl+Shift+R` 强制刷新，才能真正看到压缩
后的新图片——不然即使部署成功，浏览器还是会继续显示本地缓存里那几张几百
KB 的旧图。以后如果还要改图片，这个"图片不自动升版本"的缺口值得后续单独
处理（比如把 `update-asset-versions.js` 也扩展到覆盖图片），目前先靠一次
性强制刷新绕过。

**以后每次改动 `public/assets/*.js` 或 `*.css` 之后，打包前都必须重新跑
一遍 `node update-asset-versions.js`——这一步已经补上了默认流程里，后续
批次不会再漏。**

---

## 关键修复（2026-08-09）：跑马灯真正的根因——不是变快，是渲染了三万多个重复元素

**这个才是"跑马灯突然变快"的真正、完整的根因，之前的图片压缩只是缓解，没有
解决问题本身。**

用你描述的"在 TG Reply Threads 强制刷新、再回首页"这个具体操作精确复现
后，测出来的数字吓了一跳：正常情况下跑马灯轨道里应该有 54 个 logo 元素
（`brandRowTrack` 的子元素），但按你说的这个操作路径走一遍之后，
**变成了 34,578 个**。

**根因**：首页的 `renderBrandRow()` 函数（构建跑马灯）需要测量"一份 logo
组合有多宽"和"容器有多宽"，然后据此算出要重复渲染几份才能铺满、实现无缝
循环。但如果这个函数运行的时候，它自己所在的容器恰好是**隐藏的**
（`display:none`，宽度会被测成 0），代码原本的兜底逻辑会把 0 当成"还没
测出来"，退化成用整个浏览器窗口宽度去除以一个错误的"1px"当作每份宽度——
算出来要重复渲染近两千份才能"铺满"，实际执行时就变成了三万多个 DOM 节点。

**这恰好精确对应你说的操作路径**：直接用 `/?view=threads` 这个网址加载
页面（强制刷新时地址栏正是这个），此时 spa-shell.js 会自动把 threads
视图设为当前显示、首页设为隐藏——而 `renderBrandRow()` 又是在页面刚加载
时无条件执行一次的，不管首页当时是不是隐藏的。所以只要是"直接停在非首页
的地址上刷新"这个动作，就会 100% 触发这个 bug，之后不管什么时候回到
首页，看到的都是那三万多个元素在 26 秒里跑一圈——同样的动画时长，轨道
却宽了近千倍，视觉上自然就是"疯狂加速"，而且会一直保持这个错误状态，直到
真正整页刷新（这也是为什么你说"重新刷新之后就正常"——那次刷新如果停在
首页地址，就不会触发这个 bug，看起来就"恢复正常"了；但只要再回到"停在
threads 强制刷新"这个操作，就会复现）。

**修复**：
1. `renderBrandRow()` 加了一个前置检查——如果容器当前测出来宽度是 0（说明
   还没真正可见），直接跳过，不做任何测量/渲染，避免用错误数据算出离谱的
   重复份数。
2. `spa-shell.js` 现在每次导航**回到首页**时，都会重新调用一次
   `renderBrandRow()`（通过新暴露的 `window.renderBrandRow`）——这样等
   首页真正变回可见、能测出正确宽度的那一刻，会用真实数据重新构建一次，
   不会留着一个空的或者错误的轨道。

**验证**：精确复现了你描述的操作路径（直接停在 `/?view=threads` 强制
刷新 → 回首页），重复元素数量从 34,578 降到正常的 54 个，跟"从首页直接
打开"这个正常路径完全一致（1600px 宽度窗口下两种路径测出来的速度都是
~141px/s，完全吻合，之前是几十倍的差距）。又跑了一遍完整回归测试，全部
正常。

---

## 新功能（2026-08-09）：品牌跑马灯改为每个页面顶部常驻

**需求**：参考 INR 项目的效果——跑马灯不再只在首页显示，而是在 TG Reply
Threads / Promo / Deposit Issue / Deposit Backup / Announcement / 表单等
每个页面顶部（topbar 下面、提醒条上面）都能看到。

**实现方式**：

1. **首页/SPA 壳这边**：把跑马灯从 `#viewHome`（首页专属区域）挪到了
   index.html 的**常驻区域**（`</header>` 之后，跟 topbar、Account
   Management 编辑弹窗同级）。这样不管 SPA 壳当前显示的是首页还是别的
   任何视图，看到的都是同一个跑马灯，不需要每个视图各自重新渲染一份—
   —也顺带避免了再次触发之前那个"容器隐藏时宽度测成 0 导致渲染出三万多
   个重复元素"的 bug（因为这个跑马灯现在永远不会被隐藏了）。

2. **6 个独立子页面**（threads.html / announcements.html / promo.html /
   deposit-issue.html / deposit-backup.html / form.html）：新增了一个
   共享脚本 `public/assets/brand-row.js`，逻辑上是首页那份的简化版——
   只显示 logo + 品牌名，点击跳转到配置的链接，**没有**首页那个编辑
   铅笔图标（编辑品牌 logo/链接目前还是只在首页能操作，没有把整套编辑
   弹窗也搬到 6 个页面上，避免不必要的重复 UI）。这 6 个页面各自的挂载
   点用的是 `id="pageBrandRow"`，跟首页的 `id="brandRow"` 特意用了不同
   的 id——这样即使某天两者同时出现在同一个页面里（比如 SPA 挂载时），
   也不会互相冲突或者被对方覆盖。

3. 每个子页面自己的 `<style>` 里都加了 `flex-shrink:0`，保证跑马灯不会
   在窗口变窄时被意外压缩。

**为什么 SPA 模式下不会重复显示两个跑马灯**：SPA 挂载某个视图时，只会
把该页面 `.threads-sidebar`/`.subpage-right-col` 之类的内容节点搬进
`#spaMount`，每个子页面自己 `pageBrandRow` 所在的 topbar 区域根本不在
搬运范围内，所以 SPA 模式下只有首页那个常驻跑马灯在起作用；`
brand-row.js` 在 SPA 模式下依然会跟着页面脚本一起重新执行一次，但因为
找不到 `#pageBrandRow` 这个元素，会安全地什么都不做（跟 `hub-nav.js`
处理 `#hubNavMount` 的方式完全一样）。只有**直接访问**（书签/新标签页/
不经过 SPA 壳）这 6 个页面时，`brand-row.js` 才会真正派上用场。

**验证**：
- SPA 模式下点遍全部 6 个路由，确认全程只有 1 个 `#brandRow` 元素、
  内容正确（54 个 logo pill），没有 `#pageBrandRow` 意外混进来
- 6 个子页面分别用真实 URL 直接打开（不经过首页），各自的 `#pageBrandRow`
  都正确渲染出 54 个 logo pill，0 条 JS 报错
- 完整跑了一遍此前全部回归测试（Loading 重试、Announcement 提示条、
  Promo/Deposit 样式、跑马灯速度一致性），全部依旧正常

---

## 布局修复（2026-08-09）：跑马灯不该压在侧边栏上面

**症状**：加了跑马灯常驻功能之后，跑马灯是横跨整个页面顶部的（从最左边
到最右边），把侧边栏也盖在了下面/后面，视觉上很怪。

**根因**：我最初的实现是把跑马灯放在 `<body>` 的顶层，跟 topbar 同级、
在 `.hub-layout`（侧边栏+内容区）**外面**——这样它自然就横跨了全宽，
包括侧边栏那一段宽度。但参考你发的 INR 项目截图，正确的布局应该是跑马灯
只occupy侧边栏右侧那一栏的宽度，跟侧边栏是左右并排的关系，不是压在上面。

**修复**：把跑马灯从"跟侧边栏同级的顶层元素"改成"嵌进侧边栏右侧的内容
列里"——新增了一层包裹容器（`.hub-content-col` / `.subpage-content-col` /
`.threads-content-col`，视具体页面布局而定），跑马灯是这层容器的第一个
子元素，容器本身跟侧边栏左右并排。首页、6 个独立子页面（无论是 SPA 模式
下访问还是直接打开）全部同步改了这个结构。

**验证**：测量了跑马灯和侧边栏的实际像素位置——现在无论首页、SPA 模式下
的 Threads、还是直接打开 threads.html/promo.html，跑马灯的左边缘都精确
贴着侧边栏的右边缘（1600px 宽度窗口下都是 sidebar 右边界=290px，跑马灯
左边界=290px，完全对齐），不再有覆盖侧边栏的情况。截图确认视觉效果跟
参考图一致。又跑了一遍完整回归测试（6 路由挂载、Announcement 提示条、
Promo/Deposit 专属样式、跑马灯速度一致性），全部依旧正常。
