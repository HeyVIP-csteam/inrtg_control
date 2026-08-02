/**
 * toast.js — centered popup notification (showToast(message, type)).
 *
 * Replaces plain inline colored-text status messages with a single
 * reusable overlay (position:fixed; inset:0) + centered card,
 * pointer-events:none throughout (it's a notification, not a modal — it
 * never blocks clicking things underneath). Dims the backdrop briefly,
 * auto-fades after 2s.
 *
 * Went through several UX iterations before landing here: plain colored
 * text -> corner-stacked toasts -> centered popup with dim backdrop. If
 * porting this elsewhere, build the centered-popup version directly and
 * skip the corner-toast step.
 */
(function () {
  let overlay = null;
  let hideTimer = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "toast-overlay";
    overlay.innerHTML = '<div class="toast-card"><span class="toast-icon"></span><span class="toast-msg"></span></div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  window.showToast = function (message, type) {
    const el = ensureOverlay();
    const card = el.querySelector(".toast-card");
    card.className = "toast-card" + (type === "err" ? " toast-err" : type === "ok" ? " toast-ok" : "");
    card.querySelector(".toast-icon").textContent = type === "err" ? "✕" : type === "ok" ? "✓" : "ℹ";
    card.querySelector(".toast-msg").textContent = message;

    clearTimeout(hideTimer);
    // Force a reflow so re-triggering the class while already open still
    // restarts the transition instead of being a no-op.
    el.classList.remove("is-open");
    void el.offsetWidth;
    el.classList.add("is-open");

    hideTimer = setTimeout(function () {
      el.classList.remove("is-open");
    }, 2000);
  };
})();
