# "拖拽排序驱动展示顺序" —— 通用实现模式

一份可以直接套用到其他项目的说明,不绑定任何具体代码库。

> **本项目里的落地实现**:`public/index.html` 的 `renderBettingLinks()`
> （Account Management → Betting Resources Links → Results Finding
> Websites 那一栏，`acctBettingLinks.results` 数组），配套 CSS 在
> `public/assets/style.css` 的 `.link-edit-row .drag-handle` 一带。
> 展示层就是这份文档说的"通常不用做"的那种——`public/betting-resources.html`
> 已经是 `results.map(...)` 直接渲染，改动完全没碰这个文件。
>
> 和下面通用模板的一处出入：模板里强调"拖拽前先同步表单数据
> (`syncFormFn`)"，本项目没有单独实现这一步，因为 Icon/Name/URL 三个输入框
> 本来就是 `oninput` 时逐字符直接写回 `acctBettingLinks.results[idx]`
> （不是等 `blur`/`change`），所以数组任何时刻都是最新的，拖拽触发的
> 重渲染不会丢数据。**如果照抄这个模式到别的项目，先确认对方的输入框是不是
> 也是 `oninput` 全量同步——如果是 `blur`/`change` 才同步，就必须补上
> `syncFormFn` 这一步，否则会丢正在编辑但还没失焦的内容。**

## 核心逻辑(一句话)

**数组本身的顺序就是展示顺序,不需要额外的排序字段。** 管理界面拖拽调整数组元素位置 → 保存整个数组 → 展示页面按数组原样 `map` 渲染。排序这件事从头到尾只发生在"数组里谁在前面"这一个事实上。

这跟"自由定位拖拽面板"(第一次我理解错的那种)是两回事:
- 自由定位:面板可以拖到任意坐标/任意网格格子,需要碰撞检测、吸附判定、`layoutMap` 记录每个面板的位置。复杂。
- **列表排序(这次真正要的)**:只是调整一组同类项目的先后顺序,前一项和后一项谁在上谁在下。简单,标准模式。

先分清这两者,是选对实现方案的第一步——很多"能不能拖拽调整布局"的需求,拆开看其实只是列表排序。

## 什么场景适用这个模式

任何"管理端编辑一组条目 → 该组条目会在别处按顺序展示"的场景都适用,例如:
- 后台管理导航菜单项顺序 → 前台导航栏按顺序渲染
- 后台管理首页 banner/卡片顺序 → 首页按顺序渲染
- 后台管理 FAQ 列表顺序 → 帮助页按顺序渲染
- 这次的例子:后台管理链接列表顺序 → 主页链接卡片按顺序渲染

判断依据很简单:**如果展示端已经是"数组顺序 = 渲染顺序"(比如 `results.map(item => ...)` 这种代码),那么排序功能只需要改管理端,展示端一行代码都不用动。**

## 三层结构

```
┌─────────────┐     拖拽重排数组      ┌─────────────┐     保存整个数组     ┌─────────────┐
│  编辑层      │ ───────────────────> │  存储层      │ ──────────────────> │  展示层      │
│ 后台管理界面  │                      │ 数据库/KV/表 │                      │ 前台/主页面   │
│ (drag handle)│                      │ (纯数组,     │                      │ (按数组顺序   │
│              │                      │  无sort字段) │                      │  直接渲染)    │
└─────────────┘                      └─────────────┘                      └─────────────┘
```

**动手改代码前先确认这三层各自现状**,尤其是存储层——如果已经是数组结构(不是靠单独 `sortOrder`/`position` 字段排序的),那就完全不需要新增字段,只需要让编辑层能重排这个数组、保存时整体覆盖写入即可。如果存储层是靠单独字段排序(比如数据库表每行有 `sort_index`),那编辑层拖拽后要做的是批量更新每一行的 `sort_index`,展示层查询时要 `ORDER BY sort_index`。两种存储方式实现细节不同,先看清楚现状再选路径。

## 编辑层:拖拽手柄的通用实现

### 关键设计点

1. **拖拽手柄独立于整行**:不要让整行都能拖,容易和输入框、删除按钮、点击跳转冲突。加一个单独的手柄图标(⠿ / ≡ / 六个小圆点),只有按住手柄才触发拖拽。
2. **拖拽前先同步表单数据**:如果每行里有可编辑的输入框(名字、URL 之类),拖拽重排数组之前,一定要先把当前表单里所有输入框的值读回数据对象,再做数组的 splice/reorder,不然正在编辑但还没触发 blur/change 的内容会被重新渲染覆盖丢失。这是最容易踩的坑。
3. **只在能编辑时显示手柄**:只读模式/权限不足的用户不应该看到可拖拽的手柄。
4. **只有 2 条以上才需要手柄**:1 条数据没有"排序"的意义。

### 代码模板(原生 HTML5 drag/drop,零依赖)

适合桌面端管理后台。原生 drag/drop 的好处是浏览器自带碰撞检测和视觉反馈,不用自己算坐标;缺点是移动端浏览器支持不稳定,纯 admin 后台可以接受,面向 C 端用户的可拖拽 UI 不建议用这个,要用下面的"指针事件版"。

```javascript
// data: 要重排的数组，例如 acctData.results = [{name, url, icon}, ...]
// renderFn: 重新渲染整个列表的函数（每次 splice 之后调用）
// syncFormFn: 把当前所有输入框的值写回 data 数组的函数（splice 之前调用）

let dragSrcIdx = null;

rowElements.forEach((row) => {
  row.addEventListener('dragstart', (e) => {
    dragSrcIdx = Number(row.dataset.idx);
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragSrcIdx));
  });

  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
  });

  row.addEventListener('dragover', (e) => {
    e.preventDefault(); // 必须，否则 drop 事件不会触发
    e.dataTransfer.dropEffect = 'move';
    if (Number(row.dataset.idx) !== dragSrcIdx) row.classList.add('drag-over');
  });

  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drag-over');
    const targetIdx = Number(row.dataset.idx);
    if (dragSrcIdx === null || targetIdx === dragSrcIdx) return;

    syncFormFn();                          // 先保存正在编辑的内容
    const [moved] = data.splice(dragSrcIdx, 1);
    data.splice(targetIdx, 0, moved);
    dragSrcIdx = null;
    renderFn();                            // 重新渲染整个列表
  });
});
```

对应 CSS:

```css
.drag-handle { cursor: grab; user-select: none; }
.drag-handle:active { cursor: grabbing; }
.row.dragging { opacity: 0.4; }
.row.drag-over { border-color: var(--accent); }
```

### 移动端 / 触屏方案:指针事件版(不依赖原生 drag/drop)

如果需要在手机上也能拖拽(比如 C 端用户操作的列表),要换成 `pointerdown`/`pointermove`/`pointerup`,原理是拖动时实时算鼠标/手指的 Y 坐标落在哪两行之间,决定插入位置:

```javascript
handle.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const row = handle.closest('.row');
  const id = row.dataset.id;

  function move(ev) {
    // 跟随手指/鼠标移动（视觉反馈，可选：transform: translateY()）
    // 同时计算 ev.clientY 落在哪个相邻行的中点之上/之下，决定当前应插入的位置
  }
  function up(ev) {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    // 根据最终落点位置，splice 数组，renderFn()
  }
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
});
```

（这就是我们之前 demo 里用的方式，比原生 drag/drop 麻烦一些，但跨平台一致。）

## 展示层要做的事(通常是"不用做")

如果展示层已经是这样:

```javascript
results.map(item => renderCard(item)).join('')
```

那就完全不用改——因为它天然就是"数组顺序即渲染顺序"。**先去确认这一点,再决定要不要碰展示层代码,很多时候这一步是省下来的。**

如果展示层是按某个单独字段排序的(比如后端返回未排序的数组,前端自己 `sort((a,b) => a.sortOrder - b.sortOrder)`),那要确保编辑层拖拽保存时同步更新每条记录的 `sortOrder` 值。

## 保存时机的选择

两种常见做法,按场景选:

| 方式 | 优点 | 缺点 | 适合场景 |
|---|---|---|---|
| 拖完立即保存 | 用户无感知,不会因为忘记点保存丢失排序 | 频繁请求,拖几次就调几次接口 | 拖拽是唯一操作、其他字段不常编辑 |
| 统一走"Save"按钮 | 减少请求次数,和其他字段编辑一起提交 | 用户拖完必须记得点保存 | 页面本来就有全局保存按钮、排序只是众多可编辑项之一 |

## 常见坑,提前规避

1. **拖拽重排前忘记同步表单数据** —— 最容易踩的坑,上面已强调。
2. **给 `dragover` 忘记 `e.preventDefault()`** —— 原生 drag/drop 不加这行,`drop` 事件根本不会触发。
3. **手柄和整行拖拽绑在一起** —— 导致点输入框/按钮时误触发拖拽。
4. **移动端用原生 HTML5 drag/drop** —— 支持不稳定,C 端用户会觉得"拖不动"。
5. **展示层单独维护一份顺序 array,和编辑层的不是同一份数据源** —— 排序改了但展示端没变,通常是两边接口/字段没对齐。先确认两边读写的是同一个数组字段。

## 上手前的 3 步检查清单

拿到新项目要做这个功能时,先花几分钟确认这三件事,再动手写代码:

1. 展示层现在是怎么决定渲染顺序的?(数组原始顺序 / 单独排序字段 / 后端固定返回顺序)
2. 编辑层现在的列表渲染方式是什么?(是否已经有 `data-idx`/`data-id` 之类可以定位到具体是哪一条)
3. 编辑层保存时是整体覆盖数组,还是逐条更新?(决定了排序信息要不要额外持久化字段)

答案决定了改动范围——多数情况下(展示层已经是数组顺序渲染),只需要改编辑层一处,展示层零改动。
