// The ablation flag contract (D08 T02 §3): one flag per switch, each naming the model calls it skips.
import { describe, expect, it } from "vitest";
import {
  ABLATE_FLAGS,
  type AblateFlag,
  checkAblationManifest,
  isAblateFlag,
  loadAblationManifest,
  saveAblationManifest,
  selectAblationPopulation,
  skippedModels,
} from "../../eval/ablate.ts";

describe("the ablation flag contract", () => {
  it("maps every flag to exactly the model calls it skips, and rejects unknown flags", () => {
    expect(skippedModels("no-agent-reasoning")).toEqual(["muse-spark-1.3"]);
    expect(skippedModels("no-walkthrough")).toEqual(["muse-wonder-1.0"]);
    expect(skippedModels("no-sam")).toEqual(["sam-3.1"]);
    expect(skippedModels("no-transcribe")).toEqual(["muse-voice-transcribe-1.0"]);
    expect(skippedModels("no-screening")).toEqual(["loupe"]);
    const flags = Object.keys(ABLATE_FLAGS).sort();
    expect(flags).toEqual(["no-agent-reasoning", "no-sam", "no-screening", "no-transcribe", "no-walkthrough"]);
    expect(isAblateFlag("no-agent-reasoning")).toBe(true);
    expect(isAblateFlag("no-such-model")).toBe(false);
    expect(isAblateFlag("")).toBe(false);
    expect(isAblateFlag(null)).toBe(false);
    const exhaustive: Record<AblateFlag, true> = {
      "no-agent-reasoning": true,
      "no-walkthrough": true,
      "no-sam": true,
      "no-transcribe": true,
      "no-screening": true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual(flags);
  });
});

describe("the ablation selection", () => {
  const sets: Parameters<typeof selectAblationPopulation>[0] = [
    {
      name: "s",
      samples: [
        { id: "s/a1.eml", label: "attack", category: "credential-phishing" },
        { id: "s/a2.eml", label: "attack", category: "credential-phishing" },
        { id: "s/a3.eml", label: "attack", category: "bec-payment" },
        { id: "s/a4.eml", label: "attack", category: "bec-payment" },
        { id: "s/g1.eml", label: "genuine", category: "genuine-business" },
        { id: "s/g2.eml", label: "genuine", category: "genuine-newsletter" },
      ],
    },
  ];

  it("reselects the identical stratified ids from the seed", () => {
    const a = selectAblationPopulation(sets, { perSetAttacks: 2, perSetGenuine: 1, seed: "seed-1" });
    const b = selectAblationPopulation(sets, { perSetAttacks: 2, perSetGenuine: 1, seed: "seed-1" });
    expect(a).toEqual(b);
    // One per attack category (round-robin), plus genuine.
    expect(a.filter((id) => id.includes("/a"))).toHaveLength(2);
    const cats = new Set(
      a.filter((id) => id.includes("/a")).map((id) => (id.includes("a1") || id.includes("a2") ? "cred" : "bec")),
    );
    expect(cats.size).toBe(2);
    expect(a.filter((id) => id.includes("/g"))).toHaveLength(1);
  });

  it("differs by seed and caps at the available samples", () => {
    const a = selectAblationPopulation(sets, { perSetAttacks: 2, perSetGenuine: 1, seed: "seed-1" });
    const c = selectAblationPopulation(sets, { perSetAttacks: 99, perSetGenuine: 99, seed: "seed-2" });
    expect(c).toHaveLength(6);
    expect(new Set(c).size).toBe(6);
    expect(a).not.toEqual(c.slice(0, a.length));
  });
});

describe("the ablation manifest", () => {
  it("round-trips through temp-then-replace and refuses a mismatched deployment or population", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "eval-ablation-"));
    const manifest = {
      seed: "seed-1",
      sets: ["synthetic-sa"],
      setVersions: { "synthetic-sa": "v1" },
      deployment: "abc123",
      ids: ["synthetic-sa/a1.eml"],
    };
    const path = saveAblationManifest(dir, manifest);
    expect(loadAblationManifest(path)).toEqual(manifest);
    expect(() =>
      checkAblationManifest(manifest, { setVersions: { "synthetic-sa": "v1" }, deployment: "abc123" }),
    ).not.toThrow();
    expect(() =>
      checkAblationManifest(manifest, { setVersions: { "synthetic-sa": "v2" }, deployment: "abc123" }),
    ).toThrow(/set version/);
    expect(() =>
      checkAblationManifest(manifest, { setVersions: { "synthetic-sa": "v1" }, deployment: "def456" }),
    ).toThrow(/deployment/);
  });
});
