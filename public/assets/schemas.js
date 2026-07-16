/**
 * schemas.js
 * Single source of truth for brands + form fields, used by the hub page
 * and the generic form renderer. This file is PUBLIC (served as a static
 * asset) so it must never contain secrets, chat IDs, or sheet URLs —
 * that routing lives server-side in functions/_shared/routing.js.
 */

// Rename / add your real brands here. The `id` must match the brand key
// used in functions/_shared/routing.js on the server.
const BRANDS = [
  { id: "betvisa", name: "BetVisa" },
  { id: "brand2", name: "Brand 2" },
  { id: "brand3", name: "Brand 3" },
  { id: "brand4", name: "Brand 4" },
  { id: "brand5", name: "Brand 5" },
];

// Each module = one card on the hub + one generic form page (form.html?module=<id>)
const MODULES = [
  {
    id: "qa",
    name: "QA",
    icon: "🔍",
    accent: "#60A5FA", // blue
    description: "Quality checks and bug reports for agents to flag before they reach production.",
    fields: [
      { key: "ticketId", label: "Ticket / Case ID", type: "text", required: false, placeholder: "e.g. CS-10234" },
      {
        key: "category", label: "Category", type: "select", required: true,
        options: ["Deposit", "Withdraw", "Account", "Bonus / Promotion", "Game / Provider", "Website / App", "Other"],
      },
      {
        key: "priority", label: "Priority", type: "select", required: true,
        options: ["Low", "Medium", "High", "Urgent"],
      },
      { key: "userId", label: "User ID", type: "text", required: false, placeholder: "Player ID (if applicable)" },
      { key: "description", label: "Description", type: "textarea", required: true, placeholder: "What's wrong, steps to reproduce, expected vs actual..." },
      { key: "attachmentUrl", label: "Screenshot / Video Link", type: "text", required: false, placeholder: "https://..." },
    ],
  },
  {
    id: "account_issue",
    name: "Account Issue",
    icon: "🔑",
    accent: "#FBBF24", // amber
    description: "Registration, verification, KYC and login issues tied to a player account.",
    fields: [
      {
        key: "issueType", label: "Issue Type", type: "select", required: true,
        options: [
          "Register Number Verification",
          "Add Mobile Number Verify",
          "Add Number Remove",
          "Registration Number Inputted Wrong",
          "Gmail Verification",
          "Gmail Remove",
          "Customer Email Change / Inactive / Lost",
          "Forgot Password (OTP Limit Exceeded)",
          "Forget Username & Gmail",
          "KYC Issues",
        ],
      },
      { key: "userId", label: "User ID", type: "text", required: true, placeholder: "Player ID" },
      { key: "registeredContact", label: "Registered Mobile / Email", type: "text", required: false },
      { key: "description", label: "Description", type: "textarea", required: true },
      { key: "attachmentUrl", label: "Screenshot Link", type: "text", required: false, placeholder: "https://..." },
    ],
  },
  {
    id: "promotion_request",
    name: "Promotion Request",
    icon: "🎟️",
    accent: "#F472B6", // pink
    description: "Bonus, cashback and promo code requests that need manual review.",
    fields: [
      { key: "promoCode", label: "Promo Code", type: "text", required: false },
      { key: "userId", label: "User ID", type: "text", required: true, placeholder: "Player ID" },
      {
        key: "bonusType", label: "Bonus Type", type: "select", required: true,
        options: ["Deposit Bonus", "Cashback", "Free Bet", "Birthday Bonus", "Referral Bonus", "Other"],
      },
      { key: "amount", label: "Amount", type: "number", required: false, placeholder: "0.00" },
      { key: "reason", label: "Reason / Notes", type: "textarea", required: true },
      { key: "attachmentUrl", label: "Screenshot Link", type: "text", required: false, placeholder: "https://..." },
    ],
  },
  {
    id: "daily_report",
    name: "Daily Report",
    icon: "📊",
    accent: "#34D399", // green
    description: "End-of-shift summary that gets logged straight to the tracking sheet.",
    fields: [
      { key: "reportDate", label: "Date", type: "date", required: true },
      {
        key: "shift", label: "Shift", type: "select", required: true,
        options: ["Morning", "Afternoon", "Night"],
      },
      { key: "reporter", label: "Reporter", type: "text", required: true, placeholder: "Your name" },
      { key: "totalIssues", label: "Total Issues Handled", type: "number", required: false, placeholder: "0" },
      { key: "summary", label: "Summary", type: "textarea", required: true, placeholder: "Notable issues, escalations, pending items..." },
    ],
  },
  {
    id: "genie_issue",
    name: "Genie Issue",
    icon: "🤖",
    accent: "#A78BFA", // purple
    description: "Problems with Genie chat sessions — stuck replies, wrong answers, escalations.",
    fields: [
      { key: "sessionId", label: "Chat / Session ID", type: "text", required: false },
      { key: "userId", label: "User ID", type: "text", required: false, placeholder: "Player ID (if applicable)" },
      { key: "description", label: "Issue Description", type: "textarea", required: true },
      { key: "attachmentUrl", label: "Screenshot Link", type: "text", required: false, placeholder: "https://..." },
    ],
  },
];

// Shared across pages via <script src="/assets/schemas.js"></script> (no modules, keep it simple + cache-friendly)
window.BRANDS = BRANDS;
window.MODULES = MODULES;
