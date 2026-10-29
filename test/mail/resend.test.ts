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
function stubSmtp2go(answer: (body: Sent) => "sent" | "refused" = () => "sent") {
  const requests: Sent[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== SMTP2GO_URL) return real(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as Sent;
    requests.push(body);
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
