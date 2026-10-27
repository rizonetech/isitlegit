import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config";
import { createCase } from "../../src/db/cases";
import { type MailMessage, recipientHash, SMTP2GO_URL, sendMail } from "../../src/mail/smtp2go";

// src/mail/smtp2go.ts (D01 T02 §1): the request SMTP2GO documents, a durable intent before any call so nothing is sent
// twice, retries only where SMTP2GO did not take the message, typed outcomes, and a log holding no address, body or key.
const db = env.DB;
const KEY = `api-${"k".repeat(32)}`;
type Call = { url: string; headers: Headers; body: Record<string, unknown> };
type Answer = Response | "timeout";
const ok = (id = "1u0SwL-B9zBpi9ffUq-JAB2") =>
  Response.json({ request_id: "r", data: { succeeded: 1, failed: 0, failures: [], email_id: id } });

function smtp2go(answers: Answer[]) {
  const calls: Call[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    const next = answers.shift() ?? ok();
    if (next === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
    return next;
  }) as typeof fetch;
  return { stub, calls };
}
let n = 0;
const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  sendKey: `test:${++n}`,
  kind: "reply",
  to: "Member@Example.com",
  from: "IsItLegit <check@isitlegit.co.za>",
  subject: "Re: Invoice INV-2026-104",
  text: "Malicious: do not pay this invoice.",
  html: "<p>Malicious: do not pay this invoice.</p>",
  headers: { "In-Reply-To": "<forward@example.com>", References: "<orig@example.com> <forward@example.com>" },
  ...over,
});
const pauses: number[] = [];
const deps = (stub: typeof fetch) => ({
  db,
  apiKey: KEY,
  fetch: stub,
  pause: async (ms: number) => {
    pauses.push(ms);
  },
});
const row = (sendKey: string) =>
  db.prepare("SELECT * FROM mail_sends WHERE send_key = ?").bind(sendKey).first<Record<string, unknown>>();
beforeEach(() => {
  pauses.length = 0;
});

describe("sendMail", () => {
  it("posts the request SMTP2GO documents, with the key in its header and threading in custom headers", async () => {
    const { stub, calls } = smtp2go([ok()]);
    const outcome = await sendMail(deps(stub), message());
    expect(outcome).toEqual({ status: "sent", providerId: "1u0SwL-B9zBpi9ffUq-JAB2", attempts: 1 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(SMTP2GO_URL);
    expect(call?.headers.get("x-smtp2go-api-key")).toBe(KEY);
    expect(call?.headers.get("content-type")).toBe("application/json");
    // The field names of SMTP2GO's documented example; the key is never in the body.
    expect(call?.body).toEqual({
      sender: "IsItLegit <check@isitlegit.co.za>",
      to: ["Member@Example.com"],
      subject: "Re: Invoice INV-2026-104",
      text_body: "Malicious: do not pay this invoice.",
      html_body: "<p>Malicious: do not pay this invoice.</p>",
      custom_headers: [
        { header: "In-Reply-To", value: "<forward@example.com>" },
        { header: "References", value: "<orig@example.com> <forward@example.com>" },
      ],
    });
  });

  it("logs one row per send with the recipient's hash only, and no address, body or key anywhere", async () => {
    const created = await createCase(db, { orgId: "org-a", channel: "email", headersAvailable: true });
    if (!created.ok) throw new Error(created.error.message);
    const sent = message({ sendKey: `reply:${created.value.id}`, caseId: created.value.id });
    await sendMail(deps(smtp2go([ok()]).stub), sent);
    const failed = message();
    await sendMail(deps(smtp2go([new Response("{}", { status: 400 })]).stub), failed);
    const uncertain = message();
    await sendMail(deps(smtp2go(["timeout"]).stub), uncertain);
    const rows = [await row(sent.sendKey), await row(failed.sendKey), await row(uncertain.sendKey)];
    expect(rows.map((r) => r?.status)).toEqual(["sent", "failed", "uncertain"]);
    expect(rows[0]).toMatchObject({
      case_id: created.value.id,
      kind: "reply",
      provider_id: "1u0SwL-B9zBpi9ffUq-JAB2",
      attempts: 1,
    });
    // Trimmed and lower-cased, so the same person is the same hash.
    expect(rows[0]?.to_hash).toBe(await recipientHash(" member@example.com "));
    const stored = JSON.stringify(rows).toLowerCase();
    for (const secret of ["member@example.com", "do not pay", KEY.toLowerCase(), "invoice inv-2026-104"])
      expect(stored).not.toContain(secret);
  });

  it("retries a 503 and a 429, up to 3 attempts in all, and backs off between them", async () => {
    const recovered = smtp2go([new Response("busy", { status: 503 }), ok()]);
    expect(await sendMail(deps(recovered.stub), message())).toMatchObject({ status: "sent", attempts: 2 });
    expect(pauses).toEqual([1000]);
    pauses.length = 0;
    const limited = smtp2go([429, 429, 429, 429].map((s) => new Response("", { status: s })));
    const gaveUp = await sendMail(deps(limited.stub), message());
    expect(gaveUp).toMatchObject({ status: "failed", attempts: 3 });
    expect(gaveUp.status === "failed" && gaveUp.reason).toMatch(/HTTP 429 3 times; gave up/);
    expect(limited.calls).toHaveLength(3);
    expect(pauses).toEqual([1000, 2000]);
  });

  it("fails a 400 and a 200 reporting a failure at once, without retrying", async () => {
    const refused = smtp2go([
      Response.json(
        { data: { error_code: "E_ApiResponseCodes.ENDPOINT_PERMISSION_DENIED", error: "to x@y.example" } },
        { status: 400 },
      ),
    ]);
    const outcome = await sendMail(deps(refused.stub), message());
    expect(outcome).toMatchObject({ status: "failed", attempts: 1 });
    expect(outcome.status === "failed" && outcome.reason).toBe(
      "SMTP2GO refused the message (HTTP 400: E_ApiResponseCodes.ENDPOINT_PERMISSION_DENIED)",
    );
    expect(refused.calls).toHaveLength(1);
    const reported = smtp2go([Response.json({ data: { succeeded: 0, failed: 1, failures: ["x"], email_id: "e" } })]);
    expect(await sendMail(deps(reported.stub), message())).toMatchObject({ status: "failed", attempts: 1 });
    expect(reported.calls).toHaveLength(1);
  });

  it("records no answer, a malformed or truncated 200, and an unconfirmed 200 as uncertain, never retried", async () => {
    for (const [label, answer] of [
      ["timeout", "timeout"],
      ["not JSON", new Response("<html>gateway</html>", { status: 200 })],
      ["truncated", new Response('{"data":{"succeeded":1,', { status: 200 })],
      ["no email id", Response.json({ data: { succeeded: 1, failed: 0, failures: [] } })],
      ["no data", Response.json({ request_id: "r" })],
    ] as [string, Answer][]) {
      const world = smtp2go([answer, ok()]);
      const outcome = await sendMail(deps(world.stub), message());
      expect(outcome, label).toMatchObject({ status: "uncertain", attempts: 1 });
      expect(world.calls, label).toHaveLength(1);
    }
  });

  it("sends once when SMTP2GO took the message and the outcome write failed, however often the caller retries", async () => {
    const sent = message();
    const { stub, calls } = smtp2go([ok(), ok(), ok()]);
    // The outcome UPDATE fails, as if D1 or the Worker stopped right after SMTP2GO accepted the message.
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop);
        return (sql: string) => {
          if (sql.startsWith("UPDATE mail_sends SET status = ?, provider_id"))
            return { bind: () => ({ run: async () => Promise.reject(new Error("D1 unavailable")) }) };
          return target.prepare(sql);
        };
      },
    }) as D1Database;
    expect(await sendMail({ ...deps(stub), db: flaky }, sent)).toMatchObject({ status: "sent" });
    expect((await row(sent.sendKey))?.status).toBe("pending");
    for (let i = 0; i < 2; i++)
      expect(await sendMail(deps(stub), sent)).toEqual({
        status: "duplicate",
        previous: "uncertain",
        providerId: null,
      });
    expect(calls).toHaveLength(1);
  });

  it("answers a send already made as a duplicate, and tries a failed one again on the same row", async () => {
    const once = message();
    const world = smtp2go([ok("first"), ok("second")]);
    await sendMail(deps(world.stub), once);
    expect(await sendMail(deps(world.stub), once)).toEqual({
      status: "duplicate",
      previous: "sent",
      providerId: "first",
    });
    expect(world.calls).toHaveLength(1);
    const retry = message();
    const flaky = smtp2go([new Response("{}", { status: 400 }), ok("later")]);
    expect(await sendMail(deps(flaky.stub), retry)).toMatchObject({ status: "failed" });
    expect(await sendMail(deps(flaky.stub), retry)).toMatchObject({ status: "sent", providerId: "later" });
    expect(await row(retry.sendKey)).toMatchObject({ status: "sent", attempts: 2, error: null });
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM mail_sends WHERE send_key = ?")
      .bind(retry.sendKey)
      .first();
    expect(count?.n).toBe(1);
  });

  it("sends nothing when the send log cannot be written", async () => {
    const { stub, calls } = smtp2go([ok()]);
    const broken = { prepare: () => ({ bind: () => ({ run: async () => Promise.reject(new Error("D1 down")) }) }) };
    const outcome = await sendMail({ ...deps(stub), db: broken as unknown as D1Database }, message());
    expect(outcome).toMatchObject({ status: "failed", attempts: 0 });
    expect(outcome.status === "failed" && outcome.reason).toMatch(/send log could not be written, so nothing was sent/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing key, and a message it must not send, before writing or sending anything", async () => {
    const { stub, calls } = smtp2go([]);
    await expect(sendMail({ ...deps(stub), apiKey: undefined }, message())).rejects.toBeInstanceOf(ConfigError);
    const bad: [string, Partial<MailMessage>][] = [
      ["two addresses", { to: "a@b.example, c@d.example" }],
      ["no address", { to: "nobody" }],
      ["a header SMTP2GO refuses", { headers: { "Content-Type": "text/plain" } }],
      ["header injection", { headers: { "X-Note": "a\r\nBcc: x@y.example" } }],
      ["a two-line subject", { subject: "Hi\r\nBcc: x@y.example" }],
      ["no text body", { text: " " }],
      ["no send key", { sendKey: "" }],
    ];
    for (const [label, over] of bad) {
      const m = message(over);
      await expect(sendMail(deps(stub), m), label).rejects.toThrow(/^sendMail: /);
      expect(await row(m.sendKey), label).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });
});
