/**
 * presence-heartbeat.js
 *
 * Include on every page that already includes authguard.js (right after
 * it — see index.html/threads.html/etc.). Reports this browser tab's
 * online/inactive status to /api/presence/heartbeat every ~15s while
 * logged in, for the Active Agents board (public/assets/active-agents-
 * panel.js) to read back.
 *
 * IMPORTANT — the 15s interval below is deliberately NOT something you
 * tune to control write volume. Write-volume control lives entirely on
 * the SERVER side (functions/_shared/presence.js's throttled-write
 * logic) so it can change independently without touching every page
 * that loads this script. This file's only job is to accurately report
 * "what is this tab doing right now", as often as a heartbeat
 * reasonably should, full stop.
 *
 * BROWSER BACKGROUND THROTTLING — Chrome (and most modern browsers)
 * clamp setInterval/setTimeout in a BACKGROUNDED tab to roughly once
 * per 60s as a battery/CPU-saving measure, regardless of what interval
 * you actually asked for. This is a real, well-documented browser
 * behavior, not something fixable from application code — the server's
 * offline-detection thresholds (see presence.js's
 * INACTIVE_OFFLINE_AFTER_MS) are deliberately sized with this in mind,
 * not against the naive "should fire every 15s" assumption.
 *
 * STATUS DEFINITIONS (matches functions/_shared/presence.js):
 *   "online"   — tab visible AND at least one real interaction
 *                (mouse/keyboard/scroll/touch) within IDLE_THRESHOLD_MS.
 *   "inactive" — tab hidden/backgrounded, OR visible but idle longer
 *                than IDLE_THRESHOLD_MS.
 *   "offline"  — never sent by this file. The server infers it purely
 *                from a heartbeat going quiet for too long (see
 *                deriveStatus() in presence.js) — that's the only
 *                honest way to detect "closed the tab / lost power /
 *                network died", since none of those let a script run
 *                one last "I'm leaving" message reliably.
 */
(function () {
  const HEARTBEAT_URL = "/api/presence/heartbeat";
  const HEARTBEAT_INTERVAL_MS = 15 * 1000;
  const IDLE_THRESHOLD_MS = 60 * 1000; // no interaction for 60s while visible -> "inactive"

  let lastInteractionAt = Date.now();
  let lastSentStatus = null;

  function markInteraction() { lastInteractionAt = Date.now(); }
  ["mousemove", "mousedown", "keydown", "scroll", "touchstart"].forEach((evt) => {
    document.addEventListener(evt, markInteraction, { passive: true });
  });

  function computeStatus() {
    if (document.hidden) return "inactive";
    return (Date.now() - lastInteractionAt < IDLE_THRESHOLD_MS) ? "online" : "inactive";
  }

  async function sendHeartbeat(status) {
    if (!window.AgentAuth || !window.AgentAuth.getAuth || !window.AgentAuth.getAuth()) return;
    lastSentStatus = status;
    try {
      await window.AgentAuth.authFetch(HEARTBEAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    } catch {
      // Network blip — the next interval's heartbeat (or the server's
      // own offline-after-silence detection) covers this; no retry
      // logic needed here.
    }
  }

  function tick() {
    sendHeartbeat(computeStatus());
  }

  // Fire once immediately on load (don't make the board wait ~15s to
  // learn someone just logged in), then on the regular interval.
  tick();
  setInterval(tick, HEARTBEAT_INTERVAL_MS);

  // Coming back to a visible/foregrounded tab is itself a real signal of
  // presence — treat it as an interaction and report right away instead
  // of waiting for the next tick, so the board updates promptly instead
  // of showing "inactive" for up to 15s after someone tabs back in.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      markInteraction();
      tick();
    }
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
  // detection in presence.js catches it within ~100-150s regardless.
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
