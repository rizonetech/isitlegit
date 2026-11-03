// The ablation command (D08 T02 section 3): one budgeted arm per switch plus the full baseline arm, in order,
// stopping on a failed arm, writing the Model removed table to eval/RESULTS.md from stored arm reports.
// Live arms upload through the runner only once the intake admit transports the flags (checks lane D01);
// until then a live run is refused by name, never silently run as the full pipeline.
import { join } from "node:path";
import {
  type AblateFlag,
  type AblationArmReport,
  type AblationRunManifest,
  checkAblationArmResults,
  checkAblationManifest,
  isAblateFlag,
  nextAblationArm,
  recordAblationArm,
  startAblationRun,
  writeAblationResults,
} from "./ablate.ts";

export type AblateArmOutcome = {
  runId: string;
  status: "complete" | "incomplete" | "failed";
  outcomes: string[];
  report: AblationArmReport | null;
};

export type AblateClients = {
  manifest: AblationRunManifest;
  caps: Record<string, number>;
  runArm: (flag: AblateFlag | "full", capUsd: number) => Promise<AblateArmOutcome>;
  resultsDir: string;
  actual: { setVersions: Record<string, string>; deployment: string };
};

export type AblateResult = {
  status: "complete" | "incomplete" | "refused";
  arms: { flag: string; runId: string | null; status: string }[];
  resultsPath: string | null;
  problems: string[];
};

export async function runAblation(clients: AblateClients): Promise<AblateResult> {
  const problems: string[] = [];
  try {
    checkAblationManifest(clients.manifest, clients.actual);
  } catch (e) {
    return {
      status: "refused",
      arms: clients.manifest.arms.map((a) => ({ flag: a.flag, runId: a.runId, status: a.status })),
      resultsPath: null,
      problems: [e instanceof Error ? e.message : String(e)],
    };
  }
  let manifest = clients.manifest;
  const reports: AblationArmReport[] = [];
  for (;;) {
    let next: ReturnType<typeof nextAblationArm>;
    try {
      next = nextAblationArm(manifest);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
      break;
    }
    if (!next) break;
    const cap = clients.caps[next.flag];
    if (cap === undefined || !(cap > 0)) {
      problems.push(`no stated cap for the ${next.flag} arm: state one before it spends`);
      manifest = recordAblationArm(manifest, next.flag, "", "failed");
      break;
    }
    const outcome = await clients.runArm(next.flag, cap);
    try {
      checkAblationArmResults(next.flag, outcome.outcomes);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
      manifest = recordAblationArm(manifest, next.flag, outcome.runId, "incomplete");
      break;
    }
    manifest = recordAblationArm(manifest, next.flag, outcome.runId, outcome.status);
    if (outcome.report) reports.push(outcome.report);
    if (outcome.status === "failed") {
      problems.push(`the ${next.flag} arm failed (${outcome.runId}): later arms not started`);
      break;
    }
    if (outcome.status === "incomplete") {
      problems.push(`the ${next.flag} arm is incomplete (${outcome.runId}): it never enters the table as measured`);
      break;
    }
  }
  const measured = reports.filter((r) => r.metrics.measured);
  const resultsPath = measured.length > 0 ? writeAblationResults(clients.resultsDir, reports) : null;
  const complete = problems.length === 0 && manifest.arms.every((a) => a.status === "complete");
  return {
    status: complete ? "complete" : "incomplete",
    arms: manifest.arms.map((a) => ({ flag: a.flag, runId: a.runId, status: a.status })),
    resultsPath,
    problems,
  };
}

export const ABLATE_USAGE = [
  "usage: pnpm eval:ablate --cap-usd <usd> [--flags <a,b>] [--seed <seed>]",
  "flags: no-agent-reasoning, no-walkthrough, no-sam, no-transcribe, no-screening (all by default, after the full arm).",
  "Exit 0 complete, 2 incomplete, 3 refused. Live arms need the intake flag admit (checks lane D01, D08 T02 section 3).",
].join("\n");

export function parseAblateArgs(
  argv: string[],
): { capUsd: number; flags: AblateFlag[]; seed: string } | { error: string } {
  let capUsd: number | null = null;
  let flags: AblateFlag[] = ["no-agent-reasoning", "no-walkthrough", "no-sam", "no-transcribe", "no-screening"];
  let seed = "ablation-v1";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cap-usd") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: "--cap-usd needs a positive number" };
      capUsd = v;
    } else if (a === "--flags") {
      const parts = (argv[++i] ?? "").split(",").filter(Boolean);
      if (parts.length === 0 || !parts.every(isAblateFlag))
        return { error: `--flags names unknown flags: ${parts.join(",")}` };
      flags = parts as AblateFlag[];
    } else if (a === "--seed") {
      seed = argv[++i] ?? "";
      if (!seed) return { error: "--seed needs a value" };
    } else return { error: `unknown option ${a}` };
  }
  if (capUsd === null) return { error: "--cap-usd is required (a stated cap per arm, never raised)" };
  return { capUsd, flags, seed };
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseAblateArgs(argv);
  if ("error" in parsed) {
    console.error(`eval:ablate: ${parsed.error}\n${ABLATE_USAGE}`);
    return 3;
  }
  // The flags reach a case only through the intake admit; without it every arm would measure the full pipeline.
  console.error(
    "eval:ablate: live arms refused: /api/upload does not admit ablate flags yet (checks lane D01 intake, D08 T02 section 3 hooks). No upload sent, no spend.",
  );
  return 3;
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
