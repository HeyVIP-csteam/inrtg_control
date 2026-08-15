/**
 * presence-heartbeat.js  (SHARED — include on every logged-in page,
 * right after authguard.js)
 *
 * Sends a heartbeat to /api/presence/heartbeat every 15s for as long as
 * this tab is open and the agent is logged in, so the Active Agents
 * popup (see public/assets/active-agents-modal.js, opened from the
 * Home page's tool-card grid) can show near-real-time presence.
 *
 * "Active" vs "inactive" is decided by the Page Visibility API, NOT a
 * mouse/keyboard idle timer — switching to another tab, minimizing the
 * window, or switching to another app all fire `visibilitychange`
 * IMMEDIATELY (not on the next 15s tick), so status changes the instant
 * the tab stops being the visible one, matching "tab switch = inactive"
 * exactly as specced. There is no "offline" status sent from here —
 * offline is always DERIVED server-side from a stale heartbeat (see
 * the module note in functions/_shared/presence.js) since a closed tab
 * or crashed browser can never reliably send a final signal itself.
 *
 * Device/browser/OS are parsed from navigator.userAgent — this can
 * reliably distinguish mobile vs desktop and identify browser name +
 * major version + OS family, but CANNOT distinguish a laptop from a
 * desktop PC (no browser exposes that, on any platform) and CANNOT
 * read a machine's hostname/device name (no web API exposes that
 * either) — both are hard browser privacy limits, not something a
 * smarter parser could work around.
 */
(function () {
  if (!window.AgentAuth || !window.AgentAuth.getAuth()) return; // not logged in, nothing to track

  const HEARTBEAT_INTERVAL_MS = 15000;

  function detectDevice() {
    const ua = navigator.userAgent;
    const isMobile = /Mobi|Android(?!.*Tablet)|iPhone|iPod/.test(ua) || (/Android|iPad|Tablet/.test(ua) && !/Windows NT/.test(ua));
    return isMobile ? "mobile" : "desktop";
  }

  function detectBrowser() {
    const ua = navigator.userAgent;
    let m;
    if ((m = ua.match(/Edg\/(\d+)/))) return `Edge ${m[1]}`;
    if ((m = ua.match(/OPR\/(\d+)/))) return `Opera ${m[1]}`;
    if ((m = ua.match(/Chrome\/(\d+)/)) && !/Chromium/.test(ua)) return `Chrome ${m[1]}`;
    if ((m = ua.match(/Firefox\/(\d+)/))) return `Firefox ${m[1]}`;
    if ((m = ua.match(/Version\/(\d+).*Safari/)) ) return `Safari ${m[1]}`;
    return "Unknown browser";
  }

  function detectOS() {
    const ua = navigator.userAgent;
    if (/Windows NT/.test(ua)) return "Windows";
    if (/Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua)) return "macOS";
    if (/Android/.test(ua)) return "Android";
    if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
    if (/Linux/.test(ua)) return "Linux";
    return "Unknown OS";
  }

  const payloadBase = { device: detectDevice(), browser: detectBrowser(), os: detectOS() };

  function currentStatus() {
    return document.visibilityState === "visible" ? "online" : "inactive";
  }

  function sendHeartbeat() {
    if (!window.AgentAuth || !window.AgentAuth.getAuth()) return; // logged out mid-session
    window.AgentAuth.authFetch("/api/presence/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: currentStatus(), ...payloadBase }),
    }).catch(() => {}); // best-effort — a dropped heartbeat just makes this tick a no-op, next one recovers
  }

  // Immediately on load, and immediately again on every visibility flip
  // (tab switch, minimize, app switch) — not waiting for the next
  // interval tick is what makes "inactive" register instantly rather
  // than up to 15s late.
  sendHeartbeat();
  document.addEventListener("visibilitychange", sendHeartbeat);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
})();
