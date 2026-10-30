// Hidden text in an email's HTML (D02 T05 §1; spec: prompt injection, the safety contract in AGENTS.md): text a reader
// never sees but a model reading the raw message would, as styles and markup hide it. The HTML is streamed through
// HTMLRewriter (the Workers runtime's own parser), each element's hiding decided from its inline style, its `hidden`
// attribute, the `<style>` rules seen before it (class, id and tag selectors, alone or `tag.class`) and its ancestors;
// any other selector is counted as not resolved. The visible text is what a model reads; the hidden text is evidence.
// The Workflow's `checks` step runs the scan (the cut parts' full HTML is in R2) and the check maps its result to items.

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
// A simple rule: its selector's parts, its specificity (ids, classes, tags) and its place in the document.
type Rule = {
  tag: string | null;
  cls: string | null;
  id: string | null;
  specificity: number;
  order: number;
  body: Declarations;
};
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

// `prop: value; ...` as a map of lower-cased names to values and their `!important`.
export function declarations(text: string): Declarations {
  const out: Declarations = new Map();
  for (const part of text.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const colon = part.indexOf(":");
    if (colon < 1) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const raw = part
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    const important = /!\s*important\s*$/.test(raw);
    const value = raw.replace(/!\s*important\s*$/, "").trim();
    // Within one block a later declaration wins, except that a normal one never overrides an `!important` one.
    if (name && value && !(out.get(name)?.important && !important)) out.set(name, { value, important });
  }
  return out;
}

const SIMPLE = /^([a-z][a-z0-9]*)?(?:\.([a-z0-9_-]+))?$|^#([a-z0-9_-]+)$/i;
// A style sheet's simple rules appended to `rules` in document order; returns how many selectors were not simple.
export function addRules(sheet: string, rules: Rule[]): number {
  let unresolved = 0;
  const text = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  // At-rule blocks (`@media`, `@supports`) hold conditional rules: not resolved, counted once each.
  const flat = text.replace(/@[a-z-]+[^{;]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, () => {
    unresolved++;
    return "";
  });
  for (const match of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = declarations(match[2] ?? "");
    for (const raw of (match[1] ?? "").split(",")) {
      const selector = raw.trim().toLowerCase();
      if (!selector) continue;
      const simple = SIMPLE.exec(selector);
      if (!simple || (!simple[1] && !simple[2] && !simple[3])) {
        unresolved++;
        continue;
      }
      const [, tag = null, cls = null, id = null] = simple;
      const specificity = (id ? 10_000 : 0) + (cls ? 100 : 0) + (tag ? 1 : 0);
      rules.push({ tag, cls, id, specificity, order: rules.length, body });
    }
  }
  return unresolved;
}

// The declarations that apply to an element, by the cascade: normal rules by specificity then order, the inline style
// over them, then `!important` rules by specificity then order, the inline style's `!important` last (completion
// review: `!important` and stylesheet order decide, never the order of the class attribute).
export function cascade(
  rules: Rule[],
  tag: string,
  classes: string[],
  id: string,
  inline: Declarations,
): Map<string, string> {
  const matching = rules
    .filter(
      (r) =>
        (r.id === null || r.id === id) &&
        (r.cls === null || classes.includes(r.cls)) &&
        (r.tag === null || r.tag === tag) &&
        (r.id !== null || r.cls !== null || r.tag !== null),
    )
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  const out = new Map<string, string>();
  const apply = (body: Declarations, important: boolean) => {
    for (const [name, d] of body) if (d.important === important) out.set(name, d.value);
  };
  for (const r of matching) apply(r.body, false);
  apply(inline, false);
  for (const r of matching) apply(r.body, true);
  apply(inline, true);
  return out;
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
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
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

// The colour in a `background` shorthand: its tokens split outside parentheses, the first that reads as a colour.
function backgroundColour(value: string | undefined): Colour | null {
  if (!value) return null;
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
  for (const t of tokens) {
    const c = readColour(t);
    if (c) return c;
  }
  return null;
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
  const m = /^(-?[\d.]+)(px|pt)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number.parseFloat(m[1] as string);
  return m[2] === "pt" ? n * (4 / 3) : m[2] === "px" || n === 0 ? n : null;
};
// A font size in pixels, relative units taken against the parent's (`rem` against 16px); the parent's when unread.
const fontSize = (value: string | undefined, parent: number) => {
  if (!value) return parent;
  const absolute = px(value);
  if (absolute !== null) return absolute;
  const m = /^([\d.]+)(em|rem|%)$/.exec(value.trim());
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
export async function scanHtml(
  source: () => ReadableStream | string | Promise<ReadableStream | string>,
): Promise<Scan> {
  const rules: Rule[] = [];
  const sheet = await sheets(await source());
  const unresolvedRules = addRules(sheet.text, rules) + (sheet.cut ? 1 : 0);
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
  const hidden: HiddenSpan[] = [];
  let omittedSpans = 0;
  let visible = "";
  let open: { reason: HiddenReason; text: string; tail: string; beforeVisible: boolean; instruction: boolean } | null =
    null;
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
    if (open?.text.trim())
      keep({
        text: open.text.replace(/\s+/g, " ").trim(),
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
    }
    // Instruction words are looked for across chunk boundaries (the last 64 characters carried over), the text kept up
    // to MAX_SPAN_CHARS.
    const window = open.tail + text;
    if (!open.instruction && INSTRUCTION.test(window)) open.instruction = true;
    open.tail = window.slice(-64);
    if (open.text.length < MAX_SPAN_CHARS) open.text += text.slice(0, MAX_SPAN_CHARS - open.text.length);
  };
  const addVisible = (text: string) => {
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
    if (reasonOf(state) && open) open.text += " ";
    else if (!reasonOf(state)) addVisible(separator);
  };

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();
        const parent = top();
        const classes = (element.getAttribute("class") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const id = (element.getAttribute("id") ?? "").toLowerCase();
        const d = cascade(rules, tag, classes, id, declarations(element.getAttribute("style") ?? ""));
        const readOrCount = (value: string | undefined | null, read: (v: string) => Colour | null) => {
          if (value === undefined || value === null || value === "") return null;
          const c = read(value);
          if (c === null && !/^(inherit|initial|unset|currentcolor|none)$/.test(value.trim())) unreadColours++;
          return c;
        };
        const bg =
          readOrCount(d.get("background-color"), readColour) ??
          readOrCount(d.get("background"), (v) => backgroundColour(v)) ??
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
    visible: visible
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

// The case's hidden text and visible text, for the `checks` step: the summary's HTML gives both; each HTML part cut for
// reading is scanned whole from R2, in its own charset, for evidence only, a span the summary already gave not repeated.
// A part whose object is missing or whose charset cannot be decoded is named as not scanned; any other storage or
// stream error is thrown, so the step is retried.
export async function hiddenTextOf(
  bucket: R2Bucket,
  summary: {
    html: string | null;
    text: string | null;
    truncated: readonly { mediaType: string; charset: string | null; key: string }[];
  },
): Promise<{ hidden: HiddenText; visible: string }> {
  const spans: HiddenText["spans"] = [];
  const notScanned: HiddenText["notScanned"] = [];
  let unresolvedRules = 0;
  let unreadColours = 0;
  let omittedSpans = 0;
  let visible = summary.text ?? "";
  let visibleFromWholePart = false;
  if (summary.html !== null) {
    const html = summary.html;
    const scan = await scanHtml(() => html);
    spans.push(...scan.hidden.map((h) => ({ ...h, part: "summary" })));
    unresolvedRules += scan.unresolvedRules;
    unreadColours += scan.unreadColours;
    omittedSpans += scan.omittedSpans;
    visible = scan.visible;
  }
  for (const part of summary.truncated) {
    if (part.mediaType.split(";")[0]?.trim().toLowerCase() !== "text/html") continue;
    const charset = part.charset ?? "utf-8";
    try {
      new TextDecoder(charset);
    } catch {
      notScanned.push({ key: part.key, why: "charset" });
      continue;
    }
    if (!(await bucket.head(part.key))) {
      notScanned.push({ key: part.key, why: "missing" });
      continue;
    }
    // Each pass reads the object afresh, decoded from its charset and encoded again as UTF-8 for the parser.
    const open = async () => {
      const object = await bucket.get(part.key);
      if (!object) throw new Error(`the cut part ${part.key} disappeared while it was read`);
      return object.body.pipeThrough(new TextDecoderStream(charset)).pipeThrough(new TextEncoderStream());
    };
    const scan = await scanHtml(open);
    unresolvedRules += scan.unresolvedRules;
    unreadColours += scan.unreadColours;
    omittedSpans += scan.omittedSpans;
    for (const span of scan.hidden) {
      // A span already kept from another reading of the same text (the summary's prefix, or the same part listed again)
      // is not repeated; the longer reading is kept.
      const at = spans.findIndex((s) => s.reason === span.reason && span.text.startsWith(s.text));
      if (at >= 0) {
        if ((spans[at] as HiddenSpan).text.length < span.text.length) spans[at] = { ...span, part: part.key };
      } else spans.push({ ...span, part: part.key });
    }
    // The part the summary's HTML was cut from: its whole scan gives the visible text, so a rule after the cut that
    // hides text before it takes that text out of what the model reads (completion review).
    if (!visibleFromWholePart && summary.html !== null && (await startsAs(bucket, part.key, charset, summary.html))) {
      visible = scan.visible;
      visibleFromWholePart = true;
    }
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

// Whether a stored part begins as the summary's HTML does (its first 512 characters, whitespace aside).
async function startsAs(bucket: R2Bucket, key: string, charset: string, html: string): Promise<boolean> {
  const head = await bucket.get(key, { range: { offset: 0, length: 4096 } });
  if (!head) return false;
  const text = new TextDecoder(charset).decode(await head.arrayBuffer());
  const squash = (t: string) => t.replace(/\s+/g, "").slice(0, 512);
  return squash(text).startsWith(squash(html).slice(0, Math.min(512, squash(text).length)));
}
