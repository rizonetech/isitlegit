// The app script (D07 T01 §9): the little behaviour server-rendered pages need beyond htmx, loaded on every page by
// `Document` as a module (deferred, after the page is parsed). Built by scripts/hash-asset.ts with Node's type stripping,
// so it keeps to erasable syntax and imports nothing.
//
// Copy: a `[data-copy]` button writes its value to the clipboard and says so in its group's status line (a
// `[data-copy-status]` beside it, visible and announced politely), "Copied" for 4 seconds; when the clipboard refuses
// (no permission, an insecure context, no Clipboard API) it says how to copy by hand and selects the address shown
// beside the button (`[data-copy-source]`). A button with no status line beside it announces through one hidden region.

const CLEAR_AFTER_MS = 4000;
// How long the line stays empty before a press's outcome is written: long enough that a screen reader sees the clearing
// and the new words as two changes, so a second press with the same outcome is announced again (WCAG technique ARIA19
// clears and reinserts the same way).
const ANNOUNCE_GAP_MS = 100;
const COPIED = "Copied";
const FAILED = "Copy failed: select the address to copy it";

let fallbackRegion                     = null;

// The status line of a button's copy group, or the page's one hidden region when the group has none.
function statusFor(button         )              {
  const own = button.parentElement?.closest("[data-copy-group]")?.querySelector             ("[data-copy-status]");
  if (own) return own;
  if (!fallbackRegion) {
    fallbackRegion = document.createElement("p");
    fallbackRegion.className = "sr-only";
    fallbackRegion.setAttribute("role", "status");
    fallbackRegion.setAttribute("aria-live", "polite");
    document.body.append(fallbackRegion);
  }
  return fallbackRegion;
}

const timers = new WeakMap                     ();

function say(region             , text        , clear         )       {
  const pending = timers.get(region);
  if (pending !== undefined) window.clearTimeout(pending);
  region.textContent = text;
  if (clear)
    timers.set(
      region,
      window.setTimeout(() => (region.textContent = ""), CLEAR_AFTER_MS),
    );
}

// Select the address beside the button, so a refused copy can be finished by hand.
function selectSource(button         )       {
  const source = button.parentElement?.closest("[data-copy-group]")?.querySelector("[data-copy-source]");
  const selection = window.getSelection();
  if (!source || !selection) return;
  // A source kept out of sight until it is needed (the report's link, D07 T03 §9) is shown to be selected.
  source.closest             ("[data-copy-reveal]")?.setAttribute("data-shown", "");
  const range = document.createRange();
  range.selectNodeContents(source);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copy(button             )                {
  const value = button.dataset.copy ?? "";
  const region = statusFor(button);
  // A new press starts again: the line is emptied first, and the outcome written in a later task, so the same message
  // twice running is announced twice.
  say(region, "", false);
  const emptied = new Promise((done) => window.setTimeout(done, ANNOUNCE_GAP_MS));
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error("no clipboard");
    // A button with `data-copy-html` (the signature badge, D05 T02 §7) puts rich content on the clipboard too, since
    // signature editors paste rendered content, not markup; its plain text is the button's value.
    const html = button.dataset.copyHtml;
    if (html !== undefined) {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard.write) throw new Error("no rich clipboard");
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([value], { type: "text/plain" }),
        }),
      ]);
    } else await navigator.clipboard.writeText(value);
    await emptied;
    say(region, COPIED, true);
  } catch {
    await emptied;
    say(region, button.dataset.copyFailed ?? FAILED, false);
    selectSource(button);
  }
}

document.addEventListener("click", (event) => {
  const button = (event.target                  )?.closest             ("[data-copy]");
  if (!button || button.matches(":disabled, [aria-disabled='true']")) return;
  event.preventDefault();
  void copy(button);
});

// Upload (D01 T03 §6): choosing or dropping a file on the upload page sends it at once, by XMLHttpRequest for its
// progress, to the page's own POST /upload (`x-upload-script`), which answers the report's address (`x-location`) or the
// refusal's words for the alert region. Only what is known before sending (one file, its size and name) and what the
// connection does (it stalls, or no answer comes) is worded here. Thirty seconds without progress ends a request; an
// answer lost after the file was sent is said to be unknown, and trying again is safe (the same file within the day
// answers its first case). The chosen file is kept, so Try again sends it again.
const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const UPLOAD_NAME_CHARS = 255;
const UPLOAD_STALL_MS = 30_000;
const MEGABYTE = 1024 * 1024;
// Rounded up to a tenth, as the page's own words are (src/web/pages/upload-view.tsx `megabytes`).
const sizeWords = (bytes        ) => `${Math.ceil((bytes / MEGABYTE) * 10) / 10} MB`;
const AUDIO_FILE = /\.(ogg|opus|wav|mp3)$/i;
let uploading              = null;

// The form's state, which the stylesheet draws (ready, uploading, refused, paused), and its busy flag.
function uploadState(form                 , state                                              )       {
  form.dataset.state = state;
  const input = form.querySelector                  ('input[type="file"]');
  if (input) input.disabled = state === "uploading";
  if (state === "uploading") form.setAttribute("aria-busy", "true");
  else form.removeAttribute("aria-busy");
}

function uploadSay(form                 , title        , detail = "", retry = false)       {
  const region = form.querySelector             ("#upload-alert");
  if (!region) return;
  region.replaceChildren();
  const strong = document.createElement("p");
  strong.className = "weight-text-strong wrap-anywhere";
  strong.textContent = title;
  region.append(strong);
  if (detail) {
    const line = document.createElement("p");
    line.className = "text-14 wrap-anywhere";
    line.textContent = detail;
    region.append(line);
  }
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.uploadRetry = "";
    button.className = "self-start text-14 text-orange-text underline underline-offset-4";
    button.textContent = "Try again";
    region.append(button);
  }
  if (form.dataset.state !== "paused") uploadState(form, "refused");
  region.focus();
}

function uploadSend(form                 , file      )       {
  // The input is emptied once its file is taken, so choosing the same file again (after a refusal, or after midnight)
  // is a change the page hears; the file itself is kept for Try again.
  const input = form.querySelector                  ('input[type="file"]');
  if (input) input.value = "";
  if (file.size > UPLOAD_LIMIT_BYTES) {
    uploadSay(
      form,
      `"${file.name}" is ${sizeWords(file.size)}. The limit is 25 MB.`,
      AUDIO_FILE.test(file.name)
        ? "Upload a shorter clip, or the part of the recording that matters. Voice notes are checked up to 10 minutes."
        : "Upload a smaller copy: a PDF exported again or compressed, or a screenshot rather than a full photo. A recording can be shortened to the part that matters.",
    );
    return;
  }
  if (file.name.length > UPLOAD_NAME_CHARS) {
    uploadSay(form, `The file's name is longer than ${UPLOAD_NAME_CHARS} characters. Rename it and try again.`);
    return;
  }
  if (file.size === 0) {
    uploadSay(form, "The file is empty.");
    return;
  }
  uploading = file;
  const region = form.querySelector             ("#upload-alert");
  region?.replaceChildren();
  const name = form.querySelector             ("[data-upload-name]");
  const bar = form.querySelector             ("[data-upload-bar]");
  const fill = form.querySelector             ("[data-upload-fill]");
  const sent = form.querySelector             ("[data-upload-sent]");
  if (name) name.textContent = `Uploading ${file.name}`;
  // XHR counts the whole request body (the file and its multipart framing), so progress is that body's fraction, shown
  // as the file's own bytes.
  const show = (done        ) => {
    const percent = Math.round((done / Math.max(1, file.size)) * 100);
    bar?.setAttribute("aria-valuenow", String(percent));
    if (fill) fill.style.width = `${percent}%`;
    if (sent) sent.textContent = `${sizeWords(done)} of ${sizeWords(file.size)} · then the report opens`;
  };
  show(0);
  uploadState(form, "uploading");
  const body = new FormData();
  body.append("file", file, file.name);
  const xhr = new XMLHttpRequest();
  let arrived = false;
  let stall = 0;
  const restart = () => {
    window.clearTimeout(stall);
    stall = window.setTimeout(() => xhr.abort(), UPLOAD_STALL_MS);
  };
  // A stall (aborted here) cannot tell whether the file arrived, since a browser may report its upload done only once
  // an answer starts: its outcome is unknown. A connection error before any of the file was taken did not reach us.
  const lost = (event       ) => {
    window.clearTimeout(stall);
    uploadState(form, "ready");
    if (arrived || event.type === "abort")
      uploadSay(
        form,
        "We could not tell whether the file arrived. Try again: the same file opens its first report.",
        "",
        true,
      );
    else uploadSay(form, "The file did not reach us. Check your connection and try again.", "", true);
  };
  xhr.upload.addEventListener("progress", (event) => {
    restart();
    show(event.lengthComputable && event.total > 0 ? (event.loaded / event.total) * file.size : 0);
    if (event.loaded > 0) arrived = true;
  });
  xhr.upload.addEventListener("load", () => {
    arrived = true;
    show(file.size);
    restart();
  });
  xhr.addEventListener("abort", lost);
  xhr.addEventListener("error", lost);
  xhr.addEventListener("load", () => {
    window.clearTimeout(stall);
    const report = xhr.getResponseHeader("x-location");
    if (xhr.status >= 200 && xhr.status < 300 && report) return location.assign(report);
    // The refusal's words, drawn by the server (src/web/pages/upload.tsx) and marked as an alert; anything else (a
    // gateway's own page) is an answer we cannot draw.
    uploadState(form, xhr.status === 429 ? "paused" : "refused");
    if (region && xhr.getResponseHeader("x-upload-alert") === "1") {
      region.innerHTML = xhr.responseText;
      region.focus();
    } else uploadSay(form, "The file could not be taken just now. Try again in a moment.", "", true);
  });
  xhr.open("POST", form.action);
  xhr.setRequestHeader("x-upload-script", "1");
  xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
  xhr.setRequestHeader("x-file-size", String(file.size));
  restart();
  xhr.send(body);
}

const uploadForm = (target                    ) =>
  (target                  )?.closest?.                 ("form[data-upload]") ?? null;
document.addEventListener("change", (event) => {
  const form = uploadForm(event.target);
  const input = event.target                    ;
  if (!form || input.type !== "file" || !input.files?.length) return;
  if (input.files.length > 1) {
    uploadSay(form, "Drop one file at a time.");
    return;
  }
  uploadSend(form, input.files[0]        );
});
document.addEventListener("dragover", (event) => {
  if (
    uploadForm(event.target)
      ?.querySelector("[data-upload-zone]")
      ?.contains(event.target        )
  )
    event.preventDefault();
});
document.addEventListener("drop", (event) => {
  const form = uploadForm(event.target);
  if (!form?.querySelector("[data-upload-zone]")?.contains(event.target        )) return;
  event.preventDefault();
  const files = event.dataTransfer?.files;
  if (!files?.length || form.dataset.state === "uploading") return;
  if (files.length > 1) {
    uploadSay(form, "Drop one file at a time.");
    return;
  }
  uploadSend(form, files[0]        );
});
document.addEventListener("click", (event) => {
  const retry = (event.target                  )?.closest("[data-upload-retry]");
  const form = uploadForm(retry ?? null);
  if (!retry || !form) return;
  event.preventDefault();
  const kept = uploading ?? form.querySelector                  ('input[type="file"]')?.files?.[0];
  if (kept) uploadSend(form, kept);
});
// Without the script's own sending the form posts itself; with it, a submit (Enter in the form) sends the chosen file.
document.addEventListener("submit", (event) => {
  const form = uploadForm(event.target);
  if (!form) return;
  event.preventDefault();
  const file = form.querySelector                  ('input[type="file"]')?.files?.[0];
  if (file && form.dataset.state !== "uploading") uploadSend(form, file);
});

// Print: a `[data-print]` button opens the browser's print (the report's Download PDF, D07 T03 §9), whose print rules
// leave only the report. The page is marked as running this script, and the stylesheet shows the button only under
// that mark, so a page without it never shows a button that does nothing, and content swapped in later (the report's
// header, refreshed by its poll) never flickers.
document.documentElement.dataset.script = "";
document.addEventListener("click", (event) => {
  if (!(event.target                  )?.closest("[data-print]")) return;
  event.preventDefault();
  window.print();
});

// A results request (the Cases list's filters and pager, D07 T04 §1) that fails, cannot be sent, or ends somewhere else
// (an expired session sent to sign in) is not drawn into the page: the address is loaded as a whole page instead, so
// the reader meets the sign-in, 403 or 503 page as a page, and its Try again keeps the filters.
                   
                       
                                                                 
                       
  
const asked = (detail            ) =>
  detail.pathInfo?.finalRequestPath ?? detail.pathInfo?.requestPath ?? location.href;
// A running report's poll (`[data-poll]`, D07 T03 §4) is the exception: its failure or timeout keeps the report and says
// the progress is not current until a poll answers again, and polling carries on (the region is not replaced).
const polled = (event       ) => (event.target                  )?.closest?.("[data-poll]") ?? null;
const STALE = "Progress is not up to date. Trying again.";
const stale = (on         ) => {
  let line = document.getElementById("report-stale");
  if (!on) return line?.remove();
  if (line) return;
  line = document.createElement("p");
  line.id = "report-stale";
  line.className = "type-small text-muted";
  line.textContent = STALE;
  document.getElementById("report-live")?.before(line);
  const region = document.getElementById("report-announce");
  if (region) region.textContent = STALE;
};
// A region that answers its own refusals (`[data-swap-errors]`) keeps the page, and what was typed, through a failure
// it could not draw (no connection, a timeout, an answer that is not its HTML): it says so in the form and gives the
// button back.
const NOT_REACHED = "That did not reach us. Check your connection and send it again: what you typed is kept.";
const ownFailure = (event       ) => {
  const region = (event.target                  )?.closest?.("[data-swap-errors]");
  if (!region) return false;
  // The form that failed (a region can hold several: the saved feedback's Change and Withdraw), else the region's first.
  const form = (event.target                  )?.closest?.("form") ?? region.querySelector("form");
  if (!form) return true;
  let line = form.querySelector             ("[data-not-reached]");
  if (!line) {
    line = document.createElement("p");
    line.dataset.notReached = "";
    line.setAttribute("role", "alert");
    line.className = "text-14 text-mal weight-text-strong";
    form.querySelector("button[type=submit]")?.before(line);
  }
  // A form may say its own words (the feedback's Withdraw: nothing it typed is at stake, its feedback is still there).
  line.textContent = form.dataset.notReachedText ?? NOT_REACHED;
  form.dispatchEvent(new Event("busy:release"));
  return true;
};
let casesRecoverySeq = 0;
let casesRecoveryAbort                         = null;
const casesFailure = (name        , event       ) => {
  const el = event.target                  ;
  const inCases = el?.closest?.("#case-filters") ?? (el?.getAttribute?.("hx-target") === "#case-results" ? el : null);
  if (!inCases) return false;
  if (name !== "htmx:timeout" && name !== "htmx:sendError") return false;
  document.getElementById("case-loading")?.classList.remove("htmx-request");
  const form = document.getElementById("case-filters");
  if (!form) return true;
  const href = asked((event                           ).detail);
  let alert = document.getElementById("case-filter-error");
  if (!alert) {
    alert = document.createElement("p");
    alert.id = "case-filter-error";
    alert.setAttribute("role", "alert");
    alert.className = "flex flex-wrap items-center gap-8 type-small text-mal weight-text-strong";
    form.appendChild(alert);
  }
  alert.textContent = "Could not load cases. Your current list and filters are kept. ";
  const retry = document.createElement("a");
  retry.id = "case-filter-retry";
  retry.href = href;
  retry.className = "text-orange-text underline underline-offset-4";
  retry.textContent = "Try again";
  alert.appendChild(retry);
  casesRecoveryAbort?.abort();
  casesRecoveryAbort = null;
  const seq = ++casesRecoverySeq;
  if (name === "htmx:sendError" && navigator.onLine !== false) {
    const ctrl = new AbortController();
    casesRecoveryAbort = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const hxHeaders = form.closest("[hx-headers]")?.getAttribute("hx-headers") ?? null;
    const headers                         = {};
    if (hxHeaders) {
      try {
        const parsed = JSON.parse(hxHeaders)                          ;
        if (parsed["x-cases-org"]) headers["x-cases-org"] = parsed["x-cases-org"];
      } catch {}
    }
    void fetch(href, { credentials: "same-origin", headers, signal: ctrl.signal })
      .then(async (res) => {
        if (seq !== casesRecoverySeq || ctrl.signal.aborted) return;
        const redirect = res.headers.get("hx-redirect");
        if (redirect) {
          location.assign(redirect);
          return;
        }
        if (res.redirected) {
          location.assign(res.url);
          return;
        }
        if (!res.ok) return;
        const text = await res.text();
        if (seq !== casesRecoverySeq || ctrl.signal.aborted) return;
        const doc = new DOMParser().parseFromString(text, "text/html");
        const nextHeaders = doc.querySelector("[hx-headers]")?.getAttribute("hx-headers") ?? null;
        if (hxHeaders && nextHeaders !== hxHeaders) {
          location.assign(href);
          return;
        }
        const nextResults = doc.getElementById("case-results");
        const curResults = document.getElementById("case-results");
        if (nextResults && curResults) {
          curResults.replaceWith(nextResults);
          for (const id of [
            "case-count",
            "case-stats",
            "case-period-state",
            "case-range-state",
            "case-checker-state",
          ]) {
            const nextEl = doc.getElementById(id);
            const curEl = document.getElementById(id);
            if (nextEl && curEl) curEl.replaceWith(nextEl);
          }
          document.getElementById("case-filter-error")?.remove();
          history.replaceState(history.state, "", href);
        }
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  }
  return true;
};
document.addEventListener("htmx:beforeRequest", (event) => {
  const el = event.target                  ;
  if (el?.closest?.("#case-filters") || el?.getAttribute?.("hx-target") === "#case-results") {
    casesRecoverySeq++;
    casesRecoveryAbort?.abort();
    casesRecoveryAbort = null;
    document.getElementById("case-filter-error")?.remove();
  }
});
const toggleOrgReveal = (el             ) => {
  const open = el.getAttribute("aria-expanded") === "true";
  el.setAttribute("aria-expanded", open ? "false" : "true");
};
document.addEventListener("click", (event) => {
  const reveal = (event.target                  )?.closest?.("[data-org-reveal]")                      ;
  if (reveal) toggleOrgReveal(reveal);
});
document.addEventListener("keydown", (event) => {
  const target = event.target                      ;
  if (
    target?.matches?.(".overflow-x-auto[tabindex='0']") &&
    (event.key === "ArrowRight" || event.key === "ArrowLeft")
  ) {
    event.preventDefault();
    target.scrollLeft += event.key === "ArrowRight" ? 64 : -64;
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  const reveal = target?.closest?.("[data-org-reveal]")                      ;
  if (!reveal) return;
  event.preventDefault();
  toggleOrgReveal(reveal);
});
for (const name of ["htmx:responseError", "htmx:sendError", "htmx:timeout"])
  document.addEventListener(name, (event) => {
    if (polled(event)) return stale(true);
    // A quiet poll (`[data-quiet-poll]`, the model trace's mail section) fails without a word and tries again at its
    // next interval: it must never take the reader off the page.
    if ((event.target                  )?.closest?.("[data-quiet-poll]")) return;
    if (ownFailure(event)) return;
    if (casesFailure(name, event)) return;
    if (name === "htmx:timeout") return;
    location.assign(asked((event                           ).detail));
  });

// Each change of a running report is said once through the live region outside the polled one: the step that started,
// then the outcome; an unchanged poll says nothing, and the page as loaded says nothing either.
// After an outage the region said the progress was stale, so the first poll to answer says where things stand again,
// changed or not.
let said = document.getElementById("report-live")?.dataset.announce ?? "";
// The early authentication arrival (D07 T03 §37) is said once per page: its words ride on every later progress
// announcement while the card stays, so they are taken off any announcement after the first that carries them.
const EARLY_WORDS = [" Early authentication results are in.", " No trusted authentication results were stored."];
const earlySaid = new Set(EARLY_WORDS.filter((w) => said.includes(w)));
document.addEventListener("htmx:afterSwap", () => {
  const live = document.getElementById("report-live");
  if (!live) return;
  const recovered = document.getElementById("report-stale") !== null;
  stale(false);
  const words = live.dataset.announce ?? "";
  let spoken = words;
  for (const early of EARLY_WORDS) {
    if (!spoken.includes(early)) continue;
    if (earlySaid.has(early)) spoken = spoken.replace(early, "");
    else earlySaid.add(early);
  }
  const region = document.getElementById("report-announce");
  if (spoken && (words !== said || recovered) && region) region.textContent = spoken;
  said = words;
});
// The dispute control's actions are coordinated (D07 T03 §22): while one of its forms is sending, the others
// cannot be pressed, so a delayed note can never recreate feedback a withdrawal just took back.
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const region = document.getElementById("feedback");
  if (!region || !region.contains(form)) return;
  for (const other of region.querySelectorAll("form"))
    if (other !== form)
      for (const button of other.querySelectorAll                   ("button[type=submit]")) {
        button.disabled = true;
        button.dataset.coord = "";
      }
});
// An unsent note survives Change and a reload (D07 T03 §22): it is kept per report in the tab's own storage and
// put back into whichever note field the control draws next; a saved note clears it.
const draftKey = () => `feedback-note:${location.pathname}`;
let sentDraft                = null;
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.closest("#feedback")) return;
  sentDraft = form.querySelector                     ("textarea[name=note]")?.value ?? null;
});
document.addEventListener("input", (event) => {
  const area = event.target;
  if (!(area instanceof HTMLTextAreaElement) || area.name !== "note" || !area.closest("#feedback")) return;
  sessionStorage.setItem(draftKey(), area.value);
});
function releaseCoord() {
  const region = document.getElementById("feedback");
  if (!region) return;
  for (const button of region.querySelectorAll                   ("button[data-coord]")) {
    button.disabled = false;
    delete button.dataset.coord;
  }
}
function restoreDraft(clearSaved = false) {
  const region = document.getElementById("feedback");
  if (!region) return;
  releaseCoord();
  // A swap that just saved clears the draft; a fresh page load keeps it, so a reload after an uncertain send
  // shows the reader their unsent words beside where things stand.
  if (clearSaved && region.querySelector("[data-saved]") && sessionStorage.getItem(draftKey()) === sentDraft)
    sessionStorage.removeItem(draftKey());
  const area = region.querySelector                     ("textarea[name=note]");
  const draft = sessionStorage.getItem(draftKey());
  if (area && draft !== null && area.value !== draft) area.value = draft;
}
// Only the control's own swaps settle its actions and draft: the page's other polls (the mail trace's) must
// neither unlock a coordinated send nor clear an unsent note.
document.addEventListener("htmx:afterSwap", (event) => {
  const target = event.target                  ;
  if (target && (target.id === "feedback" || target.id === "report-live" || target.closest?.("#feedback")))
    restoreDraft(true);
});
// A failed or timed-out send releases the coordinated actions too, so Change and Withdraw are never left
// disabled by a send that will never answer.
for (const name of ["htmx:responseError", "htmx:sendError", "htmx:timeout", "busy:release"])
  document.addEventListener(name, (event) => {
    const target = event.target                  ;
    if (target && (target.id === "feedback" || target.closest?.("#feedback"))) releaseCoord();
  });
restoreDraft();

// A form that answers its own refusals (`[data-swap-errors]`, the feedback control, D07 T03 §6): a 4xx or 5xx answer
// that is HTML is the form again with its errors and what was typed, drawn in place; any other failure is a page, as
// above.
                                                     
document.addEventListener("htmx:beforeSwap", (event) => {
  const detail = (event                           ).detail;
  const own = (event.target                  )?.closest?.("[data-swap-errors]");
  // Only the region's own answer (`x-feedback`), never a gateway's HTML error page.
  const mine = detail.xhr?.getResponseHeader("x-feedback") === "1";
  if (own && mine && (detail.xhr?.status ?? 0) >= 400) {
    detail.shouldSwap = true;
    detail.isError = false;
  }
});
document.addEventListener("htmx:beforeSwap", (event) => {
  const detail = (event                           ).detail;
  const landed = detail.xhr?.responseURL;
  if (!landed) return;
  const wanted = new URL(asked(detail), location.href);
  if (new URL(landed).pathname === wanted.pathname) return;
  detail.shouldSwap = false;
  location.assign(landed);
});

// After the Cases list's pager redraws the results (D07 T04 §1), focus stays where the reader was: on the end pressed
// when it is still a link, else on the other end (the pressed one is a disabled span on the first or last page). It is
// decided from the press itself, not from where focus happens to be when htmx settles: on a slow page htmx's own restore,
// the old link still holding focus as it is replaced, or a blur just after the settle each leave nothing focused, so
// focus is also watched for a moment after the settle and put back if it was lost. Focus the reader moved to another
// control meanwhile is never taken.
const PAGER_ENDS = ["case-next", "case-previous"];
let pagerPress                = null;
let pagerWatchUntil = 0;
const pagerTarget = ()                     => {
  const pressed = pagerPress ? document.getElementById(pagerPress) : null;
  if (pressed instanceof HTMLAnchorElement) return pressed;
  return PAGER_ENDS.map((id) => document.getElementById(id)).find((end) => end instanceof HTMLAnchorElement) ?? null;
};
const focusLost = () => {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || PAGER_ENDS.includes(active.id);
};
const keepPagerFocus = () => {
  if (!pagerPress || !focusLost()) return;
  const target = pagerTarget();
  if (target && document.activeElement !== target) target.focus();
};
document.addEventListener("htmx:beforeRequest", (event) => {
  const id = (event                                  ).detail?.elt?.id ?? "";
  pagerPress = PAGER_ENDS.includes(id) ? id : null;
});
document.addEventListener("htmx:afterSettle", () => {
  if (pagerPress) {
    pagerWatchUntil = Date.now() + 500;
    keepPagerFocus();
    requestAnimationFrame(keepPagerFocus);
    setTimeout(() => {
      keepPagerFocus();
      if (Date.now() >= pagerWatchUntil) pagerPress = null;
    }, 520);
    return;
  }
  if (document.activeElement && document.activeElement !== document.body) return;
  const enabled = PAGER_ENDS.map((id) => document.getElementById(id)).find((end) => end instanceof HTMLAnchorElement);
  enabled?.focus();
});
// WORKAROUND: what takes focus away just after a slow settle (CI run 41253698667, once, not reproduced locally) was not
// identified, so focus lost inside the watch window goes back to the pager end. Remove it when the cause is found and
// fixed at its own layer; the decision from the press above is the fix and stands without it.
document.addEventListener("focusout", () => {
  if (pagerPress && Date.now() < pagerWatchUntil) setTimeout(keepPagerFocus, 0);
});

// Every page of the app is private (`no-store`), yet a browser may restore one from its back/forward cache without
// asking the server (Chrome does while the cookies are unchanged, which a membership removed elsewhere does not change).
// A page so restored is loaded again, through the session and organisation checks (D07 T04 §1).
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

// Unsaved work (the protected identity page's separate forms, D05 T01 §3): a form marked `data-unsaved-guard="<what it
// holds>"` counts as changed when any of its fields differs from what the page drew. Sending a different form while one
// has changed asks first, because the answer draws the page again and the unsent edit would be lost; declining stops
// the send. It runs before the busy handler below, so a declined form is not held busy.
function changedFields(form                 )          {
  // A form drawn again after a refusal holds what was typed and never saved, whatever its fields' defaults say.
  if (form.hasAttribute("data-unsaved-retained")) return true;
  return [...form.elements].some((el) => {
    if (el instanceof HTMLInputElement) {
      if (el.type === "file") return (el.files?.length ?? 0) > 0;
      if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked;
      if (el.type === "hidden" || el.type === "submit" || el.type === "button") return false;
      return el.value !== el.defaultValue;
    }
    return el instanceof HTMLTextAreaElement ? el.value !== el.defaultValue : false;
  });
}
document.addEventListener("submit", (event) => {
  const sending = event.target;
  if (!(sending instanceof HTMLFormElement)) return;
  for (const form of document.querySelectorAll                 ("form[data-unsaved-guard]")) {
    if (form === sending || !changedFields(form)) continue;
    if (!confirm(`You have unsaved changes in ${form.dataset.unsavedGuard}. Discard them?`)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    return;
  }
});

// Following a link while a guarded form holds unsaved work asks first too (the supplier ledger's Edit and Change links,
// D06 T01 §4 completion review: a typed supplier was lost without a word). A link marked `data-discard` (a form's own
// Cancel) discards that form on purpose, so it alone is not asked about; a link opened elsewhere (a new tab, a
// download, a modifier key) leaves this page as it is and is not asked about.
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  const link = event.target instanceof Element ? event.target.closest                   ("a[href]") : null;
  if (!link || link.hasAttribute("download") || link.target === "_blank") return;
  const url = new URL(link.href, location.href);
  // A link to a place on this page (the same address with a fragment) leaves every field as it is; a link to the very
  // same address without one reloads it, so it is asked about.
  if (
    url.hash &&
    url.origin === location.origin &&
    url.pathname === location.pathname &&
    url.search === location.search
  )
    return;
  // A Cancel discards its own form only: other unsaved work on the page is still asked about (round 1).
  const own = link.hasAttribute("data-discard") ? link.closest("form") : null;
  for (const form of document.querySelectorAll                 ("form[data-unsaved-guard]")) {
    if (form === own || !changedFields(form)) continue;
    if (!confirm(`You have unsaved changes in ${form.dataset.unsavedGuard}. Discard them?`)) event.preventDefault();
    return;
  }
});

// A logo (`img[data-fallback]`, naming the message to show) that fails to load is replaced by that message, which says so
// and offers a reload. An image that failed before this script ran is found at start: `complete` with no width.
function logoFailed(img                  )       {
  const message = document.getElementById(img.dataset.fallback ?? "");
  if (!message) return;
  img.hidden = true;
  message.hidden = false;
}
document.addEventListener(
  "error",
  (event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement && img.dataset.fallback) logoFailed(img);
  },
  true,
);
for (const img of document.querySelectorAll                  ("img[data-fallback]"))
  if (img.complete && img.naturalWidth === 0) logoFailed(img);

// What the page just did, said to a screen reader and shown: the first `[data-announce]` (a result or refusal notice, a
// confirmation's heading) or, inside a `[data-announce-scope]`, the first field marked invalid, whichever comes first in
// the page, takes focus when the page opens, unless the reader already has focus somewhere (an autofocus field).
// A control the reader came to use (D07 T03 §22's dispute button, from the email's link) takes focus as the page
// opens, ahead of any announcement, when nothing else holds focus.
const cameTo = document.querySelector             ("[data-focus-on-load]");
const announced = document.querySelector             ("[data-announce], [data-announce-scope] [aria-invalid='true']");
if (document.activeElement === document.body || !document.activeElement) (cameTo ?? announced)?.focus();

// Longer than the slowest action can take on the server (a mail send's 30-second deadline, src/mail/smtp2go.ts, after
// the code is issued), so the form only comes back once its request can no longer be running.
const BUSY_MS = 45_000;
// A form marked `data-busy` (the domain page's Check now, Send code and Verify, D07 T02 §15) shows its button busy
// while the request runs, and a second press does nothing: the button says what is happening (`data-busy-label`) and
// is disabled once the form has gone. The action travels in a hidden field, so disabling the button loses nothing.
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-busy")) return;
  if (form.dataset.sent === "true") {
    event.preventDefault();
    return;
  }
  form.dataset.sent = "true";
  const button = form.querySelector                   ("button[type=submit][data-busy-label]");
  if (!button) return;
  const label = button.textContent;
  // The busy words are also said in a polite status region of the form's own, since a button's new words alone are
  // not announced (D07 T02 §7).
  let status = form.querySelector             ("[data-busy-status]");
  if (!status) {
    status = document.createElement("p");
    status.setAttribute("role", "status");
    status.dataset.busyStatus = "";
    status.className = "sr-only";
    form.append(status);
  }
  setTimeout(() => {
    // A failure answered before this task runs has already given the button back (`busy:release` cleared the
    // form's sent mark): drawing the busy words now would take it away again for good.
    if (form.dataset.sent !== "true") return;
    button.textContent = button.dataset.busyLabel ?? label;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    if (status) status.textContent = button.dataset.busyLabel ?? "";
  }, 0);
  // A request that has not answered within two seconds (slow, or stopped by the reader) offers a way to see where things
  // stand (`data-busy-check`, a page to open: the invitation itself, D07 T02 §14): opening a page sends nothing again,
  // and the button stays held meanwhile, so nothing can be done twice.
  const check = form.dataset.busyCheck;
  if (check)
    setTimeout(() => {
      if (form.dataset.sent !== "true" || form.querySelector("[data-busy-check-link]")) return;
      const link = document.createElement("a");
      link.href = check;
      link.dataset.busyCheckLink = "";
      link.className = "self-start text-14 text-orange-text underline underline-offset-4";
      link.textContent = "Taking a while? See where it stands";
      form.append(link);
      if (status) status.textContent = "Taking a while. You can see where it stands.";
    }, 2000);
  // A request the reader stops (or that never answers) does not leave the form dead: once the slowest action can have
  // answered, the button is itself again and the form can be sent. A failure the page answers in place gives it back at
  // once (`busy:release`, below).
  const release = () => {
    if (form.dataset.sent !== "true") return;
    delete form.dataset.sent;
    if (status) status.textContent = "";
    form.querySelector("[data-busy-check-link]")?.remove();
    button.textContent = label;
    // Usable again, unless another hold still applies: a box it needs that is unticked (the signup page's consent).
    const box = button.dataset.needsConsent ? document.getElementById(button.dataset.needsConsent) : null;
    button.disabled = box instanceof HTMLInputElement && !box.checked;
    button.removeAttribute("aria-busy");
  };
  setTimeout(release, Number(form.dataset.busyMs) || BUSY_MS);
  form.addEventListener("busy:release", release, { once: true });
});

// An evidence screenshot's loading, failure, retry and full-size viewer (D07 T03 §13 and §8). While an image is still
// loading the figure says so. An image that fails is classified by asking the same address once: the artefact route marks
// its answers with `x-artefact-state` (`gone` for a file no longer stored, `link-expired` for a report link that has
// expired, `unavailable` for a failed read), because a status alone cannot tell an expired link from a deleted file. A gone
// or link-expired capture says so and offers nothing to open; any other failure says it could not be loaded and offers Try
// again, which loads it once more. A retry keeps its place: the loading line and then the outcome are announced politely,
// and a repeated failure puts focus on the new Try again, but only while the reader has not moved on. Recovery controls
// sit in the figure's frame beside the opener link, never inside it, so pressing one never opens the viewer. `error` and
// `load` do not bubble, so they are heard on the capture phase, and an image that settled before this script ran is read
// from its own state.
                                                                    
const FAILURE_WORDS                                           = {
  gone: ["This screenshot is no longer stored.", "Kept for 30 days. The finding above still stands."],
  "link-expired": ["This report link has expired.", "Ask for a new one."],
  "signed-out": ["You have been signed out.", "Sign in to see this screenshot."],
  temporary: ["This screenshot could not be loaded.", null],
};
// What an answer from the artefact route says: its own mark, or a redirect to sign-in (a member's session that ended while
// the report stayed open), which the browser follows and which is no image whatever its status.
function failureOf(answer          )          {
  const state = answer.headers.get("x-artefact-state");
  if (state === "gone" || state === "link-expired") return state;
  // A request made with `redirect: "manual"` meets the route's 303 to sign-in as an opaque redirect (status 0): the same
  // whether or not the browser would have followed it, so a session that ended is read the same everywhere.
  if (answer.type === "opaqueredirect") return "signed-out";
  return "temporary";
}
// The way back after signing in: the same report, at the card the capture belongs to (a member's address; a report link
// holder has no session to end).
function signInHref(src        , cardId        ) {
  const caseId = /^\/a\/([^/]+)\//.exec(new URL(src, window.location.href).pathname)?.[1];
  const back = caseId ? `/r/${caseId}${cardId ? `#${cardId.toLowerCase()}` : ""}` : "/";
  return `/signin?next=${encodeURIComponent(back)}`;
}
async function classifyFailure(src        , deadlineMs        )                   {
  // A classification that neither answers nor fails would leave the card with no failure state: after a deadline the
  // request is given up as a temporary failure (15 seconds; `data-deadline-ms` on the card's opener shortens it).
  const mine = new AbortController();
  const deadline = setTimeout(() => mine.abort(), deadlineMs);
  try {
    const answer = await fetch(src, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      signal: mine.signal,
    });
    void answer.body?.cancel();
    return failureOf(answer);
  } catch {
    // A request that cannot even be made is a temporary failure.
  } finally {
    clearTimeout(deadline);
  }
  return "temporary";
}
const frameOf = (img                  ) => img.closest             ("[data-evidence-frame]") ?? img.parentElement;
const evidenceStatus = (img                  ) => {
  const box = frameOf(img);
  if (!box) return null;
  let status = box.querySelector             ("[data-evidence-status]");
  if (!status) {
    status = document.createElement("p");
    status.setAttribute("data-evidence-status", "");
    status.setAttribute("role", "status");
    // Focusable by script only: a pressed Try again hands its focus here, so the keyboard stays in the figure.
    status.tabIndex = -1;
    status.className = "type-small text-muted wrap-anywhere";
    box.append(status);
  }
  return status;
};
// A preview transfer that stalls emits neither `load` nor `error`, so each attempt is bounded (D07 T09 §8): the
// deadline starts only when the browser begins loading the preview (it is visible, as a lazy preview in a closed
// disclosure is not), clears when the attempt ends, and is armed fresh by every Try again. A late result from an
// abandoned attempt never overwrites the current state.
const previewTimers = new WeakMap                                                 ();
const previewAttempts = new WeakMap                          ();
const previewVisible = new WeakSet                  ();
const previewDeadline = (img                  ) =>
  Number(img.closest             ("[data-evidence-open]")?.dataset.deadlineMs) || 15_000;
const clearPreview = (img                  , bump = true) => {
  if (bump) previewAttempts.set(img, (previewAttempts.get(img) ?? 0) + 1);
  const timer = previewTimers.get(img);
  if (timer) clearTimeout(timer);
  previewTimers.delete(img);
};
const armPreview = (img                  , fresh = false) => {
  if (!img.getAttribute("src") || img.complete) return;
  // An attempt already counting down keeps its deadline: scrolling away and back does not extend it.
  if (!fresh && previewTimers.has(img)) return;
  const current = previewAttempts.get(img);
  const attempt = fresh || current === undefined ? (current ?? 0) + 1 : current;
  previewAttempts.set(img, attempt);
  const old = previewTimers.get(img);
  if (old) clearTimeout(old);
  previewTimers.set(
    img,
    setTimeout(() => {
      previewTimers.delete(img);
      if (previewAttempts.get(img) !== attempt || !img.isConnected || img.complete) return;
      // The bound is the whole recovery: the temporary-failure state shows at once, with no second request. The
      // abandoned transfer is cancelled (its address kept for Try again), so its late arrival changes nothing.
      previewAttempts.set(img, attempt + 1);
      img.dataset.evidenceAbandoned = "true";
      const src = img.getAttribute("src");
      if (src) img.dataset.evidenceSrc = src;
      img.removeAttribute("src");
      evidenceFailed(img, "temporary");
    }, previewDeadline(img)),
  );
};
const previewObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const img = entry.target                    ;
    if (entry.isIntersecting) {
      previewVisible.add(img);
      armPreview(img);
    } else {
      previewVisible.delete(img);
    }
  }
});
const registerPreview = (img                  ) => previewObserver.observe(img);
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === "attributes") {
      const img = mutation.target                    ;
      if (previewVisible.has(img)) armPreview(img, true);
      continue;
    }
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node instanceof HTMLImageElement && node.hasAttribute("data-evidence-image")) registerPreview(node);
      for (const img of node.querySelectorAll                  ("img[data-evidence-image]")) registerPreview(img);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });

const evidenceFailed = (img                  , kind         ) => {
  const box = frameOf(img);
  if (!box || box.querySelector("[data-evidence-failed]")) return;
  const note = document.createElement("div");
  note.setAttribute("data-evidence-failed", kind);
  note.className = "flex h-full flex-col items-center justify-center gap-8 p-12 text-center text-14";
  const [first, second] = FAILURE_WORDS[kind];
  const words = document.createElement("p");
  words.className = "wrap-anywhere weight-text-strong";
  words.textContent = first;
  note.append(words);
  if (second) {
    const more = document.createElement("p");
    more.className = "wrap-anywhere text-muted";
    more.textContent = second;
    note.append(more);
  }
  const opener = img.closest             ("[data-evidence-open]");
  const hideOpener = (hidden         ) => {
    if (opener) opener.hidden = hidden;
    else img.hidden = hidden;
  };
  let retry                           = null;
  if (kind === "signed-out") {
    const signIn = document.createElement("a");
    signIn.href = signInHref(
      img.getAttribute("src") ?? "",
      img.closest             ("[data-evidence-open]")?.dataset.viewerId ?? "",
    );
    signIn.className =
      "self-center text-14 text-orange-text underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-text";
    signIn.textContent = "Sign in";
    note.append(signIn);
  }
  if (kind === "temporary") {
    retry = document.createElement("button");
    retry.type = "button";
    retry.className =
      "self-center text-14 text-orange-text underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-text";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => {
      const src = img.getAttribute("src") || img.dataset.evidenceSrc || "";
      delete img.dataset.evidenceAbandoned;
      img.dataset.evidenceRetried = "true";
      const status = evidenceStatus(img);
      note.remove();
      hideOpener(false);
      if (status) {
        status.textContent = "Loading the screenshot again.";
        status.focus();
      }
      img.removeAttribute("src");
      img.setAttribute("src", src);
      armPreview(img, true);
    });
    note.append(retry);
  }
  hideOpener(true);
  const status = evidenceStatus(img);
  // The first failure is announced once through the figure's live status, without moving focus; a failed retry
  // replaces it below with its own words.
  if (status) status.textContent = img.dataset.evidenceRetried === "true" ? "" : first;
  box.append(note);
  if (img.dataset.evidenceRetried === "true" && status) {
    // A failed retry keeps the keyboard where it was, but only while the reader has not moved on: the new button takes
    // the focus the figure's status line holds, and a reader who tabbed elsewhere is left where they are.
    const holds = document.activeElement === status;
    status.textContent = kind === "temporary" ? "The screenshot still could not be loaded." : first;
    if (holds && retry) retry.focus();
  }
};
const evidenceLoaded = (img                  ) => {
  const status = evidenceStatus(img);
  if (!status) return;
  status.textContent = img.dataset.evidenceRetried === "true" ? "The screenshot loaded." : "";
};
const evidenceError = (img                  ) => {
  if (img.dataset.evidenceClassifying === "true") return;
  img.dataset.evidenceClassifying = "true";
  const deadlineMs = Number(img.closest             ("[data-evidence-open]")?.dataset.deadlineMs) || 15_000;
  const attr = img.getAttribute("src") || "";
  const src = img.currentSrc || attr;
  const attempt = previewAttempts.get(img) ?? 0;
  void classifyFailure(src, deadlineMs).then((kind) => {
    delete img.dataset.evidenceClassifying;
    // A classification for an attempt the reader has since retried (a retry reuses the same address, so the
    // attempt identity, not the URL, decides), or one that has since loaded, is stale.
    if ((previewAttempts.get(img) ?? 0) !== attempt || (img.getAttribute("src") || "") !== attr || img.naturalWidth > 0)
      return;
    evidenceFailed(img, kind);
  });
};
document.addEventListener(
  "error",
  (event) => {
    const img = event.target;
    if (
      img instanceof HTMLImageElement &&
      img.hasAttribute("data-evidence-image") &&
      img.dataset.evidenceAbandoned !== "true"
    ) {
      clearPreview(img, false);
      evidenceError(img);
    }
  },
  true,
);
document.addEventListener(
  "load",
  (event) => {
    const img = event.target;
    if (
      img instanceof HTMLImageElement &&
      img.hasAttribute("data-evidence-image") &&
      img.dataset.evidenceAbandoned !== "true"
    ) {
      clearPreview(img);
      evidenceLoaded(img);
    }
  },
  true,
);
for (const img of document.querySelectorAll                  ("img[data-evidence-image]")) {
  registerPreview(img);
  if (img.complete && img.naturalWidth === 0 && img.getAttribute("src")) evidenceError(img);
  else if (!img.complete) {
    const status = evidenceStatus(img);
    if (status) status.textContent = "Loading the screenshot.";
  }
}

// The full-size viewer (D07 T03 §8, board `Report-EvidenceViewer`): a native modal dialog over the report, built from the
// opener link's own attributes with text only, so nothing from a finding is ever markup. The capture sits at its natural
// size in a scrollable, focusable region (both ways on a phone); Close, Escape and the backdrop-less native dialog keep the
// page behind inert, and focus returns to the link that opened it. The dialog has its own loading, gone, link-expired and
// temporary-failure states, and Close works in every one of them.
const BUTTON =
  "inline-flex items-center gap-8 h-40 px-16 rounded-control border border-control-border bg-surface text-ink text-15 weight-text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-text";
const make =                                        (tag   , className        , text         ) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function openViewer(opener                   ) {
  const id = opener.dataset.viewerId ?? "";
  const caption = opener.dataset.viewerCaption ?? "";
  const src = opener.getAttribute("href") ?? "";
  const dialog = make(
    "dialog",
    "m-auto flex max-h-[calc(100dvh-32px)] max-w-none w-[min(1100px,calc(100vw-32px))] max-md:h-dvh max-md:max-h-dvh max-md:w-screen flex-col overflow-hidden rounded-card border border-line bg-surface p-0 text-ink shadow-card backdrop:bg-ink/60",
  );
  dialog.setAttribute("data-evidence-viewer", "");
  const title = make("h2", "text-18 weight-text-strong wrap-anywhere m-0", id ? `${id} \u00b7 ${caption}` : caption);
  title.id = "evidence-viewer-title";
  const meta = make("p", "type-small text-muted m-0");
  meta.id = "evidence-viewer-meta";
  const dims = make("span", "");
  const scrolls = make("span", "md:hidden", " \u00b7 scrolls both ways");
  meta.append(dims, scrolls);
  const close = make("button", BUTTON);
  close.type = "button";
  close.append(make("span", "", "Close"), make("span", "max-md:hidden text-13 text-muted", "Esc"));
  close.setAttribute("aria-label", "Close");
  const head = make("div", "flex items-start justify-between gap-16 border-b border-line p-16");
  const heading = make("div", "flex min-w-0 flex-col gap-4");
  heading.append(title, meta);
  head.append(heading, close);
  const region = make(
    "div",
    "min-h-0 flex-1 overflow-auto bg-subtle focus-visible:outline-2 focus-visible:outline-orange-text",
  );
  region.tabIndex = 0;
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", `Screenshot at full size: ${caption}`);
  const status = make("p", "type-small text-muted m-0 p-16 wrap-anywhere");
  const image = make("img", "block max-w-none");
  image.alt = caption;
  image.hidden = true;
  const failure = make("div", "flex flex-col items-start gap-8 p-16 text-14");
  failure.hidden = true;
  region.append(status, image, failure);
  const foot = make(
    "div",
    "flex flex-col gap-12 border-t border-line bg-surface p-16 md:flex-row md:items-center md:justify-between",
  );
  // The board's two footers: what the capture is on a wide screen, how to read it on a phone (one short line each).
  foot.append(
    make("p", "type-small text-muted m-0 max-md:hidden", "The page as the contained browser saw it."),
    make("p", "type-small text-muted m-0 md:hidden", "Pinch or scroll to read it."),
  );
  const download = make(
    "a",
    "text-14 weight-text-strong text-orange-text underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-text",
    "Download the screenshot (PNG)",
  );
  download.href = opener.dataset.viewerDownload ?? src;
  download.setAttribute("rel", "noopener");
  foot.append(download);
  dialog.setAttribute("aria-labelledby", title.id);
  dialog.setAttribute("aria-describedby", meta.id);
  const live = make("p", "sr-only");
  live.setAttribute("role", "status");
  dialog.append(head, region, foot, live);

  // The capture is asked for afresh (never from the preview's cached copy) so its own answer, a gone or expired mark
  // included, is read from the one response; the bytes become an object address for the image and are released on close.
  // Close aborts a request still out, and a retry aborts the one before it, so transfers never pile up.
  let objectUrl                = null;
  let pending                         = null;
  // One live line says each settled outcome once (the visible words below are not a live region, they are replaced).
  const say = (words        ) => {
    live.textContent = "";
    setTimeout(() => {
      live.textContent = words;
    }, 30);
  };
  const showFailure = (kind         , again         ) => {
    const [first, second] = FAILURE_WORDS[kind];
    // A retry keeps the keyboard where it was, but only while the reader has not moved on (focus is on the scroll region
    // the pressed button handed it to); a reader who tabbed elsewhere is left where they are.
    const holds = again && document.activeElement === region;
    status.textContent = "";
    status.hidden = true;
    image.hidden = true;
    failure.replaceChildren(make("p", "m-0 weight-text-strong wrap-anywhere", first));
    if (second) failure.append(make("p", "m-0 text-muted wrap-anywhere", second));
    let again$                     = null;
    if (kind === "temporary") {
      const retry = make("button", BUTTON, "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => {
        region.focus();
        void load(true);
      });
      failure.append(retry);
      again$ = retry;
    }
    if (kind === "signed-out") {
      const signIn = make("a", BUTTON, "Sign in");
      signIn.href = signInHref(src, id);
      failure.append(signIn);
      again$ = signIn;
    }
    // A capture that is gone or whose link has expired has nothing to download either.
    download.hidden = kind === "gone" || kind === "link-expired";
    failure.hidden = false;
    say(second ? `${first} ${second}` : first);
    if (holds) again$?.focus();
  };
  const load = async (again         ) => {
    pending?.abort();
    const mine = new AbortController();
    pending = mine;
    // A request that neither answers nor fails would leave "Loading..." for ever: after a deadline it is given up and
    // the temporary-failure state with Try again shows (15 seconds; `data-deadline-ms` on the opener lets a test
    // shorten it). The deadline stays armed through the body: headers arriving while the transfer stalls still give up.
    let late = false;
    const deadline = setTimeout(() => {
      late = true;
      mine.abort();
    }, Number(opener.dataset.deadlineMs) || 15_000);
    failure.hidden = true;
    failure.replaceChildren();
    download.hidden = false;
    image.hidden = true;
    status.hidden = false;
    status.textContent = again ? "Loading the screenshot again." : "Loading the screenshot at full size.";
    say(status.textContent);
    dims.textContent = "";
    try {
      const answer = await fetch(src, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        signal: mine.signal,
      });
      if (mine.signal.aborted || !dialog.isConnected) return;
      if (!answer.ok) {
        void answer.body?.cancel();
        showFailure(failureOf(answer), again);
        return;
      }
      const blob = await answer.blob();
      clearTimeout(deadline);
      if (mine.signal.aborted || !dialog.isConnected || pending !== mine) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      loadedAgain = again;
      image.setAttribute("src", objectUrl);
    } catch {
      // An abort is the reader closing or retrying: nothing to say, unless the deadline fired it.
      if ((late || !mine.signal.aborted) && dialog.isConnected && pending === mine) showFailure("temporary", again);
    } finally {
      clearTimeout(deadline);
    }
  };
  let loadedAgain = false;
  image.addEventListener("load", () => {
    status.textContent = "";
    status.hidden = true;
    image.hidden = false;
    dims.textContent = `${image.naturalWidth} \u00d7 ${image.naturalHeight} px`;
    say(`The screenshot loaded. ${dims.textContent}.`);
  });
  image.addEventListener("error", () => showFailure("temporary", loadedAgain));
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    pending?.abort();
    dialog.remove();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    document.documentElement.removeAttribute("data-evidence-viewing");
    // Focus goes back to the link that opened the viewer; when the preview failed while the viewer was open, that link is
    // hidden, so it goes to the card's recovery control, or the card itself.
    const target = opener.hidden
      ? (opener
          .closest("[data-evidence-frame]")
          ?.querySelector             ("[data-evidence-failed] button, [data-evidence-failed] a") ??
        opener.closest             ("article"))
      : opener;
    target?.focus();
  });
  document.body.append(dialog);
  document.documentElement.setAttribute("data-evidence-viewing", "");
  dialog.showModal();
  void load(false);
  close.focus();
}
// The opener links open the viewer when script runs; Space also activates them as a button would. Without script they stay
// plain links to the capture.
for (const opener of document.querySelectorAll                   ("a[data-evidence-open]"))
  opener.setAttribute("role", "button");
document.addEventListener("click", (event) => {
  const opener = (event.target                  )?.closest                   ("a[data-evidence-open]");
  if (!opener || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
    return;
  event.preventDefault();
  openViewer(opener);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== " ") return;
  const opener = (event.target                  )?.closest                   ("a[data-evidence-open]");
  if (!opener) return;
  event.preventDefault();
  openViewer(opener);
});

// Stepping through a filtered run from a report (D07 T04 §9): `j` to the next case, `k` to the previous, `u` back
// to the list, as Gmail's keys do. Only while the step controls themselves hold focus (WCAG 2.1.4: a
// character-key shortcut active only on its component needs no off switch), never while typing, never with a
// modifier, and the addresses are the ones the page drew, so a disabled end simply has no key.
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
  const target = event.target                  ;
  if (target?.closest("input, textarea, select, [contenteditable]")) return;
  const steps = document.querySelector             ("[data-case-steps]");
  if (!steps?.contains(target        )) return;
  const to =
    event.key === "j"
      ? steps.dataset.next
      : event.key === "k"
        ? steps.dataset.previous
        : event.key === "u"
          ? steps.dataset.back
          : undefined;
  if (!to) return;
  event.preventDefault();
  window.location.assign(to);
});

// Focusing the Cases search with `/` (D07 T04 §15), as Gmail and GitHub do: only where the box is on the page,
// never while typing in a field or with a modifier, and the key stays text inside any editable control. The
// hint's Turn off button is the WCAG 2.1.4 off switch: the choice is kept in the browser and restored on load.
let slashMemory                 = null;
const slashOff = () => {
  if (slashMemory !== null) return slashMemory;
  try {
    return localStorage.getItem("iil-slash-search") === "off";
  } catch {
    return false;
  }
};
const drawSlashToggle = () => {
  const off = slashOff();
  for (const button of document.querySelectorAll                   ("[data-slash-toggle]")) {
    button.textContent = off ? "Turn on the / shortcut" : "Turn off the / shortcut";
  }
};
drawSlashToggle();
document.addEventListener("click", (event) => {
  const button = (event.target                  )?.closest                   ("[data-slash-toggle]");
  if (!button) return;
  slashMemory = !slashOff();
  try {
    localStorage.setItem("iil-slash-search", slashMemory ? "off" : "on");
  } catch {
    // A browser that refuses storage keeps the choice for this page in memory alone.
  }
  drawSlashToggle();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented)
    return;
  if (event.isComposing || slashOff()) return;
  const target = event.target                  ;
  if (target?.closest("input, textarea, select, [contenteditable]")) return;
  const box = document.querySelector                  ("#case-search");
  if (!box) return;
  event.preventDefault();
  box.focus();
});

// A page whose state changes at a known time (`data-reload-at`, epoch seconds: a lock that ends, D07 T04 §27) loads
// itself again then, a plain read of the same address, so what is drawn is what is stored. Without this script the page
// carries a "Check again" link for the same.
for (const marked of document.querySelectorAll             ("[data-reload-at]")) {
  const wait = Number(marked.dataset.reloadAt) * 1000 - Date.now();
  if (Number.isFinite(wait) && wait > 0 && wait < 3 * 60 * 60_000)
    setTimeout(() => window.location.reload(), wait + 500);
}

// The original message read in place (D07 T03 §19, board `Report-MessagePreview`): from a card's "View the original message"
// or "View complete headers" link (which, without this script, downloads the original) a native modal dialog with two tabs
// whose text comes from the artefact route's `view` mode as JSON and is drawn as text only: never the message's HTML, never
// a link. Each tab asks afresh and a response that arrives after the reader has left its tab (or closed the dialog) is
// dropped; Close and a new request abort the one before. Unavailable text, an empty body and an empty header list each say
// so, the gone, link-expired, signed-out and failed-read states are the viewer's, and every settled outcome is announced once.
                                          
                                                                                                    
const ORIGINAL_LINES                               = {
  message: "Plain text only: pictures, links and scripts in it were not loaded or run.",
  headers:
    "Every header as stored, in the order received. A result written into a header may be forged; the authentication check says which results were the receiving server's.",
};
const ORIGINAL_FOOT                               = {
  message: "Shown exactly as stored. Links are not clickable.",
  headers: "Shown exactly as stored.",
};
function openOriginal(opener                   ) {
  const start               = opener.dataset.originalView === "headers" ? "headers" : "message";
  const originalHref = opener.getAttribute("href") ?? "";
  const cardId = opener.closest             ("article")?.id ?? "";
  const viewHref = (part              ) => {
    const address = new URL(originalHref, window.location.href);
    address.searchParams.set("view", part);
    return address.pathname + address.search;
  };
  const dialog = make(
    "dialog",
    "m-auto flex max-h-[calc(100dvh-32px)] max-w-none w-[min(1100px,calc(100vw-32px))] max-md:h-dvh max-md:max-h-dvh max-md:w-screen flex-col overflow-hidden rounded-card border border-line bg-surface p-0 text-ink shadow-card backdrop:bg-ink/60",
  );
  dialog.setAttribute("data-original-viewer", "");
  const title = make("h2", "text-18 weight-text-strong m-0", "Original message");
  title.id = "original-viewer-title";
  const line = make("p", "type-small text-muted m-0 wrap-anywhere");
  line.id = "original-viewer-line";
  const close = make("button", BUTTON);
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.append(make("span", "", "Close"), make("span", "max-md:hidden text-13 text-muted", "Esc"));
  const heading = make("div", "min-w-0 flex-1");
  // A tighter line box than the body's: axe reads a wrapped line at the default height under the heading as partly
  // overlapped and cannot decide its contrast.
  line.className = "type-small text-muted m-0 mt-4 leading-[1.3] wrap-anywhere";
  heading.append(title, line);
  const head = make("div", "flex items-start justify-between gap-16 border-b border-line p-16");
  head.append(heading, close);
  const tabs = make("div", "flex gap-16 border-b border-line px-16");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Original message");
  const tabButtons = new Map                                 ();
  for (const [part, words] of [
    ["message", "Message"],
    ["headers", "Complete headers"],
  ]         ) {
    const tab = make(
      "button",
      "h-40 border-0 border-b-2 border-transparent bg-transparent px-4 text-15 text-ink-2 aria-selected:border-orange-text aria-selected:weight-text-strong aria-selected:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-text",
      words,
    );
    tab.type = "button";
    tab.id = `original-tab-${part}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "original-panel");
    tabButtons.set(part, tab);
    tabs.append(tab);
  }
  const panel = make("div", "flex min-h-0 flex-1 flex-col gap-8 overflow-hidden p-16");
  panel.id = "original-panel";
  panel.setAttribute("role", "tabpanel");
  const note = make("p", "type-small m-0 wrap-anywhere");
  note.hidden = true;
  const status = make("p", "type-small text-muted m-0 wrap-anywhere");
  const region = make(
    "div",
    "min-h-0 flex-1 overflow-auto rounded-control border border-line bg-subtle focus-visible:outline-2 focus-visible:outline-orange-text",
  );
  region.tabIndex = 0;
  region.setAttribute("role", "region");
  const pre = make("pre", "m-0 p-12 font-mono text-14 text-ink whitespace-pre-wrap break-words");
  pre.hidden = true;
  const failure = make("div", "flex flex-col items-start gap-8 p-16 text-14");
  failure.hidden = true;
  region.append(status, pre, failure);
  panel.append(note, region);
  const foot = make(
    "div",
    "flex flex-col gap-12 border-t border-line bg-surface p-16 md:flex-row md:items-center md:justify-between",
  );
  const footLine = make("p", "type-small text-muted m-0");
  const download = make(
    "a",
    "text-14 weight-text-strong text-orange-text underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-text",
    "Download the original (.eml)",
  );
  download.href = originalHref;
  download.setAttribute("rel", "noopener");
  foot.append(footLine, download);
  const live = make("p", "sr-only");
  live.setAttribute("role", "status");
  dialog.setAttribute("aria-labelledby", title.id);
  dialog.setAttribute("aria-describedby", line.id);
  dialog.append(head, tabs, panel, foot, live);

  let current               = start;
  let pending                         = null;
  const say = (words        ) => {
    live.textContent = "";
    setTimeout(() => {
      live.textContent = words;
    }, 30);
  };
  const settle = (words        ) => {
    status.textContent = "";
    status.hidden = true;
    say(words);
  };
  const GONE_WORDS                   = [
    "The original message is no longer stored.",
    "Originals are kept for 30 days. The findings above still stand, and the headers they cite are kept with them.",
  ];
  // A settled state with words: one of the viewer's failure kinds, the message's own "gone" words, or `none` (a text never
  // stored, an empty body or an empty header list: words given, no control).
  const showFailure = (
    part              ,
    kind                                    ,
    again         ,
    words                          ,
  ) => {
    // The words are the viewer's, except where they name a screenshot: this dialog is about the message.
    const own                                                    = {
      temporary: ["The original message could not be loaded.", null],
      "signed-out": ["You have been signed out.", "Sign in to read the original message."],
    };
    const [first, second] =
      words ??
      (kind === "original-gone" ? GONE_WORDS : kind === "none" ? ["", null] : (own[kind] ?? FAILURE_WORDS[kind]));
    const holds = again && document.activeElement === region;
    pre.hidden = true;
    note.hidden = true;
    failure.replaceChildren(make("p", "m-0 weight-text-strong wrap-anywhere", first));
    if (second) failure.append(make("p", "m-0 text-muted wrap-anywhere", second));
    let control                     = null;
    if (kind === "temporary") {
      const retry = make("button", BUTTON, "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => {
        region.focus();
        void show(part, true);
      });
      failure.append(retry);
      control = retry;
    }
    if (kind === "signed-out") {
      const signIn = make("a", BUTTON, "Sign in");
      signIn.href = signInHref(originalHref, cardId);
      failure.append(signIn);
      control = signIn;
    }
    failure.hidden = false;
    settle(second ? `${first} ${second}` : first);
    if (holds) control?.focus();
  };
  const show = async (part              , again = false) => {
    pending?.abort();
    const mine = new AbortController();
    pending = mine;
    current = part;
    // A request that neither answers nor fails would leave "Loading." for ever: after a deadline it is given up and the
    // retry state shows (15 seconds; `data-deadline-ms` on the link lets a test shorten it).
    let late = false;
    const deadline = setTimeout(() => {
      late = true;
      mine.abort();
    }, Number(opener.dataset.deadlineMs) || 15_000);
    for (const [name, tab] of tabButtons) {
      tab.setAttribute("aria-selected", String(name === part));
      tab.tabIndex = name === part ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", `original-tab-${part}`);
    region.setAttribute(
      "aria-label",
      part === "message" ? "The original message as text" : "The complete headers as text",
    );
    line.textContent = ORIGINAL_LINES[part];
    footLine.textContent = ORIGINAL_FOOT[part];
    failure.hidden = true;
    failure.replaceChildren();
    note.hidden = true;
    pre.hidden = true;
    pre.textContent = "";
    status.hidden = false;
    status.textContent = again ? "Loading again." : "Loading.";
    say(status.textContent);
    try {
      const answer = await fetch(viewHref(part), {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        signal: mine.signal,
      });
      if (mine.signal.aborted || !dialog.isConnected) return;
      if (!answer.ok) {
        void answer.body?.cancel();
        const kind = failureOf(answer);
        showFailure(part, kind === "gone" ? "original-gone" : kind, again);
        return;
      }
      const data = (await answer.json())                ;
      clearTimeout(deadline);
      if (mine.signal.aborted || !dialog.isConnected || current !== part) return;
      status.hidden = true;
      status.textContent = "";
      const words = part === "message" ? "message" : "headers";
      if (data.text === null) {
        showFailure(part, "none", false, [`The ${words} text was not stored.`, "Download the original to read it."]);
        return;
      }
      if (data.text === "") {
        // An HTML-only message whose visible text came out empty (images only, or all of it taken out) is not an empty
        // original: say what was taken out and leave the download as the way to it.
        showFailure(
          part,
          "none",
          false,
          data.source === "visible"
            ? [
                "No visible text remains in this message.",
                "This message has only an HTML version. Hidden text and instruction-like phrases are taken out of its visible text. Download the original to read it.",
              ]
            : [part === "message" ? "The message has no text." : "The message has no headers.", null],
        );
        return;
      }
      pre.textContent = data.text;
      pre.hidden = false;
      const notes           = [];
      if (data.source === "visible")
        notes.push(
          "This message has only an HTML version. This is its visible text, with hidden text and instruction-like phrases taken out.",
        );
      if (data.truncated)
        notes.push(
          "Showing the first 200 KB as plain text. The message is longer; download the original to read the rest.",
        );
      note.textContent = notes.join(" ");
      note.hidden = notes.length === 0;
      say(
        `${part === "message" ? "The message" : "The complete headers"} loaded.${notes.length ? ` ${notes.join(" ")}` : ""}`,
      );
    } catch {
      if ((late || !mine.signal.aborted) && dialog.isConnected && pending === mine)
        showFailure(part, "temporary", again);
    } finally {
      clearTimeout(deadline);
    }
  };
  for (const [part, tab] of tabButtons) {
    tab.addEventListener("click", () => void show(part));
    tab.addEventListener("keydown", (event) => {
      const order                 = ["message", "headers"];
      const at = order.indexOf(part);
      const next =
        event.key === "ArrowRight"
          ? order[(at + 1) % 2]
          : event.key === "ArrowLeft"
            ? order[(at + 1) % 2]
            : event.key === "Home"
              ? order[0]
              : event.key === "End"
                ? order[1]
                : undefined;
      if (!next) return;
      event.preventDefault();
      tabButtons.get(next)?.focus();
      void show(next);
    });
  }
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    pending?.abort();
    dialog.remove();
    document.documentElement.removeAttribute("data-evidence-viewing");
    opener.focus();
  });
  document.body.append(dialog);
  document.documentElement.setAttribute("data-evidence-viewing", "");
  dialog.showModal();
  void show(start);
  tabButtons.get(start)?.focus();
}
document.addEventListener("click", (event) => {
  const opener = (event.target                  )?.closest                   ("a[data-original-view]");
  if (!opener || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
    return;
  event.preventDefault();
  openOriginal(opener);
});

// A rate-limited sign-in state's button (D07 T02 §7, src/auth/confirm-page.tsx): held until the limit lifts
// (`data-retry-at`, epoch seconds), then given its plain words (`data-ready-label`) to repeat the same operation.
// Without this script the button is never held, and a press before then is refused again by the server.
for (const button of document.querySelectorAll                   ("button[data-retry-at]")) {
  const wait = Number(button.dataset.retryAt) * 1000 - Date.now();
  // Ready again, unless the same button also needs a box ticked that is not (the signup page's consent, below).
  const ready = () => {
    const box = button.dataset.needsConsent ? document.getElementById(button.dataset.needsConsent) : null;
    button.disabled = box instanceof HTMLInputElement && !box.checked;
    button.textContent = button.dataset.readyLabel ?? button.textContent;
    // The reason the hold was explained by (`data-ready-clear`, an id) is no longer true: it is emptied.
    const reason = button.dataset.readyClear ? document.getElementById(button.dataset.readyClear) : null;
    if (reason) reason.textContent = "";
    button.removeAttribute("aria-describedby");
  };
  if (wait <= 0) ready();
  else {
    button.disabled = true;
    setTimeout(ready, wait);
  }
}

// Signing in by a link (or code) lands with a short-lived `isitlegit_signed_in` cookie (src/auth/confirm.tsx): it is
// cleared, and the tabs of this browser are told which address is now signed in, so the tab that asked for the link can
// go on (below). The address is read from the session, never from the page. A browser without BroadcastChannel (Safari
// before 15.4) has none of this, and the tab that asked finds the session by asking instead.
const AUTH_CHANNEL = "isitlegit-auth";
const channel = ()                          => {
  try {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(AUTH_CHANNEL) : null;
  } catch {
    return null;
  }
};
                                                          
const sessionEmail = async ()                         => {
  const answer = await fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" });
  if (!answer.ok) throw new Error(`session ${answer.status}`);
  return ((await answer.json())                 )?.user?.email?.toLowerCase() ?? null;
};
if (/(?:^|;\s*)isitlegit_signed_in=1/.test(document.cookie)) {
  // biome-ignore lint/suspicious/noDocumentCookie: the signed-in marker cookie is the client shell's own flag, read and cleared here
  document.cookie = "isitlegit_signed_in=; Path=/; Max-Age=0; SameSite=Lax; Secure";
  sessionEmail()
    .then((email) => {
      if (email) channel()?.postMessage({ signedIn: email });
    })
    .catch(() => {});
}

// The "check your inbox" state (`data-signin-wait`, the address it asked for) goes on to the page asked for once this
// browser is signed in as that address: told by the tab the link opened, or found by asking for the session at once
// when the page is shown again and every 5 seconds while it is visible. Another address's session, already there or
// signed in elsewhere, leaves the page as it is.
const waiting = document.querySelector             ("[data-signin-wait]");
if (waiting) {
  const wanted = (waiting.dataset.signinWait ?? "").toLowerCase();
  const next = waiting.dataset.signinNext ?? "/cases";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const status = waiting.querySelector             ("[data-signin-status]");
    if (status) status.textContent = "Signed in. Opening your page.";
    location.assign(next);
  };
  // A word from another tab is only a cue to ask: the session as it is now decides, so a word that arrives late, after
  // another address signed in, cannot take this page on (round 1). Each ask is numbered, and an answer older than one
  // already seen is dropped, so a slow answer for this address cannot overrule a newer one for another (round 2).
  let asked = 0;
  let seen = 0;
  const ask = () => {
    const id = ++asked;
    sessionEmail()
      .then((email) => {
        if (done || id < seen) return;
        seen = id;
        if (email === wanted) finish();
      })
      .catch(() => {});
  };
  channel()?.addEventListener("message", (event              ) => {
    const email = (event.data                          )?.signedIn;
    if (typeof email === "string" && email.toLowerCase() === wanted && !done) ask();
  });
  const check = () => {
    if (done || document.visibilityState !== "visible") return;
    ask();
  };
  setInterval(check, 5000);
  document.addEventListener("visibilitychange", check);
}

// A shared invite code (`/signup?code=<code>`) is taken into the form and out of the address, so it is neither
// bookmarked nor left in the history (D07 T02 §13); without script the page still sends it to no other site.
if (document.querySelector("[data-drop-query]") && new URLSearchParams(location.search).has("code")) {
  const url = new URL(location.href);
  url.searchParams.delete("code");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

// A submit that needs a box ticked first (`data-needs-consent`, the box's id: the signup page's POPIA consent, D07 T02
// §13): held until the box is ticked, and again if it is unticked. Without this script the button is never held, and
// the server refuses the form without consent. A retry hold on the same button (`data-retry-at`) still holds it.
for (const button of document.querySelectorAll                   ("button[data-needs-consent]")) {
  const box = document.getElementById(button.dataset.needsConsent ?? "");
  if (!(box instanceof HTMLInputElement)) continue;
  const sync = () => {
    const retrying = Number(button.dataset.retryAt ?? 0) * 1000 > Date.now();
    button.disabled = !box.checked || retrying;
  };
  sync();
  box.addEventListener("change", sync);
}

// More findings (D07 T03 §3, `Report-Mobile`): the report's evidence beyond the cards its reasons cite sits in a
// `[data-more-findings]` disclosure, open as the page is sent so it reads whole without this script. Below `md`
// (48rem) it is closed; from `md` it is open, its summary hidden. A link to a card inside it (a direct `#e<n>`, or a
// pill followed) opens it and moves focus to the card.
// The disclosure is found afresh each time: a finished report's poll brings one in that the page did not load with, so
// it is fitted after every swap as it is on load, and a phone sees the same report by either way in.
const wide = window.matchMedia("(min-width: 48rem)");
const more = () => document.querySelector                    ("details[data-more-findings]");
// An open disclosure holding the focused control is left open, so a poll that moves a focused card into it never hides
// what the reader is on.
const fit = () => {
  const disclosure = more();
  if (!disclosure) return;
  if (!wide.matches && disclosure.open && disclosure.contains(document.activeElement)) return;
  disclosure.open = wide.matches;
};
const reveal = () => {
  const disclosure = more();
  const id = decodeURIComponent(location.hash.slice(1));
  const target = id ? document.getElementById(id) : null;
  if (!disclosure || !target || !disclosure.contains(target)) return;
  disclosure.open = true;
  target.scrollIntoView();
  target.focus();
};
fit();
reveal();
wide.addEventListener("change", fit);
window.addEventListener("hashchange", reveal);

// A row the address names (`/suppliers#<supplier id>`, D06 T01 §4, the report's ledger links of §6): the visible copy
// of it (the table row on a wide screen, the card on a narrow one, both `data-anchor-row`) is scrolled to and focused,
// so a keyboard or screen reader user lands on it. On opening, a notice already announced keeps the focus.
const anchored = (onOpen         ) => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const rows = [...document.querySelectorAll             ("[data-anchor-row]")].filter(
    (r) => r.dataset.anchorRow === id,
  );
  const row = rows.find((r) => r.offsetParent !== null);
  if (!row) return;
  if (onOpen && document.activeElement && document.activeElement !== document.body) return;
  row.scrollIntoView({ block: "center" });
  row.focus();
};
// On `load`: Chrome handles the address's fragment after this script has run, which would take back a focus given now.
window.addEventListener("load", () => anchored(true));
window.addEventListener("hashchange", () => anchored(false));
document.addEventListener("htmx:afterSwap", fit);

// After a region that answers in place is replaced (the feedback control, D07 T03 §6), focus goes where the answer
// says (`[data-focus]`: the saved state's Change, the first field in error, the choice when reopened), never back to the
// top of the page, and a saved answer is said once through the report's live region.
document.addEventListener("htmx:afterSwap", (event) => {
  const region =
    event.target instanceof Element && event.target.id === "feedback"
      ? event.target
      : document.getElementById("feedback");
  if (!region?.isConnected || !(event.target                  )?.closest?.("[data-swap-errors], #feedback")) return;
  region.querySelector             ("[data-focus]")?.focus();
  const said = region.querySelector             ("[data-saved]")?.textContent?.trim();
  const live = document.getElementById("report-announce");
  if (said && live) live.textContent = said;
});

// Passkey sign-in (D07 T02 §16). The sign-in pages draw the passkey option (`[data-passkey]`, carrying the return
// path) and its prompt (`[data-passkey-prompt]`) hidden; they are revealed here only when WebAuthn is there, in a
// secure context, so a page without this script offers the email route alone. One ceremony runs at a time: a second
// press or "Try the passkey again" aborts the first, "Email me a link instead" aborts it, and an answer that arrives for
// an aborted ceremony is dropped. Each request is bounded, so a stalled one ends in the retry state. A refusal for an
// expired challenge asks for new options once. Every other ending puts the page back with the email field focused and
// the reason said in the option's alert line.
const PASSKEY_STALL_MS = 15_000;
const OPTIONS_PATH = "/api/auth/passkey/generate-authenticate-options";
const VERIFY_PATH = "/api/auth/passkey/verify-authentication";

export function fromB64url(value        )              {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
export function toB64url(data                               )         {
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

                           
                    
                                                                           
                           
  
// Better Auth's options as WebAuthn takes them: the challenge and credential ids as bytes, as WebAuthn Level 3's
// `parseRequestOptionsFromJSON` does (used when the browser has it).
export function requestOptionsFromJSON(json                    )                                    {
  const native = (
    globalThis.PublicKeyCredential                                                                        
  )?.parseRequestOptionsFromJSON;
  if (typeof native === "function") return native(json)                                     ;
  return {
    ...json,
    challenge: fromB64url(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map((c) => ({ ...c, id: fromB64url(c.id) })),
  }                                     ;
}

                  
             
                     
               
                                          
             
                                
                                   
                           
                                   
    
                                            
  
// The browser's assertion as the JSON `verify-authentication` takes: every binary field base64url.
export function assertionToJSON(credential           ) {
  const r = credential.response;
  return {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      ...(r.userHandle ? { userHandle: toB64url(r.userHandle) } : {}),
    },
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  };
}

// What each ending says, in the member's words.
const PASSKEY_WORDS                         = {
  NotAllowedError:
    "No passkey was used. If this device has none, sign in with an email link, then add a passkey under Account.",
  USER_VERIFICATION_REQUIRED:
    "Your device was not unlocked. Use its PIN, fingerprint or face when it asks, or sign in with an email link.",
  PASSKEY_NOT_FOUND: "This passkey is no longer on your account; sign in with an email link.",
  AUTHENTICATION_FAILED: "That passkey could not be checked. Try the passkey again, or sign in with an email link.",
  TimeoutError: "Passkey sign-in took too long to answer. Try the passkey again, or sign in with an email link.",
  TypeError: "That did not reach us. Check your connection and try the passkey again.",
};
const PASSKEY_FAILED = "Passkey sign-in did not finish. Try the passkey again, or sign in with an email link.";
const passkeyWords = (code        ) =>
  Object.hasOwn(PASSKEY_WORDS, code) ? (PASSKEY_WORDS[code] ?? PASSKEY_FAILED) : PASSKEY_FAILED;

const passkeyOption = () => document.querySelector             ("[data-passkey]");
const passkeyPrompt = () => document.querySelector             ("[data-passkey-prompt]");
let ceremony                         = null;
const hiddenByPrompt                = [];

function promptShown(on         )       {
  const prompt = passkeyPrompt();
  if (!prompt?.parentElement) return;
  if (on) {
    for (const sibling of prompt.parentElement.children)
      if (sibling !== prompt && sibling instanceof HTMLElement && !sibling.hidden) {
        sibling.hidden = true;
        hiddenByPrompt.push(sibling);
      }
    prompt.hidden = false;
    const heading = prompt.querySelector             ("h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  } else {
    prompt.hidden = true;
    for (const sibling of hiddenByPrompt.splice(0)) sibling.hidden = false;
  }
}
function passkeyBusy(on         )       {
  for (const button of document.querySelectorAll             ("[data-passkey-start]"))
    on ? button.setAttribute("aria-busy", "true") : button.removeAttribute("aria-busy");
}
// The page back, on the email route, and the reason said (an empty reason clears the line). Focus goes to the email
// field; on a page without one (the invitation) to its link request; and where that request is held by the limit (the
// rate-limited state, its button disabled until the time it names) to the state's heading, whose sentence says when
// links can be sent again. Focus is never lost.
function passkeyEnded(reason        )       {
  ceremony = null;
  passkeyBusy(false);
  promptShown(false);
  const line = passkeyOption()?.querySelector             ("[data-passkey-message]");
  if (line) line.textContent = reason;
  // However the ceremony ended without signing in (a refusal, a cancellation, or the switch to the email
  // route), the troubleshooting note stays reachable beside the retry and the email route (D07 T02 §28).
  const help = passkeyOption()?.querySelector             ("[data-passkey-help]");
  if (help) help.hidden = false;
  const request = document.querySelector                   ('form[action="/signin/link"] button[type=submit]');
  const heading = passkeyOption()?.closest("section")?.querySelector             ("h1");
  if (heading) heading.tabIndex = -1;
  const target =
    document.querySelector             ("input[type=email]") ?? (request && !request.disabled ? request : heading);
  target?.focus();
}
const bounded = (own                 ) => AbortSignal.any([own.signal, AbortSignal.timeout(PASSKEY_STALL_MS)]);

async function passkeySignIn()                {
  const option = passkeyOption();
  if (!option) return;
  ceremony?.abort();
  const own = new AbortController();
  ceremony = own;
  const live = () => ceremony === own;
  passkeyBusy(true);
  const staleHelp = option.querySelector             ("[data-passkey-help]");
  if (staleHelp) staleHelp.hidden = true;
  promptShown(true);
  try {
    for (let renewed = false; ; renewed = true) {
      const options = await fetch(OPTIONS_PATH, { credentials: "same-origin", signal: bounded(own) });
      if (!live()) return;
      if (!options.ok) return passkeyEnded(PASSKEY_FAILED);
      const json = (await options.json())                      ;
      const credential = (await navigator.credentials.get({
        publicKey: requestOptionsFromJSON(json),
        signal: own.signal,
      }))                               ;
      if (!live()) return;
      if (!credential) return passkeyEnded(passkeyWords("NotAllowedError"));
      const answer = await fetch(VERIFY_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: assertionToJSON(credential) }),
        signal: bounded(own),
      });
      if (!live()) return;
      if (answer.ok) {
        ceremony = null;
        window.location.assign(option.dataset.passkey || "/cases");
        return;
      }
      const code = ((await answer.json().catch(() => ({})))                      ).code;
      if (!live()) return;
      if (code === "CHALLENGE_NOT_FOUND" && !renewed) continue;
      return passkeyEnded(passkeyWords(typeof code === "string" ? code : ""));
    }
  } catch (error) {
    if (!live()) return;
    passkeyEnded(passkeyWords(error instanceof Error ? error.name : ""));
  }
}

if (typeof PublicKeyCredential === "function" && window.isSecureContext)
  for (const option of document.querySelectorAll             ("[data-passkey]")) option.hidden = false;
document.addEventListener("click", (event) => {
  const target = event.target                  ;
  if (target?.closest?.("[data-passkey-start]")) {
    event.preventDefault();
    void passkeySignIn();
  } else if (target?.closest?.("[data-passkey-email]")) {
    event.preventDefault();
    ceremony?.abort();
    ceremony = null;
    passkeyEnded("");
  }
});

// Adding a passkey from the Account page (D07 T08 §14). `[data-passkey-add]` is drawn hidden and revealed here only
// where WebAuthn is (its "needs a browser that supports passkeys" line is hidden then). One ceremony at a time: while one
// is under way the control is held busy and a second press starts nothing. Better Auth's registration options and
// verifier are used as they are. A saved passkey goes to its naming page. An answer that never came after the response
// was sent is not retried: the page is opened on what is stored (`reconcile=add`, with the credential the device made),
// so an add that succeeded is not registered twice and a passkey added meanwhile is never taken for it. Progress is said
// at once ("Waiting for your device", then "Saving your passkey") in a status line.
const REGISTER_OPTIONS_PATH = "/api/auth/passkey/generate-register-options";
const REGISTER_VERIFY_PATH = "/api/auth/passkey/verify-registration";
const ACCOUNT_PATH = "/settings/account";

                            
                    
                                                          
                                                                             
                           
  
// Better Auth's options as WebAuthn takes them: the challenge, the user handle and the excluded credential ids as bytes.
export function creationOptionsFromJSON(json                     )                                     {
  const native = (
    globalThis.PublicKeyCredential                                                                         
  )?.parseCreationOptionsFromJSON;
  if (typeof native === "function") return native(json)                                      ;
  return {
    ...json,
    challenge: fromB64url(json.challenge),
    user: { ...json.user, id: fromB64url(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((c) => ({ ...c, id: fromB64url(c.id) })),
  }                                                 ;
}

                    
             
                     
               
                                          
                                                                                                            
                                            
                         
  
// The browser's new credential as the JSON `verify-registration` takes: every binary field base64url.
export function attestationToJSON(credential             ) {
  if (typeof credential.toJSON === "function") return credential.toJSON();
  const r = credential.response;
  return {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      attestationObject: toB64url(r.attestationObject),
      ...(r.getTransports ? { transports: r.getTransports() } : {}),
    },
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  };
}

const ADD_FAILED =
  "The passkey could not be added and nothing was saved. Try again, or keep signing in with an email link.";
const ADD_WORDS                         = {
  NotAllowedError: "No passkey was added: the prompt was cancelled or timed out. Press Add a passkey to try again.",
  USER_VERIFICATION_REQUIRED:
    "Your device was not unlocked, so no passkey was added. Use its PIN, fingerprint or face when it asks, then try again.",
  InvalidStateError: "This device already has a passkey for your account. Nothing was added.",
  ALREADY_REGISTERED: "This device already has a passkey for your account. Nothing was added.",
  OPTIONS: "We could not start adding a passkey. Check your connection and try again.",
  SESSION_NOT_FRESH:
    "For your security, adding a passkey needs a recent sign-in, and yours is older than a day. Nothing was added.",
  TimeoutError: "Adding the passkey took too long to answer, and nothing was saved. Try again.",
};
const addWords = (code        ) => (Object.hasOwn(ADD_WORDS, code) ? (ADD_WORDS[code] ?? ADD_FAILED) : ADD_FAILED);
let adding                         = null;

const addStatus = (text        ) => {
  const status = document.querySelector             ("[data-passkey-add-status]");
  if (status) status.textContent = text;
};

function addEnded(button             , reason        , signIn = false)       {
  adding = null;
  button.removeAttribute("aria-busy");
  addStatus("");
  const line = document.querySelector             ("[data-passkey-add-message]");
  if (!line) return;
  line.textContent = reason;
  if (signIn) {
    // The session is valid but older than the day Better Auth allows for adding a passkey: a new sign-in makes it fresh.
    const link = document.createElement("a");
    link.href = `/signin?next=${encodeURIComponent(ACCOUNT_PATH)}`;
    link.className = "underline text-orange-text";
    link.textContent = "Sign in again";
    line.append(" ", link);
  }
  line.tabIndex = -1;
  line.focus();
}

async function passkeyAdd(button             )                {
  if (adding) return;
  const own = new AbortController();
  adding = own;
  button.setAttribute("aria-busy", "true");
  const line = document.querySelector             ("[data-passkey-add-message]");
  if (line) line.textContent = "";
  addStatus("Waiting for your device…");
  // The credential the device made, once the response has left: from then on a lost answer is reconciled, never retried.
  let sent                = null;
  try {
    for (let renewed = false; ; renewed = true) {
      const options = await fetch(REGISTER_OPTIONS_PATH, { credentials: "same-origin", signal: bounded(own) });
      if (options.status === 401)
        return void window.location.assign(`/signin?next=${encodeURIComponent(ACCOUNT_PATH)}`);
      if (options.status === 403) {
        const refused = (await options.json().catch(() => ({})))                      ;
        if (refused.code === "SESSION_NOT_FRESH") return addEnded(button, addWords("SESSION_NOT_FRESH"), true);
      }
      if (!options.ok) return addEnded(button, addWords("OPTIONS"));
      const credential = (await navigator.credentials.create({
        publicKey: creationOptionsFromJSON((await options.json())                       ),
        signal: own.signal,
      }))                                 ;
      if (!credential) return addEnded(button, addWords("NotAllowedError"));
      sent = credential.id;
      addStatus("Saving your passkey…");
      const answer = await fetch(REGISTER_VERIFY_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: attestationToJSON(credential) }),
        signal: bounded(own),
      });
      if (answer.status === 401) return void window.location.assign(`/signin?next=${encodeURIComponent(ACCOUNT_PATH)}`);
      if (answer.ok) {
        const saved = (await answer.json())                    ;
        if (typeof saved.id !== "string") throw new Error("lost");
        adding = null;
        return void window.location.assign(`${ACCOUNT_PATH}/passkeys/${encodeURIComponent(saved.id)}/rename?added=1`);
      }
      // A server error may have come after the passkey was saved: it is read back, never taken for "nothing was saved".
      if (answer.status >= 500) throw new Error("unconfirmed");
      sent = null;
      const body = (await answer.json().catch(() => ({})))                                         ;
      if (body.code === "CHALLENGE_NOT_FOUND" && !renewed) continue;
      if (body.code === "SESSION_NOT_FRESH") return addEnded(button, addWords("SESSION_NOT_FRESH"), true);
      const code =
        typeof body.code === "string"
          ? body.code
          : typeof body.message === "string" && body.message.includes("already registered")
            ? "ALREADY_REGISTERED"
            : "";
      return addEnded(button, addWords(code));
    }
  } catch (error) {
    if (sent) {
      // The response was sent and its answer never came: look at what is stored before anything is tried again.
      adding = null;
      return void window.location.assign(`${ACCOUNT_PATH}?reconcile=add&cred=${encodeURIComponent(sent)}`);
    }
    addEnded(button, addWords(error instanceof Error ? error.name : ""));
  }
}
if (typeof PublicKeyCredential === "function" && window.isSecureContext) {
  for (const button of document.querySelectorAll             ("[data-passkey-add]")) button.hidden = false;
  for (const note of document.querySelectorAll             ("[data-passkey-add-unavailable]")) note.hidden = true;
}
document.addEventListener("click", (event) => {
  const button = (event.target                  )?.closest?.             ("[data-passkey-add]");
  if (!button) return;
  event.preventDefault();
  void passkeyAdd(button);
});

// The counts-export period fields (D07 T04 §19) survive the stats panel's own redraws: their values are kept
// in sessionStorage and restored after a swap, and clearing both clears the stored pair.
const restoreExportDates = () => {
  try {
    const from = document.querySelector                  ("#case-export-from");
    const to = document.querySelector                  ("#case-export-to");
    if (from && !from.value) from.value = sessionStorage.getItem("iil-export-from") ?? "";
    if (to && !to.value) to.value = sessionStorage.getItem("iil-export-to") ?? "";
  } catch {
    // Storage refused: the fields simply start empty.
  }
};
restoreExportDates();
document.addEventListener("htmx:afterSwap", restoreExportDates);
document.addEventListener("change", (event) => {
  const field = event.target                           ;
  if (field?.id !== "case-export-from" && field?.id !== "case-export-to") return;
  try {
    const from = document.querySelector                  ("#case-export-from")?.value ?? "";
    const to = document.querySelector                  ("#case-export-to")?.value ?? "";
    if (!from && !to) {
      sessionStorage.removeItem("iil-export-from");
      sessionStorage.removeItem("iil-export-to");
    } else {
      sessionStorage.setItem("iil-export-from", from);
      sessionStorage.setItem("iil-export-to", to);
    }
  } catch {
    // Storage refused: nothing to restore later.
  }
});
