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
  qa: { emoji: "🔍", name: "QA" },
  account_issue: { emoji: "🔑", name: "Account Issue" },
  promotion_request: { emoji: "🎟️", name: "Promotion Request" },
  daily_report: { emoji: "📊", name: "Daily Report" },
  genie_issue: { emoji: "🤖", name: "Genie Issue" },
};
