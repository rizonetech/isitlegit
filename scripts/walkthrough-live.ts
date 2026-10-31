// The live run of D04 T02 §4: the Muse Wonder loop with the live model, on the real driver, on the fictional NimbusMail
// lure (test/walkthrough/wonder-live.test.ts, a Worker test on local Browser Run). Spend counts in the one shared budget,
// the live D1's `model_spend` (scripts/lib/meta-budget.ts): the run's worst case is reserved there as one row first, so
// a cap refuses before any secret is read or anything is sent; the test spends under an allowance of that amount and
// prints what each attempt cost; the row is then settled at the reported costs, an uncertain attempt at its estimate,
// or left counted at the whole estimate when no result came back (an interrupted run included). The Meta key and the
// gateway's Run token come from Conclave and reach the test by environment, never argv, and are never printed.
//
//   node scripts/walkthrough-live.ts --confirm-credit
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Budget, BudgetExceeded } from "../src/meta/guard.ts";
import { estimateUsd } from "../src/meta/pricing.ts";
import { IMAGES_KEPT, MAX_OUTPUT_TOKENS, MAX_VIEW_TEXT, MODEL } from "../src/walkthrough/limits.ts";
import { RESULT } from "../test/walkthrough/allowance.ts";
import { localBudget } from "./lib/meta-budget.ts";
import { GATEWAY_URL, readSecretsFromVault } from "./meta-smoke.ts";
import { installSignalCleanup } from "./smoke.ts";

const ROOT = join(import.meta.dirname, "..");
// The worst case: every call of a full walk (8 actions and the final answer) at one attempt, each with the most input a
// turn can carry (every view's text, the function items, and the screenshots kept as images). A retry the allowance
// cannot hold is refused as the cap, so the walk ends `budget` rather than spend past what was reserved (the three-attempt
// worst case, US$7.69, did not fit the day cap with the other lanes' spend, 2026-10-31).
export const CALLS = 9;
export const ATTEMPTS = 1;
export const WORST_USD =
  CALLS *
  ATTEMPTS *
  estimateUsd(MODEL, {
    inputBytes: CALLS * (MAX_VIEW_TEXT + 2_000),
    images: IMAGES_KEPT,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

// The test's exit, its output (secrets removed) and Vitest's JSON report, where the result is kept.
export type Ran = { code: number; stdout: string; report: string };
export type Deps = {
  budget: Budget;
  readSecrets: () => Promise<{ meta: string; run: string }>;
  runTest: (env: NodeJS.ProcessEnv) => Promise<Ran>;
  log: (line: string) => void;
  // Where the test's output (secrets removed) is kept for reading after the run.
  keep?: (output: string) => void;
};
export type Outcome = { code: number; settled: "measured" | "estimated" | "refused" | "kept"; usd: number };

type Line = {
  outcome?: string;
  steps?: number;
  ms?: number;
  attempts?: { estimateUsd: number; actualUsd: number | null }[];
};

// The result the test kept on its `task.meta`, from Vitest's JSON report, or null when there is none (an interrupted or
// crashed run, or no report).
export function readResult(report: string): Line | null {
  try {
    const parsed = JSON.parse(report) as {
      testResults?: { assertionResults?: { meta?: Record<string, unknown> }[] }[];
    };
    for (const file of parsed.testResults ?? [])
      for (const test of file.assertionResults ?? []) {
        const kept = test.meta?.[RESULT];
        if (kept && typeof kept === "object") return kept as Line;
      }
  } catch {
    return null;
  }
  return null;
}

export async function liveRun(deps: Deps): Promise<Outcome> {
  const id = crypto.randomUUID();
  const call = { callId: crypto.randomUUID(), owner: { kind: "script" as const, name: "walkthrough-live" } };
  try {
    await deps.budget.reserve(MODEL, WORST_USD, 1, id, call);
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      deps.log(`walkthrough-live: the ${error.cap} cap refused US$${WORST_USD.toFixed(4)}; nothing was sent`);
      return { code: 2, settled: "refused", usd: 0 };
    }
    throw error;
  }
  const started = Date.now();
  let ran: Ran = { code: 1, stdout: "", report: "" };
  // Whether the test was started: before it, nothing can have been sent, so a failure releases the row at nothing.
  let sent = false;
  try {
    const secrets = await deps.readSecrets();
    sent = true;
    const raw = await deps.runTest({
      ...process.env,
      WALK_LIVE: "1",
      WALK_META_API_KEY: secrets.meta,
      WALK_CF_AIG_TOKEN: secrets.run,
      WALK_GATEWAY_URL: GATEWAY_URL,
      WALK_ALLOWANCE_USD: String(WORST_USD),
    });
    // The secrets never leave in the output.
    ran = {
      ...raw,
      stdout: [secrets.meta, secrets.run].reduce((t, x) => (x ? t.split(x).join("[secret]") : t), raw.stdout),
    };
    deps.keep?.(ran.stdout);
  } finally {
    if (!sent) {
      await deps.budget.settle(id, 0, {
        ms: Date.now() - started,
        outcome: "refused",
        certainty: "none",
        source: "estimate",
      });
      deps.log("walkthrough-live: stopped before the test started; nothing was sent");
    } else if (!readResult(ran.report)?.attempts) {
      // Nothing to settle from: the reservation stays counted at its estimate.
      await deps.budget.uncertain(id, {
        ms: Date.now() - started,
        outcome: "error",
        certainty: "estimated",
        source: "estimate",
      });
      deps.log(`walkthrough-live: no result came back; US$${WORST_USD.toFixed(4)} stays counted`);
    }
  }
  const result = readResult(ran.report);
  if (!result?.attempts) return { code: 1, settled: "kept", usd: WORST_USD };
  const uncertain = result.attempts.some((a) => a.actualUsd === null);
  const usd = result.attempts.reduce((sum, a) => sum + (a.actualUsd ?? a.estimateUsd), 0);
  await deps.budget.settle(id, usd, {
    ms: Date.now() - started,
    outcome: ran.code === 0 ? "ok" : "error",
    certainty: uncertain ? "estimated" : "measured",
    source: uncertain ? "estimate" : "meta-usage",
  });
  deps.log(
    `walkthrough-live: ${result.outcome} in ${result.steps} steps, ${((result.ms ?? 0) / 1000).toFixed(1)} s, ` +
      `US$${usd.toFixed(4)} over ${result.attempts.length} attempts${uncertain ? " (some estimated)" : ""}; test exit ${ran.code}`,
  );
  return { code: ran.code === 0 ? 0 : 1, settled: uncertain ? "estimated" : "measured", usd };
}

// The Worker test, its output and JSON report kept whatever its exit (the result is needed when it fails too).
function runTest(env: NodeJS.ProcessEnv): Promise<Ran> {
  const reportPath = join(tmpdir(), `walkthrough-live-${process.pid}-${Date.now()}.json`);
  return new Promise((resolve) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--project",
        "worker",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${reportPath}`,
        "test/walkthrough/wonder-live.test.ts",
      ],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (code) => {
      let report = "";
      try {
        report = readFileSync(reportPath, "utf8");
        rmSync(reportPath);
      } catch {}
      resolve({ code: code ?? 1, stdout, report });
    });
  });
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { "confirm-credit": { type: "boolean" } } });
  if (!values["confirm-credit"]) {
    console.error("walkthrough-live: --confirm-credit is required (the run spends Meta credit)");
    process.exit(2);
  }
  installSignalCleanup("walkthrough-live");
  const outcome = await liveRun({
    budget: localBudget("walkthrough-live"),
    readSecrets: readSecretsFromVault,
    runTest,
    log: (line) => console.log(line),
    keep: (output) => {
      const path = join(process.env.WALK_LOG_DIR ?? "/tmp", `walkthrough-live-${Date.now()}.log`);
      writeFileSync(path, output);
      console.log(`walkthrough-live: the test's output is in ${path}`);
    },
  });
  process.exit(outcome.code);
}
