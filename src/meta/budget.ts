// The Meta Model API budget guard (D03 T01 §2; design spec section 11): every transport attempt is reserved at a
// conservative estimate before it is sent and settled at its reported cost after, against the caps in ./caps.ts. One
// authority, `model_spend` in D1, shared with the local callers (scripts/lib/meta-budget.ts) through the same statements
// (./budget-sql.ts).

import type { Reservation, Statement } from "./budget-sql";
import {
  inline as _inline,
  capEventStatement,
  reserveStatement,
  settleStatement,
  spentStatement,
  uncertainStatement,
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
  for (let tries = 0; tries < ATTEMPTS; tries++) {
    const inserted = await run(db, reserveStatement(row, DAY_CAP_USD, totalLimitFor(row.day))).run();
    if (inserted.meta.changes === 1) return { ok: true, id: row.id };
    const spent = await run(db, spentStatement(row.day)).first<{ day_usd: number; total_usd: number }>();
    cap = refusingCap(spent?.day_usd ?? 0, spent?.total_usd ?? 0, row.estimateUsd, row.day);
    if (cap) return { ok: false, cap };
  }
  // Refused every time yet never by a named cap on a read: the spend moves under it; the day cap is the safe answer.
  return { ok: false, cap: cap ?? "day" };
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
    async reserve(model, estimateUsd, attempt, id) {
      const now = new Date();
      const reserved = await reserve(db, {
        ...(id ? { id } : {}),
        at: now.toISOString(),
        day: sastDay(now),
        source: "worker",
        caller: who.caller,
        model,
        caseId: who.caseId ?? null,
        attempt,
        estimateUsd,
      });
      if (!reserved.ok) {
        const day = sastDay(now);
        // Recorded first, so the cron sends the alert even if this instance's own send never finishes; a record that
        // cannot be written still leaves this instance's own send below.
        await recordCapEvent(db, reserved.cap, model, day, now.toISOString());
        if (who.notify) {
          const notice = who.notify(reserved.cap, model, sastDay(now)).catch(() => {});
          who.waitUntil?.(notice);
        }
        throw new BudgetExceeded(reserved.cap, model);
      }
      return reserved.id;
    },
    settle: async (id, actualUsd) => {
      await settle(db, id, actualUsd);
    },
    uncertain: async (id) => {
      await markUncertain(db, id);
    },
  };
}
