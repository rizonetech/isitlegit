// The ablation flag contract (D08 T02 §3): one flag per model switch, each naming the model calls a flagged
// eval-organisation case skips. The pipeline steps honour these flags (owning lanes, requested through the
// coordinator); the runner only sets, transports and reports them.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
const RESULTS_FILE = "RESULTS.md";

export type AblationArmMetrics = {
  verdictRows: number;
  detected: number;
  genuineRows: number;
  falsePositives: number;
  medianMs: number;
  measured: boolean;
};

export type AblationArmReport = {
  arm: AblateFlag | "full";
  set: string;
  runId: string;
  metrics: AblationArmMetrics;
};

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
  return { ...manifest, arms: manifest.arms.map((arm) => (arm.flag === flag ? { flag, runId, status } : arm)) };
}

// Resume keeps the selection and the switch: the arm's ids and flag are untouched, only its run restarts.
export function resumeAblationArm(manifest: AblationRunManifest, flag: AblateFlag | "full"): AblationRunManifest {
  return {
    ...manifest,
    arms: manifest.arms.map((arm) => (arm.flag === flag ? { flag, runId: null, status: "pending" } : arm)),
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

export function renderAblationResultsTable(arms: AblationArmReport[]): string {
  const header =
    "| arm | set | detected | false positives | median ms | run id |\n| --- | --- | --- | --- | --- | --- |\n";
  const rows = arms.map((report) => {
    const figures = report.metrics.measured
      ? `${report.metrics.detected}/${report.metrics.verdictRows} | ${report.metrics.falsePositives}/${report.metrics.genuineRows} | ${report.metrics.medianMs} |`
      : "not measured | not measured | not measured |";
    return `| ${report.arm} | ${report.set} | ${figures} ${report.runId} |`;
  });
  return `${header}${rows.join("\n")}\n`;
}

// Atomic temp-then-replace, like the manifest: a crash never half-writes the table reviewers read.
export function writeAblationResults(dir: string, arms: AblationArmReport[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, RESULTS_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, renderAblationResultsTable(arms));
  renameSync(tmp, path);
  return path;
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
