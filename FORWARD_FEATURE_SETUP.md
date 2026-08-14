# "Generate to another Topic" (Forwarding) — Design & Setup Guide

**用途：** 记录"↗️ 转发到另一个 Topic"这个功能从 0 到最后的完整设计逻辑、涉及的每一处代码改动、以及踩过的坑，方便你照着搬到其他 currency 项目。

---

## 1. 这个功能是什么

在 TG Reply Threads（`threads.html`）的工单详情页，点击 ↗️ 按钮，可以基于**当前这张工单**，在**另一个 Topic**（比如从 QA 转到 Account Issue）生成一张**全新的工单**——效果跟在那个 Topic 正常提交一次表单完全一样：新的 Telegram 消息、新的 Sheet 记录（如果那个模块有接 Sheet）、新的可追踪工单记录。

## 2. 确认过的设计决定

1. **同名字段自动带过去**（UID/Number/Email 等），**但全部可编辑**——防止带错
2. **Brand 锁死**，不能在转发时改成别的品牌
3. **附件走"转发"效果**——复用 Telegram 自己的 `file_id`，不重新上传，原生转发一样快
4. **可以在转发时额外加新附件**（因为目标 Topic 的群可能要求原 Topic 不需要的照片），用跟提交表单一样的拖拽上传区域（不要用丑陋的原生 `<input type="file">` 样式）
5. **PIC 默认填"当前点击转发的这个人"**，但可以改
6. **两边互相留痕迹**：新工单显示"↩️ Forwarded from（原 Topic）"，原工单显示"↗️ Forwarded to（新 Topic）"，都可以点击跳转
7. **该写 Sheet 就写 Sheet**，跟正常提交完全一样，包括 Screenshot Link 这一列（如果那个模块有接 R2）

---

## 3. 涉及改动的文件清单（共 6 个，1 个全新）

| 文件 | 改动内容 |
|---|---|
| `functions/api/forward.js` | **全新文件**——核心转发接口 |
| `functions/_shared/threads.js` | `createThread()` 支持 `forwardedFrom`/`rootMessageIds`，新增 `addForwardedToLink()` |
| `functions/api/threads/[id].js` | `recallRoot` 改成删除相册里的每一张图，不只是第一张（见第 6 节的踩坑记录） |
| `functions/api/submit.js` | 发送逻辑改成返回完整的 `messageIds` 数组（配合上面的 recall 修复） |
| `public/threads.html` | ↗️ 按钮、两阶段转发弹窗、两边"Forwarded from/to"引用卡片、拖拽上传区域 |
| `public/assets/style.css` | `.forward-link-card` 样式 |

---

## 4. `functions/api/forward.js` —— 全新接口，直接整份复制

这是核心文件，481 行，建议**整份复制**过去，然后按下面几点做针对该 currency 项目的调整：

### 需要按项目调整的地方
- **import 路径/导出名字要对得上**：`BRANDS, MODULE_META, MESSAGE_TEMPLATE, PROMOTION_MESSAGE_TEMPLATE, RECORD_TO_SHEET, SHEET_LAYOUT, PROMOTION_SHEET_CONFIG, SCREENSHOT_R2_ENABLED` 这些必须是目标项目 `routing.js` 里真实存在的导出（有些项目可能没有 `PROMOTION_SHEET_CONFIG`，看该项目有没有 Promotion Request 这个模块）
- **`buildTicketMessage`/`buildTitleAndSummary`/`resolveColumnValues`/`resolveSheetLayout`/`formatDateDDMMYYYY`** 这几个必须来自目标项目自己的 `_shared/messageBuilders.js`——如果目标项目还没做过"把 submit.js 里的消息构建逻辑抽成 messageBuilders.js"这一步（参考之前"Sync to Sheet"功能的迁移说明），**要先做那一步，这个文件才能直接用**，否则这些函数不存在

### 核心逻辑结构（如果要手写而不是照抄，按这个顺序）
1. 校验登录、`THREADS_KV`、`TELEGRAM_BOT_TOKEN`
2. 解析 body：`sourceThreadId, targetModule, fields, fieldMap, reporter, newAttachments`
3. 校验目标模块存在、`canSeeModule()` 权限
4. 用 `getThread()` 拿到原工单，检查目标模块不能跟原模块一样
5. Brand **从原工单读，不接受 body 传进来的**（这是锁死 Brand 的关键实现）
6. 拿到目标模块的 Telegram 路由（chatId/topicId）
7. **R2 上传**（如果该模块开了 `SCREENSHOT_R2_ENABLED`）——新附件直接传，转发过来的旧附件要先从 Telegram 下载字节再传（见第 6 节踩坑记录）
8. `buildTicketMessage()` 生成文字
9. `sendCombinedAttachments()` 发送——这是本文件最核心的部分，支持"只有转发的 file_id / 只有新上传 / 两者混合 / 纯文字"四种情况，都在同一条消息里发出去
10. 写 Sheet（跟 `submit.js` 的逻辑几乎一样，复制过来改一下变量名即可）
11. `createThread()` 建新工单，带上 `forwardedFrom`
12. `addForwardedToLink()` 给原工单留痕迹
13. 返回结果

---

## 5. 另外 5 个文件的具体改动

### 5.1 `functions/_shared/threads.js`

**a) `createThread()` 加两个新参数**

```js
export async function createThread(env, { module: moduleId, moduleName, icon, accent, brand, brandId, title, submitter, chatId, topicId, rootMessageId, rootMessageIds, rootText, hasMedia, attachmentFileIds, summary, fieldMap, screenshotLink, sheetRef, forwardedFrom }) {
  const now = new Date().toISOString();
  const allRootIds = rootMessageIds && rootMessageIds.length ? rootMessageIds : [rootMessageId];
  const thread = {
    // ...原有字段都不变...
    rootMessageId,
    rootMessageIds: allRootIds,   // 新增
    // ...
    msgIds: [...allRootIds],       // 原本是 [rootMessageId]，改成完整数组
    // ...
    forwardedFrom: forwardedFrom || null,  // 新增
    forwardedTo: [],                        // 新增
  };
  await Promise.all([
    saveThread(env, thread),
    ...allRootIds.map((mid) => env.THREADS_KV.put(`msgid:${thread.chatId}:${mid}`, thread.id)),  // 原本只 put 一个 rootMessageId，改成每个 id 都 put
  ]);
  await patchListCache(env, thread);
  return thread;
}
```

**b) 新增 `addForwardedToLink()`**（放在 `updateThreadDetails()` 后面即可）

```js
export async function addForwardedToLink(env, threadId, link) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.forwardedTo = [...(thread.forwardedTo || []), link];
  await saveThread(env, thread);
  return thread;
}
```

### 5.2 `functions/api/threads/[id].js` —— `recallRoot` 改成删除全部相册消息

```js
if (action === "recallRoot") {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);

  const thread = existingThread;
  const idsToDelete = thread.rootMessageIds && thread.rootMessageIds.length ? thread.rootMessageIds : [thread.rootMessageId];
  const results = await Promise.all(idsToDelete.map((mid) => callTelegram(env, "deleteMessage", { chat_id: thread.chatId, message_id: mid })));
  const firstFailure = results.find((r) => !r.ok);
  if (firstFailure) return json({ ok: false, error: telegramDeleteError(firstFailure) }, 502);

  const updated = await markRootRecalled(env, id);
  await logDeletion(env, { type: "recall-root", threadId: id, threadTitle: thread.title, brand: thread.brand, content: thread.rootText || "(no text)", by: account.username });
  return json({ ok: true, thread: updated });
}
```

### 5.3 `functions/api/submit.js` —— `sendTelegramWithAttachments()` 返回完整 `messageIds`

三个分支（单文件/相册/混合类型）的 return 语句，都要**多返回一个 `messageIds: [...]` 数组**（不只是 `messageId` 那一个）：

```js
// 相册那个分支举例：
const sent = await sendMediaGroup({ botToken, route, text, attachments });
return {
  messageId: sent[0].messageId,
  messageIds: sent.map((s) => s.messageId),   // 新增这一行
  attachmentLinks: sent.map((s) => buildMessageLink(route, s.messageId)),
  attachmentFileIds: sent.map((s) => s.fileId).filter(Boolean),
};
```

catch 里的 fallback 分支也要加：
```js
tgResult = { messageId: fallback.messageId, messageIds: [fallback.messageId], attachmentLinks: [], attachmentFileIds: [] };
```

`createThread()` 调用处：
```js
rootMessageId: tgResult.messageId,
rootMessageIds: tgResult.messageIds,   // 新增
```

### 5.4 `public/threads.html`

**a) 头部按钮**（跟 📊/✏️/🗑/🔄 放一起）：
```js
${t.fieldMap && t.brandId ? '<button class="icon-btn" id="forwardBtn" title="Generate a new ticket in another Topic, pre-filled from this one">↗️</button>' : ""}
```
```js
document.getElementById("forwardBtn")?.addEventListener("click", () => openForwardModal());
```

**b) 两边的引用卡片**（加进 `buildSummaryHTML()` 返回的模板末尾）：
```js
${t.forwardedFrom ? `
  <div class="forward-link-card" data-goto-thread="${escapeAttr(t.forwardedFrom.threadId)}">
    ↩️ Forwarded from <b>${escapeHtml(t.forwardedFrom.moduleName)}</b> — ${escapeHtml(t.forwardedFrom.title)}
  </div>` : ""}
${(t.forwardedTo || []).map((link) => `
  <div class="forward-link-card" data-goto-thread="${escapeAttr(link.threadId)}">
    ↗️ Forwarded to <b>${escapeHtml(link.moduleName)}</b> — ${escapeHtml(link.title)} &nbsp;<span class="forward-link-time">${timeAgo(link.at)}</span>
  </div>`).join("")}
```
点击跳转（加进 `wireConversationButtons()`）：
```js
document.querySelectorAll("[data-goto-thread]").forEach((card) => {
  card.addEventListener("click", () => openThread(card.dataset.gotoThread));
});
```

**c) `openForwardModal()` 整个函数** —— 这是最大的一块，两阶段（先选 Topic 再展开表单），核心结构：

```js
function openForwardModal() {
  const source = selectedThread;
  const otherModules = (window.MODULES || []).filter((m) => m.id !== source.module);
  // ...渲染弹窗 HTML：Topic下拉框 + Brand只读 + Reporter可编辑 + 动态字段容器 + 拖拽上传区域...

  overlay.querySelector("#fwdModule").addEventListener("change", (e) => {
    // 选中目标模块后，遍历 targetModule.fields，
    // 用 source.fieldMap[f.key] 预填同名字段（全部可编辑），
    // showIf 逻辑照抄 openEditDetailsModal() 那一份
  });

  // 拖拽上传区域：click / drag&drop / paste 三种方式，
  // 完整逻辑照抄 app.js 的 dropzone 实现（见 5.4-d）

  submitBtn.addEventListener("click", async () => {
    // 收集 fields/fieldMap，校验必填，
    // POST /api/forward，body: { sourceThreadId, targetModule, fields, fieldMap, reporter, newAttachments }
    // 成功后本地 patch selectedThread.forwardedTo，
    // updateThreadContent + patchLocalThread + loadList，
    // 最后 openThread(res.thread.id) 直接跳到新工单
  });
}
```

**d) 拖拽上传区域**（附件 UI 用跟提交表单一样的样式，不要用原生 `<input type="file">`）：

HTML：
```html
<div class="dropzone" id="fwdDropzone" tabindex="0">
  <div class="dz-icon">📎</div>
  <p class="dz-main">Click or drag files here</p>
  <p class="dz-sub">JPG, PNG, PDF — Max 3 files, 20MB each</p>
  <p class="dz-paste">📋 Ctrl+V / ⌘V to paste screenshot</p>
</div>
<div class="file-list" id="fwdFileList"></div>
<input type="file" id="fwdNewFile" multiple hidden />
```
JS 逻辑照抄 `app.js` 里 `dropzone`/`fileInput`/`addFiles`/`renderFileList` 那一段（click 打开、拖拽、paste 粘贴、文件小标签可删除），**唯一要注意的是 `paste` 监听器要限定在弹窗打开时才生效**，弹窗关闭时要 `window.removeEventListener("paste", ...)`，否则会一直全局监听，干扰页面其他地方的粘贴操作。

**e) Cancel / Generate & Send 两个按钮，尺寸要手动对齐**——`.icon-btn` 和 `.btn-submit` 这两个 class 是给不同用途设计的，直接拿来放一排会大小不一致，两个按钮都要写**一样的** `padding/font-size/font-weight/border-radius`，只有颜色（描边红色 vs 渐变实心）不同。

### 5.5 `public/assets/style.css` —— 新增引用卡片样式

```css
.forward-link-card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px dashed var(--panel-border);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 12.5px;
  margin-top: 10px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.forward-link-card:hover { border-color: var(--accent-gold); background: rgba(255, 255, 255, 0.05); }
.forward-link-time { color: var(--ink-soft); font-size: 11.5px; }
```

---

## 6. 开发过程中踩过的坑（一定要看，不然移植过去会重复踩）

### 坑 1：Screenshot Link 在 Sheet 里是空的
**原因：** Sheet 的 Screenshot Link 列要的是 **R2 上传后的链接**，不是 Telegram 链接、也不是 file_id。第一版转发功能只顾着把图片转发到 Telegram，完全没做"顺便也传一份到 R2"这一步。
**修法：** 见第 4 节第 7 步——新附件直接传 R2；转发过来的旧附件（只有 file_id）要先用 `getFile` + 下载 拿到真实字节，再传 R2。

### 坑 2：Recall 只删得掉相册第一张图
**原因：** 一次提交/转发多张图时，Telegram 会拆成"一张图一个 message_id"的相册，只有第一张带文字说明。但代码从头到尾只记住了"第一张"的 message_id，当成 `rootMessageId`。Recall 只删这一个 ID，其余几张永远留在群里。**这个 bug 不是转发功能才有的，是从最早的提交逻辑就存在，只是转发功能测试时更容易发多张图才暴露出来。**
**修法：** 见第 5.1/5.2/5.3 节——`rootMessageIds` 完整数组、每张图都单独登记 `msgid:` 查找指针、`recallRoot` 删除全部。

### 坑 3：Cancel 和 Generate & Send 按钮大小不一致
**原因：** 顺手把 `.icon-btn`（专门给方形小图标按钮设计，高度写死 32px）拿来当 Cancel 按钮用，跟 `.btn-submit`（14px 内距、12px 圆角、800 字重）放一排，尺寸对不上。
**修法：** 两个按钮手动写一样的 `padding/font-size/font-weight/border-radius`，只让颜色不同。

---

## 7. 移植到其他 currency 项目时的检查清单

1. **先确认目标项目有没有 `_shared/messageBuilders.js`**——如果没有，先做"把 submit.js 的消息构建逻辑抽出来"这一步，`forward.js` 依赖这几个函数
2. 整份复制 `functions/api/forward.js`，对照第 4 节调整 import
3. 按第 5.1-5.3 节改 `threads.js`/`[id].js`/`submit.js`
4. 按第 5.4-5.5 节改 `threads.html`/`style.css`
5. 部署后测试顺序：
   - 挑一张有 2+ 张附件的旧工单，转发到另一个 Topic，确认字段预填对不对、Brand 是不是锁死的
   - 加一张新附件，确认转发出去的消息里旧图+新图都在
   - 去 Sheet 确认 Screenshot Link 那一列有没有值（如果该模块接了 R2）
   - 两边工单互相点"Forwarded from/to"确认能跳转
   - **单独测试 Recall**：提交一张带 3+ 张图的工单，点 Recall，去 Telegram 确认**每一张**图都被删掉了，不是只删了第一张
