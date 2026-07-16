(function () {
  const params = new URLSearchParams(location.search);
  const moduleId = params.get("module");
  const module = window.MODULES.find((m) => m.id === moduleId);

  const titleEl = document.getElementById("title");
  const descEl = document.getElementById("desc");

  if (!module) {
    titleEl.textContent = "Form not found";
    descEl.textContent = "That module doesn't exist. Go back and pick one from the list.";
    document.querySelector(".form-card").style.display = "none";
    return;
  }

  document.title = `${module.name} — Issue Submission`;
  titleEl.textContent = module.name;
  descEl.textContent = module.description;

  // Brand dropdown
  const brandSelect = document.querySelector('select[name="brand"]');
  brandSelect.innerHTML =
    `<option value="" disabled selected>Select brand</option>` +
    window.BRANDS.map((b) => `<option value="${b.id}">${b.name}</option>`).join("");

  // Dynamic fields from schema
  const container = document.getElementById("dynamicFields");
  module.fields.forEach((f) => {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const req = f.required ? '<span class="required">*</span>' : "";
    let control = "";

    if (f.type === "textarea") {
      control = `<textarea name="${f.key}" ${f.required ? "required" : ""} placeholder="${f.placeholder || ""}"></textarea>`;
    } else if (f.type === "select") {
      control = `<select name="${f.key}" ${f.required ? "required" : ""}>
        <option value="" disabled selected>Select ${f.label.toLowerCase()}</option>
        ${f.options.map((o) => `<option value="${o}">${o}</option>`).join("")}
      </select>`;
    } else {
      control = `<input type="${f.type}" name="${f.key}" ${f.required ? "required" : ""} placeholder="${f.placeholder || ""}" />`;
    }

    wrap.innerHTML = `<label>${f.label} ${req}</label>${control}`;
    container.appendChild(wrap);
  });

  // Submit handler
  const form = document.getElementById("issueForm");
  const btn = document.getElementById("submitBtn");
  const status = document.getElementById("statusMsg");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.textContent = "";
    status.className = "status-msg";
    btn.disabled = true;
    btn.textContent = "Submitting…";

    const formData = new FormData(form);
    // Each field carries its own label so the server can build the Telegram
    // message / sheet row without needing a duplicate copy of the schema.
    const fields = module.fields.map((f) => ({
      key: f.key,
      label: f.label,
      value: formData.get(f.key) || "",
    }));

    const payload = {
      module: module.id,
      brand: formData.get("brand"),
      reporter: formData.get("reporter"),
      fields,
    };

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Submission failed");
      }

      status.textContent = "Submitted — posted to Telegram.";
      status.className = "status-msg ok";
      form.reset();
      brandSelect.selectedIndex = 0;
    } catch (err) {
      status.textContent = err.message || "Something went wrong. Try again.";
      status.className = "status-msg err";
    } finally {
      btn.disabled = false;
      btn.textContent = "Submit";
    }
  });
})();
