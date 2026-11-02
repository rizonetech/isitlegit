// The baseline orchestration (D08 T02 §11): one command runs the per-set batches of the rules-only baseline,
// verifies each, and writes a deduplicated coverage manifest. Publication stays explicit per run: this command
// never publishes. A failed batch stops the baseline with its cause; a checkpoint after each batch lets `--resume`
// continue without resubmitting completed batches.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Statement } from "../src/meta/budget-sql.ts";
import { BASELINE_CAPS, BASELINE_SETS } from "./baseline-caps.ts";
import { type Api, type Db, type Env, type ResultRow, runEval, verifyRun } from "./run.ts";
import { type BaselineManifest, type ManifestEntry, type Outcome, type RunSample, SETS } from "./run-core.ts";

export type BaselineBatch = { set: string; runId: string | null; status: string };

export type BaselineCheckpoint = {
  id: string;
  sets: string[];
  setVersions: Record<string, string>;
  deployment: string;
  batches: { set: string; runId: string }[];
};

// An earlier run's stored result for one sample: what a stale repeat may pool from.
export type SampleSource = {
  runId: string;
  deployment: string;
  setVersion: string;
  mode: string;
  status: string;
  finishedAt: string | null;
  outcome: Outcome;
  verdict: string | null;
  caseId: string | null;
  ms: number | null;
  costUsd: number;
};

export type BaselineDb = Db & {
  findSampleRuns(sample: string): Promise<SampleSource[]>;
};

export type BaselineResult = {
  id: string;
  status: "complete" | "incomplete" | "refused";
  batches: BaselineBatch[];
  manifest: string | null;
  problems: string[];
};

export type BaselineClients = {
  sets: string[];
  caps: Record<string, number>;
  api: Api;
  db: BaselineDb;
  env: Env;
  manifestDir: string;
  select: (set: string) => { samples: RunSample[]; setVersion: string };
  resume?: string | null;
};

// A measured row: the case ended with a verdict read back. Anything else is coverage still owed.
const measured = (outcome: string, verdict: string | null) =>
  (outcome === "done" || outcome === "partial") && verdict !== null;

// Atomic temp-then-rename, like the results summary: a crash never half-writes the checkpoint or the manifest.
function writeJson(dir: string, name: string, value: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const tmp = `${path}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(tmp, path);
  return path;
}

export function parseBaselineArgs(
  argv: readonly string[],
): { sets: string[]; resume: string | null } | { error: string } {
  const sets: string[] = [];
  let resume: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--sets") {
      const v = argv[++i];
      if (!v) return { error: "--sets needs at least one set" };
      for (const name of v.split(",")) {
        if (!(SETS as readonly string[]).includes(name)) return { error: `unknown set ${JSON.stringify(name)}` };
        if (!sets.includes(name)) sets.push(name);
      }
    } else if (a === "--resume") {
      const v = argv[++i];
      if (!v) return { error: "--resume needs a baseline id" };
      resume = v;
    } else return { error: `unknown option ${a}` };
  }
  return { sets: sets.length ? sets : [...BASELINE_SETS], resume };
}

function readCheckpoint(dir: string, id: string): BaselineCheckpoint | null {
  try {
    return JSON.parse(readFileSync(join(dir, `${id}.checkpoint.json`), "utf8")) as BaselineCheckpoint;
  } catch {
    return null;
  }
}

// Only a stale repeat pools, and only from a verified run on the same deployment, set version and mode whose
// stored result for the sample is measured. A missing source, a mismatch or a null verdict stays unmeasured and
// never counts: the entry keeps the stale outcome with no verdict and no pooled run.
const entryOf = (batch: { set: string; batchRunId: string; deployment: string }, r: ResultRow): ManifestEntry => ({
  sample: r.sample,
  set: batch.set,
  runId: batch.batchRunId,
  deployment: batch.deployment,
  outcome: r.outcome,
  verdict: r.verdict,
  ms: r.ms,
  costUsd: r.costUsd,
});

export async function pooledEntry(
  db: BaselineDb,
  batch: { set: string; batchRunId: string; deployment: string; setVersion: string },
  r: ResultRow,
): Promise<ManifestEntry> {
  const direct = entryOf(batch, r);
  if (r.outcome !== "stale-repeat") return direct;
  const sources = await db.findSampleRuns(r.sample).catch(() => [] as SampleSource[]);
  const qualifying = sources.filter(
    (s) =>
      s.runId !== batch.batchRunId &&
      s.deployment === batch.deployment &&
      s.setVersion === batch.setVersion &&
      s.mode === "full" &&
      (s.outcome === "done" || s.outcome === "partial") &&
      s.verdict !== null,
  );
  const verified: SampleSource[] = [];
  for (const s of qualifying) {
    const check = await verifyRun(db, s.runId).catch(() => ({ ok: false as const, problems: ["unreadable"] }));
    if (check.ok) verified.push(s);
  }
  // The repeated case decides when it names one; otherwise the latest measured source wins.
  const match = verified.find((s) => r.caseId !== null && s.caseId === r.caseId) ?? verified.at(-1) ?? null;
  if (!match) return direct;
  return {
    sample: r.sample,
    set: batch.set,
    runId: batch.batchRunId,
    deployment: match.deployment,
    outcome: match.outcome,
    verdict: match.verdict,
    ms: match.ms,
    costUsd: match.costUsd,
    pooledFrom: match.runId,
  };
}

export async function runBaseline(clients: BaselineClients): Promise<BaselineResult> {
  const { sets, caps, api, db, env, manifestDir, select } = clients;
  const id = clients.resume ?? `${Date.now()}`;
  const batches: BaselineBatch[] = [];
  const problems: string[] = [];
  const fail = (status: BaselineResult["status"]): BaselineResult => ({
    id,
    status,
    batches,
    manifest: null,
    problems,
  });
  for (const set of sets) {
    if (!(SETS as readonly string[]).includes(set))
      return { ...fail("refused"), problems: [...problems, `unknown set ${JSON.stringify(set)}`] };
    const cap = caps[set];
    if (cap === undefined || !Number.isFinite(cap))
      return { ...fail("refused"), problems: [...problems, `no stated cap for set ${JSON.stringify(set)}`] };
  }
  // A resume continues the checkpoint's batches; anything else restarts the baseline whole.
  const checkpoint = clients.resume ? readCheckpoint(manifestDir, clients.resume) : null;
  if (clients.resume && !checkpoint)
    return { ...fail("refused"), problems: [...problems, `no checkpoint for baseline ${clients.resume}`] };
  const done = new Map((checkpoint?.batches ?? []).map((b) => [b.set, b.runId]));
  const setVersions: Record<string, string> = { ...(checkpoint?.setVersions ?? {}) };
  let deployment = checkpoint?.deployment ?? null;
  const expected: string[] = [];
  const entries: ManifestEntry[] = [];
  for (const set of sets) {
    if (done.has(set)) {
      // A resume remeasures nothing, but it rechecks the population: a set whose bytes or labels changed since the
      // checkpoint is a different population and refuses, naming the set and both versions.
      const again = select(set);
      if (again.setVersion !== checkpoint?.setVersions[set])
        return {
          ...fail("refused"),
          problems: [
            ...problems,
            `set ${set} changed since the checkpoint (was ${checkpoint?.setVersions[set]}, now ${again.setVersion}): reselect, do not resume`,
          ],
        };
      const stored = await db.readRun(done.get(set) as string).catch(() => null);
      if (!stored) {
        problems.push(`checkpoint batch for ${set} is gone; rerun the baseline without --resume`);
        return { id, status: "incomplete", batches, manifest: null, problems };
      }
      for (const r of stored.results) {
        expected.push(r.sample);
        entries.push(entryOf({ set, batchRunId: stored.run.id, deployment: stored.run.commitSha }, r));
      }
      batches.push({ set, runId: stored.run.id, status: stored.run.status });
      continue;
    }
    const picked = select(set);
    if (!picked.samples.length) {
      problems.push(`set ${set} selected no samples`);
      return { id, status: "incomplete", batches, manifest: null, problems };
    }
    setVersions[set] = picked.setVersion;
    expected.push(...picked.samples.map((s) => s.id));
    const commit = await api.commit().catch(() => null);
    if (commit === null) {
      problems.push(`could not read the deployment before batch ${set}`);
      return { id, status: "incomplete", batches, manifest: null, problems };
    }
    if (deployment === null) deployment = commit;
    if (commit !== deployment) {
      problems.push(
        `the deployment is ${commit}, not ${deployment} of this baseline: a baseline is measured on one deployment`,
      );
      return { id, status: "incomplete", batches, manifest: null, problems };
    }
    const cap = caps[set] as number;
    const batch = await runEval({
      samples: picked.samples,
      setVersion: picked.setVersion,
      sets: [set],
      sampleLimit: null,
      options: { capUsd: cap, dry: false },
      api,
      db,
      env,
    });
    if (batch.runId === null || batch.status === "refused" || batch.exit === 1) {
      problems.push(
        `batch ${set} ${batch.runId === null ? "never started" : `run ${batch.runId} ${batch.status}`}: ${batch.problems.join("; ") || "aborted"}`,
      );
      batches.push({ set, runId: batch.runId, status: batch.status });
      return {
        id,
        status: batch.runId === null && batches.length === 0 ? "refused" : "incomplete",
        batches,
        manifest: null,
        problems,
      };
    }
    batches.push({ set, runId: batch.runId, status: batch.status });
    const verified = await verifyRun(db, batch.runId).catch((error: unknown) => ({
      ok: false as const,
      problems: [`the verify read failed: ${error instanceof Error ? error.message : String(error)}`],
    }));
    if (!verified.ok) {
      problems.push(`batch ${set} run ${batch.runId} did not verify: ${verified.problems.join("; ")}`);
      return { id, status: "incomplete", batches, manifest: null, problems };
    }
    // The checkpoint lands before the next batch spends: an interruption resumes here, never resubmits.
    try {
      writeJson(manifestDir, `${id}.checkpoint.json`, {
        id,
        sets,
        setVersions,
        deployment,
        batches: batches.flatMap((b) => (b.runId === null ? [] : [{ set: b.set, runId: b.runId }])),
      } satisfies BaselineCheckpoint);
    } catch (error) {
      problems.push(`the checkpoint write failed: ${error instanceof Error ? error.message : String(error)}`);
      return { id, status: "incomplete", batches, manifest: null, problems };
    }
    const stored = await db.readRun(batch.runId).catch(() => null);
    for (const r of stored?.results ?? [])
      entries.push(
        await pooledEntry(db, { set, batchRunId: batch.runId, deployment, setVersion: picked.setVersion }, r),
      );
  }
  const seen = new Map(entries.map((e) => [e.sample, e]));
  const unmeasured = expected.filter((sample) => {
    const e = seen.get(sample);
    return !e || !measured(e.outcome, e.verdict);
  });
  const manifest: BaselineManifest = {
    id,
    sets,
    setVersions,
    deployment: deployment as string,
    caps: Object.fromEntries(sets.map((set) => [set, caps[set] as number])) as Record<string, number>,
    expected,
    entries,
    unmeasured,
  };
  let path: string;
  try {
    path = writeJson(manifestDir, `${id}.coverage.json`, manifest);
  } catch (error) {
    problems.push(`the manifest write failed: ${error instanceof Error ? error.message : String(error)}`);
    return { id, status: "incomplete", batches, manifest: null, problems };
  }
  const incomplete = batches.some((b) => b.status !== "complete") || unmeasured.length > 0;
  if (incomplete)
    problems.push(`coverage is incomplete: ${unmeasured.length} of ${expected.length} samples unmeasured`);
  return { id, status: incomplete ? "incomplete" : "complete", batches, manifest: path, problems };
}

// ---- the command ------------------------------------------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, "..");

export const USAGE = [
  "usage: pnpm eval:baseline [--sets <a,b>] [--resume <baseline id>]",
  `sets: synthetic-sa, nazario-2025, synthetic-challenge (all by default). Caps: ${BASELINE_SETS.map((s) => `${s} US$${BASELINE_CAPS[s].toFixed(2)}`).join(", ")}. Needs EVAL_SESSION_COOKIE; exit 0 complete, 2 incomplete, 3 refused.`,
].join("\n");

export type BaselineLive = {
  api: Api;
  db: BaselineDb;
  env: Env;
  manifestDir: string;
  select: (set: string) => { samples: RunSample[]; setVersion: string };
};

export async function main(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  live?: BaselineLive,
): Promise<number> {
  const parsed = parseBaselineArgs(argv);
  if ("error" in parsed) {
    console.error(`eval:baseline: ${parsed.error}\n${USAGE}`);
    return 3;
  }
  const caps: Record<string, number> = {};
  for (const set of parsed.sets) caps[set] = BASELINE_CAPS[set as keyof typeof BASELINE_CAPS];
  let clients: BaselineClients;
  if (live) {
    clients = {
      sets: parsed.sets,
      caps,
      api: live.api,
      db: live.db,
      env: live.env,
      manifestDir: live.manifestDir,
      select: live.select,
      ...(parsed.resume ? { resume: parsed.resume } : {}),
    };
  } else {
    const { execute } = await import("../scripts/lib/meta-budget.ts");
    const { liveApi, liveDb } = await import("./run.ts");
    const { inlineLong } = await import("../src/meta/budget-sql.ts");
    const { selectSamples } = await import("./run-core.ts");
    const exec = (s: Statement) => execute({ sql: inlineLong(s), params: [] });
    const db = liveDb(environment.EVAL_ORG_NAME ?? "IsItLegit Eval", exec);
    const findSampleRuns = async (sample: string): Promise<SampleSource[]> => {
      const rows = (
        await exec({
          sql: `SELECT u.id AS runId, u.commit_sha AS deployment, u.set_version AS setVersion, u.mode AS mode, u.status AS status, u.finished_at AS finishedAt, r.outcome AS outcome, r.verdict AS verdict, r.case_id AS caseId, r.ms AS ms, r.cost_usd AS costUsd FROM eval_results r JOIN eval_runs u ON u.id = r.run_id WHERE r.sample = ?1 ORDER BY u.finished_at DESC`,
          params: [sample],
        })
      ).results as Record<string, string | number | null>[] | undefined;
      return (rows ?? []).map((r) => ({
        runId: String(r.runId),
        deployment: String(r.deployment),
        setVersion: String(r.setVersion),
        mode: String(r.mode),
        status: String(r.status),
        finishedAt: r.finishedAt === null ? null : String(r.finishedAt),
        outcome: r.outcome as Outcome,
        verdict: r.verdict === null ? null : String(r.verdict),
        caseId: r.caseId === null ? null : String(r.caseId),
        ms: r.ms === null ? null : Number(r.ms),
        costUsd: Number(r.costUsd),
      }));
    };
    const cookie = environment.EVAL_SESSION_COOKIE;
    if (!cookie) {
      console.error(
        "eval:baseline: EVAL_SESSION_COOKIE is not set (the eval session lives in the vault item IsItLegit eval session)",
      );
      return 3;
    }
    const setsRoot = join(ROOT, "eval/sets");
    clients = {
      sets: parsed.sets,
      caps,
      api: liveApi(environment.EVAL_BASE_URL ?? "https://app.isitlegit.co.za", cookie),
      db: { ...db, findSampleRuns },
      env: {
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        id: () => `${Date.now()}`,
        journalDir: join(ROOT, "build/eval-runs"),
        bytes: (file) => readFileSync(file),
        log: (line) => console.log(line),
        timeout: (ms, work) =>
          Promise.race([
            work(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
          ]),
        ticker: (ms, fn) => {
          const timer = setInterval(fn, ms);
          timer.unref();
          return () => clearInterval(timer);
        },
      },
      manifestDir: join(ROOT, "eval/coverage"),
      select: (set: string) => selectSamples(setsRoot, [set]),
      ...(parsed.resume ? { resume: parsed.resume } : {}),
    };
  }
  const out = await runBaseline(clients);
  for (const p of out.problems) console.error(`eval:baseline: ${p}`);
  const batches = out.batches.map((b) => `${b.set}=${b.runId ?? "none"}(${b.status})`).join(" ");
  console.log(
    `eval:baseline: ${out.status}${out.manifest ? ` manifest ${out.manifest}` : ""}${batches ? `; ${batches}` : ""}`,
  );
  return out.status === "complete" ? 0 : out.status === "incomplete" ? 2 : 3;
}

if (process.argv[1] && import.meta.filename === process.argv[1])
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`eval:baseline: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exit(1);
    },
  );
