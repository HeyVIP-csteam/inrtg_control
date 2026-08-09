/**
 * IP Access — approval workflow layered ON TOP OF the existing office
 * allowedIPs whitelist, not a replacement for it. The one line of code
 * that actually decides "does this login pass" — officeIpCheckPasses()
 * in accounts.js, `office.allowedIPs.includes(ip)` — is untouched by
 * anything in this file. Every function here either just READS that
 * data, or calls the existing saveOffice()/setAccountLocked() to change
 * it. If something in this file has a bug, the actual login path is not
 * at risk — worst case is a pending record doesn't get created, or an
 * approve doesn't go through, not that login silently breaks.
 *
 * KV key shapes:
 *   ipreq:<officeId>:<ip>    -> pending approval record
 *   ipblock:<ip>             -> global blocklist entry (not office-scoped
 *                                — a blocked IP is blocked everywhere,
 *                                regardless of which office/account it's
 *                                trying to reach)
 *   ipmeta:<officeId>:<ip>   -> provenance for an IP that's ALREADY in an
 *                                office's allowedIPs (who/how it got
 *                                there) — purely informational, never
 *                                consulted by the login check itself
 *   ipaccess-log             -> single shared audit-trail key, same
 *                                pattern as threads.js's deletion-log
 */
import { getOffice, saveOffice, setAccountLocked, listOffices } from "./accounts.js";

const MAX_LOG_SIZE = 500;
const LOG_KEY = "ipaccess-log";

function newLogId() {
  return `ipa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function kvPutWithRetry(env, key, value, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await env.THREADS_KV.put(key, value);
      return;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 150 * (i + 1) + Math.floor(Math.random() * 100)));
    }
  }
  throw lastErr;
}

export async function logIpAction(env, entry) {
  const raw = await env.THREADS_KV.get(LOG_KEY);
  const list = raw ? JSON.parse(raw) : [];
  list.unshift({ id: newLogId(), ts: new Date().toISOString(), ...entry });
  await kvPutWithRetry(env, LOG_KEY, JSON.stringify(list.slice(0, MAX_LOG_SIZE)));
}

export async function listIpAccessLog(env) {
  const raw = await env.THREADS_KV.get(LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

// ---- IP format validation ----
//
// Only ever called for HUMAN-TYPED input (manualAdd / block) — approve/
// reject IPs come straight from a real pending record, which itself was
// only ever created from requestIP(request) on a real HTTP request, so
// it's already a well-formed address and doesn't need re-checking.
// Exists because of a real bug seen on a reference project: someone
// pasted a full URL ("https://203.189.67.234") into an IP field and it
// got stored as-is, silently breaking that entry forever.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/;
export function isValidIpFormat(ip) {
  if (!ip || typeof ip !== "string") return false;
  const m = ip.match(IPV4_RE);
  if (m) return m.slice(1).every((octet) => Number(octet) <= 255);
  return IPV6_RE.test(ip) && ip.includes(":");
}

// ---- blocklist ----

export async function isIpBlocked(env, ip) {
  if (!ip) return false;
  return !!(await env.THREADS_KV.get(`ipblock:${ip}`));
}

export async function blockIp(env, { ip, reason, by, byRole }) {
  await env.THREADS_KV.put(`ipblock:${ip}`, JSON.stringify({
    ip, reason: reason || "", blockedBy: by, blockedByRole: byRole, blockedAt: new Date().toISOString(),
  }));
  await logIpAction(env, { action: "block", category: "blocked", ip, by, byRole, detail: reason || "" });
}

export async function unblockIp(env, { ip, by, byRole }) {
  await env.THREADS_KV.delete(`ipblock:${ip}`);
  await logIpAction(env, { action: "unblock", category: "blocked", ip, by, byRole });
}

// ---- pending (approval queue) ----

// Called on a real login failure caused SPECIFICALLY by the IP not being
// on the office's allowedIPs — never for wrong-password or no-office
// failures (those aren't "this IP, this office" situations at all).
export async function recordPendingIpAttempt(env, { ip, officeId, officeName, username, userAgent, country, city }) {
  if (!ip || !officeId) return;
  if (await isIpBlocked(env, ip)) return; // already-blocked IPs don't get a pending queue entry
  const key = `ipreq:${officeId}:${ip}`;
  const raw = await env.THREADS_KV.get(key);
  if (raw) {
    // Same IP retrying — bump the counter, don't spam a new log line or
    // create a second record for the same (office, ip) pair.
    const existing = JSON.parse(raw);
    existing.attempts = (existing.attempts || 1) + 1;
    existing.lastAttemptAt = new Date().toISOString();
    if (username) existing.username = username; // most recent attempted username wins
    await env.THREADS_KV.put(key, JSON.stringify(existing));
    return;
  }
  const record = {
    ip, officeId, officeName: officeName || "", username: username || "",
    userAgent: userAgent || "", country: country || "", city: city || "",
    attempts: 1, firstAttemptAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(),
  };
  await env.THREADS_KV.put(key, JSON.stringify(record));
  await logIpAction(env, { action: "pending-created", category: "pending", ip, officeId, officeName: officeName || "", detail: username || "" });
}

export async function getPendingIpRequest(env, officeId, ip) {
  const raw = await env.THREADS_KV.get(`ipreq:${officeId}:${ip}`);
  return raw ? JSON.parse(raw) : null;
}

// Approve = add to the office's real allowedIPs (via the EXISTING
// saveOffice(), same function the office picker uses) + record
// provenance + clear the pending record + unlock the account that was
// stuck behind this IP, if any + audit log. Four side effects, one call.
export async function approveIpRequest(env, { officeId, ip, by, byRole }) {
  const pending = await getPendingIpRequest(env, officeId, ip);
  const office = await getOffice(env, officeId);
  if (!office) throw new Error("Office not found.");
  if (!office.allowedIPs.includes(ip)) {
    await saveOffice(env, { id: office.id, name: office.name, allowedIPs: [...office.allowedIPs, ip] });
  }
  await env.THREADS_KV.put(`ipmeta:${officeId}:${ip}`, JSON.stringify({
    source: "approved", addedBy: by, addedByRole: byRole, addedAt: new Date().toISOString(),
  }));
  await env.THREADS_KV.delete(`ipreq:${officeId}:${ip}`);
  if (pending?.username) {
    // Best-effort — an approve should still succeed even if the account
    // was deleted/renamed in the meantime; unlocking is a bonus, not a
    // precondition.
    await setAccountLocked(env, pending.username, false).catch(() => {});
  }
  await logIpAction(env, { action: "approve", category: "approved", ip, officeId, officeName: office.name, by, byRole, detail: pending?.username || "" });
}

export async function rejectIpRequest(env, { officeId, ip, by, byRole }) {
  const office = await getOffice(env, officeId);
  await env.THREADS_KV.delete(`ipreq:${officeId}:${ip}`);
  await logIpAction(env, { action: "reject", category: "pending", ip, officeId, officeName: office?.name || "", by, byRole });
}

// ---- manual add / remove (skips the pending queue entirely) ----

export async function manualAddIp(env, { officeId, ip, by, byRole }) {
  const office = await getOffice(env, officeId);
  if (!office) throw new Error("Office not found.");
  if (!office.allowedIPs.includes(ip)) {
    await saveOffice(env, { id: office.id, name: office.name, allowedIPs: [...office.allowedIPs, ip] });
  }
  await env.THREADS_KV.put(`ipmeta:${officeId}:${ip}`, JSON.stringify({
    source: "manual", addedBy: by, addedByRole: byRole, addedAt: new Date().toISOString(),
  }));
  await env.THREADS_KV.delete(`ipreq:${officeId}:${ip}`); // in case it was also sitting in the pending queue
  await logIpAction(env, { action: "manual-add", category: "approved", ip, officeId, officeName: office.name, by, byRole });
}

export async function removeIp(env, { officeId, ip, by, byRole }) {
  const office = await getOffice(env, officeId);
  if (!office) throw new Error("Office not found.");
  await saveOffice(env, { id: office.id, name: office.name, allowedIPs: office.allowedIPs.filter((x) => x !== ip) });
  await env.THREADS_KV.delete(`ipmeta:${officeId}:${ip}`);
  await logIpAction(env, { action: "remove", category: "approved", ip, officeId, officeName: office.name, by, byRole });
}

// ---- dashboard read model ----
//
// Scans ipreq:*/ipblock:* with THREADS_KV.list() (same paginated-cursor
// pattern threads.js uses for thread:*) — these are low-volume compared
// to threads, so one bounded loop with a generous limit is plenty, no
// caching layer needed the way threads.js's sidebar scan has one.
async function listByPrefix(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.THREADS_KV.list({ prefix, cursor, limit: 1000 });
    out.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export async function getIpAccessDashboard(env) {
  const [offices, pendingKeys, blockKeys] = await Promise.all([
    listOffices(env),
    listByPrefix(env, "ipreq:"),
    listByPrefix(env, "ipblock:"),
  ]);
  const pending = (await Promise.all(pendingKeys.map((k) => env.THREADS_KV.get(k))))
    .filter(Boolean).map((raw) => JSON.parse(raw));

  const blocked = (await Promise.all(blockKeys.map((k) => env.THREADS_KV.get(k))))
    .filter(Boolean).map((raw) => JSON.parse(raw));

  // "Approved" isn't its own KV key — it's just every IP that's already
  // sitting in some office's allowedIPs. Cross-referenced with ipmeta
  // for the "Added by" column when available; falls back to "office
  // whitelist" for IPs that predate this feature and never got a meta
  // record written for them.
  const metaKeys = [];
  offices.forEach((o) => (o.allowedIPs || []).forEach((ip) => metaKeys.push(`ipmeta:${o.id}:${ip}`)));
  const metaRaw = await Promise.all(metaKeys.map((k) => env.THREADS_KV.get(k)));
  const metaByKey = {};
  metaKeys.forEach((k, i) => { if (metaRaw[i]) metaByKey[k] = JSON.parse(metaRaw[i]); });

  const approved = [];
  offices.forEach((o) => {
    (o.allowedIPs || []).forEach((ip) => {
      const meta = metaByKey[`ipmeta:${o.id}:${ip}`];
      approved.push({
        ip, officeId: o.id, officeName: o.name,
        source: meta?.source || "office whitelist",
        addedBy: meta?.addedBy || "",
        addedByRole: meta?.addedByRole || "",
        addedAt: meta?.addedAt || "",
      });
    });
  });

  const stats = {
    totalIPs: approved.length + blocked.length,
    approved: approved.length,
    pending: pending.length,
    blocked: blocked.length,
  };

  return { stats, pending, approved, blocked, offices: offices.map((o) => ({ id: o.id, name: o.name })) };
}
