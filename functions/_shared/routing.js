/**
 * routing.js  (SERVER-ONLY — anything under functions/_shared/ is never
 * routed by Cloudflare Pages, so this file is not reachable from the web)
 *
 * Fill in your real chat IDs, topic (message_thread_id) IDs and Google
 * Sheet webhook URLs here. Brand `id` keys must match public/assets/schemas.js.
 *
 * How to get a chat ID / topic ID:
 *   1. Add your bot to the group, enable "Topics" on the group if you want
 *      per-topic routing.
 *   2. Send any message in the group / topic, then open:
 *      https://api.telegram.org/bot<TOKEN>/getUpdates
 *   3. chat.id is the group's chatId (looks like -100xxxxxxxxxx).
 *      message_thread_id (present when a topic is used) is the topicId.
 *
 * Sheet logging uses a Google Cloud service account (see
 * functions/_shared/googleSheets.js) — no Apps Script needed. Per brand:
 *   1. Set `sheetId` below to the ID in the sheet's URL
 *      (https://docs.google.com/spreadsheets/d/<sheetId>/edit).
 *   2. Open that sheet → Share → add the service account's email
 *      (GOOGLE_SERVICE_ACCOUNT_EMAIL) as an Editor.
 * The service account credentials themselves are Cloudflare secrets, set
 * once for the whole project — see README.md.
 */

export const BRANDS = {
  betvisa: {
    name: "BetVisa",
    // The long ID in the sheet's URL: https://docs.google.com/spreadsheets/d/<THIS PART>/edit
    // Leave "" to disable sheet logging entirely for this brand.
    sheetId: "17wXVfUS8QywtiT8AiHxBr3iycKnWCR5vAJbCcboLJUs",
    telegram: {
      // Used when a module has no specific entry below.
      default: { chatId: "-1004488354399", topicId: null },
      qa: { chatId: "-1004488354399", topicId: 3 },
      account_issue: { chatId: "-1004488354399", topicId: 10 },
      promotion_request: { chatId: "-1004488354399", topicId: 17 },
      daily_report: { chatId: "-1004488354399", topicId: 22 },
      genie_issue: { chatId: "-1004488354399", topicId: 24 },
    },
  },
  betjili: {
    name: "Betjili",
    sheetId: "",
    telegram: {
      default: { chatId: "-100XXXXXXXXXX", topicId: null },
      qa: { chatId: "-100XXXXXXXXXX", topicId: null },
      account_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
      promotion_request: { chatId: "-100XXXXXXXXXX", topicId: null },
      daily_report: { chatId: "-100XXXXXXXXXX", topicId: null },
      genie_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
    },
  },
  crickex: {
    name: "Crickex",
    sheetId: "",
    telegram: {
      default: { chatId: "-100XXXXXXXXXX", topicId: null },
      qa: { chatId: "-100XXXXXXXXXX", topicId: null },
      account_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
      promotion_request: { chatId: "-100XXXXXXXXXX", topicId: null },
      daily_report: { chatId: "-100XXXXXXXXXX", topicId: null },
      genie_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
    },
  },
  jeetway: {
    name: "Jeetway",
    sheetId: "",
    telegram: {
      default: { chatId: "-100XXXXXXXXXX", topicId: null },
      qa: { chatId: "-100XXXXXXXXXX", topicId: null },
      account_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
      promotion_request: { chatId: "-100XXXXXXXXXX", topicId: null },
      daily_report: { chatId: "-100XXXXXXXXXX", topicId: null },
      genie_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
    },
  },
  mostplay: {
    name: "Mostplay",
    sheetId: "",
    telegram: {
      default: { chatId: "-100XXXXXXXXXX", topicId: null },
      qa: { chatId: "-100XXXXXXXXXX", topicId: null },
      account_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
      promotion_request: { chatId: "-100XXXXXXXXXX", topicId: null },
      daily_report: { chatId: "-100XXXXXXXXXX", topicId: null },
      genie_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
    },
  },
};

// Only these modules get written to the brand's Google Sheet.
// Flip any of these to change what gets recorded, independent of Telegram routing.
export const RECORD_TO_SHEET = {
  qa: true,
  account_issue: true,
  promotion_request: true,
  daily_report: true,
  genie_issue: true,
};

// Emoji + display name per module, used to build the Telegram message header.
export const MODULE_META = {
  qa: { emoji: "🔐", name: "QA" },
  account_issue: { emoji: "🔑", name: "Account Issue" },
  promotion_request: { emoji: "🎟️", name: "Promotion Request" },
  daily_report: { emoji: "📊", name: "Daily Report" },
  genie_issue: { emoji: "🤖", name: "Genie Issue" },
};

/**
 * Optional per-module Telegram message template — just the field rows, no
 * "New X — Brand" header line. `key` works the same as in SHEET_LAYOUT
 * above — a field key, "brand"/"pic"/"screenshotLink", or a
 * { details: [fallbackKeys...] } object for first-non-empty-wins fields.
 *
 * A module's value here can be either:
 *   - a plain array → one fixed template for every submission
 *   - { selectorField, templates: { <value>: [...], default: [...] } } →
 *     picks a template based on that field's submitted value (falls back
 *     to `default` if no exact match), e.g. QA's Domain Issue motive uses
 *     a completely different set of rows than the other 5 motives.
 * Add an entry here per module once you know the exact wording wanted.
 */
export const MESSAGE_TEMPLATE = {
  qa: {
    selectorField: "motive",
    templates: {
      "Domain Issue": [
        { emoji: "🎮", label: "Brand / Platform", key: "brand" },
        { emoji: "📅", label: "Date", key: "date" },
        { emoji: "🆔", label: "UID", key: "uid" },
        { emoji: "📝", label: "Issue Details", key: "issueDetails" },
        { emoji: "🌐", label: "Domain Link", key: "domainLink" },
        { emoji: "👤", label: "PIC", key: "pic" },
      ],
      default: [
        { emoji: "📅", label: "Date", key: "date" },
        { emoji: "🆔", label: "UID", key: "uid" },
        { emoji: "📱", label: "Number", key: "number" },
        { emoji: "📧", label: "Email", key: "email" },
        { emoji: "🎯", label: "Motive", key: "motive" },
        { emoji: "📝", label: "Remark", key: "remark" },
        { emoji: "👤", label: "PIC", key: "pic" },
      ],
    },
  },
};

/**
 * Maps a module to an EXISTING tab in the brand's sheet with its own fixed
 * column layout (used instead of the generic auto-create-headers path).
 * `startColumn` is the sheet's first data column (e.g. "B" when column A is
 * left blank/unused, matching the reference sheet).
 * `columns` lists, in left-to-right order, which value goes in each column —
 * each entry is either a field key (from that module's schema.js fields,
 * e.g. "date", "uid", "motive") or one of these special values:
 *   "brand"          → the brand's display name
 *   "pic"            → the reporter/agent name
 *   "screenshotLink" → clickable Telegram links to the uploaded attachments
 *   "details"        → falls back through a list of field keys, first non-empty wins
 * Add an entry here per module once you know that module's tab name + columns.
 */
export const SHEET_LAYOUT = {
  qa: {
    tab: "QA OTP & Domain",
    startColumn: "B",
    columns: ["date", "uid", "number", "email", "brand", "motive", "domainLink", "screenshotLink", { details: ["remark", "issueDetails"] }, "pic"],
  },
};
