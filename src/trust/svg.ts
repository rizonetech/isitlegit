// The SVG half of a protected identity's logo (D05 T01 §1): an uploaded SVG rebuilt from an allowlist before it is
// stored. Its own module, free of Worker bindings, so the render test in Node (test/node/logo-render.test.ts) can
// prove a rebuilt logo draws exactly as the upload did.
import { IdentityRefused } from "./errors";

const ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "pattern",
  "use",
  "symbol",
]);
const DRAWABLE = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "use"]);
// Geometry and presentation attributes; no event handler, script or external reference is among them.
const ATTRIBUTES = new Set(
  (
    "id class viewbox width height x y x1 y1 x2 y2 cx cy r rx ry d points transform fill fill-opacity fill-rule " +
    "stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray " +
    "stroke-dashoffset opacity offset stop-color stop-opacity gradientunits gradienttransform spreadmethod fx fy " +
    "clip-path clip-rule clippathunits mask maskunits patternunits patterntransform preserveaspectratio " +
    "font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing dx dy style " +
    "version href xlink:href visibility display color"
  ).split(" "),
);
const MAX_SVG_DEPTH = 64;
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

// XML's character references and predefined entities decoded (XML 1.0 section 4.1), so a value is checked as the
// renderer reads it: `u&#114;l(` is `url(` (completion review).
const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function xmlDecode(s: string): string | null {
  let bad = false;
  const out = s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]+);?/g, (_m, ref: string) => {
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      if (!Number.isFinite(code) || code > 0x10ffff) {
        bad = true;
        return "";
      }
      // Only characters XML allows (XML 1.0 section 2.2, Char): a reference to NUL or a lone surrogate is malformed.
      if (!xmlChar(code)) {
        bad = true;
        return "";
      }
      return String.fromCodePoint(code);
    }
    const named = XML_ENTITIES[ref];
    if (named === undefined) bad = true;
    return named ?? "";
  });
  return bad ? null : out;
}

const xmlChar = (c: number) =>
  c === 0x9 ||
  c === 0xa ||
  c === 0xd ||
  (c >= 0x20 && c <= 0xd7ff) ||
  (c >= 0xe000 && c <= 0xfffd) ||
  (c >= 0x10000 && c <= 0x10ffff);
// Whether the document holds a raw character XML does not allow (a control character, a lone surrogate), checked
// code point by code point.
function notXml(source: string): boolean {
  for (const ch of source) if (!xmlChar(ch.codePointAt(0) as number)) return true;
  return false;
}

// A reference is allowed only to a fragment of the same document: `#id` or `url(#id)`. A value is judged after
// decoding; one with a CSS escape (`\75 rl(`) is refused outright rather than decoded, since nothing an artist
// exports needs one.
function safeValue(name: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (name === "href" || name === "xlink:href") return v.startsWith("#");
  if (v.includes("\\")) return false;
  if (/@import|expression\s*\(|javascript:|data:|vbscript:/.test(v)) return false;
  for (const m of v.matchAll(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/g))
    if (!(m[2] ?? "").trim().startsWith("#")) return false;
  // `url(` that the pattern above could not read (an unclosed one) is refused too.
  return (v.match(/url\s*\(/g) ?? []).length === [...v.matchAll(/url\s*\(\s*(['"]?)[^)'"]*\1\s*\)/g)].length;
}

// Rebuilds an SVG from the allowlist: one root `svg` element, elements outside the list dropped with their content,
// attributes outside it dropped, names kept in the case SVG gives them (`viewBox`, `linearGradient` are
// case-sensitive), every attribute value decoded and checked as the renderer would read it, comments, processing
// instructions and CDATA dropped, and a DOCTYPE (which could declare entities) refused. Linear in the input. Throws
// `IdentityRefused` when the result is not a usable image.
export function sanitiseSvg(source: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new IdentityRefused("the SVG declares a document type, which is not allowed");
  if (notXml(source)) throw new IdentityRefused("the SVG holds a character XML does not allow");
  const out: string[] = [];
  const stack: { name: string; kept: boolean }[] = [];
  let skipping = 0;
  let rootDone = false;
  let rootSeen = false;
  let drawable = false;
  const tag =
    /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g;
  let last = 0;
  for (let m = tag.exec(source); m; m = tag.exec(source)) {
    const text = source.slice(last, m.index);
    last = m.index + m[0].length;
    if (text.includes("<")) throw new IdentityRefused("the SVG is not well formed");
    if (!skipping && stack.length && text.trim()) {
      const decoded = xmlDecode(text);
      if (decoded === null) throw new IdentityRefused("the SVG uses an entity it does not declare");
      out.push(escapeText(decoded));
    } else if (!stack.length && text.trim()) throw new IdentityRefused("the SVG has text outside its root element");
    if (!m[2]) continue; // a comment, processing instruction or CDATA section
    const closing = m[1] === "/";
    const selfClosing = m[4] === "/";
    const raw = m[2];
    const local = raw.includes(":") ? (raw.split(":").pop() as string) : raw;
    const name = local.toLowerCase();
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== local) throw new IdentityRefused("the SVG is not well formed");
      if (!open.kept) skipping--;
      else if (!skipping) out.push(`</${local}>`);
      if (!stack.length) rootDone = true;
      continue;
    }
    if (rootDone) throw new IdentityRefused("the SVG has more than one root element");
    if (!rootSeen) {
      if (name !== "svg") throw new IdentityRefused("the file is not an SVG image");
      rootSeen = true;
    }
    if (stack.length >= MAX_SVG_DEPTH) throw new IdentityRefused("the SVG is nested too deeply");
    const kept = !skipping && ELEMENTS.has(name);
    if (kept) {
      const attrs: string[] = [];
      const names = new Set<string>();
      for (const a of (m[3] ?? "").matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        const attr = a[1] ?? "";
        // An attribute given twice makes the element malformed (XML 1.0, Well-formedness constraint: Unique Att Spec).
        if (names.has(attr)) throw new IdentityRefused("the SVG gives an attribute twice");
        names.add(attr);
        const decoded = xmlDecode(a[2] ?? a[3] ?? a[4] ?? "");
        if (decoded === null) throw new IdentityRefused("the SVG uses an entity or character it may not");
        if (decoded !== null && ATTRIBUTES.has(attr.toLowerCase()) && safeValue(attr.toLowerCase(), decoded))
          attrs.push(` ${attr}="${escapeAttr(decoded)}"`);
      }
      // The rebuilt document declares its own namespaces: the root binds the SVG namespace and `xlink` (the only
      // prefix an allowed attribute uses), elements are written unprefixed in it, and the source's own declarations
      // are dropped, so the output is namespace-valid whatever the upload declared (round 2: an unbound `xlink:`).
      const declare = stack.length === 0 ? ` xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}"` : "";
      out.push(`<${local}${declare}${attrs.join("")}${selfClosing ? "/" : ""}>`);
      if (DRAWABLE.has(name)) drawable = true;
    }
    if (selfClosing) {
      if (!stack.length) rootDone = true;
    } else {
      stack.push({ name: local, kept });
      if (!kept) skipping++;
    }
  }
  if (source.slice(last).trim()) throw new IdentityRefused("the SVG has text outside its root element");
  if (!rootSeen) throw new IdentityRefused("the file is not an SVG image");
  if (stack.length) throw new IdentityRefused("the SVG is not well formed");
  if (!drawable) throw new IdentityRefused("the SVG has nothing to draw once its scripts and links are removed");
  return out.join("");
}
