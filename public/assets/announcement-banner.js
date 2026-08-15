/**
 * announcement-banner.js
 *
 * Include on every page that already includes authguard.js, right after
 * a `<div id="announcementBanner"></div>` placeholder (on Home, that
 * placeholder sits below the brand marquee; everywhere else it sits
 * right below the topbar — see each page's own markup).
 *
 * Fetches GET /api/announcements (already filtered server-side to only
 * what's effectively active right now — see _shared/announcements.js)
 * and renders it as a dismissible reminder bar:
 *   - 0 active  -> renders nothing
 *   - 1 active  -> shown, static
 *   - 2+ active -> auto-rotates one at a time (interval from the
 *     Settings tab's rotation-speed control, default 5s), with a
 *     "(2/3)" counter and small dots so it's clear more than one exists.
 *     Rotating between two announcements fades the outgoing text out in
 *     place while the incoming one slides in as full text from the
 *     right (TRANSITION_MS) — no per-character typing, no page-load
 *     jump: the text wrap uses a CSS grid overlap (see style.css) so
 *     both messages share one auto-sized box instead of a fixed height.
 *
 * Dismiss (✕) only hides that ONE announcement for the rest of THIS page
 * load — it's an in-memory set, not persisted anywhere, so refreshing
 * the page or logging back in shows it again. (An earlier version of
 * this used localStorage to remember dismissals permanently per
 * browser — deliberately reverted per feedback: agents expect a
 * refresh to bring reminders back, not hide them forever.)
 */
(function () {
  const POLL_MS = 60000;
  const TRANSITION_MS = 2200;
  let rotateMs = 6000; // overwritten by the server's configured value once loaded — see Settings tab

  const dismissedIds = new Set();
  function getDismissed() { return dismissedIds; }
  function dismiss(id) { dismissedIds.add(id); }

  let items = [];
  let visible = [];
  let rotateIndex = 0;
  let rotateTimer = null;

  // Under the SPA shell (spa-shell.js), more than one `#announcementBanner`
  // placeholder can exist in the live DOM at the same time: index.html's
  // own Home copy (hidden, not removed, while a different view is
  // mounted) PLUS the currently-mounted route's own copy (cloned fresh
  // into #spaMount on every visit — see mount() in spa-shell.js). Ids are
  // only meant to be unique, but `document.getElementById` silently just
  // returns the FIRST match in document order regardless — which, since
  // Home's markup comes before #spaMount's, was ALWAYS Home's hidden
  // copy, even while looking at threads/promo/etc. That's the bug this
  // rewrite fixes: every DOM lookup below is scoped to a specific `slot`
  // element (via `slot.querySelector(...)`, which correctly limits the
  // match to that slot's own descendants even when the same id exists
  // elsewhere in the document) rather than a single global
  // `document.getElementById`, and every slot currently present gets
  // painted/rotated together, not just whichever one happens to be first.
  function slots() {
    return Array.from(document.querySelectorAll('[id="announcementBanner"]'));
  }

  // Builds one slot's DOM shell fresh — called whenever the visible set
  // changes (new data from a poll, or a dismiss). Rotation itself (see
  // showItem below) never rebuilds this, it only touches the two text
  // nodes inside it, which is what makes the slide transition possible
  // in the first place (a full innerHTML replace every tick would just
  // snap instantly, no transition to animate).
  function buildSkeleton(slot) {
    slot.innerHTML = `
      <div class="announcement-banner">
        <span class="announcement-banner-icon breathing">📢</span>
        <div class="announcement-banner-body">
          <div class="announcement-banner-label breathing"><span id="annLabel">REMINDER</span></div>
          <div class="announcement-banner-textwrap">
            <div class="announcement-banner-text" id="annTextA"></div>
            <div class="announcement-banner-text" id="annTextB"></div>
          </div>
          <div class="announcement-banner-dots" id="annDots"></div>
        </div>
        <button type="button" class="announcement-banner-close" title="Dismiss">✕</button>
      </div>
    `;
    slot.querySelector(".announcement-banner-close").addEventListener("click", () => {
      dismiss(visible[rotateIndex].id);
      paint();
    });
  }

  function renderDotsAndCounter(slot, i) {
    const labelEl = slot.querySelector("#annLabel");
    if (labelEl) labelEl.textContent = (visible[i].topic || "Reminder").toUpperCase();
    const dotsEl = slot.querySelector("#annDots");
    if (dotsEl) {
      dotsEl.innerHTML = visible.length > 1
        ? visible.map((_, di) => `<span class="${di === i ? "on" : ""}"></span>`).join("")
        : "";
    }
  }

  // animate=false is used for the very first paint of a given skeleton
  // (nothing to transition FROM yet); animate=true is the actual
  // rotation tick — outgoing text fades out in place, incoming text
  // slides in as a complete block from the right.
  function showItem(slot, i, animate) {
    const a = visible[i];
    renderDotsAndCounter(slot, i);
    const front = slot.querySelector("#annTextA");
    const back = slot.querySelector("#annTextB");
    if (!front || !back) return;
    if (!animate) {
      front.textContent = a.text;
      front.style.transition = "none"; front.style.opacity = "1"; front.style.transform = "none";
      back.style.opacity = "0"; back.style.transform = "translateX(50px)";
      return;
    }
    back.textContent = a.text;
    back.style.transition = "none";
    back.style.transform = "translateX(50px)";
    back.style.opacity = "0";
    requestAnimationFrame(() => {
      front.style.transition = `opacity ${TRANSITION_MS}ms ease`;
      front.style.opacity = "0";
      back.style.transition = `transform ${TRANSITION_MS}ms ease, opacity ${TRANSITION_MS}ms ease`;
      back.style.transform = "translateX(0)";
      back.style.opacity = "1";
    });
    setTimeout(() => {
      // Settle: A becomes the resting "front" copy again so the next
      // rotation always fades FROM a clean, non-transitioning element.
      front.textContent = a.text;
      front.style.transition = "none"; front.style.opacity = "1"; front.style.transform = "none";
      back.style.opacity = "0"; back.style.transform = "translateX(50px)";
    }, TRANSITION_MS + 20);
  }

  function paintSlot(slot) {
    if (!visible.length) { slot.innerHTML = ""; return; }
    buildSkeleton(slot);
    showItem(slot, rotateIndex, false);
  }

  function paint() {
    clearInterval(rotateTimer);
    const dismissed = getDismissed();
    visible = items.filter((a) => !dismissed.has(a.id));
    if (rotateIndex >= visible.length) rotateIndex = 0;
    slots().forEach(paintSlot);
    if (visible.length > 1) {
      rotateTimer = setInterval(() => {
        rotateIndex = (rotateIndex + 1) % visible.length;
        // Re-query slots() on every tick rather than once up front — the
        // SPA shell can swap which route (and therefore which slot) is
        // mounted at any moment, including mid-rotation.
        slots().forEach((slot) => showItem(slot, rotateIndex, true));
      }, rotateMs);
    }
  }

  async function load() {
    try {
      const res = await window.AgentAuth.authFetch("/api/announcements", { cache: "no-store" });
      const data = await res.json();
      items = data.ok ? (data.announcements || []) : [];
      if (data.ok && Number.isFinite(data.rotateIntervalMs) && data.rotateIntervalMs > 0) rotateMs = data.rotateIntervalMs;
    } catch {
      // Network hiccup — leave whatever was already showing, try again next poll.
      return;
    }
    paint();
  }

  load();
  setInterval(load, POLL_MS);
  // Lets a page that just changed something (Save/Delete on
  // announcements.html, or the rotation-speed setting in the Settings
  // tab) refresh THIS device's banner immediately instead of waiting up
  // to POLL_MS — other agents still catch up on their own next poll.
  window.refreshAnnouncementBanner = load;
})();
