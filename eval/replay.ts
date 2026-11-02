// The replay command (D08 T02 section 12): `pnpm eval:replay --run <id>` replays an incomplete run's failed
// cases under the deployment in place when it starts. Each replayed case is resubmitted with the multipart
// replayRunId field (D01 T01 section 22), so the eval organisation's claim is scoped to the replay run and the
// original run's stored queue is untouched. Metrics then report the original run and each replay run, a replay
// result replacing its original only when complete (see mergeReplayResults in eval/metrics.ts).
import { randomUUID } from "node:crypto";
import type { ResultRow, RunRow } from "./run.ts";

export function replayableResults(results: ResultRow[]): ResultRow[] {
  return results.filter((r) => r.outcome !== "done");
}

export type ReplayClients = {
  readRun: (id: string) => Promise<{ run: RunRow; results: ResultRow[] } | null>;
  createRun: (run: RunRow) => Promise<void>;
  resubmit: (result: ResultRow, replayRunId: string) => Promise<ResultRow>;
  putResult: (row: ResultRow) => Promise<void>;
  finishRun: (id: string, status: string, costUsd: number) => Promise<void>;
  newId: () => string;
  now: () => string;
};

export type ReplayOutcome = {
  status: "complete" | "incomplete" | "refused";
  replayRunId: string | null;
  replayed: number;
  stillIncomplete: number;
  problems: string[];
};

export async function runReplay(originalId: string, clients: ReplayClients): Promise<ReplayOutcome> {
  const stored = await clients.readRun(originalId);
  if (!stored)
    return {
      status: "refused",
      replayRunId: null,
      replayed: 0,
      stillIncomplete: 0,
      problems: [`no stored run ${originalId}`],
    };
  const queue = replayableResults(stored.results);
  if (queue.length === 0)
    return {
      status: "refused",
      replayRunId: null,
      replayed: 0,
      stillIncomplete: 0,
      problems: [`run ${originalId} has no incomplete case to replay`],
    };
  const replayRunId = clients.newId();
  await clients.createRun({
    ...stored.run,
    id: replayRunId,
    mode: `replay:${originalId}`,
    status: "running",
    startedAt: clients.now(),
    finishedAt: null,
    costUsd: 0,
  });
  let stillIncomplete = 0;
  let cost = 0;
  for (const result of queue) {
    const replayed = await clients.resubmit(result, replayRunId);
    cost += replayed.costUsd;
    await clients.putResult({ ...replayed, runId: replayRunId });
    if (replayed.outcome !== "done") stillIncomplete++;
  }
  const status = stillIncomplete === 0 ? "complete" : "incomplete";
  await clients.finishRun(replayRunId, status, cost);
  return { status, replayRunId, replayed: queue.length, stillIncomplete, problems: [] };
}

export const REPLAY_USAGE = "usage: pnpm eval:replay --run <run id> (exit 0 complete, 2 incomplete, 3 refused)";

export function parseReplayArgs(argv: string[]): { runId: string } | { error: string } {
  let runId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run") runId = argv[++i] ?? null;
    else return { error: `unknown option ${argv[i]}` };
  }
  return runId ? { runId } : { error: "--run is required" };
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseReplayArgs(argv);
  if ("error" in parsed) {
    console.error(`eval:replay: ${parsed.error}\n${REPLAY_USAGE}`);
    return 3;
  }
  // Live replay spends under the runner's caps on the current deployment; it starts only with its stored run
  // read back, which the entry in eval/run.ts provides. This module is the orchestration and its tests.
  console.error(
    `eval:replay: live replay of ${parsed.runId} starts from the runner entry (eval/run.ts replay mode); no upload sent by this command yet.`,
  );
  return 3;
}

if (process.argv[1] && import.meta.filename === process.argv[1])
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`eval:replay: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );

export const newReplayId = () => randomUUID();
