/**
 * announcement-banner.js — the amber "REMINDER" banner, on every page.
 *
 * Include once per page, after authguard.js has already set up
 * window.AgentAuth:
 *   <div id="announcementBanner"></div>
 *   <script src="/assets/toast.js" defer></script>   (not required by the
 *     banner itself, but announcements.html needs it — harmless to skip
 *     here if a page never shows toasts)
 *   <script src="/assets/announcement-banner.js" defer></script>
 *
 * Behavior:
 *   - Fetches /api/announcements on load and every 60s.
 *   - 0 active -> renders nothing (#announcementBanner:empty { display:none } in CSS).
 *   - 1 active -> static.
 *   - 2+ active -> rotates using the server's rotateIntervalMs. Outgoing
 *     text fades out in place while incoming text slides in as a
 *     complete block from the right (~2.2s) — not a typewriter effect,
 *     not an instant swap.
 *   - Dismiss (✕) is in-memory only — hides that one announcement for
 *     the rest of THIS page load; a refresh or re-login brings it back.
 *   - window.refreshAnnouncementBanner() — call after any action that
 *     just changed the data (Save/Delete on the management page, saving
 *     the rotation-speed setting) so this same device updates instantly
 *     instead of waiting up to 60s for the next poll.
 *
 * Implementation note: the DOM skeleton is built ONCE per data-change
 * (buildSkeleton()) — after that, each rotation tick (showItem()) only
 * touches two overlapping text nodes. A full innerHTML replace every
 * tick would make the CSS transition impossible to animate (no "from"
 * state to transition out of).
 */
(function () {
  const POLL_MS = 60000;
  const TRANSITION_MS = 2200;

  const root = document.getElementById("announcementBanner");
  if (!root) return;

  const dismissed = new Set();
  let items = [];
  let rotateIntervalMs = 5000;
  let rotateTimer = null;
  let transitionTimer = null;
  let currentIndex = 0;
  let usingA = true; // which of the two overlapping text nodes is "current"

  let els = null; // { wrap, icon, label, textA, textB, dots, close }
  let skeletonKey = ""; // ids joined — rebuild only when this changes

  function topicLabel(item) {
    return (item.topic || "REMINDER").toUpperCase();
  }

  function buildSkeleton() {
    root.innerHTML = "";
    if (!items.length) { els = null; return; }

    const wrap = document.createElement("div");
    wrap.className = "ann-banner";

    const icon = document.createElement("span");
    icon.className = "ann-banner-icon";
    icon.textContent = "📢";

    const body = document.createElement("div");
    body.className = "ann-banner-body";

    const label = document.createElement("div");
    label.className = "ann-banner-label";

    const textWrap = document.createElement("div");
    textWrap.className = "ann-banner-text-wrap";
    const textA = document.createElement("div");
    textA.className = "ann-banner-text";
    const textB = document.createElement("div");
    textB.className = "ann-banner-text";
    textWrap.appendChild(textA);
    textWrap.appendChild(textB);

    body.appendChild(label);
    body.appendChild(textWrap);

    const dots = document.createElement("div");
    dots.className = "ann-banner-dots";
    items.forEach(() => {
      const d = document.createElement("span");
      d.className = "ann-banner-dot";
      dots.appendChild(d);
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ann-banner-close";
    close.title = "Dismiss";
    close.textContent = "✕";

    wrap.appendChild(icon);
    wrap.appendChild(body);
    if (items.length > 1) wrap.appendChild(dots);
    wrap.appendChild(close);
    root.appendChild(wrap);

    els = { wrap, label, textA, textB, dots: items.length > 1 ? dots : null, close };

    close.addEventListener("click", onDismissClick);
  }

  function onDismissClick() {
    const item = items[currentIndex];
    if (!item) return;
    dismissed.add(item.id);
    items = items.filter((i) => i.id !== item.id);
    stopRotation();
    currentIndex = 0;
    skeletonKey = "";
    render();
  }

  function showItem(idx, isInitial) {
    if (!els || !items.length) return;
    const item = items[idx];
    els.label.textContent = topicLabel(item);

    const outgoingEl = usingA ? els.textA : els.textB;
    const incomingEl = usingA ? els.textB : els.textA;
    usingA = !usingA;

    if (isInitial) {
      incomingEl.textContent = item.text;
      incomingEl.className = "ann-banner-text ann-current";
      outgoingEl.className = "ann-banner-text";
      outgoingEl.textContent = "";
    } else {
      // Outgoing: fade out in place.
      outgoingEl.className = "ann-banner-text ann-leaving";
      // Incoming: start off-screen to the right, invisible.
      incomingEl.textContent = item.text;
      incomingEl.className = "ann-banner-text ann-entering";
      // Next frame: slide/fade it in — needs the "entering" state to
      // have actually painted first, or the transition never fires.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          incomingEl.className = "ann-banner-text ann-current";
        });
      });
      clearTimeout(transitionTimer);
      transitionTimer = setTimeout(() => {
        outgoingEl.className = "ann-banner-text";
        outgoingEl.textContent = "";
      }, TRANSITION_MS);
    }

    if (els.dots) {
      Array.from(els.dots.children).forEach((d, i) => d.classList.toggle("active", i === idx));
    }
  }

  function stopRotation() {
    if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  }

  function startRotation() {
    stopRotation();
    if (items.length < 2) return;
    rotateTimer = setInterval(() => {
      currentIndex = (currentIndex + 1) % items.length;
      showItem(currentIndex, false);
    }, Math.max(1000, rotateIntervalMs));
  }

  function render() {
    const key = items.map((i) => i.id).join(",");
    if (key !== skeletonKey) {
      skeletonKey = key;
      currentIndex = 0;
      usingA = true;
      buildSkeleton();
      if (items.length) showItem(0, true);
      startRotation();
    }
  }

  async function poll() {
    try {
      const res = await window.AgentAuth.authFetch("/api/announcements");
      const data = await res.json();
      if (!data.ok) return;
      rotateIntervalMs = data.rotateIntervalMs || rotateIntervalMs;
      items = (data.announcements || []).filter((a) => !dismissed.has(a.id));
      render();
    } catch {
      // Best-effort — a failed poll just leaves the banner showing
      // whatever it already had.
    }
  }

  window.refreshAnnouncementBanner = poll;

  poll();
  setInterval(poll, POLL_MS);
})();
