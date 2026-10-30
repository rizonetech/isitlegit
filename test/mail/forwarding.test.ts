import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { scheduledForwarding } from "../../src/index";
import {
  checkForwarding,
  type ForwardingDeps,
  GRAPHQL_URL,
  RECOVERY_MS,
  type RoutingEvent,
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
  ...over,
});

describe("a forward the destination refused", () => {
  it("alerts both mailboxes once, with the alias, the time, the domains and never the sender's address or subject", async () => {
    const w = world([[forward(), report(), report({ sessionId: "s-report-2", messageId: "<ndr-2@x>" })]]);
    const outcome = await checkForwarding(deps(w.fetcher, at(5)));
    expect(outcome).toMatchObject({ state: "ok", events: 3, incidents: 1, alerted: 1 });
    expect(w.sends.map((s) => s.to)).toEqual(OPERATORS);
    const [first] = w.sends;
    expect(first?.subject).toBe("IsItLegit: mail to hello@isitlegit.co.za was refused after forwarding");
    expect(first?.text).toContain("from supplier.example to hello@isitlegit.co.za");
    expect(first?.text).toContain(`received at ${report().datetime}`);
    expect(first?.text).toContain("refused by rizonetech.com");
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
