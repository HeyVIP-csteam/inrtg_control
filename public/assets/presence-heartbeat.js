/**
 * presence-heartbeat.js
 *
 * Include on every page that already includes authguard.js (right after
 * it — see index.html/threads.html/etc.). Reports "this tab is open" to
 * /api/presence/heartbeat every ~15s while logged in, for the Active
 * Agents board (public/assets/active-agents-panel.js) to read back.
 *
 * TWO STATES ONLY — online / offline. There used to be idle/tab-hidden
 * tracking that reported a third "inactive" state; removed on request.
 * Now this file's whole job is simply "is the tab open and heartbeating
 * or not" — no mouse/keyboard/scroll listeners, no visibility checks
 * beyond the tab-close beacon below. Whether someone's actually looking
 * at the screen right now isn't tracked or displayed anymore.
 *
 * BROWSER BACKGROUND THROTTLING — Chrome (and most modern browsers)
 * clamp setInterval/setTimeout in a BACKGROUNDED tab to roughly once
 * per 60s as a battery/CPU-saving measure, regardless of what interval
 * you actually asked for. That's fine here: as long as SOME heartbeat
 * gets through within the server's 5-minute offline window (see
 * _shared/presence.js's OFFLINE_AFTER_MS), the agent still shows
 * online — a backgrounded tab is exactly the case this simplification
 * was meant to stop distinguishing from a foreground one.
 *
 * STATUS DEFINITIONS (matches functions/_shared/presence.js):
 *   "online"  — sent on every heartbeat, unconditionally, as long as
 *                the tab is open and the agent is logged in.
 *   "offline" — never sent by a regular heartbeat. Sent once, directly,
 *                on tab close (see the pagehide listener below) as a
 *                best-effort "I'm actually leaving" signal; otherwise
 *                the server infers it purely from heartbeats going
 *                quiet for 5 minutes (see deriveStatus() in
 *                presence.js) — the only honest way to detect "closed
 *                the tab / lost power / network died", since none of
 *                those let a script run one last message reliably.
 */
(function () {
  const HEARTBEAT_URL = "/api/presence/heartbeat";
  const HEARTBEAT_INTERVAL_MS = 15 * 1000;

  async function sendHeartbeat() {
    if (!window.AgentAuth || !window.AgentAuth.getAuth || !window.AgentAuth.getAuth()) return;
    try {
      await window.AgentAuth.authFetch(HEARTBEAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      // Network blip — the next interval's heartbeat (or the server's
      // own offline-after-silence detection) covers this; no retry
      // logic needed here.
    }
  }

  // Fire once immediately on load (don't make the board wait ~15s to
  // learn someone just logged in), then on the regular interval.
  sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  // Coming back to a visible/foregrounded tab after being backgrounded
  // (and therefore throttled — see file header) is a good moment to get
  // a fresh heartbeat in immediately rather than waiting for whatever's
  // left of the throttled interval.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) sendHeartbeat();
  });

  // Best-effort immediate "offline" on tab close / navigation away.
  // Deliberately fetch(..., {keepalive:true}) rather than
  // navigator.sendBeacon — sendBeacon can't attach the X-Agent-Token
  // header authFetch needs, and this endpoint has no alternative
  // token-in-body path (not worth adding just for this). fetch with
  // keepalive is well-supported in every browser this app targets and
  // survives the page unloading, same as sendBeacon would. This is a
  // nicety, not a requirement — if it doesn't fire (older browser,
  // tab killed by OS, etc.), the server's own silence-based offline
  // detection in presence.js catches it within 5 minutes regardless.
  window.addEventListener("pagehide", () => {
    if (!window.AgentAuth || !window.AgentAuth.getAuth || !window.AgentAuth.getAuth()) return;
    try {
      const auth = window.AgentAuth.getAuth();
      fetch(HEARTBEAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Token": auth.token },
        body: JSON.stringify({ status: "offline" }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  });
})();
