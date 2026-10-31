// Redaction of sample mail before anything is rendered or stored (D03 T04 §7): the pilot client's people and numbers
// are replaced with fixed placeholders in the HTML itself, so the screenshot shows the placeholders too. Brand names
// and link host names stay, because they are what Loupe learns from.
//
// Names come from the recipient headers (To, Cc, Delivered-To: the client's people) and `samples/client-names.txt`,
// never from the sender: a phishing sender's display name is the brand it fakes. Every image is replaced by a blank
// box before the render (`stripImages`): a signature image or a personalised attachment can carry what no text rule
// sees, so no picture from a sample reaches a screenshot.

import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const PLACEHOLDER = {
  email: "[email]",
  name: "[name]",
  domain: "[domain]",
  phone: "[phone]",
  number: "[number]",
  address: "[address]",
} as const;

// Mailbox roles, not people: `accounts@`, `Accounts Payable`. Taking them for names would redact `accounts.google.com`
// and `Google Accounts` out of the very lures Loupe learns from.
const ROLE_WORDS = new Set(
  "accounts account payable receivable info admin administrator support sales billing noreply reply office reception finance hr enquiries enquiry contact hello team mail email service services help orders order invoices invoice accounting marketing helpdesk security notifications notification alerts news newsletter postmaster webmaster mailer daemon bookings booking careers jobs legal compliance procurement purchasing payroll credit debtors creditors operations dispatch logistics user users staff general".split(
    " ",
  ),
);

// Words a display name carries that name no one: articles, joining and other common English words, titles, company
// forms and surname particles (`van der Merwe` is redacted by `Merwe`; `van` alone is every delivery van). Taken for
// names, they would refuse almost every page. A name that is also a common word (`May`) is left to the surname with it.
const NOT_NAMES = new Set(
  "the and for from with our your his her its of to at on in by an a or mr mrs ms miss dr prof sir madam pty ltd inc llc plc cc sa co corp company group holdings van der den de du le la von da di dos das el al bin ibn all any are but can did does get got has had have how let may new not now off one out own see she they this that than then them there these those too two was way were what when where which who why will yet you also back been best both came come each even ever every free here into just keep last like live long look made make many more most much must need next only open over part plus said same seen send show some soon such sure take tell thank thanks very want well went work year com net org gov edu www http https html htm mail gmail googlemail outlook hotmail yahoo icloud za uk".split(
    " ",
  ),
);

// A recipient's name pieces: the display name's words (a capitalised two-letter name such as `Jo` included) and the
// address's local part split at dots, dashes and underscores (three letters or more), mailbox roles left out.
export function namePieces(display: string | undefined, address: string | undefined): string[] {
  const local = (address ?? "").split("@")[0] ?? "";
  // A display name that is itself an address or a domain names no one: its words are web words (`com`, `www`), and the
  // address's own rules cover it. A hyphenated name counts whole and by its parts (`Anne-Marie`, `Anne`, `Marie`).
  const named = /@|^\S+\.[a-z]{2,}$|https?:|www\./i.test((display ?? "").trim()) ? "" : (display ?? "");
  const words = named
    .split(/[\s,."'()]+/)
    .flatMap((word) => (word.includes("-") ? [word, ...word.split("-")] : [word]));
  const shown = words.filter((piece) => /^(\p{L}{3,}(-\p{L}+)*|\p{Lu}\p{Ll})$/u.test(piece));
  const parts = local.split(/[._\-+0-9]+/).filter((piece) => /^\p{L}{3,}$/u.test(piece));
  // The whole display name too, as a phrase: a name made of common words (`May Long`) is still the reader's name.
  const whole = named.trim().replace(/\s+/g, " ");
  const role = whole.split(" ").some((word) => ROLE_WORDS.has(word.toLowerCase()));
  const phrase = !role && /^\p{L}[\p{L}'-]*( \p{L}[\p{L}'-]*)+$/u.test(whole) ? [whole] : [];
  return [...phrase, ...shown, ...parts].filter(
    (piece) => !ROLE_WORDS.has(piece.toLowerCase()) && !NOT_NAMES.has(piece.toLowerCase()),
  );
}

export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// South African numbers (+27 or 0, then nine digits grouped by spaces, dashes, dots or slashes, the area code in brackets
// too) and other international numbers.
export const PHONE =
  /\(0\d{2}\)[\s./-]?\d{3}[\s./-]?\d{4}\b|(?:\+27|\b0)[\s./-]?\d{2}[\s./-]?\d{3}[\s./-]?\d{4}\b|\+\d{1,3}[\s./-]?\(?\d{1,4}\)?(?:[\s./-]?\d{2,4}){2,4}\b/g;
// Nine or more digits in a run (single spaces, non-breaking spaces, dots, slashes or dashes allowed between): South African account numbers (9 to 11
// digits), ID numbers (13) and card numbers (13 to 19). Eight stops short, so a date like 2026-10-31 stays.
export const LONG_NUMBER = /\b\d(?:[ \u00A0\u202F./-]?\d){8,}\b/g;
const DATA_URI = /data:[^"')\s>]+/g;
const URL = /\b(?:https?:\/\/|www\.)[^\s"'<>()]+/gi;
// Characters that hide inside a word without showing: a soft hyphen or a zero-width space splits `Tha­ndi` for a
// text rule while the render shows `Thandi`.
const INVISIBLE = /[­​-‍⁠﻿]/g;
const LETTER_ENTITIES: Record<string, string> = {
  aacute: "á",
  agrave: "à",
  acirc: "â",
  auml: "ä",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  iacute: "í",
  iuml: "ï",
  oacute: "ó",
  ocirc: "ô",
  ouml: "ö",
  uacute: "ú",
  uuml: "ü",
  ccedil: "ç",
  ntilde: "ñ",
};

// Letters from other scripts that look like Latin ones, and full-width forms: a name written `Thаndi` with a Cyrillic
// `а` reads as Thandi on the screen and to an OCR engine, but no Latin rule matches it.
const LOOKALIKE: Record<string, string> = Object.fromEntries(
  [
    ...("аaеeоoрpсcуyхxіiјjѕsԁdһhӏlոnԛqԝwАAВBЕEЅSІIЈJКKМMНHОOРPСCТTХXУYΑAΒBΕEΖZΗHΙIΚKΜMΝNΟOΡPΤTΥYΧXοoαaρpνvτtιiκkυuχx".match(
      /../gu,
    ) ?? []),
  ].map((pair) => [...pair] as [string, string]),
);

// `text` with every look-alike letter and full-width form folded to its Latin or ASCII twin, one character for one
// character, so a match found in it is the same span of `text`.
export function skeleton(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const folded = LOOKALIKE[char] ?? (code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : char);
    // Only a fold that keeps the length (one UTF-16 unit for one) keeps spans aligned.
    out += folded.length === char.length ? folded : char;
  }
  return out;
}

// Every match of `rule` in the folded text replaced, in the original, by `placeholder`.
function replaceFolded(text: string, rule: RegExp, placeholder: string): string {
  const folded = skeleton(text);
  let out = "";
  let from = 0;
  for (const match of folded.matchAll(
    new RegExp(rule.source, rule.flags.includes("g") ? rule.flags : `${rule.flags}g`),
  )) {
    out += text.slice(from, match.index) + placeholder;
    from = (match.index ?? 0) + match[0].length;
  }
  return out + text.slice(from);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One rule for a list of terms, each a whole word (no letter or digit beside it), longest first; null for none.
function termRule(terms: Iterable<string>): RegExp | null {
  const unique = [...new Set([...terms].map((n) => n.trim()).filter((n) => n.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  return unique.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${unique.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "giu")
    : null;
}

// Every match of `rule` replaced by `placeholder` outside the URLs in `text`: a lure's link host stays.
function outsideUrls(text: string, rule: RegExp, placeholder: string): string {
  let out = "";
  let from = 0;
  for (const url of text.matchAll(URL)) {
    out += replaceFolded(text.slice(from, url.index), rule, placeholder) + url[0];
    from = (url.index ?? 0) + url[0].length;
  }
  return out + replaceFolded(text.slice(from), rule, placeholder);
}

// Character references written for what is plain text (`Th&#97;ndi`, `&eacute;`) read as the characters they render
// as, so a rule sees what the viewer sees. The markup's own (`&lt;`, `&amp;`, quotes) are kept.
export function decodeTextEntities(html: string): string {
  return html
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (whole, code: string) => {
      const point = code[0] === "x" || code[0] === "X" ? Number.parseInt(code.slice(1), 16) : Number(code);
      if (!Number.isFinite(point) || point < 0x20 || point > 0x10ffff) return whole;
      const char = String.fromCodePoint(point);
      return /[<>&"']/.test(char) ? whole : char;
    })
    .replace(/&([a-z]+);/gi, (whole, name: string) => {
      if (name.toLowerCase() === "nbsp") return "\u00A0";
      const lower = LETTER_ENTITIES[name.toLowerCase()];
      if (!lower) return whole;
      return name[0] === name[0]?.toUpperCase() ? lower.toUpperCase() : lower;
    })
    .replace(INVISIBLE, "");
}

const IMAGE_TAG = /<(?:img|image|object|embed|picture|source|video|audio|input\s[^>]*type\s*=\s*["']?image)\b[^>]*>/gi;

// CSS escapes read as what they stand for (`\\75rl` is `url`, `\\3a ` is `:`), in every style block and attribute, so
// the picture rules see the CSS the browser will read (CSS Syntax 3, section 4.3.7).
export function unescapeCss(html: string): string {
  const decode = (css: string) =>
    css.replace(/\\([0-9a-f]{1,6})[ \t\r\n\f]?|\\([^\r\n\f0-9a-f])/gi, (_m, hex: string, char: string) => {
      if (char !== undefined) return char;
      const point = Number.parseInt(hex, 16);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : "\uFFFD";
    });
  return html
    .replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
      (_m, open: string, css: string, close: string) => open + decode(css) + close,
    )
    .replace(/(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi, (_m, name: string, _q: string, dq?: string, sq?: string) =>
      dq !== undefined ? `${name}"${decode(dq)}"` : `${name}'${decode(sq ?? "")}'`,
    )
    .replace(/(\sstyle\s*=\s*)([^\s"'>][^\s>]*)/gi, (_m, name: string, bare: string) => `${name}${decode(bare)}`);
}

// Every picture out of the HTML before it is rendered: an `<img>` becomes a grey box of its size (so the layout a lure
// draws stays), other embedded media go, and CSS images and `background` attributes are dropped.
export function stripImages(html: string): string {
  return (
    unescapeCss(html)
      // An imported stylesheet can carry pictures of its own: it goes, whatever form its address takes.
      .replace(/@import\b(?:"[^"]*"|'[^']*'|url\([^)]*\)|[^;"'])*;?/gi, "")
      // Vector artwork (a signature drawn as paths) goes whole, its own text with it.
      .replace(
        /<svg\b[\s\S]*?<\/svg\s*>/gi,
        '<span style="display:inline-block;width:120px;height:40px;background:#d0d0d0"></span>',
      )
      // CSS-generated text is drawn but never in the page's text, out of the post-render check's reach.
      .replace(/content\s*:\s*(?:"[^"]*"|'[^']*')/gi, "content:none")
      .replace(IMAGE_TAG, (tag) => {
        if (!/^<img\b/i.test(tag)) return "";
        const size = (name: string, fallback: number, most: number) => {
          const value = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "i").exec(tag)?.[1];
          return Math.min(most, Math.max(1, value ? Number(value) : fallback));
        };
        return `<span style="display:inline-block;width:${size("width", 120, 1280)}px;height:${size("height", 40, 600)}px;background:#d0d0d0;vertical-align:middle"></span>`;
      })
      .replace(/(?:-webkit-)?image-set\((?:[^()]|\([^()]*\))*\)/gi, "none")
      .replace(/url\(\s*(["']?)[^)]*\1\s*\)/gi, "none")
      .replace(/\s(?:background|poster|srcset)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // A frame's own document (`srcdoc`) and a linked stylesheet can carry pictures of their own.
      .replace(/<(iframe|frame|frameset)\b[\s\S]*?<\/\1\s*>|<(?:iframe|frame|link)\b[^>]*>/gi, "")
      // Any embedded picture left anywhere (a quoted data URL in a style or an attribute).
      .replace(/data:image\/[^"')\s>]*/gi, "")
  );
}

// Whether any picture is left for a render to draw: checked before every render, so a rule `stripImages` missed is a
// refusal, never a stored screenshot.
export function hasImages(html: string): boolean {
  return /<(?:img|image|svg|object|embed|picture|source|video|audio|iframe|frame|link)\b|url\(\s*["']?\s*(?:data:|cid:|https?:)|image-set\(|data:image\/|content\s*:\s*["']|@import\b/i.test(
    unescapeCss(html),
  );
}

// `text` with every address, client domain, name, phone and long number replaced. Names are left alone inside a URL
// (a lure's link host is what Loupe learns from); addresses and the client's domains are replaced everywhere.
// Embedded `data:` URIs are left as they are, since a digit run inside base64 is not a number.
// Places (the entity pass's address spans, §19) are replaced the same way, by their own placeholder.
export function redact(
  text: string,
  names: Iterable<string>,
  domains: Iterable<string> = [],
  places: Iterable<string> = [],
): string {
  const nameRule = termRule(names);
  const placeRule = termRule(places);
  const owned = [...new Set([...domains].map((d) => d.trim().toLowerCase()).filter(Boolean))];
  const domainRule = owned.length
    ? new RegExp(`(?<![\\p{L}\\p{N}.-])(?:${owned.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}-])`, "giu")
    : null;
  const source = decodeTextEntities(text);
  const pieces: string[] = [];
  let last = 0;
  for (const match of source.matchAll(DATA_URI)) {
    pieces.push(clean(source.slice(last, match.index)), match[0]);
    last = (match.index ?? 0) + match[0].length;
  }
  pieces.push(clean(source.slice(last)));
  return pieces.join("");

  function clean(part: string): string {
    // Matched on the folded text, replaced in the original: look-alike letters hide nothing, and keep their own cue.
    let out = replaceFolded(part, EMAIL, PLACEHOLDER.email);
    if (domainRule) out = replaceFolded(out, domainRule, PLACEHOLDER.domain);
    if (nameRule) out = outsideUrls(out, nameRule, PLACEHOLDER.name);
    if (placeRule) out = outsideUrls(out, placeRule, PLACEHOLDER.address);
    return replaceFolded(replaceFolded(out, PHONE, PLACEHOLDER.phone), LONG_NUMBER, PLACEHOLDER.number);
  }
}

// The entity pass (D03 T04 §19): people and places a page names that no header or list gave, found by spaCy's English
// model in `entities.py`, a child process (JSON lines in on stdin and out on stdout) whose every answer is checked here
// against its schema before a span counts. Each person span becomes names (`namePieces`) and each place span a place
// that `redact()` removes from the HTML like any other term. Any failure (a missing or changed model, a crash, a
// timeout, an answer too large or not to the schema, a text too long, or a run of letters in a script the model does
// not read) refuses the page with a diagnostic that names the failure and holds none of the page's content.
//
// The switch: on only if `docs/glimmer/redaction-benchmark.json` shows the pass raising recall on the Latin-script set
// without refusing more pages (§19's measurement; its `entityDecision` records the figures this follows).
export const ENTITY_PASS_ON = true;
export const ENTITY_MODEL = {
  name: "en_core_web_lg",
  // SHA-256 over the model package's files (`model_digest()` in `entities.py`): spaCy 3.8.18's en_core_web_lg 3.8.0.
  sha256: "2c670c29386ea89708bf55e443eb92ab40c9bd05efa94f53703e4db3505c3011",
  language: "en",
} as const;
export const ENTITY_LIMITS = { text: 200_000, seconds: 60, outputBytes: 1024 * 1024 } as const;
// Everything about the pass that decides what it removes and which pages it refuses: the switch, the model and its
// digest, and the limits. `redactionKey()` (import-samples.ts) hashes all of it, so a change to any one remakes every
// sample page (§19, plan review finding 7).
export type EntityConfig = {
  on: boolean;
  model: { name: string; sha256: string; language: string };
  limits: { text: number; seconds: number; outputBytes: number };
};
export const ENTITY_CONFIG: EntityConfig = { on: ENTITY_PASS_ON, model: ENTITY_MODEL, limits: ENTITY_LIMITS };

export type EntitySpan = { start: number; end: number; label: "person" | "place" };
export type EntityPass = { find: (text: string) => Promise<EntitySpan[]>; close: () => void };

// Scripts the English model does not read (as `UNREAD` in `entities.py`): a run of three letters in one of them refuses
// the page here too, so a pass that answered clean for it is never believed.
const UNREAD_SCRIPTS = [
  "Cyrillic",
  "Arabic",
  "Hebrew",
  "Greek",
  "Devanagari",
  "Bengali",
  "Tamil",
  "Thai",
  "Hangul",
  "Hiragana",
  "Katakana",
  "Han",
  "Ethiopic",
  "Armenian",
  "Georgian",
] as const;
const UNREAD_RUNS = UNREAD_SCRIPTS.map((script) => ({
  script: script.toLowerCase(),
  rule: new RegExp(`(?:(?=\\p{L})\\p{Script=${script}}){3}`, "u"),
}));

// The first script the model does not read that holds a run of three letters or more in `text`, or null.
export function unreadScript(text: string): string | null {
  let first: { script: string; at: number } | null = null;
  for (const { script, rule } of UNREAD_RUNS) {
    const at = rule.exec(text)?.index;
    if (at !== undefined && (!first || at < first.at)) first = { script, at };
  }
  return first?.script ?? null;
}

const BLOCK_TAG =
  /<\/?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|tfoot|caption|h[1-6]|section|article|aside|header|footer|nav|main|blockquote|pre|address|form|fieldset|legend|label|button|option|select|textarea|center)\b[^>]*>/gi;

// What a page's HTML shows as text, for the entity pass: its text with block tags as line breaks and inline tags
// joined up (a name split by `<b>` reads whole), then the values a form field or a tooltip draws, one a line. Read as
// `redact()` reads it (`decodeTextEntities`), so a span's text is a term `redact()` finds in the HTML.
export function entityText(html: string): string {
  const source = decodeTextEntities(html);
  const values = [
    ...source.matchAll(/\s(?:value|placeholder|title|alt|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi),
  ].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  const body = source
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(BLOCK_TAG, "\n")
    .replace(/<[^>]*>/g, "");
  return [body, ...values]
    .join("\n")
    .replace(/&(lt|gt|quot|apos|#39|#34);/g, (_m, name: string) => MARKUP[name] ?? "")
    .replace(/&amp;/g, "&");
}
const MARKUP: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#34": '"' };

// The terms a page's spans give `redact()`: a person's name pieces (the whole name and each word that is a name) and a
// place's whole text.
export function entityTerms(text: string, spans: EntitySpan[]): { names: string[]; places: string[] } {
  const names: string[] = [];
  const places: string[] = [];
  for (const span of spans) {
    const found = text.slice(span.start, span.end).trim();
    if (span.label === "person") names.push(...namePieces(found, undefined));
    else if (found.length >= 2) places.push(found);
  }
  return { names, places };
}

const PLACEHOLDERS = new RegExp(Object.values(PLACEHOLDER).map(escapeRegExp).join("|"), "g");

// The spans of `text` that still name someone or somewhere once the placeholders are taken out: a person span with a
// name piece left (`[name] Grobbelaar`, not `Mr [name]`), a place span with a word left. What admission and the leak
// check refuse on (§19, plan review finding 4).
export function survivingEntities(text: string, spans: EntitySpan[]): EntitySpan[] {
  return spans.filter((span) => {
    const rest = text.slice(span.start, span.end).replace(PLACEHOLDERS, " ");
    if (span.label === "person") return namePieces(rest, undefined).length > 0;
    return (rest.match(/\p{L}{2,}/gu) ?? []).some((word) => !NOT_NAMES.has(word.toLowerCase()));
  });
}

// `html` redacted by the lists, and, with the switch on, by what the entity pass finds in its text: a page the pass
// refuses is refused (the error says why). With the switch off the pass is never asked.
export async function redactWithEntities(
  html: string,
  names: Iterable<string>,
  domains: Iterable<string>,
  pass: EntityPass | null,
  on: boolean = ENTITY_PASS_ON,
): Promise<string> {
  if (!on) return redact(html, names, domains);
  if (!pass) throw new Error("refused: the entity pass is on but was not started");
  const text = entityText(html);
  const found = entityTerms(text, await pass.find(text));
  return redact(html, [...names, ...found.names], domains, found.places);
}

// The refusals `entities.py` may give for a page, word for word: anything else is not to the schema, so no reason it
// sends can carry the page's text into a diagnostic.
const PASS_REFUSAL =
  /^(?:a name in [a-z]+ script would go unread|the text is over \d+ characters|a request must hold text|the request failed \([A-Za-z]+\))$/;

// UTF-16 offsets of each code point in `text` (Python counts code points), or null when the two counts agree.
function codePointOffsets(text: string): number[] | null {
  if (!/[\uD800-\uDFFF]/.test(text)) return null;
  const offsets: number[] = [];
  let at = 0;
  for (const char of text) {
    offsets.push(at);
    at += char.length;
  }
  offsets.push(at);
  return offsets;
}

// One answer read against its schema: `{"spans": [{"start", "end", "label"}]}` with whole-number offsets inside the
// text and a known label, or `{"refused": <a known reason>}`; anything else is malformed (null).
function readAnswer(line: string, text: string): EntitySpan[] | { refused: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return null;
  const answer = value as { spans?: unknown; refused?: unknown };
  if (typeof answer.refused === "string") return PASS_REFUSAL.test(answer.refused) ? { refused: answer.refused } : null;
  if (!Array.isArray(answer.spans)) return null;
  const offsets = codePointOffsets(text);
  const length = offsets ? offsets.length - 1 : text.length;
  const spans: EntitySpan[] = [];
  for (const span of answer.spans as unknown[]) {
    if (!span || typeof span !== "object" || Object.keys(span).length !== 3) return null;
    const { start, end, label } = span as Record<string, unknown>;
    if (!Number.isInteger(start) || !Number.isInteger(end) || (label !== "person" && label !== "place")) return null;
    const [from, to] = [start as number, end as number];
    if (from < 0 || from >= to || to > length) return null;
    spans.push({ start: offsets?.[from] ?? from, end: offsets?.[to] ?? to, label });
  }
  return spans;
}

// The entity pass as a child process, started on the first page and again after any failure that ended it; one page
// at a time. `python` and `script` stand in for the venv and `entities.py` in tests.
export function openEntityPass(
  options: {
    python?: string;
    script?: string;
    sha256?: string;
    seconds?: number;
    outputBytes?: number;
    text?: number;
  } = {},
): EntityPass {
  const python = options.python ?? join(homedir(), ".venvs", "presidio", "bin", "python");
  const script = options.script ?? join(import.meta.dirname, "entities.py");
  const sha256 = options.sha256 ?? ENTITY_MODEL.sha256;
  const seconds = options.seconds ?? ENTITY_LIMITS.seconds;
  const outputBytes = options.outputBytes ?? ENTITY_LIMITS.outputBytes;
  const most = options.text ?? ENTITY_LIMITS.text;
  const refuse = (why: string) => new Error(`refused: the entity ${why}`);
  type Session = { ask: (line?: string) => Promise<string>; end: (why: string) => void; close: () => void };
  let session: Session | null = null;
  let ready: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const start = (): Session => {
    const child: ChildProcess = spawn(python, ["-I", script, "--model-sha256", sha256], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let failure: string | null = null;
    let waiting: { resolve: (line: string) => void; reject: (error: Error) => void } | null = null;
    let held: Buffer[] = [];
    let heldBytes = 0;
    const self: Session = {
      // Waits for the next line, after writing `line` when one is given; the time limit runs from the write.
      ask: (line) =>
        new Promise<string>((resolve, reject) => {
          if (failure) return reject(refuse(failure));
          const timer = setTimeout(() => self.end(`pass took over ${seconds} seconds`), seconds * 1000);
          waiting = {
            resolve: (answer) => {
              clearTimeout(timer);
              resolve(answer);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
          if (line !== undefined) child.stdin?.write(`${line}\n`);
        }),
      // Ends the process for good, refusing whatever page waits on it; the next page starts a new one.
      end: (why) => {
        if (failure) return;
        failure = why;
        child.kill("SIGKILL");
        if (session === self) {
          session = null;
          ready = null;
        }
        const pending = waiting;
        waiting = null;
        pending?.reject(refuse(why));
      },
      close: () => {
        failure ??= "pass was closed";
        child.stdin?.end();
      },
    };
    child.stdin?.on("error", () => self.end("pass stopped reading"));
    child.on("error", (error: NodeJS.ErrnoException) => self.end(`pass could not start (${error.code ?? error.name})`));
    child.on("close", (code, signal) =>
      self.end(signal ? `pass crashed (signal ${signal})` : `pass crashed (exit code ${code})`),
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      let from = 0;
      for (let at = chunk.indexOf(10); at !== -1 && !failure; at = chunk.indexOf(10, from)) {
        if (heldBytes + at - from > outputBytes) return self.end(`pass answered over ${outputBytes} bytes`);
        const line = Buffer.concat([...held, chunk.subarray(from, at)]).toString("utf8");
        held = [];
        heldBytes = 0;
        from = at + 1;
        const pending = waiting;
        if (!pending) return self.end("pass answered what was not asked");
        waiting = null;
        pending.resolve(line);
      }
      if (failure) return;
      held.push(chunk.subarray(from));
      heldBytes += chunk.length - from;
      if (heldBytes > outputBytes) self.end(`pass answered over ${outputBytes} bytes`);
    });
    return self;
  };

  // The first line: ready, the pinned model, English; or the script's own refusal to start.
  const begin = async (current: Session) => {
    const line = await current.ask();
    let value: Record<string, unknown> | null = null;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {}
    const fail = (why: string) => {
      current.end(why);
      throw refuse(why);
    };
    if (value?.refused === "the model is not installed") fail("model is not installed");
    if (value?.refused === "the model is not the pinned one") fail("model is not the pinned one");
    if (
      !value ||
      Object.keys(value).length !== 4 ||
      value.ready !== true ||
      value.model !== ENTITY_MODEL.name ||
      value.language !== ENTITY_MODEL.language
    )
      fail("pass gave a malformed answer");
    if (value?.model_sha256 !== sha256) fail("model is not the pinned one");
  };

  const ask = async (text: string): Promise<EntitySpan[]> => {
    if (text.length > most) throw refuse(`pass takes at most ${most} characters, and the page's text is longer`);
    const script = unreadScript(text);
    if (script) throw refuse(`model does not read ${script} script, and the page holds a name in it`);
    if (!session) {
      session = start();
      ready = begin(session);
    }
    const current = session;
    await ready;
    const answer = readAnswer(await current.ask(JSON.stringify({ text })), text);
    if (!answer) {
      current.end("pass gave a malformed answer");
      throw refuse("pass gave a malformed answer");
    }
    if ("refused" in answer) throw refuse(`pass refused the page (${answer.refused})`);
    return answer;
  };

  return {
    find: (text) => {
      const answer = queue.then(() => ask(text));
      queue = answer.catch(() => undefined);
      return answer;
    },
    close: () => {
      session?.close();
      session = null;
      ready = null;
    },
  };
}

// The pass a configuration describes: its pinned digest and its limits, so what runs is what `redactionKey()` hashed.
export function openConfiguredPass(config: EntityConfig = ENTITY_CONFIG): EntityPass {
  const { model, limits } = config;
  return openEntityPass({
    sha256: model.sha256,
    seconds: limits.seconds,
    outputBytes: limits.outputBytes,
    text: limits.text,
  });
}
