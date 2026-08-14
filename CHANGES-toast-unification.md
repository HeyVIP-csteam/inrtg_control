# Toast 统一化 — 应用到 INR 项目的改动记录

依据 `feedback-toast-system-design.md` 对整个项目做了一遍枚举 + 收口。做法是先全局
grep `alert(`、`showToast(`、以及各页面自己写的 note/status 元素赋值，把每一处现状
列出来，再逐个判断"该不该统一、该不该保留例外"，而不是只改用户报出来的那一处。

## 1. 核心组件：`public/assets/toast.js` + `public/assets/style.css`

改之前，`showToast()` 不管 `ok` 还是 `err` 都是固定 2 秒后自动消失——并没有真正实现
设计文档里最关键的那条规则（失败不应该自动消失，需要用户点击关闭）。改成：

- **ok**：3 秒后自动消失（原来是 2 秒）。
- **err**：不再有计时器，改成全局 `document` 点击监听关闭（`capture:true`，因为
  overlay 本身是 `pointer-events:none`，不会直接收到点击），卡片上加一行
  "Click anywhere to dismiss" 提示；每次调用前先清掉上一次的监听器，避免"这次操作
  成功了，上一次错误状态的点击监听器还挂着"这种诡异 bug。
- CSS：err 状态遮罩更暗（`rgba(0,0,0,0.32)` vs ok 的 `0.12`）、卡片改成 2px 红色
  实线边框 + 淡红底色，让它在视觉上明显比 ok "更重"，配合"需要点击才能关掉"的行为。

## 2. 枚举现状时发现的真实 bug（不只是风格不统一，是功能缺失）

### `public/accounts-admin.html` —— 完全没接入统一 toast 的孤岛页面
这个页面压根没有 `<script src="/assets/toast.js">`，`deleteAccount` /
`deleteOffice` 甚至**没有检查响应就直接当成功处理**（不检查 `data.ok`，也没有任何
成功反馈）；`setAccountLock` 用的是原始 `alert()`，同样没有成功反馈。这正是设计文档
开篇提到的"某些页面(尤其是后来单独开发、没跟主逻辑复用的页面)图省事直接用了最原始
的阻塞式弹窗"的真实案例。

修复：接入 `toast.js`；新增一个页面内共用的 `setAdminMsg(msgEl, text, cls)` 函数
（对齐 `index.html` 的 `setAcctNote` 写法），把"该不该同时弹 toast"这个判断收进
一个函数里；`deleteAccount`/`deleteOffice` 补上了响应检查 + 成功/失败 toast；
`setAccountLock` 的失败提示从 `alert()` 换成 toast，并补上了此前完全没有的成功
提示（文案根据这次实际锁的是 Lock 还是 Unlock 动态生成，不是写死的字符串）。

### `public/index.html` 的 `setAgentLock` —— 同一个 bug 的另一份拷贝
和上面 accounts-admin.html 的 `setAccountLock` 是同一个功能的另一份实现，同样的
问题：失败用 `alert()`，成功完全没反馈。同样修成 toast + 动态 Lock/Unlock 文案。

### `public/threads.html` —— 五个动作只有失败提示、没有成功提示
`deleteThread`、`editRoot`、`recallRoot`、`editReply`、`recallReply` 全部是失败时
`alert()`，成功时界面悄悄更新、什么反馈都没有。全部改成走统一 toast，成功/失败都有
提示；纯输入校验的 `alert("Text can't be empty.")` 保留不动（属于设计文档 §7 例外1）。

### `public/threads.html` 的"Sync to Sheet"编辑弹窗 —— 陷阱1 的真实实例
`openEditDetailsModal` 里失败时**同时**把错误文案写进弹窗内的 `statusEl` 常驻文字
**又**弹了一次内容几乎相同的 toast——这就是设计文档第一节描述的那个原型 bug
（"点一下 Save,底部文字弹出'Saved.',同时中间又弹出一个居中气泡也写着'Saved.'"）。
现在失败时只保留 toast，`statusEl` 清空（`statusEl` 仍然保留给"必填字段未填"这类
提交前的校验，那一步本来就没有弹 toast，不冲突）。

### `public/threads.html` 的"Generate to another Topic"（转发）弹窗 —— 完全没接 toast
这是设计文档文案规范表里明确列出的标准动作类型之一（"转发/生成"），但这个弹窗此前
完全没有 toast：失败只有弹窗内的 `statusEl`，成功只是跳转到新工单，没有任何一次点击
瞬间的确认。补上了失败/成功 toast（失败时同步清空 `statusEl`，避免又制造一次陷阱1）。

### `public/deposit-issue.html` —— 页面自己发明了一套独立的"toast"
`showT(id, ok, msg)` 是这个页面自己写的、和全局 `showToast()` 完全独立的第二套反馈
组件（`.dep-toast` / `.dep-tok` / `.dep-ter`，渲染在提交按钮下方的固定 `#depT`
元素里），即使这个页面本身已经加载了 `/assets/toast.js` 也没用上——这正是设计文档
开篇"三套并存、互不统一"问题的真实案例，只是这次是"局部自建的第三套"而不是原生
`alert()`。

修复：把 `showT()` 改成一个薄封装，直接调用统一的 `window.showToast()`；删掉了
不再需要的 `#depT` 元素和 `.dep-toast`/`.dep-tok`/`.dep-ter` 这三条死 CSS 规则。

### `public/assets/app.js` 的表单提交 —— 陷阱1 的又一个真实实例
提交表单成功/失败时，`#statusMsg`（页面内常驻文字）和 `showToast()`
**同时**渲染内容高度重叠的文案（失败分支甚至是完全相同的 `err.message`）。

修复：结果只走 toast，`#statusMsg` 在结果分支里清空——它仍然保留给"附件超过大小
限制"这类提交前的输入校验（`addFiles()`），那是设计文档 §7 例外1 的场景，不受影响。
Telegram 发送成功但 Sheet 记录失败这种"部分失败"的具体原因，原来是靠常驻文字才能
看全的，现在直接整合进了 err toast 的文案本身——因为 err toast 已经改成不自动消失、
需要点击才关闭了，符合设计文档 §7 例外2 里"如果失败 toast 本身已经不自动消失，这类
详细信息可以直接整合进 toast 文案里"的判断标准。

## 3. 确认过、但刻意没有改动的地方（不是漏改，是例外）

- `threads.html` 的 `sendReply()`——回复发送失败沿用原生 `alert()`。这是聊天式的
  高频连续操作，如果每次失败都要点一下页面才能关掉提示，在这个场景里会变成明显的
  打扰；已在代码里补了注释说明这是设计文档 §7 例外1，防止以后被当成"漏改的 bug"
  又被"修复"回去。
- `threads.html` 里附件大小/数量校验（选择附件时）、`editRoot`/`editReply` 里
  "文本不能为空"——都是提交前的即时输入校验，同属例外1，保留原生 `alert()`。
- `threads.html` 里 Sheet 同步失败时那条 `alert()`（Telegram 消息已更新，但 Sheet
  行更新失败……）——这正是设计文档 §7 例外2 举的原始例子本身（"提交结果里'是否成功
  写入 Sheet'的详细原因"），维持原样。
- `openEditDetailsModal` 里"必填字段未填"的校验、`deposit-issue.html` /
  `deposit-backup.html` / `promo.html` 里搜索失败/搜索中的状态——都是持久展示在
  结果区域本身的状态文字，不是一次性弹出的动作反馈，不套用这套规则。
- `deposit-backup.html` 里有一份和 `deposit-issue.html` 同源、但从未被引用的
  `.dep-toast`/`.dep-btn-sub`/`.dep-btn-clear` 死 CSS（这个页面本身没有编辑/提交
  功能）。这是历史遗留的死代码，和本次"反馈方式统一"无关，没有动它。

## 3.1 后续调整：toast 换成 `#globalToastOverlay` id 选择器写法

按要求把 `toast.js` / `style.css` 里 toast 部分的实现换成了 `#globalToastOverlay`
id 选择器版本（原来是 `.toast-overlay` class 版本），视觉细节（更深的遮罩色调、
box-shadow、err 卡片左对齐）也换成了指定的那份。

有一处需要注意：给的这份 CSS 没有给 `ok` 类型的 `.toast-hint` 加 `display:none`，
如果只换 CSS、`toast.js` 还是原来"提示文字固定写死"的写法，`ok` 弹窗也会显示
"Click anywhere to dismiss"（但 ok 是自动消失的，不需要点击，文案会对不上）。
CSS 按给的原样保留，没有加这条规则；改成在 `toast.js` 里按类型动态生成/隐藏这行
提示文字（`err` 才有内容、`ok` 时清空并 `display:none`），效果上和加一条 CSS 规则
一样，但没有改动你提供的样式表。

## 4. 涉及改动的文件

- `public/assets/toast.js`（核心组件重写）
- `public/assets/style.css`（toast 相关 CSS）
- `public/assets/app.js`（表单提交结果去重复）
- `public/assets/apply-feature-status-to-ui.js`（默认兜底从 `alert()` 改为 toast）
- `public/index.html`（`setAgentLock` 动态文案 + toast）
- `public/threads.html`（五个动作补 toast、Sync to Sheet / Forward 弹窗去重复/补 toast）
- `public/accounts-admin.html`（接入 toast.js，补齐 delete/lock 的响应检查与反馈）
- `public/deposit-issue.html`（`showT()` 改为调用统一 toast，删除死代码）

所有改动过的文件都跑过 `node --check`（含从 HTML 里提取出的内联 `<script>` 块），
语法上都能正常解析。后端 `functions/` 目录、`d1-schema.sql` 等未涉及页面反馈的部分
没有改动。
