// The live run of D06 T01 §1: the invoice extraction with the live Muse Spark on three synthetic documents
// (test/invoice/extract-live.test.ts, a Worker test). Spend counts in the one shared budget, the live
// D1's `model_spend` (scripts/lib/meta-budget.ts): the run's worst case is reserved there as one row
// first, so a cap refuses before any secret is read or anything is sent; the test spends under an
// allowance of that amount and prints what each attempt cost; the row is then settled at the reported
// costs, an uncertain attempt at its estimate, or left counted at the whole estimate when no result
// came back. The Meta key and gateway token come from Conclave and reach the test by environment,
// never argv, and are never printed.
//
//   node scripts/invoice-live.ts --confirm-credit
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
// The worst case: four documents, one extraction call each (structured may repair once: two attempts),
// each a 20 KB PDF sent inline at the output limit. Cap stated before the run: US$1.00, inside
// the coordinator's US$10.00 across D06 T01 §1 and D05 T04 §4 (2026-11-02).
export const FIXTURES = 4;
export const ATTEMPTS = 2;
export const CAP_USD = 1.0;
export const WORST_USD = FIXTURES * ATTEMPTS * estimateUsd(MODEL, { inputBytes: 30_000, maxOutputTokens: 2_000 });
// The §5 synthetic set (D06 T01 §5): 12 documents, cap US$1.25 stated before the run, inside the
// same US$10.00 envelope (§1 counted US$0.7077 of it; D05 T04 §4 keeps the remainder).
export const FIXTURES_SET = 12;
export const CAP_SET_USD = 1.25;
export const WORST_SET_USD =
  FIXTURES_SET * ATTEMPTS * estimateUsd(MODEL, { inputBytes: 30_000, maxOutputTokens: 2_000 });

export type Ran = { code: number; stdout: string; report: string };
export type Deps = {
  worstUsd?: number;
  budget: Budget;
  readSecrets: () => Promise<{ meta: string; run: string }>;
  runTest: (env: NodeJS.ProcessEnv) => Promise<Ran>;
  log: (line: string) => void;
  keep?: (output: string) => void;
};
export type Outcome = { code: number; settled: "measured" | "estimated" | "refused" | "kept"; usd: number };

type Line = {
  outcome?: string;
  docs?: { name: string; fields: unknown; ms: number }[];
  attempts?: { estimateUsd: number; actualUsd: number | null }[];
  total?: number;
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
  const WORST = deps.worstUsd ?? WORST_USD;
  const id = crypto.randomUUID();
  const call = { callId: crypto.randomUUID(), owner: { kind: "script" as const, name: "invoice-live" } };
  try {
    await deps.budget.reserve(MODEL, WORST, 1, id, call);
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      deps.log(`invoice-live: the ${error.cap} cap refused US$${WORST.toFixed(4)}; nothing was sent`);
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
      INVOICE_LIVE: "1",
      INVOICE_META_API_KEY: secrets.meta,
      INVOICE_CF_AIG_TOKEN: secrets.run,
      INVOICE_GATEWAY_URL: GATEWAY_URL,
      INVOICE_ALLOWANCE_USD: String(WORST),
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
      deps.log("invoice-live: stopped before the test started; nothing was sent");
    } else if (!readResult(ran.report)?.attempts) {
      await deps.budget.uncertain(id, {
        ms: Date.now() - started,
        outcome: "error",
        certainty: "estimated",
        source: "estimate",
      });
      deps.log(`invoice-live: no result came back; US$${WORST.toFixed(4)} stays counted`);
    }
  }
  const result = readResult(ran.report);
  if (!result?.attempts) return { code: 1, settled: "kept", usd: WORST };
  // A partial result (fewer documents than the set holds) may miss an attempt that was still in
  // flight when the snapshot was taken: settling it as measured would undercount, so the whole
  // reservation stays counted at the estimate instead.
  const expected = result.total;
  if (expected && (result.docs?.length ?? 0) < expected) {
    await deps.budget.uncertain(id, {
      ms: Date.now() - started,
      outcome: "error",
      certainty: "estimated",
      source: "estimate",
    });
    deps.log(
      `invoice-live: partial result (${result.docs?.length ?? 0} of ${expected} documents); US$${WORST.toFixed(4)} stays counted`,
    );
    return { code: 1, settled: "kept", usd: WORST };
  }
  const uncertain = result.attempts.some((a) => a.actualUsd === null);
  const usd = result.attempts.reduce((sum, a) => sum + (a.actualUsd ?? a.estimateUsd), 0);
  await deps.budget.settle(id, usd, {
    ms: Date.now() - started,
    outcome: ran.code === 0 ? "ok" : "error",
    certainty: uncertain ? "estimated" : "measured",
    source: uncertain ? "estimate" : "meta-usage",
  });
  const docs = result.docs ?? [];
  deps.log(
    `invoice-live: ${docs.map((d) => `${d.name}(${((d.ms ?? 0) / 1000).toFixed(1)}s)`).join(", ")}; ` +
      `US$${usd.toFixed(4)} over ${result.attempts.length} attempts${uncertain ? " (some estimated)" : ""}; test exit ${ran.code}`,
  );
  return { code: ran.code === 0 ? 0 : 1, settled: uncertain ? "estimated" : "measured", usd };
}

function runTest(env: NodeJS.ProcessEnv): Promise<Ran> {
  const reportPath = join(tmpdir(), `invoice-live-${process.pid}-${Date.now()}.json`);
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
        process.env.INVOICE_LIVE_FILE ?? "test/invoice/extract-live.test.ts",
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
  const { values } = parseArgs({ options: { "confirm-credit": { type: "boolean" }, fixtures: { type: "boolean" } } });
  if (values.fixtures) process.env.INVOICE_LIVE_FILE = "test/invoice/fixtures-live.test.ts";
  if (!values["confirm-credit"]) {
    console.error("invoice-live: --confirm-credit is required (the run spends Meta credit)");
    process.exit(2);
  }
  installSignalCleanup("invoice-live");
  const outcome = await liveRun({
    ...(values.fixtures ? { worstUsd: WORST_SET_USD } : {}),
    budget: localBudget("invoice-live"),
    readSecrets: readSecretsFromVault,
    runTest,
    log: (line) => console.log(line),
    keep: (output) => {
      const path = join(process.env.INVOICE_LOG_DIR ?? "/tmp", `invoice-live-${Date.now()}.log`);
      writeFileSync(path, output);
      console.log(`invoice-live: the test's output is in ${path}`);
    },
  });
  process.exit(outcome.code);
}
