// Durable upload ablation command (D08 T02 section 17). The original in-memory prototype is replaced
// by the tested command path in ablation-experiment.ts; missing server capabilities refuse before spending.
import { join } from "node:path";
import { type AblateFlag, ExperimentId, isAblateFlag, startAblationRun, UPLOAD_FLAGS } from "./ablate.ts";

export const ABLATE_USAGE = [
  "usage: node eval/ablate-run.ts --cap-usd <per-arm-usd> [--flags <a,b>] [--seed <seed>] [--set <a,b>]",
  "       node eval/ablate-run.ts --resume <experiment-id>",
  "Defaults: four upload arms after full; Loupe screening is not measured by uploads.",
  "State: build/eval-ablation/<experiment-id>/manifest.json. Resume keeps caps, IDs and deployment.",
  "Exit 0 complete, 2 incomplete, 3 refused. No live arm before exact deployed capabilities pass.",
].join("\n");
export type AblateOptions = {
  capUsd: number | null;
  flags: AblateFlag[];
  seed: string;
  sets: string[];
  resume: string | null;
};
export function parseAblateArgs(argv: string[]): AblateOptions | { error: string } {
  const out: AblateOptions = {
    capUsd: null,
    flags: [...UPLOAD_FLAGS],
    seed: "ablation-v1",
    sets: ["nazario-2025", "synthetic-sa", "synthetic-challenge"],
    resume: null,
  };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = argv[++i];
    if (!name || seen.has(name) || !value) return { error: "duplicate option or missing value" };
    seen.add(name);
    if (name === "--cap-usd") {
      if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0)
        return { error: "--cap-usd needs a positive per-arm cap" };
      out.capUsd = Number(value);
    } else if (name === "--flags") {
      const flags = value.split(",");
      if (!flags.every(isAblateFlag) || new Set(flags).size !== flags.length)
        return { error: "unknown or duplicate arm" };
      out.flags = flags as AblateFlag[];
    } else if (name === "--seed") {
      if (value.length > 200) return { error: "seed exceeds 200 characters" };
      out.seed = value;
    } else if (name === "--set") {
      const sets = value.split(",");
      if (
        !sets.every((s) => ["nazario-2025", "synthetic-sa", "synthetic-challenge"].includes(s)) ||
        new Set(sets).size !== sets.length
      )
        return { error: "unknown or duplicate set" };
      out.sets = sets;
    } else if (name === "--resume") {
      if (!ExperimentId.safeParse(value).success) return { error: "invalid experiment ID" };
      out.resume = value;
    } else return { error: `unknown option ${name}` };
  }
  if (out.resume && seen.size !== 1)
    return { error: "--resume stands alone; stored caps, flags, seed and population remain immutable" };
  if (!out.resume && out.capUsd === null) return { error: "--cap-usd is required" };
  return out;
}
export async function main(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  deps?: import("./ablation-experiment.ts").ExperimentDeps,
): Promise<number> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(ABLATE_USAGE);
    return 0;
  }
  const parsed = parseAblateArgs(argv);
  if ("error" in parsed) {
    console.error(`eval:ablate: ${parsed.error}\n${ABLATE_USAGE}`);
    return 3;
  }
  const { runExperimentCommand } = await import("./ablation-experiment.ts");
  return runExperimentCommand(parsed, environment, deps);
}

if (process.argv[1] && import.meta.filename === process.argv[1])
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`eval:ablate: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );

export { startAblationRun };
export const RESULTS_DIR = join(import.meta.dirname, "..", "eval");
