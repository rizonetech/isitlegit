import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkInferenceKey,
  checkReadBack,
  createBody,
  type Deployment,
  errorCode,
  evalDeployment,
  importWakes,
  isCompletion,
  measureWarmup,
  minutesByDay,
  openDeployments,
  parseCommand,
  REQUEST_MS,
  reserveWake,
  settleWake,
  updateBody,
  warmupSummary,
} from "../../scripts/glimmer/deploy.ts";
import { type Exec, reserveBurst } from "../../src/vision/glimmer-minutes.ts";

// The runtime ledger (D03 T04 §14) as an in-memory SQLite database with migration 0056 applied: the same statements the
// Worker binds on D1 and the scripts send through wrangler.
type LedgerRow = {
  day: string;
  purpose: string;
  reserved_minutes: number;
  used_minutes: number | null;
  source: string;
};
function memoryLedger(): { exec: Exec; rows: () => LedgerRow[] } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "../../src/db/migrations/0056_glimmer_runtime.sql"), "utf-8"));
  const exec: Exec = async ({ sql, params }) => {
    const statement = db.prepare(sql);
    if (/^\s*SELECT/i.test(sql)) return { rows: statement.all(...params) as Record<string, unknown>[], changes: 0 };
    return { rows: [], changes: Number(statement.run(...params).changes) };
  };
  const rows = () =>
    db
      .prepare("SELECT day, purpose, reserved_minutes, used_minutes, source FROM glimmer_runtime ORDER BY wake_at, day")
      .all() as LedgerRow[];
  return { exec, rows };
}

// scripts/glimmer/deploy.ts (D03 T04 §12): one deployment, created once, scaled to zero after 5 minutes; every update
// carries only the fields its mask names, and a wrong read-back fails the command.
function fakeFireworks(start: Deployment | null, readBack?: (d: Deployment) => Deployment) {
  let current = start;
  let draining = false;
  let drained = 0;
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), url, body });
    if (init.method === "GET" && draining && current && drained++ >= 1) current = { ...current, replicaCount: 0 };
    if (init.method === "GET")
      return current
        ? new Response(JSON.stringify(readBack ? readBack(current) : current), { status: 200 })
        : new Response("{}", { status: 404 });
    if (init.method === "POST") current = { ...body, name: "accounts/rizonetech/deployments/isitlegit-loupe" };
    if (init.method === "PATCH") {
      current = { ...current, ...body };
      // A maximum of 0 drains the replicas: the read after the change still shows them, the next shows none.
      if (body.maxReplicaCount === 0 && current) draining = true;
    }
    if (init.method === "DELETE") {
      const had = current;
      current = null;
      return had ? new Response("{}", { status: 200 }) : new Response("{}", { status: 404 });
    }
    return new Response(JSON.stringify(current), { status: 200 });
  };
  return { fetcher, calls };
}

describe("ensure", () => {
  it("creates the live-merge deployment once and finds it the second time", async () => {
    const { fetcher, calls } = fakeFireworks(null);
    const deployments = openDeployments("key", fetcher);
    expect((await deployments.ensure("1.0")).created).toBe(true);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      baseModel: "accounts/rizonetech/models/isitlegit-loupe-1-0",
      deploymentShape: "default",
      minReplicaCount: 0,
      maxReplicaCount: 1,
      autoscalingPolicy: { scaleToZeroWindow: "300s" },
    });
    expect(calls.find((c) => c.method === "POST")?.url).toMatch(/deployments\?deploymentId=isitlegit-loupe$/);
    expect((await deployments.ensure("1.0")).created).toBe(false);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("refuses to treat a deployment of another version as this one", async () => {
    const { fetcher } = fakeFireworks({ ...createBody("1.0") });
    await expect(openDeployments("key", fetcher).ensure("1.1")).rejects.toThrow(/serves .*1-0/);
  });

  // §12 plan review gap 1: an existing deployment is accepted only as the contract has it, never repaired.
  it("refuses an existing deployment with drifted limits, no model, or a deleted or failed state", async () => {
    const at = (d: Deployment) => openDeployments("key", fakeFireworks(d).fetcher).ensure("1.0");
    await expect(at({ ...createBody("1.0"), maxReplicaCount: 2 })).rejects.toThrow(/maximum 2, not 1/);
    const { baseModel: _gone, ...noModel } = createBody("1.0");
    await expect(at(noModel)).rejects.toThrow(/reads back no model/);
    for (const state of ["DELETED", "DELETING", "FAILED"])
      await expect(at({ ...createBody("1.0"), state })).rejects.toThrow(new RegExp(`is ${state}`));
    // Stopped (maximum 0) is the contract too.
    expect((await at({ ...createBody("1.0"), maxReplicaCount: 0 })).created).toBe(false);
  });
});

describe("updates", () => {
  it("refuse a request with no mask, and send only the masked fields", () => {
    expect(() => updateBody([], { maxReplicaCount: 1 })).toThrow(/explicit mask/);
    expect(updateBody(["maxReplicaCount"], { maxReplicaCount: 1, minReplicaCount: 3 })).toEqual({ maxReplicaCount: 1 });
    expect(() => updateBody(["minReplicaCount"], {})).toThrow(/no value/);
  });

  it("stop, start and status send and read what they say", async () => {
    const { fetcher, calls } = fakeFireworks({ ...createBody("1.0"), replicaCount: 1 });
    const deployments = openDeployments("key", fetcher);
    expect(await deployments.stop(60_000, 1, async () => {})).toMatchObject({
      minReplicaCount: 0,
      maxReplicaCount: 0,
      replicaCount: 0,
    });
    expect(calls.filter((c) => c.method === "PATCH").at(-1)).toMatchObject({
      body: { minReplicaCount: 0, maxReplicaCount: 0 },
    });
    expect(await deployments.start()).toMatchObject({ maxReplicaCount: 1 });
    expect(calls.at(-2)).toMatchObject({ method: "PATCH", body: { maxReplicaCount: 1 } });
    expect((await deployments.status())?.maxReplicaCount).toBe(1);
  });

  // §12 plan review gap 2: maximum 0 accepted is not replicas at 0.
  it("stop waits until the replicas read 0, and fails by name when they do not", async () => {
    const stuck = async (_url: string, init: RequestInit) =>
      new Response(
        JSON.stringify({
          ...createBody("1.0"),
          ...(init.method === "PATCH" ? {} : { minReplicaCount: 0, maxReplicaCount: 0 }),
          replicaCount: 1,
        }),
        { status: 200 },
      );
    let clock = 0;
    await expect(
      openDeployments("key", stuck).stop(
        60_000,
        15_000,
        async (ms) => {
          clock += ms;
        },
        () => clock,
      ),
    ).rejects.toThrow(/maximum 0 but still runs 1 replicas after 1 minutes/);
  });

  // §12 round 2: a start from elsewhere while the replicas drain fails the stop, never passes for it.
  it("stop fails when a read during the drain no longer shows the stop", async () => {
    let reads = 0;
    const restarted = async (_url: string, init: RequestInit) => {
      if (init.method === "PATCH") return new Response("{}", { status: 200 });
      reads++;
      // The read after the change shows the stop with a replica draining; the next shows maximum 1 again.
      const body = reads === 1 ? { maxReplicaCount: 0, replicaCount: 1 } : { maxReplicaCount: 1, replicaCount: 0 };
      return new Response(JSON.stringify({ ...createBody("1.0"), ...body }), { status: 200 });
    };
    await expect(
      openDeployments("key", restarted).stop(
        60_000,
        1,
        async () => {},
        Date.now,
        () => {},
      ),
    ).rejects.toThrow(/maximum 1, not 0/);
  });

  it("fail when the read-back does not show the settings asked for", async () => {
    const { fetcher } = fakeFireworks({ ...createBody("1.0") }, (d) => ({
      ...d,
      autoscalingPolicy: { scaleToZeroWindow: "3600s" },
    }));
    await expect(openDeployments("key", fetcher).start()).rejects.toThrow(/scale-to-zero 3600s/);
    expect(() =>
      checkReadBack({ minReplicaCount: 1, maxReplicaCount: 1, autoscalingPolicy: { scaleToZeroWindow: "300s" } }, 1),
    ).toThrow(/minimum 1/);
  });
});

describe("the held-out run's preemptible deployment (§13)", () => {
  it("is created on its own id, preemptible, and found the second time", async () => {
    const { fetcher, calls } = fakeFireworks(null);
    const evaluation = openDeployments("key", fetcher, evalDeployment("1.0"));
    expect((await evaluation.ensurePreemptible("1.0")).created).toBe(true);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toMatch(/deployments\?deploymentId=isitlegit-loupe-eval-1-0$/);
    expect(post?.body).toMatchObject({
      baseModel: "accounts/rizonetech/models/isitlegit-loupe-1-0",
      preemptible: true,
    });
    expect((await evaluation.ensurePreemptible("1.0")).created).toBe(false);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("is deleted and refused when it does not read back preemptible, so no run lands on held capacity", async () => {
    const { fetcher, calls } = fakeFireworks(null, ({ preemptible: _, ...rest }) => rest);
    await expect(openDeployments("key", fetcher, evalDeployment("1.0")).ensurePreemptible("1.0")).rejects.toThrow(
      /did not read back preemptible/,
    );
    expect(calls.map((c) => c.method)).toContain("DELETE");
  });

  it("refuses an existing deployment that is not preemptible or serves another version", async () => {
    const plain = fakeFireworks({ ...createBody("1.0") });
    await expect(openDeployments("key", plain.fetcher, evalDeployment("1.0")).ensurePreemptible("1.0")).rejects.toThrow(
      /not a preemptible deployment/,
    );
    const other = fakeFireworks({ ...createBody("1.0", true) });
    await expect(openDeployments("key", other.fetcher, evalDeployment("1.0")).ensurePreemptible("1.1")).rejects.toThrow(
      /not a preemptible deployment/,
    );
  });

  it("waits until it reads READY, since a deployment still CREATING answers inference with 404", async () => {
    const states = ["CREATING", "CREATING", "READY"];
    const { fetcher } = fakeFireworks({ ...createBody("1.0", true) }, (d) => ({
      ...d,
      state: states.shift() ?? "READY",
    }));
    let slept = 0;
    const read = await openDeployments("key", fetcher, evalDeployment("1.0")).waitReady(60_000, 1_000, async () => {
      slept++;
    });
    expect(read.state).toBe("READY");
    expect(slept).toBe(2);
  });

  it("refuses a deployment that fails, is gone, or is not READY in time", async () => {
    const failed = fakeFireworks({ ...createBody("1.0", true) }, (d) => ({ ...d, state: "FAILED" }));
    await expect(
      openDeployments("key", failed.fetcher, evalDeployment("1.0")).waitReady(60_000, 1_000, async () => {}),
    ).rejects.toThrow(/is FAILED, not becoming READY/);
    const gone = fakeFireworks(null);
    await expect(
      openDeployments("key", gone.fetcher, evalDeployment("1.0")).waitReady(60_000, 1_000, async () => {}),
    ).rejects.toThrow(/is gone/);
    const slow = fakeFireworks({ ...createBody("1.0", true) }, (d) => ({ ...d, state: "CREATING" }));
    let clock = 0;
    await expect(
      openDeployments("key", slow.fetcher, evalDeployment("1.0")).waitReady(
        60_000,
        15_000,
        async (ms) => {
          clock += ms;
        },
        () => clock,
      ),
    ).rejects.toThrow(/still CREATING after 1 minutes/);
  });

  it("is deleted by remove, and the dedicated deployment is never touched", async () => {
    const { fetcher, calls } = fakeFireworks({ ...createBody("1.0", true) });
    expect(await openDeployments("key", fetcher, evalDeployment("1.0")).remove()).toBeNull();
    expect(calls.every((c) => c.url.includes("/deployments/isitlegit-loupe-eval"))).toBe(true);
  });

  // 2026-10-31: Fireworks soft-deletes, so the deleted deployment read back in state DELETED and eval-down reported it
  // still there, then failed every retry on the 400 a second DELETE answers.
  it("counts a soft-deleted deployment as gone, and never deletes it twice", async () => {
    let current: Deployment | null = { ...createBody("1.0", true), state: "READY" };
    const calls: string[] = [];
    const fetcher = async (_url: string, init: RequestInit) => {
      calls.push(String(init.method));
      if (init.method === "DELETE") {
        if (current?.state === "DELETED")
          return new Response(JSON.stringify({ code: 9, message: "deployment is already soft-deleted" }), {
            status: 400,
          });
        current = { ...(current as Deployment), state: "DELETED" };
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify(current), { status: 200 });
    };
    const deployments = openDeployments("key", fetcher, evalDeployment("1.0"));
    expect(await deployments.remove()).toBeNull();
    expect(await deployments.remove()).toBeNull();
    expect(calls.filter((m) => m === "DELETE")).toHaveLength(1);
    // A deployment that still reads back live after the delete is reported, not taken for gone.
    current = { ...createBody("1.0", true), state: "READY" };
    const stuck = async (_url: string, init: RequestInit) =>
      new Response(init.method === "DELETE" ? "{}" : JSON.stringify(current), { status: 200 });
    expect((await openDeployments("key", stuck, evalDeployment("1.0")).remove())?.state).toBe("READY");
  });
});

describe("the inference-only key (§12)", () => {
  function fake(completions: number[], change: number) {
    const sent: { method: string; url: string; body: Record<string, unknown> }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      sent.push({ method: String(init.method), url, body: JSON.parse(String(init.body)) });
      if (init.method === "PATCH") return new Response("{}", { status: change });
      const status = completions.shift() ?? 200;
      return new Response(status === 200 ? COMPLETION : status === 503 ? SCALING : "{}", { status });
    };
    return { fetcher, sent };
  }
  const noSleep = async () => {};
  const SCALING = JSON.stringify({ error: { code: "DEPLOYMENT_SCALING_UP", message: "scaling up" } });
  const COMPLETION = JSON.stringify({
    choices: [{ index: 0, message: { role: "assistant", content: "p" }, finish_reason: "length" }],
  });
  let ledger: Exec;
  let book: ReturnType<typeof memoryLedger>;
  beforeEach(() => {
    book = memoryLedger();
    ledger = book.exec;
  });

  it("waits out the cold start, gets a one-token answer from the dedicated deployment, and is refused a change", async () => {
    const { fetcher, sent } = fake([503, 429, 200], 403);
    const result = await checkInferenceKey("1.0", "key", fetcher, 60_000, noSleep, Date.now, ledger);
    expect(result.answered).toMatchObject({ status: 200, attempts: 3 });
    expect(result.change.status).toBe(403);
    expect(sent[0]?.body).toMatchObject({
      model: "accounts/rizonetech/models/isitlegit-loupe-1-0#accounts/rizonetech/deployments/isitlegit-loupe",
      max_tokens: 1,
    });
    const patch = sent.find((s) => s.method === "PATCH");
    expect(patch?.url).toMatch(/\/deployments\/isitlegit-loupe$/);
    expect(patch?.body).toEqual({ maxReplicaCount: 1 });
  });

  it("fails when the key may change the deployment, or the change is not refused as unauthorised", async () => {
    await expect(
      checkInferenceKey("1.0", "key", fake([200], 200).fetcher, 60_000, noSleep, Date.now, ledger),
    ).rejects.toThrow(/was allowed to change/);
    await expect(
      checkInferenceKey("1.0", "key", fake([200], 500).fetcher, 60_000, noSleep, Date.now, ledger),
    ).rejects.toThrow(/answered 500, not a refusal/);
  });

  it("fails on a call the deployment refuses, and on one that never answers in time", async () => {
    await expect(
      checkInferenceKey("1.0", "key", fake([404], 403).fetcher, 60_000, noSleep, Date.now, ledger),
    ).rejects.toThrow(/one-token call answered 404/);
    let clock = 0;
    const always = fake(Array(100).fill(503), 403);
    await expect(
      checkInferenceKey(
        "1.0",
        "key",
        always.fetcher,
        60_000,
        async (ms) => {
          clock += ms;
        },
        () => clock,
        ledger,
      ),
    ).rejects.toThrow(/did not answer within 1 minutes \(last 503 DEPLOYMENT_SCALING_UP\)/);
  });

  // §12 plan review gap 4: a success status with no completion in its body is no answer.
  it("takes only a completion as the answer, never an empty or other body", async () => {
    expect(isCompletion(COMPLETION)).toBe(true);
    for (const body of ["{}", "", "<html>ok</html>", '{"choices":[]}', '{"choices":[{"message":{}}]}'])
      expect(isCompletion(body), body).toBe(false);
    const empty = async (_url: string, init: RequestInit) =>
      new Response("{}", { status: init.method === "PATCH" ? 403 : 200 });
    await expect(checkInferenceKey("1.0", "key", empty, 60_000, noSleep, Date.now, ledger)).rejects.toThrow(
      /answered 200 with no completion/,
    );
  });

  // §12 plan review gap 3, on §14's ledger: a wake is the deployment's minutes, reserved at its worst case (the wait
  // and the 6-minute tail) before anything is sent, and settled at the last request plus the tail.
  it("reserves each wake in the day's 30 minutes before sending, settles it, and refuses one that would pass them", async () => {
    const at = Date.parse("2026-10-31T10:00:00Z");
    const { fetcher, sent } = fake([200], 403);
    await checkInferenceKey("1.0", "key", fetcher, 15 * 60_000, noSleep, () => at, ledger);
    expect(book.rows()).toEqual([
      { day: "2026-10-31", purpose: "key-check", reserved_minutes: 21, used_minutes: 6, source: "local" },
    ]);
    // A day already at 26 minutes refuses the next 21-minute wake, and nothing is sent for it.
    await reserveWake(ledger, "monitor", 20, new Date(at));
    const before = sent.length;
    await expect(checkInferenceKey("1.0", "key", fetcher, 15 * 60_000, noSleep, () => at, ledger)).rejects.toThrow(
      /2026-10-31 would hold 47 of its 30 minutes/,
    );
    expect(sent.length).toBe(before);
    expect(book.rows()).toHaveLength(2);
  });

  // §14: the local scripts and the Worker share one ledger, and the wakes recorded before it are copied in once.
  it("refuses a local wake past a total the Worker's burst already holds, and imports the old file once", async () => {
    const at = new Date("2026-10-31T10:00:00Z");
    expect(
      await reserveBurst(ledger, {
        id: "monitor-1",
        at,
        source: "worker",
        caller: "monitor",
        purpose: "monitor",
        minutes: 20,
      }),
    ).toMatchObject({ ok: true });
    await expect(reserveWake(ledger, "warm-up", 12, at)).rejects.toThrow(/would hold 32 of its 30 minutes/);
    const dir = mkdtempSync(join(tmpdir(), "glimmer-import-"));
    try {
      const file = join(dir, "deployment-minutes.json");
      writeFileSync(
        file,
        JSON.stringify([
          { day: "2026-10-30", at: "2026-10-30T13:30:00.000Z", purpose: "key-check", reserved: 20, used: 3.5 },
          { day: "2026-10-30", at: "2026-10-30T15:00:00.000Z", purpose: "warm-up", reserved: 12, used: null },
        ]),
      );
      expect(await importWakes(ledger, file)).toEqual({ wakes: 2, added: 2 });
      expect(await importWakes(ledger, file)).toEqual({ wakes: 2, added: 0 });
      expect(book.rows().filter((r) => r.source === "import")).toEqual([
        { day: "2026-10-30", purpose: "key-check", reserved_minutes: 20, used_minutes: 3.5, source: "import" },
        { day: "2026-10-30", purpose: "warm-up", reserved_minutes: 12, used_minutes: null, source: "import" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// §12's completion review, gaps 1 to 6.
describe("the command line, deadlines, days, reuse, progress and diagnosis (§12 completion review)", () => {
  const SCRIPT = join(import.meta.dirname, "../../scripts/glimmer/deploy.ts");
  const run = (args: string[], path: string) => {
    try {
      return {
        code: 0,
        err: execFileSync(process.execPath, [SCRIPT, ...args], { env: { PATH: path }, stdio: "pipe" }).toString(),
      };
    } catch (error) {
      const e = error as { status: number; stderr: Buffer };
      return { code: e.status, err: e.stderr.toString() };
    }
  };
  // A PATH with node alone: a command that reached for the vault would find no conclave-op.
  const nodeOnly = () => join(process.execPath, "..");

  it("prints usage with no credential read, and fails by name when the vault cannot be read (gap 1)", () => {
    for (const args of [[], ["--help"], ["ensure"], ["ensure", "v1"], ["stop", "1.0"], ["eval-down"], ["nonsense"]]) {
      const { code, err } = run(args, nodeOnly());
      expect(code, args.join(" ")).toBe(2);
      expect(err).toMatch(/^usage: /);
      expect(err).not.toMatch(/conclave-op|vault/);
    }
    expect(parseCommand(["key-check", "1.0"])).toEqual({ command: "key-check", version: "1.0" });
    expect(parseCommand(["status"])).toEqual({ command: "status" });
    const { code, err } = run(["status"], nodeOnly());
    expect(code).toBe(1);
    expect(err.trim()).toBe('deploy: reading the vault item "IsItLegit Fireworks Admin" failed (ENOENT)');
  });

  it("cuts off a management call that stalls, and a key-check request that stalls past the wait (gap 2)", async () => {
    // Answers only when its signal aborts: a stalled server.
    const stalled = (_url: string, init: RequestInit) =>
      new Promise<Response>((_done, fail) => init.signal?.addEventListener("abort", () => fail(init.signal?.reason)));
    expect(REQUEST_MS).toBe(60_000);
    const seen: (AbortSignal | undefined)[] = [];
    const recording = async (_url: string, init: RequestInit) => {
      seen.push(init.signal ?? undefined);
      return new Response(JSON.stringify({ ...createBody("1.0"), state: "READY" }), { status: 200 });
    };
    await openDeployments("key", recording).status();
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    // The key check's request is bounded by what is left of its wait: one second here.
    let clock = 0;
    const dir = mkdtempSync(join(tmpdir(), "glimmer-stall-"));
    try {
      await expect(
        checkInferenceKey(
          "1.0",
          "key",
          stalled,
          1_000,
          async () => {},
          () => (clock += 600),
          memoryLedger().exec,
          () => {},
        ),
      ).rejects.toThrow(/did not answer within .* \(last no answer to its request\)/);
      // An answer that comes after the wait ran out fails like no answer: the clock passes the wait while it is asked.
      let late = 0;
      const slow = async () => {
        late += 61_000;
        return new Response(JSON.stringify({ choices: [{ message: { content: "p" }, finish_reason: "length" }] }), {
          status: 200,
        });
      };
      await expect(
        checkInferenceKey(
          "1.0",
          "key",
          slow,
          60_000,
          async () => {},
          () => late,
          memoryLedger().exec,
          () => {},
        ),
      ).rejects.toThrow(/did not answer within 1 minutes \(last 200\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("charges a wake to each SAST day it runs in, at reservation and at settlement (gap 3)", async () => {
    // 23:59 SAST is 21:59 UTC.
    const at = new Date("2026-10-31T21:59:00Z");
    expect(minutesByDay(at, 15)).toEqual([
      { day: "2026-10-31", minutes: 1 },
      { day: "2026-11-01", minutes: 14 },
    ]);
    // The next day already holds 20 minutes: a 15-minute wake from 23:59 would take it to 34.
    const full = memoryLedger();
    await reserveWake(full.exec, "monitor", 20, new Date("2026-11-01T06:00:00Z"));
    await expect(reserveWake(full.exec, "key-check", 15, at)).rejects.toThrow(/2026-11-01 would hold 34 /);
    const book = memoryLedger();
    const wake = await reserveWake(book.exec, "key-check", 20, at);
    // Its last answer 9 minutes in: 15 minutes with the 6-minute tail, 1 on the first day and 14 on the next.
    await settleWake(book.exec, wake, { lastAnswerAt: new Date(at.getTime() + 9 * 60_000) });
    const rounded = book.rows().map((r) => ({ ...r, used_minutes: Math.round((r.used_minutes ?? 0) * 1e6) / 1e6 }));
    expect(rounded).toEqual([
      { day: "2026-10-31", purpose: "key-check", reserved_minutes: 1, used_minutes: 1, source: "local" },
      { day: "2026-11-01", purpose: "key-check", reserved_minutes: 19, used_minutes: 14, source: "local" },
    ]);
  });

  it("reuses the held-out deployment only as it would be created (gap 4)", async () => {
    const reuse = (d: Deployment) =>
      openDeployments("key", fakeFireworks(d).fetcher, evalDeployment("1.0")).ensurePreemptible("1.0");
    const good = { ...createBody("1.0", true), state: "READY" };
    expect((await reuse(good)).created).toBe(false);
    await expect(reuse({ ...good, minReplicaCount: 1 })).rejects.toThrow(/minimum 1/);
    await expect(reuse({ ...good, maxReplicaCount: 2 })).rejects.toThrow(/maximum 2/);
    await expect(reuse({ ...good, autoscalingPolicy: { scaleToZeroWindow: "3600s" } })).rejects.toThrow(
      /scale-to-zero 3600s/,
    );
    const { baseModel: _none, ...noModel } = good;
    await expect(reuse(noModel)).rejects.toThrow(/not a preemptible deployment of/);
    await expect(reuse({ ...good, state: "FAILED" })).rejects.toThrow(/is FAILED/);
  });

  it("says what a long wait is doing, on its progress line, not on stdout (gap 5)", async () => {
    const lines: string[] = [];
    let n = 0;
    const creating = async () =>
      new Response(JSON.stringify({ ...createBody("1.0"), state: n++ < 2 ? "CREATING" : "READY" }), { status: 200 });
    await openDeployments("key", creating).waitReady(
      60_000,
      1,
      async () => {},
      Date.now,
      (l) => lines.push(l),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/isitlegit-loupe is CREATING, \d+ s waited, \d+ s left/);
    const dir = mkdtempSync(join(tmpdir(), "glimmer-say-"));
    try {
      const said: string[] = [];
      const answers = [503, 200];
      const fetcher = async (_url: string, init: RequestInit) => {
        if (init.method === "PATCH") return new Response("{}", { status: 403 });
        const status = answers.shift() ?? 200;
        return new Response(
          status === 503
            ? JSON.stringify({ error: { code: "DEPLOYMENT_SCALING_UP" } })
            : JSON.stringify({ choices: [{ message: { content: "p" }, finish_reason: "length" }] }),
          { status },
        );
      };
      await checkInferenceKey(
        "1.0",
        "key",
        fetcher,
        60_000,
        async () => {},
        Date.now,
        memoryLedger().exec,
        (l) => said.push(l),
      );
      expect(said[0]).toMatch(/^asking isitlegit-loupe for one token/);
      expect(said[1]).toMatch(/^the deployment is scaling up \(503\), \d+ s waited, asking again in 15 s$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits out only a cold start or a rate limit, and names any other failure's code at once (gap 6)", async () => {
    expect(errorCode(JSON.stringify({ error: { code: "DEPLOYMENT_SCALING_UP" } }))).toBe("DEPLOYMENT_SCALING_UP");
    expect(errorCode(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "secret detail" } }))).toBe(
      "INTERNAL_ERROR",
    );
    expect(errorCode("<html>Service Unavailable</html>")).toBeNull();
    expect(errorCode(JSON.stringify({ error: { code: "lower or a very long sentence with spaces" } }))).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "glimmer-503-"));
    try {
      let asked = 0;
      const failing = async () => {
        asked++;
        return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "secret detail" } }), {
          status: 503,
        });
      };
      const error = await checkInferenceKey(
        "1.0",
        "key",
        failing,
        60_000,
        async () => {},
        Date.now,
        memoryLedger().exec,
        () => {},
      ).catch((e: Error) => e);
      expect((error as Error).message).toBe("the one-token call answered 503 (INTERNAL_ERROR)");
      expect(asked).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// §12 round 1.
describe("round 1: the ledger lock, the bounded probe, and eval-up after eval-down", () => {
  // §14 replaced the file lock with one atomic statement: two wakes for the last minutes of a day, one reserved.
  it("gives the last minutes of a day to one of two wakes at once, and refuses with nothing reserved when D1 fails", async () => {
    const book = memoryLedger();
    const at = new Date("2026-10-31T10:00:00Z");
    await reserveWake(book.exec, "monitor", 18, at);
    const both = await Promise.allSettled([
      reserveWake(book.exec, "key-check", 12, at),
      reserveWake(book.exec, "warm-up", 12, at),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const broken: Exec = async () => {
      throw new Error("wrangler d1 execute did not succeed");
    };
    await expect(reserveWake(broken, "key-check", 5, at)).rejects.toThrow(
      /could not be read or written.*nothing was sent/,
    );
  });

  it("bounds the permission probe by the wait, its body included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glimmer-probe-"));
    const book = memoryLedger();
    try {
      const fetcher = (_url: string, init: RequestInit) =>
        init.method === "PATCH"
          ? new Promise<Response>((_d, fail) => init.signal?.addEventListener("abort", () => fail(init.signal?.reason)))
          : Promise.resolve(
              new Response(JSON.stringify({ choices: [{ message: { content: "p" }, finish_reason: "length" }] }), {
                status: 200,
              }),
            );
      await expect(
        checkInferenceKey(
          "1.0",
          "key",
          fetcher,
          1_000,
          async () => {},
          Date.now,
          book.exec,
          () => {},
        ),
      ).rejects.toThrow(/did not answer in time/);
      // The wake is settled even so.
      expect(book.rows()[0]?.used_minutes).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("names a held-out deployment per version, and brings the same version's deleted one back", async () => {
    expect(evalDeployment("1.1")).toBe("isitlegit-loupe-eval-1-1");
    let current: Deployment = { ...createBody("1.1", true), state: "DELETED" };
    const posts: string[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        posts.push(url);
        if (url.endsWith(":undelete")) current = { ...current, state: "READY" };
      }
      return new Response(JSON.stringify(current), { status: 200 });
    };
    const back = await openDeployments("key", fetcher, evalDeployment("1.1")).ensurePreemptible("1.1");
    expect(back).toMatchObject({ created: false, deployment: { state: "READY" } });
    expect(posts).toEqual([expect.stringMatching(/\/deployments\/isitlegit-loupe-eval-1-1:undelete$/)]);
    // Another version's deleted record under the id is refused, never brought back.
    current = { ...createBody("1.0", true), state: "DELETED" };
    posts.length = 0;
    await expect(openDeployments("key", fetcher, evalDeployment("1.1")).ensurePreemptible("1.1")).rejects.toThrow(
      /not a preemptible deployment of/,
    );
    expect(posts).toEqual([]);
  });
});

// §12 round 3: no request starts after the wait has run out, and the pause is cut to what is left.
describe("round 3: the key check's last request starts inside its wait", () => {
  it("cuts the pause to the time left and sends nothing once the wait is over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glimmer-pause-"));
    const book = memoryLedger();
    try {
      let clock = 0;
      const sent: number[] = [];
      const limited = async (_url: string, init: RequestInit) => {
        if (init.method !== "PATCH") sent.push(clock);
        clock += 1_000; // each answer takes a second
        return new Response("{}", { status: 429 });
      };
      const pauses: number[] = [];
      await expect(
        checkInferenceKey(
          "1.0",
          "key",
          limited,
          60_000,
          async (ms) => {
            pauses.push(ms);
            clock += ms;
          },
          () => clock,
          book.exec,
          () => {},
        ),
      ).rejects.toThrow(/did not answer within 1 minutes \(last 429\)/);
      expect(Math.max(...sent)).toBeLessThan(60_000);
      expect(pauses.every((ms) => ms <= 15_000)).toBe(true);
      // The wake settled at the wait and its 6-minute tail, never past what was reserved.
      expect(book.rows()[0]?.used_minutes).toBeLessThanOrEqual(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// §13 plan review gaps 1 and 8: the warm-up measurement, one receipt a run, from a confirmed scale to zero.
describe("warm-up measurement (§13)", () => {
  const completion = JSON.stringify({ choices: [{ message: { content: "p" }, finish_reason: "length" }] });
  const scaling = JSON.stringify({ error: { code: "DEPLOYMENT_SCALING_UP" } });
  function world(cold: number, zeroAfterReads: number) {
    let clock = Date.parse("2026-10-31T16:00:00Z");
    let replicas = 0;
    let reads = 0;
    let answered = false;
    const fetcher = async () => {
      clock += 500;
      if (cold-- > 0) {
        replicas = 1;
        return new Response(scaling, { status: 503 });
      }
      answered = true;
      return new Response(completion, { status: 200 });
    };
    const admin = {
      status: async () => {
        if (answered && ++reads >= zeroAfterReads) replicas = 0;
        return { ...createBody("1.0"), state: "READY", replicaCount: replicas } as Deployment;
      },
    };
    const sleep = async (ms: number) => {
      clock += ms;
    };
    return { fetcher, admin, sleep, now: () => clock };
  }

  it("times a cold start and scale to zero, writes its receipt, and settles the wake at what it took", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glimmer-warm-"));
    const book = memoryLedger();
    try {
      const w = world(4, 3);
      const receipt = await measureWarmup("1.0", "key", w.admin, {
        ...w,
        ledger: book.exec,
        dir: join(dir, "warmup"),
        progress: () => {},
      });
      // Four 503s, 5 s apart, then the answer: warm-up from the first 503 to the answer.
      expect(receipt).toMatchObject({ cold: true, attempts: 5, warmup_ms: 4 * 5_500, within_7_minutes: true });
      expect(receipt.zero_ms_after_last_request).toBe(3 * 15_000);
      const [wake] = book.rows();
      expect(wake).toMatchObject({ purpose: "warm-up", reserved_minutes: 12 });
      expect(wake?.used_minutes).toBeCloseTo((receipt.answered_ms + 45_000) / 60_000, 1);
      expect(warmupSummary(join(dir, "warmup"))).toMatchObject({ receipts: 1, cold: 1, median_s: 22, max_s: 22 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start unless the deployment reads READY at 0 replicas, and counts a warm answer as no warm-up", async () => {
    const book = memoryLedger();
    const dir = mkdtempSync(join(tmpdir(), "glimmer-warm2-"));
    try {
      const up = { status: async () => ({ ...createBody("1.0"), state: "READY", replicaCount: 1 }) as Deployment };
      await expect(
        measureWarmup("1.0", "key", up, { ledger: book.exec, dir: join(dir, "w"), progress: () => {} }),
      ).rejects.toThrow(/starts only at READY with 0/);
      expect(book.rows()).toEqual([]);
      const w = world(0, 1);
      const warm = await measureWarmup("1.0", "key", w.admin, {
        ...w,
        ledger: book.exec,
        dir: join(dir, "w"),
        progress: () => {},
      });
      expect(warm).toMatchObject({ cold: false, warmup_ms: null });
      expect(warmupSummary(join(dir, "w"))).toMatchObject({ receipts: 1, cold: 0, median_s: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
