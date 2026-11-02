import { describe, expect, it } from "vitest";
import { ablateFlagFor, ablateKey } from "../../src/pipeline/ablate";

// D04 T01 §11: the ablation flag reader. A stubbed KV; no database, no spend.
const kvWith = (entries: Record<string, string>) =>
  ({
    get: async (key: string) => entries[key] ?? null,
  }) as unknown as KVNamespace;

describe("ablateFlagFor", () => {
  it("reads each of eval's four flags for the case's organisation", async () => {
    for (const flag of ["no-agent-reasoning", "no-walkthrough", "no-sam", "no-screening"] as const) {
      const kv = kvWith({ [ablateKey("org-1")]: flag });
      expect(await ablateFlagFor(kv, "org-1")).toBe(flag);
    }
  });

  it("reads an absent key, another organisation's flag, and a null organisation as no ablation", async () => {
    const kv = kvWith({ [ablateKey("org-2")]: "no-sam" });
    expect(await ablateFlagFor(kv, "org-1")).toBeNull();
    expect(await ablateFlagFor(kv, null)).toBeNull();
  });

  it("reads a garbage value and a failing KV as no ablation", async () => {
    expect(await ablateFlagFor(kvWith({ [ablateKey("org-1")]: "no-everything" }), "org-1")).toBeNull();
    const down = {
      get: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;
    expect(await ablateFlagFor(down, "org-1")).toBeNull();
  });
});
