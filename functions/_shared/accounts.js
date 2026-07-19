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
 * DESIGN NOTE — no session/token. This is the "medium" tier discussed
 * with the business owner: real per-agent accounts with hashed
 * passwords and enforced server-side, but no session store. The browser
 * re-sends the username+password on every request (via the
 * X-Agent-User / X-Agent-Pass headers) and every protected endpoint
 * re-verifies them (password hash + office IP) on every single call —
 * simpler to build/maintain than real sessions, acceptable for an
 * internal tool used from a small number of fixed-IP offices. There is
 * no "log out" beyond clearing the browser's saved credentials.
 */

const OFFICES_INDEX_KEY = "offices-index";
const ACCOUNTS_INDEX_KEY = "accounts-index";

// Role hierarchy — each tier can act on anything strictly below it (see
// the per-endpoint checks in functions/api/admin/*.js and
// functions/api/account/*.js for exactly what each tier can do).
export const ROLE_RANK = { agent: 0, senior: 1, admin: 2, superadmin: 3 };
const VALID_ROLES = Object.keys(ROLE_RANK);
export function rankOf(role) { return ROLE_RANK[role] ?? ROLE_RANK.agent; }

// ---- password hashing (PBKDF2 via Web Crypto, available in Workers) ----

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { salt: bytesToBase64(salt), hash: bytesToBase64(new Uint8Array(bits)) };
}

export async function verifyPassword(password, salt, expectedHash) {
  const { hash } = await hashPassword(password, salt);
  return timingSafeEqual(hash, expectedHash);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

export async function listAccounts(env) {
  const raw = await env.THREADS_KV.get(ACCOUNTS_INDEX_KEY);
  const usernames = raw ? JSON.parse(raw) : [];
  const accounts = await Promise.all(usernames.map((u) => env.THREADS_KV.get(`account:${u}`)));
  return accounts.filter(Boolean).map((a) => stripSecret(JSON.parse(a)));
}

export async function getAccount(env, username) {
  const raw = await env.THREADS_KV.get(`account:${username.toLowerCase()}`);
  return raw ? JSON.parse(raw) : null;
}

function stripSecret(account) {
  const { salt, hash, ...rest } = account;
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
export async function saveAccount(env, { username, password, passwordChangedBy, role, officeId, allowedBrands, fullName, pid }) {
  const key = username.toLowerCase();
  const existing = await getAccount(env, key);
  let salt = existing?.salt;
  let hash = existing?.hash;
  let lastPasswordChange = existing?.lastPasswordChange || null;
  if (password) {
    const hashed = await hashPassword(password);
    salt = hashed.salt;
    hash = hashed.hash;
    lastPasswordChange = { at: new Date().toISOString(), by: passwordChangedBy || key };
  }
  if (!salt || !hash) throw new Error("A password is required for a new account.");

  const account = {
    username: key,
    salt,
    hash,
    role: role !== undefined ? (VALID_ROLES.includes(role) ? role : "agent") : (existing?.role || "agent"),
    officeId: officeId !== undefined ? (officeId || null) : (existing?.officeId ?? null),
    allowedBrands: allowedBrands !== undefined
      ? (allowedBrands === "all" ? "all" : (Array.isArray(allowedBrands) ? allowedBrands : []))
      : (existing?.allowedBrands ?? []),
    fullName: fullName !== undefined ? fullName : (existing?.fullName || ""),
    pid: pid !== undefined ? pid : (existing?.pid || ""),
    lastActiveAt: existing?.lastActiveAt || null,
    lastPasswordChange,
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
 * SuperAdmin is the ONE deliberate exception — every other role MUST be
 * bound to an office with a matching IP; an account with no officeId that
 * isn't SuperAdmin now fails this outright instead of silently skipping
 * the check. Shared by verifyRequest() (every protected endpoint) AND
 * auth/login.js (the login form itself, which can't just call
 * verifyRequest() since there's no verified identity yet at that point)
 * so the two can never drift out of sync with each other.
 */
export async function officeIpCheckPasses(env, account, request) {
  if (account.role === "superadmin") return true;
  if (!account.officeId) return false;
  const office = await getOffice(env, account.officeId);
  const ip = requestIP(request);
  return !!(office && office.allowedIPs.length && office.allowedIPs.includes(ip));
}

/**
 * Verifies the X-Agent-User / X-Agent-Pass headers on an incoming request:
 * password hash match AND the office/IP rule above. Returns the (secret-
 * stripped) account on success, or null on any failure — callers should
 * treat null as "not authorized" without leaking which specific check
 * failed (bad username vs bad password vs bad IP vs no office all look
 * the same from outside).
 */
export async function verifyRequest(request, env) {
  if (!env.THREADS_KV) return null;
  const username = request.headers.get("X-Agent-User");
  const password = request.headers.get("X-Agent-Pass");
  if (!username || !password) return null;

  const account = await getAccount(env, username);
  if (!account) return null;

  const passwordOk = await verifyPassword(password, account.salt, account.hash);
  if (!passwordOk) return null;

  if (!(await officeIpCheckPasses(env, account, request))) return null;

  await touchLastActive(env, account);
  return stripSecret(account);
}

export function canSeeBrand(account, brandName) {
  if (rankOf(account.role) >= ROLE_RANK.admin) return true; // admin & superadmin see everything
  if (account.allowedBrands === "all") return true;
  return Array.isArray(account.allowedBrands) && account.allowedBrands.includes(brandName);
}

/**
 * Gate for the Account-Management endpoints, parameterized by minimum
 * role rank. Two ways in:
 *   1. A real logged-in account whose role rank >= minRank
 *      (X-Agent-User/X-Agent-Pass).
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
