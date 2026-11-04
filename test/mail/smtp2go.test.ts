import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config";
import { createCase } from "../../src/db/cases";
import { type MailMessage, recipientHash, SMTP2GO_URL, sendMail } from "../../src/mail/smtp2go";
import { addMember } from "../fixtures/auth/members";

// src/mail/smtp2go.ts (D01 T02 §1): the request SMTP2GO documents, a durable intent before any call so nothing is sent
// twice, retries only where SMTP2GO did not take the message, typed outcomes, and a log holding no address, body or key.
const db = env.DB;
const KEY = `api-${"k".repeat(32)}`;
type Call = { url: string; headers: Headers; body: Record<string, unknown>; redirect?: RequestInit["redirect"] };
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
      ...(init?.redirect ? { redirect: init.redirect } : {}),
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

// The recipient is a member, so the allowlist admits it by its records (D01 T02 §2).
beforeEach(() => addMember(env.DB, "member@example.com"));

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
        // The send key, so an uncertain send can be matched to SMTP2GO's record later.
        { header: "X-IsItLegit-Send", value: `test:${n}` },
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

  it("retries only a 429, up to 3 attempts in all, backing off and counting each attempt on the row as it ends", async () => {
    const recovered = message();
    const world = smtp2go([new Response("", { status: 429 }), ok()]);
    const seen: unknown[] = [];
    const watching = {
      ...deps(world.stub),
      pause: async (ms: number) => {
        pauses.push(ms);
        // During the backoff, as if the Worker stopped here: the first attempt is already on the row.
        seen.push(await row(recovered.sendKey));
      },
    };
    expect(await sendMail(watching, recovered)).toMatchObject({ status: "sent", attempts: 2 });
    expect(seen[0]).toMatchObject({ status: "pending", attempts: 1, error: "SMTP2GO answered HTTP 429" });
    expect(await row(recovered.sendKey)).toMatchObject({
      status: "sent",
      attempts: 2,
      error: "sent after: SMTP2GO answered HTTP 429",
    });
    expect(pauses).toEqual([1000]);
    pauses.length = 0;
    const limited = smtp2go([429, 429, 429, 429].map((s) => new Response("", { status: s })));
    const gaveUp = message();
    const outcome = await sendMail(deps(limited.stub), gaveUp);
    expect(outcome).toMatchObject({ status: "failed", attempts: 3 });
    expect(outcome.status === "failed" && outcome.reason).toMatch(/HTTP 429 3 times; gave up/);
    expect(limited.calls).toHaveLength(3);
    expect(pauses).toEqual([1000, 2000]);
    expect(await row(gaveUp.sendKey)).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("counts each attempt once even when a counter write commits and its acknowledgement is lost (round 1)", async () => {
    const sent = message();
    const world = smtp2go([new Response("", { status: 429 }), ok()]);
    // The attempt counter's UPDATE runs, then its promise rejects, as when D1's answer is lost after the commit.
    const lossy = new Proxy(db, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop);
        return (sql: string) => {
          const statement = target.prepare(sql);
          // The per-attempt counter, whatever form its arithmetic takes.
          if (!sql.startsWith("UPDATE mail_sends SET attempts")) return statement;
          return {
            bind: (...args: unknown[]) => ({
              run: async () => {
                await statement.bind(...args).run();
                throw new Error("network error after commit");
              },
            }),
          };
        };
      },
    }) as D1Database;
    expect(await sendMail({ ...deps(world.stub), db: lossy }, sent)).toMatchObject({ status: "sent", attempts: 2 });
    expect(world.calls).toHaveLength(2);
    expect(await row(sent.sendKey)).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("counts only SMTP2GO's documented 200 as sent, not another status with a confirming body (round 1)", async () => {
    for (const status of [201, 202, 302]) {
      const sent = message();
      const confirming = new Response(
        JSON.stringify({ data: { succeeded: 1, failed: 0, failures: [], email_id: "synthetic-id" } }),
        { status, headers: { "content-type": "application/json" } },
      );
      expect(await sendMail(deps(smtp2go([confirming]).stub), sent), String(status)).toMatchObject({
        status: "uncertain",
      });
      expect((await row(sent.sendKey))?.status, String(status)).toBe("uncertain");
    }
  });

  it("records a 5xx as uncertain and never retries it, since it may follow acceptance", async () => {
    for (const status of [500, 502, 503, 504]) {
      const sent = message();
      const world = smtp2go([new Response("gateway", { status }), ok()]);
      const outcome = await sendMail(deps(world.stub), sent);
      expect(outcome, String(status)).toMatchObject({ status: "uncertain", attempts: 1 });
      expect(world.calls, String(status)).toHaveLength(1);
      expect(await row(sent.sendKey), String(status)).toMatchObject({ status: "uncertain", attempts: 1 });
    }
  });

  it("still returns and records an outcome when the error answer's stream breaks", async () => {
    const sent = message();
    const broken = new ReadableStream({
      pull(controller) {
        controller.error(new TypeError("connection reset"));
      },
      cancel() {
        throw new TypeError("connection reset");
      },
    });
    const world = smtp2go([new Response(broken, { status: 503 })]);
    expect(await sendMail(deps(world.stub), sent)).toMatchObject({ status: "uncertain", attempts: 1 });
    expect(await row(sent.sendKey)).toMatchObject({ status: "uncertain", attempts: 1 });
  });

  it("gives up on a request at its deadline, as uncertain", async () => {
    const sent = message();
    let aborted = false;
    const hangs = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal?.reason);
        }),
      )) as typeof fetch;
    const started = Date.now();
    const outcome = await sendMail({ ...deps(hangs), timeoutMs: 100 }, sent);
    expect(outcome).toMatchObject({ status: "uncertain", attempts: 1 });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("lets only one of two simultaneous callers send, for a new key and for a failed one", async () => {
    const fresh = message();
    const world = smtp2go([ok("one"), ok("two")]);
    const both = await Promise.all([sendMail(deps(world.stub), fresh), sendMail(deps(world.stub), fresh)]);
    expect(both.map((o) => o.status).sort()).toEqual(["duplicate", "sent"]);
    expect(world.calls).toHaveLength(1);
    const failed = message();
    const again = smtp2go([new Response("{}", { status: 400 }), ok("three"), ok("four")]);
    await sendMail(deps(again.stub), failed);
    const retries = await Promise.all([sendMail(deps(again.stub), failed), sendMail(deps(again.stub), failed)]);
    expect(retries.map((o) => o.status).sort()).toEqual(["duplicate", "sent"]);
    expect(again.calls).toHaveLength(2);
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

  it("records each claim's own start, moving it when a failed send is tried again (D01 T02 §5)", async () => {
    const later = message();
    const first = new Date("2026-10-27T08:00:00Z");
    const retry = new Date("2026-10-27T14:30:00Z");
    await sendMail({ ...deps(smtp2go([new Response("{}", { status: 400 })]).stub), now: () => first }, later);
    expect(await row(later.sendKey)).toMatchObject({
      created_at: first.toISOString(),
      claimed_at: first.toISOString(),
    });
    await sendMail({ ...deps(smtp2go([ok()]).stub), now: () => retry }, later);
    expect(await row(later.sendKey)).toMatchObject({
      status: "sent",
      created_at: first.toISOString(),
      claimed_at: retry.toISOString(),
    });
  });

  it("sends nothing when the send log cannot be written", async () => {
    const { stub, calls } = smtp2go([ok()]);
    // The allowlist reads (it admits the recipient); the log write fails.
    const broken = {
      prepare: () => ({
        bind: () => ({ first: async () => ({}), run: async () => Promise.reject(new Error("D1 down")) }),
      }),
    };
    const outcome = await sendMail({ ...deps(stub), db: broken as unknown as D1Database }, message());
    expect(outcome).toMatchObject({ status: "failed", attempts: 0, storageFailure: "claim" });
    expect(outcome.status === "failed" && outcome.reason).toMatch(/send log could not be written, so nothing was sent/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an address the allowlist does not admit: no fetch, one refused row, however often it is asked", async () => {
    const { stub, calls } = smtp2go([ok(), ok()]);
    const stranger = message({ to: "someone@example.com", sendKey: "reply:stranger" });
    for (let i = 0; i < 2; i++) expect(await sendMail(deps(stub), stranger)).toMatchObject({ status: "refused" });
    expect(calls).toHaveLength(0);
    const rows = await db
      .prepare("SELECT status, to_hash FROM mail_sends WHERE send_key = 'reply:stranger'")
      .all<{ status: string; to_hash: string }>();
    expect(rows.results).toEqual([{ status: "refused", to_hash: await recipientHash("someone@example.com") }]);
  });

  it("holds sign-in mail to one address to five in ten minutes, even under a concurrent burst", async () => {
    const answers = Array.from({ length: 10 }, () => ok());
    const { stub, calls } = smtp2go(answers);
    const link = (n: number) => message({ to: "member@example.com", kind: "signin", sendKey: `signin:burst-${n}` });
    for (let n = 0; n < 4; n++) expect((await sendMail(deps(stub), link(n))).status).toBe("sent");
    // Four more at once: only one fits under the limit.
    const burst = await Promise.all([4, 5, 6, 7].map((n) => sendMail(deps(stub), link(n))));
    expect(burst.filter((o) => o.status === "sent")).toHaveLength(1);
    expect(burst.filter((o) => o.status === "refused")).toHaveLength(3);
    expect(calls).toHaveLength(5);
    const rows = await db
      .prepare("SELECT COUNT(*) AS n FROM mail_sends WHERE send_key LIKE 'signin:burst-%'")
      .first<{ n: number }>();
    expect(rows?.n).toBe(5);
  });

  it("records no row for a refused sign-in, which anyone can ask for", async () => {
    const { stub, calls } = smtp2go([ok()]);
    const before = await db.prepare("SELECT COUNT(*) AS n FROM mail_sends").first<{ n: number }>();
    const outcome = await sendMail(
      deps(stub),
      message({ to: "nobody@example.com", kind: "signin", sendKey: "signin:nobody" }),
    );
    expect(outcome.status).toBe("refused");
    expect(calls).toHaveLength(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM mail_sends").first<{ n: number }>())?.n).toBe(before?.n);
  });

  it("leaves a send already on record as it was when a later refusal meets its key", async () => {
    for (const status of ["sent", "failed", "uncertain", "pending"]) {
      const key = `reply:prior-${status}`;
      const at = new Date().toISOString();
      await db
        .prepare(
          "INSERT INTO mail_sends (id, send_key, kind, to_hash, status, provider_id, attempts, created_at, updated_at) VALUES (?, ?, 'reply', ?, ?, ?, 1, ?, ?)",
        )
        .bind(`prior-${status}`, key, "0".repeat(64), status, status === "sent" ? "provider-1" : null, at, at)
        .run();
      const { stub, calls } = smtp2go([ok()]);
      // The member has since left: the same key, now for an address the allowlist refuses.
      const outcome = await sendMail(deps(stub), message({ to: "gone@example.com", sendKey: key }));
      expect(outcome.status, status).toBe("refused");
      expect(calls, status).toHaveLength(0);
      const row = await db
        .prepare("SELECT status, provider_id, attempts FROM mail_sends WHERE send_key = ?")
        .bind(key)
        .first<{ status: string; provider_id: string | null; attempts: number }>();
      expect(row, status).toEqual({ status, provider_id: status === "sent" ? "provider-1" : null, attempts: 1 });
    }
  });

  it("still refuses, typed, when the refusal cannot be recorded, and records it once when asked again", async () => {
    const { stub, calls } = smtp2go([ok()]);
    // The allowlist reads (no member, so refused); the refusal's write fails.
    const failing = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => null,
          run: async () =>
            sql.startsWith("INSERT")
              ? Promise.reject(new Error("D1 storage full"))
              : db
                  .prepare(sql)
                  .bind(...values)
                  .run(),
        }),
      }),
    };
    const stranger = message({ to: "nobody@example.com", sendKey: "reply:unrecorded" });
    const outcome = await sendMail({ ...deps(stub), db: failing as unknown as D1Database }, stranger);
    expect(outcome).toEqual({
      status: "failed",
      reason: expect.stringMatching(/could not be recorded/),
      storageFailure: "refusal",
      attempts: 0,
    });
    expect(calls).toHaveLength(0);
    // Storage back: the same refusal is recorded, once.
    expect(await sendMail(deps(stub), stranger)).toMatchObject({ status: "refused" });
    expect(await sendMail(deps(stub), stranger)).toMatchObject({ status: "refused" });
    const rows = await db.prepare("SELECT status FROM mail_sends WHERE send_key = 'reply:unrecorded'").all();
    expect(rows.results).toEqual([{ status: "refused" }]);
    expect(calls).toHaveLength(0);
  });

  it("sends nothing when the allowlist cannot be read", async () => {
    const { stub, calls } = smtp2go([ok()]);
    const down = { prepare: () => ({ bind: () => ({ first: async () => Promise.reject(new Error("D1 down")) }) }) };
    const outcome = await sendMail({ ...deps(stub), db: down as unknown as D1Database }, message());
    expect(outcome).toMatchObject({ status: "failed", attempts: 0, storageFailure: "allowlist" });
    expect(outcome.status === "failed" && outcome.reason).toMatch(/allowlist could not be checked/);
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
      // The sender is exactly isitlegit.co.za: never another domain, a subdomain or a look-alike (D99 T01 §4).
      ["another sender domain", { from: "IsItLegit <alerts@rizonetech.com>" }],
      ["a look-alike sender domain", { from: "check@isitlegit.co.za.example.net" }],
      ["a bare look-alike", { from: "IsItLegit <check@notisitlegit.co.za>" }],
      ["a subdomain sender", { from: "alerts@demo.isitlegit.co.za" }],
    ];
    for (const [label, over] of bad) {
      const m = message(over);
      await expect(sendMail(deps(stub), m), label).rejects.toThrow(/^sendMail: /);
      expect(await row(m.sendKey), label).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it("sends as isitlegit.co.za, never following a redirect", async () => {
    for (const from of ["IsItLegit <check@isitlegit.co.za>", "IsItLegit <signin@ISITLEGIT.CO.ZA>"]) {
      const { stub, calls } = smtp2go([ok()]);
      await sendMail(deps(stub), message({ from, sendKey: `from:${from}` }));
      expect(calls, from).toHaveLength(1);
      expect(calls[0]?.redirect, from).toBe("manual");
    }
  });
});
