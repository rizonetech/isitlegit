import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    ledger: LEDGER,
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
      expect.objectContaining({ date: TODAY, call: "client Spark", cost: COST, state: "settled" }),
    ]);
    const record = readFileSync(RECORD, "utf-8");
    expect(record).toContain("## Meta model client");
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

  it("fails when the gateway sent no log id", async () => {
    const { options } = world({
      responses: () => json({ id: "resp_1", object: "response", output: [], usage: USAGE }),
    });
    const outcome = await runClientLive(options);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("no cf-aig-log-id");
  });
});
