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
  var generation = 0;
  function invalidate() {
    generation++;
    previews().forEach(function (frame) {
      try {
        var doc = frame.contentDocument;
        if (doc) doc.querySelectorAll("[data-gallery-outline]").forEach(function (el) {
          el.removeAttribute("data-gallery-outline"); el.style.outline = ""; el.style.outlineOffset = "";
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
  previews().forEach(function (frame) {
    frame.addEventListener("load", function () {
      try {
        var intended = new URL(frame.getAttribute("src"), location.href).pathname;
        if (frame.contentDocument && frame.contentDocument.location.href !== "about:blank" &&
            frame.contentDocument.location.pathname !== intended) {
          generation++;
          // A preview link navigated the frame away: its findings no longer describe the preview.
          var section = frame.closest("section");
          var box = section && section.querySelector("[data-a11y-results]");
          if (box) {
            box.innerHTML = ""; box.setAttribute("data-a11y-state", "idle");
            var p = document.createElement("p"); p.className = "type-small text-muted";
            p.textContent = "Not scanned yet."; box.appendChild(p);
          }
          frame.src = intended;
          return;
        }
      } catch (e) {}
      apply(false);
    });
  });
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (theme === "system") apply(true);
  });
  apply(false);
  // The gate's own rule set (test/node/axe.ts): WCAG 2.2 A and AA with target-size on.
  var OPTIONS = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "target-size": { enabled: true } }, iframes: false, resultTypes: ["violations", "incomplete"] };
  function loadAxe(win, doc) {
    return new Promise(function (resolve, reject) {
      if (win.axe) return resolve();
      var s = doc.createElement("script"); s.src = "/dev/axe.min.js";
      var timer = setTimeout(function () { reject(new Error("axe did not load in 15 seconds")); }, 15000);
      s.onload = function () { clearTimeout(timer); resolve(); };
      s.onerror = function () { clearTimeout(timer); reject(new Error("axe did not load")); };
      doc.head.appendChild(s);
    });
  }
  function waitLoad(frame) {
    frame.scrollIntoView({ block: "nearest" });
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("a preview did not load in 15 seconds")); }, 15000);
      function done() {
        try {
          var doc = frame.contentDocument;
          if (doc && doc.readyState === "complete" && doc.location.pathname === new URL(frame.src).pathname) {
            clearTimeout(timer); return resolve();
          }
        } catch (e) {}
        frame.addEventListener("load", done, { once: true });
      }
      done();
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
          var section = box.closest("section");
          var doc = section ? section.querySelector("iframe").contentDocument : document;
          doc.querySelectorAll("[data-gallery-outline]").forEach(function (el) {
            el.removeAttribute("data-gallery-outline"); el.style.outline = ""; el.style.outlineOffset = "";
          });
          var el = doc.querySelector(node.target[0]);
          if (el) {
            el.setAttribute("data-gallery-outline", "");
            el.style.outline = "3px solid var(--color-orange)"; el.style.outlineOffset = "2px";
            el.scrollIntoView({ block: "center" });
          }
        });
        li.appendChild(text); li.appendChild(btn); list.appendChild(li);
      });
    });
    box.appendChild(list);
    return findings.reduce(function (n, f) { return n + f.nodes.length; }, 0);
  }
  function clearHighlights() {
    previews().forEach(function (frame) {
      try {
        var doc = frame.contentDocument;
        if (doc) doc.querySelectorAll("[data-gallery-outline]").forEach(function (el) {
          el.removeAttribute("data-gallery-outline"); el.style.outline = ""; el.style.outlineOffset = "";
        });
      } catch (e) {}
    });
    document.querySelectorAll("[data-gallery-outline]").forEach(function (el) {
      el.removeAttribute("data-gallery-outline"); el.style.outline = ""; el.style.outlineOffset = "";
    });
  }
  async function scanInto(box, label, win, doc, gen) {
    await loadAxe(win, doc);
    var res = await win.axe.run(doc, OPTIONS);
    if (gen !== generation) return 0;
    return showFindings(box, label,
      res.violations.map(function (f) { return Object.assign({}, f, { kind: "violation" }); })
        .concat(res.incomplete.map(function (f) { return Object.assign({}, f, { kind: "undecided" }); })));
  }
  var running = false, lastGen = 0;
  async function runScan(onlySection) {
    if (running) return;
    running = true;
    var gen = ++generation;
    lastGen = gen;
    if (runButton) runButton.disabled = true;
    document.querySelectorAll("[data-a11y-scan-one]").forEach(function (b) { b.disabled = true; });
    clearHighlights();
    if (status) status.textContent = "Running accessibility checks...";
    var boxes = onlySection ? [onlySection.querySelector("[data-a11y-results]")] :
      Array.prototype.slice.call(document.querySelectorAll("[data-a11y-results]"));
    boxes.forEach(function (box) {
      box.innerHTML = ""; box.setAttribute("data-a11y-state", "running");
      var p = document.createElement("p"); p.className = "type-small text-muted"; p.textContent = "Scanning...";
      box.appendChild(p);
    });
    var total = 0;
    try {
      await loadAxe(window, document);
      if (gen !== generation) return;
      if (!onlySection) {
        var ownBox = document.querySelector("[data-a11y-results='gallery']");
        if (ownBox) total += await scanInto(ownBox, "gallery page", window, document, gen);
      }
      var sections = onlySection ? [onlySection] :
        Array.prototype.slice.call(document.querySelectorAll("section[data-a11y-label]"));
      for (var i = 0; i < sections.length; i++) {
        if (gen !== generation) return;
        var section = sections[i], frame = section.querySelector("iframe");
        var box = section.querySelector("[data-a11y-results]");
        if (!frame || !box) continue;
        await waitLoad(frame);
        if (gen !== generation) return;
        total += await scanInto(box, section.getAttribute("data-a11y-label"), frame.contentWindow, frame.contentDocument, gen);
      }
      if (gen !== generation) return;
      if (status) status.textContent = total ? total + " accessibility finding(s). See each preview below." : "Clean: no accessibility findings.";
    } catch (e) {
      if (gen !== generation) return;
      boxes.forEach(function (box) {
        box.innerHTML = ""; box.setAttribute("data-a11y-state", "failed");
        var p = document.createElement("p"); p.className = "type-small text-muted";
        p.textContent = "Accessibility checks failed: " + e.message + ". Run them again to retry.";
        box.appendChild(p);
      });
      if (status) status.textContent = "Accessibility checks failed: " + e.message + ". Run them again to retry.";
    } finally {
      if (gen === lastGen) {
        running = false;
        if (runButton) runButton.disabled = false;
        document.querySelectorAll("[data-a11y-scan-one]").forEach(function (b) { b.disabled = false; });
      }
    }
  }
  var runButton = document.querySelector("[data-a11y-run]");
  if (runButton) runButton.addEventListener("click", function () { runScan(null); });
  document.querySelectorAll("[data-a11y-scan-one]").forEach(function (b) {
    b.addEventListener("click", function () { runScan(b.closest("section")); });
  });
})();
</script>`;
