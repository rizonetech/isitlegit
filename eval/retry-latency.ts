// Interrupted-retry settlement measurement (D08 T02 section 8, D01 T01 section 17):
// Local microbenchmark of `retryCase` interrupted (`start_unknown`) + `sweepRetries` rolling back to `partial`
// across the `RETRY_SETTLE_MS` = 300,000 ms lease window (injected clock), pre-populating records so an
// interrupted collector leaves unrun slots marked `completed: false` and never shrinks denominators.
// End-to-end member-request-to-result `retry` latency requires a live Workflow run and stays unmeasured locally.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, type RetryRecord } from "./components.ts";
import { createSqliteD1, importSrc, type SqliteD1 } from "./intake-time.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function scoreRetrySettle(
  repetitions = 5,
  opts?: { outPath?: string; failAt?: number },
): Promise<RetryRecord[]> {
  const { createCase, setStatus } = await importSrc<{
    createCase: (
      db: SqliteD1,
      input: { orgId: string; channel: string; headersAvailable: boolean },
    ) => Promise<{ ok: true; value: { id: string } } | { ok: false; error: { message: string } }>;
    setStatus: (db: SqliteD1, orgId: string, caseId: string, status: string) => Promise<unknown>;
  }>("src/db/cases.ts");
  const { recordEvent } = await importSrc<{
    recordEvent: (db: SqliteD1, caseId: string, step: string, status: string, detail?: unknown) => Promise<unknown>;
  }>("src/pipeline/events.ts");
  const { RETRY_SETTLE_MS, retryCase, sweepRetries } = await importSrc<{
    RETRY_SETTLE_MS: number;
    retryCase: (
      db: SqliteD1,
      env: unknown,
      orgId: string,
      caseId: string,
      memberId: string,
      now: () => Date,
    ) => Promise<{ ok: true } | { ok: false; error: { code: string } }>;
    sweepRetries: (db: SqliteD1, env: unknown, now: () => Date) => Promise<{ settled: number }>;
  }>("src/pipeline/retry.ts");
  const db = createSqliteD1();
  const orgId = "org-retry-bench";
  const memberId = "member-retry-bench";
  const provenance =
    "local microbenchmark: retryCase(start_unknown) + sweepRetries rollback on node:sqlite D1 (injected clock for RETRY_SETTLE_MS lease window; live Workflow retry latency not measured locally)";

  const records: RetryRecord[] = Array.from({ length: repetitions }, () => ({
    kind: "interrupted-settle" as const,
    ms: null,
    completed: false,
    leaseWindowMs: RETRY_SETTLE_MS,
    expectedTotal: repetitions,
    provenance,
  }));

  const persist = () => {
    if (opts?.outPath) {
      atomicWriteJson(opts.outPath, records);
    }
  };

  persist();

  for (let i = 0; i < repetitions; i++) {
    try {
      if (opts?.failAt === i) throw new Error("simulated settle collector interruption");
      const created = await createCase(db, { orgId, channel: "email", headersAvailable: false });
      if (!created.ok) throw new Error(created.error.message);
      const caseId = created.value.id;
      await setStatus(db, orgId, caseId, "running");
      await setStatus(db, orgId, caseId, "partial");
      await recordEvent(db, caseId, "parse", "failed", { errorClass: "ParseError" });

      const states: Record<string, string | "unknown"> = { [caseId]: "errored" };
      const baseTime = new Date("2026-11-02T12:00:00.000Z");
      let createdRunId = "";
      const env = {
        ANALYSIS: {
          create: async ({ id }: { id: string }) => {
            createdRunId = id;
            states[id] = "unknown";
            throw new Error("network interrupted during create");
          },
          get: async (id: string) => {
            const st = states[id];
            if (st === "unknown") throw new Error("temporary status error");
            if (!st) throw new Error("instance.not_found");
            return { status: async () => ({ status: st }) };
          },
        },
      };

      const t0 = performance.now();
      // 1. Member requests retry; Workflow start is interrupted with unknown state, leaving case 'received' with run_id.
      const res = await retryCase(db, env, orgId, caseId, memberId, () => baseTime);
      if (res.ok || res.error.code !== "start_unknown") {
        persist();
        continue;
      }

      // 2. Once the instance is confirmed absent after RETRY_SETTLE_MS, sweepRetries settles it back to partial.
      delete states[createdRunId];
      const sweepTime = new Date(baseTime.getTime() + RETRY_SETTLE_MS + 1);
      const swept = await sweepRetries(db, env, () => sweepTime);
      const wallMs = Number((performance.now() - t0).toFixed(3));
      const afterRow = await db
        .prepare("SELECT status, run_id FROM cases WHERE id = ?")
        .bind(caseId)
        .first<{ status: string; run_id: string | null }>();
      if (swept.settled === 1 && afterRow?.status === "partial" && afterRow.run_id === null) {
        records[i] = {
          kind: "interrupted-settle",
          ms: wallMs,
          completed: true,
          leaseWindowMs: RETRY_SETTLE_MS,
          expectedTotal: repetitions,
          provenance,
        };
      }
    } catch {
      // keep pre-populated incomplete slot
    }
    persist();
  }
  return records;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const outPath = join(ROOT, "eval/components/retry.json");
  const records = await scoreRetrySettle(5, { outPath });
  console.log(`wrote ${records.length} retry records to ${outPath}`);
}
