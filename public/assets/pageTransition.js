/**
 * pageTransition.js
 *
 * index.html <-> form.html are real full page navigations (plain <a
 * href>), not an SPA — so there's no way to get a genuinely smooth
 * in-DOM transition between them. This fakes it well enough: fade the
 * CURRENT page out for a beat, then let the browser's normal navigation
 * happen; the DESTINATION page fades itself in via a CSS animation
 * that's baked directly into its own <body class="page-transition-in">
 * markup (see style.css), not added by this script — so even if this
 * file fails to load, both pages still render normally, just without
 * the fade (hard cut instead of janky/half-broken).
 *
 * Usage: call window.fadeNavigate(url) from a click handler instead of
 * just following the link normally.
 */
(function () {
  const FADE_OUT_MS = 90; // matches .page-transition-out's animation-duration in style.css

  window.fadeNavigate = function fadeNavigate(url) {
    document.body.classList.remove("page-transition-in");
    document.body.classList.add("page-transition-out");
    setTimeout(() => {
      location.href = url;
    }, FADE_OUT_MS);
  };

  // The fade-in class (baked into the static HTML — see style.css's
  // DESIGN NOTE) is only ever meant to play ONCE, on arrival. But as
  // long as it stays on <body>, the browser treats <body> as having a
  // live `animation` property — which, per spec, forces <body> into its
  // own stacking context REGARDLESS of whether the animation has
  // actually finished playing. That breaks the starfield background
  // (#starfieldRoot, z-index: -2, meant to sit behind everything) —
  // once <body> has its own stacking context, -2 only sinks it behind
  // OTHER things inside that same context, not behind <body>'s own
  // background, so the animated space image disappears and only a flat
  // color shows. Fix: strip the class the instant the fade-in finishes,
  // so <body> goes back to having no `animation` at all for the rest of
  // the page's lifetime.
  document.body.addEventListener("animationend", (e) => {
    if (e.animationName === "pageFadeIn") document.body.classList.remove("page-transition-in");
  }, { once: true });
  // Fallback in case animationend somehow never fires (edge-case browser
  // quirks) — same class removal, just on a plain timer instead of the
  // animation's own completion event. Redundant with the listener above
  // in the normal case, which is fine — removing an already-removed
  // class is a harmless no-op.
  setTimeout(() => document.body.classList.remove("page-transition-in"), 400);

  /**
   * Wires up every same-tab left-click on `selector` (a CSS selector for
   * one or more <a> elements already in the DOM) to fade out before
   * navigating, instead of jumping instantly. Modifier-clicks (cmd/ctrl
   * for a new tab, middle-click, etc.) are deliberately left alone —
   * only a plain left-click gets the fade treatment, so opening links in
   * new tabs still works exactly as agents expect.
   */
  window.wireFadeLinks = function wireFadeLinks(selector) {
    document.querySelectorAll(selector).forEach((a) => {
      // Defensive: `selector` is sometimes a class shared with non-link
      // elements that just happen to look the same (e.g. a <div> that
      // toggles a dropdown open/closed via its own separate click
      // handler, not a real navigation). Only wire up genuine <a href>
      // elements — anything else has no real destination to fade to,
      // and calling fadeNavigate(undefined) would hijack its click into
      // a broken navigation instead of whatever it was actually meant
      // to do.
      if (a.tagName !== "A" || !a.getAttribute("href")) return;
      a.addEventListener("click", (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === "_blank") return;
        e.preventDefault();
        window.fadeNavigate(a.href);
      });
    });
  };
})();
