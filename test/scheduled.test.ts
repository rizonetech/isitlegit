import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitCase } from "../src/db/cases";
import worker, { scheduledReconcile } from "../src/index";
import { CLAIM_LEASE_MS } from "../src/intake/admit";
import { GRAPHQL_URL } from "../src/mail/forwarding";
import { ACTIVITY_URL, BOUNDS, HEADER } from "../src/mail/reconcile";
import { SMTP2GO_URL } from "../src/mail/smtp2go";
import { markUnsettled } from "../src/meta/budget";
import { FORWARD_CRON, MAIN_CRON, RETRY_CRON } from "../src/schedules";

// The Worker's scheduled entrypoint (D01 T02 §5): the cron trigger runs the reconciler over the live send log with
// its band (claims older than 30 minutes, younger than 3 days), beside the HTTP routes, which still answer.
afterEach(() => vi.restoreAllMocks());

describe("the scheduled entrypoint", () => {
  it("settles an uncertain send from SMTP2GO's record when the cron fires", async () => {
    const claimed = new Date(Date.now() - 45 * 60_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO mail_sends (id, send_key, kind, to_hash, status, attempts, created_at, updated_at, claimed_at) VALUES ('s1', 'reply:cron', 'reply', ?, 'uncertain', 1, ?, ?, ?)",
    )
      .bind("a".repeat(64), claimed, claimed, claimed)
      .run();
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(String(input));
      return Response.json({
        data: { events: [{ email_id: "from-cron", event: "delivered", custom_headers: { [HEADER]: "reply:cron" } }] },
      });
    });
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry: () => {} },
      { ...env, SMTP2GO_API_KEY: `api-${"k".repeat(32)}` },
      ctx as unknown as ExecutionContext,
    );
    await Promise.all(waits);
    expect(calls).toEqual([ACTIVITY_URL]);
    expect(
      await env.DB.prepare("SELECT status, provider_id FROM mail_sends WHERE send_key = 'reply:cron'").first(),
    ).toEqual({ status: "sent", provider_id: "from-cron" });
  });

  it("runs with the kept design's band, and leaves a send younger than 30 minutes for a later run", async () => {
    // D01 T02 §7 kept SMTP2GO on these bounds (operator, 2026-10-28): changing them changes the recorded decision.
    expect(BOUNDS).toEqual({ olderThanMinutes: 30, youngerThanDays: 3 });
    const claimed = new Date(Date.now() - 20 * 60_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO mail_sends (id, send_key, kind, to_hash, status, attempts, created_at, updated_at, claimed_at) VALUES ('s2', 'reply:young', 'reply', ?, 'uncertain', 1, ?, ?, ?)",
    )
      .bind("b".repeat(64), claimed, claimed, claimed)
      .run();
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(String(input));
      return Response.json({ data: { events: [] } });
    });
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry: () => {} },
      { ...env, SMTP2GO_API_KEY: `api-${"k".repeat(32)}` },
      ctx as unknown as ExecutionContext,
    );
    await Promise.all(waits);
    expect(calls).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM mail_sends WHERE send_key = 'reply:young'").first()).toEqual({
      status: "uncertain",
    });
  });

  it("does nothing without the SMTP2GO key, and the HTTP routes still answer", async () => {
    // A Worker before the SMTP2GO key is put has none (the tests set a test key for the reply, D01 T02 §3, so it is
    // taken away here): the run says so.
    const lines: string[] = [];
    const { SMTP2GO_API_KEY: _key, ...rest } = env;
    const keyless = rest as unknown as Env;
    const outcome = await scheduledReconcile(keyless, (line) => lines.push(line));
    expect(outcome.state).toBe("disabled");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ event: "mail-reconcile", state: "disabled" });
    const response = await worker.fetch(new Request("https://example.com/health"), keyless, {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
  });
});

describe("the forwarding check (D01 T02 §6)", () => {
  it("reads Email Routing's events when the cron fires with the analytics token set", async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM forward_scan"),
      env.DB.prepare("DELETE FROM forward_incidents"),
      env.DB.prepare("DELETE FROM forward_notices"),
      env.DB.prepare("DELETE FROM mail_sends"),
    ]);
    const calls: string[] = [];
    const to: string[] = [];
    const now = new Date().toISOString();
    const event = (over: Record<string, unknown>) => ({
      datetime: now,
      sessionId: "s",
      messageId: "<cron-forward@x>",
      from: "a@supplier.example",
      to: "hello@isitlegit.co.za",
      subject: "Cron probe",
      status: "delivered",
      action: "forward",
      isNDR: 0,
      ...over,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url === GRAPHQL_URL)
        return Response.json({
          data: {
            viewer: {
              zones: [
                {
                  emailRoutingAdaptive: [
                    event({}),
                    event({
                      messageId: "<ndr@x>",
                      to: "cfbounces+ndrdrop@isitlegit.co.za",
                      subject: "Undeliverable: Cron probe",
                      status: "dropped",
                      action: "drop",
                      isNDR: 1,
                      from: "postmaster@rizonetech.com",
                    }),
                  ],
                },
              ],
            },
          },
        });
      if (url === SMTP2GO_URL) {
        to.push(JSON.parse(String(init?.body ?? "{}")).to[0]);
        return Response.json({ data: { succeeded: 1, failed: 0, email_id: `e-${to.length}` } });
      }
      return Response.json({ data: { events: [] } });
    });
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry: () => {} },
      { ...env, CF_ANALYTICS_TOKEN: "test-token", SMTP2GO_API_KEY: `api-${"k".repeat(32)}` },
      ctx as unknown as ExecutionContext,
    );
    await Promise.all(waits);
    expect(calls).toContain(GRAPHQL_URL);
    // Both of the operator's mailboxes, as the Worker's own settings name them.
    expect(to.sort()).toEqual([env.OPERATOR_EMAIL, env.OPERATOR_FALLBACK_EMAIL].sort());
  });
});

// D01 T03 §12: the minute tick takes up a delivery stranded before its Workflow, within a minute of its lease.
describe("the minute tick's intake sweep", () => {
  it("ends a stranded case with no stored file partial and releases its claim, through scheduled() itself", async () => {
    const orgId = `org-minute-${crypto.randomUUID().slice(0, 8)}`;
    const made = await admitCase(env.DB, { orgId, channel: "email", headersAvailable: false });
    if (!made.ok) throw new Error(made.error.message);
    await env.DB.prepare(
      "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, 'stranded', 'pending', ?, ?)",
    )
      .bind(orgId, made.value.id, new Date(Date.now() - CLAIM_LEASE_MS - 1_000).toISOString())
      .run();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: RETRY_CRON, noRetry: () => {} },
      env,
      ctx as unknown as ExecutionContext,
    );
    await Promise.all(waits);
    const row = await env.DB.prepare("SELECT status FROM cases WHERE id = ?")
      .bind(made.value.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("partial");
    const claims = await env.DB.prepare("SELECT COUNT(*) AS n FROM intake_messages WHERE org_id = ?")
      .bind(orgId)
      .first<{ n: number }>();
    expect(claims?.n).toBe(0);
  });
});

describe("the unsettled-call sweep (D03 T01 §3)", () => {
  it("says when it cannot run, and the next run recovers", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(String(line)));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const failing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("error_class = 'unsettled'")) throw new Error("D1_ERROR: Network connection lost.");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry: () => {} },
      { ...env, DB: failing },
      ctx as unknown as ExecutionContext,
    );
    await Promise.all(waits);
    expect(errors.some((line) => line.includes('"sweep-failed"'))).toBe(true);
    expect(await markUnsettled(env.DB)).toBeGreaterThanOrEqual(0);
  });

  it("runs the retry and intake sweeps each minute, only forwarding between quarter-hours, everything each quarter hour, and nothing for an unknown schedule (D01 T01 §17, D01 T02 §12)", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(String(input));
      return Response.json({ data: { events: [] } });
    });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
    const tick = async (cron: string) => {
      const waits: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
      await worker.scheduled(
        { scheduledTime: Date.now(), cron, noRetry: () => {} },
        { ...env, SMTP2GO_API_KEY: `api-${"k".repeat(32)}` },
        ctx as unknown as ExecutionContext,
      );
      await Promise.all(waits);
      return waits.length;
    };
    // The minute tick: retries, and since D01 T03 §12 stranded deliveries.
    expect(await tick(RETRY_CRON)).toBe(2);
    expect(calls).toEqual([]);
    expect(lines.map((l) => JSON.parse(l).event).sort()).toEqual(["intake-sweep", "retry-sweep"]);
    lines.length = 0;
    // Between the quarter-hours, the forwarding check alone (D01 T02 §12).
    expect(await tick(FORWARD_CRON)).toBe(1);
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(["forwarding"]);
    lines.length = 0;
    expect(await tick("*/5 * * * *")).toBe(0);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: "scheduled", outcome: "unknown-cron", cron: "*/5 * * * *" },
    ]);
    lines.length = 0;
    expect(await tick(MAIN_CRON)).toBeGreaterThan(5);
    expect(lines.map((l) => JSON.parse(l).event)).toContain("retry-sweep");
  });
});

describe("the trial-end notices (D07 T08 §11)", () => {
  it("sends an owner the three-day notice when the quarter-hour cron fires, and only once", async () => {
    const orgId = `org-trial-${crypto.randomUUID().slice(0, 8)}`;
    const created = new Date(Date.now() - 11 * 86_400_000).toISOString();
    await env.DB.prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Cron Couriers', ?, ?)`)
      .bind(orgId, orgId, created)
      .run();
    await env.DB.prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, 'Cron Owner', ?, 1, ?, ?)`,
    )
      .bind(`u-${orgId}`, `owner-${orgId}@example.com`, created, created)
      .run();
    await env.DB.prepare(
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'owner', ?)`,
    )
      .bind(`m-${orgId}`, orgId, `u-${orgId}`, created)
      .run();
    const bodies: { sender: string; to: string[]; subject: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === SMTP2GO_URL) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${bodies.length}` } });
      }
      return Response.json({ data: { events: [] } });
    });
    const fire = async () => {
      const waits: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
      await worker.scheduled(
        { scheduledTime: Date.now(), cron: MAIN_CRON, noRetry: () => {} },
        { ...env, SMTP2GO_API_KEY: `api-${"k".repeat(32)}` },
        ctx as unknown as ExecutionContext,
      );
      await Promise.all(waits);
    };
    await fire();
    const mine = bodies.filter((b) => b.to[0] === `owner-${orgId}@example.com`);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.sender).toBe("IsItLegit <no-reply@isitlegit.co.za>");
    expect(mine[0]?.subject).toContain("Cron Couriers");
    await fire();
    expect(bodies.filter((b) => b.to[0] === `owner-${orgId}@example.com`)).toHaveLength(1);
  });
});
