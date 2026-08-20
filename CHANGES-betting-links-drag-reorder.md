# Betting Resources Links — 结果列表支持拖拽排序

给 Account Management → Betting Resources Links → "Results Finding
Websites" 那一栏的链接列表加上拖拽排序，套用 `PATTERNS-drag-reorder.md`
里沉淀的通用模式（该文档本身也已收进项目根目录，方便以后其他列表复用）。

## 改了什么

- **`public/index.html`（`renderBettingLinks()`）**
  - 新增 `canReorder = canEdit && acctBettingLinks.results.length > 1`
    判断——只读模式、或列表只有 0/1 条时不渲染拖拽手柄。
  - 每一行 `.link-edit-row` 在 `canReorder` 为真时多渲染一个
    `<span class="drag-handle" draggable="true">⠿</span>`，只有这个手柄
    是 `draggable`，行本身不是——避免和输入框、🗑 删除按钮抢事件。
  - 新增原生 HTML5 drag/drop 事件绑定（`dragstart`/`dragend`/
    `dragover`/`dragleave`/`drop`），drop 时对 `acctBettingLinks.results`
    做 `splice` 重排，然后整体调用 `renderBettingLinks()` 重渲染。
  - **没有**额外实现"拖拽前同步表单数据"这一步（通用模式模板里提到的
    `syncFormFn`），因为这三个输入框本来就是 `oninput` 逐字符直接写回
    `acctBettingLinks.results[idx]`，不存在"还没 blur 就被覆盖丢失"的
    风险——细节写在 `PATTERNS-drag-reorder.md` 开头的项目落地说明里。
  - 保存方式沿用原有的整栏 "Save"（`acctSaveBettingLinks`），拖拽只改
    内存里的数组顺序，不会拖一下就发一次请求。

- **`public/assets/style.css`**
  - 新增 `.link-edit-row.has-handle`（预留左侧 40px 给手柄）、
    `.link-edit-row .drag-handle`（手柄本身的样式，光标 grab/grabbing）、
    `.link-edit-row.dragging`（被拖拽行半透明）、
    `.link-edit-row.drag-over`（悬停目标行描边高亮为 `--accent-gold`）。

- **展示层零改动**：`public/betting-resources.html` 已经是
  `results.map(...)` 直接按数组顺序渲染，不需要碰。

- 跑了 `node update-asset-versions.js` 同步 `style.css` 新 hash 到所有
  引用它的 `public/*.html`（10 个文件的 `?v=` 查询串更新）。

## 没有改的地方 / 为什么

- **"Rules" 单链接那一栏**（`bl_rules_*`）——只有一条数据，天然没有排序
  的意义，不加手柄。
- **移动端指针事件版拖拽**——这是内部 Account Management 后台面板，CS
  团队主要在桌面浏览器操作，原生 HTML5 drag/drop 够用；如果以后要在手机
  上也支持拖拽这个面板，再回来套用 `PATTERNS-drag-reorder.md` 里的
  pointer events 版本。
- **后端 / `functions/_shared/bettingResources.js`、
  `functions/api/betting-resources.js`**——存储层本来就是纯数组（不是靠
  `sort_index` 字段排序的表），拖拽保存时整体覆盖写入即可，不需要新增
  字段或改查询逻辑。
