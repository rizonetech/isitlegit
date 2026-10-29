import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  adoptLegacyLedger,
  GATEWAY_URL,
  LEGACY_LEDGER,
  LOGS_URL,
  loadFixtures,
  MODELS,
  metaLedger,
  parseMetaArgs,
  type RunOptions,
  readLedger,
  runMetaSmoke,
  takeLock,
  USAGE,
} from "../../scripts/meta-smoke.ts";

// A shared budget that admits every call (D03 T01 §2); test/node/meta-budget-local.test.ts covers the real one.
const openBudget = () => ({
  reserve: async () => "held",
  settle: async () => {},
  uncertain: async () => {},
});

// scripts/meta-smoke.ts (D00 T01 §7) against a stubbed transport: the real dispatch path carries the gateway headers
// and `store: false`, the spend is bounded before any call, a failed probe never passes, and no secret is printed.
const DIR = join(import.meta.dirname, `../../build/test-meta-smoke-${process.pid}`);
const SECRETS = { meta: `meta-${"k".repeat(30)}`, run: `run-${"r".repeat(30)}`, admin: `adm-${"a".repeat(30)}` };
const fx = loadFixtures();
beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

// The README's SAM record, with its box placed over the fixture's logo (250,150)-(550,350) on an 800 by 500 card.
const samRecord = (box = "x1=260;y1=160;x2=540;y2=340") =>
  `<0f>0<|box;${box};w=800;h=500|><|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7\`e.ioeAf6-k/#Xd8%dX9x(|>\n`;
const lane = { item_id: "m1", output_index: 0, content_index: 0 };
const sse = (events: object[]) =>
  events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const samStream = (text: string, complete = true) =>
  sse([
    { type: "response.output_text.delta", ...lane, delta: text },
    { type: "response.output_text.done", ...lane, text },
    // As the live SAM stream does, the completed event carries Meta's usage.
    ...(complete
      ? [
          {
            type: "response.completed",
            response: { id: "r", status: "completed", usage: { input_tokens: 0, output_tokens: 0 } },
          },
        ]
      : []),
  ]);
const message = (text: string, usage = { input_tokens: 100, output_tokens: 10 }, status = "completed") => ({
  id: "resp",
  object: "response",
  status,
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  output_text: text,
  usage,
});
const click = (x: number, y: number, name = "click") => ({
  id: "resp",
  object: "response",
  status: "completed",
  output: [{ type: "function_call", call_id: "c1", name, arguments: JSON.stringify({ x, y }) }],
  usage: { input_tokens: 2000, output_tokens: 50 },
});
// The gateway's pricing rules: input, cached input, output (US dollars per million tokens).
const price = { "muse-spark-1.3": [1.25, 0.15, 4.25], "muse-wonder-1.0": [4, 0.2, 20] } as const;

type Stub = {
  answers?: Partial<Record<string, () => Response>>; // by call: spark-text, spark-image, sam, wonder
  logs?: (id: string, part?: string) => Response;
};
function world(stub: Stub = {}) {
  const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const usageOf: Record<string, { model: string; input: number; cached: number; output: number }> = {};
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.startsWith(LOGS_URL)) {
      const [id, part] = url.slice(LOGS_URL.length + 1).split("/") as [string, string | undefined];
      if (stub.logs) return stub.logs(id, part);
      if (part) return json({ errors: [{ code: 7002, message: "Request body not available" }], success: false }, 404);
      const u = usageOf[id];
      if (!u) return json({ success: false }, 404);
      const [pin, pcached, pout] = price[u.model as keyof typeof price] ?? [0, 0, 0];
      const cost =
        u.model === "sam-3.1" ? 0 : ((u.input - u.cached) * pin + u.cached * pcached + u.output * pout) / 1e6;
      return json({
        result: {
          id,
          model: u.model,
          success: true,
          status_code: 200,
          duration: 900,
          tokens_in: u.input,
          tokens_out: u.output,
          cost,
        },
      });
    }
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "{}")));
    sent.push({ url, headers, body });
    const id = `log-${sent.length}`;
    const text = JSON.stringify(body);
    const key =
      body.model === "sam-3.1"
        ? "sam"
        : body.model === "muse-wonder-1.0"
          ? "wonder"
          : text.includes("input_image")
            ? "spark-image"
            : "spark-text";
    const answer =
      stub.answers?.[key]?.() ??
      (key === "sam"
        ? new Response(samStream(samRecord()), { headers: { "content-type": "text/event-stream" } })
        : key === "wonder"
          ? json(click(640, 450))
          : json(message(key === "spark-image" ? fx.code : "51")));
    // The body is read once: the reply is rebuilt from its text, and the usage read from the same text.
    const replyText = await answer.text();
    const replyHeaders = new Headers(answer.headers);
    replyHeaders.set("cf-aig-log-id", id);
    const usage = { input: 0, cached: 0, output: 0 };
    if (key !== "sam") {
      try {
        const peek = JSON.parse(replyText);
        usage.input = peek.usage?.input_tokens ?? 0;
        usage.output = peek.usage?.output_tokens ?? 0;
        usage.cached = peek.usage?.input_tokens_details?.cached_tokens ?? 0;
      } catch {
        // not JSON
      }
    }
    usageOf[id] = { model: body.model, ...usage };
    return new Response(replyText, { status: answer.status, headers: replyHeaders });
  }) as typeof fetch;
  return { fetchStub, sent };
}
const live = (fetchStub: typeof fetch, extra: Partial<RunOptions> = {}) => {
  let secretsRead = 0;
  return {
    run: runMetaSmoke({
      dry: false,
      confirmCredit: true,
      budget: openBudget(),
      fixtures: fx,
      readSecrets: async () => {
        secretsRead++;
        return SECRETS;
      },
      fetch: fetchStub,
      ledger: join(DIR, "spend.json"),
      report: join(DIR, "report.md"),
      now: () => new Date("2026-10-27T15:00:00Z"),
      logWaitMs: 50,
      timeoutMs: 2_000,
      ...extra,
    }),
    secretsRead: () => secretsRead,
  };
};
const failure = (lines: string[], name: string) => lines.find((l) => l.startsWith(`failed: ${name}`));

describe("scripts/meta-smoke.ts", () => {
  it("--dry prints four requests with store: false and the token redacted, sending and reading nothing", async () => {
    const { fetchStub, sent } = world();
    let secretsRead = 0;
    const outcome = await runMetaSmoke({
      dry: true,
      confirmCredit: false,
      fixtures: fx,
      fetch: fetchStub,
      readSecrets: async () => {
        secretsRead++;
        return SECRETS;
      },
    });
    expect(outcome.code).toBe(0);
    expect(sent).toHaveLength(0);
    expect(secretsRead).toBe(0);
    const bodies = outcome.lines.filter((l) => l.startsWith("  body: "));
    expect(bodies).toHaveLength(4);
    expect(bodies.every((b) => b.includes('"store":false'))).toBe(true);
    expect(outcome.lines.filter((l) => l.includes('"cf-aig-authorization":"Bearer <redacted>"'))).toHaveLength(4);
  });

  it("refuses a live run without --confirm-credit and any Contributor model, before anything is read or sent", async () => {
    const { fetchStub, sent } = world();
    expect((await runMetaSmoke({ dry: false, confirmCredit: false, fixtures: fx, fetch: fetchStub })).code).toBe(2);
    const contributor = await runMetaSmoke({
      dry: false,
      confirmCredit: true,
      budget: openBudget(),
      model: "muse-spark-1.3-contributor",
      fixtures: fx,
      fetch: fetchStub,
    });
    expect(contributor.code).toBe(2);
    expect(contributor.lines[0]).toMatch(/Contributor model/);
    expect(sent).toHaveLength(0);
  });

  it("passes when every call is right, with the gateway headers and store: false on every request, and prints no secret", async () => {
    const { fetchStub, sent } = world();
    const { run } = live(fetchStub);
    const outcome = await run;
    expect(outcome.code).toBe(0);
    expect(sent).toHaveLength(4);
    for (const request of sent) {
      expect(request.url).toBe(`${GATEWAY_URL}/responses`);
      expect(request.headers.get("cf-aig-authorization")).toBe(`Bearer ${SECRETS.run}`);
      expect(request.headers.get("cf-aig-collect-log")).toBe("true");
      expect(request.headers.get("cf-aig-collect-log-payload")).toBe("false");
      expect(request.body.store).toBe(false);
      expect(String(request.body.model)).not.toMatch(/-contributor$/);
      if (request.body.model !== "sam-3.1") expect(request.body.max_output_tokens).toBeGreaterThan(0);
    }
    const report = readFileSync(join(DIR, "report.md"), "utf-8");
    expect(report).toMatch(/every check passed/);
    expect(report.match(/\| passed \|/g)).toHaveLength(4);
    expect(report).toMatch(/unavailable from the gateway; US\$0\.0025 per image/);
    const everything = [...outcome.lines, report, readFileSync(join(DIR, "spend.json"), "utf-8")].join("\n");
    for (const secret of Object.values(SECRETS)) expect(everything).not.toContain(secret);
    expect(JSON.parse(readFileSync(join(DIR, "spend.json"), "utf-8"))[0]).toMatchObject({ date: "2026-10-27" });
  });

  it("fails a Spark image answer without the fixture's code, and a response that did not complete", async () => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    const wrong = await live(world({ answers: { "spark-image": () => json(message("ABC-123-XYZ")) } }).fetchStub).run;
    expect(wrong.code).toBe(1);
    expect(failure(wrong.lines, "Spark image")).toMatch(/expected exactly the fixture's code/);
    const cut = await live(
      world({ answers: { "spark-text": () => json(message("51", undefined, "incomplete")) } }).fetchStub,
    ).run;
    expect(failure(cut.lines, "Spark text")).toMatch(/status is "incomplete", not completed/);
  });

  it("tells SAM's outcomes apart: no logo, a box elsewhere, malformed text, a stream cut off", async () => {
    const stream = (body: string) => () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    const cases: [string, string, RegExp][] = [
      ["none", samStream(""), /no logo found/],
      ["elsewhere", samStream(samRecord("x1=10;y1=10;x2=60;y2=60")), /none over the logo/],
      ["malformed", samStream("<0f>0<|box;oops|>\n"), /malformed part\(s\) \(malformed_record\)/],
      ["malformed beside a good box", samStream(`${samRecord()}<0f>0<|box;oops|>\n`), /1 malformed part\(s\)/],
      ["cut", samStream(samRecord(), false), /not completed|could not be read/],
    ];
    for (const [label, body, why] of cases) {
      const outcome = await live(world({ answers: { sam: stream(body) } }).fetchStub).run;
      expect(outcome.code, label).toBe(1);
      expect(failure(outcome.lines, "SAM 3.1"), label).toMatch(why);
    }
  });

  it("fails Wonder for a click outside the button, another function, malformed arguments and no call", async () => {
    const json = (b: unknown) => () =>
      new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    const malformed = click(640, 450);
    (malformed.output[0] as { arguments: string }).arguments = '{"x":"middle"}';
    const cases: [object, RegExp][] = [
      [click(100, 100), /outside the button/],
      [click(640, 450, "type"), /called type, not click/],
      [malformed, /malformed click arguments/],
      [message("I cannot help with that."), /no function call/],
    ];
    for (const [answer, why] of cases) {
      const outcome = await live(world({ answers: { wonder: json(answer) } }).fetchStub).run;
      expect(outcome.code).toBe(1);
      expect(failure(outcome.lines, "Wonder")).toMatch(why);
    }
  });

  it("fails an authentication error and a timeout, naming the call and printing no secret", async () => {
    const denied = await live(
      world({
        answers: {
          "spark-text": () =>
            new Response(JSON.stringify({ error: { code: "invalid_api_key", message: `bad key ${SECRETS.meta}` } }), {
              status: 401,
              headers: { "content-type": "application/json" },
            }),
        },
      }).fetchStub,
    ).run;
    expect(failure(denied.lines, "Spark text")).toMatch(/HTTP 401/);
    expect(denied.lines.join("\n")).not.toContain(SECRETS.meta);
    const { fetchStub } = world();
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(GATEWAY_URL))
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        );
      return fetchStub(input, init);
    }) as typeof fetch;
    const timedOut = await live(slow, { timeoutMs: 200 }).run;
    expect(timedOut.code).toBe(1);
    expect(failure(timedOut.lines, "Spark text")).toBeDefined();
  }, 20_000);

  it("fails a missing gateway log, a stored body, and a token-priced call without a matching cost", async () => {
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const missing = await live(world({ logs: () => json({}, 404) }).fetchStub).run;
    expect(failure(missing.lines, "Spark text")).toMatch(/did not appear/);
    const full = {
      model: "muse-spark-1.3",
      success: true,
      status_code: 200,
      duration: 1,
      tokens_in: 100,
      tokens_out: 10,
      cost: (100 * 1.25 + 10 * 4.25) / 1e6,
    };
    const absent = () => json({ errors: [{ code: 7002 }] }, 404);
    const stored = await live(
      world({ logs: (_id, part) => (part ? json({ result: { body: "the prompt" } }) : json({ result: full })) })
        .fetchStub,
    ).run;
    expect(failure(stored.lines, "Spark text")).toMatch(/stored the request body/);
    const noCost = await live(
      world({ logs: (_id, part) => (part ? absent() : json({ result: { ...full, cost: undefined } })) }).fetchStub,
    ).run;
    expect(failure(noCost.lines, "Spark text")).toMatch(/no gateway cost/);
    const wrongCost = await live(
      world({ logs: (_id, part) => (part ? absent() : json({ result: { ...full, cost: 9 } })) }).fetchStub,
    ).run;
    expect(failure(wrongCost.lines, "Spark text")).toMatch(/does not match/);
  });

  it("certifies no stored body only on Cloudflare's own 'not available' answer (G1)", async () => {
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const full = {
      model: "muse-spark-1.3",
      success: true,
      status_code: 200,
      duration: 1,
      tokens_in: 100,
      tokens_out: 10,
    };
    const cases: [string, () => Response, RegExp][] = [
      ["forbidden", () => json({ errors: [{ code: 10000 }] }, 403), /could not be verified \(HTTP 403\)/],
      ["server error", () => json({}, 500), /could not be verified \(HTTP 500\)/],
      ["a 404 of another kind", () => json({ errors: [{ code: 7001 }] }, 404), /could not be verified \(HTTP 404\)/],
      ["a raw body", () => new Response("the prompt", { status: 200 }), /stored the request body/],
      ["a raw JSON body", () => json({ input: "the prompt" }), /stored the request body/],
    ];
    for (const [label, body, why] of cases) {
      const outcome = await live(world({ logs: (_id, part) => (part ? body() : json({ result: full })) }).fetchStub)
        .run;
      expect(outcome.code, label).toBe(1);
      expect(failure(outcome.lines, "Spark text"), label).toMatch(why);
    }
  });

  it("holds each gateway log to its call: model, success, types and Meta's token counts (G6)", async () => {
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const absent = () => json({ errors: [{ code: 7002 }] }, 404);
    const full = {
      model: "muse-spark-1.3",
      success: true,
      status_code: 200,
      duration: 1,
      tokens_in: 100,
      tokens_out: 10,
    };
    const cases: [string, object, RegExp][] = [
      ["another model", { ...full, model: "muse-wonder-1.0" }, /logged muse-wonder-1\.0, not muse-spark-1\.3/],
      ["a failure", { ...full, success: false, status_code: 502 }, /logged a failure \(HTTP 502\)/],
      ["a string count", { ...full, tokens_in: "100" }, /malformed \(tokens_in\)/],
      ["no outcome", { ...full, success: undefined }, /malformed \(success\)/],
      ["other counts", { ...full, tokens_in: 99 }, /counted 99 in and 10 out; Meta reported 100 and 10/],
    ];
    for (const [label, log, why] of cases) {
      const outcome = await live(world({ logs: (_id, part) => (part ? absent() : json({ result: log })) }).fetchStub)
        .run;
      expect(outcome.code, label).toBe(1);
      expect(failure(outcome.lines, "Spark text"), label).toMatch(why);
    }
  });

  it("ends a SAM stream that starts and then stalls at the deadline (G2)", async () => {
    const { fetchStub } = world();
    const stalls = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (!String(input).startsWith(GATEWAY_URL) || !body.includes('"sam-3.1"')) return fetchStub(input, init);
      const first = new TextEncoder().encode(sse([{ type: "response.output_text.delta", ...lane, delta: "<0f>0" }]));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-sam" } });
    }) as typeof fetch;
    const started = Date.now();
    const outcome = await live(stalls, { timeoutMs: 300 }).run;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(failure(outcome.lines, "SAM 3.1")).toMatch(/no complete answer within 0\.3 s/);
  }, 20_000);

  it("reserves each call before it is sent and settles it after, never counting an unknown cost as zero (G3)", async () => {
    const ledger = join(DIR, "spend.json");
    const seen: { calls: number; reserved: number }[] = [];
    const { fetchStub } = world({
      answers: {
        wonder: () => {
          const entries = JSON.parse(readFileSync(ledger, "utf-8")) as { state: string }[];
          seen.push({ calls: entries.length, reserved: entries.filter((e) => e.state === "reserved").length });
          // Meta reports no usage for this call.
          const { usage: _usage, ...rest } = click(640, 450);
          return new Response(JSON.stringify(rest), { headers: { "content-type": "application/json" } });
        },
      },
    });
    const outcome = await live(fetchStub).run;
    expect(seen).toEqual([{ calls: 4, reserved: 1 }]);
    const entries = JSON.parse(readFileSync(ledger, "utf-8")) as { call: string; state: string; cost: number | null }[];
    expect(entries.map((e) => [e.call, e.state])).toEqual([
      ["Spark text", "settled"],
      ["Spark image", "settled"],
      ["SAM 3.1", "settled"],
      ["Wonder", "uncertain"],
    ]);
    expect(entries[3]?.cost).toBeNull();
    expect(failure(outcome.lines, "Wonder")).toMatch(/Meta reported no usage/);
    // The next run counts the uncertain call at its estimate, not zero.
    const next = await live(world().fetchStub, { dayCap: 0.1 }).run;
    expect(next.code).toBe(2);
    expect(next.lines.at(-1)).toMatch(/spent on smoke runs today/);
  });

  it("keeps the spend when the log read throws, and stops before sending when the ledger cannot be written (G3)", async () => {
    const thrown = await live(
      world({
        logs: () => {
          throw new TypeError("fetch failed");
        },
      }).fetchStub,
    ).run;
    expect(failure(thrown.lines, "Spark text")).toMatch(/gateway log could not be read \(TypeError\)/);
    const entries = JSON.parse(readFileSync(join(DIR, "spend.json"), "utf-8")) as { state: string }[];
    expect(entries.map((e) => e.state)).toEqual(["settled", "settled", "uncertain", "settled"]);
    writeFileSync(join(DIR, "a-file"), "");
    const { fetchStub, sent } = world();
    const blocked = await live(fetchStub, { ledger: join(DIR, "a-file", "spend.json") }).run;
    expect(blocked.code).toBe(2);
    expect(blocked.lines.at(-1)).toMatch(/spend\.json\.lock could not be created \(E[A-Z]+\)/);
    // Admitted, then the disk stops taking the ledger: the run stops before the first call is sent.
    const dir = join(DIR, "ledger");
    mkdirSync(dir);
    try {
      // The shared reservation for the call that was never sent is released (completion review, 2026-10-29).
      const settled: [string, number][] = [];
      const stopped = await live(fetchStub, {
        ledger: join(dir, "spend.json"),
        budget: { ...openBudget(), settle: async (id: string, usd: number) => void settled.push([id, usd]) },
        readSecrets: async () => {
          chmodSync(dir, 0o500);
          return SECRETS;
        },
      }).run;
      expect(stopped.code).toBe(1);
      expect(stopped.lines.at(-1)).toMatch(
        /stopped before Spark text: .*could not be written \(E[A-Z]+\); free space or fix its permissions/,
      );
      expect(settled).toEqual([["held", 0]]);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses an unknown model before anything is read or written, and labels a filtered run as partial (G4)", async () => {
    const { fetchStub, sent } = world();
    const typo = live(fetchStub, { model: "muse-spark-typo" });
    const refused = await typo.run;
    expect(refused.code).toBe(2);
    expect(refused.lines[0]).toMatch(/muse-spark-typo is not one of the models this test calls/);
    expect(typo.secretsRead()).toBe(0);
    expect(existsSync(join(DIR, "report.md"))).toBe(false);
    const dryTypo = await runMetaSmoke({ dry: true, confirmCredit: false, model: "muse-spark-typo", fixtures: fx });
    expect(dryTypo.code).toBe(2);
    const partial = await live(fetchStub, { model: "sam-3.1" }).run;
    expect(partial.code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(partial.lines.at(-1)).toMatch(/1 of 1 calls \(partial: sam-3\.1\)/);
    expect(readFileSync(join(DIR, "report.md"), "utf-8")).toMatch(/Partial coverage: only `sam-3\.1`/);
  });

  it("rejects a contradicting answer, extra tool calls, fractional coordinates and an absent status (G5)", async () => {
    const json = (b: unknown) => () =>
      new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    const contradicted = await live(
      world({ answers: { "spark-text": json(message("The answer is 52, not 51")) } }).fetchStub,
    ).run;
    expect(failure(contradicted.lines, "Spark text")).toMatch(/expected exactly 51/);
    const twice = click(640, 450);
    twice.output.push({ type: "function_call", call_id: "c2", name: "click", arguments: '{"x":1,"y":1}' });
    const fractional = click(640, 450);
    (fractional.output[0] as { arguments: string }).arguments = '{"x":640.5,"y":450}';
    const noStatus: Record<string, unknown> = { ...click(640, 450) };
    delete noStatus.status;
    const cases: [object, RegExp][] = [
      [twice, /2 tool calls; exactly one click is allowed/],
      [fractional, /malformed click arguments/],
      [noStatus, /status is null, not completed/],
    ];
    for (const [answer, why] of cases) {
      const outcome = await live(world({ answers: { wonder: json(answer) } }).fetchStub).run;
      expect(failure(outcome.lines, "Wonder")).toMatch(why);
    }
  });

  it("records the gateway's fields, Meta's usage and a bounded excerpt for every call (G7)", async () => {
    await live(world().fetchStub).run;
    const rows = readFileSync(join(DIR, "report.md"), "utf-8")
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| Call") && !l.startsWith("| ---"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(
      /\| 100 \/ 10 \| 200, success, 100 \/ 10, 900 ms \| US\$0\.000168 \| US\$0\.000168 \| 51 \|/,
    );
    expect(rows[1]).toContain(`| ${fx.code} |`);
    expect(rows[2]).toMatch(/0 \/ 0 \| 200, success, 0 \/ 0, 900 ms .* \| 1 box\(es\), best overlap 0\.\d\d \|/);
    expect(rows[3]).toMatch(/\| click\(640, 450\) \|/);
  });

  it("prices cached input at the gateway's cached rate, as the live gateway did (1652 of 1771 cached)", async () => {
    const json = (b: unknown) => () =>
      new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    const cachedClick = {
      ...click(640, 450),
      usage: { input_tokens: 1771, input_tokens_details: { cached_tokens: 1652 }, output_tokens: 835 },
    };
    const outcome = await live(world({ answers: { wonder: json(cachedClick) } }).fetchStub).run;
    expect(outcome.code).toBe(0);
    const row = readFileSync(join(DIR, "report.md"), "utf-8")
      .split("\n")
      .find((l) => l.startsWith("| Wonder"));
    // The live gateway's own figure for these counts: US$0.0175064.
    expect(row).toMatch(/\| 1771 \(1652 cached\) \/ 835 \| .* \| US\$0\.017506 \| US\$0\.017506 \|/);
  });

  it("tells Wonder the screenshot's size, read from the PNG itself", async () => {
    expect(fx.pageSize).toEqual({ width: 1280, height: 800 });
    const { fetchStub, sent } = world();
    await live(fetchStub, { model: "muse-wonder-1.0" }).run;
    expect(sent).toHaveLength(1);
    const tools = sent[0]?.body.tools as { description: string; parameters: { properties: Record<string, object> } }[];
    const tool = tools[0];
    expect(tool?.description).toContain("1280 by 800 pixels");
    expect(tool?.parameters.properties.x).toMatchObject({ minimum: 0, maximum: 1279 });
    expect(tool?.parameters.properties.y).toMatchObject({ minimum: 0, maximum: 799 });
  });

  it("keeps each finished call on disk while the run goes on, and names an interrupted run next time (E1)", async () => {
    const report = join(DIR, "report.md");
    const midway: string[] = [];
    const { fetchStub } = world({
      answers: {
        wonder: () => {
          midway.push(readFileSync(report, "utf-8"));
          return new Response("{}", { status: 503 });
        },
      },
    });
    await live(fetchStub).run;
    expect(midway[0]).toMatch(/\*\*in progress\*\* \(3 of 4 calls done; if this stays, the run was interrupted\)/);
    expect(midway[0]?.match(/\| passed \|/g)).toHaveLength(3);
    writeFileSync(report, midway[0] ?? "");
    const next = await live(world().fetchStub).run;
    expect(next.lines[0]).toMatch(/the previous run did not finish/);
  });

  it("lets one run at a time spend: a second run is refused, and a dead run's lock is taken over (round 1)", async () => {
    const ledger = join(DIR, "spend.json");
    const { fetchStub, sent } = world();
    const holder = live(fetchStub, { model: "sam-3.1" });
    const second = live(fetchStub, { model: "sam-3.1" });
    const [first, other] = await Promise.all([holder.run, second.run]);
    expect([first.code, other.code].sort()).toEqual([0, 2]);
    expect([...first.lines, ...other.lines].join("\n")).toMatch(/another smoke run \(process \d+\) is running/);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(ledger, "utf-8"))).toHaveLength(1);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
    // A lock left by a process that is gone does not block the next run.
    writeFileSync(`${ledger}.lock`, "999999999");
    expect((await live(fetchStub, { model: "sam-3.1" }).run).code).toBe(0);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
    // A lock is created whole, never empty, and leaves no private file behind.
    const lock = join(DIR, "x.lock");
    const release = takeLock(lock);
    expect(readFileSync(lock, "utf-8")).toBe(String(process.pid));
    expect(existsSync(`${lock}.${process.pid}.tmp`)).toBe(false);
    expect(typeof release).toBe("function");
    expect(takeLock(lock)).toMatch(/is running/);
    (release as () => void)();
    expect(existsSync(lock)).toBe(false);
  });

  it("clears a gone run's lock only under the reclaim guard (round 2)", () => {
    const lock = join(DIR, "y.lock");
    writeFileSync(lock, "999999999");
    // Another run is clearing it right now: this one waits, and the lock is untouched.
    writeFileSync(`${lock}.reclaim`, String(process.pid));
    expect(takeLock(lock)).toMatch(/another smoke run is starting/);
    expect(readFileSync(lock, "utf-8")).toBe("999999999");
    // A guard left by a gone process is named, not silently broken.
    writeFileSync(`${lock}.reclaim`, "999999998");
    expect(takeLock(lock)).toMatch(/y\.lock\.reclaim was left by process 999999998, which is gone; delete it/);
    rmSync(`${lock}.reclaim`);
    // Unguarded, a gone run's lock and a garbled one are each cleared and claimed, and the guard is gone after.
    for (const left of ["999999999", "garbled"]) {
      writeFileSync(lock, left);
      const release = takeLock(lock);
      expect(typeof release, left).toBe("function");
      expect(readFileSync(lock, "utf-8")).toBe(String(process.pid));
      expect(existsSync(`${lock}.reclaim`)).toBe(false);
      (release as () => void)();
    }
  });

  it("compares SAM's token counts with the gateway's too (round 1)", async () => {
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const log = {
      model: "sam-3.1",
      success: true,
      status_code: 200,
      duration: 1,
      tokens_in: 900,
      tokens_out: 800,
      cost: 0,
    };
    const outcome = await live(
      world({ logs: (_id, part) => (part ? json({ errors: [{ code: 7002 }] }, 404) : json({ result: log })) })
        .fetchStub,
      { model: "sam-3.1" },
    ).run;
    expect(failure(outcome.lines, "SAM 3.1")).toMatch(/counted 900 in and 800 out; Meta reported 0 and 0/);
  });

  it("fails a run whose report cannot be saved (round 1)", async () => {
    const report = join(DIR, "locked", "report.md");
    mkdirSync(join(DIR, "locked"));
    const { fetchStub } = world({
      answers: {
        wonder: () => {
          // The disk stops taking the report once the run is under way.
          chmodSync(join(DIR, "locked"), 0o500);
          return new Response(JSON.stringify(click(640, 450)), { headers: { "content-type": "application/json" } });
        },
      },
    });
    try {
      const outcome = await live(fetchStub, { report }).run;
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/the report could not be written .*free space or fix its permissions/);
      expect(outcome.lines.at(-1)).toMatch(/^failed: 4 of 4 calls/);
    } finally {
      chmodSync(join(DIR, "locked"), 0o700);
    }
  });

  it("keeps one Meta ledger outside every checkout, ISITLEGIT_LEDGER_DIR moving it", () => {
    expect(metaLedger({ HOME: "/srv/ada" })).toBe("/srv/ada/isitlegit-data/ledgers/meta-spend.json");
    expect(metaLedger({ HOME: "/srv/ada", ISITLEGIT_LEDGER_DIR: "~/spend" })).toBe("/srv/ada/spend/meta-spend.json");
    expect(metaLedger({ HOME: "/srv/ada", ISITLEGIT_LEDGER_DIR: "/srv/ledgers" })).toBe("/srv/ledgers/meta-spend.json");
    expect(LEGACY_LEDGER.endsWith("build/meta-smoke-spend.json")).toBe(true);
  });

  it("moves a checkout's old ledger into the shared one once, losing and repeating nothing", async () => {
    const shared = join(DIR, "ledgers/meta-spend.json");
    const legacy = join(DIR, "old-spend.json");
    const entry = (run: string, cost: number) => ({
      date: "2026-10-28",
      run,
      call: "Spark text",
      estimate: 0.01,
      cost,
      state: "settled",
    });
    mkdirSync(join(DIR, "ledgers"));
    writeFileSync(shared, JSON.stringify([entry("a", 0.001)]));
    writeFileSync(legacy, JSON.stringify([entry("a", 0.001), entry("b", 0.002)]));
    expect(adoptLegacyLedger(shared, legacy)).toBeNull();
    expect(readLedger(shared).map((e) => e.run)).toEqual(["a", "b"]);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.moved`)).toBe(true);
    expect(adoptLegacyLedger(shared, legacy)).toBeNull();
    expect(readLedger(shared)).toHaveLength(2);
    writeFileSync(legacy, "not json");
    expect(adoptLegacyLedger(shared, legacy)).toMatch(/repair the unreadable one rather than delete it/);
    expect(readLedger(shared)).toHaveLength(2);
    // A run takes the old ledger in before it counts today's spend, and reads no secret past the cap it then meets.
    rmSync(legacy);
    writeFileSync(legacy, JSON.stringify([{ ...entry("c", 1.99), date: "2026-10-27" }]));
    const { fetchStub, sent } = world();
    const day = live(fetchStub, { ledger: shared, legacyLedger: legacy });
    const outcome = await day.run;
    expect(outcome.lines.at(-1)).toMatch(/spent on smoke runs today/);
    expect(day.secretsRead()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(readLedger(shared).map((e) => e.run)).toContain("c");
  });

  it("has a help text and names a safe recovery for each failed stage (E2)", async () => {
    expect(parseMetaArgs(["--help"]).help).toBe(true);
    for (const model of MODELS) expect(USAGE).toContain(model);
    for (const fact of [
      "--confirm-credit",
      "isitlegit-data/ledgers/meta-spend.json",
      "docs/meta-smoke-test.md",
      "Exit codes",
    ])
      expect(USAGE).toContain(fact);
    expect(() => parseMetaArgs(["--nope"])).toThrow();
    const noFixtures = await runMetaSmoke({ dry: true, confirmCredit: false, fixturesDir: join(DIR, "absent") });
    expect(noFixtures.code).toBe(2);
    expect(noFixtures.lines[0]).toMatch(/fixtures .* could not be read .* restore them from git, or regenerate them/);
    writeFileSync(join(DIR, "spend.json"), "not json");
    const broken = await live(world().fetchStub).run;
    expect(broken.code).toBe(2);
    expect(broken.lines.at(-1)).toMatch(/repair it .* rather than delete it/);
    const vault = await live(world().fetchStub, {
      ledger: join(DIR, "fresh.json"),
      readSecrets: async () => {
        throw new Error('reading "IsItLegit Meta Model API" from Conclave failed; check the item exists');
      },
    }).run;
    expect(vault.code).toBe(2);
    expect(vault.lines.at(-1)).toMatch(/from Conclave failed; check the item exists/);
  });

  it("refuses an over-cap run and an exhausted day before reading secrets or sending anything", async () => {
    const { fetchStub, sent } = world();
    const over = live(fetchStub, { runCap: 0.01 });
    expect((await over.run).lines.at(-1)).toMatch(/over the US\$0\.01 cap/);
    expect(over.secretsRead()).toBe(0);
    // An entry from before reservations: a cost and no state.
    writeFileSync(join(DIR, "spend.json"), JSON.stringify([{ date: "2026-10-27", estimate: 1, cost: 1.99 }]));
    const day = live(fetchStub);
    const outcome = await day.run;
    expect(outcome.code).toBe(2);
    expect(outcome.lines.at(-1)).toMatch(/US\$1\.9900 spent on smoke runs today/);
    expect(day.secretsRead()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(existsSync(join(DIR, "report.md"))).toBe(false);
  });
});

describe("the shared budget (D03 T01 §2)", () => {
  it("refuses a paid run with no budget, sending nothing", async () => {
    const sent: string[] = [];
    const counting = (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const fx = loadFixtures();
    const none = await runMetaSmoke({ dry: false, confirmCredit: true, fixtures: fx, fetch: counting });
    expect(none.code).toBe(2);
    expect(none.lines.join("\n")).toMatch(/no Meta budget was given/);
    expect(sent).toEqual([]);
  });
});

describe("the smoke test's call record (D03 T01 §3)", () => {
  it("reserves with its call and owner, and settles each call with its record", async () => {
    const reserved: unknown[] = [];
    const settled: unknown[] = [];
    const budget = {
      reserve: async (...args: unknown[]) => {
        reserved.push(args[4]);
        return "held";
      },
      settle: async (_id: string, _usd: number, record?: unknown) => void settled.push(record),
      uncertain: async (_id: string, record?: unknown) => void settled.push(record),
    };
    const { fetchStub } = world();
    await live(fetchStub, { budget }).run;
    expect(reserved.length).toBeGreaterThan(0);
    expect(reserved[0]).toMatchObject({ owner: { kind: "script", name: "meta-smoke" } });
    expect(settled.length).toBe(reserved.length);
    for (const record of settled)
      expect(record).toMatchObject({ outcome: expect.any(String), certainty: expect.any(String) });
  });
});

describe("round 1: the smoke test's calls carry the record every caller writes", () => {
  it("settles a refused call at nothing with its kind and ids, and tags every request with its owner", async () => {
    const settled: { usd: number | null; record: Record<string, unknown> }[] = [];
    const budget = {
      reserve: async () => "held",
      settle: async (_id: string, usd: number, record?: unknown) =>
        void settled.push({ usd, record: record as Record<string, unknown> }),
      uncertain: async (_id: string, record?: unknown) =>
        void settled.push({ usd: null, record: record as Record<string, unknown> }),
    };
    const limited = () =>
      new Response(JSON.stringify({ error: { type: "rate_limit_error", code: null, param: null, message: "slow" } }), {
        status: 429,
        headers: { "content-type": "application/json", "x-request-id": "req-limited" },
      });
    const { fetchStub, sent } = world({ answers: { "spark-text": limited } });
    await live(fetchStub, { budget }).run;
    expect(settled[0]).toEqual({
      usd: 0,
      record: expect.objectContaining({
        outcome: "refused",
        certainty: "none",
        errorClass: "rate-limit",
        logId: "log-1",
        requestId: "req-limited",
      }),
    });
    expect(settled.slice(1).every((s) => s.record.outcome === "ok")).toBe(true);
    for (const request of sent)
      expect(JSON.parse(request.headers.get("cf-aig-metadata") ?? "{}")).toEqual({ script: "meta-smoke" });
  });
});
