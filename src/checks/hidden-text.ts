// Hidden text in an email's HTML (D02 T05 §1; spec: prompt injection, the safety contract in AGENTS.md): text a reader
// never sees but a model reading the raw message would, as styles and markup hide it. The HTML is streamed through
// HTMLRewriter (the Workers runtime's own parser), each element's hiding decided from its inline style, its `hidden`
// attribute, the `<style>` rules seen before it (class, id and tag selectors, alone or `tag.class`) and its ancestors;
// any other selector is counted as not resolved. The visible text is what a model reads; the hidden text is evidence.
// The Workflow's `checks` step runs the scan (the cut parts' full HTML is in R2) and the check maps its result to items.
import { decodeEntities } from "./entities";

export type HiddenReason =
  | "hidden-attribute"
  | "display:none"
  | "visibility:hidden"
  | "font-size"
  | "opacity"
  | "color-match"
  | "off-screen"
  | "collapsed"
  | "comment";
// A run of hidden text; `instruction` says whether instruction words appear anywhere in it, read as it streamed in, so
// the cut at MAX_SPAN_CHARS loses no signal (completion review).
export type HiddenSpan = { text: string; reason: HiddenReason; beforeVisible: boolean; instruction: boolean };
export type Scan = {
  hidden: HiddenSpan[];
  visible: string;
  unresolvedRules: number;
  // Colour values that could not be read (a variable, a gradient), so a colour match there may be missed.
  unreadColours: number;
  // Hidden spans found but not kept, past MAX_HIDDEN_SPANS.
  omittedSpans: number;
};

// Bounds on what one scan keeps, whatever the HTML holds: spans (the instruction-bearing ones kept first), a span's
// text, the visible text and the style sheets read.
export const MAX_HIDDEN_SPANS = 200;
export const MAX_SPAN_CHARS = 2_000;
export const MAX_VISIBLE_CHARS = 1024 * 1024;
export const MAX_SHEET_CHARS = 512 * 1024;
export const MAX_SELECTORS = 20_000;
const MAX_CASCADES = 4_096;

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
// Content no reader sees as text: neither visible nor hidden text.
const NOT_TEXT = new Set(["head", "title", "script", "style", "noscript", "template", "svg", "math"]);
// Elements that start a new line in what a reader sees; table cells are separated by a tab.
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "ul",
]);
const CELL = new Set(["td", "th"]);

type Declaration = { value: string; important: boolean };
type Declarations = Map<string, Declaration>;
// The rules of one selector, merged: each property's winning value, its importance and the rule order that set it, so
// a sheet of forty thousand identical rules is one entry per property (round 1: the cascade must stay linear).
type Selector = { specificity: number; props: Map<string, Declaration & { order: number }> };
export type Rules = { byKey: Map<string, Selector>; order: number };
export const newRules = (): Rules => ({ byKey: new Map(), order: 0 });
type Rgb = [number, number, number];
type Colour = Rgb | "transparent";
type State = {
  tag: string;
  // A hiding no descendant can undo: display, the hidden attribute, opacity, collapse, off-screen placement.
  subtree: HiddenReason | null;
  // Inherited properties a descendant may set again (CSS inheritance): visibility, the font's size, the text colour.
  visibility: "visible" | "hidden";
  fontPx: number;
  color: Colour | null;
  background: Rgb;
  silent: boolean;
};

const FONT_SIZE =
  /^(?:(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|em|rem|%)|0|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/;
// A shorthand's longhands, set where the shorthand stands (CSS Cascade 5, shorthands; round 1): `background` sets its
// colour (transparent when it names none), `font` its size.
function expand(name: string, value: string): [string, string][] {
  if (name === "background") return [["background-color", backgroundColourToken(value) ?? "transparent"]];
  if (name === "font") {
    const size = value
      .split(/\s+/)
      .map((t) => t.split("/")[0] ?? "")
      .find((t) => FONT_SIZE.test(t));
    return size ? [["font-size", size]] : [];
  }
  return [[name, value]];
}

// Whether a value is one the property can take, for the properties this reads; any other property is not judged.
const WIDE = /^(inherit|initial|unset|revert|revert-layer)$/;
const LENGTH = /^[+-]?(?:(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|pc|cm|mm|in|em|rem|ex|ch|vw|vh|vmin|vmax|%)|0)$/;
const VALID: Record<string, (v: string) => boolean> = {
  display: (v) =>
    /^(none|block|inline|inline-block|flex|inline-flex|grid|inline-grid|table|table-row|table-cell|table-row-group|table-header-group|table-footer-group|table-column|table-column-group|table-caption|list-item|contents|flow-root|run-in|ruby)$/.test(
      v,
    ),
  visibility: (v) => /^(visible|hidden|collapse)$/.test(v),
  opacity: (v) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(v),
  "font-size": (v) => FONT_SIZE.test(v),
  position: (v) => /^(static|relative|absolute|fixed|sticky)$/.test(v),
  left: (v) => LENGTH.test(v) || v === "auto",
  top: (v) => LENGTH.test(v) || v === "auto",
  "text-indent": (v) => LENGTH.test(v.split(/\s+/)[0] ?? ""),
  overflow: (v) => /^(visible|hidden|clip|scroll|auto)(\s+(visible|hidden|clip|scroll|auto))?$/.test(v),
  height: (v) => LENGTH.test(v) || /^(auto|fit-content|min-content|max-content)$/.test(v),
  "max-height": (v) => LENGTH.test(v) || /^(none|fit-content|min-content|max-content)$/.test(v),
  // A colour this reads, a keyword, or a function it does not read (`var()`, `hsl()`): valid, though perhaps unread.
  color: (v) => readColour(v) !== null || v === "currentcolor" || /^[a-z-]+\(.*\)$/.test(v),
  "background-color": (v) => readColour(v) !== null || v === "currentcolor" || /^[a-z-]+\(.*\)$/.test(v),
};
const valid = (name: string, value: string) =>
  WIDE.test(value) || !Object.hasOwn(VALID, name) || (VALID[name] as (v: string) => boolean)(value);

// CSS comments removed in one linear pass; an unterminated one runs to the end, as CSS reads it (round 4: a regex
// rescanning `/*x/*x...` was quadratic).
export function stripCssComments(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("/*", at);
    if (open < 0) return out + text.slice(at);
    out += text.slice(at, open);
    const close = text.indexOf("*/", open + 2);
    if (close < 0) return out;
    at = close + 2;
  }
}

// `prop: value; ...` as a map of lower-cased names to values and their `!important`, shorthands expanded in order.
export function declarations(text: string): Declarations {
  const out: Declarations = new Map();
  for (const part of stripCssComments(text).split(";")) {
    const colon = part.indexOf(":");
    if (colon < 1) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const raw = part
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    const important = /!\s*important\s*$/.test(raw);
    const value = raw.replace(/!\s*important\s*$/, "").trim();
    if (!name || !value) continue;
    // Within one block a later declaration wins, except that a normal one never overrides an `!important` one; a value
    // the property cannot take is ignored, as CSS ignores it (round 2: `display:none;display:bogus` stays hidden).
    // Only the properties the scanner reads are kept (round 3: a sheet of custom properties copied to every selector
    // grew the heap past the Worker's limit).
    for (const [longhand, v] of expand(name, value))
      if (Object.hasOwn(VALID, longhand) && valid(longhand, v) && !(out.get(longhand)?.important && !important))
        out.set(longhand, { value: v, important });
  }
  return out;
}

// Selectors keep their case for classes and ids (case-sensitive outside quirks mode); only a tag name is lower-cased.
const SIMPLE = /^([a-zA-Z][a-zA-Z0-9]*)?(?:\.([A-Za-z0-9_-]+))?$|^#([A-Za-z0-9_-]+)$/;
// A style sheet's simple rules merged into `rules` in document order; returns how many selectors were not simple.
export function addRules(sheet: string, rules: Rules): number {
  let unresolved = 0;
  // One linear pass over the sheet (round 2: a regex that rescans a malformed sheet is quadratic): comments skipped,
  // each `selectors { declarations }` read in turn, an at-rule's block (`@media`, `@supports`) skipped whole and
  // counted, its nested braces balanced.
  let at = 0;
  const n = sheet.length;
  while (at < n) {
    if (sheet.startsWith("/*", at)) {
      const end = sheet.indexOf("*/", at + 2);
      at = end < 0 ? n : end + 2;
      continue;
    }
    const open = sheet.indexOf("{", at);
    if (open < 0) break;
    const prelude = stripCssComments(sheet.slice(at, open)).trim();
    if (prelude.startsWith("@") || prelude.includes("@")) {
      let depth = 1;
      let i = open + 1;
      for (; i < n && depth > 0; i++) {
        if (sheet[i] === "{") depth++;
        else if (sheet[i] === "}") depth--;
      }
      unresolved++;
      at = i;
      continue;
    }
    const close = sheet.indexOf("}", open + 1);
    const end = close < 0 ? n : close;
    const inner = sheet.slice(open + 1, end);
    // A block holding another `{` is not a style rule this reads: skipped and counted.
    if (inner.includes("{")) {
      unresolved++;
      at = end + 1;
      continue;
    }
    const body = declarations(inner);
    const order = rules.order++;
    for (const raw of prelude.split(",")) {
      const selector = raw.trim();
      if (!selector) continue;
      const simple = SIMPLE.exec(selector);
      if (!simple || (!simple[1] && !simple[2] && !simple[3])) {
        unresolved++;
        continue;
      }
      const [, tag, cls, id] = simple;
      const key = id ? `#${id}` : `${tag?.toLowerCase() ?? ""}${cls ? `.${cls}` : ""}`;
      const specificity = (id ? 10_000 : 0) + (cls ? 100 : 0) + (tag ? 1 : 0);
      // A rule that sets nothing the scanner reads is not kept; past MAX_SELECTORS distinct selectors, the rest are
      // counted as not resolved (round 3).
      if (!body.size) continue;
      if (!rules.byKey.has(key) && rules.byKey.size >= MAX_SELECTORS) {
        unresolved++;
        continue;
      }
      const entry = rules.byKey.get(key) ?? { specificity, props: new Map() };
      for (const [name, d] of body) {
        const existing = entry.props.get(name);
        // A later rule wins for its property unless it is normal and the earlier one `!important`.
        if (!existing || d.important || !existing.important) entry.props.set(name, { ...d, order });
      }
      rules.byKey.set(key, entry);
    }
    at = end + 1;
  }
  return unresolved;
}

// The declarations that apply to an element, by the cascade: rules by importance, then specificity, then order, the
// inline style above normal rules and its `!important` above all. Only the element's own selector keys are looked up,
// so each element costs what its tag, classes and id name, never the whole sheet (round 1).
export function cascade(
  rules: Rules,
  tag: string,
  classes: string[],
  id: string,
  inline: Declarations,
): Map<string, string> {
  const keys = [tag, ...classes.flatMap((c) => [`.${c}`, `${tag}.${c}`]), ...(id ? [`#${id}`] : [])];
  const best = new Map<string, { value: string; rank: [number, number, number] }>();
  const offer = (name: string, value: string, rank: [number, number, number]) => {
    const current = best.get(name);
    const wins =
      !current ||
      rank[0] > current.rank[0] ||
      (rank[0] === current.rank[0] &&
        (rank[1] > current.rank[1] || (rank[1] === current.rank[1] && rank[2] >= current.rank[2])));
    if (wins) best.set(name, { value, rank });
  };
  for (const key of new Set(keys)) {
    const selector = rules.byKey.get(key);
    if (!selector) continue;
    for (const [name, d] of selector.props) offer(name, d.value, [d.important ? 2 : 0, selector.specificity, d.order]);
  }
  for (const [name, d] of inline) offer(name, d.value, [d.important ? 3 : 1, 0, 0]);
  return new Map([...best].map(([name, { value }]) => [name, value]));
}

// The CSS named colours (CSS Color Module Level 4), as `rrggbb`.
const NAMED_HEX =
  "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32";
const NAMED = new Map<string, Rgb>();
{
  const words = NAMED_HEX.split(" ");
  for (let i = 0; i + 1 < words.length; i += 2) {
    const hex = words[i + 1] as string;
    NAMED.set(words[i] as string, [0, 2, 4].map((j) => Number.parseInt(hex.slice(j, j + 2), 16)) as Rgb);
  }
}

// A colour value: RGB, `transparent` (no colour shows: the keyword or a zero alpha), or null when it is not a colour this
// reads (a variable, `currentcolor`, a gradient).
export function readColour(value: string | null | undefined): Colour | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "transparent") return "transparent";
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    const h = hex[1] as string;
    const full = h.length <= 4 ? [...h.slice(0, 3)].map((c) => c + c).join("") : h.slice(0, 6);
    const alpha = h.length === 4 ? (h[3] ?? null) : h.length === 8 ? h.slice(6) : null;
    if (alpha !== null && Number.parseInt(alpha.length === 1 ? alpha + alpha : alpha, 16) === 0) return "transparent";
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as Rgb;
  }
  const rgb =
    /^rgba?\(\s*((?:\d+(?:\.\d+)?|\.\d+)%?)[\s,]+((?:\d+(?:\.\d+)?|\.\d+)%?)[\s,]+((?:\d+(?:\.\d+)?|\.\d+)%?)(?:[\s,/]+((?:\d+(?:\.\d+)?|\.\d+)%?))?\s*\)$/.exec(
      v,
    );
  if (rgb) {
    if (rgb[4] !== undefined && Number.parseFloat(rgb[4]) === 0) return "transparent";
    return [rgb[1], rgb[2], rgb[3]].map((c) =>
      Math.min(255, c?.endsWith("%") ? Math.round(Number.parseFloat(c) * 2.55) : Number.parseFloat(c ?? "0")),
    ) as Rgb;
  }
  return NAMED.get(v) ?? null;
}
// The RGB of a colour value, null for a transparent or unread one (the background reader's use).
export const parseColor = (value: string | null | undefined): Rgb | null => {
  const c = readColour(value);
  return c === "transparent" ? null : c;
};

// The colour token in a `background` shorthand, as written: its tokens split outside parentheses, the first that reads
// as a colour.
function backgroundColourToken(value: string): string | null {
  const tokens: string[] = [];
  let depth = 0;
  let token = "";
  for (const c of value) {
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(c) && depth === 0) {
      if (token) tokens.push(token);
      token = "";
    } else token += c;
  }
  if (token) tokens.push(token);
  return tokens.find((t) => readColour(t) !== null) ?? null;
}

// CIE76 colour difference between two sRGB colours (D65).
export function deltaE(a: Rgb, b: Rgb): number {
  const lab = ([r, g, b]: Rgb) => {
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const [R, G, B] = [lin(r), lin(g), lin(b)];
    const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
    const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const [l1, a1, b1] = lab(a) as [number, number, number];
  const [l2, a2, b2] = lab(b) as [number, number, number];
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// A length in pixels (px, pt, or a bare zero), or null when it is relative or unreadable.
const px = (value: string | undefined) => {
  if (!value) return null;
  const m = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(px|pt)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number.parseFloat(m[1] as string);
  return m[2] === "pt" ? n * (4 / 3) : m[2] === "px" || n === 0 ? n : null;
};
// A font size in pixels, relative units taken against the parent's (`rem` against 16px); the parent's when unread.
const fontSize = (value: string | undefined, parent: number) => {
  if (!value) return parent;
  const absolute = px(value);
  if (absolute !== null) return absolute;
  const m = /^((?:\d+(?:\.\d+)?|\.\d+))(em|rem|%)$/.exec(value.trim());
  if (!m) return parent;
  const n = Number.parseFloat(m[1] as string);
  return m[2] === "%" ? (parent * n) / 100 : m[2] === "rem" ? 16 * n : parent * n;
};

// The hiding an element's own declarations apply to its whole subtree, or null.
function subtreeHiding(d: Map<string, string>): HiddenReason | null {
  if (d.get("display") === "none") return "display:none";
  const opacity = d.get("opacity");
  if (opacity !== undefined && Number.parseFloat(opacity) === 0) return "opacity";
  const position = d.get("position") ?? "";
  const far = (name: string) => (px(d.get(name)) ?? 0) <= -1000;
  if ((/^(absolute|fixed)$/.test(position) && (far("left") || far("top"))) || far("text-indent")) return "off-screen";
  const overflow = d.get("overflow") ?? "";
  if (overflow === "hidden" && (px(d.get("max-height")) === 0 || px(d.get("height")) === 0)) return "collapsed";
  return null;
}

const INSTRUCTION =
  /\b(ignore|disregard|instruction|instructions|assistant|system|prompt|classify|classified|safe|legitimate|verdict|override|model|ai)\b/i;
// Whether hidden text speaks to a reader that is not the member: instruction words, ranked first among the findings.
export const hasInstruction = (text: string) => INSTRUCTION.test(text);
// Whether a hidden span reads as a marketing preheader: short, before any visible text, no instruction words.
export const isPreheader = (span: HiddenSpan) => span.beforeVisible && span.text.length < 120 && !span.instruction;

// Character references: ./entities (moved there for D02 T05 §2, whose matcher runs without the HTML rewriter).
export { decodeEntities };

// Drains a transformed response without keeping its bytes: the rewriter's handlers are what read it (completion review).
async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  while (!(await reader.read()).done) {}
}

// Every `<style>` sheet's text in a document, up to MAX_SHEET_CHARS (the first pass: a rule applies wherever it sits);
// `cut` says whether more was left unread.
async function sheets(html: ReadableStream | string): Promise<{ text: string; cut: boolean }> {
  let text = "";
  let cut = false;
  await drain(
    new HTMLRewriter()
      .on("style", {
        text(chunk) {
          if (text.length + chunk.text.length > MAX_SHEET_CHARS) cut = true;
          else text += chunk.text;
        },
      })
      .transform(new Response(html, { headers: { "content-type": "text/html" } })),
  );
  return { text, cut };
}

// `source` gives the HTML afresh each time it is called: it is read twice, once for the rules, once to classify.
// `extraSheets` are style sheets found elsewhere (the full text of a part the summary's HTML was cut from), applied after
// the document's own.
// `ownSheets`, when the caller already read the document's sheets, saves the first pass (round 6: a cut part was read
// three times).
// Where the scanner sends every chunk of visible and hidden text as it arrives, before any cut (D02 T05 §2: the
// AI-instruction phrases are matched there).
export type TextSinks = { visible: { feed(text: string): void }; hidden: { feed(text: string): void } };

export async function scanHtml(
  source: () => ReadableStream | string | Promise<ReadableStream | string>,
  extraSheets = "",
  ownSheets?: { text: string; cut: boolean },
  sinks?: TextSinks,
): Promise<Scan> {
  const rules = newRules();
  const sheet = ownSheets ?? (await sheets(await source()));
  const unresolvedRules =
    addRules(sheet.text, rules) + (sheet.cut ? 1 : 0) + (extraSheets ? addRules(extraSheets, rules) : 0);
  let unreadColours = 0;
  const root: State = {
    tag: "#root",
    subtree: null,
    visibility: "visible",
    fontPx: 16,
    color: null,
    background: [255, 255, 255],
    silent: false,
  };
  const stack: State[] = [root];
  const cascades = new Map<string, Map<string, string>>();
  const hidden: HiddenSpan[] = [];
  let omittedSpans = 0;
  let visible = "";
  let open: { reason: HiddenReason; text: string; tail: string; beforeVisible: boolean; instruction: boolean } | null =
    null;
  let split = false;
  const keep = (span: HiddenSpan) => {
    if (hidden.length < MAX_HIDDEN_SPANS) {
      hidden.push(span);
      return;
    }
    // Full: an instruction-bearing span takes the place of the last one without instruction words (completion review).
    const at = span.instruction ? hidden.findLastIndex((h) => !h.instruction) : -1;
    if (at >= 0) hidden[at] = span;
    omittedSpans++;
  };
  const flush = () => {
    if (open && !open.instruction && INSTRUCTION.test(decodeEntities(open.tail))) open.instruction = true;
    if (open && (open.text.trim() || open.instruction))
      keep({
        text: decodeEntities(open.text.replace(/\s+/g, " ").trim()),
        reason: open.reason,
        beforeVisible: open.beforeVisible,
        instruction: open.instruction,
      });
    open = null;
  };
  const addHidden = (reason: HiddenReason, text: string) => {
    if (!open || open.reason !== reason) {
      flush();
      open = { reason, text: "", tail: "", beforeVisible: !visible.trim(), instruction: false };
      sinks?.hidden.feed(" ");
    } else if (split) {
      // Hidden text resuming after visible text or a line boundary within one run is a new word, not the last one's
      // continuation (D02 T05 §2's completion review: "instructions" and "note" were read as "instructionsnote").
      open.text += " ";
      sinks?.hidden.feed(" ");
    }
    split = false;
    sinks?.hidden.feed(text);
    // Whitespace collapses as it arrives, so padding never fills MAX_SPAN_CHARS (round 1). Instruction words are
    // matched on whole words only: the text up to the last whitespace, the rest carried to the next chunk, so a chunk
    // boundary is never a word boundary (round 1); character references are decoded first.
    const collapsed = text.replace(/\s+/g, " ");
    const window = open.tail + collapsed;
    const cut = window.lastIndexOf(" ");
    if (cut >= 0) {
      if (!open.instruction && INSTRUCTION.test(decodeEntities(window.slice(0, cut)))) open.instruction = true;
      open.tail = window.slice(cut);
    } else open.tail = window.slice(-256);
    const room = MAX_SPAN_CHARS - open.text.length;
    if (room > 0)
      open.text += open.text.endsWith(" ") ? collapsed.replace(/^ /, "").slice(0, room) : collapsed.slice(0, room);
  };
  const addVisible = (text: string) => {
    sinks?.visible.feed(text);
    if (text.trim()) split = true;
    if (visible.length < MAX_VISIBLE_CHARS) visible += text.slice(0, MAX_VISIBLE_CHARS - visible.length);
  };
  const top = () => stack[stack.length - 1] as State;
  const reasonOf = (state: State): HiddenReason | null => {
    if (state.subtree) return state.subtree;
    if (state.visibility === "hidden") return "visibility:hidden";
    if (state.fontPx < 2) return "font-size";
    if (state.color === "transparent") return "color-match";
    if (state.color && deltaE(state.color, state.background) < 3) return "color-match";
    return null;
  };
  // A line or cell boundary, as a reader sees one: in the visible text, or as a space inside a hidden run.
  const boundary = (separator: string) => {
    const state = top();
    if (state.silent) return;
    if (reasonOf(state) && open) {
      open.text += " ";
      sinks?.hidden.feed(" ");
    } else if (!reasonOf(state)) {
      addVisible(separator);
      split = true;
    }
  };

  // HTML's optional end tags (round 1; WHATWG HTML, optional tags): <body> closes an open <head>; a block element
  // closes an open <p>; <li>, <dt>/<dd>, a cell and a row close the open sibling of their kind, within its container.
  const popTo = (at: number) => {
    if (at > 0) stack.length = at;
  };
  const openAt = (tags: string[], boundaries: string[]) => {
    for (let i = stack.length - 1; i > 0; i--) {
      const t = (stack[i] as State).tag;
      if (tags.includes(t)) return i;
      if (boundaries.includes(t)) return -1;
    }
    return -1;
  };
  const implyEnds = (tag: string) => {
    if (tag === "body") popTo(openAt(["head"], []));
    if (BLOCK.has(tag)) popTo(openAt(["p"], ["div", "td", "th", "li", "table", "body", "blockquote"]));
    if (tag === "li") popTo(openAt(["li"], ["ul", "ol"]));
    if (tag === "dt" || tag === "dd") popTo(openAt(["dt", "dd"], ["dl"]));
    if (CELL.has(tag)) popTo(openAt(["td", "th"], ["tr", "table"]));
    if (tag === "tr") popTo(openAt(["tr"], ["table", "tbody", "thead", "tfoot"]));
  };

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();
        if (!VOID.has(tag)) implyEnds(tag);
        const parent = top();
        // Classes and ids keep their case (round 1).
        const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
        const id = element.getAttribute("id") ?? "";
        // Elements alike in tag, class, id and style share one cascade (bounded), so a body of thousands of identical
        // elements costs one lookup each (round 4's timing).
        const style = element.getAttribute("style") ?? "";
        const signature = `${tag}\u0000${element.getAttribute("class") ?? ""}\u0000${id}\u0000${style}`;
        let d = cascades.get(signature);
        if (!d) {
          d = cascade(rules, tag, classes, id, declarations(style));
          if (cascades.size < MAX_CASCADES) cascades.set(signature, d);
        }
        const readOrCount = (value: string | undefined | null, read: (v: string) => Colour | null) => {
          if (value === undefined || value === null || value === "") return null;
          const c = read(value);
          if (c === null && !/^(inherit|initial|unset|currentcolor|none)$/.test(value.trim())) unreadColours++;
          return c;
        };
        // `background` is expanded to its colour where it stands (`declarations`), so one longhand decides.
        const bg =
          readOrCount(d.get("background-color"), readColour) ??
          readOrCount(element.getAttribute("bgcolor"), readColour);
        const visibility = d.get("visibility");
        const state: State = {
          tag,
          subtree: parent.subtree ?? (element.hasAttribute("hidden") ? "hidden-attribute" : subtreeHiding(d)),
          visibility:
            visibility === "visible"
              ? "visible"
              : /^(hidden|collapse)$/.test(visibility ?? "")
                ? "hidden"
                : parent.visibility,
          fontPx: fontSize(d.get("font-size"), parent.fontPx),
          color: readOrCount(d.get("color") ?? element.getAttribute("color"), readColour) ?? parent.color,
          background: bg && bg !== "transparent" ? bg : parent.background,
          silent: parent.silent || NOT_TEXT.has(tag),
        };
        if (tag === "br") boundary("\n");
        if (VOID.has(tag)) return;
        if (BLOCK.has(tag)) boundary("\n");
        if (CELL.has(tag)) boundary("\t");
        stack.push(state);
        element.onEndTag(() => {
          // Pop to this element, closing any left open inside it (HTML's implied end tags).
          const at = stack.lastIndexOf(state);
          if (at > 0) stack.length = at;
          if (BLOCK.has(tag)) boundary("\n");
        });
      },
    })
    .onDocument({
      comments(comment) {
        // A conditional comment (`[if mso]`) is markup for Outlook, not text.
        if (/^\s*\[if\b|^\s*<!\[endif\]/i.test(comment.text) || top().silent) return;
        flush();
        addHidden("comment", comment.text);
        flush();
      },
      text(chunk) {
        const state = top();
        if (state.silent || !chunk.text) return;
        const reason = reasonOf(state);
        if (!reason) {
          if (chunk.text.trim()) flush();
          addVisible(chunk.text);
          return;
        }
        addHidden(reason, chunk.text);
      },
    });
  await drain(rewriter.transform(new Response(await source(), { headers: { "content-type": "text/html" } })));
  flush();
  return {
    hidden,
    visible: decodeEntities(visible)
      .split("\n")
      .map((line) =>
        line
          .replace(/[ \r\f\v]+/g, " ")
          .replace(/ *\t */g, "\t")
          .trim(),
      )
      .join("\n")
      .replace(/\n{2,}/g, "\n")
      .trim(),
    unresolvedRules,
    unreadColours,
    omittedSpans,
  };
}

export type HiddenText = {
  spans: (HiddenSpan & { part: string })[];
  unresolvedRules: number;
  unreadColours: number;
  omittedSpans: number;
  // Cut HTML parts whose full text could not be scanned, and why.
  notScanned: { key: string; why: "missing" | "charset" }[];
};

// Where the body's text goes, whole, for the AI-instruction phrases (D02 T05 §2): a stream per kind of text, and the
// cut parts that could not be read.
export type BodyPhrases = {
  stream(kind: "visible" | "hidden" | "text"): { feed(text: string): void; end(): void };
  unread(key: string, why: "missing" | "charset"): void;
};

// The case's hidden text and visible text, for the `checks` step: the summary's HTML gives both; each HTML part cut for
// reading is scanned whole from R2, in its own charset, for evidence only, a span the summary already gave not repeated.
// A part whose object is missing or whose charset cannot be decoded is named as not scanned; any other storage or
// stream error is thrown, so the step is retried. With `phrases`, every text the body holds goes there whole: each HTML
// scan's visible and hidden text, the cut plain-text parts, and the plain text.
export async function hiddenTextOf(
  bucket: R2Bucket,
  summary: {
    html: string | null;
    text: string | null;
    truncated: readonly { mediaType: string; charset: string | null; key: string }[];
  },
  phrases?: BodyPhrases,
): Promise<{ hidden: HiddenText; visible: string }> {
  const sinks = () => (phrases ? { visible: phrases.stream("visible"), hidden: phrases.stream("hidden") } : undefined);
  const ended = (open: ReturnType<typeof sinks>) => {
    open?.visible.end();
    open?.hidden.end();
  };
  const partSpans: HiddenText["spans"] = [];
  const notScanned: HiddenText["notScanned"] = [];
  let unresolvedRules = 0;
  let unreadColours = 0;
  let omittedSpans = 0;
  // The full parts' own style sheets, applied to the summary's HTML too: a rule after the cut still hides the text
  // before it that the summary kept, and every other body part stays in the visible text (round 1).
  let partSheets = "";
  const plainParts: { key: string; charset: string }[] = [];
  for (const part of summary.truncated) {
    const html = part.mediaType.split(";")[0]?.trim().toLowerCase() === "text/html";
    if (!html && !phrases) continue;
    const charset = part.charset ?? "utf-8";
    try {
      new TextDecoder(charset);
    } catch {
      if (html) notScanned.push({ key: part.key, why: "charset" });
      phrases?.unread(part.key, "charset");
      continue;
    }
    if (!(await bucket.head(part.key))) {
      if (html) notScanned.push({ key: part.key, why: "missing" });
      phrases?.unread(part.key, "missing");
      continue;
    }
    if (!html) {
      // A cut plain-text part, for the phrases only: read after the HTML, so a match the HTML gave keeps its location.
      plainParts.push({ key: part.key, charset });
      continue;
    }
    // Each pass reads the object afresh, decoded from its charset and encoded again as UTF-8 for the parser.
    const open = async () => {
      const object = await bucket.get(part.key);
      if (!object) throw new Error(`the cut part ${part.key} disappeared while it was read`);
      return object.body.pipeThrough(new TextDecoderStream(charset)).pipeThrough(new TextEncoderStream());
    };
    const sheet = await sheets(await open());
    if (partSheets.length + sheet.text.length <= MAX_SHEET_CHARS) partSheets += sheet.text;
    const partSinks = sinks();
    const scan = await scanHtml(open, "", sheet, partSinks);
    ended(partSinks);
    unresolvedRules += scan.unresolvedRules;
    unreadColours += scan.unreadColours;
    omittedSpans += scan.omittedSpans;
    partSpans.push(...scan.hidden.map((h) => ({ ...h, part: part.key })));
  }
  const spans: HiddenText["spans"] = [];
  let visible = summary.text ?? "";
  if (summary.html !== null) {
    const html = summary.html;
    const summarySinks = sinks();
    const scan = await scanHtml(() => html, partSheets, undefined, summarySinks);
    ended(summarySinks);
    spans.push(...scan.hidden.map((h) => ({ ...h, part: "summary" })));
    unresolvedRules += scan.unresolvedRules;
    unreadColours += scan.unreadColours;
    omittedSpans += scan.omittedSpans;
    visible = scan.visible;
  }
  if (phrases) {
    for (const part of plainParts) {
      const object = await bucket.get(part.key);
      if (!object) throw new Error(`the cut part ${part.key} disappeared while it was read`);
      const stream = phrases.stream("text");
      const reader = object.body.pipeThrough(new TextDecoderStream(part.charset)).getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) stream.feed(chunk.value);
      stream.end();
    }
    if (summary.text !== null) {
      const stream = phrases.stream("text");
      stream.feed(summary.text);
      stream.end();
    }
  }
  for (const span of partSpans) {
    // A span already kept from another reading of the same text (the summary's prefix, or the same part listed again)
    // is not repeated; the longer reading is kept.
    const at = spans.findIndex((s) => s.reason === span.reason && span.text.startsWith(s.text));
    if (at >= 0) {
      if ((spans[at] as HiddenSpan).text.length < span.text.length) spans[at] = span;
    } else spans.push(span);
  }
  return {
    hidden: {
      spans: rankKept(spans),
      unresolvedRules,
      unreadColours,
      omittedSpans: omittedSpans + Math.max(0, spans.length - MAX_HIDDEN_SPANS),
      notScanned,
    },
    visible,
  };
}

// The kept spans across the parts, at most MAX_HIDDEN_SPANS, instruction-bearing ones first.
const rankKept = (spans: HiddenText["spans"]) =>
  [...spans].sort((a, b) => Number(b.instruction) - Number(a.instruction)).slice(0, MAX_HIDDEN_SPANS);
