import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_URL, HEADER, reconcileUncertain, requestTimeout } from "../../src/mail/reconcile";
import { settleStatement } from "../../src/mail/settle";
import { type MailMessage, SMTP2GO_URL, sendMail } from "../../src/mail/smtp2go";
import { addMember } from "../fixtures/auth/members";

// src/mail/reconcile.ts (D01 T02 §5): only SMTP2GO's record of a send settles it; an empty search keeps it uncertain;
// a retry or another reconciler since the row was read keeps its outcome; an unresolved send reaches the operator once;
// and the reconciler never sends the message it reconciles.
const db = env.DB;
const KEY = `api-${"k".repeat(32)}`;
const NOW = new Date("2026-10-27T20:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
let n = 0;
// Each test starts from an empty send log: the reconciler reads every row in its band.
beforeEach(async () => {
  await db.prepare("DELETE FROM mail_sends").run();
});

async function row(status: "uncertain" | "pending" | "failed" | "sent", claimedMinutesAgo: number, key = `rk:${++n}`) {
  const at = minutesAgo(claimedMinutesAgo);
  await db
    .prepare(
      "INSERT INTO mail_sends (id, send_key, kind, to_hash, status, attempts, created_at, updated_at, claimed_at) VALUES (?, ?, 'reply', ?, ?, 1, ?, ?, ?)",
    )
    .bind(`id-${key}`, key, "a".repeat(64), status, at, at, at)
    .run();
  return key;
}
const read = (key: string) =>
  db.prepare("SELECT * FROM mail_sends WHERE send_key = ?").bind(key).first<Record<string, unknown>>();
const event = (key: string, over: Record<string, unknown> = {}) => ({
  email_id: `smtp-${key}`,
  event: "processed",
  date: NOW.toISOString(),
  custom_headers: { [HEADER]: key },
  ...over,
});

type Page = { events: unknown[]; continue_token?: string | null } | "error";
// Every search gets the same answer (SMTP2GO's events in the window), or the pages in order when a list is given.
function smtp2go(answer: Page | Page[]) {
  const pages = Array.isArray(answer) ? [...answer] : null;
  const searches: Record<string, unknown>[] = [];
  const sends: unknown[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(input) === SMTP2GO_URL) {
      sends.push(body);
      return Response.json({ data: { succeeded: 1, failed: 0, failures: [], email_id: `alert-${sends.length}` } });
    }
    expect(String(input)).toBe(ACTIVITY_URL);
    expect(new Headers(init?.headers).get("x-smtp2go-api-key")).toBe(KEY);
    searches.push(body);
    const page = pages ? (pages.shift() ?? { events: [] }) : (answer as Page);
    if (page === "error") return new Response("busy", { status: 503 });
    return Response.json({ data: { events: page.events, continue_token: page.continue_token ?? null } });
  }) as typeof fetch;
  return { stub, searches, sends };
}
const deps = (stub: typeof fetch, over: Record<string, unknown> = {}) => ({
  db,
  apiKey: KEY,
  fetch: stub,
  now: () => NOW,
  operator: "hostmaster@rizonetech.com",
  pause: async () => {},
  ...over,
});
const band = { olderThanMinutes: 30, youngerThanDays: 3 };

// The recipient is a member, so the allowlist admits it by its records (D01 T02 §2).
beforeEach(() => addMember(env.DB, "member@example.com"));

describe("reconcileUncertain", () => {
  it("settles a send SMTP2GO has a record of, searching around its latest claim, and keeps a bounce's reason", async () => {
    const found = await row("uncertain", 60);
    const bounced = await row("pending", 90);
    const world = smtp2go({
      events: [
        event("someone-else"),
        event(found),
        // SMTP2GO's text can name the recipient; only the event type and the SMTP codes are kept.
        event(bounced, { event: "hard-bounced", reason: "550 5.1.1 member@example.com: mailbox unavailable" }),
      ],
    });
    const report = await reconcileUncertain(deps(world.stub), band);
    expect(report.settled.sort()).toEqual([found, bounced].sort());
    expect(await read(found)).toMatchObject({ status: "sent", provider_id: `smtp-${found}` });
    expect(await read(bounced)).toMatchObject({
      status: "sent",
      error: "settled from SMTP2GO's activity: hard-bounced (550 5.1.1)",
    });
    // The window runs from 5 minutes before the claim to 30 after, and asks for the send key's header.
    const window = world.searches.find((s) => s.start_date === minutesAgo(65));
    expect(window).toMatchObject({ end_date: minutesAgo(30), custom_headers: [HEADER] });
    expect(world.sends).toEqual([]);
  });

  it("keeps a send SMTP2GO shows nothing for uncertain, never retryable, and settles it when it appears later", async () => {
    const late = await row("uncertain", 45);
    const first = await reconcileUncertain(deps(smtp2go({ events: [] }).stub), band);
    expect(first.unresolved).toContain(late);
    expect((await read(late))?.status).toBe("uncertain");
    // A caller's retry is answered as a duplicate, not sent.
    const retry = smtp2go({ events: [] });
    const message: MailMessage = {
      sendKey: late,
      kind: "reply",
      to: "member@example.com",
      from: "IsItLegit <check@isitlegit.co.za>",
      subject: "Re: x",
      text: "x",
    };
    expect(await sendMail({ db, apiKey: KEY, fetch: retry.stub }, message)).toMatchObject({ status: "duplicate" });
    expect(retry.sends).toEqual([]);
    const second = await reconcileUncertain(deps(smtp2go({ events: [event(late)] }).stub), band);
    expect(second.settled).toContain(late);
  });

  it("leaves a row whose search failed or ran out of pages, and one too young to judge", async () => {
    const failing = await row("uncertain", 40);
    const failed = await reconcileUncertain(deps(smtp2go("error").stub), band);
    expect(failed.errors).toEqual([`${failing}: SMTP2GO answered HTTP 503`]);
    expect(failed.state).toBe("degraded");
    expect((await read(failing))?.status).toBe("uncertain");
    await db.prepare("UPDATE mail_sends SET status = 'sent' WHERE send_key = ?").bind(failing).run();
    const long = await row("uncertain", 40);
    const endless = Array.from({ length: 6 }, () => ({ events: [event("other")], continue_token: "more" }));
    const ran = await reconcileUncertain(deps(smtp2go(endless).stub, { pageBudget: 3 }), band);
    // A window not read to its end is unresolved, its place kept for the next run.
    expect(ran.unresolved).toContain(long);
    expect((await read(long))?.search_cursor).toBe("more");
    expect((await read(long))?.status).toBe("uncertain");
    await db.prepare("UPDATE mail_sends SET status = 'sent' WHERE send_key = ?").bind(long).run();
    const young = await row("uncertain", 10);
    const world = smtp2go({ events: [event(young)] });
    await reconcileUncertain(deps(world.stub), band);
    expect((await read(young))?.status).toBe("uncertain");
    expect(world.searches.some((s) => s.start_date === minutesAgo(15))).toBe(false);
    await db.prepare("UPDATE mail_sends SET status = 'sent' WHERE send_key = ?").bind(young).run();
  });

  it("never overwrites a retry that landed between its read and its write", async () => {
    const key = await row("failed", 120);
    // The row is uncertain at read time; a caller's retry claims it (new claimed_at) and sends before the reconciler writes.
    await db.prepare("UPDATE mail_sends SET status = 'uncertain' WHERE send_key = ?").bind(key).run();
    let retried = false;
    const world = smtp2go({ events: [] });
    const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === ACTIVITY_URL && !retried) {
        retried = true;
        await db.prepare("UPDATE mail_sends SET status = 'failed' WHERE send_key = ?").bind(key).run();
        const sent = await sendMail(
          { db, apiKey: KEY, fetch: world.stub, now: () => new Date(NOW.getTime() - 60_000) },
          {
            sendKey: key,
            kind: "reply",
            to: "member@example.com",
            from: "IsItLegit <check@isitlegit.co.za>",
            subject: "Re: x",
            text: "x",
          },
        );
        expect(sent.status).toBe("sent");
        return Response.json({ data: { events: [event(key, { email_id: "stale-id" })], continue_token: null } });
      }
      return world.stub(input, init);
    }) as typeof fetch;
    const report = await reconcileUncertain(deps(racing), band);
    expect(report.settled).not.toContain(key);
    expect(await read(key)).toMatchObject({ status: "sent", provider_id: "alert-1" });
  });

  it("hands a send still unresolved past 3 days to the operator once, and never sends the message itself", async () => {
    const stuck = await row("uncertain", 3 * 24 * 60 + 10);
    const world = smtp2go({ events: [] });
    const first = await reconcileUncertain(deps(world.stub), band);
    const second = await reconcileUncertain(deps(world.stub), band);
    expect(first.handedOver).toContain(stuck);
    expect(second.handedOver).toContain(stuck);
    expect(world.sends).toHaveLength(1);
    const alert = world.sends[0] as Record<string, unknown>;
    expect(alert.to).toEqual(["hostmaster@rizonetech.com"]);
    expect(String(alert.subject)).toContain(stuck);
    expect(String(alert.text_body)).toContain(`node scripts/mail-settle.ts ${stuck} sent`);
    expect(String(alert.text_body)).not.toContain("member@example.com");
    expect(world.searches).toEqual([]);
    expect((await read(stuck))?.status).toBe("uncertain");
    const noOperator = await row("uncertain", 3 * 24 * 60 + 20);
    const without = await reconcileUncertain(deps(smtp2go({ events: [] }).stub, { operator: undefined }), band);
    expect(without.errors).toContain(`${noOperator}: no operator address (OPERATOR_EMAIL) to hand it to`);
  });

  it("reports a malformed OPERATOR_EMAIL against each row and carries on, instead of ending the run", async () => {
    const first = await row("uncertain", 3 * 24 * 60 + 10);
    const second = await row("uncertain", 3 * 24 * 60 + 30);
    const world = smtp2go({ events: [] });
    const report = await reconcileUncertain(deps(world.stub, { operator: "hostmaster@rizonetech" }), band);
    for (const key of [first, second])
      expect(
        report.errors.some(
          (e) => e.startsWith(`${key}: the operator alert could not be sent`) && e.includes("OPERATOR_EMAIL"),
        ),
      ).toBe(true);
    expect(world.sends).toEqual([]);
  });

  it("does not count an uncertain alert as handed over, reconciles it, and never alerts about an alert (completion review)", async () => {
    const stuck = await row("uncertain", 3 * 24 * 60 + 10);
    // The alert's own send gets no answer.
    const timeout = (async (input: RequestInfo | URL) => {
      if (String(input) === SMTP2GO_URL) throw new DOMException("timed out", "TimeoutError");
      return Response.json({ data: { events: [], continue_token: null } });
    }) as typeof fetch;
    const first = await reconcileUncertain(deps(timeout), band);
    expect(first.handedOver).toEqual([]);
    expect(first.unresolved).toContain(stuck);
    const alertKey = `unresolved:${stuck}@${(await read(stuck))?.claimed_at}`;
    expect((await read(alertKey))?.status).toBe("uncertain");
    const world = smtp2go({ events: [] });
    const second = await reconcileUncertain(
      deps(world.stub, { now: () => new Date(NOW.getTime() + 60 * 60_000) }),
      band,
    );
    expect(second.handedOver).toEqual([]);
    expect(world.sends).toEqual([]);
    // SMTP2GO's record of the alert settles it, and only then is the send handed over.
    const later = new Date(NOW.getTime() + 2 * 60 * 60_000);
    const found = smtp2go({ events: [event(alertKey)] });
    await reconcileUncertain(deps(found.stub, { now: () => later }), band);
    expect((await read(alertKey))?.status).toBe("sent");
    const third = await reconcileUncertain(deps(smtp2go({ events: [] }).stub, { now: () => later }), band);
    expect(third.handedOver).toContain(stuck);
    expect(found.sends).toEqual([]);
    // An alert past the band is unresolved, and no alert is raised about it.
    const oldAlert = await row("uncertain", 3 * 24 * 60 + 30, `unresolved:reply:older`);
    const quiet = smtp2go({ events: [] });
    const report = await reconcileUncertain(deps(quiet.stub), band);
    expect(report.unresolved).toContain(oldAlert);
    expect(quiet.sends).toEqual([]);
  });

  it("is not stopped by malformed events, and never settles on incomplete evidence (completion review)", async () => {
    const odd = await row("uncertain", 50);
    const after = await row("uncertain", 40);
    const world = smtp2go({ events: [null, 7, "x", { custom_headers: null }, event(after)] });
    const report = await reconcileUncertain(deps(world.stub), band);
    expect(report.settled).toEqual([after]);
    expect(report.unresolved).toContain(odd);
    const incomplete = await row("uncertain", 45);
    const missing = smtp2go({ events: [{ event: "processed", custom_headers: { [HEADER]: incomplete } }] });
    const partial = await reconcileUncertain(deps(missing.stub), band);
    expect(partial.errors).toContain(`${incomplete}: SMTP2GO's event for this send has no email id or type`);
    expect((await read(incomplete))?.status).toBe("uncertain");
  });

  it("reads a long window across runs from where it stopped, paced under SMTP2GO's limit (completion review)", async () => {
    const far = await row("uncertain", 60);
    const pages = [
      ...Array.from({ length: 5 }, (_, i) => ({ events: [event("other")], continue_token: `page-${i + 2}` })),
      { events: [event(far)], continue_token: null },
    ];
    const world = smtp2go(pages);
    const pauses: number[] = [];
    const paced = { pageBudget: 3, pause: async (ms: number) => void pauses.push(ms) };
    const first = await reconcileUncertain(deps(world.stub, paced), band);
    expect(first.unresolved).toContain(far);
    expect((await read(far))?.search_cursor).toBe("page-4");
    const second = await reconcileUncertain(deps(world.stub, paced), band);
    expect(second.settled).toContain(far);
    // The second run resumed at page 4, not page 1.
    expect(world.searches.map((s) => s.continue_token ?? null)).toEqual([
      null,
      "page-2",
      "page-3",
      "page-4",
      "page-5",
      "page-6",
    ]);
    expect((await read(far))?.search_cursor).toBeNull();
    // Many rows: the run stops at its request budget and paces between rows.
    for (let i = 0; i < 6; i++) await row("uncertain", 40 + i);
    const busy = smtp2go({ events: [] });
    pauses.length = 0;
    const capped = await reconcileUncertain(
      deps(busy.stub, { runBudget: 4, paceMs: 1_100, pause: async (ms: number) => void pauses.push(ms) }),
      band,
    );
    expect(capped.requests).toBe(4);
    expect(busy.searches).toHaveLength(4);
    // A pause between searches, and none once the budget is spent: the rest wait for the next run (round 2).
    expect(pauses).toEqual([1_100, 1_100, 1_100]);
    expect(capped.unresolved).toHaveLength(6);
    expect(capped.state).toBe("ok");
  });

  it("reports a refused activity search as degraded (completion review)", async () => {
    const key = await row("uncertain", 50);
    const refused = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    const report = await reconcileUncertain(deps(refused), band);
    expect(report.state).toBe("degraded");
    expect(report.errors).toEqual([`${key}: SMTP2GO refused the activity search (HTTP 403)`]);
  });

  it("lets the operator settle only the attempt the alert named, so a repeated command cannot fail a newer one", async () => {
    const key = await row("uncertain", 3 * 24 * 60 + 10);
    const claimed = (await read(key))?.claimed_at as string;
    const settle = (status: string) => db.prepare(settleStatement(key, status, claimed, NOW.toISOString())).run();
    expect((await settle("failed")).meta.changes).toBe(1);
    // A caller tries again: a new claim, now pending.
    await sendMail(
      {
        db,
        apiKey: KEY,
        // No answer: the request is cut off at its deadline, leaving the new attempt uncertain.
        fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          )) as typeof fetch,
        timeoutMs: 10,
      },
      {
        sendKey: key,
        kind: "reply",
        to: "member@example.com",
        from: "IsItLegit <check@isitlegit.co.za>",
        subject: "Re: x",
        text: "x",
      },
    );
    expect((await read(key))?.claimed_at).not.toBe(claimed);
    // The operator repeats the command for the old attempt: refused, the new attempt untouched.
    expect((await settle("failed")).meta.changes).toBe(0);
    expect((await read(key))?.status).not.toBe("failed");
  });

  it("alerts again for a later attempt that ages out too, naming its own claim (round 1)", async () => {
    const key = await row("uncertain", 3 * 24 * 60 + 10);
    const world = smtp2go({ events: [] });
    const first = await reconcileUncertain(deps(world.stub), band);
    expect(first.handedOver).toEqual([key]);
    const firstClaim = (await read(key))?.claimed_at as string;
    // The operator fails that attempt; a caller's retry claims it again, gets no answer and ages out in turn.
    await db.prepare(settleStatement(key, "failed", firstClaim, NOW.toISOString())).run();
    const retryAt = new Date(NOW.getTime() + 60_000);
    await sendMail(
      {
        db,
        apiKey: KEY,
        now: () => retryAt,
        fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          )) as typeof fetch,
        timeoutMs: 10,
      },
      {
        sendKey: key,
        kind: "reply",
        to: "member@example.com",
        from: "IsItLegit <check@isitlegit.co.za>",
        subject: "Re: x",
        text: "x",
      },
    );
    const later = new Date(retryAt.getTime() + 3 * 86_400_000 + 60_000);
    const second = await reconcileUncertain(deps(world.stub, { now: () => later }), band);
    expect(second.handedOver).toEqual([key]);
    expect(world.sends).toHaveLength(2);
    expect(String((world.sends[1] as Record<string, unknown>).text_body)).toContain(retryAt.toISOString());
  });

  it("makes the run degraded when the operator alert fails (round 1)", async () => {
    const key = await row("uncertain", 3 * 24 * 60 + 10);
    const refused = (async (input: RequestInfo | URL) =>
      String(input) === SMTP2GO_URL
        ? Response.json({ data: { error_code: "E_ApiResponseCodes.ENDPOINT_PERMISSION_DENIED" } }, { status: 403 })
        : Response.json({ data: { events: [], continue_token: null } })) as typeof fetch;
    const report = await reconcileUncertain(deps(refused), band);
    expect(report.state).toBe("degraded");
    expect(report.errors).toEqual([
      `${key}: the operator alert failed (SMTP2GO refused the message (HTTP 403: E_ApiResponseCodes.ENDPOINT_PERMISSION_DENIED))`,
    ]);
    expect(report.handedOver).toEqual([]);
  });

  it("reaches every row of a backlog bigger than one run's budget, across runs (round 1)", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 6; i++) keys.push(await row("uncertain", 120 - i));
    // The three oldest have no record; the three newest do.
    const world = smtp2go({ events: keys.slice(3).map((k) => event(k)) });
    const settled: string[] = [];
    for (let run = 0; run < 3 && settled.length < 3; run++) {
      const report = await reconcileUncertain(deps(world.stub, { runBudget: 3, paceMs: 0 }), band);
      settled.push(...report.settled);
    }
    expect(settled.sort()).toEqual(keys.slice(3).sort());
  });

  it("lets the operator settle an alert by the key the reconciler gave it (round 2)", async () => {
    const original = await row("uncertain", 3 * 24 * 60 + 10);
    const claimed = (await read(original))?.claimed_at as string;
    const alertKey = `unresolved:${original}@${claimed}`;
    await row("uncertain", 3 * 24 * 60 + 5, alertKey);
    const alertClaim = (await read(alertKey))?.claimed_at as string;
    expect(
      (await db.prepare(settleStatement(alertKey, "failed", alertClaim, NOW.toISOString())).run()).meta.changes,
    ).toBe(1);
    expect((await read(alertKey))?.status).toBe("failed");
  });

  it("stops at its time limit in an outage, reports it, and leaves the rest for the next run (round 3)", async () => {
    for (let i = 0; i < 50; i++) await row("uncertain", 40 + i);
    // Every search takes its full 31 s (an outage); the clock moves with it.
    let clock = 0;
    const slow = (async () => {
      clock += 31_000;
      return new Response("timeout", { status: 504 });
    }) as typeof fetch;
    const report = await reconcileUncertain(deps(slow, { clock: () => clock, paceMs: 0 }), band);
    // 10 minutes at 31 s each: 20 searches, then the rest wait.
    expect(report.requests).toBe(20);
    expect(clock).toBeLessThanOrEqual(10 * 60_000 + 31_000);
    expect(report.state).toBe("degraded");
    expect(report.errors).toContain("the run reached its time limit; the remaining sends wait for the next run");
    expect(report.unresolved).toHaveLength(30);
  });

  it("aborts a hanging search at the run's deadline, not at the 30 s request limit", async () => {
    const key = await row("uncertain", 50);
    const hangs = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as typeof fetch;
    const started = Date.now();
    const report = await reconcileUncertain(deps(hangs, { deadlineMs: 300, now: () => NOW }), band);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.errors.some((e) => e.startsWith(`${key}: no readable answer from SMTP2GO`))).toBe(true);
  });

  it("cuts each request's timeout to the time the run has left", () => {
    expect(requestTimeout(600_000)).toBe(30_000);
    expect(requestTimeout(4_000)).toBe(4_000);
    expect(requestTimeout(0)).toBe(1);
    expect(requestTimeout(-50)).toBe(1);
    expect(requestTimeout(600_000, 10)).toBe(10);
  });
});
