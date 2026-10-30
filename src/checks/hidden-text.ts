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
export type HiddenSpan = { text: string; reason: HiddenReason; beforeVisible: boolean };
export type Scan = { hidden: HiddenSpan[]; visible: string; unresolvedRules: number };

// The most hidden text kept from one scan, and the most visible text: bounded, whatever the HTML holds.
export const MAX_HIDDEN_SPANS = 200;
export const MAX_SPAN_CHARS = 2_000;
export const MAX_VISIBLE_CHARS = 1024 * 1024;

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

type Declarations = Map<string, string>;
type Rules = { tag: Map<string, Declarations>; cls: Map<string, Declarations>; id: Map<string, Declarations> };
type State = { tag: string; hidden: HiddenReason | null; color: Rgb | null; background: Rgb; silent: boolean };
type Rgb = [number, number, number];

// `prop: value; ...` as a map, lower-cased names, `!important` dropped (the last wins, as in a browser for equal weight).
export function declarations(text: string): Declarations {
  const out: Declarations = new Map();
  for (const part of text.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const colon = part.indexOf(":");
    if (colon < 1) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part
      .slice(colon + 1)
      .replace(/!\s*important/i, "")
      .trim()
      .toLowerCase();
    if (name && value) out.set(name, value);
  }
  return out;
}

const SIMPLE = /^([a-z][a-z0-9]*)?(?:\.([a-z0-9_-]+))?$|^#([a-z0-9_-]+)$/i;
// A `<style>` sheet's simple rules added to `rules`; returns how many selectors were not simple (not resolved).
export function addRules(sheet: string, rules: Rules): number {
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
      const [, tag, cls, id] = simple;
      const target = id ? rules.id : cls ? rules.cls : rules.tag;
      const key = id ?? (cls ? `${tag ?? ""}.${cls}` : (tag as string));
      target.set(key, new Map([...(target.get(key) ?? []), ...body]));
    }
  }
  return unresolved;
}

// The CSS named colours a near-background match turns on most: the basic sixteen, white's near neighbours and greys.
const NAMED: Record<string, Rgb> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  red: [255, 0, 0],
  lime: [0, 255, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  aqua: [0, 255, 255],
  cyan: [0, 255, 255],
  fuchsia: [255, 0, 255],
  magenta: [255, 0, 255],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  maroon: [128, 0, 0],
  olive: [128, 128, 0],
  navy: [0, 0, 128],
  purple: [128, 0, 128],
  teal: [0, 128, 128],
  whitesmoke: [245, 245, 245],
  snow: [255, 250, 250],
  ivory: [255, 255, 240],
  ghostwhite: [248, 248, 255],
  floralwhite: [255, 250, 240],
  azure: [240, 255, 255],
  mintcream: [245, 255, 250],
  aliceblue: [240, 248, 255],
  seashell: [255, 245, 238],
  linen: [250, 240, 230],
  oldlace: [253, 245, 230],
  honeydew: [240, 255, 240],
  lavenderblush: [255, 240, 245],
  gainsboro: [220, 220, 220],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
};

// A colour value as RGB, or null for one not read (a gradient, an image, `transparent`, a variable).
export function parseColor(value: string | null | undefined): Rgb | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    const h = hex[1] as string;
    const full = h.length <= 4 ? [...h.slice(0, 3)].map((c) => c + c).join("") : h.slice(0, 6);
    const alpha = h.length === 4 ? (h[3] ?? null) : h.length === 8 ? h.slice(6) : null;
    if (alpha !== null && Number.parseInt(alpha.length === 1 ? alpha + alpha : alpha, 16) === 0) return null;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as Rgb;
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (rgb) {
    if (rgb[4] !== undefined && Number.parseFloat(rgb[4]) === 0) return null;
    return [rgb[1], rgb[2], rgb[3]].map((c) =>
      Math.min(255, c?.endsWith("%") ? Math.round(Number.parseFloat(c) * 2.55) : Number.parseFloat(c ?? "0")),
    ) as Rgb;
  }
  return Object.hasOwn(NAMED, v) ? (NAMED[v] as Rgb) : null;
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

// The hiding a set of declarations applies to its element, or null.
function hiding(d: Declarations): HiddenReason | null {
  if (d.get("display") === "none") return "display:none";
  if (/^(hidden|collapse)$/.test(d.get("visibility") ?? "")) return "visibility:hidden";
  const size = d.get("font-size");
  if (size !== undefined && ((px(size) ?? 2) < 2 || /^0(\.0+)?(em|rem|%)$/.test(size))) return "font-size";
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
export const isPreheader = (span: HiddenSpan) =>
  span.beforeVisible && span.text.length < 120 && !INSTRUCTION.test(span.text);

// Scans an HTML stream, returning the hidden spans (merged per element and reason, bounded), the visible text (bounded)
// and the count of style rules not resolved.
// Every `<style>` sheet's text in a document, in order (the first pass: a rule applies wherever it sits).
async function sheets(html: ReadableStream | string): Promise<string> {
  let all = "";
  await new HTMLRewriter()
    .on("style", {
      text(chunk) {
        all += chunk.text;
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .arrayBuffer();
  return all;
}

// `source` gives the HTML afresh each time it is called: it is read twice, once for the rules, once to classify.
export async function scanHtml(
  source: () => ReadableStream | string | Promise<ReadableStream | string>,
): Promise<Scan> {
  const rules: Rules = { tag: new Map(), cls: new Map(), id: new Map() };
  const unresolvedRules = addRules(await sheets(await source()), rules);
  const html = await source();
  const root: State = { tag: "#root", hidden: null, color: null, background: [255, 255, 255], silent: false };
  const stack: State[] = [root];
  const hidden: HiddenSpan[] = [];
  let visible = "";
  let open: { reason: HiddenReason; text: string; beforeVisible: boolean; owner: State } | null = null;
  const flush = () => {
    if (open?.text.trim() && hidden.length < MAX_HIDDEN_SPANS)
      hidden.push({
        text: open.text.replace(/\s+/g, " ").trim().slice(0, MAX_SPAN_CHARS),
        reason: open.reason,
        beforeVisible: open.beforeVisible,
      });
    open = null;
  };
  const top = () => stack[stack.length - 1] as State;

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();
        const parent = top();
        const classes = (element.getAttribute("class") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const id = (element.getAttribute("id") ?? "").toLowerCase();
        // Specificity in order: tag, then class (bare, then tag.class), then id, then the inline style.
        const merged: Declarations = new Map([
          ...(rules.tag.get(tag) ?? []),
          ...classes.flatMap((c) => [...(rules.cls.get(`.${c}`) ?? []), ...(rules.cls.get(`${tag}.${c}`) ?? [])]),
          ...(id ? (rules.id.get(id) ?? []) : []),
          ...declarations(element.getAttribute("style") ?? ""),
        ]);
        const bgcolor = parseColor(element.getAttribute("bgcolor"));
        const background =
          parseColor(merged.get("background-color")) ??
          parseColor((merged.get("background") ?? "").split(/\s+/)[0]) ??
          bgcolor ??
          parent.background;
        const own = element.hasAttribute("hidden") ? "hidden-attribute" : hiding(merged);
        const state: State = {
          tag,
          hidden: parent.hidden ?? own,
          color: parseColor(merged.get("color") ?? element.getAttribute("color")) ?? parent.color,
          background,
          silent: parent.silent || NOT_TEXT.has(tag),
        };
        if (VOID.has(tag)) return;
        stack.push(state);
        element.onEndTag(() => {
          // Pop to this element, closing any left open inside it (HTML's implied end tags).
          const at = stack.lastIndexOf(state);
          if (at > 0) stack.length = at;
        });
      },
    })
    .onDocument({
      comments(comment) {
        // A conditional comment (`[if mso]`) is markup for Outlook, not text.
        if (/^\s*\[if\b|^\s*<!\[endif\]/i.test(comment.text) || top().silent) return;
        flush();
        open = { reason: "comment", text: comment.text, beforeVisible: !visible.trim(), owner: top() };
        flush();
      },
      text(chunk) {
        const state = top();
        if (state.silent || !chunk.text) return;
        const near =
          state.color !== null && deltaE(state.color, state.background) < 3 ? ("color-match" as const) : null;
        const reason = state.hidden ?? near;
        if (!reason) {
          if (chunk.text.trim()) flush();
          if (visible.length < MAX_VISIBLE_CHARS) visible += chunk.text;
          return;
        }
        // One span for a run of text hidden the same way, across the elements inside it.
        if (!open || open.reason !== reason) {
          flush();
          open = { reason, text: "", beforeVisible: !visible.trim(), owner: state };
        }
        open.text += chunk.text;
      },
    });
  await rewriter.transform(new Response(html, { headers: { "content-type": "text/html" } })).arrayBuffer();
  flush();
  return {
    hidden,
    visible: visible
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n\s*\n+/g, "\n\n")
      .trim(),
    unresolvedRules,
  };
}

export type HiddenText = {
  spans: (HiddenSpan & { part: string })[];
  unresolvedRules: number;
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
  let visible = summary.text ?? "";
  if (summary.html !== null) {
    const html = summary.html;
    const scan = await scanHtml(() => html);
    spans.push(...scan.hidden.map((h) => ({ ...h, part: "summary" })));
    unresolvedRules += scan.unresolvedRules;
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
    for (const span of scan.hidden) {
      const repeated = spans.some((s) => s.reason === span.reason && span.text.startsWith(s.text));
      if (repeated) {
        // The full part's span replaces the summary's prefix of it.
        const at = spans.findIndex((s) => s.reason === span.reason && span.text.startsWith(s.text));
        spans[at] = { ...span, part: part.key };
      } else spans.push({ ...span, part: part.key });
    }
  }
  return { hidden: { spans: spans.slice(0, MAX_HIDDEN_SPANS), unresolvedRules, notScanned }, visible };
}
