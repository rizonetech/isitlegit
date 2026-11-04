// Publishing an eval run (D08 T02 §4): the metrics report of a complete run is stored once in `eval_published` for the
// public results page, and, for a run of mode `full`, `eval/results-summary.json` is written from the same report (the
// site's home page reads it, `site/src/lib/results.ts`). The database row comes first and is immutable; the file is
// written temp-then-rename, so a failure leaves the previous valid file, and `republishSummary` rebuilds the file from
// the stored report, so a publication whose file write failed is repaired without a second row.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Report } from "./metrics.ts";

export const SUMMARY_PATH = "eval/results-summary.json";

export type Summary = {
  detectionRate: number;
  falseAlarmRate: number;
  // The median analysis time in seconds (server admission to verdict); the forward-to-reply time is measured by D09 T01 §1.
  medianSeconds: number;
  samples: number;
  runDate: string;
  runId: string;
};

export type PublishDb = {
  insertPublished(runId: string, mode: string, reportJson: string, at: string): Promise<void>;
  readPublished(runId: string): Promise<{ mode: string; reportJson: string; publishedAt: string } | null>;
  latestFull(): Promise<{ runId: string; reportJson: string; publishedAt: string } | null>;
};

// Why a report cannot be published: publication is not run completeness. The summary's contract is numeric, so the main
// detection rate, false-positive rate and median analysis time must be numbers, never an invented zero.
export function publishProblems(r: Report): string[] {
  const problems: string[] = [];
  if (!r.complete)
    problems.push(
      `the report is not complete (run ${r.run.status}, ${r.missing.length} missing, ${r.unmeasured.length} not measured)`,
    );
  if (r.main.detection.rate === null) problems.push("no main attack was selected, so detection is not measured");
  if (r.main.falsePositives.rate === null)
    problems.push("no main genuine sample was selected, so false positives are not measured");
  const median = r.main.analysisMs.median;
  if (median === null || median <= 0) problems.push("no main case has a measured analysis time above zero");
  if (r.main.attacks + r.main.genuine < 1) problems.push("no main sample was selected");
  return problems;
}

// The SAST date of the run's end (UTC+2, no daylight saving).
export const runDate = (r: Report) =>
  new Date(Date.parse(r.run.finishedAt ?? r.run.startedAt) + 2 * 60 * 60_000).toISOString().slice(0, 10);

export function summaryOf(r: Report): Summary {
  return {
    detectionRate: r.main.detection.rate as number,
    falseAlarmRate: r.main.falsePositives.rate as number,
    medianSeconds: (r.main.analysisMs.median as number) / 1000,
    samples: r.main.attacks + r.main.genuine,
    runDate: runDate(r),
    runId: r.run.id,
  };
}

// Why a summary file does not belong to a report: another run, or any figure that is not the report's own. The page and
// the summary are read from the same report, so a stale or foreign file shows as a difference here.
export function summaryProblems(summary: unknown, r: Report): string[] {
  const want = summaryOf(r);
  if (typeof summary !== "object" || summary === null) return ["the summary is not an object"];
  const got = summary as Record<string, unknown>;
  const problems: string[] = [];
  if (got.runId !== want.runId) problems.push(`the summary is of run ${String(got.runId)}, not ${want.runId}`);
  for (const key of ["detectionRate", "falseAlarmRate", "medianSeconds", "samples", "runDate"] as const)
    if (got[key] !== want[key]) problems.push(`${key} is ${String(got[key])}, the report's is ${want[key]}`);
  return problems;
}

// Written whole or not at all: a temporary file beside it, flushed, then renamed over the old one.
export function writeResultsSummary(file: string, summary: Summary): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`);
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export type Outcome = { code: number; message: string };

// The file always follows the latest published full report: it is written from what the database holds and checked
// against it again after the write, so two publications racing (each sees only its own row at first) both end on the
// latest one, never on whichever wrote last.
// One writer at a time across processes: an exclusive lock file beside the summary naming its owner (process id and a
// token), held over the read, the write and the recheck. The owner renews it while it works, so it never expires under
// a live writer; a lock is taken over only when its process is gone, and a release removes the lock only if it is still
// this writer's own.
export const LOCK_RENEW_MS = 10_000;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
export async function withSummaryLock<T>(
  file: string,
  work: () => Promise<T>,
  waitMs = 10_000,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<T> {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const mine = `${process.pid}:${randomUUID()}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeFileSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readOwner(lock);
      // A lock whose process is gone (or that names none and was never written) is a dead writer's.
      // An empty lock (a writer that died between creating and naming it) is dead once a minute old.
      if (owner !== null ? !alive(owner.pid) : staleEmpty(lock)) rmSync(lock, { force: true });
      else if (Date.now() >= until) throw new Error("another publication holds the summary lock");
      else await sleep(100);
    }
  }
  const renew = setInterval(() => {
    try {
      if (readFileSync(lock, "utf-8") === mine) utimesSync(lock, new Date(), new Date());
    } catch {
      // the lock is gone or another's: this writer's work is checked by its own recheck
    }
  }, LOCK_RENEW_MS);
  renew.unref();
  try {
    return await work();
  } finally {
    clearInterval(renew);
    try {
      if (readFileSync(lock, "utf-8") === mine) rmSync(lock, { force: true });
    } catch {
      // already gone
    }
  }
}

const staleEmpty = (lock: string) => {
  try {
    return Date.now() - statSync(lock).mtimeMs > 60_000;
  } catch {
    return false;
  }
};

function readOwner(lock: string): { pid: number } | null {
  try {
    const pid = Number.parseInt(readFileSync(lock, "utf-8").split(":")[0] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  } catch {
    return null;
  }
}

async function converge(db: PublishDb, file: string, write: (file: string, summary: Summary) => void): Promise<void> {
  await withSummaryLock(file, () => convergeLocked(db, file, write));
}

async function convergeLocked(
  db: PublishDb,
  file: string,
  write: (file: string, summary: Summary) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const latest = await db.latestFull();
    if (!latest) throw new Error("no full run is published");
    write(file, summaryOf(JSON.parse(latest.reportJson) as Report));
    const again = await db.latestFull();
    if (again?.runId === latest.runId) return;
  }
  throw new Error("the latest published run kept changing");
}

export async function publishRun(args: {
  report: Report;
  experiment?: { baselineRunId: string };
  db: PublishDb;
  root: string;
  now: () => Date;
  write?: (file: string, summary: Summary) => void;
}): Promise<Outcome> {
  const { report, db } = args;
  const write = args.write ?? writeResultsSummary;
  const problems = publishProblems(report);
  if (problems.length) return { code: 3, message: `run ${report.run.id} is not published: ${problems.join("; ")}` };
  try {
    if (report.run.mode.startsWith("ablate:")) {
      if (!args.experiment)
        return { code: 3, message: "experiment publication requires verified manifest attribution" };
      if (report.run.mode === "ablate:full") {
        if (args.experiment.baselineRunId !== report.run.id)
          return { code: 3, message: "experiment baseline identity mismatch" };
      } else {
        const saved = await db.readPublished(args.experiment.baselineRunId);
        const baseline = saved ? (JSON.parse(saved.reportJson) as Report) : null;
        if (
          !baseline ||
          saved?.mode !== "ablate:full" ||
          baseline.run.mode !== "ablate:full" ||
          baseline.run.id !== args.experiment.baselineRunId ||
          baseline.run.setVersion !== report.run.setVersion ||
          baseline.run.commit !== report.run.commit ||
          baseline.run.sets.join() !== report.run.sets.join() ||
          baseline.run.selected !== report.run.selected ||
          publishProblems(baseline).length
        )
          return { code: 3, message: "matching experiment full baseline is not published" };
      }
    }
    if (await db.readPublished(report.run.id))
      return {
        code: 3,
        message: `run ${report.run.id} is already published; its summary file is repaired with --republish-summary`,
      };
    // A complete replay of a full run is a full measurement (D08 T02 section 12): it publishes as one, with
    // its replay provenance kept in the stored report's run mode.
    const publishedMode = report.run.mode.startsWith("replay:") ? "full" : report.run.mode;
    await db.insertPublished(report.run.id, publishedMode, JSON.stringify(report), args.now().toISOString());
  } catch (error) {
    return { code: 1, message: `nothing was published: the database failed (${(error as Error).message})` };
  }
  if (report.run.mode !== "full" && !report.run.mode.startsWith("replay:"))
    return {
      code: 0,
      message: `run ${report.run.id} published (mode ${report.run.mode}); no summary file for an ablation`,
    };
  try {
    await converge(db, join(args.root, SUMMARY_PATH), write);
  } catch (error) {
    return {
      code: 1,
      message: `run ${report.run.id} is published in the database, but ${SUMMARY_PATH} could not be written (${(error as Error).message}); the file may hold an older run, so repair it with --republish-summary`,
    };
  }
  return { code: 0, message: `run ${report.run.id} published; ${SUMMARY_PATH} written` };
}

// The summary file rebuilt from the latest published full report, never from a second computation.
export async function republishSummary(args: {
  db: PublishDb;
  root: string;
  write?: (file: string, summary: Summary) => void;
}): Promise<Outcome> {
  const write = args.write ?? writeResultsSummary;
  let latest: Awaited<ReturnType<PublishDb["latestFull"]>>;
  try {
    latest = await args.db.latestFull();
  } catch (error) {
    return { code: 1, message: `the published reports could not be read (${(error as Error).message})` };
  }
  if (!latest) return { code: 3, message: "no full run is published" };
  const problems = publishProblems(JSON.parse(latest.reportJson) as Report);
  if (problems.length)
    return { code: 3, message: `the stored report of run ${latest.runId} is not publishable: ${problems.join("; ")}` };
  try {
    await converge(args.db, join(args.root, SUMMARY_PATH), write);
  } catch (error) {
    return {
      code: 1,
      message: `${SUMMARY_PATH} could not be written (${(error as Error).message}); the file may hold an older run, so run it again`,
    };
  }
  return { code: 0, message: `${SUMMARY_PATH} rebuilt from the latest published full run` };
}

type Execute = (s: {
  sql: string;
  params: (string | number | null)[];
}) => Promise<{ results?: Record<string, unknown>[] }>;

// The live adapter over the same `execute` the runner's database uses.
export function livePublishDb(execute: Execute): PublishDb {
  return {
    async insertPublished(runId, mode, reportJson, at) {
      await execute({
        sql: "INSERT INTO eval_published (run_id, mode, report_json, published_at) VALUES (?1, ?2, ?3, ?4)",
        params: [runId, mode, reportJson, at],
      });
    },
    async readPublished(runId) {
      const row = (
        await execute({
          sql: "SELECT mode, report_json, published_at FROM eval_published WHERE run_id = ?1",
          params: [runId],
        })
      ).results?.[0];
      return row
        ? { mode: String(row.mode), reportJson: String(row.report_json), publishedAt: String(row.published_at) }
        : null;
    },
    async latestFull() {
      const row = (
        await execute({
          sql: "SELECT run_id, report_json, published_at FROM eval_published WHERE mode = 'full' ORDER BY published_at DESC, run_id DESC LIMIT 1",
          params: [],
        })
      ).results?.[0];
      return row
        ? { runId: String(row.run_id), reportJson: String(row.report_json), publishedAt: String(row.published_at) }
        : null;
    },
  };
}
