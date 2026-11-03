// The ablation flag contract (D08 T02 §3): one flag per switch, each naming the model calls it skips.
import { describe, expect, it } from "vitest";
import {
  ABLATE_FLAGS,
  type AblateFlag,
  ablationArmPublishKey,
  checkAblationArmResults,
  checkAblationManifest,
  classifyFamilyFinding,
  familyFindingClasses,
  isAblateFlag,
  loadAblationManifest,
  mergeAblationArmCells,
  nextAblationArm,
  recordAblationArm,
  resumeAblationArm,
  saveAblationManifest,
  selectAblationPopulation,
  skippedModels,
  startAblationRun,
  writeAblationResults,
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

describe("the ablation RESULTS.md writer", () => {
  it("renders one row per arm with computed figures, `not measured` for unmeasured arms, keyed by arm and set", async () => {
    const { mkdtempSync, readdirSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "eval-results-"));
    const path = writeAblationResults(dir, [
      {
        arm: "full",
        set: "synthetic-sa",
        runId: "run-full",
        metrics: {
          verdictRows: 90,
          detected: 10,
          genuineRows: 70,
          falsePositives: 0,
          medianMs: 7461,
          costUsd: 1.5,
          measured: true,
        },
      },
      {
        arm: "no-agent-reasoning",
        set: "synthetic-sa",
        runId: "run-arm",
        metrics: {
          verdictRows: 90,
          detected: 5,
          genuineRows: 70,
          falsePositives: 7,
          medianMs: 7000,
          costUsd: 0.5,
          measured: true,
        },
      },
      {
        arm: "no-screening",
        set: "synthetic-sa",
        runId: "run-unmeasured",
        metrics: {
          verdictRows: 0,
          detected: 0,
          genuineRows: 0,
          falsePositives: 0,
          medianMs: 0,
          costUsd: 0,
          measured: false,
        },
      },
    ]);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("Model removed");
    expect(body).toContain("none (full baseline) | synthetic-sa | 11.1% (10/90) | 0.0% (0/70) | 7461 ms | US$1.5000 |");
    // Hand-computed deltas: detection 5.6% - 11.1% = -5.6%, FP 10.0% - 0.0% = +10.0%, time -461 ms, cost -US$1.0000.
    expect(body).toContain("muse-spark-1.3 | synthetic-sa | -5.6% | +10.0% | -461 ms | US$-1.0000 | run-arm |");
    expect(body).toContain("loupe | synthetic-sa | not measured |");
    expect(body).toContain("run-full");
    expect(readdirSync(dir)).not.toContain("RESULTS.md.tmp");
    expect(ablationArmPublishKey({ arm: "full", set: "synthetic-sa" })).toBe("synthetic-sa:full");
  });
});

describe("the ablation orchestration", () => {
  const selection = () =>
    startAblationRun(
      {
        seed: "seed-1",
        sets: ["synthetic-sa"],
        setVersions: { "synthetic-sa": "v1" },
        deployment: "abc123",
        ids: ["a", "b"],
      },
      ["no-screening"],
    );
  it("runs the full arm first, then the flags in order", () => {
    expect(nextAblationArm(selection())?.flag).toBe("full");
    const afterFull = recordAblationArm(selection(), "full", "run-full", "complete");
    expect(nextAblationArm(afterFull)?.flag).toBe("no-screening");
    expect(nextAblationArm(recordAblationArm(afterFull, "no-screening", "run-arm", "complete"))).toBeNull();
  });
  it("stops on a failed arm and resumes it preserving the selection and switch", () => {
    const failed = recordAblationArm(selection(), "full", "run-full", "failed");
    expect(() => nextAblationArm(failed)).toThrow(/stopped on the failed full arm/);
    const resumed = resumeAblationArm(failed, "full");
    expect(resumed.ids).toEqual(["a", "b"]);
    expect(resumed.arms[0]).toEqual({ flag: "full", runId: null, status: "pending" });
    expect(nextAblationArm(resumed)?.flag).toBe("full");
  });
  it("refuses an arm whose results are all stale-repeat", () => {
    expect(() => checkAblationArmResults("full", ["stale-repeat", "stale-repeat"])).toThrow(/measures nothing/);
    expect(() => checkAblationArmResults("full", ["done", "stale-repeat"])).not.toThrow();
  });
  it("an arm publish replaces only the baseline cells at the arm ids", () => {
    const merged = mergeAblationArmCells({ full: { detected: "10/90" } }, "synthetic-sa:full", { detected: "8/90" });
    expect(merged).toEqual({ full: { detected: "10/90" }, "synthetic-sa:full": { detected: "8/90" } });
  });
});

describe("the ablation command orchestration", () => {
  const manifest = () =>
    startAblationRun(
      { seed: "s", sets: ["synthetic-sa"], setVersions: { "synthetic-sa": "v1" }, deployment: "d1", ids: ["a"] },
      ["no-screening"],
    );
  const actual = { setVersions: { "synthetic-sa": "v1" }, deployment: "d1" };
  const report = (arm: AblateFlag | "full", runId: string) => ({
    arm,
    set: "synthetic-sa",
    runId,
    metrics: {
      verdictRows: 2,
      detected: 1,
      genuineRows: 2,
      falsePositives: 0,
      medianMs: 10,
      costUsd: 0.1,
      measured: true,
    },
  });

  it("runs the full arm then each switch under its stated cap and writes the table", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "eval-ablate-run-"));
    const { runAblation } = await import("../../eval/ablate-run.ts");
    const caps: Record<string, number> = {};
    const out = await runAblation({
      manifest: manifest(),
      caps: { full: 5, "no-screening": 5 },
      actual,
      resultsDir: dir,
      runArm: async (flag, cap) => {
        caps[flag] = cap;
        return { runId: `run-${flag}`, status: "complete", outcomes: ["done"], report: report(flag, `run-${flag}`) };
      },
    });
    expect(out.status).toBe("complete");
    expect(caps).toEqual({ full: 5, "no-screening": 5 });
    expect(readFileSync(out.resultsPath ?? "", "utf8")).toContain("Model removed");
  });

  it("stops on a failed arm, refuses a mismatched deployment, and excludes an all-stale arm", async () => {
    const { runAblation, parseAblateArgs } = await import("../../eval/ablate-run.ts");
    const failed = await runAblation({
      manifest: manifest(),
      caps: { full: 5, "no-screening": 5 },
      actual,
      resultsDir: "/tmp",
      runArm: async () => ({ runId: "r1", status: "failed", outcomes: ["done"], report: null }),
    });
    expect(failed.status).toBe("incomplete");
    expect(failed.arms).toHaveLength(2);
    const stale = await runAblation({
      manifest: manifest(),
      caps: { full: 5, "no-screening": 5 },
      actual,
      resultsDir: "/tmp",
      runArm: async (flag) => ({
        runId: "r2",
        status: "complete",
        outcomes: ["stale-repeat"],
        report: report(flag, "r2"),
      }),
    });
    expect(stale.resultsPath).toBeNull();
    const drift = await runAblation({
      manifest: manifest(),
      caps: { full: 5 },
      actual: { setVersions: { "synthetic-sa": "v1" }, deployment: "d2" },
      resultsDir: "/tmp",
      runArm: async () => ({ runId: "r3", status: "complete", outcomes: ["done"], report: null }),
    });
    expect(drift.status).toBe("refused");
    expect(parseAblateArgs([])).toHaveProperty("error");
    expect(parseAblateArgs(["--cap-usd", "5", "--flags", "nope"])).toHaveProperty("error");
    expect(parseAblateArgs(["--cap-usd", "5"])).toMatchObject({ capUsd: 5 });
  });
});

describe("the impersonation finding classes", () => {
  it("separates verdict-changing checks from corroborating ones", () => {
    expect(classifyFamilyFinding("sender.display_address")).toBe("standalone");
    expect(classifyFamilyFinding("sender.display_brand")).toBe("standalone");
    expect(classifyFamilyFinding("link.text_mismatch")).toBe("standalone");
    expect(classifyFamilyFinding("link.final_domain_changed")).toBe("corroborating");
    expect(classifyFamilyFinding("link.lure_button")).toBe("corroborating");
    expect(classifyFamilyFinding("link.redirects")).toBe("other");
    // A lone corroborating finding cannot change the verdict; beside a standalone one it corroborates.
    expect(familyFindingClasses(["link.final_domain_changed"])).toEqual({
      standalone: [],
      corroborating: ["link.final_domain_changed"],
    });
    expect(familyFindingClasses(["sender.display_address", "link.final_domain_changed"])).toEqual({
      standalone: ["sender.display_address"],
      corroborating: ["link.final_domain_changed"],
    });
  });
});
