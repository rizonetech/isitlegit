// The stamps experiment (D08 T03 section 2): does SAM segmentation plus crops beat the whole page?
//   node eval/frontier/stamps.ts build [--out <dir>]   # 20 code-made POP pairs and manifest.json
//   node eval/frontier/stamps.ts run [--dir <dir>]     # runs whole and chain arms under US$1.50 cap
//   node eval/frontier/stamps.ts score [--results <file>] [--check <log>]
// Both arms receive the same genuine reference and the same Spark settings; labels never enter a prompt.
// Spend is capped at US$1.50 through the shared ledger (owner eval-frontier), as section 1's digits run.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { z } from "zod";

export const SET_DIR = join(import.meta.dirname, "sets/stamps");
export const RUN_CAP_USD = 1.5;
export const STAMP_BOX = { left: 480, top: 700, width: 260, height: 180 };
export const SIGNATURE_BOX = { left: 80, top: 760, width: 300, height: 120 };
export const REFERENCE_BOX = { left: 60, top: 690, width: 690, height: 200 };
export const MODEL_ID = "muse-spark-1.3";
export const REASONING_EFFORT = "low" as const;
export const MAX_OUTPUT_TOKENS = 4000;

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
  alteration: z.enum(["none", "stamp-date", "signature-swap", "stamp-colour"]),
  sha256: z.string(),
});
export type ManifestEntry = z.infer<typeof ManifestEntry>;

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
// A synthetic proof of payment: fictional bank and business, a stamp and a signature. The doctored variants
// change the stamp's date text (while the payment date stays 2026-01-09), swap the signature path, or restamp in red.
function popSvg(i: number, kind: "genuine" | "doctored", alteration: ManifestEntry["alteration"]): string {
  const paymentDate = "2026-01-09";
  const stampDate = kind === "doctored" && alteration === "stamp-date" ? "2026-03-14" : paymentDate;
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
<text x="60" y="240" font-family="DejaVu Sans" font-size="20" fill="#333">Payment date ${paymentDate}</text>
<g transform="translate(${STAMP_BOX.left},${STAMP_BOX.top})">
<circle cx="130" cy="90" r="78" fill="none" stroke="${stampColour}" stroke-width="5"/>
<text x="130" y="82" text-anchor="middle" font-family="DejaVu Sans" font-size="21" fill="${stampColour}">PAID</text>
<text x="130" y="110" text-anchor="middle" font-family="DejaVu Sans" font-size="17" fill="${stampColour}">${esc(stampDate)}</text>
</g>
<g transform="translate(${SIGNATURE_BOX.left},${SIGNATURE_BOX.top})">
<path d="${sig}" fill="none" stroke="#1a1a6e" stroke-width="4"/>
<line x1="10" y1="105" x2="300" y2="105" stroke="#999" stroke-width="1"/>
</g></svg>`;
}

export async function buildSet(dir = SET_DIR): Promise<ManifestEntry[]> {
  if (existsSync(dir)) throw new Error(`${dir} exists: a rebuilt set goes to another folder`);
  const staging = `${dir}.building`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const entries: ManifestEntry[] = [];
  const alterations = ["stamp-date", "signature-swap", "stamp-colour"] as const;
  for (let i = 0; i < 20; i++) {
    const kind = i % 2 === 0 ? "genuine" : "doctored";
    const alteration =
      kind === "genuine" ? "none" : (alterations[Math.floor(i / 2) % alterations.length] ?? "stamp-date");
    const png = await sharp(Buffer.from(popSvg(i, kind, alteration)))
      .png()
      .toBuffer();
    const file = `pop-${String(i + 1).padStart(2, "0")}-${kind}.png`;
    writeAtomic(join(staging, file), png);
    entries.push({ file, label: kind, alteration, sha256: sha256(png) });
  }
  // The genuine reference both arms receive: the first genuine page's signature and stamp band.
  const first = entries.find((e) => e.label === "genuine");
  const ref = await sharp(join(staging, first?.file ?? ""))
    .extract(REFERENCE_BOX)
    .png()
    .toBuffer();
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
  samBoxes: z.number().optional(),
});
export type ArmOutcome = z.infer<typeof ArmOutcome>;

export const STAMP_ANSWER = z.strictObject({ doctored: z.boolean(), reason: z.string() });
export const PROMPT =
  "The first image is a genuine Protea Bank reference showing the authentic signature (left) and bank stamp (right, blue, dated matching the payment date). Judge whether the stamp or signature in the following image or crops was doctored (altered date, changed stamp colour, or swapped signature) compared with the genuine reference. Answer only through the schema.";
export const ESTIMATE_USD = { segment: 0.0025, spark: 0.02 };

export function experimentFingerprint(entries: readonly ManifestEntry[]): string {
  return sha256(
    JSON.stringify({
      prompt: PROMPT,
      model: MODEL_ID,
      effort: REASONING_EFFORT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      files: entries.map((e) => `${e.file}:${e.label}:${e.alteration}:${e.sha256}`),
    }),
  );
}

// Failure-aware scoring: every doctored and genuine entry in the manifest stays in the denominator; an unanswered,
// refused, malformed, timed-out or budget-stopped case counts as missed (never dropped from the denominator).
export function scoreOutcomes(entries: ManifestEntry[], outcomes: ArmOutcome[]) {
  const totalAttacks = entries.filter((e) => e.label === "doctored");
  const totalGenuine = entries.filter((e) => e.label === "genuine");
  const byArm = (arm: "whole" | "chain") => {
    const rows = outcomes.filter((o) => o.arm === arm);
    const answered = rows.filter((o) => o.status === "answered");
    const caught = totalAttacks.filter((e) => answered.some((o) => o.file === e.file && o.doctored === true)).length;
    const falseAlarms = totalGenuine.filter((e) =>
      answered.some((o) => o.file === e.file && o.doctored === true),
    ).length;
    const times = answered
      .map((o) => o.ms)
      .filter((ms): ms is number => typeof ms === "number" && ms >= 0)
      .sort((a, b) => a - b);
    const medianMs = times.length ? (times[Math.floor((times.length - 1) / 2)] ?? null) : null;
    const maxMs = times.length ? (times[times.length - 1] ?? null) : null;
    return {
      outcomes: rows.length,
      answered: answered.length,
      caught,
      attacks: totalAttacks.length,
      falseAlarms,
      genuine: totalGenuine.length,
      detection: totalAttacks.length ? caught / totalAttacks.length : null,
      falsePositives: totalGenuine.length ? falseAlarms / totalGenuine.length : null,
      medianMs,
      maxMs,
      totalUsd: rows.reduce((a, o) => a + o.usd, 0),
    };
  };
  return { whole: byArm("whole"), chain: byArm("chain"), fingerprint: experimentFingerprint(entries) };
}

export type StampDecision = "feature" | "cut" | "open question";

// Preset adoption rule (D08 T03 §2 correction 6): feature when chain detects >= 80% (at least 8 of 10), raises at
// most 10% false positives (at most 1 of 10), and beats whole-page detection; cut when chain detects no more than
// whole-page or raises >= 30% false positives; otherwise open question.
export function decideStamps(score: ReturnType<typeof scoreOutcomes>): StampDecision {
  const { whole, chain } = score;
  if (chain.detection === null || chain.falsePositives === null || whole.detection === null) return "open question";
  if (chain.answered < chain.outcomes || whole.answered < whole.outcomes) {
    if (chain.falsePositives >= 0.3) return "cut";
  }
  if (chain.detection >= 0.8 && chain.falsePositives <= 0.1 && chain.detection > whole.detection) return "feature";
  if (chain.detection <= whole.detection || chain.falsePositives >= 0.3) return "cut";
  return "open question";
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
    if (f.answered === 0) problems.push(`${arm} arm has 0 answered outcomes`);
    if (f.detection !== null && !logText.includes(`${arm} detection ${(100 * f.detection).toFixed(1)}%`))
      problems.push(`${arm} detection figure missing or differs in the log`);
    if (
      f.falsePositives !== null &&
      !logText.includes(`${arm} false positives ${(100 * f.falsePositives).toFixed(1)}%`)
    )
      problems.push(`${arm} false-positive figure missing or differs in the log`);
    if (!logText.includes(`${arm} cost US$${f.totalUsd.toFixed(4)}`))
      problems.push(`${arm} cost missing or differs in the log`);
  }
  const decision = decideStamps(s);
  if (!logText.includes(`Decision: ${decision}`)) problems.push(`decision (${decision}) missing or differs in the log`);
  if (!logText.includes(`fingerprint: ${s.fingerprint}`))
    problems.push(`fingerprint (${s.fingerprint}) missing or differs in the log`);
  if (!logText.includes(PROMPT)) problems.push("prompt text missing from the log");
  if (decision === "feature" && !/\bD\d{2} T\d{2} §\d+\b/.test(logText))
    problems.push("feature decision must name an implementation section ref (DNN TNN §N)");
  return problems;
}

export type StampDeps = {
  segment: (
    png: Buffer,
    concept: "stamp" | "signature",
  ) => Promise<{ left: number; top: number; width: number; height: number }[]>;
  ask: (images: Buffer[]) => Promise<{ doctored: boolean; usd?: number }>;
  spentUsd: () => number;
};

function clampCropBox(
  box: { left: number; top: number; width: number; height: number },
  imgWidth = 800,
  imgHeight = 1000,
) {
  const left = Math.max(0, Math.min(imgWidth - 1, Math.round(box.left)));
  const top = Math.max(0, Math.min(imgHeight - 1, Math.round(box.top)));
  const width = Math.max(1, Math.min(imgWidth - left, Math.round(box.width)));
  const height = Math.max(1, Math.min(imgHeight - top, Math.round(box.height)));
  return { left, top, width, height };
}

// One budgeted run over every pair and arm: an outcome per case and arm, stopping at the cap, never resending
// a case an earlier run answered (the results file is the progress record).
export async function runStamps(
  dir: string,
  deps: StampDeps,
  resultsFile = join(dir, "results.json"),
): Promise<{ outcomes: ArmOutcome[]; stopped: string | null }> {
  const entries = ManifestEntry.array().parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const outcomes: ArmOutcome[] = existsSync(resultsFile)
    ? ArmOutcome.array().parse(JSON.parse(readFileSync(resultsFile, "utf8")))
    : [];
  const save = () => writeAtomic(resultsFile, `${JSON.stringify(outcomes, null, 1)}\n`);
  const reference = readFileSync(join(dir, "reference-stamp.png"));
  let stopped: string | null = null;
  const upsert = (row: ArmOutcome) => {
    const idx = outcomes.findIndex((o) => o.file === row.file && o.arm === row.arm);
    if (idx >= 0) outcomes[idx] = row;
    else outcomes.push(row);
    save();
  };
  for (const entry of entries) {
    const page = readFileSync(join(dir, entry.file));
    for (const arm of ["whole", "chain"] as const) {
      if (outcomes.some((o) => o.file === entry.file && o.arm === arm && o.status === "answered")) continue;
      if (deps.spentUsd() >= RUN_CAP_USD) {
        stopped = `budget cap US$${RUN_CAP_USD} reached`;
        upsert({
          file: entry.file,
          arm,
          status: "budget-stopped",
          doctored: null,
          ms: null,
          usd: 0,
        });
        continue;
      }
      const t0 = Date.now();
      let segCost = 0;
      let samBoxes = 0;
      try {
        let images: Buffer[];
        if (arm === "whole") {
          images = [reference, page];
        } else {
          const crops: Buffer[] = [reference];
          for (const concept of ["stamp", "signature"] as const) {
            const boxes = await deps.segment(page, concept);
            segCost += ESTIMATE_USD.segment;
            samBoxes += boxes.length;
            const rawBox = boxes[0] ?? (concept === "stamp" ? STAMP_BOX : SIGNATURE_BOX);
            const box = clampCropBox(rawBox);
            crops.push(await sharp(page).extract(box).png().toBuffer());
          }
          images = crops;
        }
        const answer = await deps.ask(images);
        const callUsd = (answer.usd ?? ESTIMATE_USD.spark) + segCost;
        upsert({
          file: entry.file,
          arm,
          status: "answered",
          doctored: answer.doctored,
          ms: Date.now() - t0,
          usd: Number(callUsd.toFixed(6)),
          ...(arm === "chain" ? { samBoxes } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = /timeout|timed out/i.test(msg) ? "timeout" : /refus/i.test(msg) ? "refused" : "malformed";
        upsert({
          file: entry.file,
          arm,
          status,
          doctored: null,
          ms: Date.now() - t0,
          usd: Number(segCost.toFixed(6)),
        });
      }
    }
  }
  return { outcomes, stopped };
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "build") {
    const out = rest[rest.indexOf("--out") + 1] ?? SET_DIR;
    const entries = await buildSet(rest.includes("--out") ? out : SET_DIR);
    console.log(`stamps: built ${entries.length} pairs in ${out}`);
    return 0;
  }
  if (cmd === "run") {
    register("../../scripts/lib/ts-resolve.mjs", import.meta.url);
    const { readSecretsFromVault, GATEWAY_URL, metaLedger } = await import("../../scripts/meta-smoke.ts");
    const { sharedLedger } = await import("./digits.ts");
    const { structured } = await import("../../src/meta/structured.ts");
    const samPath = "../../src/vision/sam.ts";
    const { segment } = (await import(samPath)) as {
      segment: (
        ctx: unknown,
        imageDataUrl: string,
        concept: "stamp" | "signature",
      ) => Promise<{ left: number; top: number; right: number; bottom: number; confidence: number | null }[]>;
    };
    const secrets = await readSecretsFromVault();
    const ledger = sharedLedger(metaLedger(), "stamps-v2", { capUsd: RUN_CAP_USD });
    let callNo = 0;
    let spent = 0;
    const reservedBy = new Map<string, number>();
    const budget = {
      reserve: async (_model: string, estimateUsd: number) => {
        const r = await ledger.reserve(`call-${++callNo}`, estimateUsd);
        reservedBy.set(r, estimateUsd);
        spent += estimateUsd;
        return r;
      },
      refused: async () => {},
      cached: async () => {},
      outputFailed: async () => {},
      settle: async (id: string, actualUsd: number) => {
        const est = reservedBy.get(id) ?? 0;
        spent = Math.max(0, spent - est + actualUsd);
        await ledger.settle(id, actualUsd);
      },
      uncertain: async (id: string) => ledger.uncertain(id),
    };
    const ctx = {
      env: { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL },
      budget,
      owner: "eval-frontier",
      waitUntil: () => {},
    };
    const deps: StampDeps = {
      segment: async (png, concept) => {
        const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
        const boxes = await segment(ctx, dataUrl, concept);
        return boxes.map((b) => ({
          left: b.left,
          top: b.top,
          width: b.right - b.left,
          height: b.bottom - b.top,
        }));
      },
      ask: async (images) => {
        const out = await structured(
          STAMP_ANSWER,
          {
            name: "stamp_doctor_check",
            model: MODEL_ID,
            instructions: PROMPT,
            input: [
              {
                role: "user" as const,
                content: images.map((b) => ({
                  type: "input_image" as const,
                  image_url: `data:image/png;base64,${b.toString("base64")}`,
                  detail: "high" as const,
                })),
              },
            ],
            max_output_tokens: MAX_OUTPUT_TOKENS,
            reasoning: { effort: REASONING_EFFORT },
          },
          ctx as never,
        );
        return { doctored: out.value.doctored };
      },
      spentUsd: () => spent,
    };
    const dirAt = rest.indexOf("--dir");
    const targetDir = (dirAt >= 0 ? rest[dirAt + 1] : undefined) ?? SET_DIR;
    const out = await runStamps(targetDir, deps);
    console.log(`stamps: ${out.outcomes.length} outcomes${out.stopped ? `, stopped: ${out.stopped}` : ""}`);
    return out.stopped ? 2 : 0;
  }
  if (cmd === "score") {
    const resultsAt = rest.indexOf("--results");
    const resultsFile = (resultsAt >= 0 ? rest[resultsAt + 1] : undefined) ?? join(SET_DIR, "results.json");
    const entries = ManifestEntry.array().parse(JSON.parse(readFileSync(join(SET_DIR, "manifest.json"), "utf8")));
    const outcomes = ArmOutcome.array().parse(JSON.parse(readFileSync(resultsFile, "utf8")));
    const s = scoreOutcomes(entries, outcomes);
    for (const arm of ["whole", "chain"] as const) {
      const f = s[arm];
      console.log(
        `${arm} detection ${f.detection === null ? "not measured" : `${(100 * f.detection).toFixed(1)}%`} (${f.caught}/${f.attacks}), ${arm} false positives ${f.falsePositives === null ? "not measured" : `${(100 * f.falsePositives).toFixed(1)}%`} (${f.falseAlarms}/${f.genuine}), ${arm} cost US$${f.totalUsd.toFixed(4)}, median ${f.medianMs ?? "n/a"} ms, worst ${f.maxMs ?? "n/a"} ms, answered ${f.answered} of ${f.outcomes}`,
      );
    }
    console.log(`Decision: ${decideStamps(s)} | fingerprint: ${experimentFingerprint(entries)}`);
    const checkAt = rest.indexOf("--check");
    const check = checkAt >= 0 ? rest[checkAt + 1] : undefined;
    if (check) {
      const problems = checkLog(readFileSync(check, "utf8"), entries, outcomes);
      for (const p of problems) console.error(`stamps: ${p}`);
      return problems.length ? 1 : 0;
    }
    return 0;
  }
  console.error(
    "usage: node eval/frontier/stamps.ts build [--out <dir>] | run [--dir <dir>] | score [--results <file>] [--check <log>]",
  );
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
