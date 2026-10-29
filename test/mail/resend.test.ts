import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCase, setStatus } from "../../src/db/cases";
import { storeVerdict } from "../../src/db/verdicts";
import { RESEND_RUNS, resendRequested } from "../../src/mail/resend";
import { settleStatement } from "../../src/mail/settle";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";
import { STUB_VERDICT } from "../../src/pipeline/analysis-workflow";
import { recordEvent } from "../../src/pipeline/events";

// D01 T02 §8: a reply the operator settled failed with --resend, sent again by the Worker's cron from its case.
const ORG = "org-resend";
// A demo alias, which the allowlist admits as a reply's recipient.
const FORWARDER = "member@demo.isitlegit.co.za";
const CLAIMED = "2026-10-29T08:00:00.000Z";

type Sent = { to: string[]; subject: string; text_body: string };
function stubSmtp2go(answer: (body: Sent) => "sent" | "refused" | "silent" = () => "sent") {
  const requests: Sent[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== SMTP2GO_URL) return real(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as Sent;
    requests.push(body);
    if (answer(body) === "silent") throw new DOMException("timed out", "TimeoutError");
    if (answer(body) === "refused")
      return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
    return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${requests.length}` } });
  });
  return requests;
}
afterEach(() => vi.restoreAllMocks());
const mutedLogs = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

// A finished case with a forwarder, its reply row settled failed by the operator with --resend.
async function settledCase(status: "done" | "partial", forwardedBy: string | null = FORWARDER) {
  const made = await createCase(env.DB, {
    orgId: ORG,
    channel: "email",
    headersAvailable: false,
    forwardedBy,
    messageId: "<forward-88@fictional-recipient.example>",
  });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  await setStatus(env.DB, ORG, id, "running");
  if (status === "done") await storeVerdict(env.DB, ORG, id, { ...STUB_VERDICT, headline: "Resent-9 headline" });
  await setStatus(env.DB, ORG, id, status);
  await env.DB.prepare(
    "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, created_at, updated_at, claimed_at) VALUES (?, ?, ?, 'reply', ?, 'uncertain', 1, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), `reply:${id}`, id, "a".repeat(64), CLAIMED, CLAIMED, CLAIMED)
    .run();
  const settled = await env.DB.prepare(
    settleStatement(`reply:${id}`, "failed", CLAIMED, new Date().toISOString(), true),
  ).run();
  expect(settled.meta.changes).toBe(1);
  return id;
}
const rowOf = async (id: string) =>
  env.DB.prepare("SELECT status, resend_state, resend_runs FROM mail_sends WHERE send_key = ?")
    .bind(`reply:${id}`)
    .first<{ status: string; resend_state: string; resend_runs: number }>();

describe("resendRequested", () => {
  it("rebuilds a reply from its case and sends it once, and a second run sends nothing", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    const id = await settledCase("done");
    const first = await resendRequested(env);
    expect(first.done).toBeGreaterThanOrEqual(1);
    const mine = requests.filter((r) => r.to[0] === FORWARDER && r.text_body.includes("Resent-9 headline"));
    expect(mine).toHaveLength(1);
    expect(await rowOf(id)).toMatchObject({ status: "sent", resend_state: "done" });
    await resendRequested(env);
    expect(requests.filter((r) => r.text_body.includes("Resent-9 headline"))).toHaveLength(1);
  });

  it("sends once when two runs race for the same request", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    const id = await settledCase("done");
    await Promise.all([resendRequested(env), resendRequested(env)]);
    expect(requests.filter((r) => r.to[0] === FORWARDER && r.text_body.includes("Resent-9 headline"))).toHaveLength(1);
    expect(await rowOf(id)).toMatchObject({ status: "sent", resend_state: "done" });
  });

  it("rebuilds a partial case from its analysis failure, though a reply failure follows, with the day cap's advice", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    const id = await settledCase("partial");
    await recordEvent(env.DB, id, "checks", "failed", { errorClass: "budget:day:muse-spark-1.3", once: true });
    await recordEvent(env.DB, id, "reply", "failed", { errorClass: "ReplyNotSent", once: true });
    await resendRequested(env);
    const sent = requests.find(
      (r) => r.to[0] === FORWARDER && r.text_body.includes("Forward the message again tomorrow"),
    );
    expect(sent).toBeTruthy();
    expect(await rowOf(id)).toMatchObject({ status: "sent", resend_state: "done" });
  });

  it("ends a request the allowlist now refuses as done, with nothing sent", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    const id = await settledCase("done", "stranger@nowhere.example");
    await resendRequested(env);
    expect(requests.filter((r) => r.to[0] === "stranger@nowhere.example")).toEqual([]);
    expect((await rowOf(id))?.resend_state).toBe("done");
  });

  it("tries a failing send three runs, then leaves it exhausted with one alert, and a requeue after repair sends", async () => {
    mutedLogs();
    let down = true;
    const requests = stubSmtp2go((body) => (down && body.to[0] === FORWARDER ? "refused" : "sent"));
    const id = await settledCase("done");
    for (let run = 1; run <= RESEND_RUNS; run++) await resendRequested(env);
    expect(await rowOf(id)).toMatchObject({ resend_state: "exhausted", resend_runs: RESEND_RUNS });
    const alerts = requests.filter((r) => r.subject.includes(`reply:${id}`) && r.text_body.includes("requeue"));
    expect(alerts).toHaveLength(1);
    await resendRequested(env);
    expect(requests.filter((r) => r.subject.includes(`reply:${id}`))).toHaveLength(1);
    down = false;
    const { requeueStatement } = await import("../../src/mail/settle");
    expect((await env.DB.prepare(requeueStatement(`reply:${id}`, new Date().toISOString())).run()).meta.changes).toBe(
      1,
    );
    await resendRequested(env);
    expect(await rowOf(id)).toMatchObject({ status: "sent", resend_state: "done" });
  });

  it("leaves an accepted send whose outcome could not be written to the reconciler, never sending again", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    const id = await settledCase("done");
    const failing = new Proxy(env.DB, {
      get(target, name) {
        if (name === "prepare")
          return (sql: string) => {
            if (sql.startsWith("UPDATE mail_sends SET status = ?, provider_id")) throw new Error("D1 down");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    await resendRequested({ ...env, DB: failing });
    const row = await rowOf(id);
    expect(row?.resend_state).toBe("done");
    expect(row?.status).not.toBe("sent");
    await resendRequested(env);
    expect(requests.filter((r) => r.to[0] === FORWARDER && r.text_body.includes("Resent-9 headline"))).toHaveLength(1);
  });
});

describe("recordEvent", () => {
  it("keeps a Meta cap's class whole and still refuses one that is a message", async () => {
    const made = await createCase(env.DB, { orgId: ORG, channel: "upload", headersAvailable: false });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await recordEvent(env.DB, id, "checks", "failed", { errorClass: "budget:day:muse-spark-1.3" });
    await recordEvent(env.DB, id, "parse", "failed", { errorClass: "the sender wrote: pay now" });
    const rows = (
      await env.DB.prepare("SELECT step, error FROM case_events WHERE case_id = ? ORDER BY id").bind(id).all()
    ).results;
    expect(rows).toEqual([
      { step: "checks", error: "budget:day:muse-spark-1.3" },
      { step: "parse", error: "Error" },
    ]);
  });
});

describe("completion review (2026-10-29)", () => {
  const scheduled = async () => {
    const { default: worker } = await import("../../src/index");
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
    await worker.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry: () => {} }, env, ctx as never);
    await Promise.allSettled(waits);
  };
  const headlineSends = (requests: Sent[]) =>
    requests.filter((r) => r.to[0] === FORWARDER && r.text_body.includes("Resent-9 headline"));

  it("sends a requested reply through the Worker's own cron, and nothing once it was cancelled", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    await settledCase("done");
    await scheduled();
    expect(headlineSends(requests)).toHaveLength(1);
    const cancelledId = await settledCase("done");
    const { cancelStatement } = await import("../../src/mail/settle");
    expect(
      (await env.DB.prepare(cancelStatement(`reply:${cancelledId}`, new Date().toISOString())).run()).meta.changes,
    ).toBe(1);
    await scheduled();
    expect(headlineSends(requests)).toHaveLength(1);
    expect((await rowOf(cancelledId))?.resend_state).toBe("cancelled");
  });

  it("asks for a reply already settled failed without --resend (G1)", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    const id = await settledCase("done");
    await env.DB.prepare("UPDATE mail_sends SET resend_state = NULL WHERE send_key = ?").bind(`reply:${id}`).run();
    const { requeueStatement } = await import("../../src/mail/settle");
    expect((await env.DB.prepare(requeueStatement(`reply:${id}`, new Date().toISOString())).run()).meta.changes).toBe(
      1,
    );
    await resendRequested(env);
    expect(headlineSends(requests)).toHaveLength(1);
  });

  it("recovers a claim a stopped run left: asked for again while unsent, the reconciler's once it may have gone (G2)", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    const unsent = await settledCase("done");
    const maybe = await settledCase("done");
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    await env.DB.prepare("UPDATE mail_sends SET resend_state = 'sending', resend_at = ? WHERE send_key IN (?, ?)")
      .bind(old, `reply:${unsent}`, `reply:${maybe}`)
      .run();
    await env.DB.prepare("UPDATE mail_sends SET status = 'uncertain' WHERE send_key = ?").bind(`reply:${maybe}`).run();
    const report = await resendRequested(env);
    expect(report.recovered).toBe(2);
    expect(await rowOf(unsent)).toMatchObject({ status: "sent", resend_state: "done" });
    expect(await rowOf(maybe)).toMatchObject({ status: "uncertain", resend_state: "done" });
    expect(headlineSends(requests)).toHaveLength(1);
  });

  it("tries an exhaustion alert that did not go again on the next run, and sends it once (G3)", async () => {
    mutedLogs();
    let alertsDown = true;
    const requests = stubSmtp2go((body) =>
      body.to[0] === FORWARDER
        ? "refused"
        : alertsDown && body.subject.includes("could not be sent again")
          ? "refused"
          : "sent",
    );
    const id = await settledCase("done");
    for (let run = 1; run <= RESEND_RUNS; run++) await resendRequested(env);
    expect(
      (
        await env.DB.prepare("SELECT resend_alerted FROM mail_sends WHERE send_key = ?")
          .bind(`reply:${id}`)
          .first<{ resend_alerted: number }>()
      )?.resend_alerted,
    ).toBe(0);
    alertsDown = false;
    await resendRequested(env);
    await resendRequested(env);
    const delivered = requests.filter((r) => r.subject.includes(`reply:${id}`) && !r.to.includes(FORWARDER));
    expect(delivered.length).toBeGreaterThanOrEqual(2);
    expect(
      (
        await env.DB.prepare("SELECT resend_alerted FROM mail_sends WHERE send_key = ?")
          .bind(`reply:${id}`)
          .first<{ resend_alerted: number }>()
      )?.resend_alerted,
    ).toBe(1);
    const sentAlerts = (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_sends WHERE instr(send_key, ?) = 1 AND status = 'sent'")
        .bind(`resend-exhausted:reply:${id}@`)
        .first<{ n: number }>()
    )?.n;
    expect(sentAlerts).toBe(1);
  });

  it("sends every one of eleven requests in one run (G4)", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    await env.DB.prepare("UPDATE mail_sends SET resend_state = 'done' WHERE resend_state = 'requested'").run();
    for (let i = 0; i < 11; i++) await settledCase("done");
    await resendRequested(env);
    expect(headlineSends(requests)).toHaveLength(11);
  });

  it("says what a resend ended in, and the next step, in its status (G6)", async () => {
    mutedLogs();
    stubSmtp2go();
    const id = await settledCase("done", "stranger@nowhere.example");
    await resendRequested(env);
    const row = await env.DB.prepare("SELECT resend_outcome FROM mail_sends WHERE send_key = ?")
      .bind(`reply:${id}`)
      .first<{ resend_outcome: string }>();
    expect(row?.resend_outcome).toMatch(/^refused \(/);
    expect(row?.resend_outcome).not.toContain("stranger@");
  });
});

describe("round 1 (2026-10-29)", () => {
  it("tries a request once a run, so one run never spends all three tries", async () => {
    mutedLogs();
    const requests = stubSmtp2go((body) => (body.to[0] === FORWARDER ? "refused" : "sent"));
    const id = await settledCase("done");
    await resendRequested(env);
    expect(requests.filter((r) => r.to[0] === FORWARDER)).toHaveLength(1);
    expect(await rowOf(id)).toMatchObject({ resend_state: "requested", resend_runs: 1 });
  });

  it("tries the least recently tried exhaustion alert first, so uncertain ones never hold the rest back", async () => {
    mutedLogs();
    await env.DB.prepare("UPDATE mail_sends SET resend_alerted = 1 WHERE resend_state = 'exhausted'").run();
    const keys: string[] = [];
    for (let i = 0; i < 11; i++) {
      const key = `reply:01ALERT${String(i).padStart(19, "0")}`;
      keys.push(key);
      await env.DB.prepare(
        "INSERT INTO mail_sends (id, send_key, kind, to_hash, status, attempts, created_at, updated_at, claimed_at, resend_state, resend_runs, resend_at) VALUES (?, ?, 'reply', ?, 'failed', 1, ?, ?, ?, 'exhausted', 3, ?)",
      )
        .bind(
          crypto.randomUUID(),
          key,
          "a".repeat(64),
          CLAIMED,
          CLAIMED,
          CLAIMED,
          `2026-10-29T09:00:${String(i).padStart(2, "0")}.000Z`,
        )
        .run();
    }
    const requests = stubSmtp2go(() => "silent");
    await resendRequested(env);
    await resendRequested(env);
    const tried = new Set(requests.map((r) => keys.find((k) => r.subject.includes(k))).filter(Boolean));
    expect(tried.size).toBe(11);
  });

  it("asks again for a resend that ended uncertain and was then settled failed", async () => {
    const { requeueStatement } = await import("../../src/mail/settle");
    const id = await settledCase("done");
    await env.DB.prepare("UPDATE mail_sends SET resend_state = 'done' WHERE send_key = ?").bind(`reply:${id}`).run();
    expect((await env.DB.prepare(requeueStatement(`reply:${id}`, new Date().toISOString())).run()).meta.changes).toBe(
      1,
    );
    expect((await rowOf(id))?.resend_state).toBe("requested");
  });

  it("resends the stored verdict of a case whose only failure was delivering its reply", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    const made = await createCase(env.DB, {
      orgId: ORG,
      channel: "email",
      headersAvailable: false,
      forwardedBy: FORWARDER,
      messageId: "<forward-99@fictional-recipient.example>",
    });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await setStatus(env.DB, ORG, id, "running");
    await storeVerdict(env.DB, ORG, id, { ...STUB_VERDICT, headline: "Kept-4 headline" });
    await setStatus(env.DB, ORG, id, "partial");
    await recordEvent(env.DB, id, "reply", "failed", { errorClass: "ReplyNotSent", once: true });
    await env.DB.prepare(
      "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, created_at, updated_at, claimed_at, resend_state, resend_at) VALUES (?, ?, ?, 'reply', ?, 'failed', 1, ?, ?, ?, 'requested', ?)",
    )
      .bind(crypto.randomUUID(), `reply:${id}`, id, "a".repeat(64), CLAIMED, CLAIMED, CLAIMED, CLAIMED)
      .run();
    await resendRequested(env);
    expect(requests.find((r) => r.to[0] === FORWARDER && r.text_body.includes("Kept-4 headline"))).toBeTruthy();
  });
});

describe("round 2 (2026-10-29)", () => {
  it("resends the stored verdict of a case that failed only after it, finishing the case", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    const made = await createCase(env.DB, {
      orgId: ORG,
      channel: "email",
      headersAvailable: false,
      forwardedBy: FORWARDER,
      messageId: "<forward-100@fictional-recipient.example>",
    });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await setStatus(env.DB, ORG, id, "running");
    await storeVerdict(env.DB, ORG, id, { ...STUB_VERDICT, headline: "Finish-5 headline" });
    await setStatus(env.DB, ORG, id, "partial");
    await recordEvent(env.DB, id, "finish", "failed", { errorClass: "Error", once: true });
    await env.DB.prepare(
      "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, created_at, updated_at, claimed_at, resend_state, resend_at) VALUES (?, ?, ?, 'reply', ?, 'failed', 1, ?, ?, ?, 'requested', ?)",
    )
      .bind(crypto.randomUUID(), `reply:${id}`, id, "a".repeat(64), CLAIMED, CLAIMED, CLAIMED, CLAIMED)
      .run();
    await resendRequested(env);
    expect(requests.find((r) => r.to[0] === FORWARDER && r.text_body.includes("Finish-5 headline"))).toBeTruthy();
  });
});

describe("round 3 (2026-10-29)", () => {
  it("never takes a failed bookkeeping write after a delivery for a failed delivery", async () => {
    mutedLogs();
    const requests = stubSmtp2go();
    const id = await settledCase("done");
    let failed = false;
    const flaky = new Proxy(env.DB, {
      get(target, name) {
        if (name === "prepare")
          return (sql: string) => {
            if (!failed && sql.startsWith("UPDATE mail_sends SET resend_state = ?, resend_runs = ?")) {
              failed = true;
              throw new Error("D1 down");
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const report = await resendRequested({ ...env, DB: flaky });
    expect(report.retried + report.exhausted).toBe(0);
    expect(await rowOf(id)).toMatchObject({ status: "sent", resend_state: "sending", resend_runs: 0 });
    // A later run, past the claim's age, settles it by the send's own status: done, sent once, no alert.
    await resendRequested(env, () => new Date(Date.now() + 20 * 60_000));
    expect(await rowOf(id)).toMatchObject({ status: "sent", resend_state: "done" });
    expect(requests.filter((r) => r.to[0] === FORWARDER && r.text_body.includes("Resent-9 headline"))).toHaveLength(1);
    expect(requests.filter((r) => r.subject.includes("could not be sent again"))).toEqual([]);
  });
});
