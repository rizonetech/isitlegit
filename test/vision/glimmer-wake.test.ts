import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  allowanceMinutes,
  DEPLOYED_MODEL,
  MAX_WARMUP_SECONDS,
  TAIL_MINUTES,
  totalLimitMinutes,
  WARMUP_MARGIN_SECONDS,
} from "../../src/vision/glimmer-caps";
import { d1Exec, dayMinutes, findBurst, reserveBurst } from "../../src/vision/glimmer-minutes";
import {
  type Burst,
  FIRST_BACKOFF_MS,
  isCompletion,
  MAX_BACKOFF_MS,
  type Outcome,
  settleGlimmer,
  untilWarm,
  WARMUP_LIMIT_MS,
  type WakeCtx,
  wakeGlimmer,
} from "../../src/vision/glimmer-wake";
import { stubSmtp2go } from "../auth/helpers";

// Waking Loupe's deployment (D03 T04 §15) on the real ledger (§14) and the real mail sender, with Fireworks stood in.
const db = (env as unknown as Env).DB;
const ledger = d1Exec(db);
const ENV = {
  FIREWORKS_API_KEY: "fw-key",
  GLIMMER_GATEWAY_URL: "https://gateway.test/v1/acct/isitlegit/custom-fireworks/v1",
  CF_AIG_TOKEN: "aig-token",
  SMTP2GO_API_KEY: `api-${"k".repeat(32)}`,
  OPERATOR_EMAIL: "hostmaster@rizonetech.com",
};
const SCALING = JSON.stringify({ error: { code: "DEPLOYMENT_SCALING_UP", message: "scaling up" } });
const COMPLETION = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "p" } }] });

beforeEach(async () => {
  await db.prepare("DELETE FROM glimmer_runtime").run();
  await db.prepare("DELETE FROM mail_sends WHERE send_key LIKE 'glimmer-deployment-missing:%'").run();
});

// A stand-in Fireworks answering from a script (one status a request; the last repeats), on a fake clock that each
// request advances by 500 ms and each sleep by its length.
function world(answers: (number | "hang")[], start = Date.parse("2026-11-01T08:00:00Z")) {
  let t = start;
  const requests: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const pending: Promise<unknown>[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    t += 500;
    const status = answers.length > 1 ? answers.shift() : answers[0];
    if (status === "hang")
      return new Promise<Response>((_d, fail) =>
        init.signal?.addEventListener("abort", () => fail(init.signal?.reason)),
      );
    const body = status === 200 ? COMPLETION : status === 503 ? SCALING : "{}";
    return new Response(body, { status: status as number });
  }) as unknown as typeof fetch;
  const ctx = (over: Partial<WakeCtx> = {}): WakeCtx => ({
    env: ENV,
    ledger,
    burstId: "monitor-run-1",
    calls: 10,
    callSeconds: 6,
    fetcher,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    mail: { db, apiKey: ENV.SMTP2GO_API_KEY, operator: ENV.OPERATOR_EMAIL },
    waitUntil: (promise) => pending.push(promise),
    ...over,
  });
  return {
    ctx,
    requests,
    sleeps,
    now: () => t,
    advance: (ms: number) => (t += ms),
    delivered: () => Promise.all(pending),
  };
}

describe("wakeGlimmer", () => {
  it("sends nothing when the day's minutes are spent", async () => {
    const earlier = await reserveBurst(ledger, {
      id: "earlier",
      at: new Date("2026-11-01T07:00:00Z"),
      source: "local",
      caller: "t",
      purpose: "warm-up",
      minutes: Math.min(allowanceMinutes("2026-11-01"), totalLimitMinutes()),
    });
    expect(earlier.ok).toBe(true);
    const w = world([503]);
    expect(await wakeGlimmer(w.ctx())).toMatchObject({ outcome: "refused" });
    expect(w.requests).toHaveLength(0);
  });

  it("reserves the whole retry window, sends one request and returns before the warm-up ends", async () => {
    const w = world([503]);
    const woken = await wakeGlimmer(w.ctx());
    expect(woken).toMatchObject({ outcome: "woken", reused: false, first: null });
    expect(w.requests).toHaveLength(1);
    if (woken.outcome !== "woken") throw new Error("not woken");
    expect(woken.burst.deadline - woken.burst.wakeAt).toBe((MAX_WARMUP_SECONDS + WARMUP_MARGIN_SECONDS) * 1000);
    // Warm-up, its margin, ten 6-second calls and the tail.
    expect(await dayMinutes(ledger, "2026-11-01")).toBeCloseTo(
      (MAX_WARMUP_SECONDS + WARMUP_MARGIN_SECONDS) / 60 + 1 + TAIL_MINUTES,
      9,
    );
  });

  it("finds the same burst and its first deadline when the step runs again, and sends nothing", async () => {
    const w = world([503]);
    const first = await wakeGlimmer(w.ctx());
    w.advance(90_000);
    const again = await wakeGlimmer(w.ctx());
    expect(again).toMatchObject({ outcome: "woken", reused: true });
    if (first.outcome !== "woken" || again.outcome !== "woken") throw new Error("not woken");
    expect(again.burst.deadline).toBe(first.burst.deadline);
    expect(w.requests).toHaveLength(1);
  });

  it("carries the gateway's metadata-only log headers and the model on every request", async () => {
    const w = world([503, 503, 200]);
    const woken = await wakeGlimmer(w.ctx());
    if (woken.outcome !== "woken") throw new Error("not woken");
    await untilWarm(w.ctx(), woken.burst);
    expect(w.requests.length).toBe(3);
    for (const { url, init } of w.requests) {
      expect(url).toBe(`${ENV.GLIMMER_GATEWAY_URL}/chat/completions`);
      const headers = init.headers as Record<string, string>;
      expect(headers["cf-aig-collect-log-payload"]).toBe("false");
      expect(headers["cf-aig-authorization"]).toBe("Bearer aig-token");
      expect(headers.Authorization).toBe("Bearer fw-key");
      expect(JSON.parse(String(init.body))).toMatchObject({ model: DEPLOYED_MODEL, max_tokens: 1 });
    }
  });

  it("sends nothing and says what is missing when the transport is not configured", async () => {
    const w = world([200]);
    expect(await wakeGlimmer(w.ctx({ env: { ...ENV, GLIMMER_GATEWAY_URL: "" } }))).toEqual({
      outcome: "not_configured",
      missing: ["GLIMMER_GATEWAY_URL"],
    });
    expect(await wakeGlimmer(w.ctx({ env: { CF_AIG_TOKEN: "x" } }))).toMatchObject({
      missing: ["FIREWORKS_API_KEY", "GLIMMER_GATEWAY_URL"],
    });
    expect(w.requests).toHaveLength(0);
  });
});

describe("untilWarm", () => {
  it("retries a cold start with backoff 5 s doubling to 30 s and answers ready when the warm-up ends in time", async () => {
    const w = world([503, 503, 503, 503, 503, 429, 502, 200]);
    const woken = await wakeGlimmer(w.ctx());
    if (woken.outcome !== "woken") throw new Error("not woken");
    expect(await untilWarm(w.ctx(), woken.burst)).toEqual({ outcome: "ready", attempts: 7 });
    expect(w.sleeps).toEqual([FIRST_BACKOFF_MS, 10_000, 20_000, MAX_BACKOFF_MS, 30_000, 30_000]);
  });

  it("answers warming at the deadline when the warm-up runs over, and at once with no request after it", async () => {
    const w = world([503]);
    const woken = await wakeGlimmer(w.ctx());
    if (woken.outcome !== "woken") throw new Error("not woken");
    const over = await untilWarm(w.ctx(), woken.burst);
    expect(over.outcome).toBe("warming");
    expect(w.now()).toBeGreaterThanOrEqual(woken.burst.deadline);
    // No sleep runs past the deadline: the clock stops within one request of it.
    expect(w.now() - woken.burst.deadline).toBeLessThanOrEqual(500);
    expect(woken.burst.deadline - woken.burst.wakeAt).toBe(WARMUP_LIMIT_MS);
    const sent = w.requests.length;
    // Settled at the deadline, the burst is closed: a later wait sends nothing.
    expect(await untilWarm(w.ctx(), woken.burst)).toMatchObject({ outcome: "burst_closed" });
    expect(w.requests.length).toBe(sent);
  });

  it("takes only a completion as ready: an empty 200 is a bad answer, and a 401 is final", async () => {
    for (const [answers, outcome] of [
      [[503, 200], "ready"],
      [[503, 401], "unauthorized"],
      [[503, 403], "unauthorized"],
    ] as const) {
      await db.prepare("DELETE FROM glimmer_runtime").run();
      const w = world([...answers]);
      const woken = await wakeGlimmer(w.ctx());
      if (woken.outcome !== "woken") throw new Error("not woken");
      expect((await untilWarm(w.ctx(), woken.burst)).outcome).toBe(outcome);
    }
    await db.prepare("DELETE FROM glimmer_runtime").run();
    const empty = world([503]);
    const woken = await wakeGlimmer(empty.ctx());
    if (woken.outcome !== "woken") throw new Error("not woken");
    const ctx = empty.ctx({ fetcher: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch });
    expect(await untilWarm(ctx, woken.burst)).toMatchObject({ outcome: "bad_answer", status: 200, settled: true });
    // A final answer settles the burst.
    expect((await findBurst(ledger, "monitor-run-1"))?.settled).toBe(true);
  });

  it("cuts a hanging request at the burst's deadline", async () => {
    const w = world(["hang"]);
    const started = Date.now();
    const ctx = w.ctx({ now: () => Date.now(), sleep: async () => {} });
    const burst = { id: "monitor-run-1", wakeAt: Date.now(), deadline: Date.now() + 200 };
    expect((await untilWarm(ctx, burst)).outcome).toBe("warming");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("a missing deployment", () => {
  it("answers deployment_missing and sends the operator one notice across two calls, naming the command", async () => {
    const smtp = stubSmtp2go();
    try {
      const w = world([404]);
      expect(await wakeGlimmer(w.ctx())).toMatchObject({ outcome: "deployment_missing" });
      expect(await wakeGlimmer(w.ctx({ burstId: "monitor-run-2" }))).toMatchObject({ outcome: "deployment_missing" });
      await w.delivered();
      expect(smtp.sends).toHaveLength(1);
      expect(smtp.sends[0]?.subject).toBe("IsItLegit: Loupe's deployment isitlegit-loupe is missing");
      expect(smtp.sends[0]?.text).toContain("node scripts/glimmer/deploy.ts ensure 1.0");
    } finally {
      smtp.restore();
    }
  });

  it("leaves a notice whose send failed to the next miss", async () => {
    let answer: "refused" | "sent" = "refused";
    const smtp = stubSmtp2go(() => answer);
    try {
      const w = world([404]);
      await wakeGlimmer(w.ctx());
      await w.delivered();
      expect(smtp.sends).toHaveLength(0);
      answer = "sent";
      await wakeGlimmer(w.ctx({ burstId: "monitor-run-2" }));
      await w.delivered();
      expect(smtp.sends).toHaveLength(1);
    } finally {
      smtp.restore();
    }
  });

  // Completion review gap 3: the answer never waits for the mail.
  it("answers deployment_missing at once while a slow notice is still being sent", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((done) => {
      release = done;
    });
    const smtp = stubSmtp2go();
    try {
      const w = world([404]);
      const mail = {
        db,
        apiKey: ENV.SMTP2GO_API_KEY,
        operator: ENV.OPERATOR_EMAIL,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          await slow;
          return fetch(input, init);
        }) as typeof fetch,
      };
      const answer = await wakeGlimmer(w.ctx({ mail }));
      expect(answer).toMatchObject({ outcome: "deployment_missing", notice: "queued" });
      expect(smtp.sends).toHaveLength(0);
      release();
      await w.delivered();
      expect(smtp.sends).toHaveLength(1);
    } finally {
      smtp.restore();
    }
  });
});

describe("completion review gaps", () => {
  it("sends nothing for a burst already settled, even when the step runs again after its deadline", async () => {
    const w = world([503]);
    const woken = await wakeGlimmer(w.ctx());
    if (woken.outcome !== "woken") throw new Error("not woken");
    await untilWarm(w.ctx(), woken.burst);
    const sent = w.requests.length;
    w.advance(24 * 3_600_000);
    expect(await wakeGlimmer(w.ctx())).toMatchObject({ outcome: "burst_closed" });
    expect(w.requests.length).toBe(sent);
  });

  it("settles the burst when the warm-up runs past its deadline, and reports a settlement that failed", async () => {
    const w = world([503]);
    const woken = await wakeGlimmer(w.ctx());
    if (woken.outcome !== "woken") throw new Error("not woken");
    expect(await untilWarm(w.ctx(), woken.burst)).toMatchObject({ outcome: "warming", settled: true });
    expect((await findBurst(ledger, "monitor-run-1"))?.settled).toBe(true);
    await db.prepare("DELETE FROM glimmer_runtime").run();
    const v = world([503]);
    const again = await wakeGlimmer(v.ctx());
    if (again.outcome !== "woken") throw new Error("not woken");
    const failing = v.ctx({
      ledger: async (statement) => {
        if (statement.sql.includes("ON CONFLICT")) throw new Error("D1 unavailable");
        return ledger(statement);
      },
    });
    expect(await untilWarm(failing, again.burst)).toMatchObject({ outcome: "warming", settled: false });
  });

  it("takes only an assistant message as a completion", () => {
    for (const body of [
      '{"choices":[{"message":{}}]}',
      '{"choices":[{"message":[]}]}',
      '{"choices":[]}',
      '{"choices":[{"message":{"role":"user","content":"p"}}]}',
      "not json",
    ])
      expect(isCompletion(body), body).toBe(false);
    expect(isCompletion('{"choices":[{"message":{"role":"assistant","content":"p"}}]}')).toBe(true);
    expect(isCompletion('{"choices":[{"message":{"role":"assistant","content":null}}]}')).toBe(true);
  });

  // Round 1, finding 1: a replayed wait on a settled burst sends nothing.
  it("answers burst_closed to a replayed wait after a final answer settled the burst", async () => {
    const w = world([503, 401, 200]);
    const woken = await wakeGlimmer(w.ctx());
    if (woken.outcome !== "woken") throw new Error("not woken");
    expect(await untilWarm(w.ctx(), woken.burst)).toMatchObject({ outcome: "unauthorized", settled: true });
    const sent = w.requests.length;
    expect(await untilWarm(w.ctx(), woken.burst)).toMatchObject({ outcome: "burst_closed" });
    expect(w.requests.length).toBe(sent);
  });

  // Round 1, finding 2: a final answer says when its settlement did not land.
  it("reports a failed settlement on a final answer", async () => {
    const w = world([503, 401]);
    const woken = await wakeGlimmer(w.ctx());
    if (woken.outcome !== "woken") throw new Error("not woken");
    const failing = w.ctx({
      ledger: async (statement) => {
        if (statement.sql.includes("ON CONFLICT")) throw new Error("D1 unavailable");
        return ledger(statement);
      },
    });
    expect(await untilWarm(failing, woken.burst)).toMatchObject({ outcome: "unauthorized", settled: false });
  });

  // D03 T04 §40: a caller whose settlement failed needs the burst and the cutoff to settle it again, however late.
  const DAY = 24 * 3_600_000;
  const emptyOk = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  // The context a flow runs in: its ledger fails the settlement when asked, and its fetcher answers an empty 200 for a bad answer.
  const contextFor = (w: ReturnType<typeof world>, failing: boolean, bad: boolean): WakeCtx =>
    w.ctx({
      ...(bad ? { fetcher: emptyOk } : {}),
      ...(failing
        ? {
            ledger: async (statement) => {
              if (statement.sql.includes("ON CONFLICT")) throw new Error("D1 unavailable");
              return ledger(statement);
            },
          }
        : {}),
    });

  // Every outcome that settles its own burst, by each path that reaches it.
  type Flow = "first" | "waiting" | "deadline";
  const cases: { name: string; answers: number[]; flow: Flow; bad?: boolean }[] = [
    { name: "unauthorized on the first request", answers: [401], flow: "first" },
    { name: "deployment_missing on the first request", answers: [404], flow: "first" },
    { name: "bad_answer on the first request", answers: [200], flow: "first", bad: true },
    { name: "unauthorized while waiting", answers: [503, 401], flow: "waiting" },
    { name: "deployment_missing while waiting", answers: [503, 404], flow: "waiting" },
    { name: "bad_answer while waiting", answers: [503], flow: "waiting", bad: true },
    { name: "warming past the deadline", answers: [503], flow: "deadline" },
  ];
  const run = async (c: (typeof cases)[number], w: ReturnType<typeof world>, failing: boolean) => {
    if (c.flow === "first") return wakeGlimmer(contextFor(w, failing, c.bad === true));
    const woken = await wakeGlimmer(w.ctx());
    if (woken.outcome !== "woken") throw new Error("not woken");
    return untilWarm(contextFor(w, failing, c.bad === true), woken.burst);
  };

  for (const c of cases) {
    it(`returns the burst and its cutoff after ${c.name}, settled or not, and a retry a day later charges the same minutes`, async () => {
      const smtp = stubSmtp2go();
      try {
        const w = world([...c.answers]);
        // The settlement succeeds: the burst and cutoff are there too, and the charge is the cutoff plus the tail.
        const ok = (await run(c, w, false)) as Outcome & { burst?: Burst; settleUntil?: number };
        expect(ok).toMatchObject({ settled: true, burst: { id: "monitor-run-1" }, settleUntil: expect.any(Number) });
        const charged = await dayMinutes(ledger, "2026-11-01");
        const wakeAt = (ok.burst as Burst).wakeAt;
        expect(charged).toBeCloseTo(((ok.settleUntil as number) - wakeAt) / 60_000 + TAIL_MINUTES, 6);
        // The same, with the settlement failing: only the reserve is held, and the burst comes back.
        await ledger({ sql: "DELETE FROM glimmer_runtime", params: [] });
        const w2 = world([...c.answers]);
        const failed = (await run(c, w2, true)) as Outcome & { burst?: Burst; settleUntil?: number };
        expect(failed).toMatchObject({
          settled: false,
          burst: { id: "monitor-run-1" },
          settleUntil: expect.any(Number),
        });
        expect((await findBurst(ledger, "monitor-run-1"))?.settled).toBe(false);
        // A day later the retry charges to the cutoff, exactly what the settlement on time charged, never the idle day.
        w2.advance(DAY);
        const retried = await settleGlimmer(w2.ctx(), failed.burst as Burst, failed.settleUntil);
        expect(retried.ok).toBe(true);
        expect((await findBurst(ledger, "monitor-run-1"))?.settled).toBe(true);
        expect(await dayMinutes(ledger, "2026-11-01")).toBeCloseTo(charged, 6);
      } finally {
        smtp.restore();
      }
    });
  }

  // Round 2: a wait resumed a day later is charged to the deadline, not to the day it was idle.
  it("settles a wait resumed long after its deadline to the deadline", async () => {
    const w = world([503]);
    const woken = await wakeGlimmer(w.ctx());
    if (woken.outcome !== "woken") throw new Error("not woken");
    w.advance(24 * 3_600_000);
    expect(await untilWarm(w.ctx(), woken.burst)).toMatchObject({ outcome: "warming", attempts: 0, settled: true });
    const charged = (woken.burst.deadline - woken.burst.wakeAt) / 60_000 + TAIL_MINUTES;
    expect(await dayMinutes(ledger, "2026-11-01")).toBeCloseTo(charged, 6);
  });
});
