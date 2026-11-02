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

async function flagged(orgId: string, domain: string, host: string) {
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
  it("investigates past the member cap, stops at its own bound, and leaves member usage untouched", async () => {
    const { orgId, domain } = await business();
    await registerLogo(orgId);
    const { admitCase } = await import("../../src/db/cases");
    // Seed monitor cases up to the bound minus one, all today.
    const { createCase } = await import("../../src/db/cases");
    const { MONITOR_CASES_PER_DAY } = await import("../../src/db/cap-rule");
    for (let i = 0; i < MONITOR_CASES_PER_DAY - 1; i++)
      await createCase(db, {
        orgId,
        channel: "upload",
        headersAvailable: false,
        uploadedBy: "monitor",
        sourceKind: "image",
        uploadName: `seed-${i}@x`,
        uploadMediaType: "image/jpeg",
      });
    const key = await flagged(orgId, domain, "allowance.example");
    const summary = await monitorPipeline(deps([]), orgId, "2026-11-01T00:00:00.000Z");
    expect(summary.investigated).toBe(1);
    // The bound is now full: a second flagged page creates no case and settles partial.
    const key2 = await flagged(orgId, domain, "allowance-two.example");
    const summary2 = await monitorPipeline(deps([]), orgId, "2026-11-01T00:00:00.000Z");
    expect(summary2.failed).toBe(1);
    const inv2 = await db
      .prepare("SELECT state, case_id FROM monitor_investigations WHERE org_id = ? AND capture_key = ?")
      .bind(orgId, key2)
      .first<{ state: string; case_id: string | null }>();
    expect(inv2?.state).toBe("partial");
    expect(inv2?.case_id).toBeNull();
    // Member usage is untouched by the monitor cases: a member case still admits.
    void key;
    const member = await admitCase(db, {
      orgId,
      channel: "upload",
      headersAvailable: false,
      uploadedBy: "member-1",
      sourceKind: "image",
      uploadName: "member-upload.jpg",
      uploadMediaType: "image/jpeg",
    });
    expect(member.ok).toBe(true);
  });
});
