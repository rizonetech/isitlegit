// The ablation flag contract (D08 T02 §3): one flag per model switch, each naming the model calls a flagged
// eval-organisation case skips. The pipeline steps honour these flags (owning lanes, requested through the
// coordinator); the runner only sets, transports and reports them.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ABLATION_HEADING, writeResultsSection } from "./results-file.ts";

export const ABLATE_FLAGS = {
  // Agent reasoning off: the rule-based verdict decides alone.
  "no-agent-reasoning": ["muse-spark-1.3"],
  // No Muse Wonder walkthrough.
  "no-walkthrough": ["muse-wonder-1.0"],
  // No SAM 3.1 comparison.
  "no-sam": ["sam-3.1"],
  // No voice transcription.
  "no-transcribe": ["muse-voice-transcribe-1.0"],
  // No Loupe page screening (Muse Spark screens every page instead).
  "no-screening": ["loupe"],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type AblateFlag = keyof typeof ABLATE_FLAGS;

export const isAblateFlag = (flag: unknown): flag is AblateFlag =>
  typeof flag === "string" && Object.hasOwn(ABLATE_FLAGS, flag);

export function skippedModels(flag: AblateFlag): readonly [string, ...string[]] {
  return ABLATE_FLAGS[flag];
}

// The ablation population (D08 T02 §3): a stratified sample reselected identically from its seed. Attacks round-robin
// across categories so every attack class is represented, genuine mail alongside, capped at the available samples.
// Ordering within each bucket is the SHA-256 of seed, set and id: deterministic, no RNG to seed or restore.
export type AblationPool = {
  name: string;
  samples: { id: string; label: "attack" | "genuine"; category: string }[];
};

export type AblationSelection = {
  perSetAttacks: number;
  perSetGenuine: number;
  seed: string;
};

export function selectAblationPopulation(pools: AblationPool[], selection: AblationSelection): string[] {
  const picked: string[] = [];
  for (const pool of pools) {
    const rank = (id: string) => createHash("sha256").update(`${selection.seed}\0${pool.name}\0${id}`).digest("hex");
    const byCategory = new Map<string, { id: string; label: "attack" | "genuine" }[]>();
    for (const s of pool.samples) {
      const bucket = byCategory.get(s.category) ?? [];
      bucket.push({ id: s.id, label: s.label });
      byCategory.set(s.category, bucket);
    }
    for (const bucket of byCategory.values()) bucket.sort((a, b) => (rank(a.id) < rank(b.id) ? -1 : 1));
    const attacks: string[] = [];
    const categories = [...byCategory.keys()].sort();
    let taking = true;
    while (taking && attacks.length < selection.perSetAttacks) {
      taking = false;
      for (const category of categories) {
        const bucket = byCategory.get(category) ?? [];
        const next = bucket.find((s) => s.label === "attack" && !attacks.includes(s.id));
        if (next && attacks.length < selection.perSetAttacks) {
          attacks.push(next.id);
          taking = true;
        }
      }
    }
    const genuine = pool.samples
      .filter((s) => s.label === "genuine")
      .sort((a, b) => (rank(a.id) < rank(b.id) ? -1 : 1))
      .slice(0, selection.perSetGenuine)
      .map((s) => s.id);
    picked.push(...attacks, ...genuine);
  }
  return picked;
}

export type AblationManifest = {
  seed: string;
  sets: string[];
  setVersions: Record<string, string>;
  deployment: string;
  ids: string[];
};

export type AblationArmState = {
  flag: AblateFlag | "full";
  runId: string | null;
  status: "pending" | "complete" | "incomplete" | "failed";
};

export type AblationRunManifest = AblationManifest & { arms: AblationArmState[] };

const MANIFEST_FILE = "ablation-manifest.json";

export type AblationArmMetrics = {
  verdictRows: number;
  detected: number;
  genuineRows: number;
  falsePositives: number;
  medianMs: number;
  costUsd: number; // Mean model cost per measured check, not the population total.
  measured: boolean;
};

export type AblationArmReport = {
  arm: AblateFlag | "full";
  set: string;
  runId: string | null;
  metrics: AblationArmMetrics;
};

// The impersonation finding classes (D04 T01 §9, as named in `src/agent/rule-verdict.ts`): a standalone check changes
// the rule verdict on its own, a corroborating one counts only beside a second finding of the family. The names are
// repeated here, as `ABLATE_FLAGS` repeats the model names, because the node test project cannot compile the
// Worker-typed rule module; the section's review re-checks them against the rule.
const STANDALONE_FAMILY_CHECKS = new Set(["sender.display_address", "sender.display_brand", "link.text_mismatch"]);
const CORROBORATING_FAMILY_CHECKS = new Set(["link.final_domain_changed", "link.lure_button"]);

export function classifyFamilyFinding(check: string): "standalone" | "corroborating" | "other" {
  if (STANDALONE_FAMILY_CHECKS.has(check)) return "standalone";
  if (CORROBORATING_FAMILY_CHECKS.has(check)) return "corroborating";
  return "other";
}

export function familyFindingClasses(checks: string[]): { standalone: string[]; corroborating: string[] } {
  const standalone = [...new Set(checks.filter((check) => classifyFamilyFinding(check) === "standalone"))];
  const corroborating = [...new Set(checks.filter((check) => classifyFamilyFinding(check) === "corroborating"))];
  return { standalone, corroborating };
}

// One key per arm and set, so an arm publish replaces only the baseline's modified cells at its own ids.
export function ablationArmPublishKey(report: Pick<AblationArmReport, "arm" | "set">): string {
  return `${report.set}:${report.arm}`;
}

// The orchestration (D08 T02 §3): the full run leads (its arms ablate it), then each flag in order. A failed arm stops
// the sequence before later arms spend; resume re-runs that same arm with the same ids and switch, never a reselect.
export function startAblationRun(manifest: AblationManifest, flags: (AblateFlag | "full")[]): AblationRunManifest {
  const arms: AblationArmState[] = [{ flag: "full", runId: null, status: "pending" }];
  for (const flag of flags) if (flag !== "full") arms.push({ flag, runId: null, status: "pending" });
  return { ...manifest, arms };
}

export function nextAblationArm(manifest: AblationRunManifest): AblationArmState | null {
  for (const arm of manifest.arms) {
    if (arm.status === "complete") continue;
    if (arm.status === "failed")
      throw new Error(`stopped on the failed ${arm.flag} arm: resume it, do not skip past it`);
    return arm;
  }
  return null;
}

export function recordAblationArm(
  manifest: AblationRunManifest,
  flag: AblateFlag | "full",
  runId: string,
  status: AblationArmState["status"],
): AblationRunManifest {
  return { ...manifest, arms: manifest.arms.map((arm) => (arm.flag === flag ? { ...arm, flag, runId, status } : arm)) };
}

// Resume keeps the selection and the switch: the arm's ids and flag are untouched, its known run identity survives retries.
export function resumeAblationArm(manifest: AblationRunManifest, flag: AblateFlag | "full"): AblationRunManifest {
  return {
    ...manifest,
    arms: manifest.arms.map((arm) => (arm.flag === flag ? { ...arm, status: "pending" } : arm)),
  };
}

// An arm of all stale-repeat rows remeasures nothing: refuse it rather than publish its non-figures.
export function checkAblationArmResults(flag: AblateFlag | "full", outcomes: string[]): void {
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome === "stale-repeat"))
    throw new Error(`the ${flag} arm is all stale-repeat: it measures nothing, reselect on a fresh deployment`);
}

// Keyed replacement: the arm's cells land at its own ids, every baseline cell elsewhere is carried unchanged.
export function mergeAblationArmCells(
  baseline: Record<string, Record<string, string>>,
  key: string,
  armCells: Record<string, string>,
): Record<string, Record<string, string>> {
  return { ...baseline, [key]: { ...armCells } };
}

const rate = (n: number, d: number): string => (d > 0 ? `${((100 * n) / d).toFixed(1)}% (${n}/${d})` : "not measured");
const signed = (v: number, unit: string): string => `${v > 0 ? "+" : ""}${v.toFixed(unit === "%" ? 1 : 0)}${unit}`;

// The ablation table (D08 T02 §3): each switch arm against the full baseline arm on the same set, as changes in
// detection, false positives, time and cost. An unmeasured arm, or one with no comparable baseline, reads
// `not measured` in every change cell, never zero.
export function renderAblationResultsTable(arms: AblationArmReport[]): string {
  const header =
    "| Model removed | set | Detection change | False-positive change | Time change | Cost per check change | run id |\n| --- | --- | --- | --- | --- | --- | --- |\n";
  const baselines = new Map(arms.filter((a) => a.arm === "full").map((a) => [a.set, a]));
  const rows = arms.map((report) => {
    const removed = report.arm === "full" ? "none (full baseline)" : skippedModels(report.arm).join(", ");
    const base = baselines.get(report.set);
    if (!report.metrics.measured || !base?.metrics.measured || report.arm === "full") {
      const own =
        report.arm === "full" && report.metrics.measured
          ? `${rate(report.metrics.detected, report.metrics.verdictRows)} | ${rate(report.metrics.falsePositives, report.metrics.genuineRows)} | ${report.metrics.medianMs} ms | US$${report.metrics.costUsd.toFixed(4)} |`
          : "not measured | not measured | not measured | not measured |";
      return `| ${removed} | ${report.set} | ${own} ${report.runId ?? "not run"} |`;
    }
    const det =
      report.metrics.verdictRows > 0 && base.metrics.verdictRows > 0
        ? signed(
            (100 * report.metrics.detected) / report.metrics.verdictRows -
              (100 * base.metrics.detected) / base.metrics.verdictRows,
            "%",
          )
        : "not measured";
    const fp =
      report.metrics.genuineRows > 0 && base.metrics.genuineRows > 0
        ? signed(
            (100 * report.metrics.falsePositives) / report.metrics.genuineRows -
              (100 * base.metrics.falsePositives) / base.metrics.genuineRows,
            "%",
          )
        : "not measured";
    const time = signed(report.metrics.medianMs - base.metrics.medianMs, " ms");
    const cost = `US$${(report.metrics.costUsd - base.metrics.costUsd).toFixed(4)}`;
    return `| ${removed} | ${report.set} | ${det} | ${fp} | ${time} | ${cost.startsWith("US$-") ? cost : `+${cost}`} | ${report.runId ?? "not run"} |`;
  });
  return `${header}${rows.join("\n")}\n`;
}

// Merged under its own heading, never replacing another section's rows (the RESULTS.md merge contract).
export function writeAblationResults(dir: string, arms: AblationArmReport[], experiment?: ExperimentManifest): string {
  const provenance = experiment
    ? `Experiment: ${experiment.experimentId}. Deployment: ${experiment.deployment}. Population manifest SHA-256: ${experiment.manifestDigest}. Selected samples: ${experiment.ids.length}.\n\n`
    : "";
  const screening = experiment
    ? "\nLoupe screening: not measured by upload experiments; it requires the separate labelled monitor experiment. Arms whose full baseline did not exercise the removed model are not measured.\n"
    : "";
  return writeResultsSection(dir, ABLATION_HEADING, `${provenance}${renderAblationResultsTable(arms)}${screening}`);
}

// Persist the manifest with an atomic replace, so an interrupted write never leaves a half manifest behind.
export function saveAblationManifest(dir: string, manifest: AblationManifest): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, MANIFEST_FILE);
  const tmp = `${path}.tmp-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 1)}\n`);
  renameSync(tmp, path);
  return path;
}

export function loadAblationManifest(path: string): AblationManifest {
  return JSON.parse(readFileSync(path, "utf8")) as AblationManifest;
}

// Refuse an arm whose population or deployment drifted from the manifest: it would measure something incomparable.
export function checkAblationManifest(
  manifest: AblationManifest,
  actual: { setVersions: Record<string, string>; deployment: string },
): void {
  for (const set of manifest.sets) {
    if (actual.setVersions[set] !== manifest.setVersions[set])
      throw new Error(`the ${set} set version changed since the manifest: reselect, do not reuse its ids`);
  }
  if (actual.deployment !== manifest.deployment)
    throw new Error(
      `the deployment is ${actual.deployment}, not ${manifest.deployment} of the manifest: reselect, do not reuse its ids`,
    );
}

// Current durable experiment protocol (D08 T02 section 17). Historical population-only manifests remain distinct.
export const ExperimentId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Arm = z.enum(["full", "no-agent-reasoning", "no-walkthrough", "no-sam", "no-transcribe", "no-screening"]);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ExperimentInput = z
  .object({
    experimentId: ExperimentId,
    arm: Arm,
    manifestDigest: Digest,
    deployment: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
export const CaseExperiment = ExperimentInput.extend({ replayRunId: ExperimentId }).strict();
export type ExperimentInput = z.infer<typeof ExperimentInput>;
export type CaseExperiment = z.infer<typeof CaseExperiment>;
export const UPLOAD_FLAGS: AblateFlag[] = ["no-agent-reasoning", "no-walkthrough", "no-sam", "no-transcribe"];
export const Capabilities = z
  .object({
    version: z.literal(1),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    durableContext: z.literal(true),
    uploadArms: z.array(Arm).min(1).max(5),
    screening: z.literal(false),
  })
  .strict();
export function requireCapabilities(raw: unknown, deployment: string, arms: string[]): void {
  const value = Capabilities.parse(raw);
  if (
    value.commit !== deployment ||
    !value.uploadArms.includes("full") ||
    new Set(value.uploadArms).size !== value.uploadArms.length ||
    value.uploadArms.includes("no-screening") ||
    arms.some((arm) => !value.uploadArms.includes(arm as z.infer<typeof Arm>))
  )
    throw new Error("missing or mismatched upload ablation capabilities; no upload authorized");
}
export function experimentDigest(value: AblationManifest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        seed: value.seed,
        sets: value.sets,
        setVersions: Object.fromEntries(
          Object.keys(value.setVersions)
            .sort()
            .map((key) => [key, value.setVersions[key]]),
        ),
        deployment: value.deployment,
        ids: value.ids,
      }),
    )
    .digest("hex");
}
const ExperimentSchema = z
  .object({
    version: z.literal(1),
    experimentId: ExperimentId,
    seed: z.string().min(1).max(200),
    sets: z
      .array(z.string().regex(/^[a-z0-9-]{1,64}$/))
      .min(1)
      .max(20),
    setVersions: z.record(z.string(), Digest),
    deployment: z.string().regex(/^[a-f0-9]{40}$/),
    ids: z.array(z.string().min(3).max(512)).min(1).max(10000),
    manifestDigest: Digest,
    arms: z
      .array(
        z
          .object({
            flag: Arm,
            replayRunId: ExperimentId,
            runId: ExperimentId.nullable(),
            status: z.enum(["pending", "complete", "incomplete", "failed", "not-measured"]),
            capUsd: z.number().finite().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict()
  .superRefine((m, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (new Set(m.sets).size !== m.sets.length || new Set(m.ids).size !== m.ids.length) fail("duplicate population");
    if (Object.keys(m.setVersions).sort().join() !== [...m.sets].sort().join())
      fail("set versions do not match selected sets");
    if (m.ids.some((id) => id.includes("..") || !m.sets.some((set) => id.startsWith(`${set}/`))))
      fail("invalid selected sample identity");
    if (m.manifestDigest !== experimentDigest(m)) fail("manifest digest mismatch");
    if (m.arms[0]?.flag !== "full" || new Set(m.arms.map((a) => a.flag)).size !== m.arms.length)
      fail("invalid arm order or duplicate arm");
    if (new Set(m.arms.map((a) => a.replayRunId)).size !== m.arms.length) fail("duplicate replay identity");
    if (m.arms.some((a) => a.runId !== null && a.runId !== a.replayRunId)) fail("run/replay identity mismatch");
    if (m.arms.some((a) => a.status === "complete" && a.runId === null)) fail("completed arm lacks run identity");
    if (m.arms.some((a) => a.status === "not-measured" && (a.runId !== null || a.flag === "full")))
      fail("invalid unmeasured arm state");
  });
export type ExperimentManifest = z.infer<typeof ExperimentSchema>;
export function parseExperiment(raw: unknown): ExperimentManifest {
  return ExperimentSchema.parse(raw);
}
export function sameExperiment(actual: unknown, expected: CaseExperiment): boolean {
  const parsed = CaseExperiment.safeParse(actual);
  return (
    parsed.success &&
    Object.entries(expected).every(([key, value]) => parsed.data[key as keyof CaseExperiment] === value)
  );
}
export function armContext(manifest: ExperimentManifest, arm: ExperimentManifest["arms"][number]): CaseExperiment {
  return {
    experimentId: manifest.experimentId,
    arm: arm.flag,
    manifestDigest: manifest.manifestDigest,
    deployment: manifest.deployment,
    replayRunId: arm.replayRunId,
  };
}
export function createExperiment(
  selection: AblationManifest,
  flags: AblateFlag[],
  capUsd: number,
  id: () => string,
): ExperimentManifest {
  return parseExperiment({
    ...selection,
    version: 1,
    experimentId: id(),
    manifestDigest: experimentDigest(selection),
    arms: ["full", ...flags].map((flag) => ({ flag, replayRunId: id(), runId: null, status: "pending", capUsd })),
  });
}
export function loadExperiment(file: string): ExperimentManifest {
  if (statSync(file).size > 5_000_000) throw new Error("experiment manifest exceeds 5 MB");
  const text = readFileSync(file, "utf8");
  const raw: unknown = JSON.parse(text);
  // Generated manifests are canonical, so duplicate JSON keys cannot hide behind JSON.parse's last-key behavior.
  if (text !== `${JSON.stringify(raw, null, 2)}\n`) throw new Error("experiment manifest is not canonical JSON");
  return parseExperiment(raw);
}
export function saveExperiment(dir: string, value: ExperimentManifest): string {
  const manifest = parseExperiment(value);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "manifest.json");
  if (existsSync(file)) {
    const previous = loadExperiment(file);
    const identity = (m: ExperimentManifest) =>
      JSON.stringify({
        id: m.experimentId,
        digest: m.manifestDigest,
        arms: m.arms.map((a) => ({ flag: a.flag, replayRunId: a.replayRunId, capUsd: a.capUsd })),
      });
    if (identity(previous) !== identity(manifest)) throw new Error("refusing immutable experiment change");
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    loadExperiment(tmp);
    renameSync(tmp, file);
    const fdDir = openSync(dir, "r");
    try {
      fsyncSync(fdDir);
    } finally {
      closeSync(fdDir);
    }
    loadExperiment(file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return file;
}
