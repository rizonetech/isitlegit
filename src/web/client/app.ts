// The app script (D07 T01 §9): the little behaviour server-rendered pages need beyond htmx, loaded on every page by
// `Document` as a module (deferred, after the page is parsed). Built by scripts/hash-asset.ts with Node's type stripping,
// so it keeps to erasable syntax and imports nothing.
//
// Copy: a `[data-copy]` button writes its value to the clipboard and says so in its group's status line (a
// `[data-copy-status]` beside it, visible and announced politely), "Copied" for 4 seconds; when the clipboard refuses
// (no permission, an insecure context, no Clipboard API) it says how to copy by hand and selects the address shown
// beside the button (`[data-copy-source]`). A button with no status line beside it announces through one hidden region.

const CLEAR_AFTER_MS = 4000;
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
  // A new press starts again: the line is emptied first, so the same message is announced afresh.
  say(region, "", false);
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error("no clipboard");
    await navigator.clipboard.writeText(value);
    say(region, COPIED, true);
  } catch {
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

export {};
