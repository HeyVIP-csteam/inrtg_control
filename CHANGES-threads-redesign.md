# TG Reply Threads — sidebar redesign (tabs + single list)

`public/threads.html` 左侧原来是三个堆叠的可折叠区块（Active Threads /
Solved Chat History / Recall Chat History），改成了顶部 tab 切换 + 单一
大卡片列表，同一时刻只渲染其中一个 tab 的内容。技术点 1/2/3（本地已读、
并发批量、key-based DOM 复用）本身没有变化——见
`PATTERNS-bulk-list-operations.md`——这次改的是外面这层"哪些区块同时
存在"的布局。

## 1. 三段式 → tab 切换

`#activeSection` / `#solvedSection` / `#recallSection` 三个
`.threads-section` 没了，换成 `#threadsTabs` 里动态渲染的
`Active / Solved / [Recall]` 三个 tab（`renderTabs()`），加一个共享的
`#threadList` 容器。`currentTab` 状态决定 `currentItems()` 返回哪个数组，
`reconcileSection` 现在只对着这一个容器、一份数组跑——不再是同时维护两个
容器（`activeList`/`solvedList`）。

**Recall 现在只对 admin 及以上可见，而且是"不存在"而不是"存在但灰着"**：
`renderTabs()` 里 `if (isAdmin) tabs.push(...)`，非管理员的 tabs 数组从头
到尾就只有两项，不用额外做锁图标或权限提示。`isAdmin` 从 `bootDashboard()`
里那个原本局部的 `const` 提到了模块级 `let`，因为 `renderTabs()` 也要读它。

## 2. Select all + Mark as read/Solved 挪到同一行、靠右

原来的 `.threads-select-bar` 是一整块（选中数 + Cancel 在上，两个按钮在
下）。现在拆成两块：

- `.threads-select-all-row`：checkbox + "Select all" + 一个 flex spacer +
  两个按钮靠右（`justify-content` 靠 spacer 撑开，不是 `space-between`，
  这样以后再加按钮不用改布局）
- `.threads-select-bar`：现在只剩 Cancel + 选中计数，`position: sticky;
  bottom: 0`，贴在 sidebar 滚动区域底部

两个原来分开的 `activeSelectAll` / `solvedSelectAll` checkbox 合并成一个
`#threadsSelectAll`，因为现在同一时刻只有一个 tab 在显示，不需要两份。

## 3. 卡片本身：单行 → 两行，数字未读数 → "NEW" 徽标

`renderItem()` 的输出从"一行挤下标题+副标题+未读数+勾+kebab"改成两行：

```
[icon/checkbox]  标题                              14:22
                 提交人 · N reply              [NEW]
```

`unread-badge`（显示未读条数的红点）换成了 `badge-new`（青色 "NEW" 药丸），
跟审批过的预览稿一致——这是故意简化掉"具体几条未读"这个信息，只保留
"有没有新回复"。如果以后想要回具体数字，`unread` 变量在 `renderItem()`
里还在，改 `badge-new` 那一行的文案就行，不用碰 key/reconcile 逻辑。

## 4. 没变的部分（照抄过来，特意确认过）

- `itemRenderKey()` 仍然**不**把 `checkedThreadIds.has(t.id)` 算进 key——
  这是 `PATTERNS-bulk-list-operations.md` 那个"全选卡顿"陷阱的修复，这次
  重构没有碰这块，continue as-is。
- `toggleThreadSolvedById` 的批量版本仍然是 `Promise.all(...)`，不是
  `for...await`。
- 已读状态仍然是 `localStorage`（`getSeenCount`/`markSeen`），零网络。
- 单条 `⋮` kebab 菜单（Select / Mark as read-unread / Solved）逻辑没动，
  只是外层容器从窄行换成了新的两行卡片，`openThreadKebabMenu` 本身不用改。

## 5. 顺手做的调整

- `.threads-sidebar` 宽度从 300px 加到 380px——两行卡片 + 更大的图标在
  300px 里会挤，加宽之后 `.threads-main`（右侧对话详情）相应变窄，桌面端
  常见分辨率下还够用。
- `renderLists()` 现在顺带调用 `renderTabs()`，不然轮询刷新数据后 tab
  上的数字（"Active 1914"里的 1914）会停在打开页面那一刻，不跟着新数据
  动——这是原设计里没有的场景（原来数字直接绑在 `#activeCount`/
  `#solvedCount` 上，每次 `renderLists()` 都会更新），改成 tab 形式后容易
  漏掉，这里补上了。
