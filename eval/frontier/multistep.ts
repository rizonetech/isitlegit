// Offline experiment coordinator. Only explicit run + credit confirmation can reach a provider.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { execute, localBudget } from "../../scripts/lib/meta-budget.ts";
import { GATEWAY_URL, readSecretsFromVault } from "../../scripts/meta-smoke.ts";
import { MODEL } from "../../src/walkthrough/limits.ts";
import { renderSupplement, sourceConfiguration, verifyPublished } from "./multistep-configuration.ts";
import {
  ALLOWANCE,
  capacityDelay,
  type Deps,
  INITIAL_CAP,
  INITIAL10_AUTHORITY,
  type LedgerRow,
  Refusal,
  ReportSchema,
  reconcile,
  runNext,
  type State,
  scoreExperiment,
  usedUsd,
  validateState,
} from "./multistep-core.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const NAMES = ["index", "lure", "login", "submitted"] as const;
const SOURCE_PATHS = [
  "eval/frontier/multistep.ts",
  "eval/frontier/multistep-core.ts",
  "eval/frontier/multistep-observation.ts",
  "eval/frontier/multistep-configuration.ts",
  "eval/frontier/multistep-vitest.config.ts",
  "test/eval/frontier-multistep-live.test.ts",
  "fixtures/nimbusmail-multistep",
];
export const USAGE =
  "usage: node eval/frontier/multistep.ts run --confirm-credit --deployed-sha <full-sha> [--dir path] [--initial-cap-usd 10 --initial-cap-authority BUDGET-RECOVERY-20] [--cap-usd 10|20 --decision reason]\n       node eval/frontier/multistep.ts reconcile|score [--dir path] [--check docs/frontier-log.md]\nMULTISTEP_URL is environment-only. Five ordinals; no automatic retry; score/reconcile make no provider call.";
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function atomicState(path: string, state: State) {
  validateState(state);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    const parent = openSync(dirname(path), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    if (existsSync(temp)) rmSync(temp);
  }
}
export async function exclusive<T>(dir: string, work: () => Promise<T>, lockName = ".lock"): Promise<T> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const child = spawn(
    "flock",
    [
      "-w",
      "2",
      "-E",
      "73",
      join(dir, lockName),
      process.execPath,
      "-e",
      'process.stdout.write("ready");process.stdin.resume();',
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  await new Promise<void>((ready, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Refusal("experiment lock unavailable")));
    child.stdout.once("data", () => ready());
  });
  try {
    return await work();
  } finally {
    child.stdin.end();
    await closed;
  }
}
function git(args: string[]) {
  const p = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (p.status !== 0) throw new Refusal("cannot verify committed source identity");
  return p.stdout.trim();
}
export function fixtureUrl(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "fixtures.isitlegit.co.za" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9_-]{16,128}\/nimbusmail-multistep\/$/.test(url.pathname)
  )
    throw new Refusal("fixture URL does not match the authorized route");
  return url;
}
function hashes() {
  return Object.fromEntries(
    NAMES.map((name) => [name, digest(readFileSync(join(ROOT, `fixtures/nimbusmail-multistep/${name}.html`)))]),
  );
}
export async function boundedBody(response: Response, limit = 100000): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Refusal("fixture response exceeded its bound");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function preflight(state: State, rawUrl: string, fetcher: typeof fetch = fetch, checkGit = true) {
  const url = fixtureUrl(rawUrl);
  if (digest(url.href) !== state.urlHash) throw new Refusal("fixture identity differs from saved experiment");
  if (JSON.stringify(hashes()) !== JSON.stringify(state.fixtureHashes)) throw new Refusal("fixture bytes changed");
  if (checkGit) {
    if (git(["status", "--porcelain"])) throw new Refusal("live experiment requires a clean committed checkout");
    git(["diff", "--exit-code", state.sourceSha, "--", ...SOURCE_PATHS]);
    git(["diff", "--exit-code", state.deployedSha, "--", "src"]);
  }
  if (checkGit) {
    const config = sourceConfiguration(state.sourceSha);
    if (state.configuration && JSON.stringify(config) !== JSON.stringify(state.configuration))
      throw new Refusal("configuration differs from frozen source");
  }
  const health = await fetcher("https://app.isitlegit.co.za/health", {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  const body = z
    .object({ ok: z.literal(true), commit: z.literal(state.deployedSha) })
    .safeParse(JSON.parse(new TextDecoder().decode(await boundedBody(health, 4096))));
  if (!health.ok || !body.success) throw new Refusal("deployed identity does not match experiment");
  for (const name of NAMES) {
    const response = await fetcher(new URL(name === "index" ? "" : name, url), {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("text/html") ||
      !response.headers.get("x-robots-tag")?.toLowerCase().includes("noindex") ||
      !response.headers.get("cache-control")?.toLowerCase().includes("no-store")
    )
      throw new Refusal("fixture response failed publication checks");
    const bytes = await boundedBody(response);
    if (bytes.byteLength > 100000 || digest(bytes) !== state.fixtureHashes[name])
      throw new Refusal("deployed fixture bytes do not match");
  }
}
export async function ledgerRow(id: string): Promise<LedgerRow | null> {
  const row = (
    await execute({
      sql: "SELECT id,caller,model,estimate_usd AS estimateUsd,actual_usd AS actualUsd,state,outcome FROM model_spend WHERE id=?1",
      params: [id],
    })
  ).results?.[0];
  if (!row) return null;
  return z
    .strictObject({
      id: z.string(),
      caller: z.string(),
      model: z.string(),
      estimateUsd: z.number().finite().nonnegative(),
      actualUsd: z.number().finite().nonnegative().nullable(),
      state: z.enum(["reserved", "uncertain", "settled"]),
      outcome: z.string().nullable(),
    })
    .parse(row);
}
function childWalk(
  dir: string,
  ordinal: number,
  reservationId: string,
  allowance: number,
  url: string,
): Promise<unknown> {
  return (async () => {
    const secrets = await readSecretsFromVault();
    const reportPath = join(dir, `${reservationId}.child.json`);
    if (existsSync(reportPath)) throw new Refusal("existing child output requires reconciliation");
    const child = spawn(
      "flock",
      [
        "-n",
        "-E",
        "73",
        join(dir, ".walk.lock"),
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--config",
        "eval/frontier/multistep-vitest.config.ts",
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          MULTISTEP_LIVE: "1",
          MULTISTEP_URL: url,
          MULTISTEP_ORDINAL: String(ordinal),
          MULTISTEP_RESERVATION: reservationId,
          WALK_META_API_KEY: secrets.meta,
          WALK_CF_AIG_TOKEN: secrets.run,
          WALK_GATEWAY_URL: GATEWAY_URL,
          WALK_ALLOWANCE_USD: String(allowance),
        },
        // Provider/child diagnostics can contain private URLs; only the validated public result crosses this boundary.
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const code = await new Promise<number>((done, reject) => {
      child.once("error", reject);
      child.once("close", (code) => done(code ?? 1));
    });
    if (code !== 0 || !existsSync(reportPath))
      throw new Refusal("child outcome unavailable; reconcile before any later attempt");
    const report = readChildReport(reportPath, ordinal, reservationId);
    if (!report.diagnostic) throw new Refusal("new child observation lacks bounded diagnostics");
    return report;
  })();
}
export function readChildReport(reportPath: string, ordinal: number, reservationId: string) {
  const parsed = JSON.parse(readFileSync(reportPath, "utf8")) as {
    testResults?: { assertionResults?: { meta?: Record<string, unknown> }[] }[];
  };
  const reports = (parsed.testResults ?? [])
    .flatMap((file) => file.assertionResults ?? [])
    .map((test) => test.meta?.multistep)
    .filter((r) => r !== undefined);
  if (reports.length !== 1) throw new Refusal("child did not return exactly one observation");
  const report = ReportSchema.parse(reports[0]);
  if (report.ordinal !== ordinal || report.reservationId !== reservationId)
    throw new Refusal("child identity differs from reserved ordinal");
  return report;
}
export function initialBudget(
  cap?: number,
  authority?: string,
): Pick<State, "initialCapUsd" | "capUsd" | "initialCapAuthority"> {
  if (cap === undefined && authority === undefined) return { initialCapUsd: INITIAL_CAP, capUsd: INITIAL_CAP };
  if (cap !== 10 || authority !== INITIAL10_AUTHORITY.decision)
    throw new Refusal("initial cap requires explicit 10 and BUDGET-RECOVERY-20 authority");
  return { initialCapUsd: 10, capUsd: 10, initialCapAuthority: { ...INITIAL10_AUTHORITY } };
}
export function createState(deployedSha: string, url: string, initialCap?: number, authority?: string): State {
  const budget = initialBudget(initialCap, authority);
  if (git(["status", "--porcelain"])) throw new Refusal("live experiment requires a clean committed checkout");
  if (!/^[a-f0-9]{40}$/.test(deployedSha)) throw new Refusal("full deployed SHA required");
  return validateState({
    version: 1,
    configuration: sourceConfiguration(git(["rev-parse", "HEAD"])),
    id: randomUUID(),
    sourceSha: git(["rev-parse", "HEAD"]),
    deployedSha,
    fixtureHashes: hashes(),
    urlHash: digest(fixtureUrl(url).href),
    model: MODEL,
    allowanceUsd: ALLOWANCE,
    ...budget,
    capDecisions: [],
    failures: 0,
    notBefore: null,
    slots: Array.from({ length: 5 }, (_, i) => ({
      ordinal: i + 1,
      reservationId: randomUUID(),
      reservationHistory: [],
      status: "ready",
      report: null,
      costUsd: 0,
      certainty: "none",
    })),
  });
}
export function raiseCap(state: State, to: number, reason: string, now: Date) {
  if (
    to !== state.capUsd * 2 ||
    ![10, 20].includes(to) ||
    reason.trim().length < 20 ||
    reason.length > 1000 ||
    !state.slots.some(
      (slot) => slot.status === "complete" && slot.report?.attempts.some((attempt) => (attempt.actualUsd ?? 0) > 0),
    ) ||
    !state.slots.some((slot) => slot.status === "ready")
  )
    throw new Refusal("staged cap change needs measured usage, remaining attempts and a recorded reason");
  state.capDecisions.push({ from: state.capUsd, to, at: now.toISOString(), reason, usedUsd: usedUsd(state) });
  state.capUsd = to as 10 | 20;
  validateState(state);
}
export function render(state: State) {
  const score = scoreExperiment(state);
  const noModelCalls = !score.unknown && state.slots.every((slot) => slot.report?.attempts.length === 0);
  return `## Wonder multi-step experiment\n\nSource ${state.sourceSha}; deployed ${state.deployedSha}; experiment ${state.id}.\n\nCredential page reached: ${score.reached}/${score.total}. Unknown outcomes: ${score.unknown}. Counted cost: US$${score.costUsd.toFixed(6)} (${score.estimated} estimated ordinals). Credential arrival steps: ${JSON.stringify(score.arrivalSteps)}. Arrival time ms: ${JSON.stringify(score.arrivalMs)}. Final steps: ${JSON.stringify(score.steps)}. Final time ms: ${JSON.stringify(score.ms)}.\n\n${noModelCalls ? "No model call was attempted; model navigation capability was not measured." : "These outcomes record a contained synthetic-fixture experiment, not production detection accuracy."} Reaching the credential page is distinct from successful form submission. ${score.unknown ? "Incomplete: unknown attempts retain their full reserved charge; no completion claim." : "All five observations are accounted for."}\n`;
}
export async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(USAGE);
    return 0;
  }
  const command = argv[0];
  if (!["run", "reconcile", "score"].includes(command ?? "")) throw new Refusal(USAGE);
  let dir = join(homedir(), "isitlegit-data/frontier/multistep"),
    sha = "",
    check = "",
    confirmed = false,
    cap = 0,
    decision = "";
  let initialCap: number | undefined, initialAuthority: string | undefined;
  const seen = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (!key || seen.has(key)) throw new Refusal("duplicate option");
    seen.add(key);
    if (key === "--confirm-credit") confirmed = true;
    else if (
      [
        "--dir",
        "--deployed-sha",
        "--check",
        "--cap-usd",
        "--decision",
        "--initial-cap-usd",
        "--initial-cap-authority",
      ].includes(key)
    ) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Refusal("missing option value");
      if (key === "--dir") dir = resolve(value);
      else if (key === "--deployed-sha") sha = value;
      else if (key === "--check") check = value;
      else if (key === "--initial-cap-usd") {
        if (value !== "10") throw new Refusal("initial cap must be the authorized 10");
        initialCap = 10;
      } else if (key === "--initial-cap-authority") initialAuthority = value;
      else if (key === "--cap-usd") {
        if (!["10", "20"].includes(value)) throw new Refusal("cap must be an authorized stage, 10 or 20");
        cap = Number(value);
      } else decision = value;
    } else throw new Refusal("unknown option");
  }
  const hasInitial = initialCap !== undefined || initialAuthority !== undefined;
  initialBudget(initialCap, initialAuthority);
  if (hasInitial && (command !== "run" || cap || decision))
    throw new Refusal("initial cap applies only to a fresh run, without a staged increase");
  if ((command !== "run" && (confirmed || sha || cap || decision)) || (command !== "score" && check))
    throw new Refusal("option does not apply to this command");
  if (command === "run" && !confirmed) throw new Refusal("--confirm-credit is required before a live run");
  return exclusive(dir, async () => {
    const file = join(dir, "state.json");
    if (existsSync(file) && hasInitial) throw new Refusal("initial cap cannot change on resume");
    const state = existsSync(file)
      ? validateState(JSON.parse(readFileSync(file, "utf8")))
      : command === "run"
        ? createState(sha, process.env.MULTISTEP_URL ?? "", initialCap, initialAuthority)
        : null;
    if (!state) throw new Refusal("no recorded experiment");
    if (sha && sha !== state.deployedSha) throw new Refusal("deployment cannot change during an experiment");
    if (command === "score") {
      const output = render(state);
      if (check) {
        if (scoreExperiment(state).unknown) throw new Refusal("experiment remains incomplete");
        try {
          verifyPublished(state, output, readFileSync(resolve(check), "utf8"));
        } catch {
          throw new Refusal("published log differs or required configuration/diagnostics are missing");
        }
        console.log("multi-step measurement verified");
      } else process.stdout.write(`${output}\n${renderSupplement(state)}`);
      return 0;
    }
    if (cap || decision) raiseCap(state, cap, decision, new Date());
    atomicState(file, state);
    const persisted = validateState(JSON.parse(readFileSync(file, "utf8")));
    if (JSON.stringify(persisted) !== JSON.stringify(state))
      throw new Refusal("state readback differs before execution");
    const d: Deps = {
      budget: localBudget("eval-frontier"),
      readLedger: ledgerRow,
      save: (value) => atomicState(file, value),
      preflight: () => preflight(state, process.env.MULTISTEP_URL ?? ""),
      perform: (ordinal, id, allowance) => childWalk(dir, ordinal, id, allowance, process.env.MULTISTEP_URL ?? ""),
      now: Date.now,
      random: Math.random,
    };
    if (command === "reconcile")
      await exclusive(
        dir,
        async () => {
          for (const slot of state.slots) {
            const path = join(dir, `${slot.reservationId}.child.json`);
            if (slot.status === "pending" && existsSync(path)) {
              slot.report = readChildReport(path, slot.ordinal, slot.reservationId);
              slot.status = "observed";
              // Preserve capacity policy before any later ordinal, even when the parent died before ingesting this report.
              if (slot.report.capacity.length) {
                state.failures++;
                const provider = Math.max(
                  ...slot.report.capacity.map((c) => (c.retryAfterMs ?? 0) + c.atMs - Date.now()),
                  0,
                );
                state.notBefore = Date.now() + capacityDelay(state.failures, provider, Math.random());
              }
              atomicState(file, state);
            }
          }
          await reconcile(state, d);
        },
        ".walk.lock",
      );
    else while (await runNext(state, d)) {}
    console.log("experiment state saved; use score to inspect measured and unknown outcomes");
    return 0;
  });
}
if (process.argv[1] === import.meta.filename)
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        `multistep: ${error instanceof Refusal ? error.message : "operation failed; preserve state and reconcile before retrying"}`,
      );
      process.exitCode = 2;
    });
