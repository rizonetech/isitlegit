// Parked, for-sale and empty pages are recorded as parked and screened by no model (D05 T04 §3, correction 4), since a
// lookalike domain that only shows its registrar's sales page is no lure and each model call costs money. The rules are
// narrow on purpose: a page is parked only when its text shows no sign of a form, so a lure that says "for sale" beside a
// login form, a long page that mentions a sale, or one that hides its words in an image is still screened.

export const PARKED_MAX_TEXT = 2_000;
export const EMPTY_MAX_TEXT = 40;
export const EMPTY_MAX_SCREENSHOT = 10_000;

// Words that mean the page asks for something: credentials, a card or a payment. Any one sends the page to the screener.
const FORM_WORDS =
  /\b(?:password|passcode|username|sign[ -]?in|log[ -]?in|login|card number|cvv|cvc|expiry|pay(?:ment|ments|\s+now)?|account number|bank(?:ing)?|one[- ]time|otp|verify your|pin)\b/i;

// What parking and sale pages say: the parking services' names and the registrars' own wording.
const MARKERS: [string, RegExp][] = [
  ["sedo", /\bsedo(?:\.com)?\b/i],
  ["afternic", /\bafternic\b/i],
  ["hugedomains", /\bhugedomains\b/i],
  ["dan.com", /\bdan\.com\b/i],
  ["parkingcrew", /\bparking\s?crew\b/i],
  ["bodis", /\bbodis\b/i],
  ["for-sale", /\b(?:this|the)\s+domain\s+(?:name\s+)?(?:is|may be|might be|could be)\s+(?:for\s+sale|available)\b/i],
  ["buy-this-domain", /\bbuy\s+this\s+domain\b/i],
  [
    "domain-parking",
    /\bdomain\s+(?:is\s+)?parked\b|\bparked\s+(?:free\s+)?(?:domain|page)\b|\bthis\s+(?:web\s?)?page\s+is\s+parked\b/i,
  ],
  [
    "registrar",
    /\b(?:domain\s+(?:has\s+)?expired|renew(?:ed)?\s+this\s+domain|registered\s+(?:at|with|by)\s+\w+[\w .-]*\s+and\s+is\s+(?:currently\s+)?parked)\b/i,
  ],
];

export type Parked = { parked: true; reason: string } | { parked: false };

// What the browser counted on the page when it was captured (D05 T04 §3, correction 10): `innerText` cannot show a form
// whose labels are images or placeholders, nor one in a shadow root; the page's elements can.
export type Signals = { inputs: number; passwords: number; forms: number; iframes: number; components: number };

// Text beside a screenshot this big is a page that says little in words and much in pictures: screened, never parked.
export const IMAGE_LED_MAX_TEXT = 400;
export const IMAGE_LED_MIN_SCREENSHOT = 100_000;

// Whether a captured page is parked: its visible text, the browser's signals and the byte size of its screenshot. Any
// doubt screens it: no signals (a capture made before they were taken), an input, a form or a frame, a form word, or
// an image-led page.
export function parkedPage(text: string, signals: Signals | null, screenshotBytes: number): Parked {
  if (!signals) return { parked: false };
  // A component is a custom element, whose shadow root the counts may not have reached: any is a doubt, so it screens.
  if (signals.inputs > 0 || signals.passwords > 0 || signals.forms > 0 || signals.iframes > 0 || signals.components > 0)
    return { parked: false };
  const visible = text.replace(/\s+/g, " ").trim();
  if (FORM_WORDS.test(visible)) return { parked: false };
  if (visible.length < IMAGE_LED_MAX_TEXT && screenshotBytes >= IMAGE_LED_MIN_SCREENSHOT) return { parked: false };
  // A known marker names the reason; failing that, a page with next to nothing on it is empty.
  if (visible.length < PARKED_MAX_TEXT)
    for (const [name, pattern] of MARKERS) if (pattern.test(visible)) return { parked: true, reason: name };
  if (visible.length < EMPTY_MAX_TEXT && screenshotBytes < EMPTY_MAX_SCREENSHOT)
    return { parked: true, reason: "empty" };
  return { parked: false };
}
