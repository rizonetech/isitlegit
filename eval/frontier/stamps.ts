// The stamps experiment (D08 T03 section 2): does SAM segmentation plus crops beat the whole page?
//   node eval/frontier/stamps.ts build [--out <dir>]   # 20 code-made POP pairs (40 pages) and manifest.json
//   node eval/frontier/stamps.ts run [--dir <dir>] [--retry-failed]  # runs whole and chain arms under US$1.50 cap
//   node eval/frontier/stamps.ts score [--dir <dir>] [--results <file>] [--check <log>]
// Both arms receive the same genuine reference and the same Spark settings; labels never enter a prompt.
// Spend is capped at US$1.50 through localBudget and the shared ledger (owner eval-frontier), stopping on any refusal.
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
export const SAM_MODEL_ID = "sam-3.1";
export const SAM_CONCEPTS = ["stamp", "signature"] as const;
export const MAX_CROPS_PER_CONCEPT = 4;
export const PAGE_WIDTH = 800;
export const PAGE_HEIGHT = 1000;
export const MAX_CHAIN_MEDIAN_MS = 15_000;
export const MAX_CHAIN_MAX_MS = 30_000;
export const REASONING_EFFORT = "low" as const;
export const MAX_OUTPUT_TOKENS = 4000;

export const sha256 = (d: Uint8Array | string) => createHash("sha256").update(d).digest("hex");
export function writeAtomic(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export const ManifestEntry = z.strictObject({
  file: z.string(),
  pairId: z.string(),
  label: z.enum(["genuine", "doctored"]),
  alteration: z.enum(["none", "stamp-date", "signature-swap", "stamp-colour"]),
  sha256: z.string(),
});
export type ManifestEntry = z.infer<typeof ManifestEntry>;

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
// A synthetic proof of payment: fictional bank and business, a stamp and a signature. The doctored variants
// change the stamp's date text (while the payment date stays 2026-01-09), swap the signature path, or restamp in red.
function popSvg(pairIndex: number, kind: "genuine" | "doctored", alteration: ManifestEntry["alteration"]): string {
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
<text x="60" y="140" font-family="DejaVu Sans" font-size="22" fill="#333">Proof of payment ${1000 + pairIndex}</text>
<text x="60" y="200" font-family="DejaVu Sans" font-size="20" fill="#333">Paid to Fynbos Freight (fictional), R 12 400.00</text>
<text x="60" y="240" font-family="DejaVu Sans" font-size="20" fill="#333">Payment date ${paymentDate}</text>
<text x="60" y="280" font-family="DejaVu Sans" font-size="16" fill="#666">SYNTHETIC TEST DOCUMENT</text>
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
    const pairNum = String(i + 1).padStart(2, "0");
    const pairId = `pair-${pairNum}`;
    const docAlteration = alterations[i % alterations.length] ?? "stamp-date";
    for (const kind of ["genuine", "doctored"] as const) {
      const alteration = kind === "genuine" ? "none" : docAlteration;
      const png = await sharp(Buffer.from(popSvg(i, kind, alteration)))
        .png()
        .toBuffer();
      const file = `pop-${pairNum}-${kind}.png`;
      writeAtomic(join(staging, file), png);
      entries.push({ file, pairId, label: kind, alteration, sha256: sha256(png) });
    }
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
  status: z.enum(["pending", "answered", "empty-segmentation", "refused", "malformed", "timeout", "budget-stopped"]),
  doctored: z.boolean().nullable(),
  ms: z.number().nonnegative().finite().nullable(),
  usd: z.number().nonnegative().finite(),
  attempts: z.number().int().nonnegative(),
  fileSha256: z.string(),
  fingerprint: z.string(),
  samBoxes: z.number().int().nonnegative().optional(),
});
export type ArmOutcome = z.infer<typeof ArmOutcome>;

export const STAMP_ANSWER = z.strictObject({ doctored: z.boolean(), reason: z.string() });
export const PROMPT =
  "The first image is a genuine Protea Bank reference showing the authentic signature (left) and bank stamp (right, blue, dated matching the payment date). Judge whether the stamp or signature in the following image or crops was doctored (altered date, changed stamp colour, or swapped signature) compared with the genuine reference. Answer only through the schema.";
export const ESTIMATE_USD = { segment: 0.0025, spark: 0.02 };

export type FingerprintConfig = {
  samModel?: string;
  samConcepts?: readonly string[];
  maxCropsPerConcept?: number;
  pageWidth?: number;
  pageHeight?: number;
};

export function experimentFingerprint(
  entries: readonly ManifestEntry[],
  referenceSha256 = "ref",
  config?: FingerprintConfig,
): string {
  return sha256(
    JSON.stringify({
      prompt: PROMPT,
      model: MODEL_ID,
      effort: REASONING_EFFORT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      samModel: config?.samModel ?? SAM_MODEL_ID,
      samConcepts: config?.samConcepts ?? SAM_CONCEPTS,
      maxCropsPerConcept: config?.maxCropsPerConcept ?? MAX_CROPS_PER_CONCEPT,
      pageWidth: config?.pageWidth ?? PAGE_WIDTH,
      pageHeight: config?.pageHeight ?? PAGE_HEIGHT,
      referenceSha256,
      files: entries.map((e) => `${e.file}:${e.pairId}:${e.label}:${e.alteration}:${e.sha256}`),
    }),
  );
}

export function verifySetOnDisk(
  dir: string,
  entries: readonly ManifestEntry[],
): {
  referenceSha256: string;
  fingerprint: string;
  problems: string[];
} {
  const problems: string[] = [];
  const refPath = join(dir, "reference-stamp.png");
  let referenceSha256 = "";
  if (!existsSync(refPath)) {
    problems.push("reference-stamp.png is missing on disk");
  } else {
    referenceSha256 = sha256(readFileSync(refPath));
  }
  for (const e of entries) {
    const p = join(dir, e.file);
    if (!existsSync(p)) {
      problems.push(`${e.file}: missing on disk`);
      continue;
    }
    const actual = sha256(readFileSync(p));
    if (actual !== e.sha256) problems.push(`${e.file}: on-disk sha256 (${actual}) differs from manifest (${e.sha256})`);
  }
  const fingerprint = experimentFingerprint(entries, referenceSha256);
  return { referenceSha256, fingerprint, problems };
}

// Failure-aware scoring: every doctored and genuine entry in the manifest stays in the denominator; an unanswered,
// empty-segmentation, refused, malformed, timed-out, pending or budget-stopped case counts as missed (never dropped).
// Every stored outcome is validated against its manifest entry sha256, experiment fingerprint, duplicate keys and
// terminal field invariants before scoring.
export function validateOutcomes(
  entries: readonly ManifestEntry[],
  outcomes: readonly ArmOutcome[],
  referenceSha256 = "ref",
): string[] {
  const problems: string[] = [];
  const expectedFp = experimentFingerprint(entries, referenceSha256);
  const byFile = new Map(entries.map((e) => [e.file, e]));
  const seen = new Set<string>();
  for (const o of outcomes) {
    const key = `${o.file}:${o.arm}`;
    if (seen.has(key)) problems.push(`${o.file} (${o.arm}): duplicate outcome record`);
    seen.add(key);
    const entry = byFile.get(o.file);
    if (!entry) {
      problems.push(`${o.file}: outcome names file not in manifest`);
      continue;
    }
    if (o.fileSha256 !== entry.sha256)
      problems.push(
        `${o.file} (${o.arm}): outcome fileSha256 (${o.fileSha256}) differs from manifest (${entry.sha256})`,
      );
    if (o.fingerprint !== expectedFp)
      problems.push(
        `${o.file} (${o.arm}): outcome fingerprint (${o.fingerprint}) differs from experiment (${expectedFp})`,
      );
    if (!Number.isFinite(o.usd) || o.usd < 0) problems.push(`${o.file} (${o.arm}): invalid usd (${o.usd})`);
    if (o.status === "pending" || o.status === "budget-stopped") {
      problems.push(`${o.file} (${o.arm}): incomplete outcome status ${o.status}`);
      continue;
    }
    if (typeof o.ms !== "number" || !Number.isFinite(o.ms) || o.ms < 0)
      problems.push(`${o.file} (${o.arm}): terminal outcome missing non-negative ms (${o.ms})`);
    if (!Number.isInteger(o.attempts) || o.attempts < 1)
      problems.push(`${o.file} (${o.arm}): terminal outcome requires attempts >= 1 (${o.attempts})`);
    if (o.status === "answered") {
      if (typeof o.doctored !== "boolean")
        problems.push(`${o.file} (${o.arm}): answered outcome has non-boolean doctored (${o.doctored})`);
    } else if (o.doctored !== null) {
      problems.push(`${o.file} (${o.arm}): non-answered outcome (${o.status}) must have null doctored`);
    }
  }
  for (const e of entries)
    for (const arm of ["whole", "chain"] as const)
      if (!outcomes.some((o) => o.file === e.file && o.arm === arm)) problems.push(`${e.file}: no ${arm} outcome`);
  return problems;
}

export function scoreOutcomes(entries: ManifestEntry[], outcomes: ArmOutcome[], referenceSha256 = "ref") {
  const expectedFp = experimentFingerprint(entries, referenceSha256);
  const byFile = new Map(entries.map((e) => [e.file, e]));
  const seen = new Set<string>();
  for (const o of outcomes) {
    const key = `${o.file}:${o.arm}`;
    if (seen.has(key)) throw new Error(`${o.file} (${o.arm}): duplicate outcome record`);
    seen.add(key);
    const entry = byFile.get(o.file);
    if (!entry) throw new Error(`${o.file}: outcome names file not in manifest`);
    if (o.fileSha256 !== entry.sha256)
      throw new Error(
        `${o.file} (${o.arm}): outcome fileSha256 (${o.fileSha256}) differs from manifest (${entry.sha256})`,
      );
    if (o.fingerprint !== expectedFp)
      throw new Error(
        `${o.file} (${o.arm}): outcome fingerprint (${o.fingerprint}) differs from experiment (${expectedFp})`,
      );
    if (!Number.isFinite(o.usd) || o.usd < 0) throw new Error(`${o.file} (${o.arm}): invalid usd (${o.usd})`);
    if (o.status !== "pending" && o.status !== "budget-stopped") {
      if (typeof o.ms !== "number" || !Number.isFinite(o.ms) || o.ms < 0)
        throw new Error(`${o.file} (${o.arm}): terminal outcome missing non-negative ms (${o.ms})`);
      if (!Number.isInteger(o.attempts) || o.attempts < 1)
        throw new Error(`${o.file} (${o.arm}): terminal outcome requires attempts >= 1 (${o.attempts})`);
      if (o.status === "answered" && typeof o.doctored !== "boolean")
        throw new Error(`${o.file} (${o.arm}): answered outcome has non-boolean doctored`);
      if (o.status !== "answered" && o.doctored !== null)
        throw new Error(`${o.file} (${o.arm}): non-answered outcome (${o.status}) must have null doctored`);
    }
  }
  const totalAttacks = entries.filter((e) => e.label === "doctored");
  const totalGenuine = entries.filter((e) => e.label === "genuine");
  const byArm = (arm: "whole" | "chain") => {
    const rows = outcomes.filter((o) => o.arm === arm);
    const answered = rows.filter((o) => o.status === "answered");
    const emptySeg = rows.filter((o) => o.status === "empty-segmentation").length;
    const caught = totalAttacks.filter((e) => answered.some((o) => o.file === e.file && o.doctored === true)).length;
    const falseAlarms = totalGenuine.filter((e) =>
      answered.some((o) => o.file === e.file && o.doctored === true),
    ).length;
    const terminalTimes = rows
      .filter((o) => o.status !== "pending" && o.status !== "budget-stopped")
      .map((o) => o.ms)
      .filter((ms): ms is number => typeof ms === "number" && ms >= 0)
      .sort((a, b) => a - b);
    const medianMs = terminalTimes.length ? (terminalTimes[Math.floor((terminalTimes.length - 1) / 2)] ?? null) : null;
    const maxMs = terminalTimes.length ? (terminalTimes[terminalTimes.length - 1] ?? null) : null;
    const answeredTimes = answered
      .map((o) => o.ms)
      .filter((ms): ms is number => typeof ms === "number" && ms >= 0)
      .sort((a, b) => a - b);
    const answeredMedianMs = answeredTimes.length
      ? (answeredTimes[Math.floor((answeredTimes.length - 1) / 2)] ?? null)
      : null;
    const answeredMaxMs = answeredTimes.length ? (answeredTimes[answeredTimes.length - 1] ?? null) : null;
    return {
      outcomes: rows.length,
      answered: answered.length,
      emptySegmentation: emptySeg,
      caught,
      attacks: totalAttacks.length,
      falseAlarms,
      genuine: totalGenuine.length,
      detection: totalAttacks.length ? caught / totalAttacks.length : null,
      falsePositives: totalGenuine.length ? falseAlarms / totalGenuine.length : null,
      medianMs,
      maxMs,
      answeredMedianMs,
      answeredMaxMs,
      totalUsd: rows.reduce((a, o) => a + o.usd, 0),
      totalAttempts: rows.reduce((a, o) => a + o.attempts, 0),
    };
  };
  return {
    whole: byArm("whole"),
    chain: byArm("chain"),
    fingerprint: expectedFp,
  };
}

export type StampDecision = "feature" | "cut" | "open question";

// Preset adoption rule (D08 T03 §2 correction 6): feature when chain detects >= 80%, raises at most 2% false
// positives, beats whole-page detection, costs at most twice whole-page cost, and stays within the step latency ceiling
// (median <= 15s, worst <= 30s); cut when chain detects no more than whole-page, raises > 2% false positives, costs > 2x
// whole-page, or exceeds the latency ceiling; otherwise open question.
export function decideStamps(score: ReturnType<typeof scoreOutcomes>): StampDecision {
  const { whole, chain } = score;
  if (
    chain.detection === null ||
    chain.falsePositives === null ||
    whole.detection === null ||
    whole.falsePositives === null ||
    whole.outcomes === 0 ||
    chain.outcomes === 0
  )
    return "open question";
  if (
    chain.detection <= whole.detection ||
    chain.falsePositives > 0.02 ||
    (whole.totalUsd > 0 && chain.totalUsd > 2 * whole.totalUsd) ||
    (chain.medianMs !== null && chain.medianMs > MAX_CHAIN_MEDIAN_MS) ||
    (chain.maxMs !== null && chain.maxMs > MAX_CHAIN_MAX_MS)
  )
    return "cut";
  if (
    chain.answered === chain.outcomes &&
    whole.answered === whole.outcomes &&
    chain.detection >= 0.8 &&
    chain.falsePositives <= 0.02 &&
    chain.detection > whole.detection &&
    whole.totalUsd > 0 &&
    chain.totalUsd <= 2 * whole.totalUsd &&
    chain.medianMs !== null &&
    chain.medianMs <= MAX_CHAIN_MEDIAN_MS &&
    chain.maxMs !== null &&
    chain.maxMs <= MAX_CHAIN_MAX_MS
  )
    return "feature";
  return "open question";
}

export function checkLog(
  logText: string,
  entries: ManifestEntry[],
  outcomes: ArmOutcome[],
  opts?: { setDir?: string; referenceSha256?: string; todoPlanJson?: string },
): string[] {
  const problems: string[] = [];
  let referenceSha256 = opts?.referenceSha256 ?? "ref";
  if (opts?.setDir) {
    const disk = verifySetOnDisk(opts.setDir, entries);
    referenceSha256 = disk.referenceSha256;
    problems.push(...disk.problems);
  }
  const outcomeProblems = validateOutcomes(entries, outcomes, referenceSha256);
  if (outcomeProblems.length > 0) {
    problems.push(...outcomeProblems);
    return problems;
  }
  const s = scoreOutcomes(entries, outcomes, referenceSha256);
  if (s.whole.answered === 0) problems.push("whole arm has 0 answered outcomes");
  if (s.chain.answered === 0 && s.chain.emptySegmentation === 0)
    problems.push("chain arm has 0 answered or empty-segmentation outcomes");
  for (const [arm, f] of [
    ["whole", s.whole],
    ["chain", s.chain],
  ] as const) {
    if (f.detection !== null && !logText.includes(`${arm} detection ${(100 * f.detection).toFixed(1)}%`))
      problems.push(`${arm} detection figure missing or differs in the log`);
    if (
      f.falsePositives !== null &&
      !logText.includes(`${arm} false positives ${(100 * f.falsePositives).toFixed(1)}%`)
    )
      problems.push(`${arm} false-positive figure missing or differs in the log`);
    if (!logText.includes(`${arm} cost US$${f.totalUsd.toFixed(4)}`))
      problems.push(`${arm} cost missing or differs in the log`);
    if (f.medianMs !== null && f.maxMs !== null && !logText.includes(`median ${f.medianMs} ms, worst ${f.maxMs} ms`))
      problems.push(`${arm} latency (median ${f.medianMs} ms, worst ${f.maxMs} ms) missing or differs in the log`);
  }
  const decision = decideStamps(s);
  if (!logText.includes(`Decision: ${decision}`)) problems.push(`decision (${decision}) missing or differs in the log`);
  if (!logText.includes(`fingerprint: ${s.fingerprint}`))
    problems.push(`fingerprint (${s.fingerprint}) missing or differs in the log`);
  if (!logText.includes(PROMPT)) problems.push("prompt text missing from the log");
  if (decision === "feature") {
    const match = logText.match(/\bAdopted in (D\d{2} T\d{2} §\d+)\b/);
    if (!match?.[1]) {
      problems.push("feature decision must state 'Adopted in DNN TNN §N'");
    } else {
      const planPath = opts?.todoPlanJson ?? join(import.meta.dirname, "../../todo/implementation-plan.md");
      if (existsSync(planPath)) {
        const planText = readFileSync(planPath, "utf8");
        if (!planText.includes(match[1])) problems.push(`adopted section ${match[1]} does not exist in ${planPath}`);
      }
    }
  }
  return problems;
}

export type StampStepBox = { left: number; top: number; width: number; height: number };
export type StampSegmentResult = StampStepBox[] | { boxes: StampStepBox[]; usd?: number; attempts?: number };
export type StampAskResult = { doctored: boolean; usd?: number; attempts?: number };
export type StampCallMeta = {
  file: string;
  arm: "whole" | "chain";
  fingerprint: string;
};

export type StampDeps = {
  segment: (png: Buffer, concept: "stamp" | "signature", meta?: StampCallMeta) => Promise<StampSegmentResult>;
  ask: (images: Buffer[], meta?: StampCallMeta) => Promise<StampAskResult>;
  spentUsd: () => number;
  drainFailedStep?: () => { usd: number; attempts: number };
  reconcilePrior?: (meta: StampCallMeta) => Promise<{ usd: number; attempts: number } | null>;
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

// One budgeted run over every pair and arm: an outcome per case and arm, bound to the manifest/reference/settings
// fingerprint, stopping at the cap, and never automatically resending a paid attempt that already ran or failed.
export async function runStamps(
  dir: string,
  deps: StampDeps,
  opts?: { resultsFile?: string; retryFailed?: boolean },
): Promise<{ outcomes: ArmOutcome[]; stopped: string | null }> {
  const resultsFile = opts?.resultsFile ?? join(dir, "results.json");
  const retryFailed = opts?.retryFailed ?? false;
  const entries = ManifestEntry.array().parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const disk = verifySetOnDisk(dir, entries);
  if (disk.problems.length > 0) throw new Error(`stamps set verification failed: ${disk.problems.join("; ")}`);
  const { fingerprint } = disk;

  const outcomes: ArmOutcome[] = existsSync(resultsFile)
    ? ArmOutcome.array().parse(JSON.parse(readFileSync(resultsFile, "utf8")))
    : [];
  const byFile = new Map(entries.map((e) => [e.file, e]));
  for (const o of outcomes) {
    const entry = byFile.get(o.file);
    if (!entry) throw new Error(`stored outcome ${o.file} is not in manifest.json`);
    if (o.fileSha256 !== entry.sha256)
      throw new Error(`stored outcome for ${o.file} has fileSha256 ${o.fileSha256}, expected ${entry.sha256}`);
    if (o.fingerprint !== fingerprint)
      throw new Error(`stored outcome for ${o.file} has fingerprint ${o.fingerprint}, expected ${fingerprint}`);
  }

  const save = () => writeAtomic(resultsFile, `${JSON.stringify(outcomes, null, 1)}\n`);
  const reference = readFileSync(join(dir, "reference-stamp.png"));
  let stopped: string | null = null;
  let fatalStop = false;
  const upsert = (row: ArmOutcome) => {
    const idx = outcomes.findIndex((o) => o.file === row.file && o.arm === row.arm);
    if (idx >= 0) outcomes[idx] = row;
    else outcomes.push(row);
    save();
  };

  for (const entry of entries) {
    if (fatalStop) break;
    const page = readFileSync(join(dir, entry.file));
    for (const arm of ["whole", "chain"] as const) {
      if (fatalStop) break;
      const prev = outcomes.find((o) => o.file === entry.file && o.arm === arm);
      if (prev) {
        if (prev.status === "answered" || prev.status === "empty-segmentation") continue;
        if (prev.status !== "budget-stopped" && !retryFailed) continue;
      }
      const meta: StampCallMeta = { file: entry.file, arm, fingerprint };
      const reconciled = prev ? await deps.reconcilePrior?.(meta) : null;
      const priorUsd = reconciled ? reconciled.usd : (prev?.usd ?? 0);
      const priorAttempts = reconciled ? reconciled.attempts : (prev?.attempts ?? 0);
      if (deps.spentUsd() >= RUN_CAP_USD) {
        stopped = `budget cap US$${RUN_CAP_USD} reached`;
        if (!prev) {
          upsert({
            file: entry.file,
            arm,
            status: "budget-stopped",
            doctored: null,
            ms: null,
            usd: 0,
            attempts: 0,
            fileSha256: entry.sha256,
            fingerprint,
          });
        }
        continue;
      }

      const initialReserve = arm === "whole" ? ESTIMATE_USD.spark : 2 * ESTIMATE_USD.segment;
      upsert({
        file: entry.file,
        arm,
        status: "pending",
        doctored: null,
        ms: null,
        usd: Number((priorUsd + initialReserve).toFixed(6)),
        attempts: priorAttempts + (arm === "whole" ? 1 : 2),
        fileSha256: entry.sha256,
        fingerprint,
      });

      const t0 = Date.now();
      let segCost = 0;
      let segAttempts = 0;
      let askStarted = false;
      let samBoxes = 0;
      try {
        let images: Buffer[];
        if (arm === "whole") {
          images = [reference, page];
        } else {
          const crops: Buffer[] = [reference];
          for (const concept of SAM_CONCEPTS) {
            const rawSeg = await deps.segment(page, concept, meta);
            const boxes = Array.isArray(rawSeg) ? rawSeg : rawSeg.boxes;
            segCost += Array.isArray(rawSeg) ? ESTIMATE_USD.segment : (rawSeg.usd ?? ESTIMATE_USD.segment);
            segAttempts += Array.isArray(rawSeg) ? 1 : (rawSeg.attempts ?? 1);
            samBoxes += boxes.length;
            for (const rawBox of boxes.slice(0, MAX_CROPS_PER_CONCEPT)) {
              const box = clampCropBox(rawBox, PAGE_WIDTH, PAGE_HEIGHT);
              crops.push(await sharp(page).extract(box).png().toBuffer());
            }
          }
          if (crops.length === 1) {
            upsert({
              file: entry.file,
              arm,
              status: "empty-segmentation",
              doctored: null,
              ms: Date.now() - t0,
              usd: Number((priorUsd + segCost).toFixed(6)),
              attempts: priorAttempts + segAttempts,
              fileSha256: entry.sha256,
              fingerprint,
              samBoxes: 0,
            });
            continue;
          }
          images = crops;
        }
        askStarted = true;
        const answer = await deps.ask(images, meta);
        const callUsd = (answer.usd ?? ESTIMATE_USD.spark) + segCost;
        const callAttempts = segAttempts + (answer.attempts ?? 1);
        upsert({
          file: entry.file,
          arm,
          status: "answered",
          doctored: answer.doctored,
          ms: Date.now() - t0,
          usd: Number((priorUsd + callUsd).toFixed(6)),
          attempts: priorAttempts + callAttempts,
          fileSha256: entry.sha256,
          fingerprint,
          ...(arm === "chain" ? { samBoxes } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const failed = deps.drainFailedStep?.() ?? {
          usd: arm === "whole" || askStarted ? ESTIMATE_USD.spark : ESTIMATE_USD.segment,
          attempts: 1,
        };
        const isFatalStop = /^accounting:|^budget:|would pass its cap|shared ledger/i.test(msg);
        const status = /timeout|timed out/i.test(msg)
          ? "timeout"
          : /refus|^accounting:|^budget:|would pass its cap|shared ledger/i.test(msg)
            ? "refused"
            : "malformed";
        upsert({
          file: entry.file,
          arm,
          status,
          doctored: null,
          ms: Date.now() - t0,
          usd: Number((priorUsd + segCost + failed.usd).toFixed(6)),
          attempts: priorAttempts + segAttempts + failed.attempts,
          fileSha256: entry.sha256,
          fingerprint,
          ...(arm === "chain" ? { samBoxes } : {}),
        });
        if (status === "refused" || isFatalStop) {
          stopped = msg;
          fatalStop = true;
        }
      }
    }
  }
  return { outcomes, stopped };
}

export async function createBudgetedStampDeps(opts: {
  env: { META_API_KEY: string; CF_AIG_TOKEN: string; META_GATEWAY_URL: string };
  guard: import("../../src/meta/guard.ts").Budget;
  ledger: import("./digits.ts").AttemptLedger;
  segmentFn: (
    ctx: unknown,
    imageDataUrl: string,
    concept: "stamp" | "signature",
  ) => Promise<{ left: number; top: number; right: number; bottom: number; confidence: number | null }[]>;
  structuredFn: typeof import("../../src/meta/structured.ts").structured;
}): Promise<StampDeps> {
  const { attemptsOf, ledgeredBudget } = await import("./digits.ts");
  let fallbackCallNo = 0;
  let totalSpent = 0;
  let failedStep = { usd: 0, attempts: 0 };
  let fatalAccounting: string | null = null;

  const stepCallKey = (meta: StampCallMeta | undefined, stepName: string) =>
    meta ? `${meta.fingerprint.slice(0, 12)}:${meta.file}:${meta.arm}:${stepName}` : `call-${++fallbackCallNo}`;

  async function runStep<T>(
    callKey: string,
    fn: (ctx: unknown) => Promise<T>,
  ): Promise<{ value: T; usd: number; attempts: number }> {
    if (fatalAccounting) {
      failedStep = { usd: 0, attempts: 0 };
      throw new Error(`accounting: a settlement could not be written (${fatalAccounting})`);
    }
    const priorIds = new Set((await opts.ledger.entries(callKey)).map((e) => e.id));
    const spend = ledgeredBudget(opts.guard, opts.ledger, callKey);
    const late: Promise<unknown>[] = [];
    const ctx = {
      env: opts.env,
      budget: spend.budget,
      owner: { kind: "script" as const, name: "eval-frontier" },
      waitUntil: (p: Promise<unknown>) => {
        late.push(p);
      },
    };
    failedStep = { usd: 0, attempts: 0 };
    let collected: { usd: number; attempts: number } | null = null;
    const collectOnce = async () => {
      if (collected) return collected;
      await Promise.allSettled(late);
      const entries = (await opts.ledger.entries(callKey)).filter((e) => !priorIds.has(e.id));
      const a = attemptsOf(entries, spend.usage);
      const usd = Number((a.usd + a.uncertainUsd).toFixed(6));
      totalSpent = Number((totalSpent + usd).toFixed(6));
      collected = { usd, attempts: Math.max(a.attempts, spend.attempts()) };
      return collected;
    };
    try {
      const value = await fn(ctx);
      const step = await collectOnce();
      const acct = spend.accounting();
      if (acct) {
        fatalAccounting ??= acct;
        throw new Error(`accounting: a settlement could not be written (${fatalAccounting})`);
      }
      return { value, usd: step.usd, attempts: step.attempts };
    } catch (err) {
      failedStep = await collectOnce().catch(() => ({ usd: 0, attempts: spend.attempts() }));
      const acct = spend.accounting();
      if (acct) {
        fatalAccounting ??= acct;
        throw new Error(`accounting: a settlement could not be written (${fatalAccounting})`);
      }
      throw err;
    }
  }

  return {
    segment: async (png, concept, meta) => {
      const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
      const step = await runStep(stepCallKey(meta, concept), (ctx) => opts.segmentFn(ctx, dataUrl, concept));
      return {
        boxes: step.value.map((b) => ({
          left: b.left,
          top: b.top,
          width: b.right - b.left,
          height: b.bottom - b.top,
        })),
        usd: step.usd,
        attempts: step.attempts,
      };
    },
    ask: async (images, meta) => {
      const step = await runStep(stepCallKey(meta, "ask"), (ctx) =>
        opts.structuredFn(
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
        ),
      );
      return {
        doctored: step.value.value.doctored,
        usd: step.usd,
        attempts: Math.max(step.attempts, step.value.attempts),
      };
    },
    spentUsd: () => totalSpent,
    drainFailedStep: () => {
      const out = failedStep;
      failedStep = { usd: 0, attempts: 0 };
      return out;
    },
    reconcilePrior: async (meta) => {
      const combined = [
        ...(await opts.ledger.entries(stepCallKey(meta, "stamp"))),
        ...(await opts.ledger.entries(stepCallKey(meta, "signature"))),
        ...(await opts.ledger.entries(stepCallKey(meta, "ask"))),
      ];
      if (combined.length === 0) return null;
      const a = attemptsOf(combined, () => undefined);
      return {
        usd: Number((a.usd + a.uncertainUsd).toFixed(6)),
        attempts: a.attempts,
      };
    },
  };
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "build") {
    const out = rest[rest.indexOf("--out") + 1] ?? SET_DIR;
    const entries = await buildSet(rest.includes("--out") ? out : SET_DIR);
    console.log(`stamps: built ${entries.length} pages (${entries.length / 2} pairs) in ${out}`);
    return 0;
  }
  if (cmd === "run") {
    register("../../scripts/lib/ts-resolve.mjs", import.meta.url);
    const { readSecretsFromVault, GATEWAY_URL, metaLedger } = await import("../../scripts/meta-smoke.ts");
    const { localBudget } = await import("../../scripts/lib/meta-budget.ts");
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
    const clock = new Date();
    const now = () => clock;
    const tick = () => {
      clock.setTime(Date.now());
      return clock;
    };
    const secrets = await readSecretsFromVault();
    const guard = localBudget("eval-frontier", undefined, now);
    const ledger = sharedLedger(metaLedger(), "stamps-v3", { capUsd: RUN_CAP_USD, now: tick });
    const deps = await createBudgetedStampDeps({
      env: { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL },
      guard,
      ledger,
      segmentFn: segment,
      structuredFn: structured,
    });
    const dirAt = rest.indexOf("--dir");
    const targetDir = (dirAt >= 0 ? rest[dirAt + 1] : undefined) ?? SET_DIR;
    const retryFailed = rest.includes("--retry-failed");
    const out = await runStamps(targetDir, deps, { retryFailed });
    console.log(`stamps: ${out.outcomes.length} outcomes${out.stopped ? `, stopped: ${out.stopped}` : ""}`);
    return out.stopped ? 2 : 0;
  }
  if (cmd === "score") {
    const dirAt = rest.indexOf("--dir");
    const targetDir = (dirAt >= 0 ? rest[dirAt + 1] : undefined) ?? SET_DIR;
    const resultsAt = rest.indexOf("--results");
    const resultsFile = (resultsAt >= 0 ? rest[resultsAt + 1] : undefined) ?? join(targetDir, "results.json");
    const entries = ManifestEntry.array().parse(JSON.parse(readFileSync(join(targetDir, "manifest.json"), "utf8")));
    const disk = verifySetOnDisk(targetDir, entries);
    if (disk.problems.length > 0) {
      for (const p of disk.problems) console.error(`stamps: ${p}`);
      return 1;
    }
    const outcomes = ArmOutcome.array().parse(JSON.parse(readFileSync(resultsFile, "utf8")));
    const outcomeProblems = validateOutcomes(entries, outcomes, disk.referenceSha256);
    if (outcomeProblems.length > 0) {
      for (const p of outcomeProblems) console.error(`stamps: ${p}`);
      return 1;
    }
    const s = scoreOutcomes(entries, outcomes, disk.referenceSha256);
    for (const arm of ["whole", "chain"] as const) {
      const f = s[arm];
      console.log(
        `${arm} detection ${f.detection === null ? "not measured" : `${(100 * f.detection).toFixed(1)}%`} (${f.caught}/${f.attacks}), ${arm} false positives ${f.falsePositives === null ? "not measured" : `${(100 * f.falsePositives).toFixed(1)}%`} (${f.falseAlarms}/${f.genuine}), ${arm} cost US$${f.totalUsd.toFixed(4)} (${f.totalAttempts} calls), median ${f.medianMs ?? "n/a"} ms, worst ${f.maxMs ?? "n/a"} ms, answered ${f.answered} of ${f.outcomes}${f.emptySegmentation ? ` (${f.emptySegmentation} empty-segmentation)` : ""}`,
      );
    }
    console.log(`Decision: ${decideStamps(s)} | fingerprint: ${s.fingerprint}`);
    const checkAt = rest.indexOf("--check");
    const check = checkAt >= 0 ? rest[checkAt + 1] : undefined;
    if (check) {
      const problems = checkLog(readFileSync(check, "utf8"), entries, outcomes, { setDir: targetDir });
      for (const p of problems) console.error(`stamps: ${p}`);
      return problems.length ? 1 : 0;
    }
    return 0;
  }
  console.error(
    "usage: node eval/frontier/stamps.ts build [--out <dir>] | run [--dir <dir>] [--retry-failed] | score [--dir <dir>] [--results <file>] [--check <log>]",
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
