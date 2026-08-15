/**
 * accounts.js  (SERVER-ONLY)
 *
 * Backs the TG Reply Threads account system: Offices (a name + a small
 * allowed-IP list) and Accounts (username/password/role/brand access,
 * each belonging to one Office). Stored in the same THREADS_KV namespace
 * as everything else in this feature, under their own key prefixes so
 * nothing collides with thread records:
 *
 *   office:<id>        → { id, name, allowedIPs: [...] }
 *   offices-index       → JSON array of office ids
 *   account:<username>  → { username, salt, hash, role, officeId, allowedBrands }
 *   accounts-index       → JSON array of usernames
 *
 * DESIGN NOTE — SESSION TOKENS (replaces the old "no session" model).
 *
 * SECURITY INCIDENT, 2026-07-20: the original design stored the agent's
 * PLAINTEXT password in the browser's localStorage (`agentAuth`) and
 * re-sent it on every request via X-Agent-User/X-Agent-Pass headers, so
 * every protected endpoint could re-verify the password hash + office IP
 * on every single call without a session store. This was found to be
 * trivially readable via browser DevTools (F12 → Application → Local
 * Storage) by anyone with physical/remote access to an already-logged-in
 * browser — i.e. the password was sitting in the clear, independent of
 * how strong the server-side hash was. Replaced with signed session
 * tokens:
 *   - On login, the server issues a signed token (HMAC-SHA256 over
 *     {username, tokenVersion, iat, exp} using the SESSION_TOKEN_SECRET
 *     env secret) — see issueToken()/verifyToken() below.
 *   - The browser stores ONLY this token (never the password) and sends
 *     it as X-Agent-Token on every request.
 *   - verifyToken() checks the signature + expiry; verifyRequest() then
 *     re-fetches the account and checks it's not locked AND that the
 *     token's `tokenVersion` still matches the account's current
 *     tokenVersion (bumped on every password change and every lock/
 *     unlock — see saveAccount()/setAccountLocked()), so a token that
 *     predates a password reset or a lock immediately stops working,
 *     same guarantee the old design had.
 *   - Tokens expire after TOKEN_TTL_MS regardless (hard ceiling on top
 *     of the client-side 2h idle timeout in authguard.js).
 * REQUIRES a new Cloudflare secret: SESSION_TOKEN_SECRET (any long
 * random string — used only to sign/verify tokens, never sent to the
 * browser). If unset, issueToken()/verifyToken() throw/fail closed
 * rather than silently signing with a guessable key.
 */

const OFFICES_INDEX_KEY = "offices-index";
const ACCOUNTS_INDEX_KEY = "accounts-index";

// Role hierarchy — each tier can act on anything STRICTLY below it (same
// rank can't manage same rank either — see canManage() in
// functions/api/admin/accounts.js). "owner" sits above superadmin: hidden
// from every account listing, can't be assigned through the website at
// all (see ASSIGNABLE_ROLES below and saveAccount()'s role handling),
// and is the only rank exempt from the office/IP login requirement (see
// officeIpCheckPasses()). Created once, directly in KV, outside the
// website entirely — see OWNER_ROLE_SETUP.md for that one-time step.
export const ROLE_RANK = { agent: 0, senior: 1, admin: 2, superadmin: 3, owner: 4 };
const VALID_ROLES = Object.keys(ROLE_RANK);
// "owner" deliberately excluded — saveAccount() below only ever accepts
// a role from THIS list, so there is no code path anywhere (regardless
// of what a caller further up the stack does or doesn't check) that can
// result in a new "owner" account. The only way to create one is the
// direct-KV-write process in OWNER_ROLE_SETUP.md.
const ASSIGNABLE_ROLES = VALID_ROLES.filter((r) => r !== "owner");
export function rankOf(role) { return ROLE_RANK[role] ?? ROLE_RANK.agent; }

// ---- Account Management Access ----
//
// The sidebar's "Account Management" dropdown has 4 gated items: Create
// Account, Whitelist IP, TG Group/Channel, Agent Profile (Reset Password
// is a 5th subitem but is intentionally NOT in this list/gate at all —
// every rank keeps seeing it, unconditionally, same as before). Which of
// the 4 gated items an account can see/edit is a per-account,
// Owner-controlled choice ON TOP OF a rank floor — the floor still has to
// be met (an "agent"-rank account can never see any of these, regardless
// of any override), but within that floor the Owner decides per-account
// via `allowedAdminSections` ("all" | array of ids | unset) and, for the
// 3 editable sections, `adminSectionEditAccess` ("all" | array of ids |
// unset).
//
// SECURITY FIX — 2026-07-28: `unset` used to mean "show/allow everything
// the rank floor alone would permit", i.e. every Admin+ account defaulted
// to seeing (and, once the account.js UI is opened, being one Owner click
// away from being granted) ALL FOUR sections the moment it crossed a
// floor, with no deliberate Owner action required. That is exactly
// backwards for a permissions feature — a brand new Admin- or
// SuperAdmin-rank account should start LOCKED DOWN to a safe minimum and
// require the Owner to deliberately widen it, not the other way round.
// `unset` now falls back to a role-based default preset (below) instead
// of "everything the floor allows". The Owner can still override any
// individual account, in either direction (narrower OR wider than its
// role's default — e.g. dropping a SuperAdmin to view-only, or handing an
// Admin extra sections), by explicitly setting allowedAdminSections /
// adminSectionEditAccess on that account — that explicit array/"all"
// value always wins over the role default below.
export const ADMIN_SECTIONS_LIST = [
  { id: "createAccount", name: "Create Account", icon: "➕", floorRank: ROLE_RANK.senior },
  { id: "whitelistIp", name: "IP Access", icon: "🌐", floorRank: ROLE_RANK.admin },
  { id: "tgRoutes", name: "TG Group / Channel", icon: "📡", floorRank: ROLE_RANK.admin },
  { id: "agentProfile", name: "Agent Profile", icon: "🪪", floorRank: ROLE_RANK.admin },
  // Settings admin panel — @ mention history backfill (TG Reply
  // Threads) + the announcement banner's rotation speed. Same tier as
  // tgRoutes (both are feature-control panels, not raw account/
  // financial data).
  { id: "settings", name: "Settings", icon: "⚙️", floorRank: ROLE_RANK.admin },
  // Sensitive config surface (wrong link = CS reading/editing the wrong
  // brand's live deposit data) — floor is superadmin, not admin, so
  // Admin/Senior never see it at all unless individually granted via
  // allowedAdminSections, same opt-in-only pattern as the others.
  { id: "depositSheets", name: "Deposit Sheet Link", icon: "🧾", floorRank: ROLE_RANK.superadmin },
  // Live-editable link list behind the "HeyVIP Betting Rules" home card
  // (public/betting-resources.html) — SuperAdmin-tier, same shape as
  // tgRoutes: reading the page itself is open to any logged-in agent,
  // only EDITING the link list is gated here.
  { id: "bettingLinks", name: "Betting Resources Links", icon: "🔗", floorRank: ROLE_RANK.superadmin },
  // Home-page brand-pill marquee links (public/index.html's brand row —
  // was previously "any logged-in agent" via the pill's own ✏️ button;
  // moved here 2026-08-15 so only the Owner (or whoever the Owner grants
  // this section to) can change where a brand's pill opens). Same
  // public-read/gated-write shape as bettingLinks: any logged-in agent
  // can still SEE and click the pills (GET /api/brand-config stays
  // unauthenticated), only EDITING a link is gated here.
  { id: "webLinks", name: "Web Link", icon: "🔗", floorRank: ROLE_RANK.superadmin },
  // NOTE — "announcements" and "activeAgents" USED to live here (both
  // superadmin-tier, Owner-controlled Account Management Access items).
  // Moved out, 2026-08-10 — they're now OWNER_TOPIC_ITEMS below, living
  // in the Agent Profile's "Topic access" list instead of Account
  // Management Access. See the comment on OWNER_TOPIC_ITEMS for why, and
  // canAccessOwnerTopic() for the enforcement.
];

// Role-based defaults, used ONLY when the Owner has never explicitly set
// allowedAdminSections / adminSectionEditAccess on that specific account.
//   - agent:      sees none of the 4 (Reset Password only, ungated)
//   - senior:     Create Account only (the one section its floor unlocks)
//   - admin:      Whitelist IP (view-only)
//   - superadmin: every remaining section, all fully editable
//   - owner:      always full access — short-circuited before these are
//                 ever consulted, see canSeeAdminSection()/canEditAdminSection()
export const ADMIN_SECTIONS_DEFAULT_SEEN = {
  agent: [],
  senior: ["createAccount"],
  admin: ["whitelistIp"],
  superadmin: ["createAccount", "whitelistIp", "tgRoutes", "agentProfile", "depositSheets", "settings", "bettingLinks", "webLinks"],
};
export const ADMIN_SECTIONS_DEFAULT_EDIT = {
  agent: [],
  senior: [],
  admin: [], // Whitelist IP visible but view-only by default
  superadmin: ["whitelistIp", "tgRoutes", "agentProfile", "depositSheets", "settings", "bettingLinks", "webLinks"],
};

// ---- Owner Topics ("Topic access", Owner-gated items) ----
//
// MOVED, 2026-08-10: "Announcements" and "Active Agents" used to be
// Account Management Access items (ADMIN_SECTIONS_LIST above) —
// superadmin-tier, but editable by ANY Owner-delegated account via
// canManageOthersAdminAccess() (canGrantAdminAccess), same as every
// other Account Management Access item. Per a direct request, both moved
// into the Agent Personal Profile's "Topic access" list instead (next to
// the real form-module checkboxes, e.g. qa/account_issue/...) — but they
// are NOT real form modules (there's no form.html?module=announcements),
// so they are NOT added to allowedModules/window.MODULES. They live in
// this separate, parallel list instead, and are rendered inline with the
// module checkboxes purely as a UI grouping — see
// public/index.html's OWNER_TOPIC_ITEMS + openAgentProfileModal().
//
// Deliberately its OWN field (`ownerTopicAccess`, see saveAccount()
// below) rather than reusing `allowedModules`:
//   - `allowedModules` defaults to "all" for every account (new or
//     pre-existing) — reusing it here would mean every account
//     automatically got Announcements/Active Agents access the moment
//     this shipped, exactly backwards for something that's supposed to
//     require deliberate Owner action.
//   - `allowedModules === "all"` is also achieved just by an agent
//     having every REAL topic checked — that can't be allowed to
//     silently double as "and also grant these two Owner-gated items",
//     see canAccessOwnerTopic() below.
//
// STRICTLY Owner-only to grant (not delegable via canGrantAdminAccess,
// unlike Account Management Access) — enforced in
// functions/api/admin/accounts.js. `ownerTopicAccess` defaults to an
// EMPTY array for every account, new or pre-existing — nobody is
// grandfathered in; the Owner has to explicitly check the box for each
// account, same "opt-in-only" principle the rest of this file uses.
//
// No rank floor, on purpose (2026-08-14 — previously had one, see git
// history): the Owner checking the box for an account IS the access
// decision, full stop — an `agent`-ranked account the Owner has
// deliberately opted in to Active Agents gets it, same as an admin
// would. Layering a rank requirement on top of an explicit per-account
// grant just means the Owner's own click can silently not take effect
// depending on the target's role, which defeats the point of a
// per-account opt-in list in the first place.
export const OWNER_TOPIC_ITEMS = [
  { id: "announcements", name: "Announcements", icon: "📢" },
  { id: "activeAgents", name: "Active Agents", icon: "👥" },
  // Added 2026-08-15 — the "Integration Portal" sidebar group (TG Group/
  // Channel, Deposit Sheet Link, Betting Resources Links, Web Link) now
  // needs an EXPLICIT per-account grant here before it shows in the
  // sidebar at all, on top of (not instead of) the existing
  // "Integration Portal Access" checkboxes in Account Management Access
  // (see EDITABLE ADMIN_SECTIONS / canSeeAdminSection for tgRoutes/
  // depositSheets/bettingLinks/webLinks). Same reasoning as everywhere
  // else this list is used: this is a coarse "can this account see the
  // menu entry at all" gate, separate from the finer "which of the 4
  // items inside it, view or edit" gate underneath — an account needs
  // BOTH checked to actually see anything (see the sidebar visibility
  // check in public/index.html).
  { id: "integrationPortal", name: "Integration Portal", icon: "🔗" },
];

export function canAccessOwnerTopic(account, topicId) {
  if (!account) return true; // bootstrap mode — same full trust bootstrapPassword already had
  if (account.role === "owner") return true;
  const topic = OWNER_TOPIC_ITEMS.find((t) => t.id === topicId);
  if (!topic) return false;
  // No "all" shortcut either (see the comment above) — explicit
  // membership in ownerTopicAccess is the ONLY way in, regardless of
  // rank or of what allowedModules holds.
  return Array.isArray(account.ownerTopicAccess) && account.ownerTopicAccess.includes(topicId);
}

export function canSeeAdminSection(account, sectionId) {
  if (!account) return true; // bootstrap mode — same full trust bootstrapPassword already had
  if (account.role === "owner") return true;
  const section = ADMIN_SECTIONS_LIST.find((s) => s.id === sectionId);
  if (!section) return false;
  if (rankOf(account.role) < section.floorRank) return false;
  if (account.allowedAdminSections === "all") return true;
  if (Array.isArray(account.allowedAdminSections)) return account.allowedAdminSections.includes(sectionId);
  // Unset — never explicitly touched by the Owner — falls back to this
  // account's role default (see ADMIN_SECTIONS_DEFAULT_SEEN above), NOT
  // to "everything the floor allows" like before the 2026-07-28 fix.
  return (ADMIN_SECTIONS_DEFAULT_SEEN[account.role] || []).includes(sectionId);
}

// Only the Owner — or an account the Owner has explicitly delegated this
// to via the "Can manage Account Management Access for other accounts"
// checkbox (`canGrantAdminAccess`) — can grant/restrict OTHER accounts'
// Account Management Access (both the see-it layer above and the edit-it
// layer below). The delegation flag itself can only ever be set by the
// real Owner (enforced in functions/api/admin/accounts.js, not here) —
// so a delegated account can extend Account Management Access to others,
// but can never hand out the delegation power itself, and (per the
// caller-side rank check in accounts.js) can only act on accounts
// ranked below its own.
export function canManageOthersAdminAccess(account) {
  return !!account && (account.role === "owner" || account.canGrantAdminAccess === true);
}

// View-vs-Edit split, for the 3 sections where "seeing it" and "changing
// it" are meaningfully different actions. "createAccount" has no
// view-only mode — creating an account IS the whole action, so it's
// excluded here and stays governed by canSeeAdminSection() alone.
//
// DESIGN: this is the ONLY gate for edit rights on these 3 sections —
// rank plays no further role beyond already being required to pass
// canSeeAdminSection() above. An Admin-rank account CAN be granted
// Can-Edit on e.g. whitelistIp, and a SuperAdmin CAN be left at
// View-only. (The separate "actor must outrank the TARGET account" rule
// for Agent Profile edits, in functions/api/admin/accounts.js, is a
// different, still-active protection — not replaced by this.)
export const EDITABLE_ADMIN_SECTIONS = ["whitelistIp", "tgRoutes", "agentProfile", "depositSheets", "settings", "bettingLinks", "webLinks"];

export function canEditAdminSection(account, sectionId) {
  if (!account) return true; // bootstrap mode
  if (account.role === "owner") return true;
  if (!canSeeAdminSection(account, sectionId)) return false;
  if (account.adminSectionEditAccess === "all") return true;
  if (Array.isArray(account.adminSectionEditAccess)) return account.adminSectionEditAccess.includes(sectionId);
  // Unset — role-default edit level (see ADMIN_SECTIONS_DEFAULT_EDIT
  // above). Previously defaulted to "no edit" for everyone, which was
  // safe but ALSO wrongly capped SuperAdmin at view-only by default.
  return (ADMIN_SECTIONS_DEFAULT_EDIT[account.role] || []).includes(sectionId);
}

// ---- password hashing (PBKDF2 via Web Crypto, available in Workers) ----
//
// ITERATION COUNT — lowered this session, see below for why.
//
// This system has no session/token (see the design note above): every
// single request re-verifies the password from scratch via
// verifyPassword(), including every 6-second sidebar poll. Cloudflare
// Workers' Free plan caps CPU time at 10ms per request — and PBKDF2 at
// the OLD count (100,000 iterations) was landing right at or over that
// ceiling on every authenticated call, especially once you add the rest
// of the request's own JS work on top. Cloudflare's own docs flag
// exactly this: "heavier workloads that handle authentication... typically
// use 10-20ms" of CPU time on Free — this is a documented, known way to
// blow the Free plan's budget, not a misconfiguration on our end. When a
// request exceeds the CPU limit, Cloudflare kills the isolate at the
// platform level — that's NOT a catchable JS exception, so none of the
// try/catch safety nets added earlier this session could ever have caught
// it; it surfaces to the browser as a bare network-level 503, no JSON
// body, which matches exactly what showed up in testing.
//
// Lowering the iteration count directly cuts that CPU cost. Every
// EXISTING account's password hash was computed at the OLD count and
// will only ever verify correctly against that count — so instead of a
// single global constant, each account record stores the iteration count
// that was actually used for IT specifically (`iterations` field, added
// this session). New accounts / password resets from now on get the new
// lower count; every account created before this change keeps working
// unmodified, verified at the count it was actually hashed with. Nothing
// needs a forced password reset.
const PBKDF2_ITERATIONS_CURRENT = 10000; // used for any password hashed from now on
const PBKDF2_ITERATIONS_LEGACY_FALLBACK = 100000; // only for account records saved before this session, which predate the `iterations` field

async function hashPassword(password, saltB64, iterations = PBKDF2_ITERATIONS_CURRENT) {
  const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { salt: bytesToBase64(salt), hash: bytesToBase64(new Uint8Array(bits)), iterations };
}

// `iterations` MUST be the count that particular account's hash was
// actually created with (account.iterations) — falls back to the old
// hardcoded value only for account records saved before this field
// existed, so nothing that already worked breaks.
export async function verifyPassword(password, salt, expectedHash, iterations = PBKDF2_ITERATIONS_LEGACY_FALLBACK) {
  const { hash } = await hashPassword(password, salt, iterations);
  return timingSafeEqual(hash, expectedHash);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- session tokens (HMAC-SHA256, replaces sending the password on
// every request — see the DESIGN NOTE at the top of this file) ----

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h hard ceiling, independent of the client-side 2h idle timeout

async function getSigningKey(env) {
  if (!env.SESSION_TOKEN_SECRET) {
    throw new Error("SESSION_TOKEN_SECRET is not configured — set it in Cloudflare (Settings → Environment variables, Production) to any long random string.");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function toBase64Url(bytes) {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Issues a signed session token for an account, good for TOKEN_TTL_MS.
 * Payload carries the account's CURRENT tokenVersion, so this token
 * stops verifying the instant that version changes (password reset,
 * lock, or unlock) — see verifyToken()/verifyRequest().
 */
export async function issueToken(env, account) {
  const payload = {
    u: account.username,
    v: account.tokenVersion || 0,
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await getSigningKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = toBase64Url(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verifies a token's signature and expiry. Does NOT check tokenVersion
 * or lock state against the account — that requires a KV read, done by
 * the caller (verifyRequest()) once it has both the token payload and
 * the current account record. Returns the decoded payload ({u, v, iat,
 * exp}) on success, or null on any failure (bad signature, malformed,
 * expired, secret not configured).
 */
export async function verifyToken(env, token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;
  try {
    const key = await getSigningKey(env);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(sigB64),
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
    if (!payload.u || typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- offices ----

export async function listOffices(env) {
  const raw = await env.THREADS_KV.get(OFFICES_INDEX_KEY);
  const ids = raw ? JSON.parse(raw) : [];
  const offices = await Promise.all(ids.map((id) => env.THREADS_KV.get(`office:${id}`)));
  return offices.filter(Boolean).map((o) => JSON.parse(o));
}

export async function getOffice(env, id) {
  const raw = await env.THREADS_KV.get(`office:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function saveOffice(env, { id, name, allowedIPs }) {
  const officeId = id || `off_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const office = { id: officeId, name, allowedIPs: (allowedIPs || []).map((ip) => ip.trim()).filter(Boolean) };
  await env.THREADS_KV.put(`office:${officeId}`, JSON.stringify(office));
  if (!id) {
    const raw = await env.THREADS_KV.get(OFFICES_INDEX_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    if (!ids.includes(officeId)) {
      ids.unshift(officeId);
      await env.THREADS_KV.put(OFFICES_INDEX_KEY, JSON.stringify(ids));
    }
  }
  return office;
}

export async function deleteOffice(env, id) {
  await env.THREADS_KV.delete(`office:${id}`);
  const raw = await env.THREADS_KV.get(OFFICES_INDEX_KEY);
  const ids = raw ? JSON.parse(raw) : [];
  await env.THREADS_KV.put(OFFICES_INDEX_KEY, JSON.stringify(ids.filter((x) => x !== id)));
}

// ---- accounts ----

// The ONE data exit point for "list every account" — anyAdminExists(),
// anySuperAdminExists(), and GET /api/admin/accounts (functions/api/
// admin/accounts.js) all go through this, so filtering owner out HERE
// makes it disappear from all three automatically, with no risk of one
// of them forgetting to filter separately. `viewerUsername` defaults to
// undefined (fully hidden, including from itself) — only pass it when
// the caller has already confirmed the CURRENT viewer IS that owner
// account, which lets exactly that one row through so an owner viewing
// their own Agent Profile table can see themselves.
export async function listAccounts(env, { viewerUsername } = {}) {
  const raw = await env.THREADS_KV.get(ACCOUNTS_INDEX_KEY);
  const usernames = raw ? JSON.parse(raw) : [];
  const accounts = await Promise.all(usernames.map((u) => env.THREADS_KV.get(`account:${u}`)));
  return accounts.filter(Boolean).map((a) => JSON.parse(a))
    .filter((a) => a.role !== "owner" || a.username === viewerUsername)
    .map(stripSecret);
}

export async function getAccount(env, username) {
  const raw = await env.THREADS_KV.get(`account:${username.toLowerCase()}`);
  return raw ? JSON.parse(raw) : null;
}

function stripSecret(account) {
  const { salt, hash, iterations, ...rest } = account;
  return rest;
}

// role: "agent" | "admin". allowedBrands: array of brand names, or "all".
// Any field left `undefined` keeps its EXISTING value (patch semantics) —
// this matters a lot now that lightweight callers (e.g. just touching
// lastActiveAt, or just editing fullName/pid) shouldn't have to resend
// role/officeId/allowedBrands/password just to avoid wiping them out.
// `passwordChangedBy` is only meaningful when `password` is also given —
// the username of whoever triggered the change (their own, for
// self-service; the admin's, for an admin-driven reset).
export async function saveAccount(env, { username, password, passwordChangedBy, role, officeId, allowedBrands, allowedModules, allowedAdminSections, adminSectionEditAccess, canGrantAdminAccess, ownerTopicAccess, fullName, pid }) {
  const key = username.toLowerCase();
  const existing = await getAccount(env, key);
  let salt = existing?.salt;
  let hash = existing?.hash;
  // Pre-existing accounts saved before this field existed are implicitly
  // the old iteration count — see the note above hashPassword().
  let iterations = existing?.iterations || PBKDF2_ITERATIONS_LEGACY_FALLBACK;
  let lastPasswordChange = existing?.lastPasswordChange || null;
  // Bumped on every password change so any already-issued session token
  // (see issueToken()/verifyToken() above) is invalidated the instant a
  // password changes — a browser holding an old token can no longer use
  // it, same guarantee the old "re-send the password every request"
  // design had for free.
  let tokenVersion = existing?.tokenVersion || 0;
  if (password) {
    const hashed = await hashPassword(password);
    salt = hashed.salt;
    hash = hashed.hash;
    iterations = hashed.iterations;
    lastPasswordChange = { at: new Date().toISOString(), by: passwordChangedBy || key };
    tokenVersion += 1;
  }
  if (!salt || !hash) throw new Error("A password is required for a new account.");

  // ASSIGNABLE_ROLES (not VALID_ROLES) on purpose — see its definition
  // above. If anything, anywhere, ever passes role: "owner" here: an
  // existing account keeps its current role unchanged (never downgraded,
  // never "upgraded" to owner); a brand-new account falls back to
  // "agent". This is the actual enforcement point — every other check
  // (canManage(), the explicit early rejection in
  // functions/api/admin/accounts.js, etc.) is defense in depth on top of
  // this, not instead of it.
  const finalRole = role !== undefined
    ? (ASSIGNABLE_ROLES.includes(role) ? role : (existing?.role || "agent"))
    : (existing?.role || "agent");

  // Default Can-Edit set for a NEW account, or any pre-existing account
  // that has never had adminSectionEditAccess explicitly touched yet —
  // mirrors what rank ALONE used to determine before this became a
  // per-account choice (SuperAdmin+ could edit Whitelist IP/Agent
  // Profile outright, TG Routes too; everyone else was view-only or
  // couldn't see it at all). This exists purely so switching this
  // feature on doesn't silently downgrade every existing SuperAdmin to
  // view-only — the Owner doesn't have to manually re-grant Can-Edit to
  // accounts that already effectively had it. The instant the Owner
  // explicitly sets this field (even to an empty array), that value wins
  // forever after.
  const defaultAdminSectionEditAccess = rankOf(finalRole) >= ROLE_RANK.superadmin ? "all" : [];

  const account = {
    username: key,
    salt,
    hash,
    iterations,
    tokenVersion,
    // ASSIGNABLE_ROLES (not VALID_ROLES) on purpose — see finalRole above,
    // computed once and reused so the same value backs both this field
    // and the Can-Edit default below.
    role: finalRole,
    officeId: officeId !== undefined ? (officeId || null) : (existing?.officeId ?? null),
    allowedBrands: allowedBrands !== undefined
      ? (allowedBrands === "all" ? "all" : (Array.isArray(allowedBrands) ? allowedBrands : []))
      : (existing?.allowedBrands ?? []),
    // Topic Access, in the Agent Personal Profile modal. Same shape as
    // allowedBrands ("all" or an explicit array of module ids), but
    // defaults to "all" — not []  — both for brand-new accounts AND for
    // any pre-existing account saved before this field existed. Business
    // decision: new accounts start with every topic visible, and nobody
    // gets retroactively locked out of topics they already had access to
    // just because this feature shipped after they were created.
    allowedModules: allowedModules !== undefined
      ? (allowedModules === "all" ? "all" : (Array.isArray(allowedModules) ? allowedModules : []))
      : (existing?.allowedModules ?? "all"),
    // Account Management Access — which of the 4 admin-sidebar sections
    // this account can even see. "all" | array of ids | left unset
    // entirely (never touched by the Owner, so canSeeAdminSection() falls
    // back to rank-floor-only behavior — see that function's comment).
    allowedAdminSections: allowedAdminSections !== undefined
      ? (allowedAdminSections === "all" ? "all" : (Array.isArray(allowedAdminSections) ? allowedAdminSections : []))
      : existing?.allowedAdminSections,
    // Of the sections this account can see, which it can also EDIT (vs.
    // View only). See canEditAdminSection() + defaultAdminSectionEditAccess
    // above for why the fallback is role-based instead of just [].
    adminSectionEditAccess: adminSectionEditAccess !== undefined
      ? (adminSectionEditAccess === "all" ? "all" : (Array.isArray(adminSectionEditAccess) ? adminSectionEditAccess : []))
      : (existing?.adminSectionEditAccess !== undefined ? existing.adminSectionEditAccess : defaultAdminSectionEditAccess),
    // "Can manage Account Management Access for other accounts" — lets
    // this account act as a delegate for canManageOthersAdminAccess()
    // (see that function). Owner-only to set (enforced in
    // functions/api/admin/accounts.js) — defaults to false for every
    // account, new or pre-existing, so nobody gains this power just by
    // this field shipping.
    canGrantAdminAccess: canGrantAdminAccess !== undefined ? !!canGrantAdminAccess : (existing?.canGrantAdminAccess || false),
    // Owner Topics ("Topic access" list — Announcements / Active
    // Agents). Always an explicit array, never "all" — see
    // OWNER_TOPIC_ITEMS above for why. Defaults to [] (locked out) for
    // every account, new or pre-existing; only an explicit Owner save
    // ever changes it.
    ownerTopicAccess: ownerTopicAccess !== undefined
      ? (Array.isArray(ownerTopicAccess) ? ownerTopicAccess : [])
      : (existing?.ownerTopicAccess ?? []),
    fullName: fullName !== undefined ? fullName : (existing?.fullName || ""),
    pid: pid !== undefined ? pid : (existing?.pid || ""),
    lastActiveAt: existing?.lastActiveAt || null,
    lastPasswordChange,
    // Lock state is intentionally NOT a parameter of saveAccount() — it's
    // only ever touched by setAccountLocked() below (manual SuperAdmin
    // action, or the auto-lock triggers in api/auth/login.js), so a
    // routine profile-field save can never accidentally lock/unlock
    // someone as a side effect.
    locked: existing?.locked || false,
    lockedAt: existing?.lockedAt || null,
    lockedReason: existing?.lockedReason || null,
  };
  await env.THREADS_KV.put(`account:${key}`, JSON.stringify(account));
  if (!existing) {
    const raw = await env.THREADS_KV.get(ACCOUNTS_INDEX_KEY);
    const usernames = raw ? JSON.parse(raw) : [];
    if (!usernames.includes(key)) {
      usernames.unshift(key);
      await env.THREADS_KV.put(ACCOUNTS_INDEX_KEY, JSON.stringify(usernames));
    }
  }
  return stripSecret(account);
}

// Dedicated lock/unlock — deliberately separate from saveAccount() (see
// note above) so this is the ONLY code path that ever changes lock
// state, whether triggered by a SuperAdmin's manual click or by one of
// the auto-lock triggers in api/auth/login.js (too many distinct
// unrecognized IPs in an hour, or too many consecutive wrong passwords).
export async function setAccountLocked(env, username, locked, reason) {
  const key = username.toLowerCase();
  const existing = await getAccount(env, key);
  if (!existing) return null;
  existing.locked = !!locked;
  existing.lockedAt = locked ? new Date().toISOString() : null;
  existing.lockedReason = locked ? (reason || "Locked") : null;
  // Bump on both lock AND unlock — a token issued before the lock should
  // never come back to life just because the account was later unlocked;
  // whoever unlocks it should get a fresh token via a real login.
  existing.tokenVersion = (existing.tokenVersion || 0) + 1;
  await env.THREADS_KV.put(`account:${key}`, JSON.stringify(existing));
  return stripSecret(existing);
}

export async function deleteAccount(env, username) {
  const key = username.toLowerCase();
  await env.THREADS_KV.delete(`account:${key}`);
  const raw = await env.THREADS_KV.get(ACCOUNTS_INDEX_KEY);
  const usernames = raw ? JSON.parse(raw) : [];
  await env.THREADS_KV.put(ACCOUNTS_INDEX_KEY, JSON.stringify(usernames.filter((u) => u !== key)));
}

// "Admin-or-above exists" — governs the original bootstrap window (create
// the very first admin-tier account with the BRAND_EDIT_PASSWORD).
export async function anyAdminExists(env) {
  const accounts = await listAccounts(env);
  return accounts.some((a) => rankOf(a.role) >= ROLE_RANK.admin);
}

// Governs the SuperAdmin self-promotion bootstrap (see authenticateStaff
// below) — once true, that path closes for good.
export async function anySuperAdminExists(env) {
  const accounts = await listAccounts(env);
  return accounts.some((a) => a.role === "superadmin");
}

// ---- request-time auth ----

export function requestIP(request) {
  return request.headers.get("CF-Connecting-IP") || "";
}

// Cheap "last seen" tracking — throttled to at most one KV write per
// account per 5 minutes, otherwise every single poll/request from every
// logged-in agent would each cost a write and blow through KV's free-tier
// daily write limit fast. This means Last Active Time in Agent Profile is
// "accurate to within ~5 minutes", not to-the-second — an acceptable
// trade for how it's actually used (spotting accounts that have gone
// quiet, not a real-time presence indicator).
async function touchLastActive(env, account) {
  const now = Date.now();
  const last = account.lastActiveAt ? new Date(account.lastActiveAt).getTime() : 0;
  if (now - last < 5 * 60 * 1000) return;
  const fresh = await getAccount(env, account.username);
  if (!fresh) return;
  fresh.lastActiveAt = new Date(now).toISOString();
  await env.THREADS_KV.put(`account:${account.username}`, JSON.stringify(fresh));
}

/**
 * Whether an account passes the office/IP check for a given request.
 * Owner is the ONE deliberate exception now — SuperAdmin used to be
 * exempt too, but per OWNER_ROLE_SETUP.md's design, SuperAdmin now MUST
 * be bound to an office with a matching IP just like every other visible
 * role; an account with no officeId that isn't Owner fails this outright
 * instead of silently skipping the check. Shared by verifyRequest()
 * (every protected endpoint) AND auth/login.js (the login form itself,
 * which can't just call verifyRequest() since there's no verified
 * identity yet at that point) so the two can never drift out of sync
 * with each other.
 */
export async function officeIpCheckPasses(env, account, request) {
  if (account.role === "owner") return true;
  if (!account.officeId) return false;
  const office = await getOffice(env, account.officeId);
  const ip = requestIP(request);
  return !!(office && office.allowedIPs.length && office.allowedIPs.includes(ip));
}

/**
 * Verifies the X-Agent-Token header on an incoming request: signature +
 * expiry (verifyToken()), AND that the token's tokenVersion still
 * matches the account's current one (rejects tokens issued before a
 * password change or a lock/unlock cycle), AND the office/IP rule.
 * Returns the (secret-stripped) account on success, or null on any
 * failure — callers should treat null as "not authorized" without
 * leaking which specific check failed.
 */
export async function verifyRequest(request, env) {
  if (!env.THREADS_KV) return null;
  const token = request.headers.get("X-Agent-Token");
  if (!token) return null;

  const payload = await verifyToken(env, token);
  if (!payload) return null;

  const account = await getAccount(env, payload.u);
  if (!account) return null;

  // Checked BEFORE anything else — a locked account should be rejected
  // on every single request, and a browser holding a still-unexpired
  // token from before the lock must not keep working.
  if (account.locked) return null;

  // A token from before the most recent password change / lock / unlock
  // is stale even if its signature and expiry are both still valid.
  if ((account.tokenVersion || 0) !== payload.v) return null;

  // IP Access blocklist check — deliberately a raw KV read here instead
  // of importing isIpBlocked() from _shared/ipAccess.js, because that
  // module imports getOffice()/saveOffice()/setAccountLocked()/
  // listOffices() FROM this file — importing back from here would be a
  // circular module dependency. It's one line either way; not worth the
  // risk of a bundler mishandling the cycle. Keep the `ipblock:<ip>` key
  // shape in sync with _shared/ipAccess.js if that ever changes. Checked
  // before officeIpCheckPasses() — cheaper (no office KV read) and a
  // blocked IP should never even get to see "not on the approved list"
  // wording, just the block message (mirrored in login.js).
  if (await env.THREADS_KV.get(`ipblock:${requestIP(request)}`)) return null;

  if (!(await officeIpCheckPasses(env, account, request))) return null;

  await touchLastActive(env, account);
  return stripSecret(account);
}

export function canSeeBrand(account, brandName) {
  if (rankOf(account.role) >= ROLE_RANK.admin) return true; // admin & superadmin see everything
  if (account.allowedBrands === "all") return true;
  return Array.isArray(account.allowedBrands) && account.allowedBrands.includes(brandName);
}

// Topic Access — same shape/rules as canSeeBrand above (admin & superadmin
// are never restricted; only "agent"-rank accounts can be limited to a
// subset of topics/modules via the Agent Personal Profile modal).
export function canSeeModule(account, moduleId) {
  if (rankOf(account.role) >= ROLE_RANK.admin) return true;
  if (account.allowedModules === "all" || account.allowedModules === undefined) return true;
  return Array.isArray(account.allowedModules) && account.allowedModules.includes(moduleId);
}

/**
 * Gate for the Account-Management endpoints, parameterized by minimum
 * role rank. Two ways in:
 *   1. A real logged-in account whose role rank >= minRank (X-Agent-Token).
 *   2. BOOTSTRAP MODE: if no admin-or-above account exists in KV yet at
 *      all, and minRank is admin or below, the existing
 *      BRAND_EDIT_PASSWORD secret works as a one-time key (sent as
 *      X-Bootstrap-Password) purely to let the business owner create the
 *      very first admin account. The instant one admin-or-above account
 *      exists, this fallback stops being accepted — it's not a
 *      permanent second door, just a way to get started.
 */
export async function authenticateStaff(request, env, minRank) {
  const viaAccount = await verifyRequest(request, env);
  if (viaAccount && rankOf(viaAccount.role) >= minRank) return { ok: true, account: viaAccount };

  // Bootstrap mode grants FULL trust (any minRank, including superadmin
  // operations like creating an Office) but ONLY while zero admin-or-above
  // accounts exist anywhere — that's the entire initial-setup window
  // (create the first Office, then the first admin account). The instant
  // one admin-or-above account exists, this fallback stops being accepted
  // for good, at any rank — it's not a permanent second door.
  const bootstrapPassword = request.headers.get("X-Bootstrap-Password");
  if (bootstrapPassword && env.BRAND_EDIT_PASSWORD && bootstrapPassword === env.BRAND_EDIT_PASSWORD) {
    const hasAdmin = await anyAdminExists(env);
    if (!hasAdmin) return { ok: true, account: null, bootstrap: true };
  }

  return { ok: false };
}

// Back-compat alias — deletion-log.js and anywhere else that only ever
// needs the "classic" admin-or-above gate can keep using this name.
export async function authenticateAdmin(request, env) {
  return authenticateStaff(request, env, ROLE_RANK.admin);
}
