// The gallery page's own script (D07 T01 §15): theme and width controls and axe-core on demand.
export const GALLERY_SCRIPT = `<script>// Gallery controls (D07 T01 §15): theme and width for every preview, and axe-core on demand. Session-only:
// the choices live in sessionStorage and never touch the app's own theme default.
(function () {
  var THEME_KEY = "gallery-theme", WIDTH_KEY = "gallery-width";
  var theme = "system", width = "full";
  try {
    theme = sessionStorage.getItem(THEME_KEY) || theme;
    width = sessionStorage.getItem(WIDTH_KEY) || width;
  } catch (e) { /* storage unavailable: the controls still work for this page */ }
  if (["light", "dark", "system"].indexOf(theme) < 0) theme = "system";
  if (["360", "1280", "full"].indexOf(width) < 0) width = "full";
  var status = document.querySelector("[data-a11y-status]");
  function previews() { return Array.prototype.slice.call(document.querySelectorAll("iframe[data-gallery-preview]")); }
  function applyTo(doc) {
    if (!doc || !doc.documentElement) return;
    if (theme === "system") doc.documentElement.removeAttribute("data-theme");
    else doc.documentElement.setAttribute("data-theme", theme);
  }
  function invalidate() {
    previews().forEach(function (frame) {
      try {
        var doc = frame.contentDocument;
        if (doc) doc.querySelectorAll("[data-gallery-highlight]").forEach(function (el) {
          el.removeAttribute("data-gallery-highlight"); el.style.outline = ""; el.style.outlineOffset = "";
        });
      } catch (e) {}
    });
    document.querySelectorAll("[data-a11y-results]").forEach(function (box) {
      box.innerHTML = ""; box.setAttribute("data-a11y-state", "idle");
      var p = document.createElement("p"); p.className = "type-small text-muted"; p.textContent = "Not scanned yet.";
      box.appendChild(p);
    });
    if (status) status.textContent = "Not run yet. Settings changed: run accessibility again.";
  }
  function apply(changed) {
    applyTo(document);
    previews().forEach(function (frame) {
      frame.style.width = width === "full" ? "100%" : width + "px";
      frame.style.maxWidth = "100%";
      try { applyTo(frame.contentDocument); } catch (e) {}
    });
    document.querySelectorAll("[data-gallery-theme]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-gallery-theme") === theme));
    });
    document.querySelectorAll("[data-gallery-width]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-gallery-width") === width));
    });
    try {
      sessionStorage.setItem(THEME_KEY, theme); sessionStorage.setItem(WIDTH_KEY, width);
    } catch (e) {}
    if (changed) invalidate();
  }
  document.querySelectorAll("[data-gallery-theme]").forEach(function (b) {
    b.addEventListener("click", function () { theme = b.getAttribute("data-gallery-theme"); apply(true); });
  });
  document.querySelectorAll("[data-gallery-width]").forEach(function (b) {
    b.addEventListener("click", function () { width = b.getAttribute("data-gallery-width"); apply(true); });
  });
  previews().forEach(function (frame) { frame.addEventListener("load", function () { apply(false); }); });
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (theme === "system") apply(false);
  });
  apply(false);
  // The gate's own rule set (test/node/axe.ts): WCAG 2.2 A and AA with target-size on.
  var OPTIONS = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "target-size": { enabled: true } }, iframes: false, resultTypes: ["violations", "incomplete"] };
  function loadAxe(win, doc) {
    return new Promise(function (resolve, reject) {
      if (win.axe) return resolve();
      var s = doc.createElement("script"); s.src = "/dev/axe.min.js";
      s.onload = function () { resolve(); }; s.onerror = function () { reject(new Error("axe did not load")); };
      doc.head.appendChild(s);
    });
  }
  function waitLoad(frame) {
    return new Promise(function (resolve) {
      try {
        if (frame.contentDocument && frame.contentDocument.readyState === "complete") return resolve();
      } catch (e) {}
      frame.addEventListener("load", function () { resolve(); }, { once: true });
    });
  }
  function showFindings(box, label, findings) {
    box.innerHTML = ""; box.setAttribute("data-a11y-state", findings.length ? "findings" : "clean");
    if (!findings.length) {
      var p = document.createElement("p"); p.className = "type-small text-muted";
      p.textContent = "No accessibility findings."; box.appendChild(p); return 0;
    }
    var list = document.createElement("ul"); list.className = "flex flex-col gap-8";
    findings.forEach(function (f) {
      f.nodes.forEach(function (node) {
        var li = document.createElement("li"); li.className = "flex flex-wrap items-center gap-8 type-small";
        var text = document.createElement("span");
        text.textContent = label + ": " + f.id + " (" + f.kind + "): " + (f.help || "");
        var btn = document.createElement("button"); btn.type = "button"; btn.className = "underline text-orange-text";
        btn.textContent = "Highlight";
        btn.setAttribute("data-highlight-target", node.target[0]);
        btn.addEventListener("click", function () {
          var doc = box.closest("section").querySelector("iframe").contentDocument;
          doc.querySelectorAll("[data-gallery-highlight]").forEach(function (el) {
            el.removeAttribute("data-gallery-highlight"); el.style.outline = ""; el.style.outlineOffset = "";
          });
          var el = doc.querySelector(node.target[0]);
          if (el) {
            el.setAttribute("data-gallery-highlight", "");
            el.style.outline = "3px solid #FF4A14"; el.style.outlineOffset = "2px";
            el.scrollIntoView({ block: "center" });
          }
        });
        li.appendChild(text); li.appendChild(btn); list.appendChild(li);
      });
    });
    box.appendChild(list);
    return findings.reduce(function (n, f) { return n + f.nodes.length; }, 0);
  }
  var runButton = document.querySelector("[data-a11y-run]");
  if (runButton) runButton.addEventListener("click", async function () {
    if (status) status.textContent = "Running accessibility checks...";
    document.querySelectorAll("[data-a11y-results]").forEach(function (box) {
      box.setAttribute("data-a11y-state", "running");
    });
    var total = 0, failed = false;
    try {
      await loadAxe(window, document);
      var own = await window.axe.run(document, OPTIONS);
      var ownBox = document.querySelector("[data-a11y-results='gallery']");
      if (ownBox) total += showFindings(ownBox, "gallery page",
        own.violations.map(function (f) { return Object.assign({}, f, { kind: "violation" }); })
          .concat(own.incomplete.map(function (f) { return Object.assign({}, f, { kind: "undecided" }); })));
      var sections = document.querySelectorAll("section[data-a11y-label]");
      for (var i = 0; i < sections.length; i++) {
        var section = sections[i], frame = section.querySelector("iframe");
        var box = section.querySelector("[data-a11y-results]");
        if (!frame || !box) continue;
        await waitLoad(frame);
        var win = frame.contentWindow, doc = frame.contentDocument;
        await loadAxe(win, doc);
        var res = await win.axe.run(doc, OPTIONS);
        total += showFindings(box, section.getAttribute("data-a11y-label"),
          res.violations.map(function (f) { return Object.assign({}, f, { kind: "violation" }); })
            .concat(res.incomplete.map(function (f) { return Object.assign({}, f, { kind: "undecided" }); })));
      }
      if (status) status.textContent = total ? total + " accessibility finding(s). See each preview below." : "Clean: no accessibility findings.";
    } catch (e) {
      failed = true;
      document.querySelectorAll("[data-a11y-results]").forEach(function (box) {
        box.setAttribute("data-a11y-state", "failed");
      });
      if (status) status.textContent = "Accessibility checks failed: " + e.message + ". Run them again to retry.";
    }
    if (runButton) runButton.disabled = false;
    return !failed;
  });
})();
</script>`;
