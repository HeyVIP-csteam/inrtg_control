/**
 * threads.js  (SERVER-ONLY)
 *
 * Storage for the "TG Reply Threads" feature — tracks each form submission
 * that was sent to Telegram, plus every reply that lands in that Telegram
 * thread (via webhook) or is sent back out from the dashboard.
 *
 * Backed by Cloudflare KV (binding: THREADS_KV — see wrangler.toml).
 * Two kinds of keys:
 *   thread:<id>          → full thread record (JSON)
 *   msgid:<chatId>:<mid>  → thread id (string) — lets the Telegram webhook
 *                           find which thread a reply belongs to in O(1)
 *   index                → JSON array of lightweight summaries, newest
 *                           first, used to render the sidebar without
 *                           fetching every full thread record
 *
 * AUTO-CLEANUP — controls how many KV "writes" you burn per day (see the
 * free-plan limits: 1,000 writes/day, 1,000 deletes/day). Adjust the two
 * numbers below to change how long tickets stick around; set either to
 * `Infinity` to disable that rule entirely. Cleanup runs opportunistically
 * (piggy-backing on normal reads/writes) rather than on a schedule, since
 * Cloudflare Pages Functions don't support Cron Triggers.
 */

// Solved tickets older than this many days are auto-deleted.
const SOLVED_RETENTION_DAYS = 30;
// Any ticket (solved or not) with zero activity for this many days is
// auto-deleted as a safety net, so a never-solved ticket can't sit forever.
const STALE_RETENTION_DAYS = 90;

const INDEX_KEY = "index";
const MAX_INDEX_SIZE = 500;

function newId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readIndex(env) {
  const raw = await env.THREADS_KV.get(INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function writeIndex(env, list) {
  await env.THREADS_KV.put(INDEX_KEY, JSON.stringify(list.slice(0, MAX_INDEX_SIZE)));
}

function summarize(thread) {
  return {
    id: thread.id,
    module: thread.module,
    moduleName: thread.moduleName,
    icon: thread.icon,
    accent: thread.accent,
    brand: thread.brand,
    title: thread.title,
    submitter: thread.submitter,
    submittedAt: thread.submittedAt,
    lastActivity: thread.lastActivity,
    solved: thread.solved,
    solvedAt: thread.solvedAt,
    deleted: thread.deleted,
    replyCount: thread.messages.length,
    chatId: thread.chatId,
    topicId: thread.topicId,
    msgIds: thread.msgIds,
  };
}

// Deletes a thread's KV record plus every msgid: pointer that leads to it
// (the root submission message, and any reply sent back out from the
// dashboard). Does NOT touch the index — callers manage that separately.
async function purgeThread(env, summaryOrThread) {
  await env.THREADS_KV.delete(`thread:${summaryOrThread.id}`);
  const ids = summaryOrThread.msgIds || [];
  for (const mid of ids) {
    await env.THREADS_KV.delete(`msgid:${summaryOrThread.chatId}:${mid}`);
  }
}

function isExpired(t, now) {
  const daysSince = (iso) => (now - new Date(iso).getTime()) / 86400000;
  if (t.solved && t.solvedAt && daysSince(t.solvedAt) > SOLVED_RETENTION_DAYS) return true;
  if (daysSince(t.lastActivity) > STALE_RETENTION_DAYS) return true;
  return false;
}

// Sweeps the in-memory index for expired entries and deletes their KV
// records. Runs as part of every index write (cheap — just a date check
// per entry, no extra KV calls unless something is actually expired), so
// there's no need for a Cron Trigger.
async function sweepExpired(env, list) {
  const now = Date.now();
  const keep = [];
  for (const t of list) {
    if (!t.deleted && isExpired(t, now)) {
      await purgeThread(env, t);
    } else {
      keep.push(t);
    }
  }
  return keep;
}

async function upsertIndexEntry(env, thread) {
  const list = await readIndex(env);
  const filtered = list.filter((t) => t.id !== thread.id);
  filtered.unshift(summarize(thread));
  filtered.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  // Anything pushed past MAX_INDEX_SIZE would otherwise leak — actually
  // delete it instead of just dropping it from the visible list.
  const overflow = filtered.slice(MAX_INDEX_SIZE);
  for (const t of overflow) await purgeThread(env, t);

  const swept = await sweepExpired(env, filtered.slice(0, MAX_INDEX_SIZE));
  await writeIndex(env, swept);
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
    hasMedia: !!hasMedia,
    rootRecalled: false,
    msgIds: [rootMessageId],
    summary: summary || [],
    messages: [],
    solved: false,
    solvedAt: null,
    deleted: false,
  };
  await env.THREADS_KV.put(`thread:${thread.id}`, JSON.stringify(thread));
  await env.THREADS_KV.put(`msgid:${thread.chatId}:${rootMessageId}`, thread.id);
  await upsertIndexEntry(env, thread);
  return thread;
}

export async function getThread(env, id) {
  const raw = await env.THREADS_KV.get(`thread:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function findThreadIdByMessage(env, chatId, messageId) {
  return env.THREADS_KV.get(`msgid:${chatId}:${messageId}`);
}

// Fallback for forum-topic groups: Telegram auto-attaches reply_to_message
// pointing at the topic's root message for ANY message typed in that topic
// (not just genuine replies), so an exact message-id match often won't hit.
// In that case, assume the message belongs to whichever thread in this
// chat+topic was most recently active and isn't solved yet.
export async function findLatestThreadForTopic(env, chatId, topicId) {
  const list = await readIndex(env);
  const candidates = list.filter((t) => !t.deleted && t.chatId === String(chatId) && t.topicId === topicId);
  if (!candidates.length) return null;
  const unsolved = candidates.filter((t) => !t.solved);
  const pool = unsolved.length ? unsolved : candidates;
  pool.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  return pool[0].id;
}

export async function listThreads(env, { q } = {}) {
  const list = await readIndex(env);
  const visible = list.filter((t) => !t.deleted);
  if (!q) return visible;
  const needle = q.toLowerCase();
  return visible.filter((t) =>
    (t.submitter || "").toLowerCase().includes(needle) ||
    (t.title || "").toLowerCase().includes(needle) ||
    (t.brand || "").toLowerCase().includes(needle)
  );
}

export async function appendMessage(env, threadId, message) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.messages.push(message);
  thread.lastActivity = message.ts;
  // A new reply on a thread that was already marked solved un-resolves it —
  // someone is still talking about it.
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
  await env.THREADS_KV.put(`thread:${thread.id}`, JSON.stringify(thread));
  if (message.messageId) {
    await env.THREADS_KV.put(`msgid:${thread.chatId}:${message.messageId}`, thread.id);
  }
  await upsertIndexEntry(env, thread);
  return thread;
}

export async function setSolved(env, threadId, solved) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.solved = solved;
  thread.solvedAt = solved ? new Date().toISOString() : null;
  await env.THREADS_KV.put(`thread:${thread.id}`, JSON.stringify(thread));
  await upsertIndexEntry(env, thread);
  return thread;
}

// Root ticket message (the original submission) was edited on Telegram —
// update the text we keep so the summary card reflects the correction.
export async function updateRootText(env, threadId, text) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.rootText = text;
  thread.lastActivity = new Date().toISOString();
  await env.THREADS_KV.put(`thread:${thread.id}`, JSON.stringify(thread));
  await upsertIndexEntry(env, thread);
  return thread;
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
  await env.THREADS_KV.put(`thread:${thread.id}`, JSON.stringify(thread));
  await upsertIndexEntry(env, thread);
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
  await env.THREADS_KV.put(`thread:${thread.id}`, JSON.stringify(thread));
  await upsertIndexEntry(env, thread);
  return thread;
}

// A self-sent reply was recalled from Telegram — remove it from the
// conversation (matches how Telegram itself just removes it, no trace).
export async function removeMessageFromThread(env, threadId, messageId) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.messages = thread.messages.filter((m) => !(m.self && m.messageId === messageId));
  await env.THREADS_KV.put(`thread:${thread.id}`, JSON.stringify(thread));
  await upsertIndexEntry(env, thread);
  return thread;
}

export async function softDeleteThread(env, threadId) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  await purgeThread(env, thread);
  const list = await readIndex(env);
  await writeIndex(env, list.filter((t) => t.id !== threadId));
  return thread;
}
