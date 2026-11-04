// Spark's second look at a page Loupe flagged, before the walkthrough (D05 T04 §9): a flag Spark does not confirm stops
// there and is kept as a likely false positive; a confirmed one goes on; a page Spark screened itself is not asked again;
// a second look that cannot answer leaves the flag standing. Spark is the real Meta client on the real budget, with a
// stand-in transport; Loupe's verdict is the stub, so the question under test is the second look.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DAY_CAP_USD } from "../../src/meta/caps";
import { flaggedForWalkthrough } from "../../src/monitor/flagged";
import { type MonitorDeps, monitorOrg } from "../../src/monitor/run";
import { monitorDeps } from "../../src/monitor/workflow";
import { screened } from "../../src/vision/page-screen";
import { fakeJpeg } from "../fixtures/jpeg";
import { business, DAY_MS, db, live, NO_FORM, runRow, START, world } from "./world";

const KEYS = {
  FIREWORKS_API_KEY: "fw-key",
  GLIMMER_GATEWAY_URL: "https://gateway.test/v1/acct/isitlegit/custom-fireworks/v1",
  CF_AIG_TOKEN: "aig-token",
  META_API_KEY: "meta-key",
  META_GATEWAY_URL: "https://gateway.test/v1",
};
const LURE = {
  brand: "Kestrel Freight",
  has_login_form: true,
  has_payment_form: false,
  lure: true,
  lure_type: "credential",
  confidence: 0.92,
};
const BENIGN = { ...LURE, brand: null, has_login_form: false, lure: false, lure_type: "none", confidence: 0.05 };
const metaText = (body: string) =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: body }] }],
      usage: { input_tokens: 1200, output_tokens: 60 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );
const loupeFlag = () => ({
  ok: true as const,
  screen: screened({ ...LURE, lure_type: "credential" } as never, "glimmer"),
  glimmer_reason: null,
  spark_call: null,
  tier: "glimmer" as const,
  escalation: null,
  spark_calls: [],
});

// The real Spark path (monitorDeps's `second`) with Loupe's verdict stubbed to flag every page, for the hosts given.
function secondWorld(
  _b: Awaited<ReturnType<typeof business>>,
  hosts: string[],
  runId: string,
  sparkFetch: typeof fetch,
  screen?: MonitorDeps["screen"],
) {
  const real = monitorDeps({ ...env, ...KEYS } as unknown as Env, runId, { sparkFetch });
  const now = START.getTime();
  const deps = {
    ...real,
    now: () => new Date(now),
    resolve: async (h: string) => (hosts.includes(h) ? live("192.0.2.20") : { status: "none" as const }),
    capture: async (h: string) => ({
      screenshot: fakeJpeg(1280, 800, 30_000),
      text: `Sign in to ${h}`,
      parkText: `Sign in to ${h}`,
      url: `https://${h}/`,
      signals: NO_FORM,
    }),
    screen: screen ?? (async () => loupeFlag()),
    open: async () => ({ ctx: {}, burst: null, state: "unknown", reservedUntil: 0, lastRequestEnd: null }) as never,
    close: async () => null,
  } as unknown as MonitorDeps;
  return { deps };
}
const screens = async (orgId: string) =>
  (
    await db
      .prepare("SELECT * FROM monitor_screens WHERE org_id = ? ORDER BY domain")
      .bind(orgId)
      .all<Record<string, unknown>>()
  ).results;
const reset = async () => {
  await db.prepare("DELETE FROM model_spend").run();
};

describe("the second look's store", () => {
  it("adds the columns and refuses a made-up verdict, or one on a page Loupe did not flag", async () => {
    const b = await business();
    const insert = (extra: string, vals: unknown[], outcome = "screened", screener = "'glimmer'", lure = 1) =>
      db
        .prepare(
          `INSERT INTO monitor_screens (org_id, domain, capture_key, outcome, screener, brand, has_login_form, has_payment_form,
             lure, lure_type, confidence, screened_at, ${extra})
           VALUES (?, ?, ?, '${outcome}', ${screener}, NULL, 0, 0, ${lure}, '${lure ? "credential" : "none"}', 0.5, 'now', ${vals.map(() => "?").join(", ")})`,
        )
        .bind(b.orgId, `a${crypto.randomUUID().slice(0, 6)}.example`, "k", ...vals)
        .run();
    await expect(insert("second_look", ["maybe"])).rejects.toThrow();
    await expect(insert("second_look", ["declined"], "screened", "'spark'")).rejects.toThrow();
    await expect(insert("second_look", ["declined"], "screened", "'glimmer'", 0)).rejects.toThrow();
    // A declined verdict carries Spark's own: not a lure, type none.
    await expect(
      insert("second_look, second_look_lure, second_look_type", ["declined", 1, "credential"]),
    ).rejects.toThrow();
    await insert("second_look, second_look_lure, second_look_type", ["declined", 0, "none"]);
    await insert("second_look", ["unavailable"]);
    // An incomplete verdict is refused too, not waved through as unknown: a declined or confirmed look carries Spark's own.
    await expect(insert("second_look", ["declined"])).rejects.toThrow();
    await expect(insert("second_look", ["confirmed"])).rejects.toThrow();
    await expect(insert("second_look, second_look_lure", ["unavailable", 1])).rejects.toThrow();
    const plan = await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT domain FROM monitor_screens WHERE org_id = ? AND second_look = 'declined' AND screened_at >= ?",
      )
      .bind(b.orgId, "x")
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toContain("monitor_screens_declined");
    const run = await db.prepare("SELECT lures_declined, second_look_unavailable FROM monitor_runs LIMIT 1").first();
    expect(run === null || Object.keys(run).length === 2).toBe(true);
  });
});

describe("the second look in the run", () => {
  it("confirms a lure and declines a benign page, storing both verdicts, and keeps only the confirmed as a standing flag", async () => {
    await reset();
    const b = await business();
    const [lure, benign] = b.candidates.slice(0, 2) as [string, string];
    const asked: string[] = [];
    const sparkFetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body);
      asked.push(body);
      return metaText(JSON.stringify(body.includes(`Host: ${lure}`) ? LURE : BENIGN));
    }) as typeof fetch;
    const w = secondWorld(b, [lure, benign], "monitor-second-1", sparkFetch);
    const summary = await monitorOrg(w.deps, b.orgId, "monitor-second-1");
    expect(asked).toHaveLength(2);
    expect(summary).toMatchObject({ screened: 2, lures: 1, luresDeclined: 1, secondLookUnavailable: 0 });
    const rows = await screens(b.orgId);
    const by = (d: string) => rows.find((r) => r.domain === d);
    expect(by(lure)).toMatchObject({
      lure: 1,
      second_look: "confirmed",
      second_look_lure: 1,
      second_look_type: "credential",
    });
    expect(by(benign)).toMatchObject({
      lure: 1,
      second_look: "declined",
      second_look_lure: 0,
      second_look_type: "none",
    });
    expect(by(benign)?.second_look_call_id).toEqual(expect.any(String));
    expect(await runRow(b.orgId)).toMatchObject({ lures: 1, lures_declined: 1, second_look_unavailable: 0 });
    // The request is the screener's own: the host the monitor holds, the text in the untrusted block, under the second-look step.
    expect((asked[0] as string).match(/<<UNTRUSTED/g)).toHaveLength(1);
    // The call's own record, linked from the screening row: the monitor's run, the host it holds, the second-look step and
    // the model.
    const call = await db
      .prepare("SELECT owner, monitor_run, host, step, model, outcome FROM model_spend WHERE call_id = ?")
      .bind(by(lure)?.second_look_call_id)
      .first<Record<string, unknown>>();
    expect(call).toMatchObject({
      owner: "monitor",
      monitor_run: "monitor-second-1",
      step: "second-look",
      model: "muse-spark-1.3",
      outcome: "ok",
    });
    expect(call?.host).toBe(lure);
    // §4 takes only the confirmed one.
    const since = new Date(START.getTime() - DAY_MS).toISOString();
    expect((await flaggedForWalkthrough(db, b.orgId, since)).map((f) => f.domain)).toEqual([lure]);
  });

  it("does not ask for a page Spark screened itself, and never asks twice for one", async () => {
    await reset();
    const b = await business();
    const [site] = b.candidates as [string];
    let calls = 0;
    const sparkFetch = (async () => {
      calls++;
      return metaText(JSON.stringify(LURE));
    }) as typeof fetch;
    // Loupe is down, so Spark screens the page itself: its one call is the screening.
    const sparkScreen = async () => ({
      ok: true as const,
      screen: screened({ ...LURE, lure_type: "credential" } as never, "spark"),
      glimmer_reason: "deployment_missing" as const,
      spark_call: { callId: "c1", logId: "l1" },
      tier: "spark" as const,
      escalation: null,
      spark_calls: [{ callId: "c1", logId: "l1" }],
    });
    const w = secondWorld(b, [site], "monitor-second-2", sparkFetch, sparkScreen);
    await monitorOrg(w.deps, b.orgId, "monitor-second-2");
    expect(calls).toBe(0);
    expect(await screens(b.orgId)).toMatchObject([{ screener: "spark", lure: 1, second_look: null }]);
    // A rerun the same day finds nothing owed.
    await monitorOrg(w.deps, b.orgId, "monitor-second-2b");
    expect(calls).toBe(0);
    // And §4 takes it, with no second look.
    const since = new Date(START.getTime() - DAY_MS).toISOString();
    expect((await flaggedForWalkthrough(db, b.orgId, since)).map((f) => [f.domain, f.second_look])).toEqual([
      [site, null],
    ]);
  });

  it("keeps the flag when the second look cannot answer: a refused budget, an invalid answer and a transport failure", async () => {
    for (const kind of ["budget", "invalid", "transport"] as const) {
      await reset();
      const b = await business();
      const [first, second] = b.candidates.slice(0, 2) as [string, string];
      let sent = 0;
      const sparkFetch = (async () => {
        sent++;
        if (kind === "transport") throw new TypeError("network down");
        return metaText(kind === "invalid" ? '{"nonsense":true}' : JSON.stringify(LURE));
      }) as typeof fetch;
      if (kind === "budget")
        await db
          .prepare(
            "INSERT INTO model_spend (id, at, day, source, caller, model, attempt, estimate_usd, state) VALUES ('x', ?1, ?2, 'worker', 't', 'muse-spark-1.3', 1, 1000, 'reserved')",
          )
          .bind(new Date().toISOString(), new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10))
          .run();
      const w = secondWorld(b, [first, second], `monitor-second-${kind}`, sparkFetch);
      const summary = await monitorOrg(w.deps, b.orgId, `monitor-second-${kind}`);
      // Both pages are screened and both flags stand, the run partial; one page's failure never stopped the other.
      expect(summary, kind).toMatchObject({
        screened: 2,
        lures: 2,
        luresDeclined: 0,
        secondLookUnavailable: 2,
        outcome: "partial",
      });
      expect(await screens(b.orgId), kind).toMatchObject([
        { lure: 1, second_look: "unavailable", second_look_lure: null },
        { lure: 1, second_look: "unavailable", second_look_lure: null },
      ]);
      expect(
        summary.errors.some((e) => e.startsWith("second-look:")),
        kind,
      ).toBe(true);
      expect(await runRow(b.orgId), kind).toMatchObject({ second_look_unavailable: 2, outcome: "partial" });
      // An unavailable flag still goes to §4.
      const since = new Date(START.getTime() - DAY_MS).toISOString();
      expect(
        (await flaggedForWalkthrough(db, b.orgId, since)).map((f) => f.second_look),
        kind,
      ).toEqual(["unavailable", "unavailable"]);
      // The bound: a refused budget sends nothing; an invalid answer is repaired at most once; a transient failure is
      // retried by the shared client and no more (every attempt is the budget's to count).
      if (kind === "budget") expect(sent).toBe(0);
      else expect(sent, kind).toBeGreaterThan(0);
      expect(sent, kind).toBeLessThanOrEqual(2 * 4);
    }
  });

  it("repairs an invalid answer exactly once, and the repaired answer is the verdict", async () => {
    await reset();
    const b = await business();
    const [site] = b.candidates as [string];
    const answers = ['{"nonsense":true}', JSON.stringify(BENIGN)];
    let sent = 0;
    const sparkFetch = (async () => metaText(answers[sent++] ?? "{}")) as typeof fetch;
    const w = secondWorld(b, [site], "monitor-second-fix", sparkFetch);
    const summary = await monitorOrg(w.deps, b.orgId, "monitor-second-fix");
    expect(sent).toBe(2);
    expect(summary).toMatchObject({ lures: 0, luresDeclined: 1, secondLookUnavailable: 0 });
    expect(await screens(b.orgId)).toMatchObject([{ second_look: "declined" }]);
    // Both attempts are the budget's: two records for the one second look.
    const spent = await db
      .prepare("SELECT COUNT(*) AS n FROM model_spend WHERE step = 'second-look'")
      .first<{ n: number }>();
    expect(spent?.n).toBe(2);
  });

  it("stops the repair at the budget: the first attempt is billed, the refused repair sends nothing", async () => {
    await reset();
    // What one attempt is estimated at, read from a call that succeeds.
    const probe = await business();
    const [probeSite] = probe.candidates as [string];
    const ok = (async () => metaText(JSON.stringify(LURE))) as typeof fetch;
    await monitorOrg(
      secondWorld(probe, [probeSite], "monitor-second-probe", ok).deps,
      probe.orgId,
      "monitor-second-probe",
    );
    const estimate = (
      await db
        .prepare("SELECT estimate_usd AS e FROM model_spend WHERE step = 'second-look' LIMIT 1")
        .first<{ e: number }>()
    )?.e as number;
    expect(estimate).toBeGreaterThan(0);
    await reset();
    // Room for one attempt and not for a second: the day's cap less one estimate (and a hair) is already spent, so the first
    // attempt fits and, once it settles at its real cost, the repair no longer does.
    await db
      .prepare(
        "INSERT INTO model_spend (id, at, day, source, caller, model, attempt, estimate_usd, state) VALUES ('held', ?1, ?2, 'worker', 't', 'muse-spark-1.3', 1, ?3, 'reserved')",
      )
      .bind(
        new Date().toISOString(),
        new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10),
        DAY_CAP_USD - estimate - 0.0001,
      )
      .run();
    const b = await business();
    const [site] = b.candidates as [string];
    let sent = 0;
    const sparkFetch = (async () => {
      sent++;
      return metaText('{"nonsense":true}');
    }) as typeof fetch;
    const summary = await monitorOrg(
      secondWorld(b, [site], "monitor-second-cap", sparkFetch).deps,
      b.orgId,
      "monitor-second-cap",
    );
    // One request went out; the repair was refused by the budget and never sent.
    expect(sent).toBe(1);
    expect(summary).toMatchObject({ lures: 1, secondLookUnavailable: 1, outcome: "partial" });
    const refused = await db
      .prepare("SELECT COUNT(*) AS n FROM model_spend WHERE step = 'second-look' AND outcome = 'refused'")
      .first<{ n: number }>();
    expect(refused?.n).toBe(1);
  });

  it("reports an unavailable second look again when the run is retried, and repeats no second look", async () => {
    await reset();
    const b = await business();
    const [site] = b.candidates as [string];
    let sent = 0;
    const sparkFetch = (async () => {
      sent++;
      throw new TypeError("network down");
    }) as typeof fetch;
    const w = secondWorld(b, [site], "monitor-second-r1", sparkFetch);
    await monitorOrg(w.deps, b.orgId, "monitor-second-r1");
    const afterFirst = sent;
    expect(afterFirst).toBeGreaterThan(0);
    // The Workflow retries the step: a new attempt of the same day. The verdict is stored, so nothing is owed and nothing
    // is asked, and the counts and the partial outcome come from the store.
    const retry = await monitorOrg(w.deps, b.orgId, "monitor-second-r2");
    expect(sent).toBe(afterFirst);
    // The standing flag is reported again too: the unavailable second look left it standing.
    expect(retry).toMatchObject({ screened: 0, lures: 1, secondLookUnavailable: 1, outcome: "partial" });
    expect(await runRow(b.orgId)).toMatchObject({ second_look_unavailable: 1, outcome: "partial" });
  });
});

describe("the run's day", () => {
  it("counts only the rows of its own South African day, not the next day's screened by a late attempt", async () => {
    const b = await business();
    const w = world(START);
    const [site] = b.candidates as [string];
    w.answers.set(site, live("192.0.2.50"));
    // A row screened just after the next South African midnight (22:00 UTC), and one just before this day began.
    const put = (domain: string, at: string) =>
      db
        .prepare(
          `INSERT INTO monitor_screens (org_id, domain, capture_key, outcome, screener, brand, has_login_form, has_payment_form,
             lure, lure_type, confidence, screened_at, second_look)
           VALUES (?, ?, 'k', 'screened', 'glimmer', NULL, 0, 0, 1, 'credential', 0.5, ?, 'unavailable')`,
        )
        .bind(b.orgId, domain, at)
        .run();
    await put("late.example", "2026-11-02T22:00:01.000Z");
    await put("early.example", "2026-11-01T21:59:59.000Z");
    const run = await monitorOrg(w.deps, b.orgId, "day");
    expect(run).toMatchObject({ secondLookUnavailable: 0, luresDeclined: 0, lures: 0 });
    expect(await runRow(b.orgId)).toMatchObject({ day: "2026-11-02", second_look_unavailable: 0 });
  });
});

describe("what §4 takes", () => {
  it("returns the organisation's confirmed, unavailable, Spark-screened and unlooked-at lures, not a declined one, from `since`", async () => {
    const b = await business();
    const other = await business();
    const w = world(START);
    const [site] = b.candidates as [string];
    w.answers.set(site, live("192.0.2.40"));
    w.lures.add(site);
    // No second look is wired in this world: the lure stands as one stored before the second look existed.
    await monitorOrg(w.deps, b.orgId, "f1");
    const [otherSite] = other.candidates as [string];
    w.answers.set(otherSite, live("192.0.2.41"));
    w.lures.add(otherSite);
    await monitorOrg(w.deps, other.orgId, "f2");
    const before = new Date(START.getTime() - DAY_MS).toISOString();
    expect((await flaggedForWalkthrough(db, b.orgId, before)).map((f) => [f.domain, f.second_look])).toEqual([
      [site, null],
    ]);
    // Another organisation's lure is not returned, and the boundary is `screened_at >= since`.
    const row = await db
      .prepare("SELECT screened_at FROM monitor_screens WHERE org_id = ?")
      .bind(b.orgId)
      .first<{ screened_at: string }>();
    const at = row?.screened_at as string;
    expect(await flaggedForWalkthrough(db, b.orgId, at)).toHaveLength(1);
    expect(await flaggedForWalkthrough(db, b.orgId, new Date(Date.parse(at) + 1).toISOString())).toHaveLength(0);
    // A declined row is not returned.
    await db
      .prepare(
        "UPDATE monitor_screens SET second_look = 'declined', second_look_lure = 0, second_look_type = 'none' WHERE org_id = ?",
      )
      .bind(b.orgId)
      .run();
    expect(await flaggedForWalkthrough(db, b.orgId, before)).toEqual([]);
  });
});
