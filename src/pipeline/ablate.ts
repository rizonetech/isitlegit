import { z } from "zod";

// The ablation flags (eval D08 T02 §3; the coordinator's 2026-11-02 assignment): eval's runner
// measures each model's contribution by running flagged arms, and the flag names and semantics
// are eval's contract (`ABLATE_FLAGS` in eval/ablate.ts on the eval lane). A flagged case's
// steps read their flag here and skip their model contribution, storing the same evidence shape
// with the step marked ablated. The flag itself lives in the CACHE KV under `ablate:<orgId>`,
// holding one flag name, which the eval runner sets for an arm and clears after it; an absent
// key, a value that is not one of the four, or a KV that cannot answer all read as no ablation,
// so a flag can only ever remove a model contribution, never break a case.
export const ABLATE_FLAGS = [
  "no-agent-reasoning",
  "no-walkthrough",
  "no-sam",
  "no-transcribe",
  "no-screening",
] as const;
export type AblateFlag = (typeof ABLATE_FLAGS)[number];

export const ablateKey = (orgId: string) => `ablate:${orgId}`;

// The flag set for a case's organisation, or null when it is not ablated.
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

// The eval upload contract is independent of the legacy KV reader above. Consumers migrate in D04 T01 §17.
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
// Only implemented upload consumers are advertised; D04 T01 §17 expands this with its tested hooks.
export const UPLOAD_EXPERIMENT_ARMS: readonly z.infer<typeof ExperimentArm>[] = ["full"];
