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

let fallbackRegion: HTMLElement | null = null;

// The status line of a button's copy group, or the page's one hidden region when the group has none.
function statusFor(button: Element): HTMLElement {
  const own = button.parentElement?.closest("[data-copy-group]")?.querySelector<HTMLElement>("[data-copy-status]");
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

const timers = new WeakMap<HTMLElement, number>();

function say(region: HTMLElement, text: string, clear: boolean): void {
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
function selectSource(button: Element): void {
  const source = button.parentElement?.closest("[data-copy-group]")?.querySelector("[data-copy-source]");
  const selection = window.getSelection();
  if (!source || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(source);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copy(button: HTMLElement): Promise<void> {
  const value = button.dataset.copy ?? "";
  const region = statusFor(button);
  // A new press starts again: the line is emptied first, and the outcome written in a later task, so the same message
  // twice running is announced twice.
  say(region, "", false);
  const emptied = new Promise((done) => window.setTimeout(done, ANNOUNCE_GAP_MS));
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error("no clipboard");
    await navigator.clipboard.writeText(value);
    await emptied;
    say(region, COPIED, true);
  } catch {
    await emptied;
    say(region, FAILED, false);
    selectSource(button);
  }
}

document.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLElement>("[data-copy]");
  if (!button || button.matches(":disabled, [aria-disabled='true']")) return;
  event.preventDefault();
  void copy(button);
});

// A results request (the Cases list's filters and pager, D07 T04 §1) that fails, cannot be sent, or ends somewhere else
// (an expired session sent to sign in) is not drawn into the page: the address is loaded as a whole page instead, so
// the reader meets the sign-in, 403 or 503 page as a page, and its Try again keeps the filters.
type HtmxDetail = {
  xhr?: XMLHttpRequest;
  pathInfo?: { requestPath?: string; finalRequestPath?: string };
  shouldSwap?: boolean;
};
const asked = (detail: HtmxDetail) =>
  detail.pathInfo?.finalRequestPath ?? detail.pathInfo?.requestPath ?? location.href;
for (const name of ["htmx:responseError", "htmx:sendError"])
  document.addEventListener(name, (event) => {
    location.assign(asked((event as CustomEvent<HtmxDetail>).detail));
  });
document.addEventListener("htmx:beforeSwap", (event) => {
  const detail = (event as CustomEvent<HtmxDetail>).detail;
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
  const button = form.querySelector<HTMLButtonElement>("button[type=submit][data-busy-label]");
  if (!button) return;
  const label = button.textContent;
  // The busy words are also said in a polite status region of the form's own, since a button's new words alone are
  // not announced (D07 T02 §7).
  let status = form.querySelector<HTMLElement>("[data-busy-status]");
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
  // answered, the button is itself again and the form can be sent.
  setTimeout(() => {
    delete form.dataset.sent;
    if (status) status.textContent = "";
    form.querySelector("[data-busy-check-link]")?.remove();
    button.textContent = label;
    // Usable again, unless another hold still applies: a box it needs that is unticked (the signup page's consent).
    const box = button.dataset.needsConsent ? document.getElementById(button.dataset.needsConsent) : null;
    button.disabled = box instanceof HTMLInputElement && !box.checked;
    button.removeAttribute("aria-busy");
  }, Number(form.dataset.busyMs) || BUSY_MS);
});

// A rate-limited sign-in state's button (D07 T02 §7, src/auth/confirm-page.tsx): held until the limit lifts
// (`data-retry-at`, epoch seconds), then given its plain words (`data-ready-label`) to repeat the same operation.
// Without this script the button is never held, and a press before then is refused again by the server.
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-retry-at]")) {
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
const channel = (): BroadcastChannel | null => {
  try {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(AUTH_CHANNEL) : null;
  } catch {
    return null;
  }
};
type SessionAnswer = { user?: { email?: string } } | null;
const sessionEmail = async (): Promise<string | null> => {
  const answer = await fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" });
  if (!answer.ok) throw new Error(`session ${answer.status}`);
  return ((await answer.json()) as SessionAnswer)?.user?.email?.toLowerCase() ?? null;
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
const waiting = document.querySelector<HTMLElement>("[data-signin-wait]");
if (waiting) {
  const wanted = (waiting.dataset.signinWait ?? "").toLowerCase();
  const next = waiting.dataset.signinNext ?? "/cases";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const status = waiting.querySelector<HTMLElement>("[data-signin-status]");
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
  channel()?.addEventListener("message", (event: MessageEvent) => {
    const email = (event.data as { signedIn?: unknown })?.signedIn;
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
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-needs-consent]")) {
  const box = document.getElementById(button.dataset.needsConsent ?? "");
  if (!(box instanceof HTMLInputElement)) continue;
  const sync = () => {
    const retrying = Number(button.dataset.retryAt ?? 0) * 1000 > Date.now();
    button.disabled = !box.checked || retrying;
  };
  sync();
  box.addEventListener("change", sync);
}

export {};
