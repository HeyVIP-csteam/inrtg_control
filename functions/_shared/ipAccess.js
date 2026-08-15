/**
 * functions/_shared/ipAccess.js
 *
 * Backs the "IP Access" admin dashboard (public/index.html's Account
 * Management → IP Access, opened via openAcctModal("whitelist")). Layers
 * THREE new concepts on top of the existing Office/allowedIPs whitelist
 * (functions/_shared/accounts.js) without changing how a login is
 * actually gated:
 *
 *   - PENDING  — an office-bound account tried to log in with the right
 *     password from an IP NOT on its office's allowedIPs. That's
 *     already rejected today by officeIpCheckPasses() in accounts.js —
 *     this file doesn't touch that decision at all — but now, instead
 *     of that failure only living in a Telegram alert, it's ALSO parked
 *     here so an admin can see it and one-click Approve it straight onto
 *     the office's allowedIPs (or Reject it, which just clears the
 *     pending record — the account can still try again from a
 *     DIFFERENT IP, this only dismisses the one entry).
 *   - BLOCKED  — a NEW, separate rejection: a globally blocked IP is
 *     refused at login before the password is even checked, regardless
 *     of which account or office is involved. This is an ADDITION to
 *     the login flow (see functions/api/auth/login.js), not a
 *     replacement for officeIpCheckPasses().
 *   - RECORD   — one shared, capped audit log of every approve / reject
 *     / block / unblock / manual-add / remove action taken from this
 *     dashboard, newest first. Read-only — nothing else in the app
 *     writes to it.
 *
 * All three are single-key KV lists (same low-write-volume pattern as
 * _shared/threads.js's deletion log) — admin actions and real login
 * failures are nowhere near the write volume that made per-thread
 * "index" keys necessary elsewhere in this codebase.
 *
 * Per-IP "who added this and when" metadata rides on the Office record
 * itself as a new `ipMeta: { [ip]: { addedBy, addedAt, method } }` map
 * (see accounts.js's saveOffice(), which now preserves/merges this
 * field). Any IP with no ipMeta entry (every IP that existed before this
 * feature shipped) reads back as "Legacy entry" / "—", matching exactly
 * how the pre-existing PKR whitelist data should display.
 *
 * Every mutating function here takes `getOffice`/`saveOffice`/
 * `setAccountLocked` as PARAMETERS rather than importing them directly
 * from accounts.js — deliberate dependency injection, not an oversight,
 * so this module has zero import-time coupling to accounts.js (only
 * functions/api/admin/ip-access.js and functions/api/auth/login.js need
 * to wire the two together).
 */

const BLOCKED_KEY = "blocked-ips";
const PENDING_KEY = "pending-ips";
const LOG_KEY = "ip-access-log";
const MAX_LOG_SIZE = 500;
const MAX_PENDING_SIZE = 500;

async function readList(env, key) {
  const raw = await env.THREADS_KV.get(key);
  return raw ? JSON.parse(raw) : [];
}

async function writeList(env, key, list) {
  await env.THREADS_KV.put(key, JSON.stringify(list));
}

function newLogId() {
  return `ipa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function appendRecord(env, entry) {
  const list = await readList(env, LOG_KEY);
  list.unshift({ id: newLogId(), ts: new Date().toISOString(), ...entry });
  await writeList(env, LOG_KEY, list.slice(0, MAX_LOG_SIZE));
}

// ---- blocked (checked from login.js on EVERY login attempt) ----

export async function isIpBlocked(env, ip) {
  if (!ip) return false;
  const list = await readList(env, BLOCKED_KEY);
  return list.some((b) => b.ip === ip);
}

export async function blockIp(env, { ip, reason, by, byRole }) {
  const list = await readList(env, BLOCKED_KEY);
  if (list.some((b) => b.ip === ip)) throw new Error(`${ip} is already blocked.`);
  list.unshift({ ip, reason: reason || "", by, byRole, blockedAt: new Date().toISOString() });
  await writeList(env, BLOCKED_KEY, list);
  await appendRecord(env, { ip, action: "Blocked", by, byRole, detail: reason || "—" });
}

export async function unblockIp(env, { ip, by, byRole }) {
  const list = await readList(env, BLOCKED_KEY);
  const next = list.filter((b) => b.ip !== ip);
  if (next.length === list.length) throw new Error(`${ip} isn't currently blocked.`);
  await writeList(env, BLOCKED_KEY, next);
  await appendRecord(env, { ip, action: "Unblocked", by, byRole, detail: "—" });
}

// ---- pending ----

// Called from login.js's existing officeIpCheckPasses()-failed branch —
// fire-and-forget via waitUntil there, same as that branch's Telegram
// alert, so this never adds latency to the rejection response. Dedupes
// on (officeId, ip): a repeated attempt from the same unrecognized IP
// just bumps attempts/lastAttemptAt instead of piling up duplicate rows.
export async function recordPendingIpRequest(env, { officeId, officeName, ip, username }) {
  if (!officeId || !ip) return;
  const list = await readList(env, PENDING_KEY);
  const now = new Date().toISOString();
  const existing = list.find((p) => p.officeId === officeId && p.ip === ip);
  if (existing) {
    existing.lastAttemptAt = now;
    existing.attempts = (existing.attempts || 1) + 1;
    existing.username = username || existing.username; // most recent account to hit this pair
    existing.officeName = officeName || existing.officeName;
  } else {
    list.unshift({ officeId, officeName: officeName || null, ip, username: username || null, firstAttemptAt: now, lastAttemptAt: now, attempts: 1 });
  }
  await writeList(env, PENDING_KEY, list.slice(0, MAX_PENDING_SIZE));
}

async function removePending(env, { officeId, ip }) {
  const list = await readList(env, PENDING_KEY);
  const match = list.find((p) => p.officeId === officeId && p.ip === ip) || null;
  await writeList(env, PENDING_KEY, list.filter((p) => !(p.officeId === officeId && p.ip === ip)));
  return match;
}

export async function approveIpRequest(env, { officeId, ip, by, byRole, getOffice, saveOffice, setAccountLocked }) {
  const office = await getOffice(env, officeId);
  if (!office) throw new Error("Office not found.");
  const currentIPs = office.allowedIPs || [];
  const allowedIPs = currentIPs.includes(ip) ? currentIPs : [...currentIPs, ip];
  const ipMeta = { ...(office.ipMeta || {}), [ip]: { addedBy: by, addedAt: new Date().toISOString(), method: "Approved" } };
  const saved = await saveOffice(env, { id: officeId, name: office.name, allowedIPs, ipMeta });

  const match = await removePending(env, { officeId, ip });

  // Best-effort convenience, not a security decision: if the account that
  // generated this exact pending request is currently auto-locked, clear
  // that lock too — the missing whitelist entry is very likely WHY it
  // kept failing (see login.js's combined 5-in-1-hour counter, which
  // treats "unrecognized IP" the same as a wrong password). Narrow on
  // purpose: only ever the ONE account this pending row named, never a
  // blanket unlock of the whole office. Never allowed to fail the
  // approval itself.
  if (match?.username && setAccountLocked) {
    try {
      await setAccountLocked(env, match.username, false, null);
    } catch {
      // Account may already be unlocked, or may not exist anymore — fine either way.
    }
  }

  await appendRecord(env, { ip, action: "Approved", by, byRole, detail: office.name, officeId, officeName: office.name });
  return { office: saved };
}

export async function rejectIpRequest(env, { officeId, ip, by, byRole }) {
  const match = await removePending(env, { officeId, ip });
  await appendRecord(env, { ip, action: "Rejected", by, byRole, detail: match?.officeName || "—", officeId, officeName: match?.officeName || null });
}

// ---- manual add / remove (admin typing an IP in directly, not via a pending request) ----

export async function addManualIp(env, { officeId, ip, by, byRole, getOffice, saveOffice }) {
  const office = await getOffice(env, officeId);
  if (!office) throw new Error("Office not found.");
  const currentIPs = office.allowedIPs || [];
  if (currentIPs.includes(ip)) throw new Error(`${ip} is already approved for ${office.name}.`);
  const allowedIPs = [...currentIPs, ip];
  const ipMeta = { ...(office.ipMeta || {}), [ip]: { addedBy: by, addedAt: new Date().toISOString(), method: "Manual" } };
  const saved = await saveOffice(env, { id: officeId, name: office.name, allowedIPs, ipMeta });
  await appendRecord(env, { ip, action: "Manually Added", by, byRole, detail: office.name, officeId, officeName: office.name });
  return saved;
}

export async function removeApprovedIp(env, { officeId, ip, by, byRole, getOffice, saveOffice }) {
  const office = await getOffice(env, officeId);
  if (!office) throw new Error("Office not found.");
  const allowedIPs = (office.allowedIPs || []).filter((x) => x !== ip);
  const ipMeta = { ...(office.ipMeta || {}) };
  delete ipMeta[ip];
  await saveOffice(env, { id: officeId, name: office.name, allowedIPs, ipMeta });
  await appendRecord(env, { ip, action: "Removed", by, byRole, detail: office.name, officeId, officeName: office.name });
}

// ---- dashboard (GET /api/admin/ip-access) ----

export async function getIpAccessDashboard(env, { listOffices }) {
  const offices = await listOffices(env);
  const approved = [];
  for (const o of offices) {
    for (const ip of o.allowedIPs || []) {
      const meta = (o.ipMeta || {})[ip];
      approved.push({
        ip,
        officeId: o.id,
        officeName: o.name,
        addedBy: meta?.addedBy || "Legacy entry",
        addedAt: meta?.addedAt || null,
      });
    }
  }
  const [blocked, pending, record] = await Promise.all([
    readList(env, BLOCKED_KEY),
    readList(env, PENDING_KEY),
    readList(env, LOG_KEY),
  ]);
  return {
    stats: {
      total: approved.length + blocked.length,
      approved: approved.length,
      pending: pending.length,
      blocked: blocked.length,
    },
    approved,
    blocked,
    pending,
    record,
    offices: offices.map((o) => ({ id: o.id, name: o.name })),
  };
}
