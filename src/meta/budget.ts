// The Meta Model API budget guard (D03 T01 §2; design spec section 11): every transport attempt is reserved at a
// conservative estimate before it is sent and settled at its reported cost after, against the caps in ./caps.ts. One
// authority, `model_spend` in D1, shared with the local callers (scripts/lib/meta-budget.ts) through the same statements
// (./budget-sql.ts).

import type { Reservation, Statement } from "./budget-sql";
import {
  inline as _inline,
  cachedStatement,
  capEventStatement,
  costStatement,
  ownerColumns,
  refusedStatement,
  reserveStatement,
  settleStatement,
  spentStatement,
  uncertainStatement,
  unsettledStatement,
} from "./budget-sql";
import { capEvent, DAY_CAP_USD, refusingCap, totalLimitFor } from "./caps";

export { type Bound, costUsd, estimateUsd, type Usage } from "./pricing";

import { sastDay } from "./day";
import { type Budget, BudgetExceeded, type Cap } from "./guard";

export { BudgetExceeded, type Cap };

const run = (db: D1Database, s: Statement) => db.prepare(s.sql).bind(...s.params);

export type Reserved = { ok: true; id: string } | { ok: false; cap: Cap };

// Reserves one attempt, or says which cap refused it: the day cap, the reserve (a total within the cap but into the
// held-back US$30 on another day), or the total cap itself.
// A refusal is named from a second read; when a settlement landed in between and no cap refuses it any more, the
// reservation is tried again (a few times), so a cap is never named that did not refuse it (round 1).
const ATTEMPTS = 3;

export async function reserve(db: D1Database, r: Omit<Reservation, "id"> & { id?: string }): Promise<Reserved> {
  const row: Reservation = { ...r, id: r.id ?? crypto.randomUUID() };
  let cap: Cap | null = null;
  for (let tries = 0; tries < ATTEMPTS && !cap; tries++) {
    const inserted = await run(db, reserveStatement(row, DAY_CAP_USD, totalLimitFor(row.day))).run();
    if (inserted.meta.changes === 1) return { ok: true, id: row.id };
    const spent = await run(db, spentStatement(row.day)).first<{ day_usd: number; total_usd: number }>();
    cap = refusingCap(spent?.day_usd ?? 0, spent?.total_usd ?? 0, row.estimateUsd, row.day);
  }
  // Refused every time yet never by a named cap on a read: the spend moves under it; the day cap is the safe answer.
  const refused = cap ?? "day";
  // The refused attempt's own record, costing nothing (D03 T01 §3 final review); one that cannot be written is logged,
  // never a reason to send the call.
  await run(db, refusedStatement(row, `budget:${refused}`))
    .run()
    .catch(() => console.error(JSON.stringify({ event: "budget", outcome: "refusal-unrecorded", cap: refused })));
  return { ok: false, cap: refused };
}

// The cap's event for the cron's alert, tried three times; whether it was written.
export async function recordCapEvent(db: D1Database, cap: Cap, model: string, day: string, at: string) {
  for (let tries = 0; tries < 3; tries++) {
    const written = await run(db, capEventStatement(capEvent(cap, day), cap, model, day, at))
      .run()
      .then(
        () => true,
        () => false,
      );
    if (written) return true;
  }
  return false;
}

export const settle = (db: D1Database, id: string, actualUsd: number, at = new Date().toISOString()) =>
  run(db, settleStatement(id, actualUsd, at)).run();

export const markUncertain = (db: D1Database, id: string) => run(db, uncertainStatement(id)).run();

export { _inline as inline };

// The Worker's budget for one caller (a Workflow step, its case): each attempt reserved in D1 on today's SAST day. A
// refusal starts the operator's notice for its cap event (./notice.ts) and does not wait for it; `waitUntil` keeps the
// send alive past the refusal where the caller has one.
export function d1Budget(
  db: D1Database,
  who: {
    caller: string;
    caseId?: string | null;
    notify?: (cap: Cap, model: string, day: string) => Promise<unknown>;
    waitUntil?: (promise: Promise<unknown>) => void;
  },
): Budget {
  return {
    async reserve(model, estimateUsd, attempt, id, call) {
      const now = new Date();
      const owned = ownerColumns(call);
      const reserved = await reserve(db, {
        ...(id ? { id } : {}),
        ...owned,
        at: now.toISOString(),
        day: sastDay(now),
        source: "worker",
        caller: who.caller,
        model,
        caseId: owned.caseId ?? who.caseId ?? null,
        attempt,
        estimateUsd,
      });
      if (!reserved.ok) {
        const day = sastDay(now);
        // Recorded first, so the cron sends the alert even if this instance's own send never finishes; a record that
        // cannot be written still leaves this instance's own send below.
        const recorded = await recordCapEvent(db, reserved.cap, model, day, now.toISOString());
        // Neither recorded nor sent here: logged, so the lost alert shows in the Worker's logs (final review).
        if (!recorded && !who.notify)
          console.error(JSON.stringify({ event: "budget", outcome: "cap-event-unrecorded", cap: reserved.cap }));
        if (who.notify) {
          const notice = who.notify(reserved.cap, model, sastDay(now)).catch(() => {});
          who.waitUntil?.(notice);
        }
        throw new BudgetExceeded(reserved.cap, model);
      }
      return reserved.id;
    },
    settle: async (id, actualUsd, record) => {
      await run(db, settleStatement(id, actualUsd, new Date().toISOString(), record)).run();
    },
    uncertain: async (id, record) => {
      await run(db, uncertainStatement(id, record)).run();
    },
    refused: async (model, call, errorClass) => {
      const now = new Date();
      const owned = ownerColumns(call);
      await run(
        db,
        refusedStatement(
          {
            ...owned,
            id: crypto.randomUUID(),
            at: now.toISOString(),
            day: sastDay(now),
            source: "worker",
            caller: who.caller,
            model,
            caseId: owned.caseId ?? who.caseId ?? null,
            attempt: 1,
            estimateUsd: 0,
          },
          errorClass,
        ),
      ).run();
    },
    cached: async (model, call, ms) => {
      const now = new Date();
      const owned = ownerColumns(call);
      await run(
        db,
        cachedStatement(
          {
            ...owned,
            id: crypto.randomUUID(),
            at: now.toISOString(),
            day: sastDay(now),
            source: "worker",
            caller: who.caller,
            model,
            caseId: owned.caseId ?? who.caseId ?? null,
            attempt: 1,
            estimateUsd: 0,
          },
          ms,
        ),
      ).run();
    },
  };
}

// The cron's sweep (D03 T01 §3): a reservation older than an hour whose settlement was never written is marked an
// unsettled error, still counted at its estimate, so an incomplete record shows and is never lost.
export async function markUnsettled(db: D1Database, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - 60 * 60_000).toISOString();
  return (await run(db, unsettledStatement(before)).run()).meta.changes ?? 0;
}

// A case's or a monitor run's model cost, its parts apart: the measured total, the estimated total (usage missing, an
// answer lost, a settlement never written) and how many attempts that is; an estimate is never added into the measured.
export type CaseCost = { measuredUsd: number; estimatedUsd: number; estimatedCalls: number; attempts: number };

export async function caseCost(db: D1Database, owner: { caseId: string } | { monitorRun: string }): Promise<CaseCost> {
  const row = await run(db, costStatement(owner)).first<{
    measured_usd: number;
    estimated_usd: number;
    estimated_calls: number;
    attempts: number;
  }>();
  return {
    measuredUsd: row?.measured_usd ?? 0,
    estimatedUsd: row?.estimated_usd ?? 0,
    estimatedCalls: row?.estimated_calls ?? 0,
    attempts: row?.attempts ?? 0,
  };
}
