# Withdraw Issue Module — Design & Setup Guide

**用途：** 记录 Withdraw Issue（提款问题）这个模块从 0 到最后的完整逻辑，方便你照着搬到其他 currency 项目。

---

## 1. 模块设计

**7 个 Issue Type**（单选，作为"门控字段"——选完才展开其他字段）：
- Withdraw Want to Cancel
- Wrong Wallet — Want to Cancel
- Withdraw Disapproved
- Withdraw Approved but Not Received
- Withdraw Amount Received Less
- Withdraw Reversed Back to Agent
- Withdraw Follow Up

**字段：** Issue Type → Username → TID → **[仅 "Withdraw Amount Received Less" 才显示] Submitted Amount / Received Amount** → Remark → 截图（可选）

**跟其他模块不一样的两点：**
1. 识别字段用的是 `username`（不是大部分模块常用的 `uid`）——这是这个模块本身的设计，不是命名不一致的错误
2. Sheet 里**没有 Screenshot Link 这一列**——业务方明确要求提款问题不需要记录截图链接

---

## 2. 涉及改动的文件清单（共 3 个）

| 文件 | 改动内容 |
|---|---|
| `public/assets/schemas.js` | 新增模块本身（表单字段定义） |
| `functions/_shared/routing.js` | 9 个品牌的路由占位、`MODULE_META`、`WITHDRAW_ISSUE_FIELD_STYLE`、`SHEET_LAYOUT.withdraw_issue`、`RECORD_TO_SHEET.withdraw_issue` |
| `functions/_shared/messageBuilders.js` | `buildWithdrawIssueDynamicMessage()` + 调度分支 + `autoDate` 列关键字 |

`app.js`/`threads.html` **完全不用改**——只要项目已经有"选完门控字段才展开其他字段"这个通用逻辑（`emphasize: true` 驱动的门控），新模块自动就能用上，不需要额外代码。

---

## 3. `public/assets/schemas.js` —— 新增模块定义

币种符号请换成目标项目实际用的（PKR 这边用的是 `Rs.`，原版参考的是给 PHP 项目做的 ₱）：

```js
{
  id: "withdraw_issue",
  name: "Withdraw Issue",
  icon: "💸",
  accent: "#4ADE80",
  description: "Select brand and issue type",
  attachments: DEFAULT_ATTACHMENTS,
  fields: [
    {
      key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
      options: [
        "Withdraw Want to Cancel",
        "Wrong Wallet — Want to Cancel",
        "Withdraw Disapproved",
        "Withdraw Approved but Not Received",
        "Withdraw Amount Received Less",
        "Withdraw Reversed Back to Agent",
        "Withdraw Follow Up",
      ],
    },
    { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
    { key: "tid", label: "TID", type: "text", required: true, placeholder: "Transaction ID..." },
    // -- Withdraw Amount Received Less -- (仅此类型才显示)
    { key: "submittedAmount", label: "Submitted Amount (Rs.)", type: "number", required: true, placeholder: "0.00",
      showIf: { field: "issueType", oneOf: ["Withdraw Amount Received Less"] },
    },
    { key: "receivedAmount", label: "Received Amount (Rs.)", type: "number", required: true, placeholder: "0.00",
      showIf: { field: "issueType", oneOf: ["Withdraw Amount Received Less"] },
    },
    { key: "remark", label: "Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
  ],
},
```

放在 `window.MODULES` 数组里任意位置即可（PKR 放在最后一个）。

---

## 4. `functions/_shared/routing.js` —— 4 处改动

### 4.1 每个品牌的 `telegram` 路由块，都要加一行空的占位

```js
withdraw_issue: { chatId: "", topicId: null },
```
（部署后要去 TG Group/Channel 管理面板，把每个品牌的真实 chatId/topicId 填进去）

### 4.2 `MODULE_META` 加一行

```js
withdraw_issue: { emoji: "💸", name: "Withdraw Issue", accent: "#4ADE80" },
```

### 4.3 新增 `WITHDRAW_ISSUE_FIELD_STYLE` 导出（放在 `ACCOUNT_ISSUE_FIELD_STYLE` 附近）

```js
/**
 * Emoji (and optional label override) per field, for the Telegram
 * message Withdraw Issue's submissions produce. "issueType"/"username"/
 * "remark" are handled separately (fixed header/footer lines), don't
 * need an entry here.
 */
export const WITHDRAW_ISSUE_FIELD_STYLE = {
  tid: { emoji: "🆔" },
  submittedAmount: { emoji: "💵" },
  receivedAmount: { emoji: "💰" },
};
```

### 4.4 `SHEET_LAYOUT.withdraw_issue` + `RECORD_TO_SHEET.withdraw_issue`

⚠️ **这两处不要瞎猜！** 必须先跟业务方确认真实 Google Sheet 的分页名字和列顺序，猜错了会把数据写到错的位置。PKR 这边确认下来的结构是（起始列是 **A**，不是其他模块常用的 B，因为 Date 就在 A 列；而且**没有** Screenshot Link 这一列）：

```js
// SHEET_LAYOUT 里加：
withdraw_issue: {
  tab: "Withdraw Issue",
  startColumn: "A",
  columns: ["autoDate", "brand", "username", "issueType", "tid", "submittedAmount", "receivedAmount", "remark", "pic"],
},
```

```js
// RECORD_TO_SHEET 里加：
withdraw_issue: true,
```

**在拿到真实 Sheet 结构之前，先把 `RECORD_TO_SHEET.withdraw_issue` 设成 `false`**——这样 Telegram 消息照常发，但不会往任何 Sheet 里写东西，等确认好列结构再打开成 `true`。

---

## 5. `functions/_shared/messageBuilders.js` —— 3 处改动

### 5.1 import 里加 `WITHDRAW_ISSUE_FIELD_STYLE`

```js
import { RISK_ISSUE_AUTO_REMARKS, RISK_ISSUE_FIELD_EMOJI, ACCOUNT_ISSUE_FIELD_STYLE, WITHDRAW_ISSUE_FIELD_STYLE } from "./routing.js";
```

### 5.2 新增 `buildWithdrawIssueDynamicMessage()`（放在 `buildAccountIssueDynamicMessage()` 后面）

```js
// Withdraw Issue: header shows Issue Type, Username right under Brand
// (no blank line between them), then any type-specific extra fields
// (only "Withdraw Amount Received Less" has any), then a blank line
// before Remark and another before PIC. Identifier field here is
// "username" (not "uid" like most other modules) — that's this
// module's own design, not a mismatch to fix.
export function buildWithdrawIssueDynamicMessage({ brandName, fields, fieldMap, reporter }) {
  const lines = [`💸 <b>Withdraw Issue — ${escapeHtml(fieldMap.issueType || "-")}</b>`, ""];
  lines.push(`🎮 <b>Brand/Platform:</b> ${escapeHtml(brandCurrencyLabel(brandName))}`);
  lines.push(`👤 <b>Username:</b> ${escapeHtml(fieldMap.username || "-")}`);

  fields
    .filter((f) => !["issueType", "username", "remark"].includes(f.key) && f.value)
    .forEach((f) => {
      const style = WITHDRAW_ISSUE_FIELD_STYLE[f.key];
      const emoji = style ? style.emoji : "🔸";
      const label = style && style.label ? style.label : f.label;
      lines.push(`${emoji} <b>${escapeHtml(label)}:</b> ${escapeHtml(f.value)}`);
    });

  lines.push("", `📝 <b>Remark:</b> ${escapeHtml(fieldMap.remark || "-")}`);
  lines.push("", `👷 <b>PIC:</b> ${escapeHtml(reporter)}`);
  return lines.join("\n");
}
```

### 5.3 `buildTicketMessage()` 调度函数里加一行分支

```js
if (moduleId === "account_issue") return buildAccountIssueDynamicMessage({ brandName: brand.name, fields, fieldMap, reporter });
if (moduleId === "withdraw_issue") return buildWithdrawIssueDynamicMessage({ brandName: brand.name, fields, fieldMap, reporter });  // 新增这行
```

### 5.4（可选，为将来接 Sheet 预留）`resolveColumnValues()` 里加 `autoDate` 列关键字支持

```js
if (col === "dateFormatted") return formatDateDDMMYYYY(fieldMap.reportDate || fieldMap.date) || "-";
// "autoDate" — today's date, written automatically with no form field
// needed (unlike "dateFormatted" above, which reads a real field the
// agent filled in). Used by modules whose form doesn't ask the agent
// to pick a date at all (e.g. Withdraw Issue).
if (col === "autoDate") return formatDateDDMMYYYY(new Date().toISOString().slice(0, 10));
```

这个关键字只有 `SHEET_LAYOUT.withdraw_issue` 用到，如果目标项目还没打算马上接 Sheet，这一步可以先跳过，等要接的时候再加。

---

## 6. `username`/`tid`/`submittedAmount`/`receivedAmount` 这几个字段不需要额外代码

它们都是普通字符串列，`resolveColumnValues()` 里已有的兜底分支 `return fieldMap[col] || "-";` 自动处理，包括"这个 Issue Type 没有金额字段时显示 `-`"这种情况，不需要专门写判断逻辑。

---

## 7. 移植到其他 currency 项目时的检查清单

1. 按第 3 节加 `schemas.js` 模块定义（币种符号记得换）
2. 按第 4 节的 4 处改 `routing.js`（**Sheet 那两处先按 `false` 上线，等业务方给到真实 Sheet 结构再改**）
3. 按第 5 节的 3 处改 `messageBuilders.js`（第 4 点等要接 Sheet 时再加）
4. 部署后去 TG Group/Channel 面板，给每个品牌填真实 chatId/topicId
5. 先测"普通类型"（比如 Withdraw Disapproved）和"Withdraw Amount Received Less"（唯一带金额字段的）各提交一次，确认 Telegram 消息格式、字段展开/收起逻辑都正常
6. 等业务方给到真实 Sheet 结构后，按第 4.4 节把 `SHEET_LAYOUT.withdraw_issue` 填对、`RECORD_TO_SHEET.withdraw_issue` 打开成 `true`，再测一次确认写对了列
