import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { scheduledReconcile } from "../src/index";
import { GRAPHQL_URL } from "../src/mail/forwarding";
import { ACTIVITY_URL, BOUNDS, HEADER } from "../src/mail/reconcile";
import { SMTP2GO_URL } from "../src/mail/smtp2go";
import { markUnsettled } from "../src/meta/budget";

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
      // An incident already resolved and waiting for its alert: the cron sends it to both of the Worker's mailboxes.
      env.DB.prepare(
        "INSERT INTO forward_incidents (key, kind, alias, occurred_at, detected_at, state, alert) VALUES (?, 'refused', 'hello@isitlegit.co.za', ?, ?, 'open', 'pending')",
      ).bind("c".repeat(64), new Date().toISOString(), new Date().toISOString()),
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
});
