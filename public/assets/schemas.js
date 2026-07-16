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
  { id: "betjili", name: "Betjili" },
  { id: "crickex", name: "Crickex" },
  { id: "jeetway", name: "Jeetway" },
  { id: "mostplay", name: "Mostplay" },
];

// Every module gets the same attachment slot (screenshots/PDFs, shown as a
// drag-and-drop + paste dropzone under its fields). Change `max` per module
// if one of them shouldn't allow attachments.
const DEFAULT_ATTACHMENTS = { max: 3, accept: "image/png,image/jpeg,application/pdf" };

// A field can declare `showIf: { field: "<otherFieldKey>", oneOf: [...values] }`
// to only appear when that other field currently holds one of those values —
// e.g. "Add Number" only shows up when Issue Type is "Add Mobile Number Verify".
// It stays in the DOM (kept in field order) but is hidden + not required
// until its condition is met, so add each issue type's extra fields inline
// at the position they should appear.

// Each module = one card on the hub + one generic form page (form.html?module=<id>)
// `emphasize: true` on a field draws the highlighted box style (used for the
// main "what kind of issue is this" selector, matching the reference design).
const MODULES = [
  {
    id: "qa",
    name: "QA",
    icon: "🔐",
    formTitle: "QA Check",
    accent: "#60A5FA",
    description: "Email Verify, Number Verify, Forget Password SMS, Forget Password Email, Add Secondary Number, Domain Issue — check with QA",
    reporterLabel: "PIC",
    attachments: DEFAULT_ATTACHMENTS,
    fields: [
      {
        key: "motive", label: "Motive", type: "select", required: true, emphasize: true,
        options: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number", "Domain Issue"],
      },
      { key: "date", label: "Date", type: "date", required: true },
      { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID..." },
      {
        key: "number", label: "Number", type: "text", required: false, placeholder: "Phone number...",
        showIf: { field: "motive", oneOf: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number"] },
      },
      {
        key: "email", label: "Email", type: "text", required: false, placeholder: "Email address...",
        showIf: { field: "motive", oneOf: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number"] },
      },
      {
        key: "domainLink", label: "Domain Link", type: "text", required: true, placeholder: "https://...",
        showIf: { field: "motive", oneOf: ["Domain Issue"] },
      },
      {
        key: "remark", label: "Remark", type: "textarea", required: true, placeholder: "Additional remarks...",
        showIf: { field: "motive", oneOf: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number"] },
      },
      {
        key: "issueDetails", label: "Issue Details", type: "textarea", required: true, placeholder: "Describe the domain issue...",
        showIf: { field: "motive", oneOf: ["Domain Issue"] },
      },
    ],
  },
  {
    id: "account_issue",
    name: "Account Issue",
    icon: "🔑",
    accent: "#FBBF24",
    description: "Select brand and issue type",
    attachments: DEFAULT_ATTACHMENTS,
    fields: [
      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
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
      { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
      { key: "registerNumber", label: "Register Number", type: "text", required: true, placeholder: "Register number..." },
      {
        key: "addNumber", label: "Add Number", type: "text", required: false, placeholder: "Number to add...",
        showIf: { field: "issueType", oneOf: ["Add Mobile Number Verify"] },
      },
      { key: "nid", label: "NID", type: "text", required: false, placeholder: "NID number..." },
      { key: "remark", label: "Issue & Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
    ],
  },
  {
    id: "promotion_request",
    name: "Promotion Request",
    icon: "🎟️",
    accent: "#F472B6",
    description: "Bonus, cashback and promo code requests that need manual review.",
    attachments: DEFAULT_ATTACHMENTS,
    fields: [
      {
        key: "bonusType", label: "Bonus Type", type: "select", required: true, emphasize: true,
        options: ["Deposit Bonus", "Cashback", "Free Bet", "Birthday Bonus", "Referral Bonus", "Other"],
      },
      { key: "userId", label: "User ID", type: "text", required: true, placeholder: "Player ID" },
      { key: "promoCode", label: "Promo Code", type: "text", required: false },
      { key: "amount", label: "Amount", type: "number", required: false, placeholder: "0.00" },
      { key: "remark", label: "Issue & Remark", type: "textarea", required: true, placeholder: "Reason / notes..." },
    ],
  },
  {
    id: "daily_report",
    name: "Daily Report",
    icon: "📊",
    formTitle: "Daily Report",
    accent: "#34D399",
    description: "Shift summary — logged to the Day or Night block in the tracking sheet based on which shift you pick.",
    reporterLabel: "Reported by",
    attachments: DEFAULT_ATTACHMENTS,
    fields: [
      { key: "shift", label: "Shift", type: "select", required: true, emphasize: true, options: ["Day Shift", "Night Shift"] },
      { key: "reportDate", label: "Date", type: "date", required: true },
      { key: "majorIssues", label: "Major Issues", type: "textarea", required: false },
      { key: "csIssues", label: "CS Issues", type: "textarea", required: false },
      { key: "paymentIssues", label: "Payment Issues", type: "textarea", required: false },
      { key: "minorSystemBugs", label: "Minor System Bugs", type: "textarea", required: false },
      { key: "domainControl", label: "Domain Control", type: "textarea", required: false },
      { key: "providerIssues", label: "Provider Issues", type: "textarea", required: false },
      { key: "promotionQuests", label: "Promotion Quests", type: "textarea", required: false },
      { key: "othersIssues", label: "Others Issues", type: "textarea", required: false },
    ],
  },
  {
    id: "genie_issue",
    name: "Genie Issue",
    icon: "🤖",
    accent: "#A78BFA",
    description: "Problems with Genie chat sessions — stuck replies, wrong answers, escalations.",
    attachments: DEFAULT_ATTACHMENTS,
    fields: [
      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: ["Stuck Reply", "Wrong Answer", "Escalation Needed", "Session Not Loading", "Other"],
      },
      { key: "sessionId", label: "Chat / Session ID", type: "text", required: false },
      { key: "userId", label: "User ID", type: "text", required: false, placeholder: "Player ID (if applicable)" },
      { key: "remark", label: "Issue & Remark", type: "textarea", required: true },
    ],
  },
];

// Shared across pages via <script src="/assets/schemas.js"></script> (no modules, keep it simple + cache-friendly)
window.BRANDS = BRANDS;
window.MODULES = MODULES;
