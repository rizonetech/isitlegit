import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GATEWAY_URL, LOGS_URL, loadFixtures, type RunOptions, runMetaSmoke } from "../../scripts/meta-smoke.ts";

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
    ...(complete ? [{ type: "response.completed", response: { id: "r", status: "completed" } }] : []),
  ]);
const message = (text: string, usage = { input_tokens: 100, output_tokens: 10 }, status = "completed") => ({
  id: "resp",
  object: "response",
  status,
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  output_text: text,
  usage,
});
const click = (x: number, y: number, extra: object = {}) => ({
  id: "resp",
  object: "response",
  status: "completed",
  output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", button: "left", x, y }], ...extra }],
  usage: { input_tokens: 2000, output_tokens: 50 },
});
const price = { "muse-spark-1.3": [1.25, 4.25], "muse-wonder-1.0": [4, 20] } as const;

type Stub = {
  answers?: Partial<Record<string, () => Response>>; // by call: spark-text, spark-image, sam, wonder
  logs?: (id: string, part?: string) => Response;
};
function world(stub: Stub = {}) {
  const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const usageOf: Record<string, { model: string; input: number; output: number }> = {};
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.startsWith(LOGS_URL)) {
      const [id, part] = url.slice(LOGS_URL.length + 1).split("/") as [string, string | undefined];
      if (stub.logs) return stub.logs(id, part);
      if (part) return json({ success: false }, 404);
      const u = usageOf[id];
      if (!u) return json({ success: false }, 404);
      const [pin, pout] = u.model === "sam-3.1" ? [0, 0] : (price[u.model as keyof typeof price] ?? [0, 0]);
      const cost = u.model === "sam-3.1" ? undefined : (u.input * pin + u.output * pout) / 1e6;
      return json({ result: { id, model: u.model, duration: 900, tokens_in: u.input, tokens_out: u.output, cost } });
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
    const usage = { input: 0, output: 0 };
    if (key !== "sam") {
      try {
        const peek = JSON.parse(replyText);
        usage.input = peek.usage?.input_tokens ?? 0;
        usage.output = peek.usage?.output_tokens ?? 0;
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
    expect(failure(wrong.lines, "Spark image")).toMatch(/did not read the fixture's code/);
    const cut = await live(
      world({ answers: { "spark-text": () => json(message("51", undefined, "incomplete")) } }).fetchStub,
    ).run;
    expect(failure(cut.lines, "Spark text")).toMatch(/ended incomplete, not completed/);
  });

  it("tells SAM's outcomes apart: no logo, a box elsewhere, malformed text, a stream cut off", async () => {
    const stream = (body: string) => () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    const cases: [string, string, RegExp][] = [
      ["none", samStream(""), /no logo found/],
      ["elsewhere", samStream(samRecord("x1=10;y1=10;x2=60;y2=60")), /none over the logo/],
      ["malformed", samStream("<0f>0<|box;oops|>\n"), /could not be read|no logo found/],
      ["cut", samStream(samRecord(), false), /not completed|could not be read/],
    ];
    for (const [label, body, why] of cases) {
      const outcome = await live(world({ answers: { sam: stream(body) } }).fetchStub).run;
      expect(outcome.code, label).toBe(1);
      expect(failure(outcome.lines, "SAM 3.1"), label).toMatch(why);
    }
  });

  it("fails Wonder for a click outside the button, a typed action, a refusal and a pending safety check", async () => {
    const json = (b: unknown) => () =>
      new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    const typed = click(640, 450);
    (typed.output[0] as { actions: object[] }).actions = [{ type: "type", text: "Continue" }];
    const cases: [object, RegExp][] = [
      [click(100, 100), /outside the button/],
      [typed, /was type, not a click/],
      [message("I cannot help with that."), /no computer_call/],
      [click(640, 450, { pending_safety_checks: [{ id: "s1", code: "malicious_instructions" }] }), /safety check/],
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
    const full = { model: "m", duration: 1, tokens_in: 100, tokens_out: 10, cost: (100 * 1.25 + 10 * 4.25) / 1e6 };
    const stored = await live(
      world({ logs: (_id, part) => (part ? json({ result: { body: "the prompt" } }) : json({ result: full })) })
        .fetchStub,
    ).run;
    expect(failure(stored.lines, "Spark text")).toMatch(/stored the request body/);
    const noCost = await live(
      world({ logs: (_id, part) => (part ? json({}, 404) : json({ result: { ...full, cost: undefined } })) }).fetchStub,
    ).run;
    expect(failure(noCost.lines, "Spark text")).toMatch(/no gateway cost/);
    const wrongCost = await live(
      world({ logs: (_id, part) => (part ? json({}, 404) : json({ result: { ...full, cost: 9 } })) }).fetchStub,
    ).run;
    expect(failure(wrongCost.lines, "Spark text")).toMatch(/does not match/);
  });

  it("refuses an over-cap run and an exhausted day before reading secrets or sending anything", async () => {
    const { fetchStub, sent } = world();
    const over = live(fetchStub, { runCap: 0.01 });
    expect((await over.run).lines.at(-1)).toMatch(/over the US\$0\.01 cap/);
    expect(over.secretsRead()).toBe(0);
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
