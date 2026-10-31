// What a PDF's pages draw, for the forensics (D06 T02 §1; ISO 32000-1 sections 8 and 9): each text run with its font
// and its box on the page, and each image with its box, in painting order. It interprets the content stream operators
// that place text and images (graphics state, text objects and positioning, text showing, XObjects and inline images)
// and ignores the rest, since forensics asks where things are, not how they look. Widths come from the font's own
// width tables; a font without them is taken at half an em a glyph, close enough to tell what overlaps what.
import {
  type Budget,
  byteString,
  dictOf,
  isDict,
  isName,
  isOp,
  isStream,
  isString,
  Lexer,
  newBudget,
  note,
  OverBudget,
  type PdfDict,
  type PdfFile,
  type PdfObject,
  type PdfOperator,
  type PdfRef,
  type PdfStream,
  PdfSyntax,
  type PdfValue,
  resolve,
  streamData,
} from "./pdf";

export const MAX_PAGES = 200;
export const MAX_RUNS = 20_000;
export const MAX_FORM_DEPTH = 8;
export const MAX_WIDTHS = 2 * 65_536;
export const MAX_RUN_CODES = 16_384;
// The text one code may map to, in UTF-16 units, and the text a whole file's runs may hold: what a hostile font map
// could multiply is bounded twice (round 7: one code to 256 characters retained 160 MiB).
export const MAX_MAPPED = 8;
export const MAX_TEXT = 2 * 1024 * 1024;
const INLINE_END = /\sEI(?=\s|$)/g;

type Matrix = [number, number, number, number, number, number];
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type TextRun = {
  page: number;
  // Whether the text is painted at all (render modes 3 and 7 draw nothing, as a scan's OCR layer does; 9.3.6).
  visible: boolean;
  // The font object's number (its identity across pages), or -1 for a font defined inline.
  fontId: number;
  font: string;
  size: number;
  text: string;
  box: Box;
  seq: number;
};
// An image as drawn: its box after the clipping rectangles in force, whether it is opaque (no soft mask, no constant
// alpha below 1), and whether a clip of another shape left its painted area unknown.
export type ImageDraw = { page: number; box: Box; seq: number; inline: boolean; opaque: boolean; clipKnown: boolean };
export type PageContent = { index: number; box: Box; runs: TextRun[]; images: ImageDraw[] };
export type Content = { pages: PageContent[]; fonts: Map<number, string> };

const overlaps = (a: Box, b: Box) =>
  Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
const intersect = (a: Box, b: Box): Box => ({
  x0: Math.max(a.x0, b.x0),
  y0: Math.max(a.y0, b.y0),
  x1: Math.min(a.x1, b.x1),
  y1: Math.min(a.y1, b.y1),
});

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
function boxOf(m: Matrix, x0: number, y0: number, x1: number, y1: number): Box {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
const matrixOf = (v: PdfValue | undefined): Matrix | null =>
  Array.isArray(v) && v.length === 6 && v.every((n) => typeof n === "number") ? (v as Matrix) : null;

// A font as the interpreter needs it: how to split a string into codes, each code's text and width.
type Font = {
  id: number;
  name: string;
  bytesPerCode: 1 | 2;
  text: (code: number) => string;
  width: (code: number) => number; // in thousandths of an em
};

// Glyph names a simple font's /Differences commonly uses for the characters forensics reads (amounts, account numbers).
const GLYPHS: Record<string, string> = {
  space: " ",
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  period: ".",
  comma: ",",
  hyphen: "-",
  colon: ":",
  slash: "/",
  parenleft: "(",
  parenright: ")",
  numbersign: "#",
  percent: "%",
  ampersand: "&",
  plus: "+",
};

// A ToUnicode CMap (9.10.3): its codespace, bfchar and bfrange entries, read with the PDF lexer (a CMap's syntax is
// PostScript's, which the lexer reads), so the read is linear in the stream and charged to the shared budget whatever
// the blocks look like: a block left open costs nothing extra (round 4, where a lazy regex went quadratic). Every entry
// written counts, overwrites included, up to MAX_CMAP_WRITES (round 3).
export const MAX_CMAP_WRITES = 2 * 65_536;
export function toUnicode(
  cmap: string,
  budget: Budget = newBudget(),
): { map: Map<number, string>; bytes: 1 | 2; damaged: boolean } {
  const map = new Map<number, string>();
  let bytes: 1 | 2 = 2;
  let writes = 0;
  const write = (code: number, text: string) => {
    if (++writes > MAX_CMAP_WRITES) return false;
    map.set(code, text);
    return true;
  };
  const code = (v: PdfValue | PdfOperator | undefined): number | null => {
    if (!isString(v) || v.bytes.length < 1 || v.bytes.length > 4) return null;
    let n = 0;
    for (let i = 0; i < v.bytes.length; i++) n = n * 256 + v.bytes.charCodeAt(i);
    return n;
  };
  const text = (v: PdfValue | undefined): string => {
    if (!isString(v)) return "";
    // One code maps to a short string (a ligature is three letters); more than MAX_MAPPED units is cut (round 7).
    const b = v.bytes.slice(0, 2 * MAX_MAPPED);
    let out = "";
    for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode((b.charCodeAt(i) << 8) | b.charCodeAt(i + 1));
    return out;
  };
  const lex = new Lexer(cmap, budget);
  let mode: "none" | "space" | "char" | "range" = "none";
  // A block opened inside another, or never closed, or a stream that does not lex, is a damaged map: what it read is
  // kept, and the caller says the text may be incomplete (round 5).
  let damaged = false;
  const operands: (PdfValue | PdfOperator)[] = [];
  try {
    for (;;) {
      const t = lex.next(true);
      if (t === undefined || writes > MAX_CMAP_WRITES) break;
      if (isOp(t)) {
        const op = t.op;
        const opens = op === "begincodespacerange" || op === "beginbfchar" || op === "beginbfrange";
        if (opens && mode !== "none") damaged = true;
        if (op === "begincodespacerange") mode = "space";
        else if (op === "beginbfchar") mode = "char";
        else if (op === "beginbfrange") mode = "range";
        else if (op === "endcodespacerange" || op === "endbfchar" || op === "endbfrange") mode = "none";
        operands.length = 0;
        continue;
      }
      operands.push(t);
      if (mode === "space" && operands.length === 2) {
        const lo = operands[0];
        if (isString(lo) && lo.bytes.length === 1) bytes = 1;
        operands.length = 0;
      } else if (mode === "char" && operands.length === 2) {
        const c = code(operands[0]);
        if (c !== null && !write(c, text(operands[1] as PdfValue))) break;
        operands.length = 0;
      } else if (mode === "range" && operands.length === 3) {
        const lo = code(operands[0]);
        const hiRaw = code(operands[1]);
        const dst = operands[2] as PdfValue;
        operands.length = 0;
        if (lo === null || hiRaw === null) continue;
        const hi = Math.min(hiRaw, lo + 0xffff);
        if (Array.isArray(dst)) {
          for (const [i, x] of dst.slice(0, hi - lo + 1).entries()) if (!write(lo + i, text(x))) break;
        } else if (isString(dst)) {
          const base = text(dst);
          const prefix = base.slice(0, -1);
          const start = base.charCodeAt(base.length - 1) || 0;
          for (let c = lo; c <= hi; c++) {
            budget.tokens++;
            if (!write(c, prefix + String.fromCharCode(start + c - lo))) break;
          }
        }
      } else if (mode === "none" && operands.length > 64) operands.length = 0;
    }
  } catch (error) {
    if (!(error instanceof OverBudget) && !(error instanceof PdfSyntax)) throw error;
    damaged = true;
  }
  if (mode !== "none" || writes > MAX_CMAP_WRITES) damaged = true;
  return { map, bytes, damaged };
}

const baseName = (dict: PdfDict) => {
  const b = dict.entries.get("BaseFont");
  return isName(b) ? b.name : "unnamed";
};

export async function readContent(file: PdfFile): Promise<Content> {
  const fonts = new Map<number, string>();
  const fontCache = new Map<PdfDict, Font>();
  let runs = 0;
  let seq = 0;
  let textHeld = 0;
  const unreadOnce = (reason: string) => note(file, reason);

  async function fontOf(ref: PdfObject | undefined): Promise<Font | null> {
    const dict = dictOf(file, ref);
    if (!dict) return null;
    const cached = fontCache.get(dict);
    if (cached) return cached;
    const id = isRefLike(ref) ? ref.num : -1;
    const subtype = dict.entries.get("Subtype");
    const composite = isName(subtype, "Type0");
    let cmap: { map: Map<number, string>; bytes: 1 | 2; damaged: boolean } | null = null;
    const tu = resolve(file, dict.entries.get("ToUnicode"));
    if (isStream(tu)) {
      const data = await streamData(file, tu);
      if (data) cmap = toUnicode(byteString(data.subarray(0, 1024 * 1024)), file.budget);
      if (cmap?.damaged) unreadOnce("a font's text map is damaged, so some of its text may not have been read");
    }
    let name = baseName(dict);
    let width: (code: number) => number;
    if (composite) {
      const descendants = resolve(file, dict.entries.get("DescendantFonts"));
      const cid = Array.isArray(descendants) ? dictOf(file, descendants[0]) : null;
      if (cid && name === "unnamed") name = baseName(cid);
      const dw = cid?.entries.get("DW");
      const widths = new Map<number, number>();
      const w = resolve(file, cid?.entries.get("W"));
      if (Array.isArray(w)) {
        // Every width written counts, so ranges that overlap (and rewrite the same CIDs) stop at the same bound as ranges
        // that do not: at most MAX_WIDTHS writes a font, each charged to the shared budget (round 2).
        let writes = 0;
        const write = (cid: number, value: number) => {
          if (++writes > MAX_WIDTHS) return false;
          file.budget.tokens++;
          widths.set(cid, value);
          return true;
        };
        for (let i = 0; i < w.length && writes <= MAX_WIDTHS; ) {
          const first = w[i];
          const second = resolve(file, w[i + 1]);
          // A CID is 0 to 65535 (9.7.3); a range outside that, or not of whole numbers, ends the table.
          if (typeof first !== "number" || !Number.isInteger(first) || first < 0 || first > 0xffff) break;
          if (Array.isArray(second)) {
            for (const [j, x] of second.slice(0, 0x10000 - first).entries())
              if (typeof x === "number" && !write(first + j, x)) break;
            i += 2;
          } else if (typeof second === "number" && typeof w[i + 2] === "number") {
            const last = Math.min(Number.isInteger(second) ? second : -1, 0xffff, first + 0xffff);
            for (let c = first; c <= last; c++) if (!write(c, w[i + 2] as number)) break;
            i += 3;
          } else break;
        }
      }
      const fallback = typeof dw === "number" ? dw : 1000;
      width = (code) => widths.get(code) ?? fallback;
    } else {
      const first = resolve(file, dict.entries.get("FirstChar"));
      const list = resolve(file, dict.entries.get("Widths"));
      const descriptor = dictOf(file, dict.entries.get("FontDescriptor"));
      const missing = descriptor?.entries.get("MissingWidth");
      width = (code) => {
        if (Array.isArray(list) && typeof first === "number") {
          const v = resolve(file, list[code - first]);
          if (typeof v === "number") return v;
        }
        return typeof missing === "number" && missing > 0 ? missing : 500;
      };
    }
    const differences = new Map<number, string>();
    const enc = resolve(file, dict.entries.get("Encoding"));
    if (isDict(enc)) {
      const diff = resolve(file, enc.entries.get("Differences"));
      if (Array.isArray(diff)) {
        let code = 0;
        for (const d of diff.slice(0, 1024)) {
          if (typeof d === "number") code = d;
          else if (isName(d)) {
            differences.set(code, d.name.length === 1 ? d.name : (GLYPHS[d.name] ?? "�"));
            code++;
          }
        }
      }
    }
    const bytesPerCode: 1 | 2 = composite ? (cmap?.bytes ?? 2) : 1;
    const text = (code: number) =>
      cmap?.map.get(code) ?? differences.get(code) ?? (composite ? "�" : String.fromCharCode(code));
    const font: Font = { id, name, bytesPerCode, text, width };
    fontCache.set(dict, font);
    if (id >= 0) fonts.set(id, name);
    return font;
  }

  const pages: PageContent[] = [];
  try {
    for (const page of pageList(file)) {
      if (pages.length >= MAX_PAGES) {
        unreadOnce(`pages after the first ${MAX_PAGES} were not read`);
        break;
      }
      const index = pages.length;
      const content: PageContent = { index, box: matrixBox(inherited(file, page, "MediaBox")), runs: [], images: [] };
      pages.push(content);
      const resources = dictOf(file, inherited(file, page, "Resources"));
      // A page without /Contents is blank (7.7.3.3); one whose /Contents does not resolve is missing.
      const declared = page.entries.get("Contents");
      const contents = declared === undefined ? [] : resolve(file, declared);
      const parts = Array.isArray(contents) ? contents.map((c) => resolve(file, c)) : [contents];
      const chunks: string[] = [];
      for (const part of parts) {
        if (!isStream(part)) {
          unreadOnce("a page's content is missing");
          continue;
        }
        const data = await streamData(file, part);
        if (data) chunks.push(byteString(data));
      }
      await interpret(chunks.join("\n"), resources, IDENTITY, content, new Set());
    }
  } catch (error) {
    if (!(error instanceof OverBudget)) throw error;
    unreadOnce(`the pages need more work to read than allowed (${error.message})`);
  }
  return { pages, fonts };

  async function interpret(
    src: string,
    resources: PdfDict | null,
    base: Matrix,
    page: PageContent,
    forms: Set<PdfStream>,
    // The caller's graphics state when a Form is drawn (8.10.1): its alpha and clip hold inside the Form.
    inherited?: Pick<State, "clip" | "clipKnown" | "alpha">,
  ): Promise<void> {
    const lex = new Lexer(src, file.budget);
    const operands: PdfValue[] = [];
    let g: State = {
      ctm: base,
      font: null,
      size: 0,
      tl: 0,
      tc: 0,
      tw: 0,
      th: 1,
      mode: 0,
      clip: inherited?.clip ?? null,
      clipKnown: inherited?.clipKnown ?? true,
      alpha: inherited?.alpha ?? 1,
    };
    const stack: State[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    // The current path, as far as a clip needs it: one rectangle (`re`), or a shape of another kind.
    let path: Box | "other" | null = null;
    let clipNext = false;
    const fontsByName = dictOf(file, resources?.entries.get("Font"));
    const xobjects = dictOf(file, resources?.entries.get("XObject"));
    const states = dictOf(file, resources?.entries.get("ExtGState"));

    const show = (s: string) => {
      const font = g.font;
      if (!font) return;
      const parts: string[] = [];
      let advance = 0;
      // A run's first MAX_RUN_CODES codes are read: a real line is far shorter, and a hostile one costs no more.
      if (s.length > MAX_RUN_CODES * font.bytesPerCode) unreadOnce("a text run was too long to read whole");
      const limit = Math.min(s.length, MAX_RUN_CODES * font.bytesPerCode);
      for (let i = 0; i < limit; i += font.bytesPerCode) {
        const code = font.bytesPerCode === 2 ? (s.charCodeAt(i) << 8) | (s.charCodeAt(i + 1) || 0) : s.charCodeAt(i);
        parts.push(font.text(code));
        advance += (font.width(code) / 1000) * g.size + g.tc + (font.bytesPerCode === 1 && code === 32 ? g.tw : 0);
      }
      advance *= g.th;
      let text = parts.join("");
      if (textHeld + text.length > MAX_TEXT) {
        unreadOnce(`text past the first ${MAX_TEXT / 1024 / 1024} MiB was not read`);
        text = text.slice(0, Math.max(0, MAX_TEXT - textHeld));
      }
      textHeld += text.length;
      if (text.length && runs < MAX_RUNS) {
        runs++;
        const m = mul(tm, g.ctm);
        const box = boxOf(m, 0, -0.2 * g.size, advance, 0.8 * g.size);
        page.runs.push({
          page: page.index,
          // Render modes 3 and 7 paint nothing (9.3.6), nor does a fill alpha of 0, nor text wholly outside the clip.
          visible: g.mode !== 3 && g.mode !== 7 && g.alpha > 0 && (!g.clip || overlaps(g.clip, box)),
          fontId: font.id,
          font: font.name,
          size: Math.abs(g.size * Math.hypot(m[2], m[3])),
          text,
          box,
          seq: seq++,
        });
      } else if (runs >= MAX_RUNS) unreadOnce(`text after the first ${MAX_RUNS} runs was not read`);
      tm = mul([1, 0, 0, 1, advance, 0], tm);
    };
    const nextLine = (tx: number, ty: number) => {
      tlm = mul([1, 0, 0, 1, tx, ty], tlm);
      tm = tlm;
    };
    const num = (i: number) => {
      const v = operands[operands.length - i];
      return typeof v === "number" ? v : 0;
    };
    const drawImage = (inline: boolean, masked: boolean) => {
      const drawn = boxOf(g.ctm, 0, 0, 1, 1);
      page.images.push({
        page: page.index,
        box: g.clip ? intersect(drawn, g.clip) : drawn,
        seq: seq++,
        inline,
        opaque: !masked && g.alpha >= 1,
        clipKnown: g.clipKnown,
      });
    };

    for (;;) {
      let token: ReturnType<Lexer["next"]>;
      try {
        token = lex.next(true);
      } catch (error) {
        if (error instanceof OverBudget) throw error;
        unreadOnce("a page's content could not be fully parsed");
        return;
      }
      if (token === undefined) return;
      if (!isOp(token)) {
        if (operands.length < 64) operands.push(token);
        continue;
      }
      const op = token.op;
      switch (op) {
        case "q":
          if (stack.length < 64) stack.push({ ...g });
          break;
        case "Q":
          g = stack.pop() ?? g;
          break;
        case "cm": {
          const m = matrixOf(operands.slice(-6) as PdfValue);
          if (m) g.ctm = mul(m, g.ctm);
          break;
        }
        case "gs": {
          const name = operands[operands.length - 1];
          const state = isName(name) ? dictOf(file, states?.entries.get(name.name)) : null;
          const ca = state?.entries.get("ca");
          const smask = state?.entries.get("SMask");
          if (typeof ca === "number") g.alpha = ca;
          if (smask !== undefined && !isName(smask, "None")) g.alpha = Math.min(g.alpha, 0.99);
          break;
        }
        case "re": {
          const [x, y, w, h] = [num(4), num(3), num(2), num(1)];
          const box = boxOf(g.ctm, Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h));
          path = path === null ? box : "other";
          break;
        }
        case "m":
        case "l":
        case "c":
        case "v":
        case "y":
        case "h":
          path = "other";
          break;
        case "W":
        case "W*":
          clipNext = true;
          break;
        case "n":
        case "f":
        case "F":
        case "f*":
        case "S":
        case "s":
        case "B":
        case "B*":
        case "b":
        case "b*":
          if (clipNext) {
            if (path === "other" || path === null) g.clipKnown = false;
            else g.clip = g.clip ? intersect(g.clip, path) : path;
          }
          clipNext = false;
          path = null;
          break;
        case "BT":
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case "Tf": {
          const name = operands[operands.length - 2];
          g.size = num(1);
          g.font = isName(name) ? await fontOf(fontsByName?.entries.get(name.name)) : null;
          if (!g.font) unreadOnce("a font a page uses is missing, so its text was not read");
          break;
        }
        case "Tr":
          g.mode = num(1);
          break;
        case "TL":
          g.tl = num(1);
          break;
        case "Tc":
          g.tc = num(1);
          break;
        case "Tw":
          g.tw = num(1);
          break;
        case "Tz":
          g.th = num(1) / 100;
          break;
        case "Td":
          nextLine(num(2), num(1));
          break;
        case "TD":
          g.tl = -num(1);
          nextLine(num(2), num(1));
          break;
        case "Tm": {
          const m = matrixOf(operands.slice(-6) as PdfValue);
          if (m) {
            tlm = m;
            tm = m;
          }
          break;
        }
        case "T*":
          nextLine(0, -g.tl);
          break;
        case "Tj":
        case "'":
        case '"': {
          if (op === '"') {
            g.tw = num(3);
            g.tc = num(2);
          }
          if (op !== "Tj") nextLine(0, -g.tl);
          const s = operands[operands.length - 1];
          if (isString(s)) show(s.bytes);
          break;
        }
        case "TJ": {
          const list = operands[operands.length - 1];
          if (Array.isArray(list))
            for (const item of list) {
              if (isString(item)) show(item.bytes);
              else if (typeof item === "number") tm = mul([1, 0, 0, 1, (-item / 1000) * g.size * g.th, 0], tm);
            }
          break;
        }
        case "Do": {
          const name = operands[operands.length - 1];
          const x = resolve(file, isName(name) ? xobjects?.entries.get(name.name) : undefined);
          if (!isStream(x)) {
            if (isName(name)) unreadOnce("an image or form a page draws is missing");
            break;
          }
          const sub = x.dict.entries.get("Subtype");
          if (isName(sub, "Image")) {
            const smask = x.dict.entries.get("SMask");
            const mask = x.dict.entries.get("Mask");
            drawImage(false, (smask !== undefined && smask !== null) || mask !== undefined);
          } else if (isName(sub, "Form")) {
            // A Form that draws itself, directly or through another, is drawn once (cycle detection).
            if (forms.has(x)) {
              unreadOnce("a form draws itself, so it was read once");
              break;
            }
            if (forms.size >= MAX_FORM_DEPTH) {
              unreadOnce("forms nested too deeply were not read");
              break;
            }
            const data = await streamData(file, x);
            if (!data) break;
            const m = matrixOf(resolve(file, x.dict.entries.get("Matrix")) as PdfValue) ?? IDENTITY;
            const own = dictOf(file, x.dict.entries.get("Resources")) ?? resources;
            // A Form paints only inside its /BBox (8.10.1), a clip intersected with the caller's.
            const bbox = resolve(file, x.dict.entries.get("BBox"));
            const formMatrix = mul(m, g.ctm);
            const bounds =
              Array.isArray(bbox) && bbox.length === 4 && bbox.every((n) => typeof n === "number")
                ? boxOf(formMatrix, ...(bbox as [number, number, number, number]))
                : null;
            const clip = bounds ? (g.clip ? intersect(g.clip, bounds) : bounds) : g.clip;
            const saved = { ...g };
            await interpret(byteString(data), own, formMatrix, page, new Set([...forms, x]), {
              clip,
              clipKnown: g.clipKnown,
              alpha: g.alpha,
            });
            g = saved;
          }
          break;
        }
        case "BI": {
          // An inline image (8.9.7): its data runs from `ID` to an `EI` between white space.
          // Both searches move forward from the lexer's position, which then moves past them: linear in the stream.
          const id = src.indexOf("ID", lex.pos);
          if (id < 0) return;
          INLINE_END.lastIndex = id + 2;
          const ei = INLINE_END.exec(src);
          if (!ei) return;
          lex.pos = ei.index + ei[0].length;
          drawImage(true, false);
          break;
        }
      }
      operands.length = 0;
    }
  }
}

type State = {
  ctm: Matrix;
  font: Font | null;
  size: number;
  tl: number;
  tc: number;
  tw: number;
  th: number;
  mode: number;
  clip: Box | null;
  clipKnown: boolean;
  // The fill alpha (`ca`, 11.6.4.4), which text and images are painted with; a soft mask counts as below 1.
  alpha: number;
};

const isRefLike = (v: unknown): v is PdfRef => typeof v === "object" && v !== null && (v as PdfRef).kind === "ref";

// A page attribute, inherited through the page tree (7.7.3.4).
function inherited(file: PdfFile, page: PdfDict, key: string): PdfObject | undefined {
  let node: PdfDict | null = page;
  for (let i = 0; node && i < 32; i++) {
    const v = node.entries.get(key);
    if (v !== undefined) return v;
    node = dictOf(file, node.entries.get("Parent"));
  }
  return undefined;
}

function matrixBox(v: PdfObject | undefined): Box {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number")
    ? { x0: v[0] as number, y0: v[1] as number, x1: v[2] as number, y1: v[3] as number }
    : { x0: 0, y0: 0, x1: 612, y1: 792 };
}

// The pages in order: the page tree from the catalog (7.7.3), or every page object when the tree cannot be walked.
export function pageList(file: PdfFile): PdfDict[] {
  const out: PdfDict[] = [];
  const seen = new Set<PdfDict>();
  const root = dictOf(file, file.trailer?.entries.get("Root"));
  const walk = (node: PdfDict | null, depth: number) => {
    if (node && seen.has(node)) note(file, "the page tree refers back to itself, so it was read once");
    if (node && depth > 32) note(file, "the page tree is nested too deeply to read whole");
    if (!node || seen.has(node) || depth > 32 || out.length > MAX_PAGES) return;
    seen.add(node);
    if (isName(node.entries.get("Type"), "Page")) {
      out.push(node);
      return;
    }
    const kids = resolve(file, node.entries.get("Kids"));
    if (Array.isArray(kids))
      for (const k of kids) {
        const kid = dictOf(file, k);
        if (!kid) note(file, "a page the document lists is missing");
        walk(kid, depth + 1);
      }
  };
  walk(root ? dictOf(file, root.entries.get("Pages")) : null, 0);
  if (out.length) return out;
  for (const value of file.objects.values()) {
    const d = isDict(value) ? value : null;
    if (d && isName(d.entries.get("Type"), "Page") && out.length <= MAX_PAGES) out.push(d);
  }
  return out;
}

export type { PdfStream };
