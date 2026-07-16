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
 * How to get a Sheet webhook URL:
 *   Use a Google Apps Script bound to each brand's sheet, deployed as a
 *   Web App (Execute as: Me, Who has access: Anyone with the link).
 *   The script should read e.doc.postData.contents (JSON), then append a
 *   row. See README.md "Google Sheets logging" section for a ready script.
 */

export const BRANDS = {
  betvisa: {
    name: "BetVisa",
    // Apps Script Web App URL for this brand's sheet. Leave "" to disable sheet logging entirely for this brand.
    sheetWebhookUrl: "",
    telegram: {
      // Used when a module has no specific entry below.
      default: { chatId: "-100XXXXXXXXXX", topicId: null },
      qa: { chatId: "-100XXXXXXXXXX", topicId: null },
      account_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
      promotion_request: { chatId: "-100XXXXXXXXXX", topicId: null },
      daily_report: { chatId: "-100XXXXXXXXXX", topicId: null },
      genie_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
    },
  },
  brand2: {
    name: "Brand 2",
    sheetWebhookUrl: "",
    telegram: {
      default: { chatId: "-100XXXXXXXXXX", topicId: null },
      qa: { chatId: "-100XXXXXXXXXX", topicId: null },
      account_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
      promotion_request: { chatId: "-100XXXXXXXXXX", topicId: null },
      daily_report: { chatId: "-100XXXXXXXXXX", topicId: null },
      genie_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
    },
  },
  brand3: {
    name: "Brand 3",
    sheetWebhookUrl: "",
    telegram: {
      default: { chatId: "-100XXXXXXXXXX", topicId: null },
      qa: { chatId: "-100XXXXXXXXXX", topicId: null },
      account_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
      promotion_request: { chatId: "-100XXXXXXXXXX", topicId: null },
      daily_report: { chatId: "-100XXXXXXXXXX", topicId: null },
      genie_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
    },
  },
  brand4: {
    name: "Brand 4",
    sheetWebhookUrl: "",
    telegram: {
      default: { chatId: "-100XXXXXXXXXX", topicId: null },
      qa: { chatId: "-100XXXXXXXXXX", topicId: null },
      account_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
      promotion_request: { chatId: "-100XXXXXXXXXX", topicId: null },
      daily_report: { chatId: "-100XXXXXXXXXX", topicId: null },
      genie_issue: { chatId: "-100XXXXXXXXXX", topicId: null },
    },
  },
  brand5: {
    name: "Brand 5",
    sheetWebhookUrl: "",
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
  qa: false,
  account_issue: true,
  promotion_request: true,
  daily_report: true,
  genie_issue: false,
};

// Emoji + display name per module, used to build the Telegram message header.
export const MODULE_META = {
  qa: { emoji: "🔍", name: "QA" },
  account_issue: { emoji: "🔑", name: "Account Issue" },
  promotion_request: { emoji: "🎟️", name: "Promotion Request" },
  daily_report: { emoji: "📊", name: "Daily Report" },
  genie_issue: { emoji: "🤖", name: "Genie Issue" },
};
