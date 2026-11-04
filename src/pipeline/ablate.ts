import { z } from "zod";

// Shared arm names match eval/ablate.ts. Uploaded-case consumers resolve immutable D1
// attribution through case-experiments.ts; the legacy KV reader remains for monitor migration.
export const ABLATE_FLAGS = [
  "no-agent-reasoning",
  "no-walkthrough",
  "no-sam",
  "no-transcribe",
  "no-screening",
] as const;
export type AblateFlag = (typeof ABLATE_FLAGS)[number];

export const ablateKey = (orgId: string) => `ablate:${orgId}`;

// Legacy monitor flag, replaced by the labelled monitor contract in D04 T01 §18.
export async function ablateFlagFor(kv: KVNamespace, orgId: string | null): Promise<AblateFlag | null> {
  if (!orgId) return null;
  let value: unknown;
  try {
    value = await kv.get(ablateKey(orgId));
  } catch {
    return null; // A KV that cannot answer is no ablation, never a failed case.
  }
  return typeof value === "string" && (ABLATE_FLAGS as readonly string[]).includes(value)
    ? (value as AblateFlag)
    : null;
}

// Strict immutable eval upload attribution.
export const ExperimentId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const ExperimentArm = z.enum(["full", ...ABLATE_FLAGS]);
export const ExperimentInput = z.strictObject({
  experimentId: ExperimentId,
  arm: ExperimentArm,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  deployment: z.string().regex(/^[a-f0-9]{40}$/),
});
export type ExperimentInput = z.infer<typeof ExperimentInput>;
export const CaseExperiment = ExperimentInput.extend({ replayRunId: ExperimentId });
export type CaseExperiment = z.infer<typeof CaseExperiment>;
// Installed uploaded-case consumers; monitor screening has its own separate trigger.
export const UPLOAD_EXPERIMENT_ARMS: readonly z.infer<typeof ExperimentArm>[] = [
  "full",
  "no-agent-reasoning",
  "no-walkthrough",
  "no-sam",
  "no-transcribe",
];
