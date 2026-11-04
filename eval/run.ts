// The evaluation runner (D08 T02 §1): `pnpm eval:run`. It uploads each selected sample to the deployed upload API as the
// eval organisation (the session cookie is read from EVAL_SESSION_COOKIE, never from argv), waits for each case to end,
// and stores one row per sample in `eval_results` under an `eval_runs` row. The API and the database are injected
// (`Api`, `Db`), so the rules below are tested on distinct injected answers; the live clients are at the foot of the file.
//
// A sample ends `done` or `partial` (a result with the verdict it has, null when none), `refused` (the upload was
// refused), `capped` (429), `timeout` (5 minutes), `stale-repeat` (the upload answered a case from before this run, so
// it measures nothing new) or `lost` (no result: never sent, or its case could not be read). A run is `complete` only
// when every selected sample ended `done` or `partial`; otherwise `incomplete`, and `aborted` when the session was
// refused or the database could not be written. Every case id is journaled the moment the upload answers, so
// `--resume` polls stored cases without uploading again. A repeat of the same file (same bytes, name and type) within
// a SAST day answers the first case: one this run opened is the recovery of a lost response, one from before it is
// `stale-repeat`.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dailyCapSql } from "../src/auth/plan-sql.ts";
import { MEMBER_CASES_TODAY, sastDayStart } from "../src/db/cap-rule.ts";
import { inlineLong, type Statement, spentStatement } from "../src/meta/budget-sql.ts";
import { refusingCap } from "../src/meta/caps.ts";
import { sastDay } from "../src/meta/day.ts";
import { CaseExperiment, ExperimentInput, isAblateFlag, requireCapabilities, sameExperiment } from "./ablate.ts";

import {
  EXIT,
  exitCode,
  isTerminal,
  type Options,
  type Outcome,
  parseArgs,
  perSampleEstimate,
  preflightProblems,
  type RunSample,
  type RunStatus,
  recoveryHint,
  runStatus,
  selectSamples,
  USAGE,
} from "./run-core.ts";

export const CONCURRENCY = 4;
export const POLL_MS = 3_000;
export const CASE_TIMEOUT_MS = 5 * 60_000;
export const UPLOAD_TIMEOUT_MS = 120_000;
export const DB_TIMEOUT_MS = 60_000;
export const UPLOAD_RETRIES = 3;
export const POLL_ERRORS = 5;
export const WRITE_RETRIES = 3;
export const SHARED_RECHECK_MS = 10_000;
export const PROGRESS_MS = 5_000;

export type Verdict = "safe" | "suspicious" | "malicious";
export type CaseState = {
  status: "received" | "running" | "done" | "partial";
  verdict: Verdict | null;
  // Settled spend, else the reserved estimate, of every model call the case made (`model_spend`, the shared ledger).
  costUsd: number;
  critical: boolean;
  // Reputation providers that listed this case (D08 T02 section 8); empty means not recorded, never clean.
  providers?: { provider: string; checked: boolean; listed: boolean }[];
  walkthrough?: boolean | null;
  createdAt: string;
  updatedAt: string;
};
export type Attribution = { context: CaseExperiment; uploadKey: string; active: boolean; rawMissing: boolean };
export type ModelUse = {
  model: string;
  step: string | null;
  outcome: string | null;
  state: string;
  cache: string | null;
};
export type UploadAnswer = { status: number; caseId?: string; repeat?: boolean; experiment?: unknown };
export type Api = {
  commit(): Promise<string>;
  // The replay identity is the replay run's own id (D08 T02 section 12): never the source run's, so a second
  // remeasurement of one source opens its own cases instead of reusing the first replay's claims.
  upload(
    sample: RunSample,
    bytes: Uint8Array,
    opts: { mode: string; replayRunId: string | null; experiment?: ExperimentInput },
  ): Promise<UploadAnswer>;
  // The signed-in user the session belongs to, null when it is not signed in.
  whoami(): Promise<string | null>;
  capabilities?(): Promise<unknown>;
};
export type RunRow = {
  id: string;
  commitSha: string;
  setVersion: string;
  mode: string;
  sets: string[];
  sampleLimit: number | null;
  status: "running" | RunStatus;
  selected: number;
  capUsd: number;
  startedAt: string;
  finishedAt: string | null;
  costUsd: number;
};
export type ResultRow = {
  runId: string;
  sample: string;
  caseId: string | null;
  outcome: Outcome;
  label: "attack" | "genuine";
  category: string;
  verdict: Verdict | null;
  ms: number | null;
  costUsd: number;
  criticalFound: boolean;
  providers?: { provider: string; checked: boolean; listed: boolean }[] | undefined;
  walkthrough?: boolean | null | undefined;
  httpStatus: number | null;
  detail: string | null;
};
export type Db = {
  orgId(): Promise<string>;
  memberships(userId: string): Promise<string[]>;
  allowance(): Promise<{ used: number; limit: number }>;
  spent(day: string): Promise<{ daySpentUsd: number; totalSpentUsd: number }>;
  lastCostPerCase(): Promise<number | null>;
  caseState(caseId: string): Promise<CaseState | null>;
  caseExperiment?(caseId: string): Promise<Attribution | null>;
  modelUse?(caseId: string): Promise<ModelUse[]>;
  insertRun(run: RunRow): Promise<void>;
  putResult(row: ResultRow): Promise<void>;
  finishRun(id: string, status: RunStatus, costUsd: number, finishedAt: string): Promise<void>;
  readRun(id: string): Promise<{ run: RunRow; results: ResultRow[] } | null>;
};
export type Env = {
  now(): number;
  sleep(ms: number): Promise<void>;
  id(): string;
  journalDir: string;
  bytes(file: string): Uint8Array;
  // One line of operator output (the preflight figures before the first upload, then progress).
  log(line: string): void;
  // Calls `fn` every `ms` until the returned function is called (progress lines must not wait on a result).
  ticker(ms: number, fn: () => void): () => void;
  // Bounds an awaited operation: rejects when it has not settled in `ms`.
  timeout<T>(ms: number, work: () => Promise<T>): Promise<T>;
};

// Rejects when the operation has not settled in `ms` (a stalled request must not outlive its bound).
export function boundedBy<T>(ms: number, work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    work().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class WriteFailed extends Error {
  override name = "WriteFailed";
}
class SessionRefused extends Error {}

// ---- the journal: case ids kept as soon as they are known, written temp-then-replace -----------------------------------

type Journal = { runId: string; startedAt: string; caseIds: Record<string, string> };
const journalFile = (dir: string, id: string) => join(dir, `${id}.json`);
function saveJournal(dir: string, journal: Journal) {
  mkdirSync(dir, { recursive: true });
  const file = journalFile(dir, journal.runId);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(journal, null, 1)}\n`);
  renameSync(tmp, file);
}
function loadJournal(dir: string, id: string): Journal | null {
  const file = journalFile(dir, id);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Journal) : null;
}

async function retried<T>(env: Env, times: number, work: () => Promise<T>, fail: (e: unknown) => Error): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= times; attempt++) {
    try {
      return await work();
    } catch (error) {
      last = error;
      if (attempt < times) await env.sleep(1_000 * 2 ** attempt);
    }
  }
  throw fail(last);
}

export type RunResult = {
  runId: string | null;
  status: RunStatus | "refused";
  exit: number;
  problems: string[];
  results: ResultRow[];
  costUsd: number;
};

const usd = (n: number) => `US$${n.toFixed(4)}`;
// Settled results a resume keeps: a measured case, and a stale repeat (which measured nothing and stays excluded).
const kept = (o: Outcome) => o === "done" || o === "partial" || o === "stale-repeat";

// ---- a run ---------------------------------------------------------------------------------------------------------

export async function runEval(args: {
  samples: RunSample[];
  setVersion: string;
  sets: string[];
  sampleLimit: number | null;
  options: Pick<Options, "capUsd" | "dry">;
  api: Api;
  db: Db;
  env: Env;
  resume?: string | null;
  // An ablation arm name (`ablate:<flag>`), or the full pipeline. The mode is stored on the run row so reports can
  // tell arms apart; a resume keeps the stored mode.
  mode?: string;
  // The source run a replay remeasures (D08 T02 section 12), set only by the --replay path after it has
  // restored and verified the source population. A replay mode named through `mode` is refused: it would
  // carry replay provenance with no validated source behind it.
  replayOf?: string;
  experiment?: CaseExperiment;
}): Promise<RunResult> {
  const { samples, setVersion, options, api, db, env } = args;
  const refused = (problems: string[]): RunResult => ({
    runId: null,
    status: "refused",
    exit: EXIT.refused,
    problems,
    results: [],
    costUsd: 0,
  });
  const faulted = (runId: string | null, problems: string[], results: ResultRow[] = []): RunResult => ({
    runId,
    status: "aborted",
    exit: EXIT.fault,
    problems,
    results,
    costUsd: results.reduce((a, r) => a + r.costUsd, 0),
  });

  // A resumed run keeps its row, its settled results and its journal, and continues on the deployment it began on.
  let existing: ResultRow[] = [];
  const experiment = args.experiment ? CaseExperiment.parse(args.experiment) : undefined;
  let runId = experiment?.replayRunId ?? env.id();
  let startedAt = new Date(env.now()).toISOString();
  let journal: Journal = { runId, startedAt, caseIds: {} };
  const commitNow = args.options.dry && !args.resume ? "dry" : await api.commit();
  let commitSha = commitNow;
  let capUsd = options.capUsd;
  let mode = args.replayOf ? `replay:${args.replayOf}` : (args.mode ?? "full");
  if (mode.startsWith("replay:") && !args.replayOf && !args.resume)
    return refused([
      `a replay is started with --replay <run id>, not --mode ${JSON.stringify(mode)}: the source population must be restored and verified first`,
    ]);
  if (
    mode !== "full" &&
    !(
      mode.startsWith("ablate:") &&
      (isAblateFlag(mode.slice("ablate:".length)) || (mode === "ablate:full" && experiment))
    ) &&
    !(mode.startsWith("replay:") && mode.length > "replay:".length)
  )
    return refused([`unknown run mode ${JSON.stringify(mode)}: "full", "ablate:<flag>" or "replay:<run id>"`]);
  if (experiment) {
    if (args.replayOf || (args.resume && args.resume !== experiment.replayRunId) || mode !== `ablate:${experiment.arm}`)
      return refused(["experiment arm/run/mode conflict"]);
    if (commitNow !== experiment.deployment || !api.capabilities || !db.caseExperiment)
      return refused(["experiment deployment or durable capability reader missing"]);
    try {
      requireCapabilities(await api.capabilities(), experiment.deployment, ["full", experiment.arm]);
    } catch (error) {
      return refused([`experiment capability refusal: ${String(error)}`]);
    }
  } else if (mode.startsWith("ablate:")) return refused(["ablation requires immutable experiment metadata"]);
  if (args.resume) {
    const stored = await db.readRun(args.resume);
    if (!stored) return refused([`no run ${args.resume}`]);
    if (stored.run.status === "complete") return refused([`run ${args.resume} is already complete`]);
    // A resume keeps the switch the run began with: a different flag would measure a different arm.
    if (args.mode !== undefined && args.mode !== stored.run.mode)
      return refused([
        `run ${args.resume} was started with mode ${stored.run.mode}, not ${args.mode}; a resume keeps the switch it began with (drop --mode or repeat that figure)`,
      ]);
    mode = stored.run.mode;
    if (mode.startsWith("ablate:") && !experiment)
      return refused(["ablation resume requires immutable experiment metadata"]);
    if (stored.run.setVersion !== setVersion) return refused(["the selected samples are not those of the run"]);
    if (stored.run.commitSha !== commitNow)
      return refused([
        `the deployment is ${commitNow}, not ${stored.run.commitSha} of run ${args.resume}: a run is measured on one deployment`,
      ]);
    // A resume keeps the spending cap the run was started with: a different one would spend against a limit the record
    // does not hold.
    if (Number.isFinite(options.capUsd) && options.capUsd !== stored.run.capUsd)
      return refused([
        `run ${args.resume} was started with cap ${usd(stored.run.capUsd)}; a resume keeps it (drop --cap-usd or repeat that figure)`,
      ]);
    capUsd = stored.run.capUsd;
    runId = stored.run.id;
    startedAt = stored.run.startedAt;
    commitSha = stored.run.commitSha;
    existing = stored.results;
    journal = loadJournal(env.journalDir, runId) ?? { runId, startedAt, caseIds: {} };
    for (const r of existing) if (r.caseId) journal.caseIds[r.sample] = r.caseId;
  }

  // The session must belong to the eval organisation alone, before anything is sent.
  if (!options.dry) {
    const user = await api.whoami();
    if (!user) return refused(["the session is not signed in"]);
    const [org, member] = await Promise.all([db.orgId(), db.memberships(user)]);
    if (member.length !== 1 || member[0] !== org)
      return refused(["the session does not belong to the eval organisation alone; nothing was sent"]);
  }

  async function attribution(sample: RunSample, caseId: string): Promise<Attribution> {
    const value = await db.caseExperiment?.(caseId);
    if (
      !experiment ||
      !value ||
      !sameExperiment(value.context, experiment) ||
      value.uploadKey !== sampleUploadKey(sample)
    )
      throw new SessionRefused(`experiment attribution mismatch for ${sample.id}`);
    if (!value.active && !value.rawMissing)
      throw new SessionRefused(`unknown inactive experiment binding for ${sample.id}`);
    return value;
  }
  if (experiment) {
    try {
      for (const sample of samples) {
        const caseId = journal.caseIds[sample.id];
        if (!caseId) continue;
        const bound = await attribution(sample, caseId);
        if (!bound.active) {
          // Only the server's definitive RawMissing settlement allows replacement under this same replay identity.
          delete journal.caseIds[sample.id];
          existing = existing.filter((row) => row.sample !== sample.id);
        }
      }
      if (args.resume) saveJournal(env.journalDir, journal);
    } catch (error) {
      return refused([`cannot reconcile experiment: ${String(error)}`]);
    }
  }
  const finished = new Map(existing.filter((r) => kept(r.outcome)).map((r) => [r.sample, r]));
  const todo = samples.filter((s) => !finished.has(s.id));

  // Refused before anything is uploaded: no cap, estimate or allowance may pass.
  const day = sastDay(new Date(env.now()));
  const [spent, last, allowance] = await Promise.all([db.spent(day), db.lastCostPerCase(), db.allowance()]);
  const perSample = perSampleEstimate(last);
  const needUpload = todo.filter((s) => !journal.caseIds[s.id]);
  const estimate = needUpload.length * perSample;
  const problems = preflightProblems({
    selected: todo.length,
    // Only the samples still to be uploaded use the organisation's allowance.
    uploads: needUpload.length,
    // A dry run states no cap: it is judged against its own estimate.
    capUsd: options.dry && !Number.isFinite(capUsd) ? estimate : capUsd,
    perSampleUsd: perSample,
    day,
    daySpentUsd: spent.daySpentUsd,
    totalSpentUsd: spent.totalSpentUsd,
    allowance,
  });
  // A resume with nothing left to measure (every sample settled) only finishes the run.
  if (args.resume && todo.length === 0) problems.length = 0;
  env.log(
    `eval:run: ${todo.length} of ${samples.length} samples to measure (${needUpload.length} to upload), estimate ${usd(estimate)} at ${usd(perSample)} each, cap ${Number.isFinite(capUsd) ? usd(capUsd) : "none stated"}, organisation allowance ${allowance.used} of ${allowance.limit} used today, shared spend today ${usd(spent.daySpentUsd)} (total ${usd(spent.totalSpentUsd)})`,
  );
  if (options.dry)
    return {
      ...refused(problems),
      status: problems.length ? "refused" : "complete",
      exit: problems.length ? EXIT.refused : 0,
    };
  // A resume with cases already opened still reconciles them when new uploads are refused (no headroom, no allowance):
  // only the uploads are blocked, and the run ends incomplete with the reasons.
  const reopenedCount = todo.filter((s) => journal.caseIds[s.id]).length;
  const blocked = problems.length && args.resume && reopenedCount > 0 ? problems : [];
  if (problems.length && !blocked.length) return refused(problems);
  if (blocked.length)
    env.log(`eval:run: new uploads are refused (${blocked.join("; ")}); reconciling ${reopenedCount} opened cases`);

  try {
    if (!args.resume) {
      await retried(
        env,
        WRITE_RETRIES,
        () =>
          db.insertRun({
            id: runId,
            commitSha,
            setVersion,
            mode,
            sets: args.sets,
            sampleLimit: args.sampleLimit,
            status: "running",
            selected: samples.length,
            capUsd: capUsd,
            startedAt,
            finishedAt: null,
            costUsd: 0,
          }),
        (e) => new WriteFailed(`the run could not be recorded: ${String(e)}`),
      );
      saveJournal(env.journalDir, journal);
    }
  } catch (error) {
    return faulted(null, [(error as Error).message]);
  }
  env.log(`eval:run: run ${runId} started on ${commitSha}; resume it with: pnpm eval:run --resume ${runId}`);

  const priorBySample = new Map(existing.map((r) => [r.sample, r]));
  const results = new Map<string, ResultRow>(finished);
  let spentUsd = [...finished.values()].reduce((a, r) => a + r.costUsd, 0);
  let inflight = 0;
  let stop: "capped" | "budget" | "shared" | "preflight" | null = blocked.length ? "preflight" : null;
  let aborted: Error | null = null;
  let sharedOkAt = env.now();
  let sharedCheck: Promise<boolean> | null = null;
  let loggedAt = env.now();
  const started = env.now();

  // A plain-text line at least every five seconds, from any wait: results, polling and retries alike.
  function progress() {
    if (env.now() - loggedAt < PROGRESS_MS) return;
    loggedAt = env.now();
    env.log(
      `eval:run: ${results.size} of ${samples.length} ended, ${inflight} in flight, ${Math.round((env.now() - started) / 1000)} s, spend ${usd(spentUsd)}`,
    );
  }

  const store = (row: ResultRow) =>
    retried(
      env,
      WRITE_RETRIES,
      () => env.timeout(DB_TIMEOUT_MS, () => db.putResult(row)),
      (e) => new WriteFailed(`the result could not be stored: ${String(e)}`),
    ).then(() => {
      results.set(row.sample, row);
      progress();
    });
  const base = (s: RunSample, caseId: string | null) => ({
    runId,
    sample: s.id,
    caseId,
    label: s.label,
    category: s.category,
    verdict: null,
    ms: null,
    costUsd: 0,
    criticalFound: false,
    httpStatus: null,
    detail: null,
  });

  async function poll(s: RunSample, caseId: string, recordedUsd: number): Promise<ResultRow> {
    const startedMs = env.now();
    let errors = 0;
    let seen: CaseState | null = null;
    for (;;) {
      let state: CaseState | null = null;
      try {
        state = await env.timeout(DB_TIMEOUT_MS, () => db.caseState(caseId));
        errors = 0;
        seen = state ?? seen;
      } catch {
        if (++errors >= POLL_ERRORS)
          return {
            ...base(s, caseId),
            outcome: "lost",
            costUsd: seen?.costUsd ?? recordedUsd,
            detail: "its case could not be read",
          };
      }
      if (state && experiment) {
        const bound = await attribution(s, caseId);
        if (!bound.active)
          return {
            ...base(s, null),
            outcome: "lost",
            detail: "definitive RawMissing; resume replaces under the same arm identity",
          };
      }
      if (state && (state.status === "done" || state.status === "partial")) {
        return {
          ...base(s, caseId),
          outcome: state.status,
          verdict: state.verdict,
          // The server's own admission-to-terminal time: a slow poll or a resume cannot change it.
          ms: Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.createdAt)),
          costUsd: state.costUsd,
          criticalFound: state.critical,
          providers: state.providers ?? [],
          walkthrough: state.walkthrough ?? null,
        };
      }
      if (env.now() - startedMs >= CASE_TIMEOUT_MS)
        return {
          ...base(s, caseId),
          outcome: "timeout",
          costUsd: seen?.costUsd ?? recordedUsd,
          detail: "no end within 5 minutes",
        };
      progress();
      await env.sleep(POLL_MS);
    }
  }

  // The shared caps again between admissions: another lane's spend can use up the headroom mid-run. One read at a time
  // (concurrent admissions wait for the read in flight), and a read that fails or has not answered refuses the
  // admission: the run never spends without knowing the headroom.
  function sharedStillAllows(): Promise<boolean> {
    if (env.now() - sharedOkAt < SHARED_RECHECK_MS) return Promise.resolve(true);
    sharedCheck ??= (async () => {
      const day = sastDay(new Date(env.now()));
      try {
        const now = await env.timeout(DB_TIMEOUT_MS, () => db.spent(day));
        sharedOkAt = env.now();
        // `inflight` already counts the admissions waiting on this read.
        return !refusingCap(now.daySpentUsd, now.totalSpentUsd, Math.max(1, inflight) * perSample, day);
      } catch {
        return false;
      } finally {
        sharedCheck = null;
      }
    })();
    return sharedCheck;
  }

  async function one(s: RunSample) {
    // The admission gates apply to a new upload; a case already opened is reconciled whatever the budget says.
    const reopened = Boolean(journal.caseIds[s.id]);
    if (aborted || (stop && !reopened)) return;
    // The estimate is reserved synchronously, before any await, so concurrent workers cannot all pass on the same headroom.
    if (!reopened && spentUsd + (inflight + 1) * perSample > capUsd) {
      stop = "budget";
      return;
    }
    inflight++;
    try {
      if (!reopened && !(await sharedStillAllows())) {
        stop = "shared";
        return;
      }
      let caseId = journal.caseIds[s.id] ?? null;
      if (!caseId) {
        let bytes: Uint8Array;
        try {
          bytes = env.bytes(s.file);
        } catch {
          await store({ ...base(s, null), outcome: "lost", detail: "its file could not be read here" });
          return;
        }
        if (experiment && sha256(bytes) !== s.sha256) throw new SessionRefused(`selected sample changed: ${s.id}`);
        let answer: UploadAnswer | null = null;
        for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt++) {
          try {
            answer = await env.timeout(UPLOAD_TIMEOUT_MS, () =>
              api.upload(s, bytes, {
                mode,
                replayRunId: experiment?.replayRunId ?? (mode.startsWith("replay:") ? runId : null),
                ...(experiment
                  ? {
                      experiment: {
                        experimentId: experiment.experimentId,
                        arm: experiment.arm,
                        manifestDigest: experiment.manifestDigest,
                        deployment: experiment.deployment,
                      },
                    }
                  : {}),
              }),
            );
          } catch {
            answer = { status: 503 };
          }
          if (answer.status !== 503) break;
          if (attempt < UPLOAD_RETRIES) await env.sleep(1_000 * 2 ** attempt);
        }
        const a = answer as UploadAnswer;
        if (a.status === 401 || a.status === 403) throw new SessionRefused(`the session was refused (${a.status})`);
        if (a.status === 429) {
          stop = "capped";
          await store({
            ...base(s, null),
            outcome: "capped",
            httpStatus: 429,
            detail: "the organisation's cases for today are used",
          });
          return;
        }
        if ((a.status !== 200 && a.status !== 201) || !a.caseId) {
          await store({
            ...base(s, null),
            outcome: "refused",
            httpStatus: a.status >= 100 && a.status <= 599 ? a.status : null,
            detail: a.status === 503 ? "the upload failed after its retries" : `the upload was refused (${a.status})`,
          });
          return;
        }
        caseId = a.caseId;
        if (experiment) {
          if (!sameExperiment(a.experiment, experiment))
            throw new SessionRefused(`upload experiment attribution mismatch for ${s.id}`);
          const bound = await attribution(s, caseId);
          if (!bound.active) {
            await store({
              ...base(s, null),
              outcome: "lost",
              detail: "definitive RawMissing; resume with the same arm identity",
            });
            return;
          }
        }
        // A repeat is judged before its case is journaled: a case from before this run must never reach a poll, so a
        // crash or a failed store here is found again, as a repeat, when the run is resumed.
        if (a.repeat && !experiment) {
          let earlier: CaseState | null | "unreadable" = "unreadable";
          try {
            earlier = await env.timeout(DB_TIMEOUT_MS, () => db.caseState(caseId as string));
          } catch {
            earlier = "unreadable";
          }
          // A case whose age could not be read is retried on resume (as a repeat again), never excluded for good.
          if (earlier === "unreadable" || !earlier) {
            await store({
              ...base(s, null),
              outcome: "lost",
              detail: "the age of its repeated case could not be read",
            });
            return;
          }
          if (earlier.createdAt < startedAt) {
            await store({
              ...base(s, caseId),
              outcome: "stale-repeat",
              httpStatus: a.status,
              detail: "answered a case from before this run",
            });
            return;
          }
        }
        journal.caseIds[s.id] = caseId;
        saveJournal(env.journalDir, journal);
      }
      if (experiment) await attribution(s, caseId);
      const row = await poll(s, caseId, priorBySample.get(s.id)?.costUsd ?? 0);
      await store(row);
      spentUsd += row.costUsd;
    } finally {
      inflight--;
    }
  }

  const stopTicker = env.ticker(PROGRESS_MS, progress);
  const queue = [...todo];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let s = queue.shift(); s && !aborted; s = queue.shift()) {
      try {
        await one(s);
      } catch (error) {
        aborted = error as Error;
      }
    }
  });
  await Promise.all(workers);
  stopTicker();

  // A sample never sent stays in the denominator as `lost`, stored like any other result.
  for (const s of samples)
    if (!results.has(s.id)) {
      // A sample the run did not reach keeps the row an earlier pass stored (its case and its recorded cost).
      const row: ResultRow = priorBySample.get(s.id) ?? {
        ...base(s, journal.caseIds[s.id] ?? null),
        outcome: "lost",
        detail: "never sent",
      };
      try {
        await store(row);
      } catch (error) {
        aborted = aborted ?? (error as Error);
        results.set(s.id, row);
      }
    }

  const rows = samples.map((s) => results.get(s.id) as ResultRow);
  let status: RunStatus = aborted
    ? "aborted"
    : runStatus(
        samples.length,
        rows.map((r) => r.outcome),
      );
  const costUsd = rows.reduce((a, r) => a + r.costUsd, 0);
  const why = aborted
    ? [String((aborted as Error).message)]
    : stop === "preflight"
      ? blocked.map((p) => `new uploads refused: ${p}`)
      : stop
        ? [`stopped early: ${stop}`]
        : [];
  // Never success before the run is durably finished: a finish that cannot be stored is a fault, whatever the results.
  try {
    await retried(
      env,
      WRITE_RETRIES,
      () => env.timeout(DB_TIMEOUT_MS, () => db.finishRun(runId, status, costUsd, new Date(env.now()).toISOString())),
      (e) => new WriteFailed(`the run could not be finished in the database: ${String(e)}`),
    );
  } catch (error) {
    status = "aborted";
    why.push((error as Error).message);
  }
  return { runId, status, exit: exitCode(status), problems: why, results: rows, costUsd };
}

// ---- verify: the stored run read back and reconciled with its cases ------------------------------------------------------

// One line on what verification checked: the stored status, and the measured against the unmeasured samples. A
// verified run still needs its status read: `verified` alone never claims completeness.
export function verifyLine(stored: { run: RunRow; results: ResultRow[] }): string {
  const tally = new Map<string, number>();
  for (const r of stored.results) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1);
  const measured = stored.results.filter(
    (r) => (r.outcome === "done" || r.outcome === "partial") && r.verdict !== null,
  ).length;
  return (
    `run ${stored.run.id} is ${stored.run.status}: ${stored.results.length} of ${stored.run.selected} results, ` +
    `${measured} measured (${[...tally].map(([k, v]) => `${v} ${k}`).join(", ")})`
  );
}

export async function verifyRun(db: Db, id: string): Promise<{ ok: boolean; problems: string[] }> {
  const stored = await db.readRun(id);
  if (!stored) return { ok: false, problems: [`no run ${id}`] };
  const problems: string[] = [];
  const { run, results } = stored;
  if (results.length !== run.selected) problems.push(`${results.length} results for ${run.selected} selected samples`);
  if (new Set(results.map((r) => r.sample)).size !== results.length) problems.push("a sample is stored twice");
  const seen = new Set<string>();
  for (const r of results) {
    if (r.caseId) {
      if (seen.has(r.caseId)) problems.push(`${r.sample}: case ${r.caseId} is another sample's too`);
      seen.add(r.caseId);
    }
    if (isTerminal(r.outcome)) {
      const state = r.caseId ? await db.caseState(r.caseId) : null;
      if (!state) problems.push(`${r.sample}: its case ${r.caseId ?? "(none)"} cannot be read`);
      else {
        if (state.status !== r.outcome || state.verdict !== r.verdict)
          problems.push(
            `${r.sample}: stored ${r.outcome}/${r.verdict}, the case says ${state.status}/${state.verdict}`,
          );
        if (Math.abs(state.costUsd - r.costUsd) > 1e-9)
          problems.push(`${r.sample}: stored cost ${r.costUsd}, the ledger says ${state.costUsd}`);
        if (state.critical !== r.criticalFound)
          problems.push(`${r.sample}: stored critical ${r.criticalFound}, the case says ${state.critical}`);
        const ms = Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.createdAt));
        if (r.ms !== ms) problems.push(`${r.sample}: stored ${r.ms} ms, the case says ${ms}`);
      }
    }
  }
  const total = results.reduce((a, r) => a + r.costUsd, 0);
  if (run.status !== "running" && Math.abs(run.costUsd - total) > 1e-9)
    problems.push(`the run's cost ${run.costUsd} is not its results' ${total}`);
  const want = runStatus(
    run.selected,
    results.map((r) => r.outcome),
  );
  if (run.status !== "aborted" && run.status !== want)
    problems.push(`the run says ${run.status}, its results say ${want}`);
  return { ok: problems.length === 0, problems };
}

// ---- the live clients ----------------------------------------------------------------------------------------------------

const MEDIA: Record<string, string> = { ".eml": "message/rfc822", ".pdf": "application/pdf", ".png": "image/png" };
export function sampleUploadKey(sample: RunSample): string {
  const ext = sample.path.slice(sample.path.lastIndexOf(".")).toLowerCase();
  return `sha256:${sha256(`${sample.sha256}\0${sample.path}\0${MEDIA[ext] ?? "application/octet-stream"}`)}`;
}

export function liveApi(base: string, cookie: string, fetchImpl: typeof fetch = fetch): Api {
  return {
    async capabilities() {
      const res = await fetchImpl(new URL("/api/upload/ablation-capabilities", base), {
        headers: { cookie },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`ablation capability unavailable (${res.status})`);
      return res.json();
    },
    async commit() {
      const body = (await (
        await fetchImpl(new URL("/health", base), { signal: AbortSignal.timeout(30_000) })
      ).json()) as {
        commit?: string;
      };
      if (!body.commit) throw new Error("/health named no commit");
      return body.commit;
    },
    async whoami() {
      const res = await fetchImpl(new URL("/api/auth/get-session", base), {
        headers: { cookie },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as { user?: { id?: string } } | null;
      return body?.user?.id ?? null;
    },
    async upload(sample, bytes, opts) {
      const ext = sample.path.slice(sample.path.lastIndexOf(".")).toLowerCase();
      const form = new FormData();
      form.set("file", new Blob([bytes as BlobPart], { type: MEDIA[ext] ?? "application/octet-stream" }), sample.path);
      // A replay (D08 T02 section 12, D01 T01 section 22): the upload door admits at most one replayRunId field,
      // honoured only for the eval organisation, scoping the claim so the replay admits its own case. The id is
      // the replay run's own, never the source run's. Experimental arms carry explicit immutable context;
      // their capability and durable-attribution gates run before a case can enter measurements.
      if (opts.experiment) {
        const value = ExperimentInput.parse(opts.experiment);
        CaseExperiment.parse({ ...value, replayRunId: opts.replayRunId });
        form.set("ablate", JSON.stringify(value));
      }
      if (opts.replayRunId) form.set("replayRunId", opts.replayRunId);
      const res = await fetchImpl(new URL("/api/upload", base), {
        method: "POST",
        headers: { cookie },
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      const json = (await res.json().catch(() => ({}))) as { caseId?: string; repeat?: boolean; experiment?: unknown };
      if (opts.experiment && (res.status === 200 || res.status === 201)) {
        if (typeof json.caseId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(json.caseId))
          throw new Error("invalid experimental case ID");
        CaseExperiment.parse(json.experiment);
      }
      return {
        status: res.status,
        ...(json.caseId ? { caseId: json.caseId } : {}),
        ...(json.repeat ? { repeat: true } : {}),
        ...(json.experiment !== undefined ? { experiment: json.experiment } : {}),
      };
    },
  };
}

type Execute = (s: Statement) => Promise<{ results?: Record<string, unknown>[]; meta?: { changes?: number } }>;

export function canonicalReputationProvider(provider: string): string {
  if (provider === "cloudflare") return "cloudflare-security-dns";
  if (provider === "webrisk") return "google-web-risk";
  return provider;
}

export function mergeCaseProviderRecords(
  repRows: { provider: string; state: string }[],
  evidenceProviders: string[],
): { provider: string; checked: boolean; listed: boolean }[] {
  const byProv = new Map<string, Set<string>>();
  for (const r of repRows) {
    if (!r.provider) continue;
    const p = canonicalReputationProvider(r.provider);
    const set = byProv.get(p) ?? new Set<string>();
    set.add(r.state);
    byProv.set(p, set);
  }
  for (const rawP of evidenceProviders) {
    if (!rawP) continue;
    const p = canonicalReputationProvider(rawP);
    const set = byProv.get(p) ?? new Set<string>();
    set.add("listed");
    byProv.set(p, set);
  }
  return [...byProv.entries()].map(([provider, states]) => {
    if (states.has("listed") || states.has("blocked")) return { provider, checked: true, listed: true };
    if (states.has("clear") || states.has("not_listed")) return { provider, checked: true, listed: false };
    return { provider, checked: false, listed: false };
  });
}

export function liveDb(orgName: string, execute: Execute, now: () => Date = () => new Date()): Db {
  let org: string | null = null;
  const orgId = async () => {
    if (org) return org;
    const rows =
      (await execute({ sql: `SELECT id FROM "organization" WHERE name = ?1`, params: [orgName] })).results ?? [];
    if (rows.length !== 1) throw new Error(`expected one organisation named ${orgName}, found ${rows.length}`);
    org = String(rows[0]?.id);
    return org;
  };
  const num = (v: unknown) => Number(v ?? 0);
  return {
    orgId,
    async memberships(userId) {
      const rows = (
        await execute({ sql: `SELECT "organizationId" AS org FROM "member" WHERE "userId" = ?1`, params: [userId] })
      ).results;
      return (rows ?? []).map((r) => String(r.org));
    },
    async allowance() {
      const t = now();
      const rows = (
        await execute({
          sql: `SELECT ${MEMBER_CASES_TODAY("?1", "?2")} AS used, ${dailyCapSql("?1", "?3")} AS lim`,
          params: [await orgId(), sastDayStart(t), t.toISOString()],
        })
      ).results;
      return { used: num(rows?.[0]?.used), limit: num(rows?.[0]?.lim) };
    },
    async spent(day) {
      const row = (await execute(spentStatement(day))).results?.[0];
      return { daySpentUsd: num(row?.day_usd), totalSpentUsd: num(row?.total_usd) };
    },
    async lastCostPerCase() {
      const row = (
        await execute({
          sql: `SELECT AVG(cost_usd) AS c FROM eval_results WHERE outcome IN ('done', 'partial') AND run_id = (SELECT id FROM eval_runs WHERE status = 'complete' ORDER BY started_at DESC LIMIT 1)`,
          params: [],
        })
      ).results?.[0];
      return row?.c === null || row?.c === undefined ? null : Number(row.c);
    },
    async caseState(caseId) {
      // The cost is the shared ledger's (`model_spend`, by case): settled spend, else the reserved estimate, as the
      // budget guard counts it; `case_events.cost_usd` is not written by the pipeline.
      const row = (
        await execute({
          sql: `SELECT status, verdict, created_at, updated_at, (SELECT COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_usd ELSE estimate_usd END), 0) FROM model_spend WHERE case_id = ?1) AS cost, EXISTS (SELECT 1 FROM evidence WHERE case_id = ?1 AND severity = 'critical') AS critical, (SELECT COALESCE(json_group_array(json_object('provider', provider, 'state', state)), '[]') FROM reputation_results WHERE case_id = ?1 AND provider IN ('google-web-risk', 'cloudflare')) AS rep_rows, (SELECT COALESCE(json_group_array(DISTINCT json_extract(detail_json, '$.provider')), '[]') FROM evidence WHERE case_id = ?1 AND "check" = 'reputation.listing') AS providers, (CASE WHEN EXISTS (SELECT 1 FROM walkthrough_actions WHERE case_id = ?1) AND NOT EXISTS (SELECT 1 FROM evidence WHERE case_id = ?1 AND "check" IN ('walkthrough.not_checked', 'walkthrough.ablated')) AND NOT EXISTS (SELECT 1 FROM evidence WHERE case_id = ?1 AND "check" = 'walkthrough.chain' AND json_extract(detail_json, '$.reused') IS NOT NULL) THEN 1 WHEN EXISTS (SELECT 1 FROM walkthrough_actions WHERE case_id = ?1) OR EXISTS (SELECT 1 FROM evidence WHERE case_id = ?1 AND "check" = 'walkthrough.not_checked') THEN 0 ELSE NULL END) AS walked FROM cases WHERE id = ?1 AND org_id = ?2`,
          params: [caseId, await orgId()],
        })
      ).results?.[0];
      if (!row) return null;
      const repRows = JSON.parse(String(row.rep_rows ?? "[]")) as { provider: string; state: string }[];
      const evidenceProviders = JSON.parse(String(row.providers ?? "[]")) as string[];
      const providerRecords = mergeCaseProviderRecords(repRows, evidenceProviders);
      return {
        status: row.status as CaseState["status"],
        verdict: (row.verdict ?? null) as Verdict | null,
        costUsd: num(row.cost),
        critical: num(row.critical) === 1,
        providers: providerRecords,
        walkthrough: row.walked === null || row.walked === undefined ? null : num(row.walked) === 1,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    },
    async caseExperiment(caseId) {
      const row = (
        await execute({
          sql: `SELECT e.experiment_id AS experimentId,a.arm,e.manifest_digest AS manifestDigest,
        e.deployment,a.replay_run_id AS replayRunId,x.upload_key,x.active_upload_key,
        EXISTS(SELECT 1 FROM case_events v WHERE v.case_id=c.id AND v.step='admit' AND v.status='failed' AND v.error='RawMissing' AND c.status='partial') AS raw_missing
        FROM case_experiments x JOIN eval_experiment_arms a ON a.org_id=x.org_id AND a.experiment_id=x.experiment_id AND a.arm=x.arm AND a.replay_run_id=x.replay_run_id
        JOIN eval_experiments e ON e.org_id=a.org_id AND e.experiment_id=a.experiment_id
        JOIN cases c ON c.id=x.case_id AND c.org_id=x.org_id WHERE x.case_id=?1 AND x.org_id=?2`,
          params: [caseId, await orgId()],
        })
      ).results?.[0];
      if (!row) return null;
      const context = CaseExperiment.parse({
        experimentId: row.experimentId,
        arm: row.arm,
        manifestDigest: row.manifestDigest,
        deployment: row.deployment,
        replayRunId: row.replayRunId,
      });
      return {
        context,
        uploadKey: String(row.upload_key),
        active: row.active_upload_key === row.upload_key,
        rawMissing: row.active_upload_key === null && num(row.raw_missing) === 1,
      };
    },
    async modelUse(caseId) {
      const rows =
        (
          await execute({
            sql: `SELECT m.model,m.step,m.outcome,m.state,m.cache FROM model_spend m
        JOIN cases c ON c.id=m.case_id WHERE c.id=?1 AND c.org_id=?2 AND m.owner='case'`,
            params: [caseId, await orgId()],
          })
        ).results ?? [];
      return rows.map((row) => ({
        model: String(row.model),
        step: row.step === null ? null : String(row.step),
        outcome: row.outcome === null ? null : String(row.outcome),
        state: String(row.state),
        cache: row.cache === null ? null : String(row.cache),
      }));
    },
    async insertRun(r) {
      await execute({
        sql: `INSERT INTO eval_runs (id, commit_sha, set_version, mode, sets, sample_limit, status, selected, cap_usd, started_at, finished_at, cost_usd) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, 0)`,
        params: [
          r.id,
          r.commitSha,
          r.setVersion,
          r.mode,
          r.sets.join(","),
          r.sampleLimit,
          r.status,
          r.selected,
          r.capUsd,
          r.startedAt,
        ],
      });
    },
    async putResult(r) {
      await execute({
        sql: `INSERT INTO eval_results (run_id, sample, case_id, outcome, label, category, verdict, ms, cost_usd, critical_found, http_status, detail, providers, walkthrough) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) ON CONFLICT (run_id, sample) DO UPDATE SET case_id = excluded.case_id, outcome = excluded.outcome, verdict = excluded.verdict, ms = excluded.ms, cost_usd = excluded.cost_usd, critical_found = excluded.critical_found, http_status = excluded.http_status, detail = excluded.detail, providers = excluded.providers, walkthrough = excluded.walkthrough`,
        params: [
          r.runId,
          r.sample,
          r.caseId,
          r.outcome,
          r.label,
          r.category,
          r.verdict,
          r.ms,
          r.costUsd,
          r.criticalFound ? 1 : 0,
          r.httpStatus,
          r.detail,
          r.providers ? JSON.stringify(r.providers) : null,
          r.walkthrough === null || r.walkthrough === undefined ? null : r.walkthrough ? 1 : 0,
        ],
      });
    },
    async finishRun(id, status, costUsd, finishedAt) {
      await execute({
        sql: `UPDATE eval_runs SET status = ?2, cost_usd = ?3, finished_at = ?4 WHERE id = ?1`,
        params: [id, status, costUsd, finishedAt],
      });
    },
    async readRun(id) {
      const runs = (await execute({ sql: `SELECT * FROM eval_runs WHERE id = ?1`, params: [id] })).results ?? [];
      const r = runs[0];
      if (!r) return null;
      const rows =
        (await execute({ sql: `SELECT * FROM eval_results WHERE run_id = ?1 ORDER BY sample`, params: [id] }))
          .results ?? [];
      return {
        run: {
          id: String(r.id),
          commitSha: String(r.commit_sha),
          setVersion: String(r.set_version),
          mode: String(r.mode),
          sets: String(r.sets).split(","),
          sampleLimit: r.sample_limit === null ? null : num(r.sample_limit),
          status: r.status as RunRow["status"],
          selected: num(r.selected),
          capUsd: num(r.cap_usd),
          startedAt: String(r.started_at),
          finishedAt: r.finished_at === null ? null : String(r.finished_at),
          costUsd: num(r.cost_usd),
        },
        results: rows.map((x) => ({
          runId: String(x.run_id),
          sample: String(x.sample),
          caseId: x.case_id === null ? null : String(x.case_id),
          outcome: x.outcome as Outcome,
          label: x.label as "attack" | "genuine",
          category: String(x.category),
          verdict: (x.verdict ?? null) as Verdict | null,
          ms: x.ms === null ? null : num(x.ms),
          costUsd: num(x.cost_usd),
          criticalFound: num(x.critical_found) === 1,
          providers: x.providers ? (JSON.parse(String(x.providers)) as ResultRow["providers"]) : undefined,
          walkthrough: x.walkthrough === null || x.walkthrough === undefined ? null : num(x.walkthrough) === 1,
          httpStatus: x.http_status === null ? null : num(x.http_status),
          detail: x.detail === null ? null : String(x.detail),
        })),
      };
    },
  };
}

// The sets and limit a command runs: a resumed run restores the selection it began with, whatever options the command
// repeats; otherwise the options' own.
export async function resolveSelection(
  db: Pick<Db, "readRun">,
  options: Pick<Options, "sets" | "limit" | "resume">,
): Promise<{ sets: string[]; limit: number | null } | { error: string }> {
  if (!options.resume) return { sets: options.sets, limit: options.limit };
  const stored = await db.readRun(options.resume);
  if (!stored) return { error: `no run ${options.resume}` };
  return { sets: stored.run.sets, limit: stored.run.sampleLimit };
}

// A replay's population (D08 T02 section 12): the source run's stored selection restored and verified against
// the files on disk. A drifted population (a missing, changed or re-labelled sample, a changed set version)
// is an error before anything is uploaded.
export function replayPopulation(
  stored: { run: RunRow; results: ResultRow[] },
  select: (sets: readonly string[], limit: number | null) => { samples: RunSample[]; setVersion: string },
): { samples: RunSample[]; setVersion: string } | { error: string } {
  // Only a full run replays (D08 T02 section 12): an ablation arm measures a different pipeline, and a
  // replay of a replay would attribute the new measurement to the wrong source.
  if (stored.run.mode !== "full")
    return {
      error: `run ${stored.run.id} was measured as ${stored.run.mode}, not full; only a full run replays as a full measurement`,
    };
  const restored = select(stored.run.sets, stored.run.sampleLimit);
  if (restored.setVersion !== stored.run.setVersion)
    return {
      error: `the sets on disk (version ${restored.setVersion}) are not those of run ${stored.run.id} (version ${stored.run.setVersion})`,
    };
  const ids = new Set(restored.samples.map((s) => s.id));
  const missing = stored.results.filter((r) => !ids.has(r.sample));
  if (restored.samples.length !== stored.run.selected || missing.length > 0)
    return {
      error: `the restored selection (${restored.samples.length} samples) is not the population of run ${stored.run.id} (${stored.run.selected} selected, ${missing.length} missing)`,
    };
  return restored;
}

// ---- the command ------------------------------------------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function main(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  // Injected by the command-entry tests; the live command builds its own from the environment.
  deps?: { db: Db; api: Api; env: Env },
): Promise<number> {
  const options = parseArgs(argv);
  if ("error" in options) {
    console.error(`eval:run: ${options.error}\n${USAGE}`);
    return EXIT.refused;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const { execute } = await import("../scripts/lib/meta-budget.ts");
  const db =
    deps?.db ??
    liveDb(environment.EVAL_ORG_NAME ?? "IsItLegit Eval", (s) => execute({ sql: inlineLong(s), params: [] }));
  if (options.verify) {
    const result = await verifyRun(db, options.verify);
    for (const p of result.problems) console.error(`eval:run: ${p}`);
    const stored = await db.readRun(options.verify).catch(() => null);
    if (stored) console.log(`eval:run: ${verifyLine(stored)}`);
    console.log(
      result.ok ? `eval:run: run ${options.verify} verified` : `eval:run: run ${options.verify} NOT verified`,
    );
    return result.ok ? 0 : EXIT.fault;
  }
  const cookie = environment.EVAL_SESSION_COOKIE;
  if (!cookie && !options.dry) {
    console.error(
      "eval:run: EVAL_SESSION_COOKIE is not set (the eval session lives in the vault item IsItLegit eval session)",
    );
    return EXIT.refused;
  }
  if (options.replay && (options.mode || options.resume)) {
    console.error("eval:run: --replay stands alone (no --mode or --resume)");
    return EXIT.refused;
  }
  const picked = await resolveSelection(db, options);
  if ("error" in picked) {
    console.error(`eval:run: ${picked.error}`);
    return EXIT.refused;
  }
  let { sets, limit } = picked;
  let samples: RunSample[];
  let setVersion: string;
  if (options.replay) {
    // The source run is read before any set is loaded: only its stored selection is ever read from disk, so
    // an unrelated missing or malformed corpus cannot refuse a replay (D08 T02 section 12).
    const stored = await db.readRun(options.replay).catch(() => null);
    if (!stored) {
      console.error(`eval:run: no stored run ${options.replay} to replay`);
      return EXIT.refused;
    }
    const restored = replayPopulation(stored, (s, l) => selectSamples(join(ROOT, "eval/sets"), s, l));
    if ("error" in restored) {
      console.error(`eval:run: ${restored.error}; nothing sent`);
      return EXIT.refused;
    }
    sets = stored.run.sets;
    limit = stored.run.sampleLimit;
    samples = restored.samples;
    setVersion = restored.setVersion;
  } else {
    const selectedAll = selectSamples(join(ROOT, "eval/sets"), sets, limit);
    samples = selectedAll.samples;
    setVersion = selectedAll.setVersion;
  }
  const api = deps?.api ?? liveApi(environment.EVAL_BASE_URL ?? "https://app.isitlegit.co.za", cookie ?? "");
  const env: Env = deps?.env ?? {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    id: () => randomUUID(),
    journalDir: join(ROOT, "build/eval-runs"),
    bytes: (file) => readFileSync(file),
    log: (line) => console.log(line),
    timeout: boundedBy,
    ticker: (ms, fn) => {
      const timer = setInterval(fn, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
  const result = await runEval({
    samples,
    setVersion,
    sets,
    sampleLimit: limit,
    options,
    api,
    db,
    env,
    resume: options.resume,
    ...(options.replay ? { replayOf: options.replay } : options.mode ? { mode: options.mode } : {}),
  });
  for (const p of result.problems) console.error(`eval:run: ${p}`);
  if (result.exit === EXIT.refused) {
    const hints = [...new Set(result.problems.map(recoveryHint).filter((h) => h !== null))];
    for (const h of hints) console.error(`eval:run: next step: ${h}`);
  }
  const tally = new Map<string, number>();
  for (const r of result.results) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1);
  console.log(
    `eval:run: ${result.status}${result.runId ? ` run ${result.runId}` : ""}; ${[...tally].map(([k, v]) => `${v} ${k}`).join(", ") || "nothing sent"}; cost US$${result.costUsd.toFixed(4)}`,
  );
  return result.exit;
}

if (process.argv[1] && import.meta.filename === process.argv[1])
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`eval:run: ${(error as Error).message}`);
      process.exit(EXIT.fault);
    },
  );

// A SHA-256 helper for tests of the journal and the provenance.
export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
