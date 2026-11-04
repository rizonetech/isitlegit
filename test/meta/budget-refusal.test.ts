import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { d1Budget, reserve } from "../../src/meta/budget";
import { DAY_CAP_USD } from "../../src/meta/caps";
import { metaResponses } from "../../src/meta/client";
import { sastDay } from "../../src/meta/day";
import { BudgetExceeded } from "../../src/meta/guard";
import { capEvent, sendCapNotice, sendPendingCapNotices } from "../../src/meta/notice";
import { stubSmtp2go } from "../auth/helpers";

// The real client on the Worker's real budget (D03 T01 §2): with the day's cap spent, a call is refused before
// anything is sent, and it is not retried.
const db = (env as unknown as Env).DB;
beforeEach(async () => {
  await db.prepare("DELETE FROM model_spend").run();
});

describe("the Worker's budget", () => {
  it("refuses a call once today's cap is spent, sending nothing", async () => {
    const day = sastDay();
    await reserve(db, {
      at: new Date().toISOString(),
      day,
      source: "worker",
      caller: "earlier",
      model: "muse-spark-1.3",
      caseId: null,
      attempt: 1,
      estimateUsd: DAY_CAP_USD,
    });
    const sent: string[] = [];
    const error = await metaResponses(
      { model: "muse-spark-1.3", input: "hello", max_output_tokens: 16 },
      {
        env: { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" },
        budget: d1Budget(db, { caller: "checks", caseId: "case-1" }),
        owner: { kind: "case", caseId: "case-1", step: "checks" },
        fetch: (async (input: RequestInfo | URL) => {
          sent.push(String(input));
          return new Response("{}");
        }) as typeof fetch,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceeded);
    expect([(error as BudgetExceeded).cap, (error as BudgetExceeded).model]).toEqual(["day", "muse-spark-1.3"]);
    expect(sent).toEqual([]);
    // The earlier spend, and the refused attempt's own record costing nothing (D03 T01 §3 final review).
    const rows = await db
      .prepare(
        "SELECT outcome, error_class, cost_certainty, actual_usd, case_id FROM model_spend WHERE outcome = 'refused'",
      )
      .all();
    expect(rows.results).toEqual([
      { outcome: "refused", error_class: "budget:day", cost_certainty: "none", actual_usd: 0, case_id: "case-1" },
    ]);
  });
});

describe("the operator's notice for a cap event", () => {
  const spendToday = async (usd: number) =>
    reserve(db, {
      at: new Date().toISOString(),
      day: sastDay(),
      source: "worker",
      caller: "earlier",
      model: "muse-spark-1.3",
      caseId: null,
      attempt: 1,
      estimateUsd: usd,
    });
  const noticeEnv = { DB: db, SMTP2GO_API_KEY: `api-${"k".repeat(32)}`, OPERATOR_EMAIL: "hostmaster@rizonetech.com" };

  it("sends one notice however many refusals race or Worker instances see them, and another on the next day", async () => {
    await db.prepare("DELETE FROM mail_sends WHERE send_key LIKE 'budget:%'").run();
    await spendToday(DAY_CAP_USD);
    const smtp = stubSmtp2go();
    try {
      const pending: Promise<unknown>[] = [];
      const budget = () =>
        d1Budget(db, {
          caller: "checks",
          notify: (cap, model, day) => sendCapNotice(noticeEnv, cap, model, day),
          waitUntil: (p) => pending.push(p),
        });
      // Three refusals at once on one instance, then one on a fresh instance.
      await Promise.all(
        [1, 2, 3].map(() =>
          budget()
            .reserve("muse-spark-1.3", 1, 1)
            .catch(() => null),
        ),
      );
      await budget()
        .reserve("muse-spark-1.3", 1, 1)
        .catch(() => null);
      await Promise.all(pending);
      expect(smtp.sends).toHaveLength(1);
      expect(smtp.sends[0]?.subject).toBe("IsItLegit: the Meta day cap refused a call");
      // The next day is a new event.
      await sendCapNotice(noticeEnv, "day", "muse-spark-1.3", "2099-01-01");
      expect(smtp.sends).toHaveLength(2);
      expect(capEvent("day", "2099-01-01")).toBe("budget:day:2099-01-01");
    } finally {
      smtp.restore();
    }
  });

  it("retries a notice whose send failed at the next refusal", async () => {
    await db.prepare("DELETE FROM mail_sends WHERE send_key LIKE 'budget:%'").run();
    let answer: "refused" | "sent" = "refused";
    const smtp = stubSmtp2go(() => answer);
    try {
      await sendCapNotice(noticeEnv, "total", "muse-wonder-1.0", sastDay());
      expect(smtp.sends).toHaveLength(0);
      answer = "sent";
      await sendCapNotice(noticeEnv, "total", "muse-wonder-1.0", sastDay());
      expect(smtp.sends).toHaveLength(1);
      expect(smtp.sends[0]?.to).toBe("hostmaster@rizonetech.com");
    } finally {
      smtp.restore();
    }
  });
});

describe("the cron's alert for recorded cap events (completion review)", () => {
  it("alerts once for an event a local script and the Worker both recorded, and marks it", async () => {
    await db.prepare("DELETE FROM mail_sends WHERE send_key LIKE 'budget:%'").run();
    await db.prepare("DELETE FROM budget_events").run();
    const day = "2099-02-01";
    for (const _ of [1, 2])
      await db
        .prepare(
          "INSERT OR IGNORE INTO budget_events (event, cap, model, day, at) VALUES (?, 'day', 'muse-spark-1.3', ?, ?)",
        )
        .bind(capEvent("day", day), day, new Date().toISOString())
        .run();
    const smtp = stubSmtp2go();
    try {
      const env2 = { DB: db, SMTP2GO_API_KEY: `api-${"k".repeat(32)}`, OPERATOR_EMAIL: "hostmaster@rizonetech.com" };
      expect(await sendPendingCapNotices(env2)).toBe(1);
      expect(await sendPendingCapNotices(env2)).toBe(0);
      expect(smtp.sends).toHaveLength(1);
      const row = await db.prepare("SELECT notified_at FROM budget_events").first<{ notified_at: string | null }>();
      expect(row?.notified_at).not.toBeNull();
    } finally {
      smtp.restore();
    }
  });
});
