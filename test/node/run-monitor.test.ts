// The production monitor runner's mechanics (D05 T04 §6), without paid calls: target resolution,
// demo eligibility checks, same-day existing-run correlation, bounded polling, and the full
// run -> capture -> confirmed investigation -> finding -> sent alert proof.
import { describe, expect, it } from "vitest";
import {
  checkOrgEligibility,
  executeMonitorRun,
  FIXTURE_HOST,
  FIXTURE_PATH,
  FYNBOS_ORG_ID,
  findingSatisfied,
  instanceIdFor,
  type MonitorRunProof,
  proofSatisfied,
  resolveTargetOrg,
} from "../../scripts/run-monitor";

describe("run-monitor mechanics", () => {
  it("resolves demo-fynbos to the protected Fynbos Freight organisation and names instances", () => {
    expect(resolveTargetOrg("demo-fynbos")).toBe(FYNBOS_ORG_ID);
    expect(resolveTargetOrg("org-explicit")).toBe("org-explicit");
    expect(resolveTargetOrg("   ")).toBeNull();
    expect(instanceIdFor("org-1", "2026-11-03")).toBe("monitor-org-1-2026-11-03");
    expect(instanceIdFor("org-1", "2026-11-03", "retry1")).toBe("monitor-org-1-2026-11-03-retry1");
  });

  it("checks demo eligibility, protection, domain, logo, monitor plan and alert recipient readiness", () => {
    const valid = {
      metadata: JSON.stringify({ demo: true }),
      createdAt: "2026-10-31T16:04:18.996Z",
      plan: null,
      trialEndsAt: null,
      protectedFlag: 1,
      financeContact: "accounts@fynbosfreight.demo.isitlegit.co.za",
      logoKey: "ident/fynbos/logo.svg",
      verifiedDomains: ["fynbosfreight.demo.isitlegit.co.za"],
      verifiedAddresses: ["accounts@fynbosfreight.demo.isitlegit.co.za"],
      now: new Date("2026-11-03T12:00:00Z"),
    };
    expect(checkOrgEligibility(valid)).toEqual({
      ok: true,
      alertRecipient: "alerts@demo.isitlegit.co.za",
    });

    const ineligible = checkOrgEligibility({
      metadata: JSON.stringify({ demo: false }),
      createdAt: "2026-10-01T00:00:00Z",
      plan: null,
      trialEndsAt: null,
      protectedFlag: 0,
      financeContact: "unverified@example.org",
      logoKey: null,
      verifiedDomains: [],
      verifiedAddresses: [],
      now: new Date("2026-11-03T12:00:00Z"),
    });
    expect(ineligible).toEqual({
      ok: false,
      reasons: [
        "not-demo-org",
        "protection-off",
        "no-verified-domain",
        "no-registered-logo",
        "no-monitor-plan",
        "alert-recipient-unverified",
      ],
    });
  });

  it("accepts only a complete correlated chain from run through sent alert", () => {
    const start = "2026-11-03T01:00:00.000Z";
    expect(
      findingSatisfied(
        {
          host: FIXTURE_HOST,
          outcome: "confirmed",
          alert_state: "sent",
          alerted_at: "2026-11-03T01:05:30.000Z",
        },
        { state: "confirmed", updated_at: "2026-11-03T01:05:00.000Z" },
        start,
      ),
    ).toBe(true);
    expect(
      findingSatisfied({ host: FIXTURE_HOST }, { state: "confirmed", updated_at: "2026-11-02T01:05:00.000Z" }, start),
    ).toBe(false);
    expect(
      findingSatisfied(
        { host: FIXTURE_HOST, outcome: "confirmed", alert_state: "refused", alerted_at: null },
        { state: "confirmed", updated_at: "2026-11-03T01:05:00.000Z" },
        start,
      ),
    ).toBe(false);

    const baseInvestigation = {
      domain: FIXTURE_HOST,
      capture_key: "monitor/org-1/fixtures.isitlegit.co.za/2026-11-03T01:01:00.000Z/",
      case_id: "case-1",
      state: "confirmed",
      updated_at: "2026-11-03T01:04:00.000Z",
    };
    const baseFinding = {
      host: FIXTURE_HOST,
      capture_key: "monitor/org-1/fixtures.isitlegit.co.za/2026-11-03T01:01:00.000Z/",
      case_id: "case-1",
      outcome: "confirmed",
      alert_state: "sent",
      alerted_at: "2026-11-03T01:05:00.000Z",
    };
    const baseProof: MonitorRunProof = {
      expectedRunId: "monitor-org-1-2026-11-03",
      run: {
        run_id: "monitor-org-1-2026-11-03",
        outcome: "completed",
        finished_at: "2026-11-03T01:06:00.000Z",
      },
      capture: {
        domain: FIXTURE_HOST,
        capture_key: "monitor/org-1/fixtures.isitlegit.co.za/2026-11-03T01:01:00.000Z/",
        capture_url: "https://fixtures.isitlegit.co.za/pfx/fynbos-lookalike/",
        captured_at: "2026-11-03T01:01:00.000Z",
      },
      investigation: baseInvestigation,
      finding: baseFinding,
      mailSend: {
        send_key: `monitor-finding:org-1:${FIXTURE_HOST}`,
        status: "sent",
        updated_at: "2026-11-03T01:05:00.000Z",
      },
    };
    expect(proofSatisfied(baseProof, start)).toEqual({ ok: true });
    expect(
      proofSatisfied({ ...baseProof, investigation: { ...baseInvestigation, state: "unconfirmed" } }, start),
    ).toEqual({ ok: false, reason: "investigation-not-confirmed" });
    expect(
      proofSatisfied({ ...baseProof, finding: { ...baseFinding, alert_state: "failed", alerted_at: null } }, start),
    ).toEqual({ ok: false, reason: "alert-not-sent" });
    expect(
      proofSatisfied(
        { ...baseProof, mailSend: { send_key: "k", status: "refused", updated_at: "2026-11-03T01:05:00.000Z" } },
        start,
      ),
    ).toEqual({
      ok: false,
      reason: "mail-send-not-confirmed",
    });
    expect(
      proofSatisfied({ ...baseProof, finding: { ...baseFinding, alerted_at: "2026-11-02T23:59:59.000Z" } }, start),
    ).toEqual({
      ok: false,
      reason: "alert-historical-not-from-this-run",
    });
    expect(
      proofSatisfied(
        {
          ...baseProof,
          mailSend: {
            send_key: `monitor-finding:org-1:${FIXTURE_HOST}`,
            status: "sent",
            updated_at: "2026-11-02T23:59:59.000Z",
          },
        },
        start,
      ),
    ).toEqual({
      ok: false,
      reason: "alert-historical-not-from-this-run",
    });
  });

  it("handles same-day existing completed instances by starting a correlated instance, and exits properly on timeout or error", async () => {
    let clockMs = Date.parse("2026-11-03T10:00:00.000Z");
    const createdInstances: { id: string; params: Record<string, string> }[] = [];
    const baseQuery = async (sql: string) => {
      if (sql.includes('FROM "organization"'))
        return [{ metadata: '{"demo":true}', createdAt: "2026-10-31T16:04:18.996Z", plan: null, trial_ends_at: null }];
      if (sql.includes("FROM identities"))
        return [
          {
            protected: 1,
            finance_contact_email: "accounts@fynbosfreight.demo.isitlegit.co.za",
            logo_r2_key: "ident/logo.svg",
          },
        ];
      if (sql.includes("FROM org_domains")) return [{ domain: "fynbosfreight.demo.isitlegit.co.za" }];
      if (sql.includes("FROM org_addresses")) return [{ address: "accounts@fynbosfreight.demo.isitlegit.co.za" }];
      if (sql.includes("SELECT path FROM monitor_seeds")) return [{ path: FIXTURE_PATH }];
      if (sql.includes("FROM monitor_runs")) {
        const latestId = createdInstances.at(-1)?.id ?? `monitor-${FYNBOS_ORG_ID}-2026-11-03`;
        return [{ run_id: latestId, outcome: "completed", finished_at: "2026-11-03T10:02:00.000Z" }];
      }
      if (sql.includes("FROM monitor_hosts") && sql.startsWith("SELECT"))
        return [
          {
            domain: FIXTURE_HOST,
            capture_key: "monitor/f/2026-11-03T10:00:30.000Z/",
            capture_url: `https://${FIXTURE_HOST}/pfx/${FIXTURE_PATH}`,
            captured_at: "2026-11-03T10:00:30.000Z",
          },
        ];
      if (sql.includes("FROM monitor_investigations"))
        return [
          {
            domain: FIXTURE_HOST,
            capture_key: "monitor/f/2026-11-03T10:00:30.000Z/",
            case_id: "case-live-1",
            state: "confirmed",
            updated_at: "2026-11-03T10:01:30.000Z",
          },
        ];
      if (sql.includes("FROM monitor_findings"))
        return [
          {
            host: FIXTURE_HOST,
            capture_key: "monitor/f/2026-11-03T10:00:30.000Z/",
            case_id: "case-live-1",
            outcome: "confirmed",
            alert_state: "sent",
            alerted_at: "2026-11-03T10:01:45.000Z",
          },
        ];
      if (sql.includes("FROM mail_sends"))
        return [
          {
            send_key: `monitor-finding:${FYNBOS_ORG_ID}:${FIXTURE_HOST}`,
            status: "sent",
            updated_at: "2026-11-03T10:01:45.000Z",
          },
        ];
      return [];
    };

    // 1. Existing same-day instance returns 409 and is already "complete": runner creates a fresh correlated instance.
    const outcome = await executeMonitorRun(
      {
        account: "acc-1",
        now: () => new Date(clockMs),
        sleep: async (ms) => {
          clockMs += ms;
        },
        pollIntervalMs: 1_000,
        query: baseQuery,
        api: async (path, init) => {
          if (init?.method === "POST" && path.endsWith("/instances")) {
            const body = JSON.parse(String(init.body)) as { id: string; params: Record<string, string> };
            if (body.id === `monitor-${FYNBOS_ORG_ID}-2026-11-03`) {
              return new Response("conflict", { status: 409 });
            }
            createdInstances.push(body);
            return Response.json({ result: { id: body.id } });
          }
          return Response.json({ result: { status: "complete" } });
        },
      },
      { orgArg: "demo-fynbos", waitSeconds: 60 },
    );
    expect(outcome.exitCode).toBe(0);
    expect(createdInstances).toHaveLength(1);
    expect(createdInstances[0]?.id).toMatch(new RegExp(`^monitor-${FYNBOS_ORG_ID}-2026-11-03-`));
    expect(outcome.instanceId).toBe(createdInstances[0]?.id);

    // 2. Timeout exits 2.
    let timeoutClock = Date.parse("2026-11-03T10:00:00.000Z");
    const timedOut = await executeMonitorRun(
      {
        account: "acc-1",
        now: () => new Date(timeoutClock),
        sleep: async (ms) => {
          timeoutClock += ms;
        },
        pollIntervalMs: 5_000,
        query: baseQuery,
        api: async (path, init) => {
          if (init?.method === "POST") return Response.json({ result: { id: "x" } });
          if (path.includes("/instances/")) return Response.json({ result: { status: "running" } });
          return Response.json({});
        },
      },
      { orgArg: "demo-fynbos", waitSeconds: 10 },
    );
    expect(timedOut.exitCode).toBe(2);
    expect(timedOut.reason).toBe("timeout:running");

    // 3. Errored instance exits 1.
    const errored = await executeMonitorRun(
      {
        account: "acc-1",
        now: () => new Date("2026-11-03T10:00:00.000Z"),
        sleep: async () => {},
        query: baseQuery,
        api: async (_path, init) => {
          if (init?.method === "POST") return Response.json({ result: { id: "x" } });
          return Response.json({ result: { status: "errored" } });
        },
      },
      { orgArg: "demo-fynbos", waitSeconds: 10 },
    );
    expect(errored.exitCode).toBe(1);
    expect(errored.reason).toBe("workflow-errored");

    // 4. Rerun with a fresh confirmed investigation but a historical deduplicated alert exits 1.
    const historicalRerun = await executeMonitorRun(
      {
        account: "acc-1",
        now: () => new Date("2026-11-03T10:00:00.000Z"),
        sleep: async () => {},
        query: async (sql) => {
          if (sql.includes("FROM monitor_findings")) {
            return [
              {
                host: FIXTURE_HOST,
                capture_key: "monitor/f/2026-11-03T10:00:30.000Z/",
                case_id: "case-live-1",
                outcome: "confirmed",
                alert_state: "sent",
                alerted_at: "2026-11-03T09:50:00.000Z",
              },
            ];
          }
          if (sql.includes("FROM mail_sends")) {
            return [
              {
                send_key: `monitor-finding:${FYNBOS_ORG_ID}:${FIXTURE_HOST}`,
                status: "sent",
                updated_at: "2026-11-03T09:50:00.000Z",
              },
            ];
          }
          return baseQuery(sql);
        },
        api: async (path, init) => {
          if (init?.method === "POST" && path.endsWith("/instances")) {
            const body = JSON.parse(String(init.body)) as { id: string; params: Record<string, string> };
            createdInstances.push(body);
            return Response.json({ result: { id: body.id } });
          }
          return Response.json({ result: { status: "complete" } });
        },
      },
      { orgArg: "demo-fynbos", waitSeconds: 10 },
    );
    expect(historicalRerun.exitCode).toBe(1);
    expect(historicalRerun.reason).toBe("alert-historical-not-from-this-run");

    // 5. Stalled network request and stalled response-body read abort at the wait deadline and exit 2.
    let sawAbortSignal = false;
    const stalledFetch = await executeMonitorRun(
      {
        account: "acc-1",
        query: baseQuery,
        api: async (_path, init) => {
          if (init?.method === "POST") return Response.json({ result: { id: "x" } });
          return await new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              sawAbortSignal = true;
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          });
        },
      },
      { orgArg: "demo-fynbos", waitSeconds: 0.03 },
    );
    expect(sawAbortSignal).toBe(true);
    expect(stalledFetch.exitCode).toBe(2);
    expect(stalledFetch.reason).toBe("timeout:unknown");

    const stalledBody = await executeMonitorRun(
      {
        account: "acc-1",
        query: baseQuery,
        api: async (_path, init) => {
          if (init?.method === "POST") return Response.json({ result: { id: "x" } });
          return {
            ok: true,
            status: 200,
            json: () => new Promise(() => {}),
          } as unknown as Response;
        },
      },
      { orgArg: "demo-fynbos", waitSeconds: 0.03 },
    );
    expect(stalledBody.exitCode).toBe(2);
    expect(stalledBody.reason).toBe("timeout:unknown");

    // 6. Native DOMException TimeoutError from a stalled D1 query converts cleanly to exit 2.
    const nativeQueryTimeout = await executeMonitorRun(
      {
        account: "acc-1",
        query: async () => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
        api: async () => Response.json({}),
      },
      { orgArg: "demo-fynbos", waitSeconds: 10 },
    );
    expect(nativeQueryTimeout.exitCode).toBe(2);
    expect(nativeQueryTimeout.reason).toBe("timeout:unknown");

    // 7. When `monitor_runs.finished_at` is set after Step 1 (`run`) while the Workflow instance is still `"running"`
    // in Step 2 (`pipeline`), the runner joins the active instance instead of starting an overlapping suffixed instance.
    let activeChecks = 0;
    let postCalls = 0;
    let dnsResetCalls = 0;
    const joinedOutcome = await executeMonitorRun(
      {
        account: "acc-1",
        now: () => new Date("2026-11-03T10:01:00.000Z"),
        sleep: async () => {},
        pollIntervalMs: 10,
        query: async (sql) => {
          if (sql.includes("UPDATE monitor_hosts SET captured_dns_hash = NULL")) {
            dnsResetCalls++;
            return [];
          }
          if (sql.includes("FROM monitor_runs")) {
            return [
              {
                run_id: `monitor-${FYNBOS_ORG_ID}-2026-11-03`,
                started_at: "2026-11-03T10:00:00.000Z",
                outcome: "completed",
                finished_at: "2026-11-03T10:00:25.000Z",
              },
            ];
          }
          return baseQuery(sql);
        },
        api: async (_path, init) => {
          if (init?.method === "POST") {
            postCalls++;
            return Response.json({ result: { id: "unexpected" } });
          }
          activeChecks++;
          return Response.json({
            result: {
              id: `monitor-${FYNBOS_ORG_ID}-2026-11-03`,
              status: activeChecks === 1 ? "running" : "complete",
              start: "2026-11-03T10:00:00.000Z",
            },
          });
        },
      },
      { orgArg: "demo-fynbos", waitSeconds: 60 },
    );
    expect(joinedOutcome.exitCode).toBe(0);
    expect(joinedOutcome.instanceId).toBe(`monitor-${FYNBOS_ORG_ID}-2026-11-03`);
    expect(postCalls).toBe(0);
    expect(dnsResetCalls).toBe(0);
  });
});
