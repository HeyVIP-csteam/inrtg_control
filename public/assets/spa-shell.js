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
 * EXTRA FIX NOT IN THE ORIGINAL GUIDE: each of the 5 pages keeps its own
 * page-specific CSS in a <style> block in ITS OWN <head> (not in the
 * shared style.css) — mount() only ever clones selected BODY content, so
 * without injectPageStyles() below, a freshly-mounted view renders with
 * zero styling for anything that isn't already in the shared stylesheet
 * (this was a real, ship-blocking bug the first time around, not a
 * hypothetical). Fixed by copying every <style> tag out of the fetched
 * doc's <head> into the real document's <head>, once per view, cached.
 *
 * index.html's own layout is now also viewport-locked (see style.css's
 * `body.hub-page` rules) the same way threads.html/announcements.html
 * already were, with .hub-main doing its own internal overflow-y:auto —
 * so a mounted view slightly taller than the available space just gets
 * its own scrollbar there instead of anything visually breaking.
 */
(function () {
  const SHELL_PATH = "/"; // pushState never targets anything else — see pitfall #7
  const MOUNT_ID = "spaMount";
  const HOME_ID = "viewHome";

  const ROUTES = {
    threads: {
      url: "/threads.html",
      select: ["#attachLightbox", "#threadsShell"],
      // Emoji rendering is nice-to-have — threads.html's own code only
      // calls it defensively (`if (window.twemoji) ...`), so this is
      // exactly the "fire and forget" case from pitfall #5.
      extScripts: ["https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/twemoji.min.js"],
      // No .threads-topline (its own "← Back to Home" pill) — the
      // persistent sidebar's Home link already covers that, and having
      // both was redundant.
      // fullBleed: a real sidebar+panel app-shell that wants ALL of
      // .hub-main's box, not the padded/centered card-column treatment
      // — see the .spa-fullbleed CSS rules for what this toggles.
      fullBleed: true,
    },
    promo: {
      // .promo-shell already brings its OWN max-width:1500px + padding
      // (see its injected <style> block) — it's a padded, centered card
      // layout, not a full-bleed app-shell, so it keeps .hub-main's
      // normal padding around it instead of stripping it.
      url: "/promo.html",
      select: ".promo-shell",
    },
    depositIssue: {
      url: "/deposit-issue.html",
      select: ["#imgLightbox", ".dep-shell"],
    },
    depositBackup: {
      url: "/deposit-backup.html",
      select: ["#imgLightbox", ".dep-shell"],
    },
    announcements: {
      url: "/announcements.html",
      select: "#annShell",
      fullBleed: true,
    },
    // "form" is different from the other 5 — one file (form.html) shared
    // by every ISSUE SUBMISSION sidebar item, parameterized by a
    // `module` query param that form.html's OWN app.js reads via
    // `new URLSearchParams(location.search).get("module")`. That means:
    //  - the fetched HTML *structure* is identical regardless of module
    //    (safe to cache once, unlike a per-module fetch)
    //  - app.js itself isn't inline in the body like the other 5 pages'
    //    scripts — it's a separate <script src> file NOT already loaded
    //    by index.html — so `paramScript` below tells mount() to fetch
    //    ITS text once and re-run it via new Function() on every visit
    //    AND every module switch (a real `<script src>` tag, once
    //    inserted, won't re-run just because the query string changed).
    form: {
      url: "/form.html",
      select: ".form-page",
      paramScript: "app.js",
      hasModuleParam: true,
    },
  };

  const htmlCache = new Map();
  const loadedExtScripts = new Set();
  const injectedStyleViews = new Set();
  const viewIntervals = {};
  Object.keys(ROUTES).forEach((k) => (viewIntervals[k] = []));
  let currentView = "home";
  let currentModule = null;
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

  // Each of the 5 pages carries its OWN page-specific CSS in a <style>
  // block in its own <head> (not in the shared style.css — e.g.
  // deposit-issue.html's 100+ .dep-* rules exist nowhere else). The
  // fetched doc's <head> is never otherwise touched by mount() — only
  // the selected body content gets cloned in — so without this, a
  // mounted view renders with zero styling for anything that isn't
  // already in the shared stylesheet. Injected once per view and
  // cached (data-spa-style="<view>-<n>" guards against a duplicate on
  // repeat visits), not removed on navigating away — CSS rules sitting
  // unused in <head> cost nothing at runtime, and re-injecting/removing
  // on every visit would just be churn for no benefit.
  function injectPageStyles(view, doc) {
    if (injectedStyleViews.has(view)) return;
    injectedStyleViews.add(view);
    doc.querySelectorAll("style").forEach((styleEl, i) => {
      const tag = document.createElement("style");
      tag.setAttribute("data-spa-style", `${view}-${i}`);
      tag.textContent = styleEl.textContent;
      document.head.appendChild(tag);
    });
  }

  async function mount(view, { pushUrl = true, module = null } = {}) {
    clearViewIntervals(currentView);
    currentView = view;
    currentModule = module;
    const homeEl = document.getElementById(HOME_ID);
    const mountEl = document.getElementById(MOUNT_ID);

    if (view === "home" || !ROUTES[view]) {
      currentView = "home";
      mountEl.style.display = "none";
      mountEl.classList.remove("spa-mounted", "spa-fullbleed");
      mountEl.removeAttribute("data-view");
      mountEl.innerHTML = "";
      homeEl.style.display = "";
      if (pushUrl) history.pushState({ view: "home" }, "", SHELL_PATH);
      return;
    }

    homeEl.style.display = "none";
    mountEl.style.display = "";
    mountEl.classList.add("spa-mounted");
    const cfg = ROUTES[view];
    mountEl.classList.toggle("spa-fullbleed", !!cfg.fullBleed);
    // Which exact view is mounted (not just "is it fullBleed") — needed
    // so CSS can single out just threads (e.g. auto-collapsing the
    // persistent ISSUE SUBMISSION sidebar on narrower windows) without
    // also catching announcements, the other fullBleed route, which
    // doesn't have the same "not enough width for a 3rd column" problem.
    mountEl.setAttribute("data-view", view);
    mountEl.innerHTML = '<div class="spa-loading" style="padding:40px; text-align:center; color:var(--ink-soft);">Loading…</div>';

    const docPromise = getDoc(view);
    // Pitfall #5: non-blocking, third-party "nice to have" scripts.
    (cfg.extScripts || []).forEach((src) => loadExternalScriptOnce(src).catch(() => {}));
    const doc = await docPromise;

    // Only proceed if this is still the view/module the user wants — a
    // fast double-click between two routes (or two modules) shouldn't
    // render the first fetch's result after a second one already started.
    if (currentView !== view || currentModule !== module) return;

    // Pitfall #7: pushState only ever changes the shell's own path +
    // query string, never a real standalone file path — so a refresh
    // reloads index.html (which restores the view from the query string
    // below), instead of the browser asking the server for a static file
    // that would show up with no shell around it at all. `module` rides
    // along in the SAME query string — form.html's own app.js (see
    // paramScript below) reads it straight from the real
    // `location.search`, so it has to actually be there before that
    // script runs, not passed as a JS variable.
    if (pushUrl) {
      const qs = cfg.hasModuleParam && module ? `view=${view}&module=${module}` : `view=${view}`;
      history.pushState({ view, module }, "", `${SHELL_PATH}?${qs}`);
    }

    injectPageStyles(view, doc);

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
      // paramScript: form.html's app.js is an external <script src>, not
      // inline — normally that'd go through loadExternalScriptOnce() and
      // just sit there loaded, but app.js's whole job is a one-shot IIFE
      // that reads location.search ONCE at execution time. A real
      // <script src> tag only ever runs once per insertion, so switching
      // modules (still "form" view, different ?module=) would leave the
      // OLD module's form on screen forever without this — fetch its
      // source text once (cached) and re-run it via new Function() every
      // single time, exactly like an inline script, specifically so a
      // module switch actually re-executes it against the new
      // location.search that was just pushState'd above.
      if (cfg.paramScript) {
        const text = await getParamScriptText(doc, cfg.paramScript);
        if (text && currentView === view && currentModule === module) new Function(text)();
      }
    } catch (err) {
      console.error(`[spa-shell] ${view} script error:`, err);
    } finally {
      capturingFor = null;
    }
  }

  const paramScriptCache = new Map();
  async function getParamScriptText(doc, filename) {
    if (paramScriptCache.has(filename)) return paramScriptCache.get(filename);
    const scriptEl = Array.from(doc.querySelectorAll("script[src]")).find((s) => s.getAttribute("src").includes(`/${filename}`));
    if (!scriptEl) return null;
    const res = await fetch(scriptEl.getAttribute("src"));
    const text = await res.text();
    paramScriptCache.set(filename, text);
    return text;
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
    const module = el.dataset.module || null;
    // Same-view same-module clicks are true no-ops; same-view but a
    // DIFFERENT module (e.g. QA -> Account Issue, both "form") must
    // still re-mount — this is exactly the module-switch case
    // paramScript exists for.
    if (view === currentView && module === currentModule) return;
    mount(view, { module }).catch((err) => console.error("[spa-shell] mount failed:", err));
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
    mount((e.state && e.state.view) || "home", { pushUrl: false, module: (e.state && e.state.module) || null });
  });

  // Pitfall #7 companion: on a fresh load (including a refresh after
  // navigating to /?view=xxx or /?view=form&module=xxx), restore
  // whichever view (and module) the query string says, instead of
  // always landing back on home.
  document.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(location.search);
    const view = params.get("view");
    if (view && ROUTES[view]) mount(view, { pushUrl: false, module: params.get("module") });
  });
})();
