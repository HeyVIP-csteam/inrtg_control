/**
 * threads.js  (SERVER-ONLY)
 *
 * Storage for the "TG Reply Threads" feature — tracks each form submission
 * that was sent to Telegram, plus every reply that lands in that Telegram
 * thread (via webhook) or is sent back out from the dashboard.
 *
 * Backed by Cloudflare KV (binding: THREADS_KV — see wrangler.toml).
 * Two kinds of keys:
 *   thread:<id>          → full thread record (JSON), with a lightweight
 *                           summary attached as this key's KV *metadata*
 *   msgid:<chatId>:<mid>  → thread id (string) — lets the Telegram webhook
 *                           find which thread a reply belongs to in O(1)
 *
 * NO SHARED "index" KEY ANYMORE. Every write used to also rewrite one
 * single `"index"` JSON blob (the sidebar's data source) — but Cloudflare
 * KV allows at most 1 write/sec to the SAME key, and every reply/submit/
 * solve-toggle/edit was hitting that one key, so concurrent agents could
 * genuinely 429 each other. Instead, each thread's own summary now rides
 * along as *metadata* on that thread's own `put()` — a different key per
 * thread, so two agents touching two different tickets never contend with
 * each other at all (only two edits to the exact same ticket in the same
 * second still could, which is a much smaller, much rarer surface). The
 * sidebar is built with `THREADS_KV.list({ prefix: "thread:" })`, which
 * returns every thread's metadata without fetching the full record —
 * cheap, and there's no per-key limit on reads, only writes.
 *
 * Trade-off: `list()` is only *eventually* consistent across Cloudflare's
 * edge (per Cloudflare's docs, propagation is usually fast but isn't
 * instant/global like a single-key read), so a brand-new ticket can take
 * a little longer to appear in someone else's sidebar than it used to.
 * Given the previous alternative was writes silently dropped/delayed
 * under contention, this is a straightforward trade in the sidebar's
 * favor. Any `thread:<id>` key saved before this change has no metadata
 * yet — `listThreads()` below transparently falls back to reading that
 * one thread's full record and re-saves it with metadata attached so it
 * only ever needs to do that once per pre-existing ticket. That healing is
 * capped per call (MAX_HEAL_PER_CALL, near listThreads() below) — right
 * after this ships, EVERY pre-existing ticket needs healing at once, and
 * Cloudflare caps how many subrequests one call can make, so healing them
 * all in a single call risked 503ing the whole page (this actually
 * happened during testing). The sidebar catches up over a few 6-second
 * polls instead — a one-time, self-resolving cost.
 *
 * AUTO-CLEANUP — controls how many KV "writes"/"deletes" you burn per day
 * (see the free-plan limits: 1,000 writes/day, 1,000 deletes/day). Adjust
 * the two numbers below to change how long tickets stick around; set
 * either to `Infinity` to disable that rule entirely. Cleanup runs
 * opportunistically (piggy-backing on normal reads), since Cloudflare
 * Pages Functions don't support Cron Triggers.
 */

// Solved tickets older than this many days are auto-deleted.
const SOLVED_RETENTION_DAYS = 30;
// Any ticket (solved or not) with zero activity for this many days is
// auto-deleted as a safety net, so a never-solved ticket can't sit forever.
const STALE_RETENTION_DAYS = 90;

function newId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Still used for the low-frequency admin deletion log (one shared key, but
// only written on an actual delete/recall action — nowhere near the write
// volume that made "index" a problem, so it's left as a single key with a
// retry instead of also being broken apart).
async function kvPutWithRetry(env, key, value, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await env.THREADS_KV.put(key, value);
      return;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(150 * (i + 1) + Math.floor(Math.random() * 100));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cloudflare KV metadata is capped at 1024 bytes (serialized) per key —
// well clear of what a sidebar row needs, but title/submitter are free-
// text and `extraSearchText` folds in every custom form-field value, so
// both are hard-capped defensively rather than trusting upstream length.
function clip(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max) : s;
}

// Lightweight summary of a thread — this is what actually gets stored as
// this key's KV metadata (see saveThread) and is all the sidebar needs to
// render a row without fetching the full record. msgIds/chatId/topicId are
// deliberately NOT included: they're only needed once an agent opens a
// specific thread, which fetches the full `thread:<id>` record anyway.
function summarize(thread) {
  // Extra searchable text beyond title/submitter/brand (which are already
  // their own metadata fields, so listThreads() can match them without
  // needing them duplicated in here too) — e.g. an account ID typed into
  // one of the module's custom fields. Capped hard so a ticket with many/
  // long custom fields can never push this key's metadata near the limit.
  const extraSearchText = clip(
    (thread.summary || []).map((s) => s.value).filter(Boolean).join(" ").toLowerCase(),
    300
  );
  return {
    id: thread.id,
    module: thread.module,
    moduleName: thread.moduleName,
    icon: thread.icon,
    accent: thread.accent,
    brand: thread.brand,
    title: clip(thread.title, 200),
    submitter: clip(thread.submitter, 100),
    submittedAt: thread.submittedAt,
    lastActivity: thread.lastActivity,
    solved: thread.solved,
    solvedAt: thread.solvedAt,
    deleted: !!thread.deleted,
    replyCount: thread.messages.length,
    extraSearchText,
  };
}

// Every write to a thread's own record goes through this — saves the full
// JSON as the value, and the lightweight summary as this key's metadata,
// in one KV write. No second key touched, so no shared hot key.
async function saveThread(env, thread) {
  await env.THREADS_KV.put(`thread:${thread.id}`, JSON.stringify(thread), {
    metadata: summarize(thread),
  });
}

// Deletes a thread's KV record plus every msgid: pointer that leads to it
// (the root submission message, and any reply sent back out from the
// dashboard). Parallelized (Promise.all) instead of one-at-a-time — these
// are all different keys, so there's no per-key rate limit to worry about
// here, only wall-clock time, and a thread with many messages/attachments
// could otherwise mean a long chain of sequential round-trips.
async function purgeThread(env, thread) {
  const ids = thread.msgIds || [];
  await Promise.all([
    env.THREADS_KV.delete(`thread:${thread.id}`),
    ...ids.map((mid) => env.THREADS_KV.delete(`msgid:${thread.chatId}:${mid}`)),
  ]);
}

function isExpired(t, now) {
  const daysSince = (iso) => (now - new Date(iso).getTime()) / 86400000;
  if (t.solved && t.solvedAt && daysSince(t.solvedAt) > SOLVED_RETENTION_DAYS) return true;
  if (daysSince(t.lastActivity) > STALE_RETENTION_DAYS) return true;
  return false;
}

// Sweeps a batch of summaries for expired entries and deletes their KV
// records (full record fetched first, since purging needs msgIds which
// aren't in the summary — see summarize() above). Runs on a sample of
// listThreads() calls rather than every one, since retention windows are
// measured in DAYS, not seconds, and this is a read-path cost now (no
// hot-key write to protect), so it's kept cheap mainly to avoid doing
// extra KV round-trips on every single sidebar refresh.
const SWEEP_SAMPLE_RATE = 0.05;

async function sweepExpired(env, list) {
  if (Math.random() >= SWEEP_SAMPLE_RATE) return list;
  const now = Date.now();
  const keep = [];
  const expiredIds = [];
  for (const t of list) {
    if (!t.deleted && isExpired(t, now)) expiredIds.push(t.id);
    else keep.push(t);
  }
  if (expiredIds.length) {
    await Promise.all(
      expiredIds.map(async (id) => {
        const thread = await getThread(env, id);
        if (thread) await purgeThread(env, thread);
      })
    );
  }
  return keep;
}

export async function createThread(env, { module: moduleId, moduleName, icon, accent, brand, title, submitter, chatId, topicId, rootMessageId, rootText, hasMedia, summary }) {
  const now = new Date().toISOString();
  const thread = {
    id: newId(),
    module: moduleId,
    moduleName,
    icon,
    accent,
    brand,
    title,
    submitter,
    submittedAt: now,
    lastActivity: now,
    chatId: String(chatId),
    topicId: topicId ?? null,
    rootMessageId,
    rootText: rootText || "",
    rootEdited: false,
    hasMedia: !!hasMedia,
    rootRecalled: false,
    msgIds: [rootMessageId],
    summary: summary || [],
    messages: [],
    solved: false,
    solvedAt: null,
    deleted: false,
  };
  await Promise.all([
    saveThread(env, thread),
    env.THREADS_KV.put(`msgid:${thread.chatId}:${rootMessageId}`, thread.id),
  ]);
  return thread;
}

export async function getThread(env, id) {
  const raw = await env.THREADS_KV.get(`thread:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function findThreadIdByMessage(env, chatId, messageId) {
  return env.THREADS_KV.get(`msgid:${chatId}:${messageId}`);
}

// One-time migration cost, per pre-existing ticket: fetch its full record
// once and re-save it with metadata attached, so future list() calls can
// read it cheaply. Isolated into its own function so listThreads() can
// run a bounded batch of these in parallel (see MAX_HEAL_PER_CALL below).
async function healThread(env, keyName) {
  const raw = await env.THREADS_KV.get(keyName);
  if (!raw) return null;
  const thread = JSON.parse(raw);
  const meta = summarize(thread);
  try {
    await env.THREADS_KV.put(keyName, raw, { metadata: meta });
  } catch {
    // Non-fatal — it'll just get healed again on a future list().
  }
  return meta;
}

// Cloudflare caps how many subrequests a single Function invocation can
// make (well under what a naive "heal every pre-existing ticket in one
// pass" loop can hit). Right after this metadata-based sidebar first
// ships, EVERY existing `thread:*` key needs healing at once — with
// enough tickets, healing them all serially (or even all in parallel) in
// ONE call risks tripping that limit and 503ing the whole page, which is
// exactly what showed up in testing. Capping how many get healed per
// call bounds the damage to a small, fixed number of extra KV round
// trips; whatever's left over just gets picked up on the NEXT list() —
// since polling runs every 6s, the sidebar fully catches up within a
// handful of cycles after a fresh deploy, and every call after that is
// cheap again (nothing left to heal).
const MAX_HEAL_PER_CALL = 15;

// Sidebar list — walks every `thread:*` key via KV's list() (metadata
// only, no full-record fetch) instead of reading one shared "index" key.
export async function listThreads(env, { q } = {}) {
  const withMeta = [];
  const needsHeal = [];
  let cursor;
  do {
    const page = await env.THREADS_KV.list({ prefix: "thread:", cursor, limit: 1000 });
    for (const key of page.keys) {
      if (key.metadata) withMeta.push(key.metadata);
      else needsHeal.push(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const healed = await Promise.all(needsHeal.slice(0, MAX_HEAL_PER_CALL).map((name) => healThread(env, name)));
  const results = [...withMeta, ...healed.filter(Boolean)];

  const swept = await sweepExpired(env, results);
  const visible = swept.filter((t) => !t.deleted);
  visible.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  if (!q) return visible;
  const needle = q.toLowerCase();
  return visible.filter((t) => {
    if ((t.extraSearchText || "").includes(needle)) return true;
    return (
      (t.submitter || "").toLowerCase().includes(needle) ||
      (t.title || "").toLowerCase().includes(needle) ||
      (t.brand || "").toLowerCase().includes(needle)
    );
  });
}

export async function appendMessage(env, threadId, message) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.messages.push(message);
  thread.lastActivity = message.ts;
  // Only genuine, explicit replies ever reach here for non-self messages
  // (see telegram-webhook.js) — so if one lands on an already-solved
  // ticket, that's a deliberate "actually, still need to talk about this"
  // signal, and it's safe to reopen.
  if (thread.solved && !message.self) {
    thread.solved = false;
    thread.solvedAt = null;
  }
  // Track this outbound message's id (if Telegram returned one) so
  // replies-to-replies still resolve back to the same thread, and so
  // cleanup can find and delete every msgid: pointer for this thread.
  if (message.messageId) {
    thread.msgIds = [...(thread.msgIds || [thread.rootMessageId]), message.messageId];
  }
  const writes = [saveThread(env, thread)];
  if (message.messageId) {
    writes.push(env.THREADS_KV.put(`msgid:${thread.chatId}:${message.messageId}`, thread.id));
  }
  await Promise.all(writes);
  return thread;
}

export async function setSolved(env, threadId, solved) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.solved = solved;
  thread.solvedAt = solved ? new Date().toISOString() : null;
  await saveThread(env, thread);
  return thread;
}

// Root ticket message (the original submission) was edited on Telegram —
// update the text we keep. The structured `summary` (Promotion/TID/etc.
// rows) was captured once at submit time and can't be safely re-parsed
// out of free-form edited text, so we flag the thread as edited — the
// dashboard shows this raw text instead of the now-possibly-stale summary.
export async function updateRootText(env, threadId, text) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.rootText = text;
  thread.rootEdited = true;
  thread.lastActivity = new Date().toISOString();
  await saveThread(env, thread);
  return thread;
}

// ---- Deletion history — every "delete/recall" action, kept separately
// from thread storage so it survives even after a thread itself is gone.
// Not linked from anywhere in the agent-facing UI. Low-frequency
// (admin-only actions), so left as one shared key with a retry — see the
// note on kvPutWithRetry above for why this one's different from the old
// "index" key.
const DELETION_LOG_KEY = "deletion-log";
const MAX_LOG_SIZE = 500;

export async function logDeletion(env, entry) {
  const raw = await env.THREADS_KV.get(DELETION_LOG_KEY);
  const list = raw ? JSON.parse(raw) : [];
  list.unshift({ id: newId(), ts: new Date().toISOString(), by: entry.by || null, ...entry });
  await kvPutWithRetry(env, DELETION_LOG_KEY, JSON.stringify(list.slice(0, MAX_LOG_SIZE)));
}

export async function listDeletions(env) {
  const raw = await env.THREADS_KV.get(DELETION_LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

// Root ticket message was deleted from Telegram — keep the tracking record
// (conversation history, sheet row, etc. are untouched) but flag it so the
// dashboard can show "original message recalled" instead of pretending it's
// still there.
export async function markRootRecalled(env, threadId) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.rootRecalled = true;
  thread.lastActivity = new Date().toISOString();
  await saveThread(env, thread);
  return thread;
}

// A self-sent reply was edited on Telegram — update its stored text.
export async function editMessageInThread(env, threadId, messageId, text) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  const msg = thread.messages.find((m) => m.self && m.messageId === messageId);
  if (!msg) return null;
  msg.text = text;
  msg.editedAt = new Date().toISOString();
  await saveThread(env, thread);
  return thread;
}

// A self-sent reply was recalled from Telegram — remove it from the
// conversation (matches how Telegram itself just removes it, no trace).
export async function removeMessageFromThread(env, threadId, messageId) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.messages = thread.messages.filter((m) => !(m.self && m.messageId === messageId));
  await saveThread(env, thread);
  return thread;
}

export async function softDeleteThread(env, threadId) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  await purgeThread(env, thread);
  return thread;
}
