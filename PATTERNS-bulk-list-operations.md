# 批量操作不卡顿 — 可复用模式（提炼自 `public/threads.html`）

这不是一次"改动记录"（不像其他 `CHANGES-*.md`），而是把 `threads.html` 里
"全选 Mark all read" 已经在用、且效果验证过的三个性能点，沉淀成**判断标准 +
可直接复制的代码**，方便以后任何页面要做"批量操作 / 大列表频繁重渲染"时，
不用重新摸索一遍，直接对照抄。

---

## 先判断，再动手：三个独立的问题，别混着治

批量操作卡顿几乎总是下面三种原因之一（或叠加）。判断顺序：

```
1. 这个状态到底要不要让服务器/其他人知道？
   不需要（纯本地标记，如已读/收藏/展开折叠）
     → 不发请求，直接本地权威（见「判断标准 1」）
   需要（如批量删除、批量改共享状态）
     → 至少做到并发发送（见「判断标准 2」）

2. 不管发不发请求：这次操作会触发列表重渲染吗？
   列表条目数量中等以上 + 每条渲染有点重（图片/emoji/复杂布局）
     → 用 key-based DOM 复用，别整个 innerHTML 重建（见「判断标准 3」）
```

三条互相独立，可以只用其中一条，也可以叠加。`threads.html` 的
"Mark as read"（本地状态）和"Mark as solved"（共享状态，要发请求）
分别对应判断标准 1 和 2，两者共用同一套判断标准 3 的渲染层。

---

## 判断标准 1：这个状态该存本地还是存服务器？

**不是"能存 localStorage 就存"，而是先问一句**：如果两个人/两个客户端同时
在用，这个状态"该不该"让对方也看到？

- 看不到也无所谓（"我自己看没看过这条" 这种纯个人标记）→ 本地权威，
  存 `localStorage`，零网络请求，批量操作是纯同步循环，不会卡。
- 必须互相可见（"这条客观上是否已解决" 这种共享业务状态）→ 服务端权威，
  走判断标准 2。

```js
// 通用「已读标记」工具 —— localStorage 版，零网络请求
const SeenTracker = {
  key: (id) => `seen:${id}`,
  get(id) {
    return parseInt(localStorage.getItem(this.key(id)) || "0", 10);
  },
  set(id, count) {
    localStorage.setItem(this.key(id), String(count));
  },
  bulkSet(ids, count) {
    ids.forEach((id) => this.set(id, count)); // 纯同步循环，选多少条都不卡
  },
};
```

**项目里的参照实现**：`public/threads.html` 的 `getSeenCount` /
`markSeen`（未读追踪），`runBulkReadToggle`（批量标记入口）。

---

## 判断标准 2：真的要发请求时，并发不要串行

`for (const id of ids) { await doThing(id); }` 是 N 次网络延迟叠加；
改成 `Promise.all` 是约等于"最慢的那一条"。但**不能无脑全并发**——如果
接口本身没做限流，几百个并发请求会把 Function/后端打垮，要分批。

```js
// 分批并发 —— 每批最多 batchSize 个同时发，批与批之间等上一批完成
async function bulkRunLimited(ids, worker, batchSize = 20) {
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    await Promise.all(batch.map(worker));
  }
}
```

批量操作按钮在请求进行中要 `disabled`，防止手抖点两次触发重复请求
（`threads.html` 里 `readBtn.disabled` / `solveBtn.disabled` 就是干这个的）。

**项目里的参照实现**：`public/threads.html` 的 `runBulkSolveToggle`
（`Promise.all(ids.map((id) => setThreadSolvedById(id, solving)))`）。

---

## 判断标准 3：重渲染时按 key 复用 DOM，别整个重建

只要列表有几十条以上、每条渲染不轻（图片、emoji 解析、复杂布局），
`container.innerHTML = list.map(renderItem).join('')` 这种整体重建
就会比网络请求本身更卡——因为浏览器要重新解析、重新排版、重新绑事件、
重新加载资源。改成"算出每条的渲染 key，key 没变就跳过，只重建真的
变了的那几条"：

```js
function createReconciler({ getId, computeKey, renderItem, syncTransientState }) {
  const rendered = new Map(); // id -> { el, key }

  return function reconcile(container, items) {
    const touched = [];
    let prevEl = null;

    items.forEach((item) => {
      const id = getId(item);
      const key = computeKey(item);
      let entry = rendered.get(id);

      if (!entry || entry.key !== key) {
        if (entry) entry.el.remove();
        entry = { el: renderItem(item), key };
        rendered.set(id, entry);
        touched.push(entry.el); // 只有真的重建的节点才需要后续处理
      }
      // 结构不变、代价极低的状态（选中/勾选之类）在这里同步 —— 不进 key，
      // 每条都无条件跑一遍。原因见下面「⚠️ 常见陷阱」。
      if (syncTransientState) syncTransientState(entry, item);

      const wantPos = prevEl ? prevEl.nextSibling : container.firstChild;
      if (entry.el.parentNode !== container || entry.el !== wantPos) {
        container.insertBefore(entry.el, wantPos);
      }
      prevEl = entry.el;
    });

    // 清理已经不在当前列表里的旧节点（删除/被筛选掉的）
    const currentIds = new Set(items.map(getId));
    for (const [id, entry] of rendered) {
      if (!currentIds.has(id)) {
        entry.el.remove();
        rendered.delete(id);
      }
    }

    return touched; // 调用方对这些新建/重建的节点做后续处理（如重新解析 emoji）
  };
}
```

用法：

```js
const reconcileThreadList = createReconciler({
  getId: (t) => t.id,
  // ⚠️ 注意：isSelected(t.id) 不在这里 —— 见下面的陷阱说明
  computeKey: (t) => [t.title, t.updatedAt, t.status].join("|"),
  renderItem: (t) => buildThreadRowElement(t),
  syncTransientState: (entry, t) => {
    const checked = isSelected(t.id);
    entry.el.classList.toggle("checked", checked); // 只改 class，不碰结构
  },
});

function render() {
  const touched = reconcileThreadList(listContainer, currentItems);
  touched.forEach(runExpensivePostProcessing);
}
```

### ⚠️ 常见陷阱：选中/勾选状态千万别塞进 key

这是这套模式里**最容易踩、后果最隐蔽**的坑，踩中之后的症状恰好是
"平时不卡，一点全选就卡"——因为：

- "是否被选中"每次点击都会变，尤其是点"全选/取消全选"时会让**一整批行
  同时**从"未选中"变成"选中"（或反过来）。
- 如果这个状态在 `computeKey` 里，点一次全选 = 一整个列表的 key **同时**
  全部失效 = 触发对所有行的"删除 + 重建 + 重新绑定事件监听器"，在同一个
  同步 tick 里跑完 —— 这正是技术点 3 本来想避免的那种全量重建，只是换了
  个触发方式，效果一样卡，而且比"从来没做过 diff"更难排查（因为大部分
  操作看起来都是好的，只有全选才炸）。

**正确做法**：凡是"只改一个 class / 一个 checkbox 的 `.checked` 属性，
不改变这一行 DOM 结构"的状态，一律不进 key，单独用一个 `syncTransientState`
之类的函数、在每一行**无条件**同步一遍（不用判断 key 是否变化，因为这个
同步本身足够便宜：不创建节点、不解析 innerHTML、不重新绑定事件）。

**项目里的参照实现**：`public/threads.html` 的 `renderedItemEls` /
`itemRenderKey`（注释里明确写了"故意排除 `checkedThreadIds.has(t.id)`，
原因就是上面这个坑"）/ `syncCheckedState`（对应这里的 `syncTransientState`）
/ `reconcileSection`（含 twemoji 只对 `touchedEls` 重新解析）。

---

## 当前项目里的适用范围核对（写这份文档时顺手查过一遍）

- **`public/threads.html`** — 三条全部已经在用，是本文档的来源，不用动。
- **`public/index.html` 的几处 "Select All"**（`am_selectAllBtn`、
  `ap_selectAllBrands`）—— 只是切换十几个 brand/module checkbox 的
  勾选状态，不发批量请求、条目数也很少，**不适用这套模式**，维持现状即可。
- **`public/deposit-issue.html` / `public/deposit-backup.html` 的
  `gi('depRes').innerHTML = data.map(...)`** —— 每次是用户主动发起的
  一次搜索，结果整体替换是预期行为（不是"改了 3 条却重建 200 条"的场景），
  **不需要**上判断标准 3 的 reconciler；如果以后这两个页面加上"批量修改
  搜索结果里的多条记录"这种功能，再回来套用判断标准 1/2。

## 以后新加批量操作类功能时的检查清单

1. 这个状态要不要碰服务器？—— 不要就用判断标准 1，要就至少做到判断标准 2。
2. 列表有没有大（几十条以上）+ 渲染重（图片/表情/复杂布局）？—— 有就上
   判断标准 3 的 reconciler，收益通常比网络优化更明显。
3. 批量按钮请求进行中记得 `disabled`。
