/**
 * toast.js — centered popup notification (showToast(message, type)).
 *
 * Single global overlay (#globalToastOverlay, position:fixed; inset:0) +
 * centered card, pointer-events:none throughout (it's a notification, not
 * a modal — it never blocks clicking things underneath).
 *
 * ok / err deliberately use two different dismissal mechanisms — this
 * was the key decision after watching real usage, not a stylistic
 * choice:
 *   - ok: the message is trivial ("Saved.") — a glance is enough, so it
 *     auto-fades after 3s. Sitting there longer would just be in the way.
 *   - err: the message often needs to be *read* (which field, what the
 *     server actually said) and a fixed 2-3s window routinely disappears
 *     before that finishes. So err never auto-dismisses — the user closes
 *     it by clicking anywhere once they're done reading, instead of
 *     everyone guessing a "safe" timeout.
 *
 * Went through several UX iterations before landing here: plain colored
 * text -> corner-stacked toasts -> centered popup with dim backdrop. If
 * porting this elsewhere, build the centered-popup version directly and
 * skip the corner-toast step.
 */
(function () {
  const OK_AUTO_FADE_MS = 3000; // ok only — err never auto-fades, see above
  let overlay = null;
  let hideTimer = null;
  let dismissOnClick = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.getElementById("globalToastOverlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "globalToastOverlay";
    overlay.innerHTML =
      '<div class="toast-card">' +
        '<span class="toast-icon"></span>' +
        '<span class="toast-body">' +
          '<span class="toast-msg"></span>' +
          '<span class="toast-hint"></span>' +
        '</span>' +
      '</div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  function hide() {
    overlay.classList.remove("toast-show");
    clearDismissListener();
  }

  function clearDismissListener() {
    if (dismissOnClick) {
      document.removeEventListener("click", dismissOnClick, true);
      dismissOnClick = null;
    }
  }

  window.showToast = function (message, type) {
    if (!message) return;
    const el = ensureOverlay();
    const card = el.querySelector(".toast-card");
    card.className = "toast-card" + (type === "err" ? " toast-err" : type === "ok" ? " toast-ok" : "");
    card.querySelector(".toast-icon").textContent = type === "err" ? "✕" : type === "ok" ? "✓" : "ℹ";
    card.querySelector(".toast-msg").textContent = message;
    // The shared CSS doesn't hide .toast-hint for ok toasts (there's no
    // display:none rule for that case), so this is handled here instead:
    // only err shows "Click anywhere to dismiss" — ok auto-fades and
    // doesn't need it.
    const hintEl = card.querySelector(".toast-hint");
    hintEl.textContent = type === "err" ? "Click anywhere to dismiss" : "";
    hintEl.style.display = type === "err" ? "" : "none";
    el.className = type === "err" ? "toast-overlay-err" : "";

    clearTimeout(hideTimer);
    clearDismissListener();

    // Force a reflow so re-triggering the class while already open still
    // restarts the transition instead of being a no-op.
    el.classList.remove("toast-show");
    void el.offsetWidth;
    el.classList.add("toast-show");

    if (type === "err") {
      // No timer — closes only on click. Registered with capture:true and
      // on `document` (not the overlay) because the overlay itself is
      // pointer-events:none, so it never receives clicks directly.
      //
      // No race with the click that triggered the error: showToast() is
      // always called after an awaited network response, so the click
      // that kicked off that request has already fully finished bubbling
      // by the time this listener gets attached — they're two separate
      // event loop turns.
      dismissOnClick = hide;
      document.addEventListener("click", dismissOnClick, true);
    } else {
      hideTimer = setTimeout(hide, OK_AUTO_FADE_MS);
    }
  };
})();
