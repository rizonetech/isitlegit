import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { scheduledForwarding } from "../../src/index";
import {
  ALERTS_PER_RUN,
  checkForwarding,
  type ForwardingDeps,
  GRAPHQL_URL,
  MATCH_GRACE_MS,
  RECOVERY_MS,
  type RoutingEvent,
  SEEN_MS,
} from "../../src/mail/forwarding";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";

// D01 T02 §6: a forward a destination refused, read from Email Routing's events as probe 2 recorded them (the forward
// `delivered`, then `isNDR` 1 reports to Cloudflare's drop address), and member mail the Worker could not take.
const db = env.DB;
const ZONE = "zone-forwarding-test";
const OPERATORS = ["hostmaster@rizonetech.com", "rizonetech@gmail.com"];
const T0 = new Date("2026-10-30T15:20:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM forward_scan"),
    db.prepare("DELETE FROM forward_seen"),
    db.prepare("DELETE FROM forward_incidents"),
    db.prepare("DELETE FROM forward_notices"),
    db.prepare("DELETE FROM mail_sends"),
  ]);
});

const forward = (over: Partial<RoutingEvent> = {}): RoutingEvent => ({
  datetime: at(0).toISOString(),
  sessionId: "s-forward",
  messageId: "<probe-2@message-id.example>",
  from: "billing@supplier.example",
  to: "hello@isitlegit.co.za",
  subject: "Invoice 42 for October",
  status: "delivered",
  action: "forward",
  isNDR: 0,
  ...over,
});
const report = (over: Partial<RoutingEvent> = {}): RoutingEvent => ({
  datetime: at(0.2).toISOString(),
  sessionId: "s-report",
  messageId: "<ndr-1@GV2PR08MB8677.eurprd08.prod.outlook.com>",
  from: "postmaster@rizonetech.com",
  to: "cfbounces+ndrdrop@isitlegit.co.za",
  subject: "Undeliverable: Invoice 42 for October",
  status: "dropped",
  action: "drop",
  isNDR: 1,
  ...over,
});
const worker = (status: string, over: Partial<RoutingEvent> = {}): RoutingEvent => ({
  datetime: at(0).toISOString(),
  sessionId: "s-worker",
  messageId: "<member-1@member.example>",
  from: "accounts@member.example",
  to: "check@isitlegit.co.za",
  subject: "Fwd: is this real?",
  status,
  action: "worker",
  isNDR: 0,
  ...over,
});

// A fetch answering GraphQL with the events given for each call in turn (or an error), and SMTP2GO as given.
function world(pages: (RoutingEvent[] | "error")[], smtp: "sent" | "fail" = "sent") {
  const sends: { to: string; subject: string; text: string; key: string }[] = [];
  const queries: { from: string; to: string }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url === GRAPHQL_URL) {
      queries.push({ from: body.variables.from, to: body.variables.to });
      const page = pages.shift() ?? [];
      if (page === "error") return Response.json({ errors: [{ message: "boom" }] });
      return Response.json({ data: { viewer: { zones: [{ emailRoutingAdaptive: page }] } } });
    }
    if (url === SMTP2GO_URL) {
      if (smtp === "fail")
        return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
      const key = body.custom_headers.find((h: { header: string }) => h.header === "X-IsItLegit-Send")?.value;
      sends.push({ to: body.to[0], subject: body.subject, text: body.text_body, key });
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `e-${sends.length}` } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { fetcher, sends, queries };
}
const deps = (fetcher: typeof fetch, now: Date, over: Partial<ForwardingDeps> = {}): ForwardingDeps => ({
  db,
  token: "test-token",
  zone: ZONE,
  mail: { db, apiKey: "api-test", fetch: fetcher, pause: async () => {}, now: () => now },
  operators: OPERATORS,
  fetch: fetcher,
  now: () => now,
  // No grace and no wait after reading, so a refusal is tied to its forward in the run that reads it; the ordering tests
  // pass the real grace, D01 T02 §12's both, and D01 T02 §15 tests earlyAlert (default true in checkForwarding).
  graceMs: 0,
  seenMs: 0,
  earlyAlert: false,
  ...over,
});

describe("a forward the destination refused", () => {
  it("alerts both mailboxes once, with the alias, the time, the domains and never the sender's address or subject", async () => {
    const w = world([[forward(), report(), report({ sessionId: "s-report-2", messageId: "<ndr-2@x>" })]]);
    const outcome = await checkForwarding(deps(w.fetcher, at(5)));
    // Each notice is opened as read; the second, with no forward of its own, is folded into the first (D01 T02 §9).
    expect(outcome).toMatchObject({ state: "ok", events: 3, incidents: 2, folded: 1, alerted: 1 });
    expect(w.sends.map((s) => s.to)).toEqual(OPERATORS);
    const [first] = w.sends;
    expect(first?.subject).toBe("IsItLegit: mail to hello@isitlegit.co.za was refused after forwarding");
    expect(first?.text).toContain("from supplier.example to hello@isitlegit.co.za");
    // When the original came in (the forward) and when it was refused (the report), each labelled as what it is.
    expect(first?.text).toContain(`received at ${forward().datetime},`);
    expect(first?.text).toContain(`refused by rizonetech.com at ${report().datetime}`);
    expect(first?.text).toMatch(/Incident [0-9a-f]{12}\./);
    expect(first?.text).not.toContain("billing@");
    expect(first?.text).not.toContain("Invoice 42");
  });

  it("alerts once however often the same events are read, through sendMail's own table", async () => {
    const events = [forward(), report()];
    const w = world([events, events]);
    await checkForwarding(deps(w.fetcher, at(5)));
    await checkForwarding(deps(w.fetcher, at(6)));
    expect(w.sends).toHaveLength(2);
    const sent = await db
      .prepare("SELECT COUNT(*) AS n FROM mail_sends WHERE send_key LIKE 'forward-failure:%'")
      .first<{ n: number }>();
    expect(sent?.n).toBe(2);
  });

  it("ties a report read in a later run to the forward an earlier run saw", async () => {
    const w = world([[forward()], [report()]]);
    expect(await checkForwarding(deps(w.fetcher, at(1)))).toMatchObject({ incidents: 0 });
    expect(await checkForwarding(deps(w.fetcher, at(5)))).toMatchObject({ incidents: 1, alerted: 1 });
    expect(w.sends[0]?.text).toContain("to hello@isitlegit.co.za");
  });

  it("keeps two refusals with no message id apart", async () => {
    const w = world([
      [
        report({ messageId: null, sessionId: "a", subject: "Undeliverable: one" }),
        report({ messageId: null, sessionId: "b", subject: "Undeliverable: two" }),
      ],
    ]);
    expect(await checkForwarding(deps(w.fetcher, at(5)))).toMatchObject({ incidents: 2 });
  });

  it("sends nothing for a delivered forward, nor for the Worker refusing a sender on purpose", async () => {
    const w = world([[forward(), worker("dropped")]]);
    expect(await checkForwarding(deps(w.fetcher, at(5)))).toMatchObject({ incidents: 0, alerted: 0 });
    expect(w.sends).toEqual([]);
  });
});

describe("completion review", () => {
  it("makes reports read before their forward, and replayed after it, one incident and one alert per mailbox", async () => {
    const reports = [report(), report({ sessionId: "s-r2", messageId: "<ndr-2@x>" })];
    const w = world([reports, [forward(), ...reports], []]);
    const grace = { graceMs: MATCH_GRACE_MS };
    expect(await checkForwarding(deps(w.fetcher, at(1), grace))).toMatchObject({ incidents: 2, folded: 0, alerted: 0 });
    await checkForwarding(deps(w.fetcher, at(16), grace));
    await checkForwarding(deps(w.fetcher, at(22), grace));
    const rows = await db.prepare("SELECT alias, alert FROM forward_incidents").all<{ alias: string; alert: string }>();
    expect(rows.results).toEqual([{ alias: "hello@isitlegit.co.za", alert: "sent" }]);
    expect(w.sends).toHaveLength(2);
  });

  it("alerts a report whose forward never appears once the grace has passed, naming no alias", async () => {
    const w = world([[report()], [], []]);
    const grace = { graceMs: MATCH_GRACE_MS };
    await checkForwarding(deps(w.fetcher, at(1), grace));
    await checkForwarding(deps(w.fetcher, at(10), grace));
    expect(w.sends).toEqual([]);
    await checkForwarding(deps(w.fetcher, at(25), grace));
    expect(w.sends[0]?.text).toContain("an alias (its forward was not found)");
  });

  it("names every forward of the same subject as uncertain, never the latest alone", async () => {
    const w = world([
      [
        forward(),
        forward({
          messageId: "<other@x>",
          sessionId: "s2",
          to: "conduct@isitlegit.co.za",
          datetime: at(0.1).toISOString(),
        }),
        report(),
      ],
    ]);
    await checkForwarding(deps(w.fetcher, at(5)));
    expect(w.sends[0]?.subject).toBe("IsItLegit: mail to an alias was refused after forwarding");
    expect(w.sends[0]?.text).toContain("one of hello@isitlegit.co.za, conduct@isitlegit.co.za");
  });

  it("counts an alert sent only once SMTP2GO confirmed it, keeping an uncertain hand-over pending", async () => {
    const sends: string[] = [];
    let answer: "timeout" | "ok" = "timeout";
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === GRAPHQL_URL)
        return Response.json({ data: { viewer: { zones: [{ emailRoutingAdaptive: [forward(), report()] }] } } });
      if (answer === "timeout") throw new DOMException("timed out", "TimeoutError");
      sends.push(JSON.parse(String(init?.body ?? "{}")).to[0]);
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `e-${sends.length}` } });
    }) as typeof fetch;
    expect(await checkForwarding(deps(fetcher, at(5)))).toMatchObject({ alerted: 0 });
    expect((await db.prepare("SELECT alert FROM forward_incidents").first<{ alert: string }>())?.alert).toBe("pending");
    // The reconciler settles the uncertain sends as sent (SMTP2GO's record); the next run then counts the alert sent.
    await db
      .prepare("UPDATE mail_sends SET status = 'sent', provider_id = 'settled' WHERE send_key LIKE 'forward-failure:%'")
      .run();
    answer = "ok";
    expect(await checkForwarding(deps(fetcher, at(6)))).toMatchObject({ alerted: 1 });
    expect(sends).toEqual([]);
  });

  it("resumes from its last event when the page budget runs out, losing nothing", async () => {
    const full = (start: number) =>
      Array.from({ length: 1000 }, (_, i) =>
        forward({
          messageId: `<m-${start + i}@x>`,
          sessionId: `s${start + i}`,
          subject: `Bulk ${start + i}`,
          datetime: at(171 + (start + i) / 1000).toISOString(),
        }),
      );
    const pages = Array.from({ length: 10 }, (_, p) => full(p * 1000));
    const w = world([...pages, [report({ datetime: at(185).toISOString(), subject: "Undeliverable: Bulk 9999" })]]);
    // Counting what reaches D1: 10,000 forwards are written in batches, never one statement each (CI timed out on that).
    let batches = 0;
    let single = 0;
    const counted = new Proxy(db, {
      get(target, name) {
        if (name === "batch")
          return (statements: D1PreparedStatement[]) => {
            batches++;
            return target.batch(statements);
          };
        if (name === "prepare")
          return (query: string) => {
            const statement = target.prepare(query);
            return new Proxy(statement, {
              get(s, key) {
                const value = Reflect.get(s, key);
                if (key === "bind")
                  return (...args: unknown[]) => {
                    const bound = statement.bind(...args);
                    return new Proxy(bound, {
                      get(b, k) {
                        const v = Reflect.get(b, k);
                        if (k === "run" || k === "first" || k === "all") single++;
                        return typeof v === "function" ? v.bind(b) : v;
                      },
                    });
                  };
                return typeof value === "function" ? value.bind(s) : value;
              },
            });
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    expect(await checkForwarding(deps(w.fetcher, at(200), { db: counted }))).toMatchObject({
      state: "partial",
      events: 10_000,
    });
    expect(batches).toBeLessThanOrEqual(110);
    expect(single).toBeLessThan(20);
    const next = await checkForwarding(deps(w.fetcher, at(201)));
    expect(next.state).toBe("ok");
    // The next run reads from the last event the budget reached, not from its own last 30 minutes.
    expect(w.queries[10]?.from).toBe(full(9000)[999]?.datetime);
  });

  it("carries a Worker failure's reason with addresses removed, and settles a retry that arrives after the hour", async () => {
    const failed = worker("deliveryFailed", {
      errorDetail: "upstream (worker:isitlegit) temporary error: rejected accounts@member.example",
    });
    const w = world([[failed], [], [worker("delivered", { datetime: at(70).toISOString() })]]);
    await checkForwarding(deps(w.fetcher, at(1)));
    const unsent = world([[]], "fail");
    await checkForwarding(deps(unsent.fetcher, new Date(at(0).getTime() + RECOVERY_MS + 60_000)));
    const pending = await db
      .prepare("SELECT state, alert, reason FROM forward_incidents")
      .first<Record<string, string>>();
    expect(pending).toMatchObject({ state: "unresolved", alert: "pending" });
    expect(pending?.reason).toBe("upstream (worker:isitlegit) temporary error: rejected [address]");
    // The retry arrives late, during the alert provider's outage: the incident settles and its alert is dropped.
    await checkForwarding(deps(world([[worker("delivered", { datetime: at(70).toISOString() })]]).fetcher, at(75)));
    expect(await db.prepare("SELECT state, alert FROM forward_incidents").first()).toEqual({
      state: "recovered",
      alert: "none",
    });
  });

  it("deletes settled incidents after 90 days and keeps pending ones", async () => {
    const w = world([[forward(), report()], []]);
    await checkForwarding(deps(w.fetcher, at(5)));
    await db
      .prepare(
        "INSERT INTO forward_incidents (key, kind, occurred_at, detected_at, state, alert) VALUES (?, 'refused', ?, ?, 'open', 'pending')",
      )
      .bind("p".repeat(64), at(0).toISOString(), at(0).toISOString())
      .run();
    await checkForwarding(deps(world([[]], "fail").fetcher, new Date(at(0).getTime() + 91 * 24 * 60 * 60 * 1000)));
    const keys = (await db.prepare("SELECT key FROM forward_incidents").all<{ key: string }>()).results.map(
      (r) => r.key,
    );
    expect(keys).toEqual(["p".repeat(64)]);
  });
});

describe("round 1", () => {
  it("keeps two refused messages of the same subject apart, each with its own alias", async () => {
    const second = {
      messageId: "<second@x>",
      sessionId: "s-second",
      to: "conduct@isitlegit.co.za",
      datetime: at(10).toISOString(),
    };
    const w = world([
      [
        forward(),
        report(),
        report({ sessionId: "s-r1b", messageId: "<ndr-1b@x>" }),
        forward(second),
        report({ sessionId: "s-r2", messageId: "<ndr-2@x>", datetime: at(10.2).toISOString() }),
      ],
    ]);
    expect(await checkForwarding(deps(w.fetcher, at(15)))).toMatchObject({ incidents: 3, folded: 1, alerted: 2 });
    const aliases = (
      await db.prepare("SELECT alias FROM forward_incidents ORDER BY occurred_at").all<{ alias: string }>()
    ).results;
    expect(aliases.map((a) => a.alias)).toEqual(["hello@isitlegit.co.za", "conduct@isitlegit.co.za"]);
  });

  it("names both aliases as uncertain when two earlier same-subject forwards are read after the report", async () => {
    const w = world([
      [report({ datetime: at(5).toISOString() })],
      [
        forward(),
        forward({
          messageId: "<other@x>",
          sessionId: "s2",
          to: "conduct@isitlegit.co.za",
          datetime: at(1).toISOString(),
        }),
      ],
      [],
    ]);
    const grace = { graceMs: MATCH_GRACE_MS };
    await checkForwarding(deps(w.fetcher, at(6), grace));
    expect(w.sends).toEqual([]);
    await checkForwarding(deps(w.fetcher, at(10), grace));
    await checkForwarding(deps(w.fetcher, at(27), grace));
    expect(w.sends[0]?.text).toContain("one of hello@isitlegit.co.za, conduct@isitlegit.co.za");
  });

  it("never takes a later delivery as the retry of a failure with no Message-ID, but notes it (round 2)", async () => {
    const failed = worker("deliveryFailed", { messageId: null });
    const later = worker("delivered", {
      messageId: "<another@member.example>",
      sessionId: "s-later",
      datetime: at(20).toISOString(),
    });
    const w = world([[failed], [later], []]);
    await checkForwarding(deps(w.fetcher, at(1)));
    await checkForwarding(deps(w.fetcher, at(25)));
    await checkForwarding(deps(w.fetcher, new Date(at(0).getTime() + RECOVERY_MS + 60_000)));
    expect(w.sends).toHaveLength(2);
    expect(w.sends[0]?.text).toContain(
      `arrived at ${at(20).toISOString()}; the failed message carried no Message-ID, so it may or may not be its retry`,
    );
    expect((await db.prepare("SELECT state FROM forward_incidents").first<{ state: string }>())?.state).toBe(
      "unresolved",
    );
  });

  it("keeps two refused messages of the same subject a minute apart as two incidents (round 2)", async () => {
    const w = world([
      [
        forward(),
        forward({
          messageId: "<second@x>",
          sessionId: "s-second",
          to: "conduct@isitlegit.co.za",
          datetime: at(1).toISOString(),
        }),
        report(),
        report({ sessionId: "s-r2", messageId: "<ndr-2@x>", datetime: at(1.2).toISOString() }),
      ],
    ]);
    expect(await checkForwarding(deps(w.fetcher, at(5)))).toMatchObject({ incidents: 2 });
  });

  it("counts a refusal's same-second notices and says how many came (round 2)", async () => {
    const w = world([[forward(), report(), report({ sessionId: "s-r1b", messageId: "<ndr-1b@x>" })]]);
    await checkForwarding(deps(w.fetcher, at(5)));
    expect(w.sends[0]?.text).toContain("Cloudflare dropped the 2 refusal notices");
  });

  it("counts notices a second apart as one refusal, never a second alert (D01 T02 §9, probe 3)", async () => {
    const second = report({
      sessionId: "s-r1b",
      messageId: "<ndr-1b@x>",
      datetime: new Date(at(0.2).getTime() + 1000).toISOString(),
    });
    const w = world([[forward(), report(), second]]);
    await checkForwarding(deps(w.fetcher, at(5)));
    // One alert (a copy to each mailbox), counting both notices; none for a forward "not found".
    expect(new Set(w.sends.map((m) => m.subject))).toEqual(new Set([w.sends[0]?.subject]));
    for (const m of w.sends) {
      expect(m.text).toContain("Cloudflare dropped the 2 refusal notices");
      expect(m.text).not.toContain("forward was not found");
    }
  });

  it("names both messages when two of one subject are refused seconds apart, losing neither (§9 rounds 1 and 2)", async () => {
    const second = forward({
      messageId: "<m-2@x>",
      sessionId: "s2",
      to: "conduct@isitlegit.co.za",
      datetime: new Date(at(0).getTime() + 11_000).toISOString(),
    });
    const notices = [
      report({ datetime: new Date(at(0).getTime() + 10_000).toISOString() }),
      report({ sessionId: "s-r2", messageId: "<ndr-2@x>", datetime: new Date(at(0).getTime() + 13_000).toISOString() }),
    ];
    const w = world([[forward(), second, ...notices]]);
    await checkForwarding(deps(w.fetcher, at(5)));
    // A notice does not say which message it refused: one incident, both named, uncertain, both notices counted.
    const rows = (
      await env.DB.prepare("SELECT alias, uncertain FROM forward_incidents WHERE kind = 'refused'").all<{
        alias: string;
        uncertain: number;
      }>()
    ).results;
    expect(rows).toEqual([{ alias: "hello@isitlegit.co.za, conduct@isitlegit.co.za", uncertain: 1 }]);
    for (const m of w.sends) {
      expect(m.text).toContain("hello@isitlegit.co.za, conduct@isitlegit.co.za");
      expect(m.text).toContain("Cloudflare dropped the 2 refusal notices");
    }
  });

  it("never names a later, delivered forward as refused on a duplicate notice's word (§9 round 2)", async () => {
    // A refused at :00 (notices :10 and :12); B forwarded fine at :11, between the notices.
    const b = forward({
      messageId: "<m-b@x>",
      sessionId: "s-b",
      to: "conduct@isitlegit.co.za",
      datetime: new Date(at(0).getTime() + 11_000).toISOString(),
    });
    const notices = [
      report({ datetime: new Date(at(0).getTime() + 10_000).toISOString() }),
      report({ sessionId: "s-r2", messageId: "<ndr-2@x>", datetime: new Date(at(0).getTime() + 12_000).toISOString() }),
    ];
    const w = world([[forward(), b, ...notices]]);
    await checkForwarding(deps(w.fetcher, at(5)));
    const definite = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM forward_incidents WHERE kind = 'refused' AND uncertain = 0 AND alias = 'conduct@isitlegit.co.za'",
    ).first<{ n: number }>();
    expect(definite?.n).toBe(0);
    expect(new Set(w.sends.map((m) => m.subject)).size).toBe(1);
  });

  it("never names a delivered forward refused when a refusal's notices are read in separate scans (§9 round 3)", async () => {
    const t = (seconds: number) => new Date(at(0).getTime() + seconds * 1000).toISOString();
    const a = forward({ datetime: t(-10) });
    const b = forward({ messageId: "<m-b@x>", sessionId: "s-b", to: "conduct@isitlegit.co.za", datetime: t(0) });
    const n1 = report({ datetime: t(-1) });
    const n2 = report({ sessionId: "s-r2", messageId: "<ndr-2@x>", datetime: t(1) });
    const grace = { graceMs: MATCH_GRACE_MS };
    // Read a scan apart, both before the first is resolved.
    const w = world([[a, n1], [b, n2], [], []]);
    await checkForwarding(deps(w.fetcher, at(1), grace));
    await checkForwarding(deps(w.fetcher, at(16), grace));
    await checkForwarding(deps(w.fetcher, at(31), grace));
    await checkForwarding(deps(w.fetcher, at(46), grace));
    const definite = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM forward_incidents WHERE uncertain = 0 AND alias LIKE '%conduct@%'",
    ).first<{ n: number }>();
    expect(definite?.n).toBe(0);
  });

  it("keeps a notice read after its sibling was resolved from naming a forward definitively (§9 round 3)", async () => {
    const t = (seconds: number) => new Date(at(0).getTime() + seconds * 1000).toISOString();
    const a = forward({ datetime: t(-10) });
    const b = forward({ messageId: "<m-b@x>", sessionId: "s-b", to: "conduct@isitlegit.co.za", datetime: t(0) });
    const grace = { graceMs: MATCH_GRACE_MS };
    const w = world([
      [a, report({ datetime: t(-1) })],
      [],
      [b, report({ sessionId: "s-r2", messageId: "<ndr-2@x>", datetime: t(1) })],
      [],
    ]);
    await checkForwarding(deps(w.fetcher, at(1), grace));
    await checkForwarding(deps(w.fetcher, at(22), grace));
    await checkForwarding(deps(w.fetcher, at(30), grace));
    await checkForwarding(deps(w.fetcher, at(52), grace));
    const rows = (
      await env.DB.prepare(
        "SELECT alias, uncertain FROM forward_incidents WHERE kind = 'refused' ORDER BY occurred_at",
      ).all<{
        alias: string;
        uncertain: number;
      }>()
    ).results;
    expect(rows).toEqual([
      { alias: "hello@isitlegit.co.za", uncertain: 0 },
      { alias: "conduct@isitlegit.co.za", uncertain: 1 },
    ]);
    expect(w.sends.some((m) => m.text.includes("possibly conduct@isitlegit.co.za"))).toBe(true);
  });

  it("loses no cluster span when a run is interrupted while resolving it (§9 round 4)", async () => {
    const t = (seconds: number) => new Date(at(0).getTime() + seconds * 1000).toISOString();
    const b = forward({ messageId: "<m-b@x>", sessionId: "s-b", to: "conduct@isitlegit.co.za", datetime: t(11) });
    const notices = [
      report({ datetime: t(10) }),
      report({ sessionId: "s-r2", messageId: "<ndr-2@x>", datetime: t(12) }),
    ];
    const w = world([[forward(), b, ...notices], [], []]);
    // The first run's read of the candidate forwards fails, once, as a D1 request may.
    let failed = false;
    const flaky = new Proxy(db, {
      get(target, name) {
        if (name === "prepare")
          return (query: string) => {
            const statement = target.prepare(query);
            if (failed || !query.startsWith("SELECT message_hash, alias")) return statement;
            return new Proxy(statement, {
              get(st, key) {
                if (key === "bind")
                  return (...args: unknown[]) => {
                    const bound = st.bind(...args);
                    return new Proxy(bound, {
                      get(bd, k) {
                        if (k === "all") {
                          failed = true;
                          return () => Promise.reject(new Error("D1_ERROR: transient"));
                        }
                        const v = Reflect.get(bd, k);
                        return typeof v === "function" ? v.bind(bd) : v;
                      },
                    });
                  };
                const v = Reflect.get(st, key);
                return typeof v === "function" ? v.bind(st) : v;
              },
            });
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    await checkForwarding(deps(w.fetcher, at(5), { db: flaky })).catch(() => undefined);
    expect(failed).toBe(true);
    await checkForwarding(deps(w.fetcher, at(6)));
    const rows = (
      await env.DB.prepare("SELECT alias, uncertain FROM forward_incidents WHERE kind = 'refused'").all<{
        alias: string;
        uncertain: number;
      }>()
    ).results;
    expect(rows).toEqual([{ alias: "hello@isitlegit.co.za, conduct@isitlegit.co.za", uncertain: 1 }]);
  });

  it("counts one refusal's same-second notices once even with two candidate forwards (§9 round 2)", async () => {
    const earlier = forward({ messageId: "<m-0@x>", sessionId: "s0", datetime: at(-1).toISOString() });
    const notices = [report(), report({ sessionId: "s-r1b", messageId: "<ndr-1b@x>" })];
    const w = world([[earlier, forward(), ...notices]]);
    expect(await checkForwarding(deps(w.fetcher, at(5)))).toMatchObject({ folded: 1, alerted: 1 });
    expect(w.sends.map((m) => m.to)).toEqual(OPERATORS);
    expect(w.sends[0]?.text).toContain("Cloudflare dropped the 2 refusal notices");
  });

  it("keeps notices minutes apart as separate refusals", async () => {
    // (The window is NOTICE_SPREAD_MS; the round 2 test above keeps a minute apart as two as well.)
    const later = report({ sessionId: "s-r2", messageId: "<ndr-2@x>", datetime: at(3).toISOString() });
    const w = world([
      [forward(), forward({ messageId: "<m-2@x>", sessionId: "s2", datetime: at(2.9).toISOString() }), report(), later],
    ]);
    await checkForwarding(deps(w.fetcher, at(9)));
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM forward_incidents WHERE kind = 'refused'").first<{
      n: number;
    }>();
    expect(rows?.n).toBe(2);
  });

  it("names a domain without the angle bracket the analytics leave on it (D01 T02 §9, probe 3)", async () => {
    const w = world([
      [forward({ from: "<billing@supplier.example>" }), report({ from: "<postmaster@rizonetech.com>" })],
    ]);
    await checkForwarding(deps(w.fetcher, at(5)));
    expect(w.sends[0]?.text).toContain("from supplier.example to");
    expect(w.sends[0]?.text).toContain("refused by rizonetech.com at");
    expect(w.sends[0]?.text).not.toContain(">");
  });

  it("counts each notice once however often the scans read it again (round 3)", async () => {
    const notices = [report(), report({ sessionId: "s-r1b", messageId: "<ndr-1b@x>" })];
    const w = world([[forward(), ...notices], [forward(), ...notices], [forward(), ...notices], []]);
    const grace = { graceMs: MATCH_GRACE_MS };
    await checkForwarding(deps(w.fetcher, at(1), grace));
    await checkForwarding(deps(w.fetcher, at(8), grace));
    await checkForwarding(deps(w.fetcher, at(15), grace));
    await checkForwarding(deps(w.fetcher, at(22), grace));
    expect(w.sends[0]?.text).toContain("Cloudflare dropped the 2 refusal notices");
  });

  it("never names an unrelated forward read early as the refused one (round 2)", async () => {
    const refused = forward({
      messageId: "<refused@x>",
      sessionId: "s-ref",
      to: "conduct@isitlegit.co.za",
      datetime: at(1).toISOString(),
    });
    const w = world([[forward(), report({ datetime: at(1.5).toISOString() })], [refused], []]);
    const grace = { graceMs: MATCH_GRACE_MS };
    await checkForwarding(deps(w.fetcher, at(3), grace));
    await checkForwarding(deps(w.fetcher, at(12), grace));
    expect(w.sends).toEqual([]);
    await checkForwarding(deps(w.fetcher, at(24), grace));
    expect(w.sends[0]?.text).toContain("one of hello@isitlegit.co.za, conduct@isitlegit.co.za");
  });

  it("sends a new incident's alert even when a hundred older ones are still retrying", async () => {
    const stale = Array.from({ length: 100 }, (_, i) =>
      db
        .prepare(
          "INSERT INTO forward_incidents (key, kind, alias, occurred_at, detected_at, state, alert, alert_tries) VALUES (?, 'refused', 'hello@isitlegit.co.za', ?, ?, 'open', 'pending', 5)",
        )
        .bind(i.toString(16).padStart(64, "0"), at(-60).toISOString(), at(-60).toISOString()),
    );
    await db.batch(stale);
    const w = world([[forward(), report()]]);
    await checkForwarding(deps(w.fetcher, at(5)));
    const fresh = await db
      .prepare("SELECT alert FROM forward_incidents WHERE alert_tries = 1 AND forward_hash IS NOT NULL")
      .first<{ alert: string }>();
    expect(fresh?.alert).toBe("sent");
  });
});

describe("member mail the Worker could not take", () => {
  it("is alerted as unresolved when the sender's retry has not arrived within the hour", async () => {
    const w = world([[worker("deliveryFailed")], []]);
    await checkForwarding(deps(w.fetcher, at(1)));
    expect(w.sends).toEqual([]);
    await checkForwarding(deps(w.fetcher, new Date(at(0).getTime() + RECOVERY_MS + 60_000)));
    expect(w.sends.map((s) => s.subject)).toEqual([
      "IsItLegit: the Worker could not take mail to check@isitlegit.co.za",
      "IsItLegit: the Worker could not take mail to check@isitlegit.co.za",
    ]);
    expect(w.sends[0]?.text).toContain("Check the Worker's logs");
  });

  it("is never alerted when the retry arrived", async () => {
    const w = world([[worker("deliveryFailed")], [worker("delivered", { datetime: at(20).toISOString() })], []]);
    await checkForwarding(deps(w.fetcher, at(1)));
    await checkForwarding(deps(w.fetcher, at(25)));
    await checkForwarding(deps(w.fetcher, new Date(at(0).getTime() + RECOVERY_MS + 60_000)));
    expect(w.sends).toEqual([]);
    const row = await db.prepare("SELECT state FROM forward_incidents").first<{ state: string }>();
    expect(row?.state).toBe("recovered");
  });
});

describe("recovery", () => {
  it("does not advance the scan when the query fails, and catches up on the next run", async () => {
    const w = world(["error", [forward(), report()]]);
    expect(await checkForwarding(deps(w.fetcher, at(1)))).toMatchObject({ state: "degraded" });
    const outcome = await checkForwarding(deps(w.fetcher, at(400)));
    expect(outcome).toMatchObject({ state: "ok", alerted: 1 });
    // The second run read from before the first one's window, not from its own last 30 minutes.
    expect(Date.parse(w.queries[1]?.from ?? "")).toBeLessThanOrEqual(at(1).getTime() - 30 * 60_000);
  });

  it("tries an alert SMTP2GO did not take again on the next run, sending it once", async () => {
    const failing = world([[forward(), report()]], "fail");
    expect(await checkForwarding(deps(failing.fetcher, at(5)))).toMatchObject({ state: "degraded", alerted: 0 });
    const ok = world([[]]);
    expect(await checkForwarding(deps(ok.fetcher, at(6)))).toMatchObject({ alerted: 1 });
    expect(ok.sends).toHaveLength(2);
  });

  it("sends a second try only to the mailbox that failed, never twice to the one that took it", async () => {
    const sends: string[] = [];
    let fallbackUp = false;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url === GRAPHQL_URL)
        return Response.json({ data: { viewer: { zones: [{ emailRoutingAdaptive: [forward(), report()] }] } } });
      if (body.to[0] === OPERATORS[1] && !fallbackUp)
        return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
      sends.push(body.to[0]);
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `e-${sends.length}` } });
    }) as typeof fetch;
    expect(await checkForwarding(deps(fetcher, at(5)))).toMatchObject({ state: "degraded" });
    fallbackUp = true;
    expect(await checkForwarding(deps(fetcher, at(6)))).toMatchObject({ alerted: 1 });
    expect(sends).toEqual(OPERATORS);
  });

  it("says it is disabled, never silent, without the token or the zone", async () => {
    const w = world([]);
    expect(await checkForwarding(deps(w.fetcher, at(1), { token: undefined }))).toMatchObject({ state: "disabled" });
    expect(await checkForwarding(deps(w.fetcher, at(1), { zone: undefined }))).toMatchObject({ state: "disabled" });
    const lines: string[] = [];
    const keyless = { ...env, CF_ANALYTICS_TOKEN: undefined } as unknown as Env;
    expect(await scheduledForwarding(keyless, (line) => lines.push(line), w.fetcher)).toMatchObject({
      state: "disabled",
    });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ event: "forwarding", state: "disabled" });
  });
});

// D01 T02 §12: the grace counts from the refusal, not from the scan that read it, and a refusal waits SEEN_MS after its
// first reading, so a forward shown a little after it is read first.
describe("a refusal alerted soon after its grace", () => {
  const real = { graceMs: MATCH_GRACE_MS, seenMs: SEEN_MS };

  it("alerts at the first scan past the grace from the refusal, as probe 4's would have at 22 minutes", async () => {
    // Probe 4: the refusal at 18:28:07, first read by the 18:45 scan with its forward; alerted at 19:15, 47 minutes on.
    const w = world([[forward(), report()], []]);
    await checkForwarding(deps(w.fetcher, at(17), real));
    expect(w.sends).toEqual([]);
    // The next five-minute tick (probe 4's 18:50, 22 minutes after the refusal): past the grace from the refusal (at
    // 0.2) and SEEN_MS after its reading, it alerts; counted from the reading, it would wait until 37.
    await checkForwarding(deps(w.fetcher, at(22), real));
    expect(w.sends).toHaveLength(2);
    expect(w.sends[0]?.text).toContain("hello@isitlegit.co.za");
  });

  it("waits SEEN_MS after a late reading, so a forward shown after its refusal is still tied to it", async () => {
    // A slow batch: the refusal read only at 25, past its grace; its forward shows at the next scan.
    const w = world([[report()], [forward()], []]);
    // Past its grace when first read, but read only now: no "forward not found" before another tick has read.
    await checkForwarding(deps(w.fetcher, at(25), real));
    expect(w.sends).toEqual([]);
    await checkForwarding(deps(w.fetcher, at(30), real));
    expect(w.sends).toHaveLength(2);
    expect(w.sends[0]?.text).toContain("hello@isitlegit.co.za");
    expect(w.sends[0]?.text).not.toContain("its forward was not found");
  });

  it("leaves a due refusal waiting through a failed read and alerts it once, with its alias, at the next complete one", async () => {
    const w = world([[report()], "error", [forward()], []]);
    await checkForwarding(deps(w.fetcher, at(1), real));
    // Due (20 minutes after the refusal, 4 after its reading), but this run read nothing: no "forward not found".
    expect(await checkForwarding(deps(w.fetcher, at(21), real))).toMatchObject({ state: "degraded" });
    expect(w.sends).toEqual([]);
    await checkForwarding(deps(w.fetcher, at(25), real));
    expect(w.sends).toHaveLength(2);
    expect(w.sends[0]?.text).toContain("hello@isitlegit.co.za");
    await checkForwarding(deps(w.fetcher, at(30), real));
    expect(w.sends).toHaveLength(2);
  });

  it("holds a whole cluster while one of its notices was read too recently, tying it at the next tick", async () => {
    // One refusal's two notices two seconds apart, read a tick apart; the forward shows at the tick after.
    const second = report({
      sessionId: "s-r2",
      messageId: "<ndr-2@x>",
      datetime: new Date(at(0.2).getTime() + 2000).toISOString(),
    });
    const w = world([[report()], [second], [forward()], []]);
    await checkForwarding(deps(w.fetcher, at(20), real));
    // The first notice is due here, but the second was read only now: settled, it would name no alias.
    await checkForwarding(deps(w.fetcher, at(25), real));
    expect(w.sends).toEqual([]);
    await checkForwarding(deps(w.fetcher, at(30), real));
    expect(w.sends).toHaveLength(2);
    expect(w.sends[0]?.text).toContain("hello@isitlegit.co.za");
    expect(w.sends[0]?.text).not.toContain("its forward was not found");
    const incidents = await db.prepare("SELECT COUNT(*) AS n FROM forward_incidents").first<{ n: number }>();
    expect(incidents?.n).toBe(1);
  });

  it("holds the cluster too when its earlier notice is the one read late", async () => {
    // The later notice shows first, the earlier one a tick on, the forward the tick after (round 2).
    const later = report({
      sessionId: "s-r2",
      messageId: "<ndr-2@x>",
      datetime: new Date(at(0.2).getTime() + 2000).toISOString(),
    });
    const w = world([[later], [report()], [forward()], []]);
    await checkForwarding(deps(w.fetcher, at(20), real));
    await checkForwarding(deps(w.fetcher, at(25), real));
    expect(w.sends).toEqual([]);
    await checkForwarding(deps(w.fetcher, at(30), real));
    expect(w.sends).toHaveLength(2);
    expect(w.sends[0]?.text).toContain("hello@isitlegit.co.za");
    expect(w.sends[0]?.text).not.toContain("its forward was not found");
    const incidents = await db.prepare("SELECT COUNT(*) AS n FROM forward_incidents").first<{ n: number }>();
    expect(incidents?.n).toBe(1);
  });

  it("leaves a due refusal waiting when a complete read could not record its forward, tied once it does", async () => {
    // The forward is read in full at 22, but D1 refuses its row: tying the refusal then would name no alias.
    const w = world([[report()], [forward()], [forward()], []]);
    await checkForwarding(deps(w.fetcher, at(1), real));
    const failing = new Proxy(db, {
      get(target, name) {
        if (name === "prepare")
          return (query: string) => {
            if (query.startsWith("INSERT INTO forward_seen")) throw new Error("D1_ERROR: Network connection lost.");
            return target.prepare(query);
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    expect(await checkForwarding(deps(w.fetcher, at(22), { ...real, db: failing }))).toMatchObject({
      state: "degraded",
    });
    expect(w.sends).toEqual([]);
    // The scan did not advance, so the next run reads the forward again, records it and ties the refusal to it.
    await checkForwarding(deps(w.fetcher, at(25), real));
    expect(w.sends.map((m) => m.to)).toEqual(OPERATORS);
    expect(w.sends[0]?.text).toContain("hello@isitlegit.co.za");
    expect(w.sends[0]?.text).not.toContain("its forward was not found");
  });

  it("leaves a due refusal waiting through a partial read, tied at the complete read that follows", async () => {
    const bulk = (page: number) =>
      Array.from({ length: 1000 }, (_, i) =>
        forward({
          messageId: `<b-${page}-${i}@x>`,
          sessionId: `b${page}-${i}`,
          subject: `Bulk ${page}-${i}`,
          datetime: at(2 + (page * 1000 + i) / 2000).toISOString(),
        }),
      );
    const w = world([[report()], ...Array.from({ length: 10 }, (_, p) => bulk(p)), [forward()], []]);
    await checkForwarding(deps(w.fetcher, at(1), real));
    expect(await checkForwarding(deps(w.fetcher, at(21), real))).toMatchObject({ state: "partial" });
    expect(w.sends).toEqual([]);
    await checkForwarding(deps(w.fetcher, at(25), real));
    expect(w.sends).toHaveLength(2);
    expect(w.sends[0]?.text).toContain("hello@isitlegit.co.za");
  });
});

describe("early refusal alert before attribution (D01 T02 §15)", () => {
  const real = { graceMs: MATCH_GRACE_MS, seenMs: SEEN_MS };
  // Omit earlyAlert so checkForwarding uses its production default (true).
  const prodDeps = (fetcher: typeof fetch, now: Date, over: Partial<ForwardingDeps> = {}): ForwardingDeps => ({
    db,
    token: "test-token",
    zone: ZONE,
    mail: { db, apiKey: "api-test", fetch: fetcher, pause: async () => {}, now: () => now },
    operators: OPERATORS,
    fetch: fetcher,
    now: () => now,
    ...real,
    ...over,
  });

  it("sends the early alert at first reading naming destination and time but no alias, the attributed alert after the grace, and one alert when earlyAlert is false", async () => {
    const w = world([[forward(), report()], []]);
    // First scan at 1 minute (before the 20-minute grace): sends the early alert to both operator mailboxes.
    const firstScan = await checkForwarding(prodDeps(w.fetcher, at(1)));
    expect(firstScan).toMatchObject({ state: "ok", alerted: 1 });
    expect(w.sends).toHaveLength(2);
    expect(w.sends.map((s) => s.to)).toEqual(OPERATORS);
    expect(w.sends[0]?.subject).toBe("IsItLegit: a forwarded message was refused after forwarding");
    expect(w.sends[0]?.text).toContain(`refused by rizonetech.com at ${report().datetime}`);
    expect(w.sends[0]?.text).not.toContain("hello@isitlegit.co.za");
    expect(w.sends[0]?.key).toMatch(/^forward-early:[0-9a-f]{64}:0$/);

    // After the grace and SEEN_MS (at 22 minutes): sends the attributed alert naming hello@isitlegit.co.za.
    const secondScan = await checkForwarding(prodDeps(w.fetcher, at(22)));
    expect(secondScan).toMatchObject({ state: "ok", alerted: 1 });
    expect(w.sends).toHaveLength(4);
    expect(w.sends[2]?.subject).toBe("IsItLegit: mail to hello@isitlegit.co.za was refused after forwarding");
    expect(w.sends[2]?.text).toContain("from supplier.example to hello@isitlegit.co.za");
    expect(w.sends[2]?.key).toMatch(/^forward-failure:[0-9a-f]{64}:0$/);

    // When the operator says no (earlyAlert: false): nothing before the grace, one attributed alert after.
    await db.batch([
      db.prepare("DELETE FROM forward_scan"),
      db.prepare("DELETE FROM forward_seen"),
      db.prepare("DELETE FROM forward_incidents"),
      db.prepare("DELETE FROM forward_notices"),
      db.prepare("DELETE FROM mail_sends"),
    ]);
    const wNo = world([[forward(), report()], []]);
    await checkForwarding(prodDeps(wNo.fetcher, at(1), { earlyAlert: false }));
    expect(wNo.sends).toEqual([]);
    await checkForwarding(prodDeps(wNo.fetcher, at(22), { earlyAlert: false }));
    expect(wNo.sends).toHaveLength(2);
    expect(wNo.sends[0]?.text).toContain("hello@isitlegit.co.za");
  });

  it("deduplicates the early alert across same-scan notices, later-scan notices (including an earlier timestamp read later), and replays", async () => {
    const laterNotice = report({
      sessionId: "s-r2",
      messageId: "<ndr-2@x>",
      datetime: new Date(at(0.2).getTime() + 2000).toISOString(),
    });
    const w = world([[laterNotice], [report()], [forward()], []]);
    // Scan 1 reads the second notice first and sends 1 early alert (2 operator emails).
    await checkForwarding(prodDeps(w.fetcher, at(1)));
    expect(w.sends).toHaveLength(2);
    // Scan 2 reads the earlier-timestamped sibling notice; it shares the cluster's early-alert key and sends nothing new.
    await checkForwarding(prodDeps(w.fetcher, at(5)));
    expect(w.sends).toHaveLength(2);
    // Scan 3 (still waiting on SEEN_MS for the second notice) replays and sends nothing new.
    await checkForwarding(prodDeps(w.fetcher, at(7)));
    expect(w.sends).toHaveLength(2);
    // Scan 4 (at 22 minutes, past grace and SEEN_MS for both notices): folds the cluster and sends 1 attributed alert.
    await checkForwarding(prodDeps(w.fetcher, at(22)));
    expect(w.sends).toHaveLength(4);
    expect(w.sends[2]?.text).toContain("hello@isitlegit.co.za");
    expect(w.sends[2]?.text).toContain("Cloudflare dropped the 2 refusal notices");
  });

  it("sends no second alert after the grace when no forward was found and the early alert was already confirmed delivered", async () => {
    const w = world([[report()], []]);
    await checkForwarding(prodDeps(w.fetcher, at(1)));
    expect(w.sends).toHaveLength(2);
    // Past the grace with no matching forward: the early alert already said all, so no second alert goes.
    const postGrace = await checkForwarding(prodDeps(w.fetcher, at(22)));
    expect(postGrace).toMatchObject({ state: "ok", alerted: 0 });
    expect(w.sends).toHaveLength(2);
    const incident = await db.prepare("SELECT alert FROM forward_incidents").first<{ alert: string }>();
    expect(incident?.alert).toBe("sent");
  });

  it("retries a failed early alert on the next scan without duplicating a delivered mailbox, and sends the early alert during a partial scan while keeping attribution blocked", async () => {
    // 1. Failed second mailbox on Scan 1, recovered on Scan 2, then attributed after the grace on Scan 3.
    const sends: { to: string; key: string }[] = [];
    let fallbackUp = false;
    const pages: RoutingEvent[][] = [[forward(), report()], [], []];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url === GRAPHQL_URL)
        return Response.json({ data: { viewer: { zones: [{ emailRoutingAdaptive: pages.shift() ?? [] }] } } });
      if (body.to[0] === OPERATORS[1] && !fallbackUp)
        return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
      const key = body.custom_headers.find((h: { header: string }) => h.header === "X-IsItLegit-Send")?.value;
      sends.push({ to: body.to[0], key });
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `e-${sends.length}` } });
    }) as typeof fetch;

    expect(await checkForwarding(prodDeps(fetcher, at(1)))).toMatchObject({ state: "degraded", alerted: 0 });
    expect(sends.map((s) => s.to)).toEqual([OPERATORS[0]]);
    fallbackUp = true;
    expect(await checkForwarding(prodDeps(fetcher, at(5)))).toMatchObject({ state: "ok", alerted: 1 });
    expect(sends.map((s) => s.to)).toEqual(OPERATORS);
    // Attribution still waited for the grace and now sends the attributed alert at 22 minutes.
    expect(await checkForwarding(prodDeps(fetcher, at(22)))).toMatchObject({ state: "ok", alerted: 1 });
    expect(sends).toHaveLength(4);

    // 2. Partial scan containing a refusal: early alert goes immediately, attribution stays blocked until complete read.
    await db.batch([
      db.prepare("DELETE FROM forward_scan"),
      db.prepare("DELETE FROM forward_seen"),
      db.prepare("DELETE FROM forward_incidents"),
      db.prepare("DELETE FROM forward_notices"),
      db.prepare("DELETE FROM mail_sends"),
    ]);
    const bulk = (page: number) =>
      Array.from({ length: 1000 }, (_, i) =>
        forward({
          messageId: `<p-${page}-${i}@x>`,
          sessionId: `p${page}-${i}`,
          subject: `Bulk ${page}-${i}`,
          datetime: at(2 + (page * 1000 + i) / 2000).toISOString(),
        }),
      );
    const wPartial = world([
      [report(), ...bulk(0).slice(0, 999)],
      ...Array.from({ length: 9 }, (_, p) => bulk(p + 1)),
      [forward()],
      [],
    ]);
    const partialOut = await checkForwarding(prodDeps(wPartial.fetcher, at(21)));
    expect(partialOut).toMatchObject({ state: "partial", alerted: 1 });
    expect(wPartial.sends).toHaveLength(2);
    expect(wPartial.sends[0]?.subject).toBe("IsItLegit: a forwarded message was refused after forwarding");
    // Next scan at 26 minutes completes the read and sends the attributed alert.
    await checkForwarding(prodDeps(wPartial.fetcher, at(26)));
    expect(wPartial.sends).toHaveLength(4);
    expect(wPartial.sends[2]?.text).toContain("hello@isitlegit.co.za");
  });

  it("bounds early-alert delivery to ALERTS_PER_RUN per scan and processes the remaining clusters on the next scan", async () => {
    const totalClusters = ALERTS_PER_RUN + 5;
    const reports = Array.from({ length: totalClusters }, (_, i) =>
      report({
        messageId: `<ndr-cap-${i}@x>`,
        sessionId: `s-cap-${i}`,
        subject: `Undeliverable: Invoice cap-${i}`,
        datetime: new Date(at(0.1).getTime() + i * 1000).toISOString(),
      }),
    );
    const w = world([reports, []]);
    const firstRun = await checkForwarding(prodDeps(w.fetcher, at(5)));
    expect(firstRun).toMatchObject({ state: "ok", alerted: ALERTS_PER_RUN });
    expect(w.sends).toHaveLength(ALERTS_PER_RUN * OPERATORS.length);

    // Remaining 5 clusters stay waiting and send their early alerts on the next scan.
    const secondRun = await checkForwarding(prodDeps(w.fetcher, at(10)));
    expect(secondRun).toMatchObject({ state: "ok", alerted: 5 });
    expect(w.sends).toHaveLength(totalClusters * OPERATORS.length);
  });
});
