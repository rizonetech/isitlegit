import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPlanStatement } from "../../src/auth/plan-sql";
import { hasFeature } from "../../src/auth/plans";
import { admitCase } from "../../src/db/cases";
import { ulid } from "../../src/db/ulid";
import worker from "../../src/index";
import {
  CLAIM_LEASE_MS,
  handleEmail,
  isAutomatic,
  MAX_MESSAGE_BYTES,
  RetryDelivery,
  sweepIntake,
} from "../../src/intake/email";
import { EMAIL_ROUTING_AUTHSERV_ID } from "../../src/intake/sender";
import { rawKey } from "../../src/intake/store";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";

// D01 T01 §3: the email front door. A forward becomes one case only from an authenticated sender of a verified domain
// or address; each delivery is claimed first, and every failure is undone or left to a claim the sweep settles.
const db = env.DB;
const mailEnv = { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` };
const HOUR = 60 * 60_000;

const world = { smtp: "sent" as "sent" | "refused", sends: [] as { to: string; text: string }[] };
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  world.smtp = "sent";
  world.sends = [];
  const real = globalThis.fetch;
  spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === SMTP2GO_URL) {
      if (world.smtp === "refused")
        return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { to: string[]; text_body: string };
      world.sends.push({ to: body.to[0] ?? "", text: body.text_body });
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${world.sends.length}` } });
    }
    return real(input, init);
  });
});
afterEach(() => spy.mockRestore());
// A Workflow a sweep or a takeover started (D01 T03 §12), run to its end inside the test, while SMTP2GO is stubbed.
async function ran(caseId: string) {
  const instance = await env.ANALYSIS.get(caseId);
  for (let tries = 0; tries < 200; tries++) {
    const { status } = await instance.status();
    if (status === "complete" || status === "errored" || status === "terminated") return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the Workflow for ${caseId} did not finish`);
}
const statusOf = async (caseId: string) =>
  (await db.prepare("SELECT status FROM cases WHERE id = ?").bind(caseId).first<{ status: string }>())?.status;
const failedStep = async (caseId: string) =>
  db
    .prepare("SELECT step, error FROM case_events WHERE case_id = ? AND status = 'failed'")
    .bind(caseId)
    .all<{ step: string; error: string }>()
    .then((r) => r.results);

// An organisation with a verified domain, unique to the test.
let orgs = 0;
async function member(options: { cap?: number } = {}) {
  orgs += 1;
  const orgId = `org-intake-${orgs}`;
  const domain = `member${orgs}.co.za`;
  const at = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, 'tttttttttttttttt', 'verified', 'dns', ?, ?)",
    )
    .bind(`d-${orgId}`, orgId, domain, at, at)
    .run();
  if (options.cap !== undefined)
    await db
      .prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, ?)")
      .bind(orgId, options.cap)
      .run();
  return { orgId, domain, from: `boss@${domain}` };
}

// A forward as Email Routing hands it to the Worker.
function message(
  from: string,
  options: {
    messageId?: string | null;
    auth?: string;
    body?: string;
    rawSize?: number;
    from?: string;
    autoSubmitted?: string;
  } = {},
) {
  const domain = from.slice(from.indexOf("@") + 1);
  const messageId = options.messageId === undefined ? `<${crypto.randomUUID()}@${domain}>` : options.messageId;
  const auth =
    options.auth ?? `${EMAIL_ROUTING_AUTHSERV_ID}; spf=pass smtp.mailfrom=${from}; dkim=pass header.d=${domain}`;
  const text = [
    `Authentication-Results: ${auth}`,
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    `From: ${options.from ?? from}`,
    "To: check@isitlegit.co.za",
    "Subject: Fwd: invoice",
    "",
    options.body ?? "Is this real?",
    "",
  ].join("\r\n");
  const bytes = new TextEncoder().encode(text);
  const rejected: string[] = [];
  const headers = new Headers();
  if (messageId) headers.set("Message-ID", messageId);
  if (options.autoSubmitted) headers.set("Auto-Submitted", options.autoSubmitted);
  const forwardable = {
    from,
    to: "check@isitlegit.co.za",
    headers,
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
    rawSize: options.rawSize ?? bytes.byteLength,
    setReject: (reason: string) => rejected.push(reason),
    forward: async () => ({ messageId: "" }),
    reply: async () => ({ messageId: "" }),
  } as unknown as ForwardableEmailMessage;
  return { forwardable, rejected, bytes, messageId };
}
// The same message delivered again: a fresh stream over the same bytes.
const again = (m: ReturnType<typeof message>) => {
  const headers = new Headers();
  if (m.messageId) headers.set("Message-ID", m.messageId);
  return {
    ...m.forwardable,
    headers,
    raw: new Response(m.bytes).body,
    setReject: m.forwardable.setReject,
  } as unknown as ForwardableEmailMessage;
};

const casesOf = async (orgId: string) =>
  (
    await db
      .prepare("SELECT id, forwarded_by, message_id FROM cases WHERE org_id = ? ORDER BY created_at")
      .bind(orgId)
      .all<{ id: string; forwarded_by: string; message_id: string | null }>()
  ).results;
const claimsOf = async (orgId: string) =>
  (
    await db
      .prepare("SELECT message_key, state, case_id FROM intake_messages WHERE org_id = ?")
      .bind(orgId)
      .all<{ message_key: string; state: string; case_id: string | null }>()
  ).results;
const rawExists = async (caseId: string) => (await env.ARTEFACTS.head(rawKey(caseId))) !== null;
const workflowExists = async (caseId: string) =>
  env.ANALYSIS.get(caseId).then(
    () => true,
    () => false,
  );
const outcome = (p: Promise<unknown>) =>
  p.then(
    (v) => v,
    (e: Error) => ({ thrown: e.name }),
  );

// A pause: `hold` waits until `release`; `reached` resolves once `count` are held.
function held(count: number) {
  let holding = 0;
  let reach: () => void = () => {};
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold = async () => {
    holding += 1;
    if (holding === count) reach();
    await released;
  };
  return { reached, release, hold };
}

describe("handleEmail", () => {
  it("makes one case from a verified member's forward: the forwarder stored, the raw message, the Workflow, a done claim", async () => {
    const { orgId, from } = await member();
    const m = message(from.toUpperCase().replace("BOSS", "Boss"));
    const result = await handleEmail(m.forwardable, mailEnv);
    expect(result.kind).toBe("admitted");
    const [made] = await casesOf(orgId);
    expect(made).toMatchObject({ forwarded_by: from, message_id: m.messageId });
    const caseId = made?.id as string;
    const raw = await env.ARTEFACTS.get(rawKey(caseId));
    expect(new Uint8Array((await raw?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(m.bytes);
    expect(await db.prepare("SELECT kind, bytes FROM artefacts WHERE case_id = ?").bind(caseId).first()).toEqual({
      kind: "raw",
      bytes: m.bytes.byteLength,
    });
    expect(await workflowExists(caseId)).toBe(true);
    expect(await claimsOf(orgId)).toEqual([{ message_key: `email:id:${m.messageId}`, state: "done", case_id: caseId }]);
    expect(world.sends).toEqual([]);
  });

  it("keeps a Message-ID that reads like a hash apart from the hash of a message without one", async () => {
    const { orgId, from } = await member();
    const { sha256Hex } = await import("../../src/intake/admit");
    const unnamed = message(from, { messageId: null });
    const spoof = message(from, { messageId: `sha256:${await sha256Hex(unnamed.bytes)}` });
    expect((await handleEmail(spoof.forwardable, mailEnv)).kind).toBe("admitted");
    expect((await handleEmail(unnamed.forwardable, mailEnv)).kind).toBe("admitted");
    expect(await casesOf(orgId)).toHaveLength(2);
  });

  it("maps a claim keyed by a forward's hash before migration 0019 to the hash form, any other to the id form", async () => {
    const org = `org-forms-${crypto.randomUUID().slice(0, 8)}`;
    const hash = `sha256:${"ab".repeat(32)}`;
    for (const key of [hash, "<b@fictional.example>"])
      await db
        .prepare(
          "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, 'done', NULL, ?)",
        )
        .bind(org, key, new Date().toISOString())
        .run();
    const migration = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0019"));
    for (const query of migration?.queries ?? []) await db.prepare(query).run();
    const keys = (
      await db.prepare("SELECT message_key FROM intake_messages WHERE org_id = ? ORDER BY message_key").bind(org).all<{
        message_key: string;
      }>()
    ).results.map((r) => r.message_key);
    expect(keys).toEqual(["email:id:<b@fictional.example>", `email:${hash}`]);
  });

  it("migrates claims whose keys would meet if renamed in place: <a> and email:id:<a> both kept", async () => {
    const org = `org-collide-${crypto.randomUUID().slice(0, 8)}`;
    const at = new Date().toISOString();
    // <a> becomes email:id:<a>, which a claim left from before already holds until it is renamed in its turn.
    for (const key of ["<a@fictional.example>", "email:id:<a@fictional.example>"])
      await db
        .prepare(
          "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, 'done', NULL, ?)",
        )
        .bind(org, key, at)
        .run();
    const migration = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0019"));
    for (const query of migration?.queries ?? []) await db.prepare(query).run();
    const keys = (
      await db.prepare("SELECT message_key FROM intake_messages WHERE org_id = ? ORDER BY message_key").bind(org).all<{
        message_key: string;
      }>()
    ).results.map((r) => r.message_key);
    expect(keys).toEqual(["email:id:<a@fictional.example>", "email:id:email:id:<a@fictional.example>"]);
  });

  it("finds a claim made before migration 0019 when the same forward is delivered again after it", async () => {
    const { orgId, from } = await member();
    const m = message(from);
    // A done claim as the previous version wrote it: the Message-ID alone, no door.
    await db
      .prepare(
        "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, 'done', NULL, ?)",
      )
      .bind(orgId, m.messageId, new Date().toISOString())
      .run();
    const migration = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0019"));
    expect(migration).toBeDefined();
    for (const query of migration?.queries ?? []) await db.prepare(query).run();
    expect(await handleEmail(m.forwardable, mailEnv)).toEqual({ kind: "duplicate" });
    expect(await casesOf(orgId)).toEqual([]);
    expect(await claimsOf(orgId)).toEqual([{ message_key: `email:id:${m.messageId}`, state: "done", case_id: null }]);
    expect(world.sends).toEqual([]);
  });

  it("reads Auto-Submitted as RFC 3834's keyword, comments and parameters around it", () => {
    for (const machine of [
      "auto-replied",
      "no-reply",
      "No-Reply",
      "auto-generated; owner-email=a@b",
      "(x) auto-replied",
      "",
    ])
      expect(isAutomatic(machine), machine).toBe(true);
    for (const person of ["no", "No", " no ", "(human) no", "no (sent by a person)", "no; reason=x"])
      expect(isAutomatic(person), person).toBe(false);
    expect(isAutomatic(null)).toBe(false);
  });

  it("ignores a message a machine sent on its own, and takes one marked Auto-Submitted: no", async () => {
    const { orgId, from } = await member();
    for (const value of ["auto-replied", "auto-generated", "Auto-Replied; owner-email=x@y"])
      expect(await handleEmail(message(from, { autoSubmitted: value }).forwardable, mailEnv)).toEqual({
        kind: "automatic",
      });
    expect(await casesOf(orgId)).toEqual([]);
    expect(world.sends).toEqual([]);
    const human = await handleEmail(message(from, { autoSubmitted: "no" }).forwardable, mailEnv);
    expect(human.kind).toBe("admitted");
  });

  it("logs one line a delivery naming its outcome, and for a drop the member match and the auth results, never an address", async () => {
    const { from } = await member();
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const unknown = message("someone@unknown.co.za");
    expect(await handleEmail(unknown.forwardable, mailEnv, new Date(), log)).toEqual({ kind: "dropped" });
    const failed = message(from, {
      auth: `${EMAIL_ROUTING_AUTHSERV_ID}; spf=fail smtp.mailfrom=${from}; dkim=pass header.d=evil.com`,
    });
    expect(await handleEmail(failed.forwardable, mailEnv, new Date(), log)).toEqual({ kind: "dropped" });
    const admitted = await handleEmail(message(from).forwardable, mailEnv, new Date(), log);
    expect(admitted.kind).toBe("admitted");
    const [first, second, third] = lines.map((line) => JSON.parse(line));
    // A non-member's forward that claims no protected business (D05 T02 §1) names why it was dropped.
    expect(first).toEqual({
      event: "intake",
      outcome: "dropped",
      member: null,
      counterparty: "no-claim",
      auth: {
        authservId: EMAIL_ROUTING_AUTHSERV_ID,
        results: [
          { method: "spf", result: "pass", domain: "unknown.co.za" },
          { method: "dkim", result: "pass", domain: "unknown.co.za" },
        ],
      },
    });
    expect(second).toMatchObject({ outcome: "dropped", member: "domain" });
    expect(second.auth.results).toEqual([
      { method: "spf", result: "fail", domain: from.slice(from.indexOf("@") + 1) },
      { method: "dkim", result: "pass", domain: "evil.com" },
    ]);
    expect(third).toEqual({ event: "intake", outcome: "admitted", caseId: (admitted as { caseId: string }).caseId });
    for (const line of lines) {
      expect(line).not.toContain("someone@");
      expect(line).not.toContain(from);
      expect(line).not.toContain(unknown.messageId);
    }
  });

  it("drops mail from an unknown sender, and a member's address in a forward authenticated for another domain", async () => {
    const { orgId, from } = await member();
    for (const m of [
      message("someone@unknown.co.za"),
      message(from, {
        auth: `${EMAIL_ROUTING_AUTHSERV_ID}; spf=fail smtp.mailfrom=${from}; dkim=pass header.d=evil.com`,
      }),
      message(from, { auth: `mx.evil.com; spf=pass smtp.mailfrom=${from}` }),
    ])
      expect(await handleEmail(m.forwardable, mailEnv)).toEqual({ kind: "dropped" });
    expect(await casesOf(orgId)).toEqual([]);
    expect(await claimsOf(orgId)).toEqual([]);
    expect(world.sends).toEqual([]);
  });

  it("rejects a message over 25 MiB before reading it, storing nothing", async () => {
    const { orgId, from } = await member();
    const m = message(from, { rawSize: MAX_MESSAGE_BYTES + 1 });
    // Reading the message at all fails the test: the size is refused from rawSize alone.
    Object.defineProperty(m.forwardable, "raw", {
      get() {
        throw new Error("the raw message was read");
      },
    });
    expect(await handleEmail(m.forwardable, mailEnv)).toEqual({ kind: "too-large" });
    expect(m.rejected).toEqual(["Message too large"]);
    expect(await casesOf(orgId)).toEqual([]);
    expect(world.sends).toEqual([]);
  });

  it("makes one case of the same message delivered twice, in turn or at once, and a second a day later", async () => {
    const { orgId, from } = await member();
    const m = message(from);
    expect((await handleEmail(m.forwardable, mailEnv)).kind).toBe("admitted");
    expect(await handleEmail(again(m), mailEnv)).toEqual({ kind: "duplicate" });
    expect(await casesOf(orgId)).toHaveLength(1);
    // At once: one is processed, the other thrown so it is retried rather than dropped while the first may still fail.
    const both = message(from);
    const answers = await Promise.all([
      outcome(handleEmail(both.forwardable, mailEnv)),
      outcome(handleEmail(again(both), mailEnv)),
    ]);
    expect(answers.map((a) => ("thrown" in (a as object) ? "thrown" : (a as { kind: string }).kind)).sort()).toEqual([
      "admitted",
      "thrown",
    ]);
    expect(await casesOf(orgId)).toHaveLength(2);
    // A day and a minute later, the first message is a new delivery.
    const later = new Date(Date.now() + 24 * HOUR + 60_000);
    expect((await handleEmail(again(m), mailEnv, later)).kind).toBe("admitted");
    expect(await casesOf(orgId)).toHaveLength(3);
  });

  it("keys a message with no Message-ID by its content", async () => {
    const { orgId, from } = await member();
    const m = message(from, { messageId: null });
    expect((await handleEmail(m.forwardable, mailEnv)).kind).toBe("admitted");
    expect(await handleEmail(again(m), mailEnv)).toEqual({ kind: "duplicate" });
    const [claim] = await claimsOf(orgId);
    expect(claim?.message_key).toMatch(/^email:sha256:[0-9a-f]{64}$/);
    expect((await casesOf(orgId))[0]?.message_id).toBeNull();
  });

  it("takes over a delivery that stopped: done when its Workflow runs, made afresh when it never started", async () => {
    const { orgId, from } = await member();
    const old = new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString();
    // Stopped after the Workflow started.
    const started = message(from);
    const first = await admitCase(db, { orgId, channel: "email", headersAvailable: false, forwardedBy: from });
    if (!first.ok) throw new Error(first.error.message);
    await env.ANALYSIS.create({ id: first.value.id, params: { caseId: first.value.id } });
    await db
      .prepare(
        "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, 'pending', ?, ?)",
      )
      .bind(orgId, `email:id:${started.messageId}`, first.value.id, old)
      .run();
    expect(await handleEmail(started.forwardable, mailEnv)).toEqual({ kind: "duplicate" });
    // Stopped before it, its raw message never recorded: the old case stays, ended partial (RawMissing) where the
    // member sees it, and the delivery makes one new case beside it (D01 T03 §12).
    const stopped = message(from);
    const orphan = await admitCase(db, { orgId, channel: "email", headersAvailable: false, forwardedBy: from });
    if (!orphan.ok) throw new Error(orphan.error.message);
    await env.ARTEFACTS.put(rawKey(orphan.value.id), stopped.bytes);
    await db
      .prepare(
        "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, 'pending', ?, ?)",
      )
      .bind(orgId, `email:id:${stopped.messageId}`, orphan.value.id, old)
      .run();
    const result = await handleEmail(stopped.forwardable, mailEnv);
    expect(result.kind).toBe("admitted");
    expect(await statusOf(orphan.value.id)).toBe("partial");
    expect(await failedStep(orphan.value.id)).toEqual([{ step: "admit", error: "RawMissing" }]);
    const ids = (await casesOf(orgId)).map((c) => c.id);
    expect(ids.sort()).toEqual([first.value.id, orphan.value.id, (result as { caseId: string }).caseId].sort());
    expect((await claimsOf(orgId)).map((c) => c.state)).toEqual(["done", "done"]);
  });

  it("caps a Free organisation at its plan's 5 a day, its notice naming 5 (D07 T08 §8)", async () => {
    const { orgId, from } = await member();
    // A real organisation, as a plan is only ever set on one.
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Free Intake', ?, ?)`)
      .bind(orgId, `free-${orgId}`, new Date().toISOString())
      .run();
    const plan = setPlanStatement(orgId, "free");
    await db
      .prepare(plan.sql)
      .bind(...plan.params)
      .run();
    for (let i = 0; i < 5; i++)
      expect((await handleEmail(message(from).forwardable, mailEnv)).kind, `forward ${i + 1}`).toBe("admitted");
    expect(await handleEmail(message(from).forwardable, mailEnv)).toEqual({ kind: "capped" });
    expect(world.sends).toHaveLength(1);
    expect(world.sends[0]).toMatchObject({ to: from, text: expect.stringContaining("limit of 5 checks") });
  });

  it("files an expired trial's member forwards as Free checks until 5, then the notice, while a live trial keeps 50 (D05 T02 §1)", async () => {
    const DAY = 24 * HOUR;
    // Organisations whose trial lapses on its own: no plan stored, created 15 days ago against one created today.
    const real = async (orgId: string, created: Date) =>
      db
        .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Trial Intake', ?, ?)`)
        .bind(orgId, `trial-${orgId}`, created.toISOString())
        .run();
    const expired = await member();
    await real(expired.orgId, new Date(Date.now() - 15 * DAY));
    const live = await member();
    await real(live.orgId, new Date());
    expect(await hasFeature(db, expired.orgId, "staff-inbox")).toBe(false);
    expect(await hasFeature(db, live.orgId, "staff-inbox")).toBe(true);
    // Eleven cases are admitted: each Workflow is recorded rather than run, since only the filing is under test.
    const started: string[] = [];
    const analysis = {
      create: async (options: { id: string }) => {
        started.push(options.id);
        return { id: options.id };
      },
      get: async (id: string) => ({ id, status: async () => ({ status: "queued" }) }),
    } as unknown as Env["ANALYSIS"];
    const recorded = { ...mailEnv, ANALYSIS: analysis } as Env;

    for (let i = 0; i < 5; i++)
      expect((await handleEmail(message(expired.from).forwardable, recorded)).kind, `forward ${i + 1}`).toBe(
        "admitted",
      );
    expect(await handleEmail(message(expired.from).forwardable, recorded)).toEqual({ kind: "capped" });
    expect((await casesOf(expired.orgId)).length).toBe(5);
    expect(world.sends).toHaveLength(1);
    expect(world.sends[0]).toMatchObject({ to: expired.from, text: expect.stringContaining("limit of 5 checks") });

    for (let i = 0; i < 6; i++)
      expect((await handleEmail(message(live.from).forwardable, recorded)).kind, `live forward ${i + 1}`).toBe(
        "admitted",
      );
    expect((await casesOf(live.orgId)).length).toBe(6);
    expect(world.sends).toHaveLength(1);
    expect(started).toHaveLength(11);
  });

  it("names 00:00 SAST as the reset, and tells a paused organisation its checks are paused, no reset promised (D07 T08 §8)", async () => {
    const reached = await member({ cap: 1 });
    expect((await handleEmail(message(reached.from).forwardable, mailEnv)).kind).toBe("admitted");
    expect(await handleEmail(message(reached.from).forwardable, mailEnv)).toEqual({ kind: "capped" });
    expect(world.sends.at(-1)?.text).toContain("it resets at 00:00 SAST");
    const paused = await member({ cap: 0 });
    expect(await handleEmail(message(paused.from).forwardable, mailEnv)).toEqual({ kind: "capped" });
    const notice = world.sends.at(-1)?.text ?? "";
    expect(notice).toContain("Checks are paused for your organisation");
    expect(notice).not.toMatch(/midnight|00:00|tomorrow/);
    // Still paused the next day: still refused, still no reset promised.
    const tomorrow = new Date(Date.now() + 24 * HOUR);
    expect(await handleEmail(message(paused.from).forwardable, mailEnv, tomorrow)).toEqual({ kind: "capped" });
  });

  it("at the cap makes no case, sends one notice a day naming the cap, and takes the same message after midnight", async () => {
    const { orgId, from } = await member({ cap: 1 });
    expect((await handleEmail(message(from).forwardable, mailEnv)).kind).toBe("admitted");
    const capped = message(from);
    expect(await handleEmail(capped.forwardable, mailEnv)).toEqual({ kind: "capped" });
    expect(world.sends).toHaveLength(1);
    expect(world.sends[0]).toMatchObject({ to: from, text: expect.stringContaining("limit of 1 checks") });
    // Another capped forward the same day, and two at once: no further notice.
    expect(await handleEmail(message(from).forwardable, mailEnv)).toEqual({ kind: "capped" });
    await Promise.all([
      handleEmail(message(from).forwardable, mailEnv),
      handleEmail(message(from).forwardable, mailEnv),
    ]);
    expect(world.sends).toHaveLength(1);
    expect(await casesOf(orgId)).toHaveLength(1);
    expect(await claimsOf(orgId)).toHaveLength(1);
    // After midnight SAST the capped message is a new delivery.
    const tomorrow = new Date(Date.now() + 24 * HOUR);
    expect((await handleEmail(again(capped), mailEnv, tomorrow)).kind).toBe("admitted");
  });

  it("sends a notice that failed with the next capped forward that day", async () => {
    const { from } = await member({ cap: 0 });
    world.smtp = "refused";
    expect(await handleEmail(message(from).forwardable, mailEnv)).toEqual({ kind: "capped" });
    expect(world.sends).toHaveLength(0);
    world.smtp = "sent";
    expect(await handleEmail(message(from).forwardable, mailEnv)).toEqual({ kind: "capped" });
    expect(world.sends).toHaveLength(1);
  });
});

// The environment with one binding's calls made to fail.
function failing(overrides: {
  db?: (sql: string) => boolean;
  put?: boolean;
  deleteRaw?: boolean;
  analysis?: Env["ANALYSIS"];
}) {
  const DB = overrides.db
    ? new Proxy(db, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              if (overrides.db?.(sql)) throw new Error("D1_ERROR: Network connection lost.");
              return target.prepare(sql);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : db;
  const ARTEFACTS = new Proxy(env.ARTEFACTS, {
    get(target, key) {
      if (key === "put" && overrides.put) return async () => Promise.reject(new Error("R2 unavailable"));
      if (key === "delete" && overrides.deleteRaw) return async () => Promise.reject(new Error("R2 unavailable"));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...mailEnv, DB, ARTEFACTS, ANALYSIS: overrides.analysis ?? env.ANALYSIS } as Env;
}

describe("round 1 cases", () => {
  it("admits a single verified address only from its own signed mailbox, not another user of its provider", async () => {
    orgs += 1;
    const orgId = `org-intake-${orgs}`;
    const victim = `registered.user${orgs}@gmail.com`;
    const at = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO org_addresses (id, org_id, address, state, verified_at, created_at) VALUES (?, ?, ?, 'verified', ?, ?)",
      )
      .bind(`a-${orgId}`, orgId, victim, at, at)
      .run();
    // Another gmail.com user's own signed message, the envelope forged to the registered address.
    const forged = message(victim, {
      auth: `${EMAIL_ROUTING_AUTHSERV_ID}; dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=${victim}`,
      from: "attacker@gmail.com",
    });
    expect(await handleEmail(forged.forwardable, mailEnv)).toEqual({ kind: "dropped" });
    expect(await casesOf(orgId)).toEqual([]);
    // The registered user's own signed message.
    const own = message(victim, { auth: `${EMAIL_ROUTING_AUTHSERV_ID}; dkim=pass header.d=gmail.com` });
    expect((await handleEmail(own.forwardable, mailEnv)).kind).toBe("admitted");
    expect((await casesOf(orgId))[0]?.forwarded_by).toBe(victim);
  });

  it("sends the cap notice to a forwarder whose address is longer than a send key", async () => {
    orgs += 1;
    const orgId = `org-intake-long-${orgs}-${"x".repeat(20)}`;
    const site = `${"c".repeat(50)}.co.za`;
    const from = `${"a".repeat(60)}@${"b".repeat(50)}.${site}`;
    const at = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, 'tttttttttttttttt', 'verified', 'dns', ?, ?)",
        )
        .bind(`d-${orgId}`, orgId, site, at, at),
      db.prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, 0)").bind(orgId),
    ]);
    expect(from.length).toBeGreaterThan(160);
    expect(await handleEmail(message(from).forwardable, mailEnv)).toEqual({ kind: "capped" });
    expect(world.sends).toEqual([
      { to: from, text: expect.stringContaining("Checks are paused for your organisation") },
    ]);
  });
});

describe("a delivery whose later step fails", () => {
  it("releases its claim when the case cannot be admitted, so the retry is processed", async () => {
    const { orgId, from } = await member();
    const m = message(from);
    await expect(
      handleEmail(m.forwardable, failing({ db: (sql) => sql.startsWith("INSERT INTO cases") })),
    ).rejects.toBeInstanceOf(RetryDelivery);
    expect(await claimsOf(orgId)).toEqual([]);
    expect((await handleEmail(again(m), mailEnv)).kind).toBe("admitted");
  });

  it("keeps the case, ended partial, when the raw message cannot be stored, and the retry makes a new one", async () => {
    const { orgId, from } = await member();
    const m = message(from);
    await expect(handleEmail(m.forwardable, failing({ put: true }))).rejects.toBeInstanceOf(RetryDelivery);
    // A case the member may have seen is never deleted (D01 T03 §12): it reads RawMissing, and its claim is freed.
    const [kept] = await casesOf(orgId);
    expect(await statusOf(kept?.id as string)).toBe("partial");
    expect(await failedStep(kept?.id as string)).toEqual([{ step: "admit", error: "RawMissing" }]);
    expect(await claimsOf(orgId)).toEqual([]);
    expect((await handleEmail(again(m), mailEnv)).kind).toBe("admitted");
    expect(await casesOf(orgId)).toHaveLength(2);
  });

  it("leaves a RawMissing case out of the day's cap, so its replacement is admitted on the last slot", async () => {
    const { orgId, from } = await member({ cap: 1 });
    const m = message(from);
    // The day's one case fails to store: it stays, partial, and does not use the day's one check.
    await expect(handleEmail(m.forwardable, failing({ put: true }))).rejects.toBeInstanceOf(RetryDelivery);
    expect((await handleEmail(again(m), mailEnv)).kind).toBe("admitted");
    expect(await casesOf(orgId)).toHaveLength(2);
    // The replacement is an ordinary case: it counts, so the next forward is capped.
    expect(await handleEmail(message(from).forwardable, mailEnv)).toEqual({ kind: "capped" });
  });

  it("keeps the case and its raw message when the Workflow did not start, and the sweep starts it", async () => {
    const { orgId, from } = await member();
    let attempted = "";
    const analysis = {
      create: async (options: { id: string }) => {
        attempted = options.id;
        throw new Error("internal error");
      },
      get: async () => Promise.reject(new Error("instance.not_found")),
    } as unknown as Env["ANALYSIS"];
    const m = message(from);
    await expect(handleEmail(m.forwardable, failing({ analysis }))).rejects.toBeInstanceOf(RetryDelivery);
    expect(attempted).not.toBe("");
    // Stored, not started: the case and its claim stay for the sweep, which starts it after the lease (D01 T03 §12).
    expect((await casesOf(orgId)).map((c) => c.id)).toEqual([attempted]);
    expect(await claimsOf(orgId)).toEqual([
      { message_key: `email:id:${m.messageId}`, state: "pending", case_id: attempted },
    ]);
    expect(await rawExists(attempted)).toBe(true);
    await sweepIntake(env as unknown as Env, new Date(Date.now() + CLAIM_LEASE_MS + 60_000));
    expect(await workflowExists(attempted)).toBe(true);
    await ran(attempted);
    expect((await claimsOf(orgId))[0]?.state).toBe("done");
  });

  it("keeps the case when the Workflow started but its answer was lost", async () => {
    const { orgId, from } = await member();
    const analysis = {
      create: async (options: { id: string; params: { caseId: string } }) => {
        await env.ANALYSIS.create(options);
        throw new Error("network connection lost");
      },
      get: (id: string) => env.ANALYSIS.get(id),
    } as unknown as Env["ANALYSIS"];
    const result = await handleEmail(message(from).forwardable, failing({ analysis }));
    expect(result.kind).toBe("admitted");
    const [made] = await casesOf(orgId);
    expect(await workflowExists(made?.id as string)).toBe(true);
    expect(await rawExists(made?.id as string)).toBe(true);
    expect((await claimsOf(orgId))[0]?.state).toBe("done");
  });

  it("leaves the case and a pending claim when it cannot tell whether the Workflow started, for the sweep to settle", async () => {
    const { orgId, from } = await member();
    const analysis = {
      create: async () => Promise.reject(new Error("internal error")),
      get: async () => Promise.reject(new Error("internal error")),
    } as unknown as Env["ANALYSIS"];
    const m = message(from);
    await expect(handleEmail(m.forwardable, failing({ analysis }))).rejects.toBeInstanceOf(RetryDelivery);
    const [made] = await casesOf(orgId);
    expect(await claimsOf(orgId)).toEqual([
      { message_key: `email:id:${m.messageId}`, state: "pending", case_id: made?.id },
    ]);
    // The sweep, after the lease, finds the case stored with no Workflow and starts it (D01 T03 §12), never removing
    // a case the member may have seen; the retried delivery is then that case's.
    const counts = await sweepIntake(env as unknown as Env, new Date(Date.now() + CLAIM_LEASE_MS + 60_000));
    expect(counts.completed).toBeGreaterThanOrEqual(1);
    expect(await workflowExists(made?.id as string)).toBe(true);
    await ran(made?.id as string);
    expect(await rawExists(made?.id as string)).toBe(true);
    expect((await claimsOf(orgId))[0]?.state).toBe("done");
    expect((await handleEmail(again(m), mailEnv)).kind).toBe("duplicate");
    expect(await casesOf(orgId)).toHaveLength(1);
  });

  it("leaves a pending claim when the undo itself fails, which a retry after the lease settles", async () => {
    const { orgId, from } = await member();
    const analysis = {
      create: async () => Promise.reject(new Error("internal error")),
      get: async () => Promise.reject(new Error("instance.not_found")),
    } as unknown as Env["ANALYSIS"];
    const m = message(from);
    await expect(handleEmail(m.forwardable, failing({ analysis, deleteRaw: true }))).rejects.toBeInstanceOf(
      RetryDelivery,
    );
    const [stuck] = await casesOf(orgId);
    expect((await claimsOf(orgId))[0]).toMatchObject({ state: "pending", case_id: stuck?.id });
    // A retry within the lease is told to come back later; after it, the stuck case (its message stored, the undo
    // having failed) is started rather than removed, and the retry is its duplicate (D01 T03 §12).
    await expect(handleEmail(again(m), mailEnv)).rejects.toBeInstanceOf(RetryDelivery);
    const result = await handleEmail(again(m), mailEnv, new Date(Date.now() + CLAIM_LEASE_MS + 60_000));
    expect(result.kind).toBe("duplicate");
    expect(await workflowExists(stuck?.id as string)).toBe(true);
    await ran(stuck?.id as string);
    expect((await casesOf(orgId)).map((c) => c.id)).toEqual([stuck?.id]);
  });
});

describe("a delivery interrupted around admission (completion review)", () => {
  it("keeps a case whose insert committed while its answer was lost, ended partial, and the retry makes one more", async () => {
    const { orgId, from } = await member();
    // The case insert runs, then the call fails as if the connection dropped on the way back.
    const lost = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith("INSERT INTO cases")) return statement;
            const bind = statement.bind.bind(statement);
            statement.bind = (...values: unknown[]) => {
              const bound = bind(...values);
              const run = bound.run.bind(bound);
              return Object.assign(bound, {
                run: async () => {
                  await run();
                  throw new Error("D1_ERROR: Network connection lost.");
                },
              });
            };
            return statement;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const m = message(from);
    await expect(handleEmail(m.forwardable, { ...mailEnv, DB: lost })).rejects.toBeInstanceOf(RetryDelivery);
    // The case committed, so it may be seen: kept, ended partial (RawMissing), its claim freed (D01 T03 §12).
    const [kept] = await casesOf(orgId);
    expect(await statusOf(kept?.id as string)).toBe("partial");
    expect(await claimsOf(orgId)).toEqual([]);
    expect((await handleEmail(again(m), mailEnv)).kind).toBe("admitted");
    expect(await casesOf(orgId)).toHaveLength(2);
  });

  it("leaves a claim naming its case when the connection drops right after the case is made, which the sweep settles", async () => {
    const { orgId, from } = await member();
    // The case insert commits, then every later database call fails: nothing after it can be written or undone.
    let dropped = false;
    const dropping = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (dropped) throw new Error("D1_ERROR: Network connection lost.");
            const statement = target.prepare(sql);
            if (!sql.startsWith("INSERT INTO cases")) return statement;
            const bind = statement.bind.bind(statement);
            statement.bind = (...values: unknown[]) => {
              const bound = bind(...values);
              const run = bound.run.bind(bound);
              return Object.assign(bound, {
                run: async () => {
                  await run();
                  dropped = true;
                  throw new Error("D1_ERROR: Network connection lost.");
                },
              });
            };
            return statement;
          };
        if (key === "batch" && dropped)
          return async () => Promise.reject(new Error("D1_ERROR: Network connection lost."));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const m = message(from);
    await expect(handleEmail(m.forwardable, { ...mailEnv, DB: dropping })).rejects.toBeInstanceOf(RetryDelivery);
    const [made] = await casesOf(orgId);
    expect(await claimsOf(orgId)).toEqual([
      { message_key: `email:id:${m.messageId}`, state: "pending", case_id: made?.id },
    ]);
    // After the lease the sweep finds the case with no Workflow and no stored message: it ends partial (RawMissing)
    // where the member sees it, and the claim is released (D01 T03 §12).
    await sweepIntake(env as unknown as Env, new Date(Date.now() + CLAIM_LEASE_MS + 60_000));
    expect((await casesOf(orgId)).map((c) => c.id)).toEqual([made?.id]);
    expect(await statusOf(made?.id as string)).toBe("partial");
    expect(await failedStep(made?.id as string)).toEqual([{ step: "admit", error: "RawMissing" }]);
    expect(await claimsOf(orgId)).toEqual([]);
  });

  it("settles a delivery that stopped before or after its case was made, leaving no case without a Workflow", async () => {
    const { orgId, from } = await member();
    const old = new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString();
    // Stopped after the claim named its case, before the case was made.
    const never = ulid();
    // Stopped after the case was made, before its raw message or Workflow.
    const made = await admitCase(db, { orgId, channel: "email", headersAvailable: false, forwardedBy: from });
    if (!made.ok) throw new Error(made.error.message);
    const insert = (key: string, caseId: string) =>
      db
        .prepare(
          "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, 'pending', ?, ?)",
        )
        .bind(orgId, key, caseId, old);
    const before = message(from);
    const after = message(from);
    await db.batch([insert(before.messageId as string, never), insert(after.messageId as string, made.value.id)]);
    const counts = await sweepIntake(env as unknown as Env);
    expect(counts.removed).toBeGreaterThanOrEqual(2);
    // The case made without its message stays, ended partial (RawMissing); both claims are released (D01 T03 §12).
    expect((await casesOf(orgId)).map((c) => c.id)).toEqual([made.value.id]);
    expect(await statusOf(made.value.id)).toBe("partial");
    expect(await claimsOf(orgId)).toEqual([]);
    // Each message's retry then makes one case.
    for (const m of [before, after]) expect((await handleEmail(again(m), mailEnv)).kind).toBe("admitted");
    expect(await casesOf(orgId)).toHaveLength(3);
  });

  it("sends no notice when the organisation's cap cannot be read, and the next capped forward sends it with the cap", async () => {
    const { from } = await member({ cap: 1 });
    expect((await handleEmail(message(from).forwardable, mailEnv)).kind).toBe("admitted");
    const unreadable = failing({ db: (sql) => sql.startsWith("SELECT COALESCE((SELECT daily_cases_override") });
    expect(await handleEmail(message(from).forwardable, unreadable)).toEqual({ kind: "capped" });
    expect(world.sends).toEqual([]);
    expect(await handleEmail(message(from).forwardable, mailEnv)).toEqual({ kind: "capped" });
    expect(world.sends).toHaveLength(1);
    expect(world.sends[0]?.text).toContain("limit of 1 checks");
  });
});

describe("final review cases", () => {
  it("starts no Workflow for a delivery that stalled while another took it over", async () => {
    const { orgId, from } = await member();
    const m = message(from);
    // The first delivery stalls just before it would start its Workflow.
    const pause = held(1);
    const stalling = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith("SELECT 1 FROM intake_messages")) return statement;
            const bind = statement.bind.bind(statement);
            statement.bind = (...values: unknown[]) => {
              const bound = bind(...values);
              const first = bound.first.bind(bound) as () => Promise<unknown>;
              return Object.assign(bound, {
                first: async () => {
                  await pause.hold();
                  return first();
                },
              });
            };
            return statement;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const stalled = outcome(handleEmail(m.forwardable, { ...mailEnv, DB: stalling }));
    await Promise.race([pause.reached, stalled]);
    const [firstCase] = await casesOf(orgId);
    // Past the lease, the same message's retry takes over: the first case is stored with no Workflow, so it is started
    // (D01 T03 §12) and the retry is its duplicate; the stalled delivery, no longer holding the claim, starts nothing.
    const later = new Date(Date.now() + CLAIM_LEASE_MS + 60_000);
    const retried = await handleEmail(again(m), mailEnv, later);
    expect(retried.kind).toBe("duplicate");
    pause.release();
    expect(await stalled).toEqual({ thrown: "RetryDelivery" });
    expect(await workflowExists(firstCase?.id as string)).toBe(true);
    await ran(firstCase?.id as string);
    expect((await casesOf(orgId)).map((c) => c.id)).toEqual([firstCase?.id]);
  });

  it("leaves a stale claim's case alone once the pipeline has moved it on", async () => {
    const { orgId, from } = await member();
    const moved = await admitCase(db, { orgId, channel: "email", headersAvailable: false, forwardedBy: from });
    if (!moved.ok) throw new Error(moved.error.message);
    await db.prepare("UPDATE cases SET status = 'running' WHERE id = ?").bind(moved.value.id).run();
    await db
      .prepare(
        "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, 'moved', 'pending', ?, ?)",
      )
      .bind(orgId, moved.value.id, new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString())
      .run();
    await sweepIntake(env as unknown as Env);
    expect((await casesOf(orgId)).map((c) => c.id)).toEqual([moved.value.id]);
    expect(await claimsOf(orgId)).toEqual([{ message_key: "moved", state: "done", case_id: moved.value.id }]);
  });

  it("sends the cap notice for an organisation whose id is long", async () => {
    orgs += 1;
    const orgId = `org-${"o".repeat(150)}-${orgs}`;
    const domain = `longorg${orgs}.co.za`;
    const at = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, 'tttttttttttttttt', 'verified', 'dns', ?, ?)",
        )
        .bind(`d-long-${orgs}`, orgId, domain, at, at),
      db.prepare("INSERT INTO org_limits (org_id, daily_cases_override) VALUES (?, 0)").bind(orgId),
    ]);
    expect(await handleEmail(message(`boss@${domain}`).forwardable, mailEnv)).toEqual({ kind: "capped" });
    expect(world.sends).toHaveLength(1);
  });
});

describe("sweepIntake", () => {
  it("expires day-old done claims, completes or ends stopped deliveries, and leaves fresh claims alone", async () => {
    const { orgId, from } = await member();
    const other = await member();
    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    const started = await admitCase(db, { orgId, channel: "email", headersAvailable: false, forwardedBy: from });
    const orphan = await admitCase(db, { orgId, channel: "email", headersAvailable: false, forwardedBy: from });
    if (!started.ok || !orphan.ok) throw new Error("admission failed");
    await env.ANALYSIS.create({ id: started.value.id, params: { caseId: started.value.id } });
    await env.ARTEFACTS.put(rawKey(orphan.value.id), new TextEncoder().encode("raw"));
    const insert = (org: string, key: string, state: string, caseId: string | null, claimedAt: string) =>
      db
        .prepare("INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, ?, ?, ?)")
        .bind(org, key, state, caseId, claimedAt);
    await db.batch([
      insert(orgId, "old-done", "done", null, at(25 * HOUR)),
      insert(orgId, "recent-done", "done", null, at(HOUR)),
      insert(orgId, "stopped-started", "pending", started.value.id, at(CLAIM_LEASE_MS + 60_000)),
      insert(orgId, "stopped-orphan", "pending", orphan.value.id, at(CLAIM_LEASE_MS + 60_000)),
      insert(other.orgId, "in-flight", "pending", null, at(60_000)),
    ]);
    await sweepIntake(env as unknown as Env, new Date(now));
    expect((await claimsOf(orgId)).map((c) => `${c.message_key}:${c.state}`).sort()).toEqual([
      "recent-done:done",
      "stopped-started:done",
    ]);
    // The orphan, its message never recorded, stays, ended partial (RawMissing), its claim released (D01 T03 §12).
    expect((await casesOf(orgId)).map((c) => c.id).sort()).toEqual([started.value.id, orphan.value.id].sort());
    expect(await statusOf(orphan.value.id)).toBe("partial");
    expect(await claimsOf(other.orgId)).toEqual([{ message_key: "in-flight", state: "pending", case_id: null }]);
  });
});

// D01 T03 §12's completion review: ending an unstored case is one batch, so an interruption leaves it as it was.
describe("an unstored case's settlement interrupted", () => {
  it("changes nothing when its one batch fails, and the next sweep ends the case partial and frees the claim", async () => {
    const { orgId, from } = await member();
    const made = await admitCase(db, { orgId, channel: "email", headersAvailable: false, forwardedBy: from });
    if (!made.ok) throw new Error(made.error.message);
    await db
      .prepare(
        "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, 'cut', 'pending', ?, ?)",
      )
      .bind(orgId, made.value.id, new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString())
      .run();
    // The settlement's batch fails, as a dropped connection would: every write in it or none.
    const failingBatch = new Proxy(db, {
      get(target, key) {
        if (key === "batch") return async () => Promise.reject(new Error("D1_ERROR: Network connection lost."));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const first = await sweepIntake({ ...(env as unknown as Env), DB: failingBatch });
    expect(first.unsettled).toBeGreaterThanOrEqual(1);
    expect(await statusOf(made.value.id)).toBe("received");
    expect(await failedStep(made.value.id)).toEqual([]);
    expect((await claimsOf(orgId)).map((c) => [c.state, c.case_id])).toEqual([["pending", made.value.id]]);
    // The next sweep, its lease run out again, settles it whole: partial, RawMissing, the claim released.
    await sweepIntake(env as unknown as Env, new Date(Date.now() + CLAIM_LEASE_MS + 60_000));
    expect(await statusOf(made.value.id)).toBe("partial");
    expect(await failedStep(made.value.id)).toEqual([{ step: "admit", error: "RawMissing" }]);
    expect(await claimsOf(orgId)).toEqual([]);
  });
});

// The operator's protected accounts (AGENTS.md): no sweep removes their cases. A stranded case of the demo
// organisation is ended partial, never deleted, however often the sweep passes over it.
describe("a protected organisation's stranded case", () => {
  it("stays through every sweep, ended partial, never removed", async () => {
    const PROTECTED_ORG = "ZF5SufztotybeXIWVncExFAVu9GYZ8Fu";
    const made = await admitCase(db, { orgId: PROTECTED_ORG, channel: "email", headersAvailable: false });
    if (!made.ok) throw new Error(made.error.message);
    await db
      .prepare(
        "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, 'protected', 'pending', ?, ?)",
      )
      .bind(PROTECTED_ORG, made.value.id, new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString())
      .run();
    for (const minutes of [0, 10, 30])
      await sweepIntake(env as unknown as Env, new Date(Date.now() + CLAIM_LEASE_MS + minutes * 60_000));
    expect((await casesOf(PROTECTED_ORG)).map((c) => c.id)).toEqual([made.value.id]);
    expect(await statusOf(made.value.id)).toBe("partial");
  });
});

describe("the Worker's email handler", () => {
  it("hands a delivery to handleEmail", async () => {
    const { orgId, from } = await member();
    await worker.email?.(message(from).forwardable, mailEnv);
    const [made] = await casesOf(orgId);
    expect(made?.forwarded_by).toBe(from);
    expect(await rawExists(made?.id as string)).toBe(true);
    expect(await workflowExists(made?.id as string)).toBe(true);
  });
});
