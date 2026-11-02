// The ablation flag contract (D08 T02 §3): one flag per switch, each naming the model calls it skips.
import { describe, expect, it } from "vitest";
import { ABLATE_FLAGS, type AblateFlag, isAblateFlag, skippedModels } from "../../eval/ablate.ts";

describe("the ablation flag contract", () => {
  it("maps every flag to exactly the model calls it skips, and rejects unknown flags", () => {
    expect(skippedModels("no-agent-reasoning")).toEqual(["muse-spark-1.3"]);
    expect(skippedModels("no-walkthrough")).toEqual(["muse-wonder-1.0"]);
    expect(skippedModels("no-sam")).toEqual(["sam-3.1"]);
    expect(skippedModels("no-transcribe")).toEqual(["muse-voice-transcribe-1.0"]);
    expect(skippedModels("no-screening")).toEqual(["loupe"]);
    const flags = Object.keys(ABLATE_FLAGS).sort();
    expect(flags).toEqual([
      "no-agent-reasoning",
      "no-sam",
      "no-screening",
      "no-transcribe",
      "no-walkthrough",
    ]);
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
