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
  const FADE_OUT_MS = 160; // matches .page-transition-out's animation-duration in style.css

  window.fadeNavigate = function fadeNavigate(url) {
    document.body.classList.remove("page-transition-in");
    document.body.classList.add("page-transition-out");
    setTimeout(() => {
      location.href = url;
    }, FADE_OUT_MS);
  };

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
      a.addEventListener("click", (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === "_blank") return;
        e.preventDefault();
        window.fadeNavigate(a.href);
      });
    });
  };
})();
