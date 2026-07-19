/**
 * starfield.js
 *
 * The animated space-photo background (confirmed design: user-supplied
 * photo + slow "breathing" zoom + subtle mouse-parallax + a twinkling
 * star overlay + a meteor shower overlay), injected into every page that
 * includes this script rather than duplicated as markup in all 6 HTML
 * files. Only active in dark theme — in light theme the existing
 * `--page-bg` gradient (lavender/blue, defined in style.css) stays
 * exactly as it was; a space photo doesn't suit the light theme's look,
 * so this deliberately does nothing there rather than trying to force it.
 *
 * Respects prefers-reduced-motion: shows the photo as a plain static
 * background with no zoom/parallax/stars/meteors for anyone with that
 * OS-level preference set, rather than ignoring it.
 *
 * Watches <html data-theme="..."> for changes (theme.js's toggle button
 * flips this attribute without a page reload) so switching themes
 * live adds/removes the starfield instantly, not just on next load.
 */
(function () {
  const STAR_COUNT = 60;
  const METEOR_COUNT = 22;
  let mounted = false;
  let root = null;

  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function buildStars() {
    let html = "";
    for (let i = 0; i < STAR_COUNT; i++) {
      const size = (Math.random() * 1.6 + 0.6).toFixed(2);
      const top = (Math.random() * 100).toFixed(2);
      const left = (Math.random() * 100).toFixed(2);
      const dur = (Math.random() * 3 + 2).toFixed(2);
      const delay = (Math.random() * 5).toFixed(2);
      const maxOp = (Math.random() * 0.5 + 0.5).toFixed(2);
      html += `<div class="sf-star" style="width:${size}px;height:${size}px;top:${top}%;left:${left}%;animation-duration:${dur}s;animation-delay:-${delay}s;--sf-max-op:${maxOp};"></div>`;
    }
    return html;
  }

  function buildMeteors() {
    let html = "";
    for (let i = 0; i < METEOR_COUNT; i++) {
      const top = (Math.random() * 60 - 15).toFixed(1);
      const left = (Math.random() * 90 - 10).toFixed(1);
      const dur = (Math.random() * 2.5 + 2.2).toFixed(2);
      const delay = (Math.random() * 8).toFixed(2);
      html += `<div class="sf-meteor" style="top:${top}%; left:${left}%; animation-duration:${dur}s; animation-delay:-${delay}s;"></div>`;
    }
    return html;
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    root = document.createElement("div");
    root.id = "starfieldRoot";
    root.innerHTML = `
      <div class="sf-bgwrap"><div class="sf-bgimg" id="sfBgImg"></div></div>
      <div class="sf-shade"></div>
      <div class="sf-stars">${reducedMotion() ? "" : buildStars()}</div>
      <div class="sf-meteors">${reducedMotion() ? "" : buildMeteors()}</div>
    `;
    if (reducedMotion()) root.classList.add("sf-static");
    document.body.insertBefore(root, document.body.firstChild);

    if (!reducedMotion()) {
      const bgimg = document.getElementById("sfBgImg");
      document.addEventListener("mousemove", onMouseMove);
      function onMouseMove(e) {
        const x = (e.clientX / window.innerWidth - 0.5) * 2;
        const y = (e.clientY / window.innerHeight - 0.5) * 2;
        bgimg.style.transform = `translate(${(x * -14).toFixed(1)}px, ${(y * -10).toFixed(1)}px) scale(1.04)`;
      }
      root._cleanup = () => document.removeEventListener("mousemove", onMouseMove);
    }
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    if (root) {
      if (root._cleanup) root._cleanup();
      root.remove();
      root = null;
    }
  }

  function sync() {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    if (isDark) mount(); else unmount();
  }

  function init() {
    sync();
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  // This script is included with `defer`, so document.body should
  // already exist by the time it runs — but guard anyway in case it's
  // ever included without defer.
  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init);
})();
