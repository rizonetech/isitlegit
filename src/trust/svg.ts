// The SVG half of a protected identity's logo (D05 T01 §1): an uploaded SVG rebuilt from an allowlist before it is
// stored. Its own module, free of Worker bindings, so the render test in Node (test/node/logo-render.test.ts) can
// prove a rebuilt logo draws exactly as the upload did.
import { IdentityRefused } from "./errors";

// SVG is XML and its names are case-sensitive and namespaced (Namespaces in XML 1.0; SVG 1.1): an element is kept only
// when it is in the SVG namespace and its local name is exactly one of these, an attribute only when it is
// unprefixed and exactly one of these, or is `href` in the XLink namespace. Nothing is compared case-insensitively,
// so the output never spells a name the upload did not (round 3), and a name SVG does not know is simply dropped.
const ELEMENTS = new Set(
  (
    "svg g defs title desc path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient " +
    "stop clipPath mask pattern use symbol"
  ).split(" "),
);
const DRAWABLE = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "use"]);
// Geometry and presentation attributes; no event handler, script or external reference is among them.
const ATTRIBUTES = new Set(
  (
    "id class viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points transform fill fill-opacity fill-rule " +
    "stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray " +
    "stroke-dashoffset opacity offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy " +
    "clip-path clip-rule clipPathUnits mask maskUnits patternUnits patternTransform preserveAspectRatio " +
    "font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing dx dy style " +
    "version href visibility display color"
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
// Rebuilds an SVG from the allowlist, reading it as XML with namespaces: each prefix resolved through the
// declarations in scope (an unbound prefix is malformed), one root `svg` element, elements outside the SVG namespace
// or the list dropped with their content, attributes outside the list dropped, every attribute value decoded and
// checked as the renderer would read it, comments, processing instructions and CDATA dropped, and a DOCTYPE (which
// could declare entities) refused. The output declares its own namespaces on its root (the SVG namespace by default,
// `xlink` for `xlink:href`), so it is namespace-valid whatever the upload declared. Linear in the input. Throws
// `IdentityRefused` when the result is not a usable image.
export function sanitiseSvg(source: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new IdentityRefused("the SVG declares a document type, which is not allowed");
  if (notXml(source)) throw new IdentityRefused("the SVG holds a character XML does not allow");
  const out: string[] = [];
  // Each open element: its name as written (to match its end tag), whether it is kept, and the prefixes in scope.
  const stack: { raw: string; local: string; kept: boolean; ns: Map<string, string> }[] = [];
  let skipping = 0;
  let rootDone = false;
  let rootSeen = false;
  let drawable = false;
  const tag =
    /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g;
  // An upload with no default namespace declared is read as SVG, as a browser reading an SVG file does.
  const initial = new Map([
    ["", SVG_NS],
    ["xml", "http://www.w3.org/XML/1998/namespace"],
  ]);
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
    if (closing) {
      const open = stack.pop();
      if (!open || open.raw !== raw) throw new IdentityRefused("the SVG is not well formed");
      if (!open.kept) skipping--;
      else if (!skipping) out.push(`</${open.local}>`);
      if (!stack.length) rootDone = true;
      continue;
    }
    if (rootDone) throw new IdentityRefused("the SVG has more than one root element");
    if (stack.length >= MAX_SVG_DEPTH) throw new IdentityRefused("the SVG is nested too deeply");
    // The attributes, read once: duplicates refused, values decoded, and this element's namespace declarations.
    const ns = new Map(stack.at(-1)?.ns ?? initial);
    const attrs: { name: string; value: string }[] = [];
    const seen = new Set<string>();
    for (const a of (m[3] ?? "").matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const name = a[1] ?? "";
      // An attribute given twice makes the element malformed (XML 1.0, Well-formedness constraint: Unique Att Spec).
      if (seen.has(name)) throw new IdentityRefused("the SVG gives an attribute twice");
      seen.add(name);
      const value = xmlDecode(a[2] ?? a[3] ?? a[4] ?? "");
      if (value === null) throw new IdentityRefused("the SVG uses an entity or character it may not");
      if (name === "xmlns") ns.set("", value);
      else if (name.startsWith("xmlns:")) ns.set(name.slice(6), value);
      else attrs.push({ name, value });
    }
    const resolve = (qname: string, forElement: boolean): { uri: string | null; local: string } => {
      const colon = qname.indexOf(":");
      if (colon < 0) return { uri: forElement ? (ns.get("") ?? null) : null, local: qname };
      const prefix = qname.slice(0, colon);
      const uri = ns.get(prefix);
      if (uri === undefined) throw new IdentityRefused("the SVG uses a namespace prefix it does not declare");
      return { uri, local: qname.slice(colon + 1) };
    };
    const element = resolve(raw, true);
    const isSvg = element.uri === SVG_NS;
    if (!rootSeen) {
      if (!isSvg || element.local !== "svg") throw new IdentityRefused("the file is not an SVG image");
      rootSeen = true;
    }
    const kept = !skipping && isSvg && ELEMENTS.has(element.local);
    if (kept) {
      const written: string[] = [];
      for (const { name, value } of attrs) {
        const attr = resolve(name, false);
        const spelled =
          attr.uri === null && ATTRIBUTES.has(attr.local)
            ? attr.local
            : attr.uri === XLINK_NS && attr.local === "href"
              ? "xlink:href"
              : null;
        if (spelled && safeValue(spelled, value)) written.push(` ${spelled}="${escapeAttr(value)}"`);
      }
      const declare = stack.length === 0 ? ` xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}"` : "";
      out.push(`<${element.local}${declare}${written.join("")}${selfClosing ? "/" : ""}>`);
      if (DRAWABLE.has(element.local)) drawable = true;
    }
    if (selfClosing) {
      if (!stack.length) rootDone = true;
    } else {
      stack.push({ raw, local: element.local, kept, ns });
      if (!kept) skipping++;
    }
  }
  if (source.slice(last).trim()) throw new IdentityRefused("the SVG has text outside its root element");
  if (!rootSeen) throw new IdentityRefused("the file is not an SVG image");
  if (stack.length) throw new IdentityRefused("the SVG is not well formed");
  if (!drawable) throw new IdentityRefused("the SVG has nothing to draw once its scripts and links are removed");
  return out.join("");
}
