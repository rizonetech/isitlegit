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

export {};
