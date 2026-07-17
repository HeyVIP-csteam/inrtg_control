(function () {
  // Applied as early as possible (this script is loaded in <head>) so the
  // page never flashes the wrong theme on load.
  const saved = localStorage.getItem("theme");
  const theme = saved || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);

  window.initThemeToggle = function () {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    const setIcon = () => {
      btn.textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "☀️" : "🌙";
    };
    setIcon();
    btn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
      setIcon();
    });
  };
})();
