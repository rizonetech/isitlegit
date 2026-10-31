// PDF forensics for payment documents (D06 T02 §1; spec 4.5a): deterministic file evidence that a PDF was altered after
// it was made. Five findings, each built to stay silent on ordinary genuine documents:
//
// - revisions: an incremental update (ISO 32000-1 section 7.5.6) that changed what the pages draw. An update that only
//   signs the file or only rewrites its metadata is history, not an edit; a linearized file's first-page section is
//   part of its first revision (Annex F).
// - producer: a document whose own heading says it is a bank's (a proof of payment, a payment confirmation, a bank
//   confirmation letter) made or saved by a consumer editor, a word processor or a print driver. A supplier's own
//   invoice made in Word is ordinary and never flagged.
// - dates: a modification some minutes after creation that falls after the payment date the document states, or a
//   proof of payment created before the payment it confirms. A POP downloaded later is created and modified together.
// - fonts: an amount or account line drawn in a font family the document uses nowhere else, beside its other amounts in
//   another family, or a second subset of the same font on the same page used only there.
// - overlay: an opaque, unclipped image painted over visible text. A background drawn first, a scan's invisible OCR
//   text, a clipped or soft-masked image are not.
//
// Each is medium; findings from two independent groups (history: revisions and dates; tool: producer; page: fonts and
// overlay) make each high. What could not be read is coverage (`ran`, `partial`, `unavailable` with a reason), never a
// clean result.
import { bounded, fittedDetail, plain } from "../checks/auth";
import type { EvidenceDraft } from "../checks/evidence";
import {
  dictOf,
  isDict,
  isName,
  isRef,
  isStream,
  newBudget,
  type PdfFile,
  type PdfObject,
  readPdf,
  resolve,
  streamData,
  textOf,
} from "./pdf";
import { type Box, type Content, type PageContent, pageList, readContent, type TextRun } from "./pdf-content";

export const FORENSIC_KINDS = ["revisions", "producer", "dates", "fonts", "overlay"] as const;
export type ForensicKind = (typeof FORENSIC_KINDS)[number];
export const FORENSIC_CHECKS = FORENSIC_KINDS.map((k) => `document.forensics.${k}`);
export const MAX_OVERLAP_PAIRS = 2_000_000;
const MAX_DRAWN = 20_000;

export type Coverage = { status: "ran" | "partial" | "unavailable"; reason: string | null };
export type Finding = { kind: ForensicKind; says: string; detail: Record<string, unknown> };
export type PdfForensics = {
  findings: Finding[];
  coverage: Record<ForensicKind, Coverage>;
  unread: string[];
  issuer: "bank" | "unknown";
};

const GROUP: Record<ForensicKind, "history" | "tool" | "page"> = {
  revisions: "history",
  dates: "history",
  producer: "tool",
  fonts: "page",
  overlay: "page",
};

const ran: Coverage = { status: "ran", reason: null };
const partial = (reason: string): Coverage => ({ status: "partial", reason });
const unavailable = (reason: string): Coverage => ({ status: "unavailable", reason });

export async function analysePdf(bytes: Uint8Array): Promise<PdfForensics> {
  const file = await readPdf(bytes, newBudget());
  const coverage = {} as Record<ForensicKind, Coverage>;
  const findings: Finding[] = [];
  if (!file.text || (file.objects.size === 0 && file.sections.length === 0)) {
    const reason = file.unread[0] ?? "the file could not be read";
    for (const k of FORENSIC_KINDS) coverage[k] = unavailable(reason);
    return { findings, coverage, unread: file.unread, issuer: "unknown" };
  }
  const content: Content = file.encrypted ? { pages: [], fonts: new Map() } : await readContent(file);
  const lines = linesOf(content.pages);
  const textRead = lines.length > 0;
  const issuer = issuerOf(content.pages[0], lines);
  const metadata = file.encrypted ? null : await metadataOf(file);
  const contentPartial = file.unread.length ? file.unread[0] : null;

  // Revisions read only the cross-reference chain, so they survive an encrypted or unreadable page.
  const revisions = revisionsOf(file);
  coverage.revisions = revisions.coverage;
  if (revisions.finding) findings.push(revisions.finding);

  if (file.encrypted) {
    for (const k of ["producer", "dates", "fonts", "overlay"] as const)
      coverage[k] = unavailable("the file is encrypted, so its metadata and pages were not read");
  } else {
    const producer = producerOf(metadata, issuer, textRead);
    coverage.producer = producer.coverage;
    if (producer.finding) findings.push(producer.finding);
    const dates = datesOf(metadata, lines, issuer);
    coverage.dates = dates.coverage;
    if (dates.finding) findings.push(dates.finding);
    const fonts = fontsOf(lines);
    coverage.fonts = textRead ? fonts.coverage : unavailable("the document's text could not be read");
    if (fonts.finding) findings.push(fonts.finding);
    const overlay = overlayOf(content.pages, lines);
    coverage.overlay = overlay.coverage;
    if (overlay.finding) findings.push(overlay.finding);
    if (contentPartial)
      for (const k of ["fonts", "overlay"] as const)
        if (coverage[k].status === "ran") coverage[k] = partial(contentPartial);
  }
  if (file.scanned && coverage.revisions.status === "ran") coverage.revisions = partial(file.unread[0] ?? "");
  return { findings, coverage, unread: file.unread, issuer };
}

// --- Revisions ---------------------------------------------------------------------------------------------------

type UpdateKind = "content" | "signature" | "other";
const VISIBLE_ANNOTS = new Set([
  "FreeText",
  "Stamp",
  "Square",
  "Circle",
  "Ink",
  "Line",
  "Polygon",
  "PolyLine",
  "Highlight",
  "Text",
  "Caret",
  "Redact",
  "StrikeOut",
  "Underline",
  "Squiggly",
]);

// The objects the pages draw from: their content streams, fonts (with their programs and maps), images and forms with
// theirs, followed through references, a visited set and MAX_DRAWN bounding the walk.
function drawnObjects(file: PdfFile): Set<number> {
  const drawn = new Set<number>();
  const pages = pageList(file);
  const stack: PdfObject[] = [];
  for (const page of pages) {
    stack.push(page.entries.get("Contents") ?? null);
    stack.push(page.entries.get("Resources") ?? null);
  }

  while (stack.length && drawn.size < MAX_DRAWN) {
    const v = stack.pop();
    if (isRef(v)) {
      if (drawn.has(v.num)) continue;
      drawn.add(v.num);
      stack.push(file.objects.get(v.num) ?? null);
    } else if (Array.isArray(v)) stack.push(...v.slice(0, 4096));
    else if (isDict(v) || isStream(v)) {
      const d = isStream(v) ? v.dict : v;
      for (const [key, value] of d.entries) if (key !== "Parent" && key !== "P") stack.push(value);
    }
  }
  return drawn;
}

function updateKind(file: PdfFile, defines: number[], drawn: Set<number>): UpdateKind {
  let signature = false;
  for (const num of defines) {
    if (drawn.has(num)) return "content";
    const d = dictOf(file, file.objects.get(num));
    if (!d) continue;
    const sub = d.entries.get("Subtype");
    if (isName(sub) && VISIBLE_ANNOTS.has(sub.name)) return "content";
    if (d.entries.has("ByteRange") || isName(d.entries.get("Type"), "Sig") || isName(d.entries.get("FT"), "Sig"))
      signature = true;
  }
  return signature ? "signature" : "other";
}

function revisionsOf(file: PdfFile): { coverage: Coverage; finding: Finding | null } {
  const sections = file.sections;
  if (file.scanned || sections.length === 0)
    return {
      coverage: unavailable("the file's cross-reference chain is damaged, so its revisions are unknown"),
      finding: null,
    };
  // The original revision: the oldest section, and with it a linearized file's first-page section (Annex F).
  let originals = 1;
  const oldest = sections[sections.length - 1];
  const second = sections[sections.length - 2];
  if (file.linearized && oldest && second && second.offset < oldest.offset) originals = 2;
  const updates = sections.slice(0, Math.max(0, sections.length - originals)).reverse();
  const drawn = drawnObjects(file);
  // Objects an update defines are read at their newest definition, which is that update's or a later one's: what is
  // asked of each is only whether it is drawn, a signature or an annotation.
  const kinds = updates.map((u) => updateKind(file, u.defines, drawn));
  const edits = kinds.filter((k) => k === "content").length;
  const firstSignature = kinds.indexOf("signature");
  const afterSignature = firstSignature >= 0 && kinds.slice(firstSignature + 1).includes("content");
  const lengthChanged =
    file.linearized !== null && file.linearized.length > 0 && file.linearized.length !== file.bytes.length;
  const coverage = file.unread.some((r) => /cross-reference|object/.test(r)) ? partial(file.unread[0] ?? "") : ran;
  if (edits === 0) return { coverage, finding: null };
  return {
    coverage,
    finding: {
      kind: "revisions",
      says: afterSignature
        ? "was changed after it was signed: a later save changed what its pages show"
        : `was changed after it was first saved: ${edits === 1 ? "a later save" : `${edits} later saves`} changed what its pages show`,
      detail: {
        revisions: sections.length - originals + 1,
        edits,
        afterSignature,
        updates: kinds,
        linearizedLengthChanged: lengthChanged,
      },
    },
  };
}

// --- Metadata and issuer -----------------------------------------------------------------------------------------

type Metadata = {
  producer: string | null;
  creator: string | null;
  xmpProducer: string | null;
  xmpCreator: string | null;
  created: PdfDate | null;
  modified: PdfDate | null;
  xmpCreated: PdfDate | null;
  xmpModified: PdfDate | null;
};
export type PdfDate = { utc: number; day: string; text: string };

// A PDF date (7.9.4): D:YYYYMMDDHHmmSSOHH'mm, every part after the year optional.
export function pdfDate(text: string | null): PdfDate | null {
  if (!text) return null;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(text.trim());
  if (!m) return null;
  return dateFrom(
    m.slice(1, 7).map((x, i) => (x === undefined ? (i === 1 || i === 2 ? 1 : 0) : Number(x))),
    m[7],
    m[8],
    m[9],
    text,
  );
}
// An XMP date (ISO 8601).
export function isoDate(text: string | null): PdfDate | null {
  if (!text) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-])?(\d{2})?:?(\d{2})?/.exec(
    text.trim(),
  );
  if (!m) return null;
  return dateFrom(
    m.slice(1, 7).map((x) => (x === undefined ? 0 : Number(x))),
    m[7],
    m[8],
    m[9],
    text,
  );
}
function dateFrom(
  parts: number[],
  sign: string | undefined,
  hh: string | undefined,
  mm: string | undefined,
  text: string,
) {
  const [y, mo, d, h, mi, s] = parts as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const offset = sign === "+" || sign === "-" ? (sign === "-" ? -1 : 1) * (Number(hh ?? 0) * 60 + Number(mm ?? 0)) : 0;
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  return {
    utc: local - offset * 60_000,
    day: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    text: text.slice(0, 40),
  };
}

async function metadataOf(file: PdfFile): Promise<Metadata> {
  const info = dictOf(file, file.trailer?.entries.get("Info"));
  const get = (k: string) => textOf(resolve(file, info?.entries.get(k)));
  let xmp = "";
  const root = dictOf(file, file.trailer?.entries.get("Root"));
  const meta = resolve(file, root?.entries.get("Metadata"));
  if (isStream(meta)) {
    const data = await streamData(file, meta);
    if (data) xmp = new TextDecoder().decode(data.subarray(0, 256 * 1024));
  }
  const field = (name: string) => {
    const el = new RegExp(`<${name}>([^<]{1,500})</${name}>`).exec(xmp);
    const at = new RegExp(`${name}="([^"]{1,500})"`).exec(xmp);
    return (el?.[1] ?? at?.[1] ?? null)?.trim() ?? null;
  };
  return {
    producer: get("Producer"),
    creator: get("Creator"),
    xmpProducer: field("pdf:Producer"),
    xmpCreator: field("xmp:CreatorTool"),
    created: pdfDate(get("CreationDate")),
    modified: pdfDate(get("ModDate")),
    xmpCreated: isoDate(field("xmp:CreateDate")),
    xmpModified: isoDate(field("xmp:ModifyDate")),
  };
}

// The programs that edit or print documents, as opposed to the systems banks issue documents from.
const EDITORS: [RegExp, string][] = [
  [/ilovepdf/i, "iLovePDF"],
  [/smallpdf/i, "Smallpdf"],
  [/sejda/i, "Sejda"],
  [/pdfescape/i, "PDFescape"],
  [/pdf-?xchange/i, "PDF-XChange"],
  [/foxit/i, "Foxit"],
  [/nitro/i, "Nitro"],
  [/pdfelement|wondershare/i, "PDFelement"],
  [/pdf24/i, "PDF24"],
  [/soda ?pdf/i, "Soda PDF"],
  [/pdffiller/i, "pdfFiller"],
  [/dochub/i, "DocHub"],
  [/canva/i, "Canva"],
  [/acrobat (pro|standard)|adobe acrobat (\d|dc)/i, "Adobe Acrobat"],
  [/microsoft.{0,12}word|word for microsoft/i, "Microsoft Word"],
  [/libreoffice|openoffice/i, "LibreOffice"],
  [/google docs/i, "Google Docs"],
  [/print to pdf|microsoft: print/i, "a print-to-PDF driver"],
  [/quartz pdfcontext|macos.*preview|^preview$/i, "macOS Preview"],
  [/photoshop|gimp|paint\.net/i, "an image editor"],
  [/skia\/pdf|chrom(e|ium)/i, "a web browser's print"],
];

const HEADING =
  /^(?:proof of payment|payment (?:confirmation|notification|advice)|confirmation of (?:payment|banking details|bank details|bank account)|(?:bank|account) confirmation letter|bank account confirmation|betalingsbewys|bevestiging van betaling)\b/i;

function issuerOf(page: PageContent | undefined, lines: Line[]): "bank" | "unknown" {
  if (!page) return "unknown";
  const top = page.box.y1 - (page.box.y1 - page.box.y0) / 4;
  for (const line of lines) {
    if (line.page !== 0 || line.y < top) continue;
    const text = line.text.trim();
    if (text.split(/\s+/).length <= 8 && HEADING.test(text)) return "bank";
  }
  return "unknown";
}

function producerOf(
  m: Metadata | null,
  issuer: "bank" | "unknown",
  textRead: boolean,
): { coverage: Coverage; finding: Finding | null } {
  const tools = [m?.producer, m?.creator, m?.xmpProducer, m?.xmpCreator].filter((t): t is string => !!t);
  if (!tools.length) return { coverage: unavailable("the file names no program that made it"), finding: null };
  if (!textRead)
    return { coverage: unavailable("the document's text could not be read, so its issuer is unknown"), finding: null };
  if (issuer !== "bank") return { coverage: ran, finding: null };
  for (const tool of tools)
    for (const [re, name] of EDITORS)
      if (re.test(tool))
        return {
          coverage: ran,
          finding: {
            kind: "producer",
            says: `says it is from a bank but was made or saved with ${name}, a program for writing or editing documents`,
            detail: {
              tool: name,
              producer: m?.producer ?? null,
              creator: m?.creator ?? null,
              xmpProducer: m?.xmpProducer ?? null,
              xmpCreator: m?.xmpCreator ?? null,
            },
          },
        };
  return { coverage: ran, finding: null };
}

// --- Dates -------------------------------------------------------------------------------------------------------

const MONTHS = [
  ["jan", "januarie"],
  ["feb", "februarie"],
  ["mar", "maart"],
  ["apr", "april"],
  ["may", "mei"],
  ["jun", "junie"],
  ["jul", "julie"],
  ["aug", "augustus"],
  ["sep", "september"],
  ["oct", "oktober"],
  ["nov", "november"],
  ["dec", "desember"],
];
function monthOf(word: string): number {
  const w = word.toLowerCase();
  return MONTHS.findIndex(([en, af]) => w.startsWith(en as string) || w === af) + 1;
}
// A calendar day written in a document: 2026-10-31, 2026/10/31, 31/10/2026, 31-10-2026, 31 October 2026, October 31, 2026.
export function statedDay(text: string): string | null {
  const day = (y: number, m: number, d: number) =>
    m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100
      ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      : null;
  let m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(text);
  if (m) return day(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(text);
  if (m) return day(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /\b(\d{1,2})\s+([A-Za-z]{3,10})\.?\s+(\d{4})\b/.exec(text);
  if (m && monthOf(m[2] as string)) return day(Number(m[3]), monthOf(m[2] as string), Number(m[1]));
  m = /\b([A-Za-z]{3,10})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(text);
  if (m && monthOf(m[1] as string)) return day(Number(m[3]), monthOf(m[1] as string), Number(m[2]));
  return null;
}
const PAID_LABEL = /\b(?:date paid|paid on|payment made on|transaction date|betaaldatum|datum betaal)\b/i;
const PAYMENT_LABEL =
  /\b(?:payment date|date of payment|value date|date paid|paid on|payment made on|transaction date|betaaldatum|datum betaal)\b/i;

function datesOf(
  m: Metadata | null,
  lines: Line[],
  issuer: "bank" | "unknown",
): { coverage: Coverage; finding: Finding | null } {
  const created = m?.created ?? m?.xmpCreated ?? null;
  const modified = m?.modified ?? m?.xmpModified ?? null;
  if (!created && !modified)
    return { coverage: unavailable("the file records no creation or modification date"), finding: null };
  let payment: { day: string; line: string; paid: boolean } | null = null;
  for (const line of lines) {
    const label = PAYMENT_LABEL.exec(line.text);
    if (!label) continue;
    const day = statedDay(line.text.slice(label.index));
    if (day) {
      payment = { day, line: line.text, paid: PAID_LABEL.test(line.text) };
      break;
    }
  }
  if (!payment) return { coverage: unavailable("the document states no payment date"), finding: null };
  const conflicts =
    (m?.modified && m.xmpModified && Math.abs(m.modified.utc - m.xmpModified.utc) > 86_400_000) ||
    (m?.created && m.xmpCreated && Math.abs(m.created.utc - m.xmpCreated.utc) > 86_400_000);
  const detail = {
    created: created?.text ?? null,
    modified: modified?.text ?? null,
    paymentDate: payment.day,
    paymentLine: payment.line,
    infoAndXmpDisagree: Boolean(conflicts),
  };
  if (created && modified && modified.utc - created.utc > 5 * 60_000 && modified.day > payment.day)
    return {
      coverage: ran,
      finding: {
        kind: "dates",
        says: `was modified on ${modified.day}, after the payment date it states (${payment.day})`,
        detail,
      },
    };
  if (issuer === "bank" && payment.paid && created && dayBefore(created.day, payment.day))
    return {
      coverage: ran,
      finding: {
        kind: "dates",
        says: `was created on ${created.day}, before the payment it confirms (${payment.day})`,
        detail,
      },
    };
  return { coverage: ran, finding: null };
}
// More than one day before: a bank's system clock in another zone moves a date by at most one.
const dayBefore = (a: string, b: string) => Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`) > 86_400_000;

// --- Lines -------------------------------------------------------------------------------------------------------

type Line = { page: number; y: number; runs: TextRun[]; text: string; sensitive: boolean };
const AMOUNT = /(?:\b(?:R|ZAR)\s?\d[\d ,]*[.,]\d{2}\b|\b\d{1,3}(?:[ ,]\d{3})+[.,]\d{2}\b|\b\d+[.,]\d{2}\b)/;
const ACCOUNT = /\b\d(?:[ -]?\d){6,10}\b/;
const DATES = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b/g;
const LABEL = /\b(?:amount|total|account (?:number|no)|acc(?:ount)? no|rekeningnommer|bedrag|branch code)\b/i;

// The visible text runs grouped into lines by page and baseline.
function linesOf(pages: PageContent[]): Line[] {
  const lines: Line[] = [];
  for (const page of pages) {
    const runs = page.runs
      .filter((r) => r.visible && r.text.trim())
      .sort((a, b) => b.box.y0 - a.box.y0 || a.box.x0 - b.box.x0);
    const open: Line[] = [];
    for (const run of runs) {
      const y = (run.box.y0 + run.box.y1) / 2;
      const tolerance = Math.max(1, (run.box.y1 - run.box.y0) * 0.4);
      let line = open.find((l) => Math.abs(l.y - y) <= tolerance);
      if (!line) {
        line = { page: page.index, y, runs: [], text: "", sensitive: false };
        open.push(line);
      }
      line.runs.push(run);
    }
    for (const line of open) {
      line.runs.sort((a, b) => a.box.x0 - b.box.x0);
      // Runs that touch are one word (Chromium's PDF places each glyph as its own run); a gap of a quarter em is a space.
      let text = "";
      let prev: TextRun | null = null;
      for (const r of line.runs) {
        if (prev && r.box.x0 - prev.box.x1 > 0.25 * Math.max(1, r.size)) text += " ";
        text += r.text;
        prev = r;
      }
      line.text = text.replace(/\s+/g, " ").trim();
      // Dates are written with the same digits as amounts and accounts, so they are taken out first.
      const undated = line.text.replace(DATES, " ");
      line.sensitive = AMOUNT.test(undated) || ACCOUNT.test(undated) || LABEL.test(undated);
    }
    lines.push(...open.sort((a, b) => b.y - a.y));
  }
  return lines;
}

// --- Fonts -------------------------------------------------------------------------------------------------------

export function fontFamily(name: string): string {
  const base = name.replace(/^[A-Z]{6}\+/, "").split(/[-,]/)[0] ?? "";
  return base
    .replace(/(MT|PS|Std|Pro)$/i, "")
    .replace(/(Bold|Italic|Oblique|Regular|Medium|Light|Semibold|SemiBold|Black|Condensed|Narrow)+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
const subsetTag = (name: string) => /^([A-Z]{6})\+/.exec(name)?.[1] ?? null;
const DIGIT = /\d/;

function fontsOf(lines: Line[]): { coverage: Coverage; finding: Finding | null } {
  const runs = lines.flatMap((l) => l.runs.map((r) => ({ run: r, line: l })));
  const unknown = runs.filter((x) => x.run.text.includes("�")).length;
  const coverage =
    runs.length && unknown / runs.length > 0.2 ? partial("some of the document's text could not be read") : ran;
  if (!lines.some((l) => l.sensitive && DIGIT.test(l.text)))
    return { coverage: unavailable("the document has no amount or account lines that could be read"), finding: null };
  // Rule 1: a family only on amount or account lines, beside such lines drawn in another family.
  const families = new Map<string, { onlySensitive: boolean; digitLines: Line[]; font: string }>();
  for (const { run, line } of runs) {
    const f = fontFamily(run.font);
    const entry = families.get(f) ?? { onlySensitive: true, digitLines: [], font: run.font };
    if (!line.sensitive) entry.onlySensitive = false;
    if (line.sensitive && DIGIT.test(run.text) && !entry.digitLines.includes(line)) entry.digitLines.push(line);
    families.set(f, entry);
  }
  for (const [family, entry] of families) {
    if (!entry.onlySensitive || entry.digitLines.length === 0) continue;
    const other = runs.find(
      (x) =>
        x.line.sensitive &&
        DIGIT.test(x.run.text) &&
        fontFamily(x.run.font) !== family &&
        !entry.digitLines.includes(x.line),
    );
    if (!other) continue;
    const line = entry.digitLines[0] as Line;
    return {
      coverage,
      finding: {
        kind: "fonts",
        says: `shows "${plain(line.text, 50)}" in a font (${plain(stripTag(entry.font), 30)}) unlike its other amounts (${plain(stripTag(other.run.font), 30)})`,
        detail: { page: line.page + 1, line: line.text, font: entry.font, otherFont: other.run.font, rule: "family" },
      },
    };
  }
  // Rule 2: a second subset of the same font on one page, used only on amount or account lines there.
  const byPage = new Map<number, typeof runs>();
  for (const x of runs) byPage.set(x.line.page, [...(byPage.get(x.line.page) ?? []), x]);
  for (const [page, list] of byPage) {
    const subsets = new Map<string, Map<string, { sensitiveOnly: boolean; line: Line; font: string }>>();
    for (const { run, line } of list) {
      const tag = subsetTag(run.font);
      if (!tag) continue;
      const name = stripTag(run.font);
      const tags = subsets.get(name) ?? new Map();
      const e = tags.get(tag) ?? { sensitiveOnly: true, line, font: run.font };
      if (!line.sensitive) e.sensitiveOnly = false;
      tags.set(tag, e);
      subsets.set(name, tags);
    }
    for (const [name, tags] of subsets) {
      if (tags.size < 2) continue;
      const odd = [...tags.values()].find((e) => e.sensitiveOnly && DIGIT.test(e.line.text));
      const usual = [...tags.values()].find((e) => !e.sensitiveOnly);
      if (!odd || !usual) continue;
      return {
        coverage,
        finding: {
          kind: "fonts",
          says: `shows "${plain(odd.line.text, 50)}" in a second copy of the font ${plain(name, 30)}, added on page ${page + 1}`,
          detail: { page: page + 1, line: odd.line.text, font: odd.font, otherFont: usual.font, rule: "subset" },
        },
      };
    }
  }
  return { coverage, finding: null };
}
const stripTag = (name: string) => name.replace(/^[A-Z]{6}\+/, "");

// --- Overlay -----------------------------------------------------------------------------------------------------

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
function overlapShare(image: Box, text: Box): number {
  const i = {
    x0: Math.max(image.x0, text.x0),
    y0: Math.max(image.y0, text.y0),
    x1: Math.min(image.x1, text.x1),
    y1: Math.min(image.y1, text.y1),
  };
  const t = area(text);
  return t > 0 ? area(i) / t : 0;
}

function overlayOf(pages: PageContent[], lines: Line[]): { coverage: Coverage; finding: Finding | null } {
  const anyText = pages.some((p) => p.runs.some((r) => r.visible && r.text.trim()));
  if (!anyText && pages.some((p) => p.images.length))
    return {
      coverage: unavailable("the document's text could not be read, so what an image covers is unknown"),
      finding: null,
    };
  let pairs = 0;
  let coverage: Coverage = ran;
  for (const page of pages) {
    const runs = page.runs.filter((r) => r.visible && r.text.trim());
    for (const image of page.images) {
      if (!image.clipKnown) coverage = partial("an image's clipping shape was not read");
      if (!image.opaque || !image.clipKnown || image.box.x1 - image.box.x0 < 2 || image.box.y1 - image.box.y0 < 2)
        continue;
      for (const run of runs) {
        if (++pairs > MAX_OVERLAP_PAIRS)
          return { coverage: partial("too many images and text runs to compare them all"), finding: null };
        if (run.seq > image.seq || overlapShare(image.box, run.box) < 0.5) continue;
        const line = lines.find((l) => l.runs.includes(run));
        return {
          coverage,
          finding: {
            kind: "overlay",
            says: `has an image placed over its text "${plain(run.text, 40)}" on page ${page.index + 1}`,
            detail: {
              page: page.index + 1,
              covered: run.text,
              line: line?.text ?? run.text,
              onAmountOrAccountLine: line?.sensitive ?? false,
              image: roundBox(image.box),
            },
          },
        };
      }
    }
  }
  return { coverage, finding: null };
}
const roundBox = (b: Box) => ({
  x0: Math.round(b.x0),
  y0: Math.round(b.y0),
  x1: Math.round(b.x1),
  y1: Math.round(b.y1),
});

// --- Evidence ----------------------------------------------------------------------------------------------------

// One item per finding, medium each, high when two independent groups agree on the file.
export function forensicsEvidence(report: PdfForensics, file: { key: string; filename: string }): EvidenceDraft[] {
  const groups = new Set(report.findings.map((f) => GROUP[f.kind]));
  const severity = groups.size >= 2 ? "high" : "medium";
  const name = plain(file.filename || "", 60) || "The PDF";
  return report.findings.map((f) => ({
    check: `document.forensics.${f.kind}`,
    severity,
    summary: bounded(`${name} ${f.says}.`),
    detail: fittedDetail({ filename: file.filename, issuer: report.issuer, ...f.detail }) as EvidenceDraft["detail"],
    artefacts: [file.key],
  }));
}

// Each check's coverage, for the registration in §3: `partial` and `unavailable` carry their reason.
export function forensicsCoverage(report: PdfForensics): Record<string, Coverage> {
  return Object.fromEntries(FORENSIC_KINDS.map((k) => [`document.forensics.${k}`, report.coverage[k]]));
}
