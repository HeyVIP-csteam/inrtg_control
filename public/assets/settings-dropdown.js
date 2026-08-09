/**
 * Portal-based custom dropdown — open/close + positioning logic, used by
 * the Settings admin panel's status picker and role multi-select. Pair
 * with settings-dropdown.css. Framework-agnostic vanilla JS.
 *
 * Expected markup per dropdown instance (built in index.html's
 * renderFeatureStatus()):
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
 * linkFsDropdownMenus() stamps `menu._dd = dd` on every dropdown's menu
 * element so option click handlers can find their way back to the
 * wrapper even once the menu has been portaled out to <body> and is no
 * longer a DOM descendant of it — reading it via `opt.closest(".fs-dropdown")`
 * instead would find null the moment the dropdown is open.
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
  const menuHeight = menu.scrollHeight || 160;
  const openUpward = rect.bottom + menuHeight + 8 > window.innerHeight && rect.top - menuHeight - 8 > 0;
  menu.style.top = openUpward ? "" : `${rect.bottom + 4}px`;
  menu.style.bottom = openUpward ? `${window.innerHeight - rect.top + 4}px` : "";
  document.body.appendChild(menu); // escape any scrolling ancestor's clipping
  dd.classList.add("open");
}

function toggleFsDropdown(dd, trigger) {
  if (dd.classList.contains("open")) closeFsDropdown(dd);
  else openFsDropdown(dd, trigger);
}

function closeAllFsDropdowns() {
  document.querySelectorAll(".fs-dropdown.open").forEach((dd) => closeFsDropdown(dd));
}

// Call when the modal that hosts these dropdowns closes — a menu left
// open when its row gets wiped out by a re-render would otherwise
// strand its portaled-to-<body> element forever.
function cleanupOrphanedFsDropdownMenus() {
  document.querySelectorAll("body > .fs-dropdown-menu").forEach((m) => m.remove());
}

/**
 * Full wiring against a re-rendered container (the Settings modal body,
 * replaced via innerHTML on every save/reset). Call at the end of
 * renderFeatureStatus().
 */
function initFsDropdowns(container, { onStatusChange, onRoleToggle } = {}) {
  linkFsDropdownMenus(container);

  container.querySelectorAll(".fs-dropdown-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      // Checked at click time, not at bind time — a trigger can start
      // disabled (e.g. the roles picker while status is "active") and
      // later become enabled via onStatusChange's live toggle, without
      // this listener ever being re-attached. Skipping the bind step
      // for a then-disabled trigger was the bug: switching status would
      // flip `trigger.disabled` back to false, but the click handler
      // was never there to begin with, so the dropdown just silently
      // never opened.
      if (trigger.disabled) return;
      const dd = trigger.closest(".fs-dropdown");
      if (dd.classList.contains("fs-dropdown-na")) return;
      toggleFsDropdown(dd, trigger);
    });
  });

  // Single-select (status: Active / Maintenance / Coming soon) — picking
  // an option replaces the previous value and closes the menu.
  container.querySelectorAll('.fs-dropdown[data-field="status"] .fs-dropdown-option').forEach((opt) => {
    opt.addEventListener("click", () => {
      const dd = opt.closest(".fs-dropdown-menu")._dd;
      dd.dataset.value = opt.dataset.value;
      dd.querySelector(".fs-dropdown-trigger").textContent = opt.querySelector("span").textContent;
      opt.closest(".fs-dropdown-menu").querySelectorAll(".fs-dropdown-option").forEach((o) => o.classList.toggle("selected", o === opt));
      closeFsDropdown(dd);
      if (onStatusChange) onStatusChange(dd, opt.dataset.value);
    });
  });

  // Multi-select (which roles can bypass this item) — each option
  // toggles independently and the menu stays open.
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
  if (e.target.closest && e.target.closest(".fs-dropdown")) return;
  closeAllFsDropdowns();
}, true);
