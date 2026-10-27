import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { scheduledReconcile } from "../src/index";
import { ACTIVITY_URL, HEADER } from "../src/mail/reconcile";

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

  it("does nothing without the SMTP2GO key, and the HTTP routes still answer", async () => {
    // Tests set no SMTP2GO_API_KEY secret, as a Worker before the key is put has none: the run says so.
    const lines: string[] = [];
    const outcome = await scheduledReconcile(env as unknown as Env, (line) => lines.push(line));
    expect(outcome.state).toBe("disabled");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ event: "mail-reconcile", state: "disabled" });
    const response = await worker.fetch(new Request("https://example.com/health"), env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
  });
});
