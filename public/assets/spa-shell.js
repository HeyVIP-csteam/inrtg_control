/**
 * spa-shell.js
 *
 * Mounts threads.html / promo.html / deposit-issue.html /
 * deposit-backup.html / announcements.html INTO index.html in place,
 * instead of a real page navigation — index.html's topbar, sidebar, and
 * the shared assets it already loads (theme.js, toast.js, starfield.js,
 * authguard.js, schemas.js, announcement-banner.js) all stay mounted the
 * whole time, only the content below the sidebar swaps.
 *
 * Built from spa-shell-pattern-guide.md's v2 template. See that doc for
 * the reasoning behind each fix referenced below by number.
 *
 * KNOWN GAP (not fixed here — needs real-browser QA, not guessed at):
 * the standalone threads.html/announcements.html pages assume they own
 * the full viewport below a single 61px topbar (their .threads-shell /
 * .ann-shell use `height: calc(100vh - 61px)` or 100%, with internal
 * scroll panes). index.html additionally has a .brand-row nav and an
 * #announcementBanner slot above .hub-layout, so the mounted shell has
 * *slightly* less real vertical room than the original page did — the
 * likely visible symptom, if any, is a bit of outer-page scroll beneath
 * an already-internally-scrolling panel, not a broken layout. Check this
 * first when testing in a real browser; a `#spaMount .threads-shell` /
 * `#spaMount .ann-shell` height override in style.css is the fix if it
 * turns out to matter visually.
 */
(function () {
  const SHELL_PATH = "/"; // pushState never targets anything else — see pitfall #7
  const MOUNT_ID = "spaMount";
  const HOME_ID = "viewHome";

  const ROUTES = {
    threads: {
      url: "/threads.html",
      select: [".threads-topline", "#attachLightbox", "#threadsShell"],
      // Emoji rendering is nice-to-have — threads.html's own code only
      // calls it defensively (`if (window.twemoji) ...`), so this is
      // exactly the "fire and forget" case from pitfall #5.
      extScripts: ["https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/twemoji.min.js"],
    },
    promo: {
      url: "/promo.html",
      select: [".threads-topline", ".promo-shell"],
    },
    depositIssue: {
      url: "/deposit-issue.html",
      select: [".threads-topline", "#imgLightbox", ".dep-shell"],
    },
    depositBackup: {
      url: "/deposit-backup.html",
      select: [".threads-topline", "#imgLightbox", ".dep-shell"],
    },
    announcements: {
      url: "/announcements.html",
      select: [".ann-page-backrow", "#annShell"],
    },
  };

  const htmlCache = new Map();
  const loadedExtScripts = new Set();
  const viewIntervals = {};
  Object.keys(ROUTES).forEach((k) => (viewIntervals[k] = []));
  let currentView = "home";
  let capturingFor = null;

  // Pitfall #2: a routed page's own setInterval() polling (threads.html's
  // message/list poll, announcements.html's pollAnnouncements) must stop
  // the instant you navigate away, or it keeps hitting the API forever
  // in the background.
  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = function (...args) {
    const id = realSetInterval(...args);
    if (capturingFor && viewIntervals[capturingFor]) viewIntervals[capturingFor].push(id);
    return id;
  };
  function clearViewIntervals(view) {
    (viewIntervals[view] || []).forEach(clearInterval);
    if (viewIntervals[view]) viewIntervals[view] = [];
  }

  async function getDoc(view) {
    if (htmlCache.has(view)) return htmlCache.get(view);
    const res = await fetch(ROUTES[view].url);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    htmlCache.set(view, doc);
    return doc;
  }

  function loadExternalScriptOnce(src) {
    if (loadedExtScripts.has(src) || document.querySelector(`script[src="${src}"]`)) {
      loadedExtScripts.add(src);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => { loadedExtScripts.add(src); resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function mount(view, { pushUrl = true } = {}) {
    clearViewIntervals(currentView);
    currentView = view;
    const homeEl = document.getElementById(HOME_ID);
    const mountEl = document.getElementById(MOUNT_ID);

    if (view === "home" || !ROUTES[view]) {
      currentView = "home";
      mountEl.style.display = "none";
      mountEl.classList.remove("spa-mounted");
      mountEl.innerHTML = "";
      homeEl.style.display = "";
      if (pushUrl) history.pushState({ view: "home" }, "", SHELL_PATH);
      return;
    }

    homeEl.style.display = "none";
    mountEl.style.display = "flex";
    mountEl.style.flexDirection = "column";
    mountEl.classList.add("spa-mounted");
    mountEl.innerHTML = '<div class="spa-loading" style="padding:40px; text-align:center; color:var(--ink-soft);">Loading…</div>';

    const cfg = ROUTES[view];
    const docPromise = getDoc(view);
    // Pitfall #5: non-blocking, third-party "nice to have" scripts.
    (cfg.extScripts || []).forEach((src) => loadExternalScriptOnce(src).catch(() => {}));
    const doc = await docPromise;

    // Only proceed if this is still the view the user wants — a fast
    // double-click between two routes shouldn't render the first fetch's
    // result after the second one already started.
    if (currentView !== view) return;

    // Pitfall #7: pushState only ever changes the shell's own path +
    // query string, never a real standalone file path — so a refresh
    // reloads index.html (which restores the view from the query string
    // below), instead of the browser asking the server for a static file
    // that would show up with no shell around it at all.
    if (pushUrl) history.pushState({ view }, "", `${SHELL_PATH}?view=${view}`);

    const selectors = Array.isArray(cfg.select) ? cfg.select : [cfg.select];
    const frag = document.createDocumentFragment();
    selectors.forEach((sel) => {
      const node = doc.querySelector(sel);
      if (node) frag.appendChild(node.cloneNode(true));
      else console.warn(`[spa-shell] ${view}: selector "${sel}" matched nothing in ${cfg.url}`);
    });
    (cfg.strip || []).forEach((sel) => frag.querySelectorAll(sel).forEach((el) => el.remove()));
    mountEl.innerHTML = "";
    mountEl.appendChild(frag);

    // Pitfall #1: run each inline <script> as a fresh function body
    // instead of re-inserting a real <script> tag — the fetched page's
    // own top-level `const`/`let` declarations would otherwise collide
    // with the SAME identifiers already declared by a previous mount (or
    // by index.html's own inline script, in a couple of cases) in the
    // shared global/module scope a real re-inserted <script> tag runs in.
    capturingFor = view;
    try {
      doc.querySelectorAll("script:not([src])").forEach((s) => {
        if (s.textContent.trim()) new Function(s.textContent)();
      });
    } catch (err) {
      console.error(`[spa-shell] ${view} script error:`, err);
    } finally {
      capturingFor = null;
    }
  }

  // Pitfall #4: pageTransition.js's wireFadeLinks() already listens for
  // click on plain <a href> elements in the bubble phase and calls
  // preventDefault() + a real navigation. Registering in the CAPTURE
  // phase means this always runs first regardless of load/registration
  // order, and stopImmediatePropagation() stops pageTransition.js's own
  // listener (and anything else's) from ever seeing this click at all —
  // otherwise a routed tool-card would still hard-navigate underneath us.
  document.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const el = e.target.closest("[data-route]");
    if (!el) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const view = el.dataset.route;
    if (view === currentView) return; // already there — no-op, not a re-mount
    mount(view).catch((err) => console.error("[spa-shell] mount failed:", err));
  }, { capture: true });

  // "Home" sidebar link (href="/") and any other href="/" link should
  // also route in-place rather than hard-reloading the whole shell.
  document.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const el = e.target.closest('a[href="/"]');
    if (!el || el.closest("[data-route]")) return;
    if (currentView === "home") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    mount("home").catch((err) => console.error("[spa-shell] mount failed:", err));
  }, { capture: true });

  window.addEventListener("popstate", (e) => {
    mount((e.state && e.state.view) || "home", { pushUrl: false });
  });

  // Pitfall #7 companion: on a fresh load (including a refresh after
  // navigating to /?view=xxx), restore whichever view the query string
  // says, instead of always landing back on home.
  document.addEventListener("DOMContentLoaded", () => {
    const view = new URLSearchParams(location.search).get("view");
    if (view && ROUTES[view]) mount(view, { pushUrl: false });
  });
})();
