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
import { inline, type Statement, spentStatement } from "../src/meta/budget-sql.ts";
import { sastDay } from "../src/meta/day.ts";

// Midnight SAST (UTC+2, no daylight saving) of the instant's SAST day, as src/db/cases.ts `sastDayStart` reads it.
const SAST_OFFSET_MS = 2 * 60 * 60_000;
const sastDayStart = (now: Date) => {
  const local = now.getTime() + SAST_OFFSET_MS;
  return new Date(local - (local % 86_400_000) - SAST_OFFSET_MS).toISOString();
};

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
  runStatus,
  selectSamples,
  USAGE,
} from "./run-core.ts";

export const CONCURRENCY = 4;
export const POLL_MS = 3_000;
export const CASE_TIMEOUT_MS = 5 * 60_000;
export const UPLOAD_RETRIES = 3;
export const POLL_ERRORS = 5;
export const WRITE_RETRIES = 3;

export type Verdict = "safe" | "suspicious" | "malicious";
export type CaseState = {
  status: "received" | "running" | "done" | "partial";
  verdict: Verdict | null;
  costUsd: number;
  critical: boolean;
  createdAt: string;
};
export type UploadAnswer = { status: number; caseId?: string; repeat?: boolean };
export type Api = {
  commit(): Promise<string>;
  upload(sample: RunSample, bytes: Uint8Array): Promise<UploadAnswer>;
};
export type RunRow = {
  id: string;
  commitSha: string;
  setVersion: string;
  mode: string;
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
};
export type Db = {
  allowance(): Promise<{ used: number; limit: number }>;
  spent(day: string): Promise<{ daySpentUsd: number; totalSpentUsd: number }>;
  lastCostPerCase(): Promise<number | null>;
  caseState(caseId: string): Promise<CaseState | null>;
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
};

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

// ---- a run ---------------------------------------------------------------------------------------------------------

export async function runEval(args: {
  samples: RunSample[];
  setVersion: string;
  options: Pick<Options, "capUsd" | "dry">;
  api: Api;
  db: Db;
  env: Env;
  resume?: string | null;
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

  // A resumed run keeps its row, its finished results and its journal.
  let existing: ResultRow[] = [];
  let runId = env.id();
  let startedAt = new Date(env.now()).toISOString();
  let journal: Journal = { runId, startedAt, caseIds: {} };
  let commitSha = "";
  if (args.resume) {
    const stored = await db.readRun(args.resume);
    if (!stored) return refused([`no run ${args.resume}`]);
    if (stored.run.status === "complete") return refused([`run ${args.resume} is already complete`]);
    if (stored.run.setVersion !== setVersion) return refused(["the selected samples are not those of the run"]);
    runId = stored.run.id;
    startedAt = stored.run.startedAt;
    commitSha = stored.run.commitSha;
    existing = stored.results;
    journal = loadJournal(env.journalDir, runId) ?? { runId, startedAt, caseIds: {} };
    for (const r of existing) if (r.caseId) journal.caseIds[r.sample] = r.caseId;
  }
  const finished = new Map(existing.filter((r) => isTerminal(r.outcome)).map((r) => [r.sample, r]));
  const todo = samples.filter((s) => !finished.has(s.id));

  // Refused before anything is uploaded: no cap, estimate or allowance may pass.
  const day = sastDay(new Date(env.now()));
  const [spent, last, allowance] = await Promise.all([db.spent(day), db.lastCostPerCase(), db.allowance()]);
  const perSample = perSampleEstimate(last);
  const needUpload = todo.filter((s) => !journal.caseIds[s.id]);
  const problems = preflightProblems({
    selected: todo.length,
    // Only the samples still to be uploaded use the organisation's allowance.
    uploads: needUpload.length,
    capUsd: options.capUsd,
    perSampleUsd: perSample,
    day,
    daySpentUsd: spent.daySpentUsd,
    totalSpentUsd: spent.totalSpentUsd,
    allowance,
  });
  if (options.dry)
    return {
      ...refused(problems),
      status: problems.length ? "refused" : "complete",
      exit: problems.length ? EXIT.refused : 0,
    };
  if (problems.length) return refused(problems);

  if (!args.resume) {
    commitSha = await api.commit();
    await db.insertRun({
      id: runId,
      commitSha,
      setVersion,
      mode: "full",
      status: "running",
      selected: samples.length,
      capUsd: options.capUsd,
      startedAt,
      finishedAt: null,
      costUsd: 0,
    });
    saveJournal(env.journalDir, journal);
  }

  const results = new Map<string, ResultRow>(finished);
  let spentUsd = [...finished.values()].reduce((a, r) => a + r.costUsd, 0);
  let inflight = 0;
  let stop: "capped" | "budget" | null = null;
  let aborted: Error | null = null;

  const store = (row: ResultRow) =>
    retried(
      env,
      WRITE_RETRIES,
      () => db.putResult(row),
      (e) => new WriteFailed(`the result could not be stored: ${String(e)}`),
    ).then(() => {
      results.set(row.sample, row);
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
  });

  async function poll(s: RunSample, caseId: string, startedMs: number): Promise<ResultRow> {
    let errors = 0;
    for (;;) {
      let state: CaseState | null = null;
      try {
        state = await db.caseState(caseId);
        errors = 0;
      } catch {
        if (++errors >= POLL_ERRORS) return { ...base(s, caseId), outcome: "lost" };
      }
      if (state && (state.status === "done" || state.status === "partial")) {
        return {
          ...base(s, caseId),
          outcome: state.status,
          verdict: state.verdict,
          ms: Math.max(0, env.now() - startedMs),
          costUsd: state.costUsd,
          criticalFound: state.critical,
        };
      }
      if (env.now() - startedMs >= CASE_TIMEOUT_MS) return { ...base(s, caseId), outcome: "timeout" };
      await env.sleep(POLL_MS);
    }
  }

  async function one(s: RunSample) {
    if (stop || aborted) return;
    if (spentUsd + (inflight + 1) * perSample > options.capUsd) {
      stop = "budget";
      return;
    }
    inflight++;
    try {
      const startedMs = env.now();
      let caseId = journal.caseIds[s.id] ?? null;
      if (!caseId) {
        let answer: UploadAnswer | null = null;
        for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt++) {
          try {
            answer = await api.upload(s, env.bytes(s.file));
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
          await store({ ...base(s, null), outcome: "capped" });
          return;
        }
        if ((a.status !== 200 && a.status !== 201) || !a.caseId) {
          await store({ ...base(s, null), outcome: "refused" });
          return;
        }
        caseId = a.caseId;
        journal.caseIds[s.id] = caseId;
        saveJournal(env.journalDir, journal);
        if (a.repeat) {
          const earlier = await db.caseState(caseId).catch(() => null);
          if (!earlier || earlier.createdAt < startedAt) {
            await store({ ...base(s, caseId), outcome: "stale-repeat" });
            return;
          }
        }
      }
      const row = await poll(s, caseId, startedMs);
      await store(row);
      spentUsd += row.costUsd;
    } finally {
      inflight--;
    }
  }

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

  // A sample never sent stays in the denominator as `lost`.
  for (const s of samples)
    if (!results.has(s.id)) {
      if (!aborted) await store({ ...base(s, journal.caseIds[s.id] ?? null), outcome: "lost" }).catch(() => {});
      else results.set(s.id, { ...base(s, journal.caseIds[s.id] ?? null), outcome: "lost" });
    }

  const rows = samples.map((s) => results.get(s.id) as ResultRow);
  const status: RunStatus = aborted
    ? "aborted"
    : runStatus(
        samples.length,
        rows.map((r) => r.outcome),
      );
  const costUsd = rows.reduce((a, r) => a + r.costUsd, 0);
  await db.finishRun(runId, status, costUsd, new Date(env.now()).toISOString()).catch(() => {});
  const why = aborted ? [String((aborted as Error).message)] : stop ? [`stopped early: ${stop}`] : [];
  return { runId, status, exit: exitCode(status), problems: why, results: rows, costUsd };
}

// ---- verify: the stored run read back and reconciled with its cases ------------------------------------------------------

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
      else if (state.status !== r.outcome || state.verdict !== r.verdict)
        problems.push(`${r.sample}: stored ${r.outcome}/${r.verdict}, the case says ${state.status}/${state.verdict}`);
    }
  }
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

export function liveApi(base: string, cookie: string, fetchImpl: typeof fetch = fetch): Api {
  return {
    async commit() {
      const body = (await (await fetchImpl(new URL("/health", base))).json()) as { commit?: string };
      if (!body.commit) throw new Error("/health named no commit");
      return body.commit;
    },
    async upload(sample, bytes) {
      const ext = sample.path.slice(sample.path.lastIndexOf(".")).toLowerCase();
      const form = new FormData();
      form.set("file", new Blob([bytes as BlobPart], { type: MEDIA[ext] ?? "application/octet-stream" }), sample.path);
      const res = await fetchImpl(new URL("/api/upload", base), { method: "POST", headers: { cookie }, body: form });
      const json = (await res.json().catch(() => ({}))) as { caseId?: string; repeat?: boolean };
      return {
        status: res.status,
        ...(json.caseId ? { caseId: json.caseId } : {}),
        ...(json.repeat ? { repeat: true } : {}),
      };
    },
  };
}

type Execute = (s: Statement) => Promise<{ results?: Record<string, unknown>[]; meta?: { changes?: number } }>;

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
    async allowance() {
      const t = now();
      const rows = (
        await execute({
          sql: `SELECT (SELECT COUNT(*) FROM cases WHERE org_id = ?1 AND created_at >= ?2) AS used, ${dailyCapSql("?1", "?3")} AS lim`,
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
      const row = (
        await execute({
          sql: `SELECT status, verdict, created_at, (SELECT COALESCE(SUM(cost_usd), 0) FROM case_events WHERE case_id = ?1) AS cost, EXISTS (SELECT 1 FROM evidence WHERE case_id = ?1 AND severity = 'critical') AS critical FROM cases WHERE id = ?1 AND org_id = ?2`,
          params: [caseId, await orgId()],
        })
      ).results?.[0];
      if (!row) return null;
      return {
        status: row.status as CaseState["status"],
        verdict: (row.verdict ?? null) as Verdict | null,
        costUsd: num(row.cost),
        critical: num(row.critical) === 1,
        createdAt: String(row.created_at),
      };
    },
    async insertRun(r) {
      await execute({
        sql: `INSERT INTO eval_runs (id, commit_sha, set_version, mode, status, selected, cap_usd, started_at, finished_at, cost_usd) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 0)`,
        params: [r.id, r.commitSha, r.setVersion, r.mode, r.status, r.selected, r.capUsd, r.startedAt],
      });
    },
    async putResult(r) {
      await execute({
        sql: `INSERT INTO eval_results (run_id, sample, case_id, outcome, label, category, verdict, ms, cost_usd, critical_found) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT (run_id, sample) DO UPDATE SET case_id = excluded.case_id, outcome = excluded.outcome, verdict = excluded.verdict, ms = excluded.ms, cost_usd = excluded.cost_usd, critical_found = excluded.critical_found`,
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
        })),
      };
    },
  };
}

// ---- the command ------------------------------------------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function main(argv: string[], environment: NodeJS.ProcessEnv = process.env): Promise<number> {
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
  const db = liveDb(environment.EVAL_ORG_NAME ?? "IsItLegit Eval", (s) => execute({ sql: inline(s), params: [] }));
  if (options.verify) {
    const result = await verifyRun(db, options.verify);
    for (const p of result.problems) console.error(`eval:run: ${p}`);
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
  const { samples, setVersion } = selectSamples(join(ROOT, "eval/sets"), options.sets, options.limit);
  const api = liveApi(environment.EVAL_BASE_URL ?? "https://app.isitlegit.co.za", cookie ?? "");
  const env: Env = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    id: () => randomUUID(),
    journalDir: join(ROOT, "build/eval-runs"),
    bytes: (file) => readFileSync(file),
  };
  const result = await runEval({ samples, setVersion, options, api, db, env, resume: options.resume });
  for (const p of result.problems) console.error(`eval:run: ${p}`);
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
