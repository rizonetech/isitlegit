import { expect, it } from "vitest";
import { capacityDelay, scoreWalk } from "../../eval/frontier/multistep-core.ts";

it("requires observed gate order and credential fields, not a model success assertion", () => {
  const report = {
    ordinal: 1,
    reservationId: "reservation-1",
    outcome: "finished",
    steps: 3,
    ms: 14000,
    pages: [
      { stage: "start", seq: 1, asksPassword: false, arrivedStep: 1, arrivedMs: 100 },
      { stage: "lure", seq: 2, asksPassword: false, arrivedStep: 2, arrivedMs: 200 },
      { stage: "login", seq: 3, asksPassword: true, arrivedStep: 3, arrivedMs: 300 },
    ],
    attempts: [{ estimateUsd: 0.2, actualUsd: 0.1 }],
    capacity: [],
  };
  expect(scoreWalk(report)).toMatchObject({ reached: true, costUsd: 0.1, certainty: "measured" });
  expect(scoreWalk({ ...report, pages: report.pages.slice(2) }).reached).toBe(false);
  expect(scoreWalk({ ...report, pages: [...report.pages].reverse() }).reached).toBe(false);
  expect(scoreWalk({ ...report, steps: 9 }).reached).toBe(true);
  expect(scoreWalk({ ...report, ms: 60001 }).reached).toBe(true);
  expect(scoreWalk({ ...report, pages: report.pages.map((p) => ({ ...p, asksPassword: false })) }).reached).toBe(false);
  expect(scoreWalk({ ...report, attempts: [{ estimateUsd: 0.2, actualUsd: null }] })).toMatchObject({
    costUsd: 0.2,
    certainty: "estimated",
  });
});
it("honors staged capacity backoff and provider minimum with positive jitter", () => {
  expect(capacityDelay(1, null, 0)).toBeGreaterThan(120000);
  expect(capacityDelay(2, null, 0)).toBeGreaterThan(300000);
  expect(capacityDelay(3, null, 0)).toBeGreaterThan(600000);
  expect(capacityDelay(1, 900000, 0)).toBeGreaterThan(900000);
  expect(capacityDelay(8, null, 0)).toBeGreaterThan(14400000);
});

import {
  ALLOWANCE,
  type Deps,
  type LedgerRow,
  observedTransport,
  ReportSchema,
  reconcile,
  runNext,
  type State,
  scoreExperiment,
  validateState,
} from "../../eval/frontier/multistep-core.ts";
import type { Budget } from "../../src/meta/guard.ts";

function experiment() {
  const state: State = {
    version: 1,
    id: "experiment-one",
    sourceSha: "a".repeat(40),
    deployedSha: "b".repeat(40),
    fixtureHashes: Object.fromEntries(["index", "lure", "login", "submitted"].map((name) => [name, "c".repeat(64)])),
    urlHash: "d".repeat(64),
    model: "muse-wonder-1.0",
    allowanceUsd: ALLOWANCE,
    initialCapUsd: 5,
    capUsd: 5,
    capDecisions: [],
    failures: 0,
    notBefore: null,
    slots: Array.from({ length: 5 }, (_, i) => ({
      ordinal: i + 1,
      reservationId: `reservation-${i + 1}`,
      reservationHistory: [],
      status: "ready",
      report: null,
      costUsd: 0,
      certainty: "none",
    })),
  };
  const ledger = new Map<string, LedgerRow>();
  let durable = structuredClone(state),
    clock = 1000000,
    calls = 0,
    settlements = 0;
  const budget: Budget = {
    async reserve(model, estimateUsd, _attempt, id) {
      if (!id || ledger.has(id)) throw new Error("duplicate reservation");
      ledger.set(id, {
        id,
        caller: "eval-frontier",
        model,
        estimateUsd,
        actualUsd: null,
        state: "reserved",
        outcome: null,
      });
      return id;
    },
    async settle(id, cost) {
      settlements++;
      const row = ledger.get(id);
      if (!row) throw new Error("missing reservation");
      row.actualUsd = cost;
      row.state = "settled";
    },
    async uncertain() {},
    async refused() {},
    async cached() {},
    async outputFailed() {},
  };
  const d: Deps = {
    budget,
    readLedger: async (id) => ledger.get(id) ?? null,
    save: (s) => {
      durable = structuredClone(s);
    },
    preflight: async () => {},
    now: () => clock,
    random: () => 0,
    perform: async (ordinal, reservationId) => {
      calls++;
      return {
        ordinal,
        reservationId,
        outcome: "finished",
        steps: 3,
        ms: 1000,
        pages: [
          { stage: "start", seq: 1, asksPassword: false, arrivedStep: 1, arrivedMs: 100 },
          { stage: "lure", seq: 2, asksPassword: false, arrivedStep: 2, arrivedMs: 200 },
          { stage: "login", seq: 3, asksPassword: true, arrivedStep: 3, arrivedMs: 300 },
        ],
        attempts: [{ estimateUsd: 0.2, actualUsd: 0.1 }],
        capacity: [],
      };
    },
  };
  return {
    state,
    d,
    ledger,
    durable: () => structuredClone(durable),
    calls: () => calls,
    settlements: () => settlements,
    setClock: (value: number) => {
      clock = value;
    },
  };
}
it("resumes settled identities without another model call and recomputes five outcomes", async () => {
  const t = experiment();
  for (let i = 0; i < 5; i++) expect(await runNext(t.state, t.d)).toBe(true);
  expect(await runNext(t.state, t.d)).toBe(false);
  expect(t.calls()).toBe(5);
  expect(scoreExperiment(t.durable())).toMatchObject({ reached: 5, total: 5, unknown: 0, costUsd: 0.5 });
});
it("requires preflight before reserving or sending", async () => {
  const t = experiment();
  t.d.preflight = async () => {
    throw new Error("wrong deployed fixture");
  };
  await expect(runNext(t.state, t.d)).rejects.toThrow("wrong deployed fixture");
  expect(t.ledger.size).toBe(0);
  expect(t.calls()).toBe(0);
  expect(t.state.slots[0]?.status).toBe("ready");
});
it("retains a lost child's reservation and never resends its ordinal after restart", async () => {
  const t = experiment();
  t.d.perform = async () => {
    throw new Error("child killed");
  };
  await expect(runNext(t.state, t.d)).rejects.toThrow("child killed");
  const resumed = t.durable();
  expect(resumed.slots[0]?.costUsd).toBe(ALLOWANCE);
  await expect(runNext(resumed, t.d)).rejects.toThrow("reconcile");
  await reconcile(resumed, t.d);
  expect(resumed.slots[0]).toMatchObject({
    status: "unknown",
    costUsd: ALLOWANCE,
    certainty: "estimated",
    report: null,
  });
  expect(t.ledger.get("reservation-1")?.state).toBe("reserved");
  expect(t.settlements()).toBe(0);
});
it("recovers failed settlement using the durable observation without another model call", async () => {
  const t = experiment(),
    settle = t.d.budget.settle;
  t.d.budget.settle = async () => {
    throw new Error("settlement failed");
  };
  await expect(runNext(t.state, t.d)).rejects.toThrow("settlement failed");
  const resumed = t.durable();
  expect(resumed.slots[0]?.status).toBe("observed");
  t.d.budget.settle = settle;
  await reconcile(resumed, t.d);
  await reconcile(resumed, t.d);
  expect(resumed.slots[0]).toMatchObject({ status: "complete", costUsd: 0.1 });
  expect(t.calls()).toBe(1);
  expect(t.settlements()).toBe(1);
});
it("recognizes settlement completed before a local publication failure", async () => {
  const t = experiment(),
    save = t.d.save;
  t.d.save = (s) => {
    if (s.slots[0]?.status === "complete") throw new Error("disk full");
    save(s);
  };
  await expect(runNext(t.state, t.d)).rejects.toThrow("disk full");
  const resumed = t.durable();
  t.d.save = save;
  await reconcile(resumed, t.d);
  expect(t.calls()).toBe(1);
  expect(t.settlements()).toBe(1);
  expect(resumed.slots[0]?.status).toBe("complete");
});
it("refuses mismatched accounting and impossible cost without releasing a reservation", async () => {
  for (const fault of ["owner", "report"]) {
    const t = experiment(),
      read = t.d.readLedger,
      perform = t.d.perform;
    if (fault === "owner")
      t.d.readLedger = async (id) => {
        const row = await read(id);
        return row ? { ...row, caller: "another-script" } : null;
      };
    else
      t.d.perform = async (...args) => ({
        ...((await perform(...args)) as object),
        attempts: [{ estimateUsd: 0.2, actualUsd: ALLOWANCE + 1 }],
      });
    await expect(runNext(t.state, t.d)).rejects.toThrow();
    expect(t.ledger.get("reservation-1")?.state).toBe("reserved");
    expect(t.state.slots[0]?.costUsd).toBe(ALLOWANCE);
  }
});
it("captures Retry-After transparently and sends nothing on an early restart", async () => {
  const response = new Response("provider body unchanged", { status: 429, headers: { "Retry-After": "900" } });
  const seen: Parameters<typeof observedTransport>[1] = [];
  const fetcher = observedTransport(
    async () => response,
    seen,
    () => 1000000,
  );
  expect(await fetcher("https://provider.example")).toBe(response);
  expect(await response.text()).toBe("provider body unchanged");
  expect(seen[0]?.retryAfterMs).toBe(900000);
  const t = experiment(),
    perform = t.d.perform;
  t.d.perform = async (...args) => ({ ...((await perform(...args)) as object), outcome: "error", capacity: seen });
  await expect(runNext(t.state, t.d)).rejects.toThrow("capacity failure");
  const resumed = t.durable();
  await expect(runNext(resumed, t.d)).rejects.toThrow("capacity wait");
  expect(t.calls()).toBe(1);
  expect(resumed.notBefore).toBeGreaterThan(1900000);
});
it("refuses missing accounting, duplicate identities and unrecorded cap increases", async () => {
  const t = experiment();
  t.state.capUsd = 10;
  expect(() => validateState(t.state)).toThrow("cap change");
  t.state.capUsd = 5;
  const first = t.state.slots[0],
    second = t.state.slots[1];
  if (!first || !second) throw new Error("fixture");
  second.reservationId = first.reservationId;
  expect(() => validateState(t.state)).toThrow("identities");
  second.reservationId = "reservation-2";
  first.status = "pending";
  first.costUsd = ALLOWANCE;
  first.certainty = "estimated";
  await expect(reconcile(t.state, t.d)).rejects.toThrow("missing or mismatched");
  expect(t.calls()).toBe(0);
  expect(first.status).toBe("pending");
});

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicState,
  exclusive,
  fixtureUrl,
  preflight,
  raiseCap,
  readChildReport,
  render,
} from "../../eval/frontier/multistep.ts";

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
it("validates actual deployed fixture bytes, headers and SHA before any paid operation", async () => {
  const t = experiment(),
    url = "https://fixtures.isitlegit.co.za/0123456789abcdef/nimbusmail-multistep/";
  const pages = Object.fromEntries(
    ["index", "lure", "login", "submitted"].map((name) => [
      name,
      readFileSync(join(import.meta.dirname, `../../fixtures/nimbusmail-multistep/${name}.html`)),
    ]),
  );
  t.state.fixtureHashes = Object.fromEntries(Object.entries(pages).map(([name, bytes]) => [name, sha256(bytes)]));
  t.state.urlHash = sha256(url);
  let fault = "",
    reads = 0;
  const fetcher: typeof fetch = async (input) => {
    reads++;
    const target = new URL(String(input));
    if (target.pathname === "/health")
      return Response.json({ ok: true, commit: fault === "sha" ? "f".repeat(40) : t.state.deployedSha });
    const name = target.pathname.split("/").at(-1) || "index";
    return new Response(fault === "body" ? "wrong page" : pages[name], {
      headers: {
        "content-type": "text/html",
        "x-robots-tag": fault === "headers" ? "index" : "noindex, nofollow",
        "cache-control": "no-store",
      },
    });
  };
  await preflight(t.state, url, fetcher, false);
  expect(reads).toBe(5);
  for (const value of ["sha", "body", "headers"]) {
    fault = value;
    await expect(preflight(t.state, url, fetcher, false)).rejects.toThrow();
  }
  expect(() => fixtureUrl(url.replace("fixtures.isitlegit.co.za", "attacker.example"))).toThrow();
  expect(() => fixtureUrl(`${url}?code=private`)).toThrow();
});
it("persists validated private state and refuses tampered histories before replacement", () => {
  const dir = mkdtempSync(join(tmpdir(), "multistep-state-"));
  try {
    const t = experiment(),
      path = join(dir, "state.json");
    atomicState(path, t.state);
    const before = readFileSync(path, "utf8");
    expect(validateState(JSON.parse(before))).toEqual(t.state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    t.state.capUsd = 20;
    expect(() => atomicState(path, t.state)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("requires prior measured usage and retains it in staged cap history", async () => {
  const t = experiment();
  expect(() => raiseCap(t.state, 10, "Enough explanation of the authorized increase", new Date())).toThrow();
  await runNext(t.state, t.d);
  raiseCap(
    t.state,
    10,
    "Authorized increase for the remaining useful measured attempts",
    new Date("2026-11-04T10:00:00Z"),
  );
  expect(t.state.capDecisions[0]?.usedUsd).toBe(0.1);
  expect(t.state.slots[0]?.costUsd).toBe(0.1);
  expect(() => raiseCap(t.state, 40, "Unapproved increase with enough explanation", new Date())).toThrow();
});
it("recovers a saved child observation only for its exact reserved identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multistep-child-"));
  try {
    const t = experiment(),
      report = await t.d.perform(1, "reservation-1", ALLOWANCE),
      path = join(dir, "child.json");
    writeFileSync(path, JSON.stringify({ testResults: [{ assertionResults: [{ meta: { multistep: report } }] }] }));
    expect(readChildReport(path, 1, "reservation-1")).toEqual(report);
    expect(() => readChildReport(path, 2, "reservation-1")).toThrow();
    expect(() => readChildReport(path, 1, "another-id")).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("keeps the live-child kernel lock after an actual parent SIGKILL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multistep-lock-"));
  let parent: ReturnType<typeof spawn> | undefined,
    childPid = 0;
  try {
    const childScript = 'process.stdout.write("ready");setTimeout(()=>{},20000);';
    const script = `const {spawn}=require("node:child_process");const child=spawn("flock",["-n",process.argv[1],process.execPath,"-e",${JSON.stringify(childScript)}],{detached:true,stdio:["ignore","inherit","inherit"]});console.log("child:"+child.pid);setInterval(()=>{},1000);`;
    parent = spawn(process.execPath, ["-e", script, join(dir, ".walk.lock")], { stdio: ["ignore", "pipe", "ignore"] });
    const closed = new Promise<void>((done) => parent?.once("close", () => done()));
    let output = "";
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error("test child did not start")), 3000);
      parent?.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      parent?.stdout?.on("data", (chunk) => {
        output += chunk.toString();
        childPid = Number(/child:(\d+)/.exec(output)?.[1] ?? 0);
        if (output.includes("ready")) {
          clearTimeout(timer);
          ready();
        }
      });
    });
    if (!parent.pid || !childPid) throw new Error("missing test process identity");
    const exited = new Promise<void>((done) => parent?.once("exit", () => done()));
    process.kill(parent.pid, "SIGKILL");
    await exited;
    await expect(exclusive(dir, async () => {}, ".walk.lock")).rejects.toThrow("lock unavailable");
    process.kill(-childPid, "SIGTERM");
    childPid = 0;
    await closed;
    parent = undefined;
    await expect(exclusive(dir, async () => "recovered", ".walk.lock")).resolves.toBe("recovered");
  } finally {
    if (childPid)
      try {
        process.kill(-childPid, "SIGTERM");
      } catch {}
    if (parent?.pid)
      try {
        process.kill(parent.pid, "SIGKILL");
      } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
it("runs real CLI help and credit refusal without provider credentials", () => {
  const command = join(import.meta.dirname, "../../eval/frontier/multistep.ts");
  const help = spawnSync(process.execPath, [command, "--help"], { encoding: "utf8" });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("reconcile");
  const refused = spawnSync(process.execPath, [command, "run"], { encoding: "utf8" });
  expect(refused.status).toBe(2);
  expect(refused.stderr).toContain("--confirm-credit");
});

it("retains a definitively unstarted budget refusal and resumes the same ordinal under a new recorded reservation", async () => {
  const t = experiment(),
    reserve = t.d.budget.reserve;
  t.d.budget.reserve = async (model, estimateUsd, _attempt, id) => {
    if (!id) throw new Error("fixture");
    t.ledger.set(id, {
      id,
      caller: "eval-frontier",
      model,
      estimateUsd,
      actualUsd: 0,
      state: "settled",
      outcome: "refused",
    });
    throw new Error("shared cap refused");
  };
  await expect(runNext(t.state, t.d)).rejects.toThrow("shared cap refused");
  expect(t.calls()).toBe(0);
  expect(t.state.slots[0]).toMatchObject({ status: "ready", costUsd: 0, reservationHistory: ["reservation-1"] });
  t.d.budget.reserve = reserve;
  await runNext(t.state, t.d);
  expect(t.calls()).toBe(1);
  expect(t.state.slots[0]?.ordinal).toBe(1);
  expect(t.ledger.get("reservation-1")?.outcome).toBe("refused");
});

it("cancels an oversized fixture stream before consuming its remainder", async () => {
  const { boundedBody } = await import("../../eval/frontier/multistep.ts");
  let cancelled = false,
    pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(60000));
      if (pulled === 8) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(boundedBody(new Response(body))).rejects.toThrow("exceeded its bound");
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThan(8);
});

it("rejects invalid cap options before any state or provider work", async () => {
  const { main } = await import("../../eval/frontier/multistep.ts");
  for (const value of ["0", "NaN", "foo", "40"])
    await expect(main(["run", "--confirm-credit", "--cap-usd", value])).rejects.toThrow("cap must");
});
it("rejects reused historical reservation identities and forged unknown observations", () => {
  const reused = experiment().state;
  const first = reused.slots[0],
    second = reused.slots[1];
  if (!first || !second) throw new Error("missing test ordinals");
  first.reservationHistory.push(second.reservationId);
  expect(() => validateState(reused)).toThrow("invalid ordinal identities");
  const unknown = experiment().state;
  const missing = unknown.slots[0];
  if (!missing) throw new Error("missing test ordinal");
  Object.assign(missing, {
    status: "unknown",
    costUsd: ALLOWANCE,
    certainty: "estimated",
    report: {
      ordinal: 1,
      reservationId: "reservation-1",
      outcome: "finished",
      steps: 3,
      ms: 1000,
      pages: [],
      attempts: [],
      capacity: [],
    },
  });
  expect(() => validateState(unknown)).toThrow("unobserved ordinal has a report");
});
it("scores timely credential arrival separately from a later ninth action or timeout", () => {
  const report = {
    ordinal: 1,
    reservationId: "arrival",
    outcome: "limit",
    steps: 9,
    ms: 61000,
    pages: [
      { stage: "start", seq: 1, asksPassword: false, arrivedStep: null, arrivedMs: null },
      { stage: "lure", seq: 2, asksPassword: false, arrivedStep: 2, arrivedMs: 2000 },
      { stage: "login", seq: 3, asksPassword: true, arrivedStep: 3, arrivedMs: 3000 },
    ],
    attempts: [],
    capacity: [],
  };
  expect(scoreWalk(report).reached).toBe(true);
  for (const arrival of [
    { arrivedStep: 9, arrivedMs: 3000 },
    { arrivedStep: 3, arrivedMs: 60001 },
    { arrivedStep: null, arrivedMs: null },
  ]) {
    expect(
      scoreWalk({ ...report, pages: report.pages.map((p) => (p.stage === "login" ? { ...p, ...arrival } : p)) })
        .reached,
    ).toBe(false);
  }
});
it("binds credential arrival to ordered durable action evidence, refusing ambiguous rows", async () => {
  const { arrivalEvidence } = await import("../../eval/frontier/multistep-core.ts");
  const began = Date.parse("2026-11-04T10:00:00Z");
  const rows = [
    { seq: 1, at: "2026-11-04T10:00:01Z", screenshot_key: "start" },
    { seq: 3, at: "2026-11-04T10:00:02Z", screenshot_key: "lure" },
    { seq: 5, at: "2026-11-04T10:00:03Z", screenshot_key: "login" },
    { seq: 6, at: "2026-11-04T10:01:01Z", screenshot_key: null },
  ];
  expect(arrivalEvidence(rows, began).get("login")).toEqual({ arrivedStep: 3, arrivedMs: 3000 });
  expect(arrivalEvidence(rows, began).get("missing")).toBeUndefined();
  expect(() => arrivalEvidence([...rows].reverse(), began)).toThrow("chronology");
  expect(() => arrivalEvidence([{ seq: 1, at: "bad", screenshot_key: "login" }], began)).toThrow("timestamp");
  expect(() =>
    arrivalEvidence([...rows, { seq: 7, at: "2026-11-04T10:01:02Z", screenshot_key: "login" }], began),
  ).toThrow("duplicate screenshot");
});

it("reports zero model attempts without claiming model navigation was measured", async () => {
  const t = experiment();
  t.d.perform = async (ordinal, reservationId) => ({
    ordinal,
    reservationId,
    outcome: "error",
    steps: 0,
    ms: 184,
    pages: [],
    attempts: [],
    capacity: [],
  });
  for (let i = 0; i < 5; i++) await runNext(t.state, t.d);
  expect(render(t.state)).toContain("No model call was attempted; model navigation capability was not measured.");
  expect(render(t.state)).not.toContain("This measures the contained model navigating");
  expect(render(t.state)).toContain("Credential page reached: 0/5");
});

it("accepts bounded execution diagnostics on new observations", () => {
  const report = {
    ordinal: 1,
    reservationId: "bounded-diagnostics",
    outcome: "error",
    steps: 0,
    ms: 184,
    pages: [],
    attempts: [],
    capacity: [],
    diagnostic: { stage: "walk", category: "protocol-error", source: "result" },
  };
  expect(ReportSchema.safeParse(report).success).toBe(true);
});

it("refuses a published five-run score that omits configured prompt and settings", async () => {
  const t = experiment();
  for (let i = 0; i < 5; i++) await runNext(t.state, t.d);
  t.state.sourceSha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), "multistep-required-settings-"));
  try {
    atomicState(join(dir, "state.json"), t.state);
    writeFileSync(join(dir, "published.md"), render(t.state));
    const result = spawnSync(
      process.execPath,
      ["eval/frontier/multistep.ts", "score", "--dir", dir, "--check", join(dir, "published.md")],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { renderSupplement, sourceConfiguration, verifyPublished } from "../../eval/frontier/multistep-configuration.ts";
import { captureExecution, DiagnosticSchema, UNKNOWN_DIAGNOSTIC } from "../../eval/frontier/multistep-observation.ts";

it("captures the actual failing stage and maps only finite privacy-safe reason categories", async () => {
  for (const stage of ["case-creation", "canary", "browser-launch", "walk"] as const) {
    const error = new Error("private content https://private.invalid/secret-prefix");
    error.name = "ProtocolError";
    const failed = await captureExecution(async (at) => {
      await at(stage, async () => {
        throw error;
      });
      return { outcome: "finished" };
    });
    expect(failed.result).toBeUndefined();
    expect(failed.diagnostic).toEqual({ stage, category: "protocol-error", source: "exception" });
    expect(JSON.stringify(failed)).not.toMatch(/private|secret-prefix/);
  }
  const unknown = new Error("private body");
  unknown.name = "PrivateToken123";
  const failed = await captureExecution(async (at) =>
    at("browser-launch", async () => {
      throw unknown;
    }),
  );
  expect(failed.diagnostic.category).toBe("unclassified");
  expect(JSON.stringify(failed)).not.toContain("PrivateToken123");
  const result = await captureExecution(async (at) =>
    at("walk", async () => ({ outcome: "error", reason: "ProtocolError" })),
  );
  expect(result.diagnostic).toEqual({ stage: "walk", category: "protocol-error", source: "result" });
  expect(DiagnosticSchema.safeParse({ ...result.diagnostic, category: "PrivateToken123" }).success).toBe(false);
  expect(DiagnosticSchema.safeParse({ ...result.diagnostic, stage: "https://private.invalid" }).success).toBe(false);
});

it("keeps original five observations byte-exact and marks absent diagnostics unknown", () => {
  const path = "eval/frontier/multistep-results-2026-11-04.json";
  const bytes = readFileSync(path);
  const state = validateState(JSON.parse(bytes.toString()));
  expect(state.slots).toHaveLength(5);
  expect(state.slots.every((slot) => slot.report?.diagnostic === undefined)).toBe(true);
  const supplement = renderSupplement(state);
  expect(supplement).toContain(`"stage": "${UNKNOWN_DIAGNOSTIC.stage}"`);
  expect(supplement).toContain("Missing historical diagnostic fields remain unknown");
  expect(readFileSync(path)).toEqual(bytes);
  expect(sha256(bytes)).toBe("a95aac8db68b9bf64b98c7911450f286ed556819147f54d600f0704cf3b48c18");
});

it("binds exact prompt/settings to immutable source and rejects every omitted or mutated required field", () => {
  const state = validateState(JSON.parse(readFileSync("eval/frontier/multistep-results-2026-11-04.json", "utf8")));
  const config = sourceConfiguration(state.sourceSha);
  expect(config).toMatchObject({
    model: "muse-wonder-1.0",
    maxOutputTokens: 1024,
    screenshotsRetained: 2,
    transportAttempts: 1,
    stepLimit: 8,
    timeLimitMs: 60000,
    store: false,
    toolChoice: "auto",
    parallelToolCalls: false,
    promptSha256: "42e81eba1408c0680d3b1857517a7d35d6625b61b34075e1a83e524b9c94ace7",
  });
  const core = render(state),
    supplement = renderSupplement(state);
  const published = `${core}\nHistorical limits and observations remain here.\n${supplement}`;
  expect(() => verifyPublished(state, core, published)).not.toThrow();
  for (const [key, value] of Object.entries(config)) {
    const field = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    expect(published).toContain(field);
    expect(() => verifyPublished(state, core, published.replace(field, ""))).toThrow();
    expect(() => verifyPublished(state, core, published.replace(field, `${JSON.stringify(key)}: "altered"`))).toThrow();
  }
  expect(() => renderSupplement({ ...state, configuration: { ...config, promptSha256: "0".repeat(64) } })).toThrow(
    "persisted configuration",
  );
});

it("retains the reservation when a configured new cohort loses its required diagnostic", async () => {
  const t = experiment();
  const historical = validateState(JSON.parse(readFileSync("eval/frontier/multistep-results-2026-11-04.json", "utf8")));
  t.state.configuration = sourceConfiguration(historical.sourceSha);
  await expect(runNext(t.state, t.d)).rejects.toThrow("diagnostic");
  expect(t.state.slots[0]?.status).toBe("pending");
  expect(t.state.slots[0]?.costUsd).toBe(ALLOWANCE);
  expect(() => validateState({ ...historical, configuration: t.state.configuration })).toThrow("diagnostic");
});

it("preserves optional driver terminal metadata through report validation", () => {
  const state = validateState(
    JSON.parse(readFileSync("eval/frontier/multistep-recovery20261104-results.json", "utf8")),
  );
  const driverDiagnostic = { operation: "interception.fulfill", category: "protocol", networkCode: "ECONNRESET" };
  const report = ReportSchema.parse({ ...state.slots[0]?.report, driverDiagnostic });
  expect(report).toHaveProperty("driverDiagnostic", driverDiagnostic);
});

import { terminalDriverDiagnostic } from "../../eval/frontier/multistep-observation.ts";

it("keeps producer terminal attribution separate from adapter cleanup failures", async () => {
  const terminal = { operation: "interception.fulfill", category: "protocol", networkCode: "ECONNRESET" };
  const captured = await captureExecution(async (at) =>
    at("walk", async () => ({ outcome: "error", reason: "TypeError", diagnostic: terminal })),
  );
  const kept = terminalDriverDiagnostic(captured.result);
  const base = validateState(JSON.parse(readFileSync("eval/frontier/multistep-recovery20261104-results.json", "utf8")));
  const report = ReportSchema.parse({
    ...base.slots[0]?.report,
    diagnostic: captured.diagnostic,
    driverDiagnostic: kept,
    followupDiagnostics: [{ stage: "browser-close", category: "timeout", source: "exception" }],
  });
  expect(report.driverDiagnostic).toEqual(terminal);
  expect(report.diagnostic?.category).toBe("runtime-error");
  expect(report.followupDiagnostics?.[0]?.category).toBe("timeout");
  expect(terminalDriverDiagnostic(undefined)).toBeUndefined();
  expect(terminalDriverDiagnostic({})).toBeUndefined();
  expect(
    terminalDriverDiagnostic({ diagnostic: { operation: "containment.popup-close", category: "unknown" } }),
  ).toEqual({ operation: "containment.popup-close", category: "unknown" });
});

it("rejects hostile driver metadata without reflecting it or settling its reservation", async () => {
  const terminal = { operation: "navigation.goto", category: "error", networkCode: "ERR_CONNECTION_RESET" };
  const secret = "synthetic_private_sentinel";
  const malformed: unknown[] = [
    null,
    [],
    secret,
    {},
    { operation: "action" },
    { category: "error" },
    ...["operation", "category", "networkCode"].map((key) => ({ ...terminal, [key]: secret })),
    ...["message", "url", "headers", "dom", "canary", "cause"].map((key) => ({ ...terminal, [key]: secret })),
  ];
  for (const diagnostic of malformed) {
    expect(() => terminalDriverDiagnostic({ diagnostic })).toThrow("invalid driver diagnostic");
    try {
      terminalDriverDiagnostic({ diagnostic });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    const t = experiment(),
      perform = t.d.perform;
    t.d.perform = async (...args) => ({ ...ReportSchema.parse(await perform(...args)), driverDiagnostic: diagnostic });
    await expect(runNext(t.state, t.d)).rejects.toThrow();
    expect(t.state.slots[0]?.status).toBe("pending");
    expect(t.state.slots[0]?.costUsd).toBe(ALLOWANCE);
    expect(t.settlements()).toBe(0);
    expect(t.calls()).toBe(1);
    await expect(runNext(t.state, t.d)).rejects.toThrow("reconcile");
    expect(t.calls()).toBe(1);
  }
});

it("round trips driver metadata through real child/state files and interrupted settlement without replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "driver-metadata-"));
  try {
    const t = experiment(),
      perform = t.d.perform,
      settle = t.d.budget.settle;
    const terminal = { operation: "view.read", category: "unknown" };
    const child = join(dir, "child.json"),
      stateFile = join(dir, "state.json");
    t.d.perform = async (...args) => {
      const report = {
        ...ReportSchema.parse(await perform(...args)),
        driverDiagnostic: terminalDriverDiagnostic({ diagnostic: terminal }),
      };
      writeFileSync(child, JSON.stringify({ testResults: [{ assertionResults: [{ meta: { multistep: report } }] }] }));
      return readChildReport(child, args[0], args[1]);
    };
    t.d.save = (state) => atomicState(stateFile, state);
    t.d.budget.settle = async () => {
      throw new Error("settlement interrupted");
    };
    await expect(runNext(t.state, t.d)).rejects.toThrow("settlement interrupted");
    const resumed = validateState(JSON.parse(readFileSync(stateFile, "utf8")));
    expect(resumed.slots[0]?.report?.driverDiagnostic).toEqual(terminal);
    t.d.budget.settle = settle;
    await reconcile(resumed, t.d);
    await reconcile(resumed, t.d);
    const final = validateState(JSON.parse(readFileSync(stateFile, "utf8")));
    expect(final.slots[0]?.report?.driverDiagnostic).toEqual(terminal);
    expect(t.calls()).toBe(1);
    expect(t.settlements()).toBe(1);
    const report = final.slots[0]?.report;
    expect(scoreWalk(report)).toEqual(scoreWalk({ ...report, driverDiagnostic: undefined }));
    const envelope = JSON.parse(readFileSync(child, "utf8"));
    envelope.testResults[0].assertionResults[0].meta.multistep.driverDiagnostic.networkCode = "not-allowed";
    writeFileSync(child, JSON.stringify(envelope));
    expect(() => readChildReport(child, 1, "reservation-1")).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("preserves both legacy supplements and verifies every present driver metadata field", () => {
  const published = readFileSync("docs/frontier-log.md", "utf8");
  for (const [path, expected] of [
    [
      "eval/frontier/multistep-results-2026-11-04.json",
      "a95aac8db68b9bf64b98c7911450f286ed556819147f54d600f0704cf3b48c18",
    ],
    [
      "eval/frontier/multistep-recovery20261104-results.json",
      "c8641eb58b014f5c6db88ffcd44cd87ac07f0e92b5de61b19b3fb2799a120561",
    ],
  ] as const) {
    const bytes = readFileSync(path),
      state = validateState(JSON.parse(bytes.toString()));
    expect(sha256(bytes)).toBe(expected);
    expect(renderSupplement(state)).not.toContain("driverDiagnostic");
    expect(published).toContain(renderSupplement(state).trim());
    const slot = state.slots[0];
    if (!slot?.report) throw new Error("fixture observation missing");
    slot.report.driverDiagnostic = {
      operation: "navigation.goto",
      category: "error",
      networkCode: "ERR_CONNECTION_RESET",
    };
    const core = render(state),
      supplement = renderSupplement(state),
      next = core + supplement;
    expect(() => verifyPublished(state, core, next)).not.toThrow();
    expect(() => verifyPublished(state, core, core)).toThrow();
    const omitted = structuredClone(state);
    if (omitted.slots[0]?.report) delete omitted.slots[0].report.driverDiagnostic;
    expect(() => verifyPublished(state, core, core + renderSupplement(omitted))).toThrow();
    for (const [key, value] of Object.entries(slot.report.driverDiagnostic)) {
      const field = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
      expect(() => verifyPublished(state, core, next.replace(field, ""))).toThrow();
      expect(() => verifyPublished(state, core, next.replace(field, `${JSON.stringify(key)}: "altered"`))).toThrow();
    }
  }
});
