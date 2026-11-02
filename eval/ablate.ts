// The ablation flag contract (D08 T02 §3): one flag per model switch, each naming the model calls a flagged
// eval-organisation case skips. The pipeline steps honour these flags (owning lanes, requested through the
// coordinator); the runner only sets, transports and reports them.

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
