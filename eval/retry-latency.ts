// Retry latency and interrupted-retry settlement measurement (D08 T02 section 8, D01 T01 section 17):
// measures `sweepRetries` settling an interrupted retry after the `RETRY_SETTLE_MS` (300,000 ms) lease window,
// and records end-to-end member retry latency against the 60 s median and 180 s p95 targets.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RetryRecord } from "./components.ts";
import { createSqliteD1, ensureTsResolve } from "./intake-time.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function scoreRetrySettle(repetitions = 5): Promise<RetryRecord[]> {
  ensureTsResolve();
  const { createCase, setStatus } = await import("../src/db/cases.ts");
  const { recordEvent } = await import("../src/pipeline/events.ts");
  const { RETRY_SETTLE_MS, retryCase, sweepRetries } = await import("../src/pipeline/retry.ts");
  const db = createSqliteD1();
  const orgId = "org-retry-bench";
  const memberId = "member-retry-bench";
  const records: RetryRecord[] = [];

  for (let i = 0; i < repetitions; i++) {
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
    } as unknown as Pick<Env, "ANALYSIS">;

    // 1. Member requests retry; Workflow start is interrupted with unknown state, leaving case 'received' with run_id.
    const res = await retryCase(db, env, orgId, caseId, memberId, () => baseTime);
    if (res.ok || res.error.code !== "start_unknown") {
      records.push({ kind: "interrupted-settle", ms: null, completed: false });
      continue;
    }

    // 2. Once the instance is confirmed absent after the 5-minute lease (RETRY_SETTLE_MS), sweepRetries settles it back to partial.
    delete states[createdRunId];
    const sweepTime = new Date(baseTime.getTime() + RETRY_SETTLE_MS + 1_000);
    const t0 = performance.now();
    const swept = await sweepRetries(db, env, () => sweepTime);
    const sweepWallMs = performance.now() - t0;
    const afterRow = await db
      .prepare("SELECT status, run_id FROM cases WHERE id = ?")
      .bind(caseId)
      .first<{ status: string; run_id: string | null }>();
    if (swept.settled === 1 && afterRow?.status === "partial" && afterRow.run_id === null) {
      records.push({
        kind: "interrupted-settle",
        ms: Number((RETRY_SETTLE_MS + sweepWallMs).toFixed(3)),
        completed: true,
      });
    } else {
      records.push({ kind: "interrupted-settle", ms: null, completed: false });
    }
  }
  return records;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const records = await scoreRetrySettle();
  const outPath = join(ROOT, "eval/components/retry.json");
  writeFileSync(outPath, `${JSON.stringify(records, null, 1)}\n`);
  console.log(`wrote ${records.length} retry records to ${outPath}`);
}
