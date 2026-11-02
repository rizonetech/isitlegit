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
