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
  const form = region.querySelector("form");
  if (!form) return true;
  let line = form.querySelector             ("[data-not-reached]");
  if (!line) {
    line = document.createElement("p");
    line.dataset.notReached = "";
    line.setAttribute("role", "alert");
    line.className = "text-14 text-mal weight-text-strong";
    form.querySelector("button[type=submit]")?.before(line);
  }
  line.textContent = NOT_REACHED;
  form.dispatchEvent(new Event("busy:release"));
  return true;
};
for (const name of ["htmx:responseError", "htmx:sendError", "htmx:timeout"])
  document.addEventListener(name, (event) => {
    if (polled(event)) return stale(true);
    if (ownFailure(event)) return;
    if (name === "htmx:timeout") return;
    location.assign(asked((event                           ).detail));
  });

// Each change of a running report is said once through the live region outside the polled one: the step that started,
// then the outcome; an unchanged poll says nothing, and the page as loaded says nothing either.
// After an outage the region said the progress was stale, so the first poll to answer says where things stand again,
// changed or not.
let said = document.getElementById("report-live")?.dataset.announce ?? "";
document.addEventListener("htmx:afterSwap", () => {
  const live = document.getElementById("report-live");
  if (!live) return;
  const recovered = document.getElementById("report-stale") !== null;
  stale(false);
  const words = live.dataset.announce ?? "";
  const region = document.getElementById("report-announce");
  if (words && (words !== said || recovered) && region) region.textContent = words;
  said = words;
});
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

// After the Cases list's pager redraws the results (D07 T04 §1), focus stays where the reader was: htmx returns it to the
// end pressed, by its id; when that end is now disabled (the first or last page), to the other end.
document.addEventListener("htmx:afterSettle", () => {
  if (document.activeElement && document.activeElement !== document.body) return;
  const ends = ["case-next", "case-previous"].map((id) => document.getElementById(id));
  const enabled = ends.find((end) => end instanceof HTMLAnchorElement);
  enabled?.focus();
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
const announced = document.querySelector             ("[data-announce], [data-announce-scope] [aria-invalid='true']");
if (announced && (document.activeElement === document.body || !document.activeElement)) announced.focus();

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
  if (!region || !region.isConnected || !(event.target                  )?.closest?.("[data-swap-errors], #feedback"))
    return;
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
