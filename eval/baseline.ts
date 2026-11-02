// The baseline orchestration (D08 T02 §11): one command runs the per-set batches of the rules-only baseline,
// verifies each, and writes a deduplicated coverage manifest. Publication stays explicit per run: this command
// never publishes. A failed batch stops the baseline with its cause; a checkpoint after each batch lets `--resume`
// continue without resubmitting completed batches.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Statement } from "../src/meta/budget-sql.ts";
import { BASELINE_CAPS, BASELINE_SETS } from "./baseline-caps.ts";
import { coverageMetrics, type Rate } from "./metrics.ts";
import { type Api, type Db, type Env, type ResultRow, runEval, verifyRun } from "./run.ts";
import {
  type BaselineManifest,
  type ManifestEntry,
  type Outcome,
  type RunSample,
  SETS,
  selectSamples,
} from "./run-core.ts";

export type BaselineBatch = { set: string; runId: string | null; status: string };

export type BaselineCheckpoint = {
  id: string;
  sets: string[];
  setVersions: Record<string, string>;
  deployment: string;
  batches: { set: string; runId: string; samples: string[] }[];
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
  // True when the caller named the sets explicitly. On resume an explicit selection must match the checkpoint;
  // without one the checkpoint's selection runs again, never the defaults.
  setsExplicit: boolean;
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

export type BaselineReport = {
  id: string;
  expected: number;
  measured: number;
  unmeasured: string[];
  pooled: number;
  detection: Rate;
  falsePositives: Rate;
  challenge: { detection: Rate } | null;
};

// The section's report (D08 T02 §11): read a manifest back, validate its population and set versions against the
// current selection, and score it. Labels come from the current sets, so changed bytes or labels refuse instead of
// silently rescoring history.
export async function readCoverageReport(
  manifestDir: string,
  id: string,
  select: (set: string) => { samples: RunSample[]; setVersion: string },
): Promise<{ report: BaselineReport } | { error: string }> {
  let raw: string;
  try {
    raw = readFileSync(join(manifestDir, `${id}.coverage.json`), "utf8");
  } catch {
    return { error: `no coverage manifest for baseline ${id}` };
  }
  const manifest = JSON.parse(raw) as BaselineManifest;
  const samples: RunSample[] = [];
  for (const set of manifest.sets ?? []) {
    const picked = select(set);
    if (picked.setVersion !== manifest.setVersions?.[set])
      return {
        error: `set ${set} changed since the manifest (was ${manifest.setVersions?.[set]}, now ${picked.setVersion})`,
      };
    samples.push(...picked.samples);
  }
  const selected = new Set(samples.map((s) => s.id));
  const expected = new Set(manifest.expected ?? []);
  if (selected.size !== expected.size || ![...expected].every((s) => selected.has(s)))
    return { error: `the manifest population no longer matches the selected samples` };
  const c = coverageMetrics(manifest, samples);
  return {
    report: {
      id: manifest.id,
      expected: c.expected,
      measured: c.measured,
      unmeasured: c.unmeasured,
      pooled: c.pooled,
      detection: c.main.detection,
      falsePositives: c.main.falsePositives,
      challenge: c.challenge ? { detection: c.challenge.detection } : null,
    },
  };
}

export function parseBaselineArgs(
  argv: readonly string[],
): { sets: string[]; setsExplicit: boolean; resume: string | null; report: string | null } | { error: string } {
  const sets: string[] = [];
  let resume: string | null = null;
  let report: string | null = null;
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
    } else if (a === "--report") {
      const v = argv[++i];
      if (!v) return { error: "--report needs a baseline id" };
      report = v;
    } else return { error: `unknown option ${a}` };
  }
  return { sets: sets.length ? sets : [...BASELINE_SETS], setsExplicit: sets.length > 0, resume, report };
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
export async function pooledEntry(
  db: BaselineDb,
  batch: { set: string; batchRunId: string; deployment: string; setVersion: string },
  r: ResultRow,
): Promise<ManifestEntry> {
  const direct: ManifestEntry = {
    sample: r.sample,
    set: batch.set,
    runId: batch.batchRunId,
    deployment: batch.deployment,
    outcome: r.outcome,
    verdict: r.verdict,
    ms: r.ms,
    costUsd: r.costUsd,
  };
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
  // The repeated case decides when it names one; otherwise the latest measured source wins, whatever order the
  // database returned. Null finish times sort last: an unfinished row is never evidence.
  const byFinished = [...verified].sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  const match = byFinished.find((s) => r.caseId !== null && s.caseId === r.caseId) ?? byFinished[0] ?? null;
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
  const id = clients.resume ?? env.id();
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
  const sameSelection = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
  // Without an explicit selection the checkpoint's selection runs again; a conflicting one refuses before spending.
  const runSets =
    clients.resume && checkpoint && !clients.setsExplicit
      ? checkpoint.sets
      : clients.resume && checkpoint && !sameSelection(sets, checkpoint.sets)
        ? null
        : sets;
  if (runSets === null)
    return {
      ...fail("refused"),
      problems: [
        ...problems,
        `resume keeps the checkpoint selection (${checkpoint?.sets.join(",")}); requested ${sets.join(",")} does not match it`,
      ],
    };
  if (!runSets.length) return { ...fail("refused"), problems: [...problems, "no sets selected"] };
  const done = new Map((checkpoint?.batches ?? []).map((b) => [b.set, b]));
  const setVersions: Record<string, string> = { ...(checkpoint?.setVersions ?? {}) };
  let deployment = checkpoint?.deployment ?? null;
  const expected: string[] = [];
  const entries: ManifestEntry[] = [];
  const checkpointSamples = new Map<string, string[]>();
  for (const set of runSets) {
    const prior = done.get(set);
    if (prior) {
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
      const stored = await db.readRun(prior.runId).catch(() => null);
      if (!stored) {
        problems.push(`checkpoint batch for ${set} is gone; rerun the baseline without --resume`);
        return { id, status: "incomplete", batches, manifest: null, problems };
      }
      // A resumed batch goes through the same verified pooling path as a fresh one: its verdicts and provenance
      // survive, and the expected population is the checkpoint's selection, not whatever rows happen to be stored.
      const reverified = await verifyRun(db, prior.runId).catch(() => ({
        ok: false as const,
        problems: ["unreadable"],
      }));
      if (!reverified.ok) {
        problems.push(
          `checkpoint batch for ${set} run ${prior.runId} no longer verifies; rerun the baseline without --resume`,
        );
        return { id, status: "incomplete", batches, manifest: null, problems };
      }
      expected.push(...prior.samples);
      checkpointSamples.set(set, [...prior.samples]);
      for (const r of stored.results)
        entries.push(
          await pooledEntry(
            db,
            { set, batchRunId: prior.runId, deployment: stored.run.commitSha, setVersion: again.setVersion },
            r,
          ),
        );
      batches.push({ set, runId: prior.runId, status: stored.run.status });
      continue;
    }
    const picked = select(set);
    if (!picked.samples.length) {
      problems.push(`set ${set} selected no samples`);
      return { id, status: "incomplete", batches, manifest: null, problems };
    }
    setVersions[set] = picked.setVersion;
    expected.push(...picked.samples.map((s) => s.id));
    checkpointSamples.set(
      set,
      picked.samples.map((s) => s.id),
    );
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
      const neverStarted = batch.runId === null && batches.length === 0;
      batches.push({ set, runId: batch.runId, status: batch.status });
      return { id, status: neverStarted ? "refused" : "incomplete", batches, manifest: null, problems };
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
    const stored = await db.readRun(batch.runId).catch(() => null);
    if (!stored) {
      problems.push(`batch ${set} run ${batch.runId} cannot be read back`);
      return { id, status: "incomplete", batches, manifest: null, problems };
    }
    // The stored run is the identity that counts, not the pre-batch read: a deployment change between the two
    // refuses the batch before its results are checkpointed or pooled, naming both deployments.
    if (stored.run.commitSha !== deployment) {
      problems.push(
        `batch ${set} ran on ${stored.run.commitSha}, not ${deployment} of this baseline: a baseline is measured on one deployment`,
      );
      batches[batches.length - 1] = { set, runId: batch.runId, status: stored.run.status };
      return { id, status: "incomplete", batches, manifest: null, problems };
    }
    // A failed row fails the batch, even beside measured ones: later batches would only spend on top of an
    // unreliable measurement, so the baseline stops with the runner's cause. Stale repeats pool below instead, and
    // a batch with nothing failed, nothing measured and nothing poolable stops the same way.
    const FAILED_OUTCOMES = new Set(["refused", "capped", "timeout", "lost"]);
    const failedRows = stored.results.filter((r) => FAILED_OUTCOMES.has(r.outcome));
    const batchMeasured = stored.results.filter((r) => measured(r.outcome, r.verdict));
    const batchPoolable = stored.results.filter((r) => r.outcome === "stale-repeat");
    if (failedRows.length || (batchMeasured.length === 0 && batchPoolable.length === 0)) {
      const cause = failedRows.length
        ? `failed rows ${failedRows.map((r) => `${r.sample} ${r.outcome}`).join(", ")}`
        : "measured nothing";
      problems.push(
        `batch ${set} run ${batch.runId} stopped on ${cause}: ${batch.problems.join("; ") || batch.status}`,
      );
      batches[batches.length - 1] = { set, runId: batch.runId, status: stored.run.status };
      return { id, status: "incomplete", batches, manifest: null, problems };
    }
    // The checkpoint lands before the next batch spends: an interruption resumes here, never resubmits.
    try {
      writeJson(manifestDir, `${id}.checkpoint.json`, {
        id,
        sets: runSets,
        setVersions,
        deployment,
        batches: batches.flatMap((b) =>
          b.runId === null ? [] : [{ set: b.set, runId: b.runId, samples: checkpointSamples.get(b.set) ?? [] }],
        ),
      } satisfies BaselineCheckpoint);
    } catch (error) {
      problems.push(`the checkpoint write failed: ${error instanceof Error ? error.message : String(error)}`);
      return { id, status: "incomplete", batches, manifest: null, problems };
    }
    for (const r of stored.results)
      entries.push(
        await pooledEntry(
          db,
          { set, batchRunId: batch.runId, deployment: stored.run.commitSha, setVersion: picked.setVersion },
          r,
        ),
      );
  }
  const seen = new Map(entries.map((e) => [e.sample, e]));
  const unmeasured = expected.filter((sample) => {
    const e = seen.get(sample);
    return !e || !measured(e.outcome, e.verdict);
  });
  const manifest: BaselineManifest = {
    id,
    sets: runSets,
    setVersions,
    deployment: deployment as string,
    caps: Object.fromEntries(runSets.map((set) => [set, caps[set] as number])) as Record<string, number>,
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
  // Status follows coverage: a pooled batch stays "incomplete" as a run while measuring every sample through its
  // sources, and repeated batches with failures are unmeasured already.
  const incomplete = unmeasured.length > 0;
  if (incomplete)
    problems.push(`coverage is incomplete: ${unmeasured.length} of ${expected.length} samples unmeasured`);
  return { id, status: incomplete ? "incomplete" : "complete", batches, manifest: path, problems };
}

// ---- the command ------------------------------------------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, "..");

export const USAGE = [
  "usage: pnpm eval:baseline [--sets <a,b>] [--resume <baseline id>]",
  "       pnpm eval:baseline --report <baseline id>   (validated pooled report, no uploads)",
  `sets: synthetic-sa, nazario-2025, synthetic-challenge (all by default). Caps: ${BASELINE_SETS.map((s) => `${s} US$${BASELINE_CAPS[s].toFixed(2)}`).join(", ")}. Needs EVAL_SESSION_COOKIE; exit 0 complete, 2 incomplete, 3 refused.`,
].join("\n");

const fmtRate = (rate: number | null) => (rate === null ? "n/a" : rate.toFixed(3));

const printReport = (r: BaselineReport): string[] => [
  `eval:baseline: report ${r.id} expected ${r.expected} measured ${r.measured} unmeasured ${r.unmeasured.length} pooled ${r.pooled}`,
  `eval:baseline: detection ${r.detection.hits}/${r.detection.n} (${fmtRate(r.detection.rate)}) false-positives ${r.falsePositives.hits}/${r.falsePositives.n} (${fmtRate(r.falsePositives.rate)})`,
  ...(r.challenge
    ? [
        `eval:baseline: challenge detection ${r.challenge.detection.hits}/${r.challenge.detection.n} (${fmtRate(r.challenge.detection.rate)})`,
      ]
    : []),
];

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
  // Reporting reads the committed manifest and never touches the deployment: no session, no uploads.
  if (parsed.report) {
    const manifestDir = live?.manifestDir ?? join(ROOT, "eval/coverage");
    const select = live?.select ?? ((set: string) => selectSamples(join(ROOT, "eval/sets"), [set]));
    const read = await readCoverageReport(manifestDir, parsed.report, select);
    if ("error" in read) {
      console.error(`eval:baseline: ${read.error}`);
      return 3;
    }
    for (const line of printReport(read.report)) console.log(line);
    return 0;
  }
  let clients: BaselineClients;
  if (live) {
    clients = {
      sets: parsed.sets,
      setsExplicit: parsed.setsExplicit,
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
      setsExplicit: parsed.setsExplicit,
      caps,
      api: liveApi(environment.EVAL_BASE_URL ?? "https://app.isitlegit.co.za", cookie),
      db: { ...db, findSampleRuns },
      env: {
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        id: () => randomUUID(),
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
    `eval:baseline: ${out.status} baseline ${out.id}${out.manifest ? ` manifest ${out.manifest}` : ""}${batches ? `; ${batches}` : ""}`,
  );
  if (out.manifest) {
    const read = await readCoverageReport(clients.manifestDir, out.id, clients.select);
    if ("error" in read) {
      console.error(`eval:baseline: the manifest does not read back: ${read.error}`);
      return 2;
    }
    for (const line of printReport(read.report)) console.log(line);
  }
  if (out.status !== "complete" && (clients.resume || out.batches.some((b) => b.runId !== null)))
    console.log(`eval:baseline: resume with pnpm eval:baseline --resume ${out.id}`);
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
