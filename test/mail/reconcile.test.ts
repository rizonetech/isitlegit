import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_URL, HEADER, reconcileUncertain } from "../../src/mail/reconcile";
import { type MailMessage, SMTP2GO_URL, sendMail } from "../../src/mail/smtp2go";

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

describe("reconcileUncertain", () => {
  it("settles a send SMTP2GO has a record of, searching around its latest claim, and keeps a bounce's reason", async () => {
    const found = await row("uncertain", 60);
    const bounced = await row("pending", 90);
    const world = smtp2go({
      events: [
        event("someone-else"),
        event(found),
        event(bounced, { event: "hard-bounced", reason: "mailbox unavailable" }),
      ],
    });
    const report = await reconcileUncertain(deps(world.stub), band);
    expect(report.settled.sort()).toEqual([found, bounced].sort());
    expect(await read(found)).toMatchObject({ status: "sent", provider_id: `smtp-${found}` });
    expect(await read(bounced)).toMatchObject({
      status: "sent",
      error: "settled from SMTP2GO's activity: hard-bounced, mailbox unavailable",
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
    expect(failed.errors).toContain(failing);
    expect((await read(failing))?.status).toBe("uncertain");
    await db.prepare("UPDATE mail_sends SET status = 'sent' WHERE send_key = ?").bind(failing).run();
    const long = await row("uncertain", 40);
    const endless = Array.from({ length: 6 }, () => ({ events: [event("other")], continue_token: "more" }));
    const ran = await reconcileUncertain(deps(smtp2go(endless).stub, { pageBudget: 3 }), band);
    expect(ran.errors).toContain(long);
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
    expect(without.errors).toContain(noOperator);
  });
});
