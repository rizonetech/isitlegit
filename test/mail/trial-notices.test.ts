import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extendTrialStatement, setDailyCapOverrideStatement, setPlanStatement } from "../../src/auth/plan-sql";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";
import { trialNoticeEmail } from "../../src/mail/templates/auth-mail";
import { sendTrialNotices } from "../../src/mail/trial-notices";

// The trial-end notices (D07 T08 §11): one three days before and one after the Protect trial ends, to each owner once, the
// organisation named, the end in SAST, recovered after a refusal, never duplicated, never stale, never for a plan that
// was chosen or the protected test organisations.
const db = (env as unknown as Env).DB;
const DAY = 86_400_000;
const NOW = new Date("2026-11-10T08:00:00.000Z");
afterEach(() => vi.restoreAllMocks());
// Each test starts from no organisations, members, limits or sends, so what one made is never due in another.
beforeEach(async () => {
  for (const table of ["mail_sends", "org_limits", '"member"', '"user"', '"organization"'])
    await db.prepare(`DELETE FROM ${table}`).run();
});

type Payload = { sender: string; to: string[]; subject: string; text_body: string; html_body?: string };
function provider(answer: () => "ok" | "refuse" | "lost" = () => "ok") {
  const sent: Payload[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== SMTP2GO_URL) return real(input, init);
    const mode = answer();
    if (mode === "lost") throw new DOMException("timed out", "TimeoutError");
    if (mode === "refuse")
      return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
    sent.push(JSON.parse(String(init?.body ?? "{}")) as Payload);
    return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${sent.length}` } });
  });
  return sent;
}

const tag = () => crypto.randomUUID().slice(0, 8);
async function organisation(opts: { name?: string; createdAgoDays: number; owners?: number; members?: string[] }) {
  const orgId = `org-${tag()}`;
  const created = new Date(NOW.getTime() - opts.createdAgoDays * DAY).toISOString();
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(orgId, opts.name ?? "Karoo Couriers", orgId, created)
    .run();
  const add = async (role: string, email = `u-${tag()}@example.com`) => {
    const userId = `user-${tag()}`;
    await db
      .prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .bind(userId, "Owner", email, created, created)
      .run();
    await db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
      .bind(`m-${tag()}`, orgId, userId, role, created)
      .run();
    return { userId, email };
  };
  const owners = [];
  for (let i = 0; i < (opts.owners ?? 1); i++) owners.push(await add("owner"));
  const plain = await add("member");
  return { orgId, owners, plain, add };
}
const run = (sql: { sql: string; params: unknown[] }) =>
  db
    .prepare(sql.sql)
    .bind(...sql.params)
    .run();
const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

describe("sendTrialNotices", () => {
  it("tells every owner, once each, three days before and after the trial ends, and not the plain members", async () => {
    quiet();
    const sent = provider();
    // Created 11 days ago: the 14-day trial ends in three days.
    const ending = await organisation({ createdAgoDays: 11, owners: 2 });
    const first = await sendTrialNotices(
      { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` },
      () => NOW,
    );
    expect(first).toMatchObject({ sent: 2, failed: 0, uncertain: 0 });
    expect(sent.map((m) => m.to[0]).sort()).toEqual(ending.owners.map((o) => o.email).sort());
    expect(sent.every((m) => m.sender === "IsItLegit <no-reply@isitlegit.co.za>")).toBe(true);
    // A second run, and two overlapping, send nothing more.
    const again = await Promise.all([
      sendTrialNotices({ ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` }, () => NOW),
      sendTrialNotices({ ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` }, () => NOW),
    ]);
    expect(sent).toHaveLength(2);
    expect(again.every((c) => c.sent === 0)).toBe(true);
    // The trial has ended a day ago: the end notice goes to each owner, once.
    const later = new Date(NOW.getTime() + 4 * DAY);
    const ended = await sendTrialNotices(
      { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` },
      () => later,
    );
    expect(ended.sent).toBe(2);
    expect(sent).toHaveLength(4);
    expect(sent[2]?.subject).toMatch(
      /^The IsItLegit Protect trial for Karoo Couriers ended on \w{3} \d{1,2} Nov 2026$/,
    );
    await sendTrialNotices({ ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` }, () => later);
    expect(sent).toHaveLength(4);
    expect(ending.plain.email).not.toBe(sent[0]?.to[0]);
  });

  it("sends nothing for a trial not near its end, a chosen plan, a lapsed week, an extension's stale notice or the protected", async () => {
    quiet();
    const sent = provider();
    const E = { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` };
    await organisation({ createdAgoDays: 5 });
    const protect = await organisation({ createdAgoDays: 12 });
    await run(setPlanStatement(protect.orgId, "protect"));
    const free = await organisation({ createdAgoDays: 12 });
    await run(setPlanStatement(free.orgId, "free"));
    await organisation({ createdAgoDays: 30 });
    const demo = await organisation({ createdAgoDays: 12 });
    await demo.add("member", "derick@rizonetech.com");
    const noOwner = await organisation({ createdAgoDays: 12, owners: 0 });
    expect(noOwner.owners).toHaveLength(0);
    expect((await sendTrialNotices(E, () => NOW)).sent).toBe(0);
    expect(sent).toHaveLength(0);
    // An extension moves the end: the notice due for the old end is not sent, and the new end gets its own in time.
    const extended = await organisation({ createdAgoDays: 12, name: "Extended Ltd" });
    await run(extendTrialStatement(extended.orgId, new Date(NOW.getTime() + 20 * DAY), NOW));
    expect((await sendTrialNotices(E, () => NOW)).sent).toBe(0);
    const near = new Date(NOW.getTime() + 18 * DAY);
    expect((await sendTrialNotices(E, () => near)).sent).toBe(1);
    expect(sent.at(-1)?.subject).toContain("Extended Ltd");
  });

  it("tries a refused send again on the next run, leaves a lost answer to the reconciler, and drops it once no longer due", async () => {
    quiet();
    let mode: "ok" | "refuse" | "lost" = "refuse";
    const sent = provider(() => mode);
    const E = { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` };
    await organisation({ createdAgoDays: 11 });
    expect(await sendTrialNotices(E, () => NOW)).toMatchObject({ sent: 0, failed: 1 });
    mode = "ok";
    expect(await sendTrialNotices(E, () => NOW)).toMatchObject({ sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    // A lost answer is uncertain: never sent again from here.
    mode = "lost";
    await organisation({ createdAgoDays: 11, name: "Lost Answer Ltd" });
    expect(await sendTrialNotices(E, () => NOW)).toMatchObject({ uncertain: 1 });
    mode = "ok";
    expect((await sendTrialNotices(E, () => NOW)).sent).toBe(0);
    // A refusal left unresolved past the seven-day window is dropped: nothing is sent for a trial that ended long ago.
    mode = "refuse";
    const old = await organisation({ createdAgoDays: 11, name: "Old Ltd" });
    expect(old.orgId).toBeTruthy();
    await sendTrialNotices(E, () => NOW);
    mode = "ok";
    const farLater = new Date(NOW.getTime() + 20 * DAY);
    const before = sent.length;
    await sendTrialNotices(E, () => farLater);
    expect(sent.length).toBe(before);
  });

  it("words a notice recovered late by its date, not a countdown, and keeps what the organisation really keeps", async () => {
    quiet();
    const sent = provider();
    const E = { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` };
    // Ends in one day and one hour (a refusal recovered two days late): the heading names the date, never "three days".
    await organisation({ createdAgoDays: 12.96, name: "Late Ltd" });
    expect((await sendTrialNotices(E, () => NOW)).sent).toBe(1);
    expect(sent[0]?.text_body).not.toMatch(/three days|in 3 days/i);
    expect(sent[0]?.text_body).toMatch(/ends on \w{3} \d{1,2} Nov 2026/);
    // An operator's pause and a raised cap are what the organisation keeps.
    const paused = await organisation({ createdAgoDays: 11, name: "Paused Ltd" });
    await run(setDailyCapOverrideStatement(paused.orgId, 0));
    const raised = await organisation({ createdAgoDays: 11, name: "Raised Ltd" });
    await run(setDailyCapOverrideStatement(raised.orgId, 500));
    await sendTrialNotices(E, () => NOW);
    const pausedMail = sent.find((m) => m.subject.includes("Paused Ltd"));
    const raisedMail = sent.find((m) => m.subject.includes("Raised Ltd"));
    expect(pausedMail?.text_body).toContain("Checking is paused for Paused Ltd by IsItLegit");
    expect(pausedMail?.text_body).not.toContain("Free checks continue");
    expect(raisedMail?.text_body).toContain("up to 500 a day");
  });

  it("stops sending to the other owners when an extension or a chosen plan lands during the first send", async () => {
    quiet();
    const org = await organisation({ createdAgoDays: 11, owners: 3 });
    const sent: Payload[] = [];
    const real = globalThis.fetch;
    let first = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      sent.push(JSON.parse(String(init?.body ?? "{}")) as Payload);
      if (first) {
        first = false;
        await run(setPlanStatement(org.orgId, "protect"));
      }
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${sent.length}` } });
    });
    const counts = await sendTrialNotices(
      { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` },
      () => NOW,
    );
    expect(sent).toHaveLength(1);
    expect(counts.sent).toBe(1);
  });

  it("judges the second owner by the moment of their own send: a trial that ends during the first send gets them no 'ends' notice", async () => {
    quiet();
    const org = await organisation({ createdAgoDays: 0, owners: 2, name: "Edge Ltd" });
    // The trial ends two seconds after the run begins.
    const end = NOW.getTime() + 2_000;
    await db
      .prepare("INSERT INTO org_limits (org_id, plan, trial_ends_at) VALUES (?, NULL, ?)")
      .bind(org.orgId, new Date(end).toISOString())
      .run();
    let at = NOW.getTime();
    const sent: Payload[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      sent.push(JSON.parse(String(init?.body ?? "{}")) as Payload);
      at = end + 1_000;
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${sent.length}` } });
    });
    await sendTrialNotices(
      { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` },
      () => new Date(at),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text_body).toContain("When it ends, these stop");
  });

  it("does not send the owners' notice to an owner demoted during the first send", async () => {
    quiet();
    const org = await organisation({ createdAgoDays: 11, owners: 2 });
    const sent: Payload[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      const mail = JSON.parse(String(init?.body ?? "{}")) as Payload;
      sent.push(mail);
      // Everyone but the owner being mailed is demoted while this send is under way.
      const current = org.owners.find((o) => o.email === mail.to[0]);
      await db
        .prepare(`UPDATE "member" SET role = 'member' WHERE "organizationId" = ? AND "userId" <> ? AND role = 'owner'`)
        .bind(org.orgId, current?.userId ?? "")
        .run();
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${sent.length}` } });
    });
    await sendTrialNotices({ ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` }, () => NOW);
    expect(sent).toHaveLength(1);
  });

  it("drops a notice made obsolete while the provider asks it to wait: a 429, then an extension, then no send", async () => {
    quiet();
    const org = await organisation({ createdAgoDays: 11, name: "Slow Ltd" });
    const reached: string[] = [];
    const real = globalThis.fetch;
    let first = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      reached.push(url);
      if (first) {
        first = false;
        // Rate limited; while the retry waits, the operator moves the trial's end out.
        await run(extendTrialStatement(org.orgId, new Date(NOW.getTime() + 20 * DAY), NOW));
        return new Response(null, { status: 429 });
      }
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-late" } });
    });
    const counts = await sendTrialNotices(
      { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` },
      () => NOW,
    );
    expect(reached).toHaveLength(1);
    expect(counts).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
  }, 15_000);

  it("records a check that could not be made as failed, never uncertain, and the next run sends the notice", async () => {
    quiet();
    const sent = provider();
    await organisation({ createdAgoDays: 11, name: "Check Ltd" });
    const prepare = db.prepare.bind(db);
    let reads = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      // The membership read is made once before the send and once by the provider-call guard: the second one fails.
      if (sql.includes('SELECT role FROM "member" WHERE "organizationId" = ? AND "userId" = ?') && ++reads === 2)
        throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const E = { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` };
    const first = await sendTrialNotices(E, () => NOW);
    spy.mockRestore();
    expect(first).toMatchObject({ sent: 0, failed: 1, uncertain: 0 });
    expect(sent).toHaveLength(0);
    expect((await db.prepare("SELECT status FROM mail_sends").first<{ status: string }>())?.status).toBe("failed");
    expect(await sendTrialNotices(E, () => NOW)).toMatchObject({ sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it("drops a notice when the recipient is demoted during the provider's wait", async () => {
    quiet();
    const org = await organisation({ createdAgoDays: 11, name: "Demote Ltd" });
    const owner = org.owners[0] as { userId: string };
    const reached: string[] = [];
    const real = globalThis.fetch;
    let first = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      reached.push(url);
      if (first) {
        first = false;
        await db
          .prepare(`UPDATE "member" SET role = 'member' WHERE "organizationId" = ? AND "userId" = ?`)
          .bind(org.orgId, owner.userId)
          .run();
        return new Response(null, { status: 429 });
      }
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-late" } });
    });
    const counts = await sendTrialNotices(
      { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` },
      () => NOW,
    );
    expect(reached).toHaveLength(1);
    expect(counts).toMatchObject({ sent: 0, skipped: 1 });
  }, 15_000);

  it("says a failed read in its summary, never as nothing due", async () => {
    const log = quiet();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("l.plan IS NULL")) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    await expect(sendTrialNotices(env as unknown as Env, () => NOW)).rejects.toThrow();
    vi.restoreAllMocks();
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"event":"trial-notices"'));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ event: "trial-notices", outcome: "failed" });
  });

  it("logs one line of counts per run", async () => {
    const log = quiet();
    provider();
    await sendTrialNotices({ ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` }, () => NOW);
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"event":"trial-notices"'));
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      event: "trial-notices",
      outcome: "ran",
      sent: expect.any(Number),
    });
  });
});

describe("the notice email", () => {
  const base = {
    appUrl: "https://app.isitlegit.co.za",
    organisation: "Karoo Couriers",
    link: "https://app.isitlegit.co.za/settings/plan",
    freePerDay: 5,
  };
  const endsAt = new Date("2026-11-13T08:00:00.000Z");
  const plain = (html: string) =>
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ");

  it("says the organisation, the exact end, what stops, that free checks continue, and no billing, in both parts", () => {
    for (const kind of ["ending", "ended"] as const) {
      const mail = trialNoticeEmail({ ...base, kind, endsAt });
      expect(mail.subject).toContain("Karoo Couriers");
      expect(mail.subject).toContain("Fri 13 Nov 2026");
      for (const part of [mail.text, plain(mail.html)]) {
        expect(part).toContain("Fri 13 Nov 2026 at 10:00 SAST");
        expect(part).toContain(kind === "ending" ? "When it ends, these stop" : "These are switched off now");
        expect(part).toContain("impersonation alerts");
        expect(part).toContain("Free checks continue: verdicts on forwarded mail, up to 5 a day.");
        expect(part).toContain("switch to Karoo Couriers first");
        expect(part).not.toMatch(/invoice for|charged \d|pay now|R\d{3}/i);
      }
      expect(mail.text.match(/https?:\/\/\S+/)?.[0]).toBe(base.link);
      expect(mail.html).toContain('alt="IsItLegit"');
      expect(mail.html).not.toMatch(/display\s*:\s*(flex|grid)/);
    }
  });

  it("escapes a hostile organisation name and keeps the subject on one line", () => {
    const mail = trialNoticeEmail({
      ...base,
      kind: "ending",
      endsAt,
      organisation: "<script>x</script>\r\nBcc: a@b.example",
    });
    expect(mail.html).not.toContain("<script>x</script>");
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
});
