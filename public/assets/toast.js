/*
 * Site-wide feedback toast — window.showToast(message, type)
 *   type: "ok" (default) | "err"
 *
 * One global singleton shared by every page (see toast.css for the
 * matching styles). Consolidated here instead of each page rolling its
 * own copy, after finding the same "bottom note text + centered toast
 * both firing for the same action" duplication bug in more than one
 * place — see feedback-toast-system-design.md for the full writeup.
 *
 * Rules (deliberately different for ok vs err):
 *   - ok:  auto-dismisses after 3s. The message is short ("Saved."), a
 *          glance is enough, and a lingering popup would just be in the way.
 *   - err: does NOT auto-dismiss. Failures usually need to be read
 *          carefully (which field, what the server said), and a fixed
 *          timeout either cuts them off or overstays its welcome. Instead
 *          it waits for a click anywhere on the page to close.
 *
 * Callers are responsible for NOT also duplicating this message in a
 * persistent inline note for the *success* case (that's the bug this
 * component exists to fix) — persistent inline text is still fine
 * alongside the toast for *failures*, or for detailed status a user
 * needs to read back later (e.g. "posted to Telegram but sheet logging
 * failed: <reason>") — those are a different kind of information, not a
 * duplicate of the toast.
 */
(function () {
  const AUTO_FADE_MS = 3000; // ok only
  let overlay = null;
  let card = null;
  let hideTimer = null;
  let dismissOnClick = null;

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "globalToastOverlay";
    card = document.createElement("div");
    card.className = "toast-card";
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function clearDismissListener() {
    if (dismissOnClick) {
      document.removeEventListener("click", dismissOnClick, true);
      dismissOnClick = null;
    }
  }

  function hide() {
    overlay.classList.remove("toast-show");
    clearDismissListener();
  }

  window.showToast = function (message, type) {
    if (!message) return;
    ensureDom();
    clearTimeout(hideTimer);
    clearDismissListener();

    const isErr = type === "err";
    card.innerHTML = "";
    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.textContent = isErr ? "✕" : "✓";
    const body = document.createElement("div");
    body.className = "toast-body";
    const line = document.createElement("div");
    line.textContent = message;
    body.appendChild(line);
    if (isErr) {
      const hint = document.createElement("div");
      hint.className = "toast-hint";
      hint.textContent = "Click anywhere to dismiss";
      body.appendChild(hint);
    }
    card.appendChild(icon);
    card.appendChild(body);

    card.className = "toast-card" + (isErr ? " toast-err" : " toast-ok");
    overlay.className = isErr ? "toast-overlay-err" : "";

    // Force reflow so re-triggering the same message replays the
    // animation instead of sitting there looking stuck.
    overlay.classList.remove("toast-show");
    void overlay.offsetWidth;
    overlay.classList.add("toast-show");

    if (isErr) {
      // showToast() is always called after an awaited network response,
      // so the click that triggered the action has already fully
      // finished bubbling by the time this listener attaches — it won't
      // immediately dismiss the toast it just opened.
      dismissOnClick = hide;
      document.addEventListener("click", dismissOnClick, true);
    } else {
      hideTimer = setTimeout(hide, AUTO_FADE_MS);
    }
  };
})();
