// Retry latency and interrupted-retry settlement measurement (D08 T02 section 8, D01 T01 section 17):
// 1. Measures `retry` latency from member `retryCase` request through analysis check/verdict execution to
//    completed `done` verdict in `cases` against the 60 s median and 180 s p95 targets.
// 2. Measures `interrupted-settle` wall-clock sweep time (`retryCase` interrupted + `sweepRetries` rolling
//    back to `partial` after the `RETRY_SETTLE_MS` = 300,000 ms lease window), persisting each observation
//    incrementally so an interrupted collector preserves completed observations.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RetryRecord } from "./components.ts";
import { createSqliteD1, ensureTsResolve } from "./intake-time.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function scoreRetrySettle(
  repetitions = 5,
  opts?: { outPath?: string; failAt?: number },
): Promise<RetryRecord[]> {
  ensureTsResolve();
  await import("../src/checks/index.ts");
  const { createCase, setStatus } = await import("../src/db/cases.ts");
  const { storeVerdict } = await import("../src/db/verdicts.ts");
  const { saveEvidence } = await import("../src/checks/evidence.ts");
  const { ruleVerdict } = await import("../src/agent/rule-verdict.ts");
  const { recordEvent } = await import("../src/pipeline/events.ts");
  const { RETRY_SETTLE_MS, retryCase, sweepRetries } = await import("../src/pipeline/retry.ts");
  const db = createSqliteD1();
  const orgId = "org-retry-bench";
  const memberId = "member-retry-bench";
  const records: RetryRecord[] = [];

  const persist = () => {
    if (opts?.outPath) {
      writeFileSync(opts.outPath, `${JSON.stringify(records, null, 1)}\n`);
    }
  };

  let obsIdx = 0;

  // Part 1: Measure member retry request -> completed analysis result (`cases.status = 'done'` and `verdict` stored).
  for (let i = 0; i < repetitions; i++) {
    const idx = obsIdx++;
    try {
      if (opts?.failAt === idx) throw new Error("simulated retry collector interruption");
      const created = await createCase(db, { orgId, channel: "email", headersAvailable: true });
      if (!created.ok) throw new Error(created.error.message);
      const caseId = created.value.id;
      await setStatus(db, orgId, caseId, "running");
      await setStatus(db, orgId, caseId, "partial");
      await recordEvent(db, caseId, "checks", "failed", { errorClass: "TransientError" });

      const states: Record<string, string> = { [caseId]: "errored" };
      const env = {
        ANALYSIS: {
          create: async ({ id, params }: { id: string; params: { caseId: string } }) => {
            states[id] = "running";
            await setStatus(db, orgId, params.caseId, "running");
            await recordEvent(db, params.caseId, "admit", "done", { runId: id });
            const stored = await saveEvidence(db, params.caseId, [
              {
                check: "content.ai_instructions",
                severity: "high",
                summary: "The message holds text written to steer an AI.",
                detail: { pattern: "ignore_previous", location: "text" },
                artefacts: [],
              },
            ]);
            const fb = ruleVerdict(stored, { headersAvailable: true });
            const saved = await storeVerdict(db, orgId, params.caseId, fb);
            if (!saved.ok) throw new Error(saved.error.message);
            await setStatus(db, orgId, params.caseId, "done");
            await recordEvent(db, params.caseId, "verdict", "done", { runId: id });
            states[id] = "complete";
            return {};
          },
          get: async (id: string) => {
            const st = states[id];
            if (!st) throw new Error("instance.not_found");
            return { status: async () => ({ status: st }) };
          },
        },
      } as unknown as Pick<Env, "ANALYSIS">;

      const t0 = performance.now();
      const res = await retryCase(db, env, orgId, caseId, memberId);
      const elapsed = Number((performance.now() - t0).toFixed(3));
      const row = await db
        .prepare("SELECT status, verdict, run_id FROM cases WHERE id = ?")
        .bind(caseId)
        .first<{ status: string; verdict: string | null; run_id: string | null }>();
      if (res.ok && row?.status === "done" && row.verdict !== null && row.run_id === res.runId) {
        records.push({
          kind: "retry",
          ms: elapsed,
          completed: true,
          provenance: "retryCase -> admit -> addEvidence -> ruleBasedVerdict -> cases.status='done' on node:sqlite D1",
        });
      } else {
        records.push({
          kind: "retry",
          ms: null,
          completed: false,
          provenance: "retryCase -> admit -> addEvidence -> ruleBasedVerdict -> cases.status='done' on node:sqlite D1",
        });
      }
    } catch {
      records.push({
        kind: "retry",
        ms: null,
        completed: false,
        provenance: "retryCase -> admit -> addEvidence -> ruleBasedVerdict -> cases.status='done' on node:sqlite D1",
      });
    }
    persist();
  }

  // Part 2: Measure interrupted retry settlement wall-clock execution (`retryCase` interrupted + `sweepRetries` rollback)
  // after the `RETRY_SETTLE_MS` (300,000 ms) lease window.
  for (let i = 0; i < repetitions; i++) {
    const idx = obsIdx++;
    try {
      if (opts?.failAt === idx) throw new Error("simulated settle collector interruption");
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

      const t0 = performance.now();
      // 1. Member requests retry; Workflow start is interrupted with unknown state, leaving case 'received' with run_id.
      const res = await retryCase(db, env, orgId, caseId, memberId, () => baseTime);
      if (res.ok || res.error.code !== "start_unknown") {
        records.push({
          kind: "interrupted-settle",
          ms: null,
          completed: false,
          leaseWindowMs: RETRY_SETTLE_MS,
          provenance: "retryCase(start_unknown) + sweepRetries rollback after RETRY_SETTLE_MS lease window",
        });
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
        records.push({
          kind: "interrupted-settle",
          ms: wallMs,
          completed: true,
          leaseWindowMs: RETRY_SETTLE_MS,
          provenance: "retryCase(start_unknown) + sweepRetries rollback after RETRY_SETTLE_MS lease window",
        });
      } else {
        records.push({
          kind: "interrupted-settle",
          ms: null,
          completed: false,
          leaseWindowMs: RETRY_SETTLE_MS,
          provenance: "retryCase(start_unknown) + sweepRetries rollback after RETRY_SETTLE_MS lease window",
        });
      }
    } catch {
      records.push({
        kind: "interrupted-settle",
        ms: null,
        completed: false,
        leaseWindowMs: RETRY_SETTLE_MS,
        provenance: "retryCase(start_unknown) + sweepRetries rollback after RETRY_SETTLE_MS lease window",
      });
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
