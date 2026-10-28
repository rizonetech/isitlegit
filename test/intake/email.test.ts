import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admitCase } from "../../src/db/cases";
import worker from "../../src/index";
import { CLAIM_LEASE_MS, handleEmail, MAX_MESSAGE_BYTES, RetryDelivery, sweepIntake } from "../../src/intake/email";
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
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases) VALUES (?, ?)").bind(orgId, options.cap).run();
  return { orgId, domain, from: `boss@${domain}` };
}

// A forward as Email Routing hands it to the Worker.
function message(
  from: string,
  options: { messageId?: string | null; auth?: string; body?: string; rawSize?: number } = {},
) {
  const domain = from.slice(from.indexOf("@") + 1);
  const messageId = options.messageId === undefined ? `<${crypto.randomUUID()}@${domain}>` : options.messageId;
  const auth =
    options.auth ?? `${EMAIL_ROUTING_AUTHSERV_ID}; spf=pass smtp.mailfrom=${from}; dkim=pass header.d=${domain}`;
  const text = [
    `Authentication-Results: ${auth}`,
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    `From: ${from}`,
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
    expect(await claimsOf(orgId)).toEqual([{ message_key: m.messageId, state: "done", case_id: caseId }]);
    expect(world.sends).toEqual([]);
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
    expect(await handleEmail(m.forwardable, mailEnv)).toEqual({ kind: "too-large" });
    expect(m.rejected).toEqual(["Message too large"]);
    expect(await casesOf(orgId)).toEqual([]);
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
    expect(claim?.message_key).toMatch(/^sha256:[0-9a-f]{64}$/);
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
      .bind(orgId, started.messageId, first.value.id, old)
      .run();
    expect(await handleEmail(started.forwardable, mailEnv)).toEqual({ kind: "duplicate" });
    // Stopped before it: the old case and its raw object go, and the delivery makes one new case.
    const stopped = message(from);
    const orphan = await admitCase(db, { orgId, channel: "email", headersAvailable: false, forwardedBy: from });
    if (!orphan.ok) throw new Error(orphan.error.message);
    await env.ARTEFACTS.put(rawKey(orphan.value.id), stopped.bytes);
    await db
      .prepare(
        "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, 'pending', ?, ?)",
      )
      .bind(orgId, stopped.messageId, orphan.value.id, old)
      .run();
    const result = await handleEmail(stopped.forwardable, mailEnv);
    expect(result.kind).toBe("admitted");
    expect(await rawExists(orphan.value.id)).toBe(false);
    const ids = (await casesOf(orgId)).map((c) => c.id);
    expect(ids).toEqual([first.value.id, (result as { caseId: string }).caseId]);
    expect((await claimsOf(orgId)).map((c) => c.state)).toEqual(["done", "done"]);
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

  it("undoes the case when the raw message cannot be stored", async () => {
    const { orgId, from } = await member();
    const m = message(from);
    await expect(handleEmail(m.forwardable, failing({ put: true }))).rejects.toBeInstanceOf(RetryDelivery);
    expect(await casesOf(orgId)).toEqual([]);
    expect(await claimsOf(orgId)).toEqual([]);
    expect((await handleEmail(again(m), mailEnv)).kind).toBe("admitted");
    expect(await casesOf(orgId)).toHaveLength(1);
  });

  it("undoes the case and its raw message when the Workflow did not start", async () => {
    const { orgId, from } = await member();
    const analysis = {
      create: async () => Promise.reject(new Error("internal error")),
      get: async () => Promise.reject(new Error("instance.not_found")),
    } as unknown as Env["ANALYSIS"];
    const m = message(from);
    await expect(handleEmail(m.forwardable, failing({ analysis }))).rejects.toBeInstanceOf(RetryDelivery);
    expect(await casesOf(orgId)).toEqual([]);
    expect(await claimsOf(orgId)).toEqual([]);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM artefacts a JOIN cases c ON c.id = a.case_id WHERE c.org_id = ?")
        .bind(orgId)
        .first(),
    ).toEqual({ n: 0 });
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
    expect(await claimsOf(orgId)).toEqual([{ message_key: m.messageId, state: "pending", case_id: made?.id }]);
    // The sweep, after the lease, finds no Workflow and removes the case; the retried delivery then makes one.
    const counts = await sweepIntake(env as unknown as Env, new Date(Date.now() + CLAIM_LEASE_MS + 60_000));
    expect(counts.removed).toBeGreaterThanOrEqual(1);
    expect(await casesOf(orgId)).toEqual([]);
    expect(await rawExists(made?.id as string)).toBe(false);
    expect((await handleEmail(again(m), mailEnv)).kind).toBe("admitted");
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
    // A retry within the lease is told to come back later; after it, the old case goes and one new case is made.
    await expect(handleEmail(again(m), mailEnv)).rejects.toBeInstanceOf(RetryDelivery);
    const result = await handleEmail(again(m), mailEnv, new Date(Date.now() + CLAIM_LEASE_MS + 60_000));
    expect(result.kind).toBe("admitted");
    expect((await casesOf(orgId)).map((c) => c.id)).toEqual([(result as { caseId: string }).caseId]);
  });
});

describe("sweepIntake", () => {
  it("expires day-old done claims, completes or removes stopped deliveries, and leaves fresh claims alone", async () => {
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
    expect((await casesOf(orgId)).map((c) => c.id)).toEqual([started.value.id]);
    expect(await rawExists(orphan.value.id)).toBe(false);
    expect(await claimsOf(other.orgId)).toEqual([{ message_key: "in-flight", state: "pending", case_id: null }]);
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
