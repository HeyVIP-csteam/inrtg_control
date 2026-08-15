(function () {
  // Applied as early as possible (this script is loaded in <head>) so the
  // page never flashes the wrong theme on load.
  const saved = localStorage.getItem("theme");
  const theme = saved || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);

  window.initThemeToggle = function () {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    const setLabel = () => {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      btn.innerHTML = isDark ? "☀️ Light" : "🌙 Dark";
    };
    setLabel();
    // Guard against wiring a second click listener onto the SAME button —
    // needed since spa-shell.js re-runs each mounted view's inline
    // script (which calls this) on every visit, but the shell's own
    // topbar/#themeToggle button is never recreated, so without this
    // guard every view switch would stack another listener on it and
    // clicking would toggle the theme an extra time per visit.
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
      setLabel();
    });
  };

  window.initClock = function () {
    const el = document.getElementById("liveClock");
    if (!el) return;
    const tick = () => {
      const now = new Date();
      const day = now.toLocaleDateString(undefined, { weekday: "long" });
      const date = now.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" });
      const time = now.toLocaleTimeString(undefined, { hour12: false });
      // Colored segments (day/date/time) + a real vertical-bar divider
      // between each, instead of the previous single plain-text string.
      el.innerHTML =
        `<span class="clock-day">${day}</span>` +
        `<span class="clock-divider"></span>` +
        `<span class="clock-date">${date}</span>` +
        `<span class="clock-divider"></span>` +
        `<span class="clock-time">${time}</span>`;
    };
    tick();
    // Same guard as initThemeToggle above — same shared #liveClock
    // element, don't stack a second ticking interval on every SPA view
    // switch (spa-shell.js's setInterval-cleanup would eventually stop
    // it on view-leave anyway, but there's no reason to ever have more
    // than one running against the same element).
    if (el.dataset.wired) return;
    el.dataset.wired = "1";
    setInterval(tick, 1000);
  };
})();
