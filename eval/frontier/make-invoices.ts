// Synthetic invoices for the edited-digits experiment (D08 T03 §1): ten fictional South African suppliers, each built
// twice, once as issued (the twin) and once with its account number pasted over (the edit), so the two differ only
// inside the number's box. Every company, bank, person and number here is invented (AGENTS.md: synthetic data only).
//
// A twin is drawn as SVG, rasterised by sharp, saved as JPEG at quality 90 and saved again at quality 90, the way an
// exported invoice reaches a mailbox after one more save. An edit starts from the same invoice issued with the
// supplier's real number and saved at quality 90, then a patch carrying the fraudster's number (the twin's own digits)
// is pasted over that number's box and the whole saved again at quality 90, the way a number is changed in an image
// editor. Both have the same encoding history, so only the patch tells them apart (plan review, 2026-10-31). Three
// ways of making the patch, cycled over the ten:
//   font        another typeface, same size and place
//   spacing     the same typeface, letter spacing and baseline off by a pixel or two
//   recompress  the same typeface and place, the patch JPEG-compressed at quality 55 before pasting (a screenshot of
//               digits pasted in), so only its compression differs
import sharp, { type Sharp } from "sharp";

export const INVOICE_SIZE = { width: 1000, height: 1414 } as const; // A4 proportions
export const JPEG_QUALITY = 90;
export const PATCH_QUALITY = 55;
export const EDIT_KINDS = ["font", "spacing", "recompress"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

// The account number's line on every invoice: its text starts at `x` on the baseline `y`, at `size` pixels.
export const ACCOUNT_TEXT = { x: 640, y: 1046, size: 20 } as const;
export type Box = { left: number; top: number; width: number; height: number };
// The box an edit replaces: the whole number with a margin, wide enough for twelve digits in any of the typefaces.
export const ACCOUNT_BOX: Box = { left: 632, top: 1018, width: 236, height: 38 };
// The other value fields of the payment block, drawn the same way: the baseline's reference for the page's own noise.
export const BANK_BOX: Box = { left: 632, top: 978, width: 300, height: 38 };
export const BRANCH_BOX: Box = { left: 632, top: 1058, width: 236, height: 38 };
export const BASE_FONT = "DejaVu Sans";
export const OTHER_FONT = "Nimbus Roman";
// The exact font files the published set was drawn with (fonts-dejavu-core, fonts-urw-base35), by sha256: a build
// refuses a machine that resolves either family to another file (eval/DATASETS.md has their licences).
export const FONT_PINS: Record<string, string> = {
  [BASE_FONT]: "b4c632e3cdf9acc7f28758fb5a323c8524d7fc6660d46904d9b6cbe2809c419c",
  [OTHER_FONT]: "fd41669443616a7ae890c42e53a58f47fa24a940fd1e367acaff665cf5b6e9d8",
};

export type Line = { description: string; quantity: number; unitCents: number };
export type InvoiceSpec = {
  id: string;
  supplier: string;
  address: string[];
  vat: string;
  customer: string;
  invoiceNumber: string;
  date: string;
  bank: string;
  branchCode: string;
  // The number on the twin and the fraudster's number on the edit.
  account: string;
  // The supplier's real number, which the edit's patch covers.
  originalAccount: string;
  lines: Line[];
  accent: string;
};

const SUPPLIERS: [string, string, string][] = [
  ["Karoo Ridge Plumbing (Pty) Ltd", "14 Fennel Street", "Graaff-Reinet, 6280"],
  ["Mzansi Office Supplies CC", "Unit 3, Bergvliet Park", "Pretoria, 0181"],
  ["Blue Crane Logistics (Pty) Ltd", "88 Harbour Lane", "Gqeberha, 6001"],
  ["Umhlanga Print & Sign", "5 Tidewater Close", "Umhlanga, 4319"],
  ["Highveld Electrical Contractors", "27 Koppie Road", "Benoni, 1501"],
  ["Fynbos Catering Co.", "102 Protea Avenue", "Stellenbosch, 7600"],
  ["Limpopo Agri Parts (Pty) Ltd", "9 Baobab Drive", "Polokwane, 0699"],
  ["Table Bay IT Services", "61 Signal Hill Way", "Cape Town, 8001"],
  ["Drakensberg Security Systems", "33 Amphitheatre Road", "Bergville, 3350"],
  ["Kalahari Cleaning Solutions", "17 Duneveld Street", "Upington, 8801"],
];
// Fictional banks: no real South African bank's name.
const BANKS = ["Savanna Mutual Bank", "Coastline Bank", "Highland Trust Bank", "Meridian Savings Bank"];
const CUSTOMERS = ["Rietvlei Dental Studio", "Amber Hill Guest House", "Nkosi & Daughters Attorneys"];
const ITEMS: [string, number][] = [
  ["Labour (hours)", 45_000],
  ["Call-out fee", 65_000],
  ["Materials as quoted", 238_500],
  ["A4 paper, box of 5 reams", 42_999],
  ["Monthly service fee", 150_000],
  ["Delivery", 35_000],
  ["Site inspection", 95_000],
  ["Replacement parts", 187_250],
];

// A small seeded generator (mulberry32), so a rerun builds the same ten invoices.
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const digits = (random: () => number, n: number) =>
  Array.from({ length: n }, (_, i) => String(Math.floor(random() * (i === 0 ? 9 : 10)) + (i === 0 ? 1 : 0))).join("");

export function invoiceSpecs(): InvoiceSpec[] {
  const random = seeded(20261031);
  return SUPPLIERS.map(([supplier, street, town], i) => {
    const length = 9 + (i % 3); // 9, 10 or 11 digits, as South African account numbers run
    const lines = Array.from({ length: 2 + (i % 3) }, (_, j) => {
      const [description, unitCents] = ITEMS[(i + j * 3) % ITEMS.length] as [string, number];
      return { description, quantity: 1 + ((i + j) % 4), unitCents };
    });
    return {
      id: `inv-${String(i + 1).padStart(2, "0")}`,
      supplier,
      address: [street, town],
      vat: `4${digits(random, 9)}`,
      customer: CUSTOMERS[i % CUSTOMERS.length] as string,
      invoiceNumber: `INV-${2026}${String(100 + i * 37).padStart(4, "0")}`,
      date: `2026-10-${String(5 + i * 2).padStart(2, "0")}`,
      bank: BANKS[i % BANKS.length] as string,
      branchCode: digits(random, 6),
      account: digits(random, length),
      originalAccount: digits(random, length),
      lines,
      accent: ["#1f4e79", "#7a2e2e", "#2e5e3a", "#5b3f86", "#8a5a00"][i % 5] as string,
    };
  });
}

const rand = (cents: number) =>
  `R ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const totals = (spec: InvoiceSpec) => {
  const net = spec.lines.reduce((sum, line) => sum + line.quantity * line.unitCents, 0);
  const vat = Math.round(net * 0.15);
  return { net, vat, gross: net + vat };
};

// The invoice as SVG, its account number `account`, or left blank when `account` is null (an edit's patch fills it).
export function invoiceSvg(spec: InvoiceSpec, account: string | null): string {
  const { width, height } = INVOICE_SIZE;
  // `extra` may set its own fill, which then replaces the default ink.
  const t = (x: number, y: number, size: number, text: string, extra = "") =>
    `<text x="${x}" y="${y}" font-family="${BASE_FONT}" font-size="${size}"${extra.includes("fill=") ? "" : ' fill="#222"'} ${extra}>${escapeXml(text)}</text>`;
  const rows = spec.lines
    .map((line, i) => {
      const y = 640 + i * 44;
      return [
        t(80, y, 18, line.description),
        t(560, y, 18, String(line.quantity), 'text-anchor="end"'),
        t(740, y, 18, rand(line.unitCents), 'text-anchor="end"'),
        t(920, y, 18, rand(line.quantity * line.unitCents), 'text-anchor="end"'),
      ].join("");
    })
    .join("");
  const sum = totals(spec);
  const totalY = 660 + spec.lines.length * 44;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="#ffffff"/>
<rect x="0" y="0" width="${width}" height="16" fill="${spec.accent}"/>
${t(80, 110, 34, spec.supplier, `font-weight="bold" fill="${spec.accent}"`)}
${t(80, 150, 18, spec.address[0] ?? "")}${t(80, 176, 18, spec.address[1] ?? "")}
${t(80, 202, 18, `VAT no. ${spec.vat}`)}
${t(920, 290, 36, "TAX INVOICE", 'text-anchor="end" font-weight="bold"')}
${t(920, 326, 18, `Invoice ${spec.invoiceNumber}`, 'text-anchor="end"')}
${t(920, 352, 18, `Date ${spec.date}`, 'text-anchor="end"')}
${t(80, 290, 16, "BILL TO", 'fill="#666"')}${t(80, 320, 20, spec.customer)}
<rect x="60" y="580" width="880" height="36" fill="#f1f1f1"/>
${t(80, 604, 16, "Description", 'font-weight="bold"')}${t(560, 604, 16, "Qty", 'text-anchor="end" font-weight="bold"')}
${t(740, 604, 16, "Unit price", 'text-anchor="end" font-weight="bold"')}${t(920, 604, 16, "Amount", 'text-anchor="end" font-weight="bold"')}
${rows}
<line x1="560" y1="${totalY - 10}" x2="940" y2="${totalY - 10}" stroke="#999"/>
${t(740, totalY + 20, 18, "Subtotal", 'text-anchor="end"')}${t(920, totalY + 20, 18, rand(sum.net), 'text-anchor="end"')}
${t(740, totalY + 48, 18, "VAT 15%", 'text-anchor="end"')}${t(920, totalY + 48, 18, rand(sum.vat), 'text-anchor="end"')}
${t(740, totalY + 84, 22, "Total due", 'text-anchor="end" font-weight="bold"')}${t(920, totalY + 84, 22, rand(sum.gross), 'text-anchor="end" font-weight="bold"')}
<rect x="60" y="930" width="880" height="200" fill="none" stroke="#ccc"/>
${t(80, 966, 18, "PAYMENT DETAILS", 'font-weight="bold"')}
${t(80, 1006, 20, "Bank")}${t(640, 1006, 20, spec.bank)}
${t(80, 1046, 20, "Account number")}${account === null ? "" : t(ACCOUNT_TEXT.x, ACCOUNT_TEXT.y, ACCOUNT_TEXT.size, account)}
${t(80, 1086, 20, "Branch code")}${t(640, 1086, 20, spec.branchCode)}
${t(80, 1116, 16, `Reference: ${spec.invoiceNumber}`, 'fill="#666"')}
${t(80, 1220, 16, "Payment within 30 days of the invoice date. Thank you for your business.", 'fill="#666"')}
</svg>`;
}

const jpeg = (image: Sharp, quality = JPEG_QUALITY) =>
  image.jpeg({ quality, chromaSubsampling: "4:2:0", mozjpeg: false }).toBuffer();

// The twin: the invoice as issued, carrying `spec.account`, saved twice as an edit is.
export async function renderInvoice(spec: InvoiceSpec): Promise<Buffer> {
  const issued = await jpeg(sharp(Buffer.from(invoiceSvg(spec, spec.account))));
  return jpeg(sharp(issued));
}

// The patch an edit pastes over ACCOUNT_BOX: white, carrying `spec.account` drawn the edit's way.
export async function patch(spec: InvoiceSpec, kind: EditKind): Promise<Buffer> {
  const { width, height } = ACCOUNT_BOX;
  const x = ACCOUNT_TEXT.x - ACCOUNT_BOX.left;
  const y = ACCOUNT_TEXT.y - ACCOUNT_BOX.top;
  const style =
    kind === "font"
      ? { family: OTHER_FONT, dx: 0, dy: 0, spacing: 0 }
      : kind === "spacing"
        ? { family: BASE_FONT, dx: 1, dy: -2, spacing: 1.6 }
        : { family: BASE_FONT, dx: 0, dy: 0, spacing: 0 };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="${x + style.dx}" y="${y + style.dy}" font-family="${style.family}" font-size="${ACCOUNT_TEXT.size}"
 letter-spacing="${style.spacing}" fill="#222">${escapeXml(spec.account)}</text></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  // A pasted screenshot carries its own, heavier compression.
  return kind === "recompress" ? jpeg(sharp(png), PATCH_QUALITY) : png;
}

// The edit: the invoice as issued with the supplier's real number, saved, then the patch pasted over that number and
// the whole saved again.
export async function editInvoice(spec: InvoiceSpec, kind: EditKind): Promise<Buffer> {
  const issued = await jpeg(sharp(Buffer.from(invoiceSvg(spec, spec.originalAccount))));
  const piece = await patch(spec, kind);
  return jpeg(sharp(issued).composite([{ input: piece, left: ACCOUNT_BOX.left, top: ACCOUNT_BOX.top }]));
}

export const editKindFor = (index: number): EditKind => EDIT_KINDS[index % EDIT_KINDS.length] as EditKind;
