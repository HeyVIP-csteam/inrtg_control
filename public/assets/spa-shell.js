/**
 * spa-shell.js  (index.html ONLY — this is the shell)
 *
 * Turns "click a tool card / module link → full page navigation" into
 * "click → fetch that page's markup, mount just its unique content into
 * #spaMount, re-run its scripts" — no more full-page reload, so the
 * Topbar/nav sidebar never unmount (no more logo-flash / white-flash
 * between pages), and the browser's back/forward buttons still work.
 *
 * Ported from spa-shell-pattern-guide.md's battle-tested pattern, with
 * two additions specific to this app:
 *   1. Every one of these routes is a real, fully-independent static
 *      page that's STILL directly reachable on its own (bookmarked,
 *      opened in a new tab, refreshed) — this file only intercepts
 *      clicks that originate from inside the shell (index.html).
 *      Nothing about threads.html/etc. themselves changes.
 *   2. A global addEventListener wrapper (not just the guide's
 *      setInterval one) — several of these pages register document/
 *      window-level listeners (paste handlers, Escape-to-close, etc.)
 *      that would otherwise silently pile up duplicates every time the
 *      agent revisits the same view in one session, since we destroy +
 *      re-run each view's script fresh on every visit (matches a real
 *      page load exactly, including for module changes on /form.html).
 */
(function () {
  // .hub-layout's entrance animation (.page-slide-in, see style.css) ends
  // with `transform: translateX(0)` and `animation-fill-mode: forwards`
  // keeps that transform applied indefinitely — which, harmlessly on its
  // own, ALSO creates a new CSS containing block for any `position:fixed`
  // descendant. That never mattered before (nothing fixed-position lived
  // inside .hub-layout), but #spaMount now nests each route's own fixed
  // lightbox (#attachLightbox, #imgLightbox) inside it, which would
  // otherwise render clipped to .hub-layout's box (starting below the
  // Topbar) instead of covering the true viewport. Strip the class once
  // the intro animation finishes — visually identical, just stops being
  // a containing block for the rest of the session.
  //
  // NOT using an `animationend` listener here: by the time this script
  // (loaded near the bottom of <body>, after several others) actually
  // runs, the 0.28s animation may already be finished — the event would
  // have already fired and been missed, since events aren't replayed.
  // A plain timeout matching style.css's known 0.28s duration (with a
  // margin) is simpler and can't lose that race.
  const layout = document.querySelector(".hub-layout");
  if (layout) setTimeout(() => layout.classList.remove("page-slide-in"), 350);
})();

(function () {
  const SHELL_PATH = "/";
  const MOUNT_ID = "spaMount";
  const HOME_ID = "viewHome";

  const ROUTES = {
    // "#announcementBanner" comes first, then the WHOLE ".threads-body-row"
    // as one unit (not ".threads-sidebar"/".threads-right-col" pulled
    // separately) — #spaMount is a column-direction flex container (see
    // its default via .hub-right-col in style.css; no longer forced to
    // row via an inline style), so stacking #announcementBanner above
    // .threads-body-row here mirrors EXACTLY the standalone page's own
    // .threads-content-col structure (brand-row / announcementBanner /
    // threads-body-row, all stacked). .threads-body-row already ships
    // with its own correct `flex:1; min-height:0` in style.css (it's the
    // same class used on the standalone page), so it stretches to fill
    // the remaining height and its own children's internal scrolling
    // (.thread-scroll-area) keeps working — pulling .threads-sidebar and
    // .threads-right-col out of that wrapper and relying on flex-wrap to
    // re-stack them was a bug: a wrapped multi-line flex row doesn't
    // stretch each line to the container's full height the way a
    // single-line row does, which silently broke the internal-scroll
    // height chain for every SPA-mounted thread/announcement view (no
    // scrollbar, reply box pushed off-screen — see conversation history).
    threads: { url: "/threads.html", select: ["#attachLightbox", "#announcementBanner", ".threads-body-row"], title: "TG Reply Threads" },
    announcements: { url: "/announcements.html", select: ["#announcementBanner", ".threads-body-row"], title: "Announcements" },
    promo: { url: "/promo.html", select: [".subpage-right-col"], title: "Promo Code Search" },
    deposit_issue: { url: "/deposit-issue.html", select: ["#imgLightbox", ".subpage-right-col"], title: "Deposit Issue" },
    deposit_backup: { url: "/deposit-backup.html", select: ["#imgLightbox", ".subpage-right-col"], title: "Deposit Backup" },
    form: { url: "/form.html", select: [".subpage-right-col"], title: "Issue Submission" },
  };

  // Scripts the shell (this very page) has already loaded once — never
  // re-fetch/re-run these even though the target page also references
  // them, they're already active and idempotent re-running them adds
  // nothing but risk (e.g. authguard.js's idle-timeout listener).
  const SHELL_OWNED_SCRIPTS = new Set([
    "/assets/theme.js", "/assets/toast.js", "/assets/starfield.js",
    "/assets/authguard.js", "/assets/announcement-banner.js",
    "/assets/schemas.js",
  ]);
  // NOTE: /assets/hub-nav.js is deliberately NOT in this set. index.html
  // (the shell) has its own separate, hand-written sidebar and never
  // loads hub-nav.js itself — that script only exists to render the
  // matching sidebar on the STANDALONE versions of threads.html/
  // form.html/etc. Every one of those pages' inline <script> starts
  // with `window.HubNav.mount("hubNavMount", {})`; treating hub-nav.js
  // as shell-owned left `window.HubNav` undefined under the SPA shell,
  // so that very first line threw and silently aborted the entire rest
  // of the view's script (thread list, form fields, everything) below
  // it — since it all lives in that one script block. HubNav.mount()
  // already no-ops safely when its target (#hubNavMount) isn't present
  // in the DOM, which is exactly the case here (the shell's persistent
  // sidebar is used instead, and #hubNavMount is intentionally excluded
  // from every route's `select` list) — so letting this script load and
  // run fresh on every mount is simply correct, not a duplicate-render
  // risk.

  const htmlCache = new Map();        // view -> parsed Document
  const scriptTextCache = new Map();  // absolute script path -> text
  const viewIntervals = {};           // view -> [intervalId, ...]
  const viewListeners = {};           // view -> [{target,type,fn,opts}, ...]
  const stylesInjectedFor = new Set(); // view names whose <style> blocks
                                        // have already been copied into
                                        // the live <head> — see mount()
  let currentView = "home";
  let capturingFor = null;

  // ---- track setInterval calls made while a view's script is running,
  // so switching away can stop its polling (guide's 坑2) ----
  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = function (...args) {
    const id = realSetInterval(...args);
    if (capturingFor) (viewIntervals[capturingFor] = viewIntervals[capturingFor] || []).push(id);
    return id;
  };

  // ---- track document/window listeners added while a view's script is
  // running, so re-running that script on a later visit doesn't stack
  // duplicate listeners on top of the old ones ----
  function trackListenersOn(target) {
    const realAdd = target.addEventListener.bind(target);
    const realRemove = target.removeEventListener.bind(target);
    target.addEventListener = function (type, fn, opts) {
      if (capturingFor) (viewListeners[capturingFor] = viewListeners[capturingFor] || []).push({ target, type, fn, opts });
      return realAdd(type, fn, opts);
    };
    target.__spaRealRemoveEventListener = realRemove;
  }
  trackListenersOn(document);
  trackListenersOn(window);

  function cleanupView(view) {
    (viewIntervals[view] || []).forEach(clearInterval);
    viewIntervals[view] = [];
    (viewListeners[view] || []).forEach(({ target, type, fn, opts }) => {
      (target.__spaRealRemoveEventListener || target.removeEventListener).call(target, type, fn, opts);
    });
    viewListeners[view] = [];
  }

  async function getDoc(view) {
    if (htmlCache.has(view)) return htmlCache.get(view);
    const res = await fetch(ROUTES[view].url);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    htmlCache.set(view, doc);
    return doc;
  }

  async function getScriptText(path) {
    if (scriptTextCache.has(path)) return scriptTextCache.get(path);
    const res = await fetch(path);
    const text = await res.text();
    scriptTextCache.set(path, text);
    return text;
  }

  function updateActiveNav(view, moduleId) {
    document.querySelectorAll(".sidebar .sidebar-item").forEach((el) => {
      const isHome = view === "home" && el.dataset.route === "home";
      const isModule = view === "form" && el.dataset.route === "form" && el.dataset.module === moduleId;
      el.classList.toggle("active", isHome || isModule);
    });
  }

  async function mount(view, opts) {
    opts = opts || {};
    if (!ROUTES[view] && view !== "home") return;

    cleanupView(currentView);
    currentView = view;

    const homeEl = document.getElementById(HOME_ID);
    const mountEl = document.getElementById(MOUNT_ID);

    if (view === "home") {
      mountEl.style.display = "none";
      mountEl.innerHTML = "";
      mountEl.removeAttribute("data-view");
      homeEl.style.display = "";
      if (opts.pushUrl !== false) history.pushState({ view: "home" }, "", SHELL_PATH);
      document.title = "PKR CS Team - TBC";
      updateActiveNav("home", null);
      return;
    }

    homeEl.style.display = "none";
    mountEl.style.display = "flex";
    mountEl.innerHTML = '<div class="spa-loading">Loading…</div>';
    // Which exact view is mounted — needed so CSS can single out just
    // Threads (auto-collapsing the persistent ISSUE SUBMISSION sidebar
    // on narrower windows, see style.css's `body:has(#spaMount[data-view="threads"])`
    // block) without also catching other routes that don't have the
    // same "not enough width for a 3rd column" problem.
    mountEl.setAttribute("data-view", view);

    const route = ROUTES[view];

    // Everything below this point touches the network (the route's HTML,
    // then each of its own script files) — ANY of those requests can
    // fail on a real connection (a dropped packet, a slow mobile link, a
    // brief edge hiccup), not just in theory. Before this fix, a failure
    // here left the "Loading…" placeholder up FOREVER: the rejected
    // promise just bubbled up to the click handler's .catch(), which
    // only logs to the console — nothing ever told the agent it had
    // failed, and nothing let them retry without knowing to reload the
    // whole page. That's the root cause behind "click a Topic → stuck on
    // Loading / page doesn't respond" reports. Now any failure anywhere
    // in this block (fetching the page, OR fetching one of its scripts)
    // is caught in one place and turned into a visible retry state
    // instead of a silent, permanent freeze.
    try {
      const doc = await getDoc(view);

      // Route-specific <style> blocks (e.g. promo.html's own .promo-shell/
      // .promo-header-card rules, not part of the shared style.css) live
      // in the fetched document's <head> — route.select only pulls BODY
      // nodes, so without this they'd silently never make it into the
      // live page and the mounted content would render completely
      // unstyled (this was a real bug: Promo / Deposit Issue / Deposit
      // Backup all define page-specific <style> blocks this way). Only
      // copy them in once per route — the rules are static, and
      // re-appending identical <style> tags on every revisit would just
      // grow <head> for no benefit.
      if (!stylesInjectedFor.has(view)) {
        doc.querySelectorAll("style").forEach((styleEl) => {
          document.head.appendChild(styleEl.cloneNode(true));
        });
        stylesInjectedFor.add(view);
      }

      let qs = `?view=${view}`;
      if (view === "form" && opts.module) qs += `&module=${encodeURIComponent(opts.module)}`;
      if (opts.pushUrl !== false) history.pushState({ view, module: opts.module || null }, "", `${SHELL_PATH}${qs}`);
      document.title = route.title;

      const frag = document.createDocumentFragment();
      route.select.forEach((sel) => {
        const node = doc.querySelector(sel);
        if (node) frag.appendChild(node.cloneNode(true));
      });
      mountEl.innerHTML = "";
      mountEl.appendChild(frag);

      // Collect scripts to run fresh: every inline <script> block in the
      // fetched document, plus any local same-origin <script src> that
      // isn't already owned/loaded by the shell (e.g. /assets/app.js,
      // which the form route needs to re-run on every mount — it reads
      // location.search for ?module= and rebuilds the form fields).
      const scripts = [];
      doc.querySelectorAll("script").forEach((s) => {
        if (s.src) {
          let path;
          try { path = new URL(s.src, location.origin).pathname; } catch { return; }
          if (path.startsWith("/assets/") && !SHELL_OWNED_SCRIPTS.has(path)) {
            scripts.push({ kind: "src", path });
          }
        } else if (s.textContent.trim()) {
          scripts.push({ kind: "inline", text: s.textContent });
        }
      });

      capturingFor = view;
      try {
        for (const s of scripts) {
          // Only the fetch itself is allowed to escape to the outer
          // catch (network failure -> retry screen, see above). Once we
          // actually HAVE the script's text, a bug INSIDE that script
          // must not block the rest of the view's scripts from running
          // — same as a real page load, where one broken <script> tag
          // doesn't stop the ones after it.
          const text = s.kind === "src" ? await getScriptText(s.path) : s.text;
          try {
            new Function(text)();
          } catch (err) {
            console.error(`[spa-shell] ${view} script error:`, err);
          }
        }
      } finally {
        capturingFor = null;
      }

      updateActiveNav(view, opts.module || null);

      // The view we just mounted has its own fresh #announcementBanner
      // placeholder (see the fix in announcement-banner.js for why this
      // is safe now that more than one such placeholder can exist in the
      // DOM at once) — paint it immediately instead of leaving it blank
      // until the script's own 60s poll happens to fire.
      if (window.refreshAnnouncementBanner) window.refreshAnnouncementBanner();
    } catch (err) {
      console.error(`[spa-shell] failed to load "${view}":`, err);
      mountEl.innerHTML = `
        <div class="spa-loading spa-error">
          <p>Couldn't load this page. Check your connection and try again.</p>
          <button type="button" class="spa-retry-btn">Retry</button>
        </div>`;
      const retryBtn = mountEl.querySelector(".spa-retry-btn");
      if (retryBtn) {
        retryBtn.addEventListener("click", () => {
          mount(view, opts).catch((e) => console.error("[spa-shell] retry failed:", e));
        });
      }
    }
  }

  // ---- capture-phase click interception, matches the guide's fix for
  // "some other script on the page grabs the click first" ----
  document.addEventListener(
    "click",
    (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const el = e.target.closest("[data-route]");
      if (!el) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      mount(el.dataset.route, { module: el.dataset.module || undefined }).catch((err) => console.error("[spa-shell] mount failed:", err));
    },
    { capture: true }
  );

  window.addEventListener("popstate", (e) => {
    const state = e.state || {};
    mount(state.view || "home", { module: state.module || undefined, pushUrl: false });
  });

  // Restore whichever view was active if the page loads with ?view= in
  // the address bar (deep link, or a refresh after navigating in-app —
  // see the guide's 坑7: pushState never points at a real file path, so
  // a refresh always re-loads THIS shell and lands here, not a 404).
  document.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(location.search);
    const view = params.get("view");
    if (view && ROUTES[view]) {
      mount(view, { module: params.get("module") || undefined, pushUrl: false });
    }
  });

  // Exposed so index.html's own inline script can trigger navigation
  // too (e.g. a "View all threads" button elsewhere), without needing
  // to know any of the above.
  window.SpaShell = { mount };
})();
