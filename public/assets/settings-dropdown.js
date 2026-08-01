/**
 * Portal-based custom dropdown — open/close + positioning logic.
 * Pair with settings-dropdown.css. Framework-agnostic vanilla JS.
 *
 * Expected markup per dropdown instance (build these strings yourself,
 * or see settings-admin-panel.js for a working example):
 *
 *   <div class="fs-dropdown" data-field="status" data-value="active">
 *     <button type="button" class="fs-dropdown-trigger">Active</button>
 *     <div class="fs-dropdown-menu">
 *       <div class="fs-dropdown-option selected" data-value="active">
 *         <span>Active</span><span class="fs-check">✓</span>
 *       </div>
 *       ...more .fs-dropdown-option rows...
 *     </div>
 *   </div>
 *
 * HOW TO WIRE IT UP (see initFsDropdowns() at the bottom for the full
 * pattern used against a container you re-render, e.g. on every save):
 *
 *   1. Call linkFsDropdownMenus(container) once after building/inserting
 *      the HTML — this is REQUIRED. It stamps `menu._dd = dd` on every
 *      dropdown's menu element so option click handlers can find their
 *      way back to the wrapper even once the menu has been portaled out
 *      to <body> and is no longer a DOM descendant of it. Skipping this
 *      step is the single most common way to "silently break" this
 *      component — an option click handler that does
 *      `opt.closest(".fs-dropdown")` instead of using the stamped
 *      reference will find null the moment the dropdown is open, throw,
 *      and LOOK like clicking simply does nothing.
 *   2. Attach a click listener to each `.fs-dropdown-trigger` that calls
 *      toggleFsDropdown(dd, trigger).
 *   3. Attach click listeners to each `.fs-dropdown-option` — read the
 *      wrapper via `opt.closest(".fs-dropdown-menu")._dd`, NOT
 *      `opt.closest(".fs-dropdown")` (see point 1).
 *   4. Call closeAllFsDropdowns() from a document-level click listener
 *      (for "click outside closes it") and optionally on scroll/resize.
 */

function linkFsDropdownMenus(container) {
  container.querySelectorAll(".fs-dropdown").forEach((dd) => {
    const menu = dd.querySelector(".fs-dropdown-menu");
    if (menu) menu._dd = dd;
  });
}

function closeFsDropdown(dd) {
  const menu = dd.querySelector(".fs-dropdown-menu") || dd._fsMenu;
  if (menu) {
    menu.style.display = "none";
    if (menu.parentElement !== dd) dd.appendChild(menu); // move back into place
  }
  dd.classList.remove("open");
}

function openFsDropdown(dd, trigger) {
  closeAllFsDropdowns();
  const menu = dd.querySelector(".fs-dropdown-menu");
  dd._fsMenu = menu;
  const rect = trigger.getBoundingClientRect();
  menu.style.display = "block";
  menu.style.width = `${rect.width}px`;
  menu.style.left = `${rect.left}px`;
  // Flip upward only if it would otherwise run off the bottom of the
  // actual browser viewport.
  const menuHeight = menu.scrollHeight || 160;
  const openUpward = rect.bottom + menuHeight + 8 > window.innerHeight && rect.top - menuHeight - 8 > 0;
  menu.style.top = openUpward ? "" : `${rect.bottom + 4}px`;
  menu.style.bottom = openUpward ? `${window.innerHeight - rect.top + 4}px` : "";
  document.body.appendChild(menu); // <-- the actual "escape the clipping container" step
  dd.classList.add("open");
}

function toggleFsDropdown(dd, trigger) {
  if (dd.classList.contains("open")) closeFsDropdown(dd);
  else openFsDropdown(dd, trigger);
}

function closeAllFsDropdowns() {
  document.querySelectorAll(".fs-dropdown.open").forEach((dd) => closeFsDropdown(dd));
}

// Call this once when a screen/modal that uses these dropdowns is
// destroyed/hidden (e.g. modal close button) — a menu left open when
// its row gets wiped out by a re-render would otherwise strand its
// portaled-to-<body> element forever.
function cleanupOrphanedFsDropdownMenus() {
  document.querySelectorAll("body > .fs-dropdown-menu").forEach((m) => m.remove());
}

/**
 * Full wiring example against a re-rendered container (e.g. a modal
 * body you replace via innerHTML on every save). Call this at the end
 * of whatever function builds your rows' HTML.
 */
function initFsDropdowns(container, { onStatusChange, onRoleToggle } = {}) {
  linkFsDropdownMenus(container);

  container.querySelectorAll(".fs-dropdown-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFsDropdown(trigger.closest(".fs-dropdown"), trigger);
    });
  });

  // Single-select behavior (e.g. a "status" field: Active / Maintenance
  // / Coming soon) — picking an option replaces the previous value and
  // closes the menu.
  container.querySelectorAll('.fs-dropdown[data-field="status"] .fs-dropdown-option').forEach((opt) => {
    opt.addEventListener("click", () => {
      const dd = opt.closest(".fs-dropdown-menu")._dd; // see the header note on why NOT .closest(".fs-dropdown")
      dd.dataset.value = opt.dataset.value;
      dd.querySelector(".fs-dropdown-trigger").textContent = opt.querySelector("span").textContent;
      opt.closest(".fs-dropdown-menu").querySelectorAll(".fs-dropdown-option").forEach((o) => o.classList.toggle("selected", o === opt));
      closeFsDropdown(dd);
      if (onStatusChange) onStatusChange(dd, opt.dataset.value);
    });
  });

  // Real multi-select behavior (e.g. "which roles can bypass this") —
  // each option toggles independently and the menu stays open.
  container.querySelectorAll('.fs-dropdown[data-field="roles"] .fs-dropdown-option').forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const dd = opt.closest(".fs-dropdown-menu")._dd;
      const current = dd.dataset.values ? dd.dataset.values.split(",").filter(Boolean) : [];
      const value = opt.dataset.value;
      const next = opt.classList.contains("selected") ? current.filter((v) => v !== value) : [...current, value];
      dd.dataset.values = next.join(",");
      opt.classList.toggle("selected");
      if (onRoleToggle) onRoleToggle(dd, next);
    });
  });
}

document.addEventListener("click", closeAllFsDropdowns);
document.addEventListener("scroll", (e) => {
  // Ignore scroll events bubbling from inside an open dropdown menu
  // itself; anything else (the row list scrolling, the window, etc.)
  // invalidates the portaled menu's fixed coordinates, so just close it
  // — repositioning live isn't worth tracking.
  if (e.target.closest && e.target.closest(".fs-dropdown")) return;
  closeAllFsDropdowns();
}, true);
