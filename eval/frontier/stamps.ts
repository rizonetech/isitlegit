// The stamps experiment (D08 T03 section 2): does SAM segmentation plus crops beat the whole page?
//   node eval/frontier/stamps.ts build [--out <dir>]   # 20 code-made POP pairs and manifest.json
//   node eval/frontier/stamps.ts score [--results <file>] [--check <log>]
// Both arms receive the same genuine reference and the same Spark settings; labels never enter a prompt.
// Spend is capped at US$1.50 through the shared ledger (owner eval-frontier), as section 1's digits run.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { z } from "zod";

export const SET_DIR = join(import.meta.dirname, "sets/stamps");
export const RUN_CAP_USD = 1.5;
export const STAMP_BOX = { left: 480, top: 700, width: 260, height: 180 };
export const SIGNATURE_BOX = { left: 80, top: 760, width: 300, height: 120 };

const sha256 = (d: Uint8Array | string) => createHash("sha256").update(d).digest("hex");
export function writeAtomic(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export const ManifestEntry = z.strictObject({
  file: z.string(),
  label: z.enum(["genuine", "doctored"]),
  alteration: z.string(),
  sha256: z.string(),
});
export type ManifestEntry = z.infer<typeof ManifestEntry>;

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
// A synthetic proof of payment: fictional bank and business, a stamp and a signature. The doctored variants
// change the stamp's date text, swap the signature path, or restamp in another colour with a pasted edge.
function popSvg(i: number, kind: "genuine" | "doctored", alteration: string): string {
  const date = kind === "doctored" && alteration === "stamp-date" ? "2026-03-14" : "2026-01-09";
  const stampColour = kind === "doctored" && alteration === "stamp-colour" ? "#cc2222" : "#2244aa";
  const sig =
    kind === "doctored" && alteration === "signature-swap"
      ? "M20 80 C 80 10, 140 110, 200 40 S 290 70, 295 60"
      : "M20 70 C 70 20, 130 100, 190 50 S 280 30, 295 75";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000">
<rect width="800" height="1000" fill="#fdfcf8"/>
<text x="60" y="80" font-family="DejaVu Sans" font-size="30" fill="#222">Protea Bank (fictional)</text>
<text x="60" y="140" font-family="DejaVu Sans" font-size="22" fill="#333">Proof of payment ${1000 + i}</text>
<text x="60" y="200" font-family="DejaVu Sans" font-size="20" fill="#333">Paid to Fynbos Freight (fictional), R 12 400.00</text>
<text x="60" y="240" font-family="DejaVu Sans" font-size="20" fill="#333">Date ${date}</text>
<g transform="translate(${STAMP_BOX.left},${STAMP_BOX.top})">
<circle cx="130" cy="90" r="78" fill="none" stroke="${stampColour}" stroke-width="5"/>
<text x="130" y="82" text-anchor="middle" font-family="DejaVu Sans" font-size="21" fill="${stampColour}">PAID</text>
<text x="130" y="110" text-anchor="middle" font-family="DejaVu Sans" font-size="17" fill="${stampColour}">${esc(date)}</text>
</g>
<g transform="translate(${SIGNATURE_BOX.left},${SIGNATURE_BOX.top})">
<path d="${sig}" fill="none" stroke="#1a1a6e" stroke-width="4"/>
<line x1="10" y1="105" x2="300" y2="105" stroke="#999" stroke-width="1"/>
</g></svg>`;
}

export async function buildSet(dir = SET_DIR): Promise<ManifestEntry[]> {
  if (existsSync(dir)) throw new Error(`${dir} exists: a rebuilt set goes to another folder`);
  const staging = `${dir}.building`;
  mkdirSync(staging, { recursive: true });
  const entries: ManifestEntry[] = [];
  const alterations = ["stamp-date", "signature-swap", "stamp-colour", "none", "none"];
  for (let i = 0; i < 20; i++) {
    const kind = i % 2 === 0 ? "genuine" : "doctored";
    const alteration = kind === "genuine" ? "none" : (alterations[i % alterations.length] as string);
    const png = await sharp(Buffer.from(popSvg(i, kind, alteration))).png().toBuffer();
    const file = `pop-${String(i + 1).padStart(2, "0")}-${kind}.png`;
    writeAtomic(join(staging, file), png);
    entries.push({ file, label: kind, alteration, sha256: sha256(png) });
  }
  // The genuine reference both arms receive: the first genuine page's stamp region, cut at the known box.
  const first = entries.find((e) => e.label === "genuine");
  const ref = await sharp(join(staging, first?.file ?? "")).extract(STAMP_BOX).png().toBuffer();
  writeAtomic(join(staging, "reference-stamp.png"), ref);
  writeAtomic(join(staging, "manifest.json"), `${JSON.stringify(entries, null, 1)}\n`);
  renameSync(staging, dir);
  return entries;
}

// The two arms' request payloads (tested, labels withheld): whole page with reference, or crops with reference.
export function wholePagePayload(pagePng: Buffer, referencePng: Buffer) {
  const img = (b: Buffer) => ({ type: "input_image", image_url: `data:image/png;base64,${b.toString("base64")}` });
  return [img(referencePng), img(pagePng)];
}
export function chainPayload(referencePng: Buffer, stampCrop: Buffer, signatureCrop: Buffer) {
  const img = (b: Buffer) => ({ type: "input_image", image_url: `data:image/png;base64,${b.toString("base64")}` });
  return [img(referencePng), img(stampCrop), img(signatureCrop)];
}

export const ArmOutcome = z.strictObject({
  file: z.string(),
  arm: z.enum(["whole", "chain"]),
  status: z.enum(["answered", "refused", "malformed", "timeout", "budget-stopped"]),
  doctored: z.boolean().nullable(),
  ms: z.number().nullable(),
  usd: z.number(),
});
export type ArmOutcome = z.infer<typeof ArmOutcome>;

export function scoreOutcomes(entries: ManifestEntry[], outcomes: ArmOutcome[]) {
  const byArm = (arm: "whole" | "chain") => {
    const rows = outcomes.filter((o) => o.arm === arm);
    const answered = rows.filter((o) => o.status === "answered");
    const attacks = answered.filter((o) => entries.find((e) => e.file === o.file)?.label === "doctored");
    const genuine = answered.filter((o) => entries.find((e) => e.file === o.file)?.label === "genuine");
    return {
      outcomes: rows.length,
      answered: answered.length,
      detection: attacks.length ? attacks.filter((o) => o.doctored).length / attacks.length : null,
      falsePositives: genuine.length ? genuine.filter((o) => o.doctored).length / genuine.length : null,
      totalUsd: rows.reduce((a, o) => a + o.usd, 0),
    };
  };
  return { whole: byArm("whole"), chain: byArm("chain") };
}

export function checkLog(logText: string, entries: ManifestEntry[], outcomes: ArmOutcome[]): string[] {
  const problems: string[] = [];
  for (const e of entries)
    for (const arm of ["whole", "chain"] as const)
      if (!outcomes.some((o) => o.file === e.file && o.arm === arm)) problems.push(`${e.file}: no ${arm} outcome`);
  const s = scoreOutcomes(entries, outcomes);
  for (const [arm, f] of [
    ["whole", s.whole],
    ["chain", s.chain],
  ] as const) {
    if (f.detection !== null && !logText.includes(`${arm} detection ${(100 * f.detection).toFixed(1)}%`))
      problems.push(`${arm} detection figure missing or differs in the log`);
    if (!logText.includes(`${arm} cost US$${f.totalUsd.toFixed(4)}`)) problems.push(`${arm} cost missing or differs in the log`);
  }
  return problems;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "build") {
    const out = rest[rest.indexOf("--out") + 1] ?? SET_DIR;
    const entries = await buildSet(rest.includes("--out") ? out : SET_DIR);
    console.log(`stamps: built ${entries.length} pairs in ${out}`);
    return 0;
  }
  if (cmd === "score") {
    const resultsFile = rest[rest.indexOf("--results") + 1] ?? join(SET_DIR, "results.json");
    const entries = ManifestEntry.array().parse(JSON.parse(readFileSync(join(SET_DIR, "manifest.json"), "utf8")));
    const outcomes = ArmOutcome.array().parse(JSON.parse(readFileSync(resultsFile, "utf8")));
    const s = scoreOutcomes(entries, outcomes);
    for (const arm of ["whole", "chain"] as const) {
      const f = s[arm];
      console.log(
        `${arm} detection ${f.detection === null ? "not measured" : `${(100 * f.detection).toFixed(1)}%`}, ${arm} cost US$${f.totalUsd.toFixed(4)}, answered ${f.answered} of ${f.outcomes}`,
      );
    }
    const check = rest[rest.indexOf("--check") + 1];
    if (check) {
      const problems = checkLog(readFileSync(check, "utf8"), entries, outcomes);
      for (const p of problems) console.error(`stamps: ${p}`);
      return problems.length ? 1 : 0;
    }
    return 0;
  }
  console.error("usage: node eval/frontier/stamps.ts build [--out <dir>] | score [--results <file>] [--check <log>]");
  return 3;
}

if (process.argv[1] && import.meta.filename === process.argv[1])
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`stamps: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
