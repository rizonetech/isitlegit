// The live run of D03 T02 §3: the vision step with the live Muse Spark on three synthetic fixtures
// (test/vision/reading-live.test.ts, a Worker test). Spend counts in the one shared budget, the live
// D1's `model_spend` (scripts/lib/meta-budget.ts): the run's worst case is reserved there as one row
// first, so a cap refuses before any secret is read or anything is sent; the test spends under an
// allowance of that amount and prints what each attempt cost; the row is then settled at the reported
// costs, an uncertain attempt at its estimate, or left counted at the whole estimate when no result
// came back. The Meta key and gateway token come from Conclave and reach the test by environment,
// never argv, and are never printed.
//
//   node scripts/vision-live.ts --confirm-credit
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Budget, BudgetExceeded } from "../src/meta/guard.ts";
import { estimateUsd } from "../src/meta/pricing.ts";
import { RESULT } from "../test/walkthrough/allowance.ts";
import { localBudget } from "./lib/meta-budget.ts";
import { GATEWAY_URL, readSecretsFromVault } from "./meta-smoke.ts";
import { installSignalCleanup } from "./smoke.ts";

const MODEL = "muse-spark-1.3";
const ROOT = join(import.meta.dirname, "..");
// The worst case: three fixtures, one reading call each (structured may repair once: two attempts),
// six images and a full visible text at the output limit. Cap stated before the run: US$1.00.
export const FIXTURES = 3;
export const ATTEMPTS = 2;
export const CAP_USD = 1.0;
export const WORST_USD =
  FIXTURES * ATTEMPTS * estimateUsd(MODEL, { inputBytes: 24_000, images: 6, maxOutputTokens: 2_000 });

export type Ran = { code: number; stdout: string; report: string };
export type Deps = {
  budget: Budget;
  readSecrets: () => Promise<{ meta: string; run: string }>;
  runTest: (env: NodeJS.ProcessEnv) => Promise<Ran>;
  log: (line: string) => void;
  keep?: (output: string) => void;
};
export type Outcome = { code: number; settled: "measured" | "estimated" | "refused" | "kept"; usd: number };

type Line = {
  outcome?: string;
  cases?: { name: string; outcome: string; items: string[]; ms: number }[];
  attempts?: { estimateUsd: number; actualUsd: number | null }[];
};

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
  const call = { callId: crypto.randomUUID(), owner: { kind: "script" as const, name: "vision-live" } };
  try {
    await deps.budget.reserve(MODEL, WORST_USD, 1, id, call);
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      deps.log(`vision-live: the ${error.cap} cap refused US$${WORST_USD.toFixed(4)}; nothing was sent`);
      return { code: 2, settled: "refused", usd: 0 };
    }
    throw error;
  }
  const started = Date.now();
  let ran: Ran = { code: 1, stdout: "", report: "" };
  let sent = false;
  try {
    const secrets = await deps.readSecrets();
    sent = true;
    const raw = await deps.runTest({
      ...process.env,
      VISION_LIVE: "1",
      VISION_META_API_KEY: secrets.meta,
      VISION_CF_AIG_TOKEN: secrets.run,
      VISION_GATEWAY_URL: GATEWAY_URL,
      VISION_ALLOWANCE_USD: String(WORST_USD),
    });
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
      deps.log("vision-live: stopped before the test started; nothing was sent");
    } else if (!readResult(ran.report)?.attempts) {
      await deps.budget.uncertain(id, {
        ms: Date.now() - started,
        outcome: "error",
        certainty: "estimated",
        source: "estimate",
      });
      deps.log(`vision-live: no result came back; US$${WORST_USD.toFixed(4)} stays counted`);
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
  const cases = result.cases ?? [];
  deps.log(
    `vision-live: ${cases.map((c) => `${c.name}=${c.outcome}[${c.items.join(",")}](${((c.ms ?? 0) / 1000).toFixed(1)}s)`).join(", ")}; ` +
      `US$${usd.toFixed(4)} over ${result.attempts.length} attempts${uncertain ? " (some estimated)" : ""}; test exit ${ran.code}`,
  );
  return { code: ran.code === 0 ? 0 : 1, settled: uncertain ? "estimated" : "measured", usd };
}

function runTest(env: NodeJS.ProcessEnv): Promise<Ran> {
  const reportPath = join(tmpdir(), `vision-live-${process.pid}-${Date.now()}.json`);
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
        "test/vision/reading-live.test.ts",
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
    console.error("vision-live: --confirm-credit is required (the run spends Meta credit)");
    process.exit(2);
  }
  installSignalCleanup("vision-live");
  const outcome = await liveRun({
    budget: localBudget("vision-live"),
    readSecrets: readSecretsFromVault,
    runTest,
    log: (line) => console.log(line),
    keep: (output) => {
      const path = join(process.env.VISION_LOG_DIR ?? "/tmp", `vision-live-${Date.now()}.log`);
      writeFileSync(path, output);
      console.log(`vision-live: the test's output is in ${path}`);
    },
  });
  process.exit(outcome.code);
}
