// What a PDF's pages draw, for the forensics (D06 T02 §1; ISO 32000-1 sections 8 and 9): each text run with its font
// and its box on the page, and each image with its box, in painting order. It interprets the content stream operators
// that place text and images (graphics state, text objects and positioning, text showing, XObjects and inline images)
// and ignores the rest, since forensics asks where things are, not how they look. Widths come from the font's own
// width tables; a font without them is taken at half an em a glyph, close enough to tell what overlaps what.
import {
  byteString,
  dictOf,
  isDict,
  isName,
  isOp,
  isStream,
  isString,
  Lexer,
  note,
  OverBudget,
  type PdfDict,
  type PdfFile,
  type PdfObject,
  type PdfRef,
  type PdfStream,
  type PdfValue,
  resolve,
  streamData,
} from "./pdf";

export const MAX_PAGES = 200;
export const MAX_RUNS = 20_000;
export const MAX_FORM_DEPTH = 8;

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

// A ToUnicode CMap (9.10.3): bfchar and bfrange entries, bounded.
export function toUnicode(cmap: string): { map: Map<number, string>; bytes: 1 | 2 } {
  const map = new Map<number, string>();
  const hex = (h: string) => Number.parseInt(h, 16);
  const utf16 = (h: string) => {
    let out = "";
    for (let i = 0; i + 3 < h.length; i += 4) out += String.fromCharCode(hex(h.slice(i, i + 4)));
    return out;
  };
  const space = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(cmap);
  const bytes: 1 | 2 = space && (space[1] as string).length <= 2 ? 1 : 2;
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of (block[1] as string).matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      if (map.size > 65_536) break;
      map.set(hex(m[1] as string), utf16(m[2] as string));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of (block[1] as string).matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g,
    )) {
      const lo = hex(m[1] as string);
      const hi = Math.min(hex(m[2] as string), lo + 65_535);
      if (m[3] !== undefined) {
        const base = m[3];
        const start = hex(base.slice(-4));
        const prefix = utf16(base.slice(0, -4));
        for (let c = lo; c <= hi && map.size <= 65_536; c++) map.set(c, prefix + String.fromCharCode(start + c - lo));
      } else {
        const list = [...(m[4] as string).matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1] as string));
        list.forEach((t, i) => {
          if (lo + i <= hi) map.set(lo + i, t);
        });
      }
    }
  }
  return { map, bytes };
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
  const unreadOnce = (reason: string) => note(file, reason);

  async function fontOf(ref: PdfObject | undefined): Promise<Font | null> {
    const dict = dictOf(file, ref);
    if (!dict) return null;
    const cached = fontCache.get(dict);
    if (cached) return cached;
    const id = isRefLike(ref) ? ref.num : -1;
    const subtype = dict.entries.get("Subtype");
    const composite = isName(subtype, "Type0");
    let cmap: { map: Map<number, string>; bytes: 1 | 2 } | null = null;
    const tu = resolve(file, dict.entries.get("ToUnicode"));
    if (isStream(tu)) {
      const data = await streamData(file, tu);
      if (data) cmap = toUnicode(byteString(data.subarray(0, 1024 * 1024)));
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
        for (let i = 0; i < w.length && widths.size < 65_536; ) {
          const first = w[i];
          const second = resolve(file, w[i + 1]);
          if (typeof first !== "number") break;
          if (Array.isArray(second)) {
            second.forEach((x, j) => {
              if (typeof x === "number") widths.set(first + j, x);
            });
            i += 2;
          } else if (typeof second === "number" && typeof w[i + 2] === "number") {
            for (let c = first; c <= second && widths.size < 65_536; c++) widths.set(c, w[i + 2] as number);
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
      const contents = resolve(file, page.entries.get("Contents"));
      const parts = Array.isArray(contents) ? contents.map((c) => resolve(file, c)) : [contents];
      const chunks: string[] = [];
      for (const part of parts) {
        if (!isStream(part)) continue;
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
  ): Promise<void> {
    const lex = new Lexer(src, file.budget);
    const operands: PdfValue[] = [];
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
      alpha: number;
    };
    let g: State = {
      ctm: base,
      font: null,
      size: 0,
      tl: 0,
      tc: 0,
      tw: 0,
      th: 1,
      mode: 0,
      clip: null,
      clipKnown: true,
      alpha: 1,
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
      for (let i = 0; i < s.length; i += font.bytesPerCode) {
        const code = font.bytesPerCode === 2 ? (s.charCodeAt(i) << 8) | (s.charCodeAt(i + 1) || 0) : s.charCodeAt(i);
        parts.push(font.text(code));
        advance += (font.width(code) / 1000) * g.size + g.tc + (font.bytesPerCode === 1 && code === 32 ? g.tw : 0);
      }
      advance *= g.th;
      const text = parts.join("");
      if (text.length && runs < MAX_RUNS) {
        runs++;
        const m = mul(tm, g.ctm);
        page.runs.push({
          page: page.index,
          visible: g.mode !== 3 && g.mode !== 7,
          fontId: font.id,
          font: font.name,
          size: Math.abs(g.size * Math.hypot(m[2], m[3])),
          text,
          box: boxOf(m, 0, -0.2 * g.size, advance, 0.8 * g.size),
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
          if (!isStream(x)) break;
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
            const saved = { ...g };
            await interpret(byteString(data), own, mul(m, g.ctm), page, new Set([...forms, x]));
            g = saved;
          }
          break;
        }
        case "BI": {
          // An inline image (8.9.7): its data runs from `ID` to an `EI` between white space.
          const id = src.indexOf("ID", lex.pos);
          const ei = id < 0 ? -1 : src.slice(id + 3, id + 3 + 4 * 1024 * 1024).search(/\sEI(?=\s|$)/);
          if (ei < 0) return;
          lex.pos = id + 3 + ei + 3;
          drawImage(true, false);
          break;
        }
      }
      operands.length = 0;
    }
  }
}

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
    if (!node || seen.has(node) || depth > 32 || out.length > MAX_PAGES) return;
    seen.add(node);
    if (isName(node.entries.get("Type"), "Page")) {
      out.push(node);
      return;
    }
    const kids = resolve(file, node.entries.get("Kids"));
    if (Array.isArray(kids)) for (const k of kids) walk(dictOf(file, k), depth + 1);
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
