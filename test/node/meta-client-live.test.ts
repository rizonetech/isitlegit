import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type LiveOptions, runClientLive } from "../../scripts/meta-client-live.ts";
import { LOGS_URL, readLedger, type Spend, spentOn, tokenCost } from "../../scripts/meta-smoke.ts";

// scripts/meta-client-live.ts (D03 T01 §1's live checkpoint) against a stubbed transport: it spends under the smoke's
// caps and ledger, reserving before the call and reading no secret past an exhausted cap, and it passes only when the
// gateway's log holds the call's metadata and no stored body.
const DIR = join(import.meta.dirname, `../../build/test-meta-client-live-${process.pid}`);
const LEDGER = join(DIR, "spend.json");
const RECORD = join(DIR, "live-checks.md");
const PENDING = join(DIR, "pending.json");
const SECRETS = { meta: `meta-${"k".repeat(30)}`, run: `run-${"r".repeat(30)}`, admin: `adm-${"a".repeat(30)}` };
const NOW = new Date("2026-10-28T17:00:00Z");
const TODAY = "2026-10-28";
const USAGE = { input_tokens: 15, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } };
const COST = tokenCost("muse-spark-1.3", 15, 2);

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(RECORD, "# Live checks\n");
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const goodLog = {
  model: "muse-spark-1.3",
  success: true,
  status_code: 200,
  duration: 900,
  tokens_in: 15,
  tokens_out: 2,
  cost: COST,
};
const absent = () => json({ errors: [{ code: 7002, message: "body not available" }], success: false }, 404);

type World = {
  responses?: () => Response | Promise<Response>;
  logs?: (id: string, part: string | undefined) => Response;
};
function world(w: World = {}) {
  const sent: string[] = [];
  let secretsRead = 0;
  const options: LiveOptions = {
    // A shared budget that admits every attempt (D03 T01 §2; the real one is test/node/meta-budget-local.test.ts).
    budget: { reserve: async () => "held", settle: async () => {}, uncertain: async () => {}, refused: async () => {} },
    ledger: LEDGER,
    pending: PENDING,
    record: RECORD,
    now: () => NOW,
    logWaitMs: 50,
    pause: async () => {},
    readSecrets: async () => {
      secretsRead++;
      return SECRETS;
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push(request.url);
      if (request.url.startsWith(LOGS_URL)) {
        const [id, part] = request.url.slice(LOGS_URL.length + 1).split("/") as [string, string | undefined];
        return (w.logs ?? ((_: string, p: string | undefined) => (p ? absent() : json({ result: goodLog }))))(id, part);
      }
      return (
        w.responses ??
        (() =>
          json({ id: "resp_1", object: "response", output: [], usage: USAGE }, 200, { "cf-aig-log-id": "log-abc" }))
      )();
    }) as typeof fetch,
  };
  return { options, sent, secretsRead: () => secretsRead };
}

const ledgerNow = (): Spend[] => readLedger(LEDGER);

describe("meta-client-live", () => {
  it("passes on a metadata-only log, settles the ledger at Meta's usage and records the run", async () => {
    const { options, sent } = world();
    const outcome = await runClientLive(options);
    expect(outcome.lines.join("\n")).toContain("passed");
    expect(outcome.code).toBe(0);
    expect(sent[0]).toMatch(/\/custom-meta\/v1\/responses$/);
    expect(sent.filter((u) => u.startsWith(LOGS_URL))).toHaveLength(3); // the log, its request body, its response body
    expect(ledgerNow()).toEqual([
      expect.objectContaining({ date: TODAY, call: "client Spark attempt 1", cost: COST, state: "settled" }),
    ]);
    const record = readFileSync(RECORD, "utf-8");
    expect(record).toContain("## Meta model client");
    expect(existsSync(PENDING)).toBe(false);
    expect(record).toContain("`log-abc`");
    for (const secret of Object.values(SECRETS)) {
      expect(outcome.lines.join("\n")).not.toContain(secret);
      expect(record).not.toContain(secret);
    }
  });

  it("refuses at an exhausted day cap, reading no secret and sending nothing", async () => {
    writeFileSync(
      LEDGER,
      JSON.stringify([{ date: TODAY, run: "earlier", call: "x", estimate: 2, cost: 1.99999, state: "settled" }]),
    );
    const { options, sent, secretsRead } = world();
    const outcome = await runClientLive(options);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("refused");
    expect(secretsRead()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(ledgerNow()).toHaveLength(1);
  });

  it("holds the reservation while the call is out, and keeps it counted when the call is cut off", async () => {
    let during: Spend[] = [];
    const { options } = world({
      responses: () => {
        during = ledgerNow();
        return Promise.reject(new TypeError("connection reset"));
      },
    });
    const outcome = await runClientLive(options);
    expect(outcome.code).toBe(1);
    expect(during).toEqual([expect.objectContaining({ state: "reserved", cost: null })]);
    const [entry] = ledgerNow();
    expect(entry).toMatchObject({ state: "uncertain", cost: null });
    expect(spentOn(ledgerNow(), TODAY)).toBe(entry?.estimate);
    expect(existsSync(`${LEDGER}.lock`)).toBe(false);
  });

  it.each([
    ["a log that never appears", () => json({ success: false, errors: [{ code: 1000 }] }, 404), "did not appear"],
    ["a denied log read", () => json({ success: false, errors: [{ code: 10000 }] }, 403), "did not appear"],
  ] as const)("fails on %s", async (_, logs, detail) => {
    const { options } = world({ logs });
    const outcome = await runClientLive(options);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain(detail);
    expect(readFileSync(RECORD, "utf-8")).not.toContain("## Meta model client");
  });

  it.each(["request", "response"])("fails when the gateway stored the %s body", async (stored) => {
    const { options } = world({
      logs: (_id, part) =>
        part === stored ? json({ result: "the body" }) : part ? absent() : json({ result: goodLog }),
    });
    const outcome = await runClientLive(options);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain(`stored the ${stored} body`);
  });

  it("fails when the body's absence cannot be verified (a denied body read)", async () => {
    const { options } = world({ logs: (_id, part) => (part ? json({}, 403) : json({ result: goodLog })) });
    const outcome = await runClientLive(options);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("could not be verified");
  });

  it("fails when the gateway sent no log id, and a rerun does not pay again", async () => {
    const { options } = world({
      responses: () => json({ id: "resp_1", object: "response", output: [], usage: USAGE }),
    });
    const outcome = await runClientLive(options);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("no cf-aig-log-id");
    expect(JSON.parse(readFileSync(PENDING, "utf-8"))).toMatchObject({ logId: null, traces: ["response resp_1"] });
    const again = world();
    const second = await runClientLive(again.options);
    expect(second.code).toBe(1);
    expect(second.lines.join("\n")).toContain("response resp_1");
    expect(again.sent).toHaveLength(0);
    expect(ledgerNow()).toHaveLength(1);
  });

  it("reserves every attempt: one that failed stays at its estimate, the answered one is settled", async () => {
    let n = 0;
    const { options, sent } = world({
      responses: () =>
        ++n === 1
          ? json({ error: { type: "server_error", message: "busy" } }, 503)
          : json({ id: "resp_1", object: "response", output: [], usage: USAGE }, 200, { "cf-aig-log-id": "log-abc" }),
    });
    const outcome = await runClientLive(options);
    expect(outcome.code).toBe(0);
    expect(sent.filter((u) => !u.startsWith(LOGS_URL))).toHaveLength(2);
    expect(ledgerNow()).toEqual([
      expect.objectContaining({ call: "client Spark attempt 1", cost: null, state: "uncertain" }),
      expect.objectContaining({ call: "client Spark attempt 2", cost: COST, state: "settled" }),
    ]);
  });

  it("sends no retry the day cap cannot cover", async () => {
    const { options, sent } = world({ responses: () => json({ error: { type: "server_error" } }, 503) });
    const estimate = tokenCost("muse-spark-1.3", 200, 64);
    const outcome = await runClientLive({ ...options, dayCap: estimate * 1.5 });
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("stopped before attempt 2");
    expect(sent).toHaveLength(1);
    expect(ledgerNow()).toEqual([expect.objectContaining({ call: "client Spark attempt 1", state: "uncertain" })]);
  });

  it("resumes a log check that failed without calling Meta again", async () => {
    const down = world({ logs: () => json({ success: false, errors: [{ code: 1000 }] }, 404) });
    const first = await runClientLive(down.options);
    expect(first.code).toBe(1);
    expect(first.lines.join("\n")).toContain("run again to resume");
    expect(JSON.parse(readFileSync(PENDING, "utf-8"))).toMatchObject({ logId: "log-abc", cost: COST });

    const up = world();
    const second = await runClientLive(up.options);
    expect(second.code).toBe(0);
    expect(second.lines.join("\n")).toContain("no new call");
    expect(up.sent.every((u) => u.startsWith(LOGS_URL))).toBe(true);
    expect(ledgerNow()).toHaveLength(1);
    expect(readFileSync(RECORD, "utf-8")).toContain("`log-abc`");
    expect(existsSync(PENDING)).toBe(false);
  });

  it("resumes a record that could not be written without calling Meta again", async () => {
    const blocked = join(DIR, "blocked");
    mkdirSync(blocked);
    const first = await runClientLive({ ...world().options, record: blocked });
    expect(first.code).toBe(1);
    expect(first.lines.join("\n")).toContain("the record could not be written");
    expect(existsSync(PENDING)).toBe(true);

    const again = world();
    const second = await runClientLive(again.options);
    expect(second.code).toBe(0);
    expect(again.sent.every((u) => u.startsWith(LOGS_URL))).toBe(true);
    expect(ledgerNow()).toHaveLength(1);
  });

  it("never sends again a call whose answer could not be saved", async () => {
    // The pending file in a folder that turns read-only once the call is out: the mark is written, the answer is not.
    const folder = join(DIR, "pending");
    mkdirSync(folder);
    const pending = join(folder, "pending.json");
    const down = world({
      responses: () => {
        chmodSync(folder, 0o500);
        return json({ id: "resp_1", object: "response", output: [], usage: USAGE }, 200, {
          "cf-aig-log-id": "log-abc",
        });
      },
      logs: () => json({ success: false, errors: [{ code: 1000 }] }, 404),
    });
    const first = await runClientLive({ ...down.options, pending });
    chmodSync(folder, 0o700);
    expect(first.code).toBe(1);
    expect(first.lines.join("\n")).toContain("record log log-abc by hand");
    expect(JSON.parse(readFileSync(pending, "utf-8"))).toMatchObject({ logId: null });

    const again = world();
    const second = await runClientLive({ ...again.options, pending });
    expect(second.code).toBe(1);
    expect(second.lines.join("\n")).toContain("is not sent again");
    expect(again.sent).toHaveLength(0);
    expect(ledgerNow()).toHaveLength(1);
  });

  it("sends nothing when the call cannot be marked as sent", async () => {
    const folder = join(DIR, "locked");
    mkdirSync(folder, { mode: 0o500 });
    const { options, sent } = world();
    const outcome = await runClientLive({ ...options, pending: join(folder, "pending.json") });
    chmodSync(folder, 0o700);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("so nothing was sent");
    expect(sent).toHaveLength(0);
    expect(ledgerNow()).toEqual([]);
  });

  it("keeps the mark when an answered call's body is cut off, so a rerun pays for nothing", async () => {
    const cut = () =>
      new Response(
        new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode('{"id":"resp_1","object":"resp'));
            c.error(new TypeError("connection reset"));
          },
        }),
        { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": "log-cut" } },
      );
    const first = world({ responses: cut });
    const outcome = await runClientLive(first.options);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("may have been answered (log log-cut)");
    expect(JSON.parse(readFileSync(PENDING, "utf-8"))).toMatchObject({ logId: null, traces: ["log log-cut"] });

    const again = world();
    const second = await runClientLive(again.options);
    expect(second.code).toBe(1);
    expect(second.lines.join("\n")).toContain("log log-cut");
    expect(again.sent).toHaveLength(0);
    expect(ledgerNow()).toHaveLength(1);
  });

  it("keeps the mark when the connection drops after sending", async () => {
    const { options } = world({ responses: () => Promise.reject(new TypeError("connection reset")) });
    expect((await runClientLive(options)).code).toBe(1);
    expect(existsSync(PENDING)).toBe(true);
  });

  it("leaves no mark when the call failed, so a new run may call again", async () => {
    const { options } = world({ responses: () => json({ error: { type: "invalid_request_error" } }, 400) });
    const outcome = await runClientLive(options);
    expect(outcome.code).toBe(1);
    expect(existsSync(PENDING)).toBe(false);
  });

  it("writes a resumed call's record once, even if it was written before the run stopped", async () => {
    writeFileSync(
      PENDING,
      JSON.stringify({
        run: "2026-10-28T17:00:00.000Z",
        logId: "log-abc",
        usage: { input: 15, output: 2, cached: 0 },
        cost: COST,
        estimate: 0.0003,
      }),
    );
    const { options, sent } = world();
    expect((await runClientLive(options)).code).toBe(0);
    expect((await runClientLive({ ...options })).code).toBe(0);
    writeFileSync(
      PENDING,
      JSON.stringify({
        run: "2026-10-28T17:00:00.000Z",
        logId: "log-abc",
        usage: { input: 15, output: 2, cached: 0 },
        cost: COST,
        estimate: 0.0003,
      }),
    );
    expect((await runClientLive(options)).code).toBe(0);
    expect(readFileSync(RECORD, "utf-8").split("`log-abc`").length - 1).toBe(1);
    expect(sent.some((u) => !u.startsWith(LOGS_URL))).toBe(true); // the middle run, with nothing pending, made its own call
  });

  it("refuses an unreadable pending call rather than paying for another", async () => {
    writeFileSync(PENDING, "{ not json");
    const { options, sent } = world();
    const outcome = await runClientLive(options);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("repair it rather than delete it");
    expect(sent).toHaveLength(0);
  });
});

describe("round 1: the live check keeps each attempt's call record", () => {
  it("forwards the client's call (its id and owner) with the ledger's row id", async () => {
    const { options } = world();
    const reserved: unknown[][] = [];
    options.budget = {
      reserve: async (...args: unknown[]) => {
        reserved.push(args);
        return "held";
      },
      settle: async () => {},
      uncertain: async () => {},
      refused: async () => {},
    } as LiveOptions["budget"];
    expect((await runClientLive(options)).code).toBe(0);
    expect(reserved[0]?.[3]).toMatch(/^ledger:/);
    expect(reserved[0]?.[4]).toMatchObject({
      callId: expect.any(String),
      owner: { kind: "script", name: "meta-client-live" },
    });
  });
});
