// The full pipeline on flagged pages (D05 T04 §4): a settled lure becomes a monitor case, is read,
// has its logo compared with the business's own registered logo, and is walked when it asks for a
// sign-in. External services are stubbed at the transport; the case, evidence and investigation
// rows are real D1.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readEvidence } from "../../src/checks/evidence";
import { d1Budget } from "../../src/meta/budget";
import { monitorPipeline, type PipelineDeps } from "../../src/monitor/pipeline";
import { fakeJpeg } from "../fixtures/jpeg";
import { business, db } from "./world";

const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };

const answer = (body: unknown) =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(body) }] }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );

const READING = {
  readings: [
    {
      image: "P1",
      claimed_brand: "Fynbos",
      requested_action: "log_in",
      urgency_cues: ["Sign in now"],
      visible_sender: null,
      payment_request: false,
      confidence: 0.9,
    },
  ],
};
const JUDGEMENT = { same_brand: true, brand_seen: "Fynbos", differences: [], confidence: 0.95 };

function stubFetch() {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (body.includes("logo_comparison")) return answer(JUDGEMENT);
    return answer(READING);
  }) as typeof fetch;
}

async function flagged(orgId: string, _domain: string, host: string) {
  const key = `monitor/${orgId}/${host}/2026-11-02T00:00:00.000Z/`;
  await env.ARTEFACTS.put(`${key}screenshot.jpg`, fakeJpeg(1280, 800, 30_000));
  await env.ARTEFACTS.put(`${key}text.txt`, `Fynbos Freight sign in to continue at ${host}.`);
  await db
    .prepare(
      `INSERT INTO monitor_hosts (org_id, domain, resolves, captured_at, capture_key, first_seen, last_seen)
       VALUES (?, ?, 1, '2026-11-02T00:00:00.000Z', ?, '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`,
    )
    .bind(orgId, host, key)
    .run();
  await db
    .prepare(
      `INSERT INTO monitor_screens (org_id, domain, capture_key, outcome, screener, brand, has_login_form,
         has_payment_form, lure, lure_type, confidence, screened_at, second_look, second_look_lure, second_look_type)
       VALUES (?, ?, ?, 'screened', 'glimmer', 'Fynbos', 1, 0, 1, 'credential', 0.9, '2026-11-02T00:00:00.000Z', 'confirmed', 1, 'credential')`,
    )
    .bind(orgId, host, key)
    .run();
  return key;
}

async function registerLogo(orgId: string, bytes = 4_000) {
  const key = `ident/${orgId}/logo.png`;
  await env.ARTEFACTS.put(key, fakeJpeg(200, 200, bytes));
  await db
    .prepare("UPDATE identities SET logo_r2_key = ?, logo_media_type = 'image/png' WHERE org_id = ?")
    .bind(key, orgId)
    .run();
}

function deps(walked: string[]): PipelineDeps {
  return {
    db,
    bucket: env.ARTEFACTS,
    store: { bucket: env.ARTEFACTS, db },
    kv: (env as unknown as { CACHE: KVNamespace }).CACHE,
    meta: {
      env: META,
      budget: d1Budget(db, { caller: "monitor-pipeline-test" }),
      random: () => 0.5,
      sleep: async () => {},
      fetch: stubFetch(),
    },
    walk: async (caseId) => {
      walked.push(caseId);
      return { outcome: "walked" };
    },
    cropLogo: async () => ({ bytes: fakeJpeg(100, 100, 2_000), mediaType: "image/png", label: "crop" }),
  };
}

describe("the monitor pipeline", () => {
  it("investigates a flagged page end to end and settles confirmed", async () => {
    const { orgId, domain } = await business();
    await registerLogo(orgId);
    const key = await flagged(orgId, domain, "fynbos-secure.example");
    const walked: string[] = [];
    const summary = await monitorPipeline(deps(walked), orgId, "2026-11-01T00:00:00.000Z");
    expect(summary.investigated).toBe(1);
    const row = await db
      .prepare("SELECT * FROM monitor_investigations WHERE org_id = ? AND capture_key = ?")
      .bind(orgId, key)
      .first<{ case_id: string; state: string; evidence_refs: string }>();
    expect(row?.state).toBe("confirmed");
    const evidence = await readEvidence(db, row?.case_id as string);
    const checks = evidence.map((e) => e.check);
    expect(checks).toContain("vision.logo_match");
    expect(checks).toContain("link.credential_form");
    expect(evidence.find((e) => e.check === "vision.logo_match")?.severity).toBe("high");
    expect(JSON.stringify(evidence)).not.toContain("ident/");
    expect(walked).toEqual([row?.case_id]);
    // A repeated run skips the settled investigation and walks nothing again.
    const again = await monitorPipeline(deps(walked), orgId, "2026-11-01T00:00:00.000Z");
    expect(again.skipped).toBe(1);
    expect(walked).toHaveLength(1);
  });

  it("uses each organisation's own logo and never walks without a form", async () => {
    const a = await business();
    const b = await business();
    await registerLogo(a.orgId, 5_000);
    await registerLogo(b.orgId, 9_000);
    await flagged(a.orgId, a.domain, "a-lure.example");
    await flagged(b.orgId, b.domain, "b-lure.example");
    const walked: string[] = [];
    // No form in this reading: requested_action none, so no trigger and no walk.
    const noForm = {
      readings: [{ ...READING.readings[0], requested_action: "none", payment_request: false }],
    };
    const references: number[] = [];
    const fetchNone = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (body.includes("logo_comparison")) {
        const images = [...body.matchAll(/data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)/g)];
        references.push(images.at(-1)?.[1]?.length ?? 0);
        return answer(JUDGEMENT);
      }
      return answer(noForm);
    }) as typeof fetch;
    const d = { ...deps(walked), meta: { ...deps(walked).meta, fetch: fetchNone } };
    await monitorPipeline(d, a.orgId, "2026-11-01T00:00:00.000Z");
    await monitorPipeline(d, b.orgId, "2026-11-01T00:00:00.000Z");
    expect(walked).toEqual([]);
    for (const org of [a.orgId, b.orgId]) {
      const row = await db
        .prepare("SELECT case_id FROM monitor_investigations WHERE org_id = ?")
        .bind(org)
        .first<{ case_id: string }>();
      const evidence = await readEvidence(db, row?.case_id as string);
      expect(evidence.some((e) => e.check === "vision.logo_match")).toBe(true);
      expect(JSON.stringify(evidence)).not.toContain("ident/");
    }
    // Each comparison received its own organisation's reference (distinct sizes, A then B).
    expect(references).toHaveLength(2);
    expect(references[0]).not.toBe(references[1]);
  });

  it("states an SVG registered logo not compared", async () => {
    const { orgId, domain } = await business();
    const key = `ident/${orgId}/logo.svg`;
    await env.ARTEFACTS.put(key, "<svg/>");
    await db
      .prepare("UPDATE identities SET logo_r2_key = ?, logo_media_type = 'image/svg+xml' WHERE org_id = ?")
      .bind(key, orgId)
      .run();
    await flagged(orgId, domain, "svg-lure.example");
    await monitorPipeline(deps([]), orgId, "2026-11-01T00:00:00.000Z");
    const row = await db
      .prepare("SELECT case_id, state FROM monitor_investigations WHERE org_id = ?")
      .bind(orgId)
      .first<{ case_id: string; state: string }>();
    const evidence = await readEvidence(db, row?.case_id as string);
    const logo = evidence.find((e) => e.check === "vision.logo_match");
    expect(logo?.detail).toMatchObject({ checked: false, reason: "registered-logo-svg" });
    expect(row?.state).toBe("partial");
  });

  it("states a missing capture partial and carries on", async () => {
    const { orgId, domain } = await business();
    await registerLogo(orgId);
    const key = await flagged(orgId, domain, "gone.example");
    await env.ARTEFACTS.delete(`${key}screenshot.jpg`);
    const later = await flagged(orgId, domain, "later.example");
    const summary = await monitorPipeline(deps([]), orgId, "2026-11-01T00:00:00.000Z");
    expect(summary.investigated).toBe(2);
    const laterRow = await db
      .prepare("SELECT state FROM monitor_investigations WHERE org_id = ? AND capture_key = ?")
      .bind(orgId, later)
      .first<{ state: string }>();
    expect(laterRow?.state).toBe("confirmed");
    const row = await db
      .prepare("SELECT state FROM monitor_investigations WHERE org_id = ? AND capture_key = ?")
      .bind(orgId, key)
      .first<{ state: string }>();
    expect(row?.state).toBe("partial");
  });
});

describe("the monitor allowance (D05 T04 §12)", () => {
  it("investigates when the member cap is exhausted, stops at 50 monitor cases with zero model calls, renders the refusal, and leaves the member's 50th slot open", async () => {
    const { orgId, domain } = await business();
    await registerLogo(orgId);
    const { admitCase, createCase, MEMBER_CASES_TODAY, MONITOR_CASES_PER_DAY, MONITOR_CASES_TODAY, sastDayStart } =
      await import("../../src/db/cases");
    const { ALLOWANCE_REFUSAL_REASON, parseAllowanceRefusal } = await import("../../src/monitor/pipeline");
    const { findingsFromInvestigations, listFindings } = await import("../../src/monitor/findings");
    const { takedownMarkdown } = await import("../../src/monitor/takedown");
    const { MonitorPage, outcomeWords } = await import("../../src/web/pages/monitor-view");

    const dayClock = new Date("2026-11-02T10:00:00.000Z");
    // Fill 49 of the 50 member slots today.
    for (let i = 0; i < 49; i++) {
      const m = await admitCase(
        db,
        {
          orgId,
          channel: "upload",
          headersAvailable: false,
          uploadedBy: "member-1",
          sourceKind: "image",
          uploadName: `member-${i}.jpg`,
          uploadMediaType: "image/jpeg",
        },
        dayClock,
      );
      expect(m.ok).toBe(true);
    }

    // Seed 49 monitor cases today.
    for (let i = 0; i < MONITOR_CASES_PER_DAY - 1; i++) {
      const c = await createCase(
        db,
        {
          orgId,
          channel: "upload",
          headersAvailable: false,
          uploadedBy: "monitor",
          sourceKind: "image",
          uploadName: `seed-${i}@x`,
          uploadMediaType: "image/jpeg",
        },
        dayClock,
      );
      expect(c.ok).toBe(true);
    }

    // Reverse proof: 49 monitor cases do not consume the member's 50th slot; the member admits their 50th case
    // and only the 51st member case is capped.
    const member50 = await admitCase(
      db,
      {
        orgId,
        channel: "upload",
        headersAvailable: false,
        uploadedBy: "member-1",
        sourceKind: "image",
        uploadName: "member-50.jpg",
        uploadMediaType: "image/jpeg",
      },
      dayClock,
    );
    expect(member50.ok).toBe(true);
    const member51 = await admitCase(
      db,
      {
        orgId,
        channel: "upload",
        headersAvailable: false,
        uploadedBy: "member-1",
        sourceKind: "image",
        uploadName: "member-51.jpg",
        uploadMediaType: "image/jpeg",
      },
      dayClock,
    );
    expect(member51.ok).toBe(false);
    if (!member51.ok) expect(member51.error.code).toBe("capped");

    // With the member cap completely exhausted (50/50), the 50th monitor slot still admits and investigates.
    await flagged(orgId, domain, "allowance.example");
    const summary = await monitorPipeline({ ...deps([]), now: () => dayClock }, orgId, "2026-11-01T00:00:00.000Z");
    expect(summary.investigated).toBe(1);

    const dayStart = sastDayStart(dayClock);
    const memberCount = await db
      .prepare(`SELECT ${MEMBER_CASES_TODAY()} AS n`)
      .bind(orgId, dayStart)
      .first<{ n: number }>();
    const monitorCount = await db
      .prepare(`SELECT ${MONITOR_CASES_TODAY()} AS n`)
      .bind(orgId, dayStart)
      .first<{ n: number }>();
    expect(memberCount?.n).toBe(50);
    expect(monitorCount?.n).toBe(MONITOR_CASES_PER_DAY);

    // The 51st monitor capture is refused: zero model calls, no case created, and readable allowance refusal persisted.
    let fetchCalls = 0;
    const countingDeps: PipelineDeps = {
      ...deps([]),
      now: () => dayClock,
      meta: {
        ...deps([]).meta,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          fetchCalls++;
          return stubFetch()(input, init);
        }) as typeof fetch,
      },
    };
    const key2 = await flagged(orgId, domain, "allowance-two.example");
    const summary2 = await monitorPipeline(countingDeps, orgId, "2026-11-01T00:00:00.000Z");
    expect(summary2.failed).toBe(1);
    expect(fetchCalls).toBe(0);

    const inv2 = await db
      .prepare("SELECT state, case_id, evidence_refs FROM monitor_investigations WHERE org_id = ? AND capture_key = ?")
      .bind(orgId, key2)
      .first<{ state: string; case_id: string | null; evidence_refs: string | null }>();
    expect(inv2?.state).toBe("partial");
    expect(inv2?.case_id).toBeNull();
    const parsedRefusal = parseAllowanceRefusal(inv2?.evidence_refs ?? null);
    expect(parsedRefusal).toEqual({
      reason: ALLOWANCE_REFUSAL_REASON,
      retrySastDay: "2026-11-03",
    });

    // Findings read-back, `/monitor` rendering, and takedown pack output expose the allowance refusal without citing a missing case.
    await findingsFromInvestigations(db, orgId, { mail: null, appUrl: "https://isitlegit.co.za" }, () => dayClock);
    const findings = await listFindings(db, orgId);
    const refusedFinding = findings.find((f) => f.host === "allowance-two.example");
    expect(refusedFinding?.case_id).toBeNull();
    expect(outcomeWords(refusedFinding?.outcome ?? "partial", refusedFinding?.evidence_refs)).toContain(
      ALLOWANCE_REFUSAL_REASON,
    );
    const pageHtml = String(
      MonitorPage({
        shell: {
          variant: "member",
          active: "monitor",
          organization: { id: orgId, name: "Fynbos" },
          otherOrganizations: [],
          monitorNew: 0,
          plan: { name: "Business" },
          user: { name: "Owner", role: "owner" },
        },
        findings: refusedFinding ? [refusedFinding] : [],
        evidence: {
          "allowance-two.example": [
            `${ALLOWANCE_REFUSAL_REASON}: no case was created before the daily monitor allowance rolled over; queued for retry on 2026-11-03 SAST.`,
          ],
        },
        shots: { "allowance-two.example": true },
        selected: "allowance-two.example",
        lastRunDay: "2026-11-02",
        partialRun: true,
      }),
    );
    expect(pageHtml).toContain(ALLOWANCE_REFUSAL_REASON);
    expect(pageHtml).not.toContain("/cases/");

    if (!refusedFinding) throw new Error("expected refusedFinding");
    const packMd = takedownMarkdown({
      finding: refusedFinding,
      contacts: {
        domain: "allowance-two.example",
        registrar: "Example Registrar",
        registrarAbuse: "abuse@registrar.example",
        ip: "192.0.2.1",
        network: "EXAMPLE-NET",
        networkAbuse: "abuse@net.example",
        unavailable: [],
      },
      evidenceSummaries: [],
      brandingConfirmed: false,
      screenshotName: "screenshot.jpg",
    });
    expect(packMd).toContain(ALLOWANCE_REFUSAL_REASON);
    expect(packMd).toContain("queued for retry on 2026-11-03 SAST");
    expect(packMd).not.toContain("The investigation evidence is on the case record.");
  });

  it("enforces concurrent last-slot admission, idempotent retry, organisation isolation, failed-admission slot release, and SAST rollover recovery across replaced captures", async () => {
    const a = await business();
    const b = await business();
    await registerLogo(a.orgId);
    await registerLogo(b.orgId);
    const { createCase, MONITOR_CASES_PER_DAY } = await import("../../src/db/cases");

    // 2026-11-02 23:50 SAST is 2026-11-02T21:50:00.000Z.
    const beforeMidnightSast = new Date("2026-11-02T21:50:00.000Z");
    for (let i = 0; i < MONITOR_CASES_PER_DAY - 1; i++) {
      await createCase(
        db,
        {
          orgId: a.orgId,
          channel: "upload",
          headersAvailable: false,
          uploadedBy: "monitor",
          sourceKind: "image",
          uploadName: `a-seed-${i}@x`,
          uploadMediaType: "image/jpeg",
        },
        beforeMidnightSast,
      );
    }

    // Failed attachment admission releases the 50th slot by marking the newly created case `failed` with no evidence.
    const failingKey = await flagged(a.orgId, a.domain, "raw-missing.example");
    const failingStoreDeps: PipelineDeps = {
      ...deps([]),
      now: () => beforeMidnightSast,
      store: {
        bucket: {
          ...env.ARTEFACTS,
          put: async () => {
            throw new Error("R2 write failed");
          },
        } as unknown as R2Bucket,
        db,
      },
    };
    const failSummary = await monitorPipeline(failingStoreDeps, a.orgId, "2026-11-01T00:00:00.000Z");
    expect(failSummary.failed).toBe(1);
    void failingKey;

    // An invocation interrupted after case creation (`state = 'investigating'`) and retried when R2 attachment storage
    // fails also records `RawMissing` and releases the 50th slot despite `caseId` having been adopted on recovery.
    const recoveredFailKey = await flagged(a.orgId, a.domain, "raw-missing-recovered.example");
    const preCreated = await createCase(
      db,
      {
        orgId: a.orgId,
        channel: "upload",
        headersAvailable: false,
        uploadedBy: "monitor",
        sourceKind: "image",
        uploadName: `raw-missing-recovered.example@${recoveredFailKey.replace(/\/$/, "").split("/").at(-1) ?? ""}`,
        uploadMediaType: "image/jpeg",
      },
      beforeMidnightSast,
    );
    expect(preCreated.ok).toBe(true);
    if (!preCreated.ok) throw new Error("expected preCreated case");
    await db
      .prepare(
        `INSERT INTO monitor_investigations (org_id, domain, capture_key, case_id, state, evidence_refs, created_at, updated_at)
         VALUES (?, 'raw-missing-recovered.example', ?, ?, 'investigating', NULL, ?, ?)`,
      )
      .bind(
        a.orgId,
        recoveredFailKey,
        preCreated.value.id,
        beforeMidnightSast.toISOString(),
        beforeMidnightSast.toISOString(),
      )
      .run();
    const recoveredFailSummary = await monitorPipeline(failingStoreDeps, a.orgId, "2026-11-01T00:00:00.000Z");
    expect(recoveredFailSummary.failed).toBe(1);

    // Because the failed admission released its slot, two concurrent callers racing for the 50th slot still see 1 open slot:
    // exactly one succeeds and one is capped; retrying the winning id returns the existing case.
    const [race1, race2] = await Promise.all([
      createCase(
        db,
        {
          id: "01JM0N1T0R1ASTS10T00000001",
          orgId: a.orgId,
          channel: "upload",
          headersAvailable: false,
          uploadedBy: "monitor",
          sourceKind: "image",
          uploadName: "race-1@x",
          uploadMediaType: "image/jpeg",
        },
        beforeMidnightSast,
      ),
      createCase(
        db,
        {
          id: "01JM0N1T0R1ASTS10T00000002",
          orgId: a.orgId,
          channel: "upload",
          headersAvailable: false,
          uploadedBy: "monitor",
          sourceKind: "image",
          uploadName: "race-2@x",
          uploadMediaType: "image/jpeg",
        },
        beforeMidnightSast,
      ),
    ]);
    expect([race1.ok, race2.ok].sort()).toEqual([false, true]);
    const winnerId = race1.ok ? "01JM0N1T0R1ASTS10T00000001" : "01JM0N1T0R1ASTS10T00000002";
    const retryWinner = await createCase(
      db,
      {
        id: winnerId,
        orgId: a.orgId,
        channel: "upload",
        headersAvailable: false,
        uploadedBy: "monitor",
        sourceKind: "image",
        uploadName: "race-retry@x",
        uploadMediaType: "image/jpeg",
      },
      beforeMidnightSast,
    );
    expect(retryWinner.ok).toBe(true);

    // Organisation isolation: Org B investigates normally on the same SAST day while Org A is capped.
    await flagged(b.orgId, b.domain, "b-isolated.example");
    const bSummary = await monitorPipeline(
      { ...deps([]), now: () => beforeMidnightSast },
      b.orgId,
      "2026-11-01T00:00:00.000Z",
    );
    expect(bSummary.investigated).toBe(1);

    // Org A's next capture before SAST midnight is refused at the allowance and skipped on a same-day retry.
    const cappedKey = await flagged(a.orgId, a.domain, "rollover-target.example");
    await db
      .prepare("UPDATE monitor_hosts SET capture_url = ? WHERE org_id = ? AND domain = ?")
      .bind("https://rollover-target.example/original-login", a.orgId, "rollover-target.example")
      .run();
    const cappedRun = await monitorPipeline(
      { ...deps([]), now: () => beforeMidnightSast },
      a.orgId,
      "2026-11-01T00:00:00.000Z",
    );
    expect(cappedRun.failed).toBe(1);

    let sameDayCalls = 0;
    const sameDayRetry = await monitorPipeline(
      {
        ...deps([]),
        now: () => new Date("2026-11-02T21:55:00.000Z"),
        meta: {
          ...deps([]).meta,
          fetch: (async (i, init) => {
            sameDayCalls++;
            return stubFetch()(i, init);
          }) as typeof fetch,
        },
      },
      a.orgId,
      "2026-11-01T00:00:00.000Z",
    );
    expect(sameDayRetry.skipped).toBeGreaterThanOrEqual(1);
    expect(sameDayCalls).toBe(0);

    // Replace the host's current capture in `monitor_hosts` and advance `since` past the original screening window:
    // after SAST midnight (2026-11-02T22:05:00.000Z = 2026-11-03 00:05 SAST), recovery still picks up `cappedKey`,
    // preserves its original capture_url, creates one case, and settles confirmed.
    await db
      .prepare(
        "UPDATE monitor_hosts SET capture_key = ?, capture_url = ?, captured_at = ? WHERE org_id = ? AND domain = ?",
      )
      .bind(
        `monitor/${a.orgId}/rollover-target.example/2026-11-03T00:01:00.000Z/`,
        "https://rollover-target.example/newer-unscreened",
        "2026-11-03T00:01:00.000Z",
        a.orgId,
        "rollover-target.example",
      )
      .run();
    const afterMidnightSast = new Date("2026-11-02T22:05:00.000Z");
    const recoveredRun = await monitorPipeline(
      { ...deps([]), now: () => afterMidnightSast },
      a.orgId,
      "2026-11-02T22:00:00.000Z",
    );
    expect(recoveredRun.investigated).toBe(1);

    const recoveredRow = await db
      .prepare("SELECT state, case_id, capture_url FROM monitor_investigations WHERE org_id = ? AND capture_key = ?")
      .bind(a.orgId, cappedKey)
      .first<{ state: string; case_id: string | null; capture_url: string | null }>();
    expect(recoveredRow?.state).toBe("confirmed");
    expect(recoveredRow?.case_id).toBeTruthy();
    expect(recoveredRow?.capture_url).toBe("https://rollover-target.example/original-login");

    // Repeated recovery produces no second case and skips the now-confirmed investigation.
    const secondRecovery = await monitorPipeline(
      { ...deps([]), now: () => afterMidnightSast },
      a.orgId,
      "2026-11-02T22:00:00.000Z",
    );
    expect(secondRecovery.investigated).toBe(0);
    const caseCount = await db
      .prepare("SELECT COUNT(*) AS n FROM cases WHERE org_id = ? AND uploaded_by = 'monitor' AND upload_name = ?")
      .bind(a.orgId, "rollover-target.example@2026-11-02T00:00:00.000Z")
      .first<{ n: number }>();
    expect(caseCount?.n).toBe(1);
  });
});
