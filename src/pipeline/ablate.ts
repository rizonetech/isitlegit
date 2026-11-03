// The ablation flags (eval D08 T02 §3; the coordinator's 2026-11-02 assignment): eval's runner
// measures each model's contribution by running flagged arms, and the flag names and semantics
// are eval's contract (`ABLATE_FLAGS` in eval/ablate.ts on the eval lane). A flagged case's
// steps read their flag here and skip their model contribution, storing the same evidence shape
// with the step marked ablated. The flag itself lives in the CACHE KV under `ablate:<orgId>`,
// holding one flag name, which the eval runner sets for an arm and clears after it; an absent
// key, a value that is not one of the four, or a KV that cannot answer all read as no ablation,
// so a flag can only ever remove a model contribution, never break a case.
export const ABLATE_FLAGS = ["no-agent-reasoning", "no-walkthrough", "no-sam", "no-screening"] as const;
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
