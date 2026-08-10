/**
 * threads.js  (SERVER-ONLY)
 *
 * Storage for the "TG Reply Threads" feature — tracks each form submission
 * that was sent to Telegram, plus every reply that lands in that Telegram
 * thread (via webhook) or is sent back out from the dashboard.
 *
 * STORAGE, as of the D1 migration (binding: THREADS_DB — see
 * wrangler.toml): the single JSON record for an individual thread — the
 * thing an agent is actually staring at while a reply is expected to show
 * up — now lives in D1 (`threads` table, one row per thread, `data` column
 * holds the same JSON shape this file always used), not KV. D1 is a single
 * strongly-consistent primary, so a write from the webhook is immediately
 * visible to the very next read from the dashboard, with no waiting on
 * Cloudflare's per-edge KV cache to catch up (that KV propagation delay —
 * up to ~60s, and NOT configurable lower — is what used to make replies
 * show up late/inconsistently, or occasionally get silently overwritten
 * when two replies landed within the same window). `appendMessage()`
 * below appends via SQLite's own JSON functions in a single UPDATE
 * statement instead of the old KV read→push-in-JS→write-the-whole-thing-
 * back pattern, so two near-simultaneous replies can never clobber one
 * another. A second table, `message_index` (chat_id, message_id) →
 * thread_id, replaces the old `msgid:<chatId>:<mid>` KV keys — same job
 * (letting the webhook resolve which thread a reply belongs to), same
 * O(1) lookup, just consistent.
 *
 * KV (binding: THREADS_KV) is STILL used, deliberately, for the ONE thing
 * it was always fine for: the sidebar list. See the LIST_CACHE_KEY /
 * scanThreadsFromKV section below — that path already tolerates being a
 * little stale by design, so there was no reason to move it. Each thread's
 * KV key (`thread:<id>`) now holds only a placeholder value with the real
 * data as its *metadata* (see saveThread) — the sidebar reads metadata via
 * `list()` and never touches the value, so there's no reason to duplicate
 * the full JSON there anymore.
 *
 * BACKWARD COMPAT: any thread saved before this migration only exists in
 * KV, as a full JSON value (no D1 row yet). `getThread()`/
 * `findThreadIdByMessage()` below transparently fall back to the old KV
 * shape and write the record through to D1 the first time it's touched —
 * same one-time "heal on read" idea this file already used for the
 * metadata migration, just one layer lower.
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
 * cheap per-call, BUT Cloudflare's free plan caps `list()` at 1,000
 * calls/day, completely separate from (and far stricter than) the
 * 100,000 reads/day budget. A naive "call list() on every listThreads()"
 * (the original version of this redesign) blew through that in a
 * couple of hours of normal 6-second sidebar polling — see the
 * LIST_CACHE_KEY / LIST_CACHE_TTL_MS / DAILY_SCAN_LIMIT section below for
 * the fix (a real list() scan now only happens at most once every 2
 * minutes, cached in between, AND is hard-capped at 800 real scans per
 * UTC day no matter what). Keep this in mind before adding any OTHER list() calls
 * anywhere in this codebase — they all share the same 1,000/day budget.
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

// Every write to a thread's own record goes through this. Two writes, in
// parallel, to two different stores that now do two different jobs:
//   - D1 gets the actual full JSON (source of truth for getThread() and
//     anything that needs an up-to-the-second read of THIS thread).
//   - KV gets only a placeholder value (there's nothing left that reads
//     it) with the lightweight summary riding along as this key's
//     *metadata* — that's still what the sidebar's list() scan reads, and
//     that path is fine with being a little stale (see file header).
// No shared hot key on either side, so two agents touching two different
// tickets still never contend with each other.
async function saveThread(env, thread) {
  const json = JSON.stringify(thread);
  const writes = [
    env.THREADS_KV.put(`thread:${thread.id}`, "1", { metadata: summarize(thread) }),
  ];
  if (env.THREADS_DB) {
    writes.push(
      env.THREADS_DB.prepare(
        `INSERT INTO threads (id, data) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      ).bind(thread.id, json).run()
    );
  }
  await Promise.all(writes);
}

// Deletes a thread's KV record plus every msgid: pointer that leads to it
// (the root submission message, and any reply sent back out from the
// dashboard). Parallelized (Promise.all) instead of one-at-a-time — these
// are all different keys, so there's no per-key rate limit to worry about
// here, only wall-clock time, and a thread with many messages/attachments
// could otherwise mean a long chain of sequential round-trips.
async function purgeThread(env, thread) {
  const ids = thread.msgIds || [];
  const deletes = [
    env.THREADS_KV.delete(`thread:${thread.id}`),
    // Best-effort cleanup of any pre-D1-migration pointers this thread
    // might still have (see file header) — harmless no-ops for threads
    // that only ever lived in D1.
    ...ids.map((mid) => env.THREADS_KV.delete(`msgid:${thread.chatId}:${mid}`)),
  ];
  if (env.THREADS_DB) {
    deletes.push(
      env.THREADS_DB.prepare(`DELETE FROM threads WHERE id = ?1`).bind(thread.id).run(),
      env.THREADS_DB.prepare(`DELETE FROM message_index WHERE thread_id = ?1`).bind(thread.id).run()
    );
  }
  await Promise.all(deletes);
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

export async function createThread(env, { module: moduleId, moduleName, icon, accent, brand, brandId, title, submitter, chatId, topicId, rootMessageId, rootMessageIds, rootText, hasMedia, attachmentFileIds, attachmentNames, summary, fieldMap, screenshotLink, sheetRef, forwardedFrom }) {
  const now = new Date().toISOString();
  // Every message_id in the album, not just the first/captioned one —
  // submit.js and forward.js both now return the FULL array from
  // sendMediaGroup (previously only the first was ever captured, which
  // meant recallRoot() could only ever delete that one — the rest of a
  // multi-photo submission stayed in the group forever). Falls back to
  // the single rootMessageId for text-only/single-attachment tickets, or
  // any caller that hasn't been updated to pass the array yet.
  const allRootIds = rootMessageIds && rootMessageIds.length ? rootMessageIds : [rootMessageId];
  const thread = {
    id: newId(),
    module: moduleId,
    moduleName,
    icon,
    accent,
    brand,
    // routing.js's BRANDS key (e.g. "crickex") — display name alone
    // (`brand` above) isn't enough to re-look-up BRANDS[...] later, and
    // editDetails() (see functions/api/threads/[id].js) needs the real
    // brand object to rebuild the message/Sheet row correctly.
    brandId: brandId || null,
    title,
    submitter,
    submittedAt: now,
    lastActivity: now,
    chatId: String(chatId),
    topicId: topicId ?? null,
    rootMessageId,
    // Full album array — see the comment on allRootIds above. Kept
    // alongside rootMessageId (not replacing it) since a lot of existing
    // code only cares about "the" root message and reads that single
    // field; this is additive.
    rootMessageIds: allRootIds,
    rootText: rootText || "",
    rootEdited: false,
    hasMedia: !!hasMedia,
    // Telegram's own file_id(s) for the original submission's photo(s)/
    // document(s) — same idea and same viewer (/api/attachment/[fileId].js)
    // as reply attachments (see functions/api/threads/[id].js), just
    // captured at ticket-creation time instead of reply time. Empty array
    // for text-only tickets, or if the module doesn't collect attachments.
    attachmentFileIds: attachmentFileIds || [],
    // Real original filenames, positionally aligned 1:1 with
    // attachmentFileIds above (see submit.js's sendTelegramWithAttachments)
    // — used by threads.html to correctly detect image vs video vs other
    // file types via a real file extension. Empty/missing for threads
    // created before this existed; threads.html falls back to a generic
    // "ticket-attachment-N" label for those (no extension, so it can't
    // auto-detect image type and just offers a download link instead —
    // degraded but not broken).
    attachmentNames: attachmentNames || [],
    rootRecalled: false,
    msgIds: [...allRootIds],
    summary: summary || [],
    messages: [],
    solved: false,
    solvedAt: null,
    deleted: false,
    // The raw { fieldKey: value } this ticket was submitted with, plus
    // where (if anywhere) it landed in a Google Sheet — both only used by
    // the "Sync to Sheet" editDetails action (functions/api/threads/[id].js).
    // Threads created before this existed just have fieldMap: null /
    // sheetRef: null, meaning they can still get their Telegram message
    // edited the old way, just not the Sheet-syncing kind of edit.
    fieldMap: fieldMap || null,
    screenshotLink: screenshotLink || "",
    // { sheetId, tab, startColumn, columns, row } — null if this
    // submission never wrote a (trackable) Sheet row. See submit.js's
    // comment on `sheetRef` for why it's captured at write time instead
    // of re-derived later (routing.js's config for this brand+module
    // could change after the fact; the row this ticket ACTUALLY landed
    // on never does).
    sheetRef: sheetRef || null,
    // "Generate to another Topic" (functions/api/forward.js) traceability
    // — set ONCE at creation, on the NEW ticket, pointing back at the
    // ticket it was forwarded FROM. Never mutated after creation (unlike
    // forwardedTo below, which grows over time). null for every ticket
    // that wasn't created via a forward.
    forwardedFrom: forwardedFrom || null,
    // The REVERSE direction — appended to over time by
    // addForwardedToLink() below, on the ORIGINAL ticket, once per
    // forward made FROM it. A single ticket can be forwarded to more
    // than one other Topic, hence an array, not a single value.
    forwardedTo: [],
  };
  const writes = [saveThread(env, thread)];
  // One message_index row per message in the album, not just the first —
  // needed so the webhook (functions/api/telegram-webhook.js) can
  // correctly resolve a reply to ANY photo in a multi-photo ticket back
  // to this thread, not just replies to the first/captioned one. Lives in
  // D1 now (see file header) — no more KV msgid: writes for new threads.
  if (env.THREADS_DB) {
    for (const mid of allRootIds) {
      writes.push(
        env.THREADS_DB.prepare(
          `INSERT OR IGNORE INTO message_index (chat_id, message_id, thread_id) VALUES (?1, ?2, ?3)`
        ).bind(thread.chatId, mid, thread.id).run()
      );
    }
  }
  await Promise.all(writes);
  await patchListCache(env, thread); // instant sidebar visibility — see that function's comment for why
  return thread;
}

// "Generate to another Topic" (functions/api/forward.js) — appends a
// backlink to the ORIGINAL ticket once a forward FROM it succeeds. See
// the forwardedFrom/forwardedTo comments in createThread() above for how
// the two directions relate. Best-effort by design (see forward.js's own
// try/catch around this call) — the forward itself has already fully
// succeeded by the time this runs; a failure here only means the
// original ticket's "↗️ Forwarded to..." reference card doesn't show up,
// nothing about the new ticket is affected.
export async function addForwardedToLink(env, threadId, link) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.forwardedTo = [...(thread.forwardedTo || []), link];
  await saveThread(env, thread);
  return thread;
}

export async function getThread(env, id) {
  if (env.THREADS_DB) {
    const row = await env.THREADS_DB.prepare(`SELECT data FROM threads WHERE id = ?1`).bind(id).first();
    if (row) return JSON.parse(row.data);
  }
  // Fall back to the pre-D1 KV shape (a full JSON value, not the "1"
  // placeholder new saveThread() calls write) — only ever hit for a
  // thread that hasn't been read/written since the D1 migration shipped.
  // See file header. Heals itself: once found here, write it through to
  // D1 (plus its message_index rows) so every read after this one takes
  // the fast D1 path above instead.
  const raw = await env.THREADS_KV.get(`thread:${id}`);
  if (!raw) return null;
  let thread;
  try {
    thread = JSON.parse(raw);
  } catch {
    return null; // corrupt — nothing to heal
  }
  // The "1" placeholder new saveThread() calls write parses fine as the
  // number 1 (valid JSON) but obviously isn't a thread — this thread was
  // already migrated and the earlier D1 lookup above should have caught
  // it; landing here means D1 genuinely has no row for it (e.g. that
  // write failed) rather than "just needs healing", so there's nothing
  // to reconstruct from KV.
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return null;
  if (env.THREADS_DB && thread.id) {
    try {
      const ids = (thread.msgIds && thread.msgIds.length ? thread.msgIds : [thread.rootMessageId]).filter(Boolean);
      await Promise.all([
        env.THREADS_DB.prepare(
          `INSERT INTO threads (id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data`
        ).bind(thread.id, raw).run(),
        ...ids.map((mid) =>
          env.THREADS_DB.prepare(
            `INSERT OR IGNORE INTO message_index (chat_id, message_id, thread_id) VALUES (?1, ?2, ?3)`
          ).bind(thread.chatId, mid, thread.id).run()
        ),
      ]);
    } catch {
      // Non-fatal — it'll just get healed again on a future read.
    }
  }
  return thread;
}

export async function findThreadIdByMessage(env, chatId, messageId) {
  if (env.THREADS_DB) {
    const row = await env.THREADS_DB.prepare(
      `SELECT thread_id FROM message_index WHERE chat_id = ?1 AND message_id = ?2`
    ).bind(String(chatId), messageId).first();
    if (row) return row.thread_id;
  }
  // Fall back to the pre-D1 KV pointer (see file header). Not healed here
  // (unlike getThread above) — the thread this points to will get its
  // message_index rows backfilled the next time IT is read via
  // getThread(), which covers this same pointer.
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
// trips; whatever's left over just gets picked up on the next real scan
// (see LIST_CACHE_TTL_MS below) — a one-time, self-resolving cost.
const MAX_HEAL_PER_CALL = 15;

// The actual KV `list()` walk — separated out from listThreads() below so
// it can be called from BEHIND a cache (see getFreshOrCachedEntries).
// Returns every thread's summary (unsorted, still includes soft-deleted
// entries — filtering happens in listThreads()).
async function scanThreadsFromKV(env) {
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
  return [...withMeta, ...healed.filter(Boolean)];
}

// ---- Cached sidebar scan ----
//
// Cloudflare's Workers KV free plan caps `list()` at 1,000 calls/day —
// completely separate from (and far lower than) the 100,000 reads/day
// budget, and NOT documented anywhere near as prominently. Every call to
// listThreads() used to run a real list() scan, and the sidebar polls
// every 6 seconds — do the math on ANY single agent leaving the
// dashboard open for a couple of hours and it's obvious this was always
// going to blow the daily list() quota, not a maybe. This is what
// actually caused the "Unexpected server error: KV list() limit
// exceeded for the day" failure that showed up in testing — a real
// architectural miss when the shared "index" key was first replaced
// with list()+metadata (that redesign fixed the KV *write*-contention
// problem, but nobody checked list()'s own separate, much stricter
// quota at the time).
//
// Fix: a real list() scan now only happens at most once every
// LIST_CACHE_TTL_MS — the result is cached in ONE KV key
// (LIST_CACHE_KEY) and every listThreads() call in between just reads
// that cache (a cheap get(), which draws from the 100,000/day read
// budget instead, with tons of headroom). 10 minutes keeps real list()
// calls to at most ~144/day even under continuous nonstop polling all
// day — comfortable headroom under 1,000, and also keeps the *write*
// side (saving the cache) well under the SEPARATE 1,000 writes/day
// budget, which every ticket submit/reply/solve-toggle also draws from.
//
// Trade-off, stated plainly: a brand-new ticket, or a solved/reopened
// status change, can now take up to ~2 minutes to show up in the
// sidebar for other agents (an already-open conversation stays fully
// real-time regardless — that's a direct-by-ID get(), never affected by
// any of this). Given the alternative was the whole sidebar hard-failing
// once the daily list() quota ran out, this is a straightforward trade
// in the sidebar's favor, same reasoning as the write-contention fix
// before it.
//
// Resilience: if a real scan fails (e.g. the daily list() quota is
// ALREADY exhausted for the day when this runs), fall back to whatever
// is cached — even hours-stale data — rather than fail the request
// outright. Only throws if there's truly nothing cached to fall back to.
const LIST_CACHE_KEY = "thread-list-cache";
const LIST_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches the standalone cron-worker's Cron Trigger interval. Was 2 minutes originally; raised because the cron worker's OWN writes (2 KV puts per run, regardless of interval) were consuming most of the separate 1,000 writes/day free-tier budget at that frequency — see wrangler.toml in the cron-worker folder for the full writeup of that miscalculation and why 10 minutes is the corrected value.

// ---- Hard daily ceiling on real list() calls, on top of the 10-minute
// throttle above ----
//
// The 10-minute throttle alone caps real scans at ~144/day under normal
// conditions — comfortably under Cloudflare's 1,000/day limit. But it's
// a "soft" guarantee: if several agents' polls land in the exact same
// instant right as the cache expires, each could independently decide
// "the cache is stale, I'll do a real scan" before any of them has
// written the refreshed cache back — a small, bounded race, not a
// guaranteed-zero one. This counter is the actual hard backstop the
// business owner asked for: an explicit daily count, stored in KV,
// checked BEFORE every real scan. Once it reaches DAILY_SCAN_LIMIT, no
// further real list() calls happen for the rest of the UTC day no
// matter what — the sidebar just keeps serving whatever's cached (even
// if that means it stops updating for the remainder of the day), which
// is a far better failure mode than risking a repeat of the outright
// "KV list() limit exceeded" error. Resets automatically at UTC
// midnight, same as Cloudflare's own quota window, since the counter
// key stores which UTC calendar date it's counting for and starts over
// the moment that date changes.
const DAILY_SCAN_LIMIT = 800;
const SCAN_COUNTER_KEY = "thread-list-scan-counter";

function utcDateString(d) {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
}

// Returns true if a real scan is allowed to proceed right now (and, if
// so, has already recorded this call against today's count). Returns
// false if today's DAILY_SCAN_LIMIT has already been reached.
async function tryReserveScanSlot(env) {
  const today = utcDateString(new Date());
  let counter;
  try {
    const raw = await env.THREADS_KV.get(SCAN_COUNTER_KEY);
    counter = raw ? JSON.parse(raw) : null;
  } catch {
    counter = null;
  }
  if (!counter || counter.date !== today) counter = { date: today, count: 0 };
  if (counter.count >= DAILY_SCAN_LIMIT) return false;
  counter.count += 1;
  try {
    await env.THREADS_KV.put(SCAN_COUNTER_KEY, JSON.stringify(counter));
  } catch {
    // If we can't even persist the counter, err on the side of caution
    // and still allow this one scan through — the 10-minute throttle is
    // still there as a backup limiter either way.
  }
  return true;
}

async function getCachedScan(env) {
  try {
    const raw = await env.THREADS_KV.get(LIST_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---- Instant sidebar updates for OUR OWN actions, decoupled from the
// cron worker's refresh interval ----
//
// LIST_CACHE_TTL_MS (10 minutes) controls how long the sidebar can go
// between full re-scans — that's the right knob for "how stale can
// things get if nobody's actively doing anything," but it's the WRONG
// knob for "how fast does MY OWN new ticket / solve-toggle / reply show
// up" — those are things we already know about the instant they happen
// (we're the ones doing them), no need to wait for the next scheduled
// scan to notice something we already have full details on. Business
// owner was right to push back hard on "up to 10 minutes for a new
// ticket to appear" for a live CS team — that's not acceptable, and
// tying ticket visibility to the write-budget-driven scan interval was
// the wrong way to solve the original quota problem.
//
// This patches the EXISTING cached entries list in place (one targeted
// KV get + put, not a full re-scan) every time something we already
// know the outcome of happens — see the call sites in createThread(),
// appendMessage(), setSolved(), and softDeleteThread() below. Costs 1
// extra read + 1 extra write per action — negligible compared to the
// action's own KV writes (saving the thread itself), and NOT tied to
// polling frequency at all, so it doesn't reintroduce the write-budget
// problem the cron interval was raised to fix. If there's no cache yet
// (nobody's loaded the sidebar since the last full scan), this is a
// harmless no-op — the next real scan builds it fresh anyway.
async function patchListCache(env, thread, { remove } = {}) {
  try {
    const cached = await getCachedScan(env);
    if (!cached) return; // nothing to patch yet — fine, next real scan builds it
    const idx = cached.entries.findIndex((e) => e.id === thread.id);
    if (remove) {
      if (idx >= 0) cached.entries.splice(idx, 1);
    } else {
      const meta = summarize(thread);
      if (idx >= 0) cached.entries[idx] = meta;
      else cached.entries.unshift(meta); // new ticket — put it at the front, sorting happens on read anyway
    }
    // generatedAt is deliberately left untouched — this is a targeted
    // patch, not a fresh scan, and keeping the original timestamp means
    // the periodic full re-scan (which also heals/cleans up drift) still
    // runs on its normal schedule rather than being perpetually pushed
    // back by ongoing activity.
    await env.THREADS_KV.put(LIST_CACHE_KEY, JSON.stringify(cached));
  } catch {
    // Best-effort only — worst case, this specific update shows up on
    // the next real scan instead of instantly. Never worth failing the
    // actual action (creating a ticket, replying, etc.) over this.
  }
}

async function getFreshOrCachedEntries(env) {
  const cached = await getCachedScan(env);
  const now = Date.now();
  if (cached && now - cached.generatedAt < LIST_CACHE_TTL_MS) {
    return cached.entries;
  }
  // Cache is missing or stale — normally that means "do a real scan,"
  // but only if today's hard ceiling hasn't been hit yet.
  const allowed = await tryReserveScanSlot(env);
  if (!allowed) {
    if (cached) return cached.entries; // stale is fine — never worth risking the real quota over
    return []; // no cache AND no budget left for today — degrade to an empty list rather than throw
  }
  try {
    const entries = await scanThreadsFromKV(env);
    // Best-effort — a failed cache write should never break the read
    // path; the next call just re-scans instead of reusing a cache.
    try {
      await env.THREADS_KV.put(LIST_CACHE_KEY, JSON.stringify({ generatedAt: now, entries }));
    } catch {
      // ignored
    }
    return entries;
  } catch (err) {
    if (cached) return cached.entries; // stale beats broken
    throw err;
  }
}

// Sidebar list — served from the cache above almost all the time; only
// touches KV's list() directly when that cache is missing or stale.
export async function listThreads(env, { q } = {}) {
  const results = await getFreshOrCachedEntries(env);

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

// Multi-attachment reply lands in Telegram as an ALBUM — one message_id
// PER attachment, not just one for the whole reply — so
// message.messageIds (plural, see sendTelegramReplyAttachments in
// threads/[id].js) carries all of them when present. Without this, a
// reply to any photo in the album OTHER than the first would silently
// fail to resolve back to this thread. Falls back to the single
// messageId for plain text/single-attachment replies, which only ever
// have the one id anyway.
function messageIdsOf(message) {
  return message.messageIds && message.messageIds.length ? message.messageIds : (message.messageId ? [message.messageId] : []);
}

// `chatId` is a separate parameter (not read off `message`, which never
// carried it) so this can insert the new message_index rows without
// needing to read the thread first — see the D1 append below for why
// avoiding a read here matters.
export async function appendMessage(env, threadId, message, chatId) {
  const allIds = messageIdsOf(message);

  if (env.THREADS_DB) {
    // BEFORE the atomic append below: make sure this thread actually HAS
    // a row in D1 yet. For any thread created after the D1 migration,
    // it already does (createThread() put it there) — this is then just
    // one cheap extra read that changes nothing. But for a thread that
    // predates the migration and hasn't been opened/touched since (so
    // never went through getThread()'s KV->D1 heal-on-read path), D1 has
    // NO row for it at all — and the atomic `UPDATE ... WHERE id = ?`
    // below would then silently match zero rows (UPDATE matching
    // nothing is not an error) and the message would vanish: not in D1
    // (nothing to update), and the follow-up getThread() call further
    // down would fall back to the STALE pre-reply KV copy and heal
    // THAT into D1 — permanently losing the very message this function
    // was called to record. getThread() already contains exactly the
    // heal-from-KV-into-D1 logic needed to prevent this, so just calling
    // it (and discarding the result) here is enough to guarantee the row
    // exists before the atomic UPDATE runs.
    await getThread(env, threadId);

    // Atomic, no read-modify-write from THIS point on: appends straight
    // into the JSON via SQLite's own json_insert/json_set, in ONE
    // statement (plus the conditional "reopen if solved" statement,
    // batched into the same transaction below). This is the actual fix
    // for replies getting lost/overwritten — two replies landing within
    // the same millisecond now just serialize as two independent
    // UPDATEs instead of racing to read-then-clobber each other's write.
    // See file header.
    const stmts = [
      env.THREADS_DB.prepare(
        `UPDATE threads
         SET data = json_set(json_insert(data, '$.messages[#]', json(?1)), '$.lastActivity', ?2)
         WHERE id = ?3`
      ).bind(JSON.stringify(message), message.ts, threadId),
    ];
    // Only genuine, explicit replies ever reach here for non-self
    // messages (see telegram-webhook.js) — so if one lands on an
    // already-solved ticket, that's a deliberate "actually, still need to
    // talk about this" signal, and it's safe to reopen. Expressed as a
    // conditional UPDATE (checked via json_extract) instead of an
    // in-memory if-check, since there's no in-memory copy anymore.
    if (!message.self) {
      stmts.push(
        env.THREADS_DB.prepare(
          `UPDATE threads
           SET data = json_set(data, '$.solved', json('false'), '$.solvedAt', NULL)
           WHERE id = ?1 AND json_extract(data, '$.solved') = 1`
        ).bind(threadId)
      );
    }
    for (const mid of allIds) {
      stmts.push(
        env.THREADS_DB.prepare(
          `INSERT OR IGNORE INTO message_index (chat_id, message_id, thread_id) VALUES (?1, ?2, ?3)`
        ).bind(String(chatId ?? ""), mid, threadId)
      );
    }
    await env.THREADS_DB.batch(stmts);
  }

  // Read back the now-current thread (a single consistent D1 read, or —
  // for a not-yet-migrated thread — getThread()'s own KV fallback+heal
  // path, see above) for the sidebar patch and the return value. Also

  // covers the env.THREADS_DB-not-bound-yet case end to end via the old
  // KV read-modify-write path below.
  const thread = await getThread(env, threadId);
  if (!thread) return null;

  if (!env.THREADS_DB) {
    // No D1 binding — fall back to the original KV read-modify-write so
    // the feature still works (with the old consistency caveats) rather
    // than silently doing nothing.
    thread.messages.push(message);
    thread.lastActivity = message.ts;
    if (thread.solved && !message.self) {
      thread.solved = false;
      thread.solvedAt = null;
    }
    if (allIds.length) thread.msgIds = [...(thread.msgIds || [thread.rootMessageId]), ...allIds];
    const writes = [saveThread(env, thread)];
    for (const mid of allIds) writes.push(env.THREADS_KV.put(`msgid:${thread.chatId}:${mid}`, thread.id));
    await Promise.all(writes);
  }

  await patchListCache(env, thread); // instant sidebar update — reply count / reopened status
  // @-mention autocomplete (threads.html's reply box) — remember this
  // person against the brand+module they replied in, NOT just this one
  // thread, so the picker still finds them next time someone opens a
  // different ticket in that same brand+module later. Same granularity
  // as a routing.js chatId/topicId pair (a brand's Risk Issue group is a
  // different pool of people than that brand's Withdraw Issue group).
  // Fire-and-forget: this is a nice-to-have suggestion list, never worth
  // failing (or slowing down) the actual reply-recording above for.
  if (message.handle && !message.self) {
    rememberMentionCandidate(env, thread.brandId, thread.module, message.handle, message.from).catch(() => {});
  }
  return thread;
}

// ---- @-mention candidate registry (brand + module scoped) -------------
function mentionRegistryKey(brandId, moduleId) {
  return `mention-registry:${brandId || "none"}:${moduleId || "none"}`;
}

async function rememberMentionCandidate(env, brandId, moduleId, handle, from) {
  const key = mentionRegistryKey(brandId, moduleId);
  const raw = await env.THREADS_KV.get(key);
  let registry;
  try {
    registry = raw ? JSON.parse(raw) : {};
  } catch {
    registry = {};
  }
  // Skip the write entirely if nothing actually changed — avoids hammering
  // this one key with a put() on every single reply from a regular in a
  // busy topic (KV caps writes to the same key at ~1/sec).
  const existing = registry[handle];
  if (existing && existing.from === from) return;
  registry[handle] = { from: from || existing?.from || "", lastSeen: Date.now() };
  await env.THREADS_KV.put(key, JSON.stringify(registry));
}

// Used by GET /api/mention-candidates.
export async function getMentionCandidates(env, brandId, moduleId) {
  const raw = await env.THREADS_KV.get(mentionRegistryKey(brandId, moduleId));
  if (!raw) return [];
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch {
    return [];
  }
  return Object.entries(registry)
    .map(([handle, v]) => ({ handle, from: v.from, lastSeen: v.lastSeen }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

// One-time backfill (POST /api/admin/backfill-mentions) — the registry
// above only started filling in going forward from the moment this
// feature shipped, so anyone who only ever replied BEFORE that has no
// entry yet even though their messages are sitting right there in each
// thread's own history. Walks every existing thread and folds their
// handles in. Paginated (100 threads/call, driven by the KV list()
// cursor) — a single huge KV scan+get loop risks running into the
// Worker's execution time limit on an account with a lot of ticket
// history, so the admin panel calls this repeatedly until `done`.
export async function backfillMentionRegistryPage(env, cursor) {
  const page = await env.THREADS_KV.list({ prefix: "thread:", cursor: cursor || undefined, limit: 100 });
  const partial = {}; // regKey -> { handle: {from, lastSeen} }
  // Read all 100 threads in this page concurrently instead of one at a
  // time — this is a plain read-only fan-out (unlike the KV WRITES
  // elsewhere in this file, which stay capped/sequential because KV
  // limits writes to ~1/sec on the SAME key; reads have no such limit).
  // Goes through getThread() rather than reading `key.name` off KV
  // directly — since the D1 migration, a thread's KV value is just the
  // "1" placeholder (the real data lives in D1); getThread() is what
  // knows to check D1 first and only fall back to a raw KV value for a
  // thread that hasn't migrated yet. Reading the KV value directly here
  // (the old approach) would silently see only "1" for every already-
  // migrated thread and produce nothing useful.
  const threads = await Promise.all(
    page.keys.map((key) => getThread(env, key.name.slice("thread:".length)))
  );
  for (const thread of threads) {
    if (!thread) continue;
    const regKey = mentionRegistryKey(thread.brandId, thread.module);
    if (!partial[regKey]) partial[regKey] = {};
    (thread.messages || []).forEach((m) => {
      if (!m.handle || m.self) return;
      const ts = m.ts || 0;
      const existing = partial[regKey][m.handle];
      if (!existing || ts > existing.lastSeen) {
        partial[regKey][m.handle] = { from: m.from || existing?.from || "", lastSeen: ts };
      }
    });
  }
  // Merge into KV — only the handful of brand+module registries actually
  // touched by this one page of threads, read-modify-write.
  await Promise.all(
    Object.entries(partial).map(async ([regKey, additions]) => {
      const raw = await env.THREADS_KV.get(regKey);
      let existing = {};
      try {
        existing = raw ? JSON.parse(raw) : {};
      } catch {
        existing = {};
      }
      for (const [handle, v] of Object.entries(additions)) {
        const cur = existing[handle];
        if (!cur || v.lastSeen > cur.lastSeen) existing[handle] = v;
      }
      await env.THREADS_KV.put(regKey, JSON.stringify(existing));
    })
  );
  return { scanned: page.keys.length, done: page.list_complete, cursor: page.list_complete ? null : page.cursor };
}

export async function setSolved(env, threadId, solved) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  thread.solved = solved;
  thread.solvedAt = solved ? new Date().toISOString() : null;
  await saveThread(env, thread);
  await patchListCache(env, thread); // instant sidebar update — solved/unsolved toggle
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

// Used by the "Sync to Sheet" editDetails action (functions/api/threads/
// [id].js) after an agent corrects a ticket's field values — updates
// everything that could have changed as a result: the raw fieldMap, the
// re-rendered Telegram message text (rootText), and the sidebar's
// title/preview (title/summary), which were all originally derived from
// fieldMap at submission time and would otherwise go stale. Unlike
// updateRootText above, this DOES call patchListCache() — title/summary
// are exactly what the sidebar shows, so a stale cache here would mean
// agents see outdated info until the next scan.
export async function updateThreadDetails(env, threadId, { fieldMap, rootText, title, summary }) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  if (fieldMap !== undefined) thread.fieldMap = fieldMap;
  if (rootText !== undefined) {
    thread.rootText = rootText;
    thread.rootEdited = true;
  }
  if (title !== undefined) thread.title = title;
  if (summary !== undefined) thread.summary = summary;
  thread.lastActivity = new Date().toISOString();
  await saveThread(env, thread);
  await patchListCache(env, thread);
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

// The OTHER side's reply was edited directly inside Telegram (not sent
// from our own dashboard) — inbound counterpart to editMessageInThread()
// above, which only ever touches OUR OWN self-sent replies. Driven by
// Telegram's edited_message webhook update (see telegram-webhook.js),
// since editing someone else's message isn't something the Bot API lets
// us do — we can only find out about it after the fact and record what
// it now says. Reopens an already-solved ticket the same way a brand-new
// reply does (see appendMessage above) — a deliberate edit is the same
// "still needs attention" signal, and it shouldn't sit unnoticed just
// because it happened to be an edit instead of a new message.
export async function editIncomingMessageInThread(env, threadId, messageId, text) {
  const thread = await getThread(env, threadId);
  if (!thread) return null;
  const msg = thread.messages.find((m) => !m.self && m.messageId === messageId);
  if (!msg) return null; // not a message we're tracking for this thread — ignore
  msg.text = text;
  msg.editedAt = new Date().toISOString();
  thread.lastActivity = msg.editedAt;
  if (thread.solved) {
    thread.solved = false;
    thread.solvedAt = null;
  }
  await saveThread(env, thread);
  await patchListCache(env, thread); // instant sidebar update — lastActivity / reopened status
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
  await patchListCache(env, thread, { remove: true }); // instant sidebar update — drop it immediately, don't wait for the next scan to notice it's gone
  return thread;
}
