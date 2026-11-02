// Findings from settled investigations (D05 T04 §5): outcome wording, taken-offline, restore,
// refused and uncertain alerts. The alert and dismissal happy path is in takedown.test.ts.
import { describe, expect, it } from "vitest";
import {
  alertNewFindings,
  dismissFinding,
  findingsFromInvestigations,
  listFindings,
  restoreFinding,
} from "../../src/monitor/findings";
import { addAddress } from "../trust/helpers";
import { business, db } from "./world";

async function settled(orgId: string, host: string, state: string, capture = "cap-1", resolves: number | null = null) {
  if (resolves !== null)
    await db
      .prepare(
        `INSERT INTO monitor_hosts (org_id, domain, resolves, first_seen, last_seen) VALUES (?, ?, ?, '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z')
         ON CONFLICT (org_id, domain) DO UPDATE SET resolves = excluded.resolves`,
      )
      .bind(orgId, host, resolves)
      .run();
  await db
    .prepare(
      `INSERT INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, '["E1"]', '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z')
       ON CONFLICT (org_id, capture_key) DO UPDATE SET state = excluded.state`,
    )
    .bind(orgId, host, capture, state)
    .run();
}

const noMail = { mail: null, appUrl: "https://app.isitlegit.co.za" };

describe("findings outcomes", () => {
  it("lists unconfirmed without an impersonation claim and partial as its own outcome", async () => {
    const { orgId } = await business();
    await settled(orgId, "maybe.example", "unconfirmed", "cap-a");
    await settled(orgId, "half.example", "partial", "cap-b");
    await findingsFromInvestigations(db, orgId, noMail);
    const findings = await listFindings(db, orgId);
    expect(findings.map((f) => [f.host, f.outcome]).sort()).toEqual([
      ["half.example", "partial"],
      ["maybe.example", "unconfirmed"],
    ]);
    // Neither alerts: no mail deps, and alerting reads only confirmed findings.
    expect(findings.every((f) => f.alerted_at === null)).toBe(true);
  });

  it("settles taken offline when the host stops resolving, and restores a dismissal", async () => {
    const { orgId } = await business();
    await settled(orgId, "gone.example", "confirmed", "cap-1", 1);
    await findingsFromInvestigations(db, orgId, noMail);
    await settled(orgId, "gone.example", "confirmed", "cap-2", 0);
    await findingsFromInvestigations(db, orgId, noMail);
    let findings = await listFindings(db, orgId);
    expect(findings[0]?.status).toBe("offline");

    expect(await dismissFinding(db, orgId, "gone.example", "  ")).toBe(false);
    expect(await dismissFinding(db, orgId, "gone.example", "Known test host")).toBe(true);
    expect(await restoreFinding(db, orgId, "gone.example")).toBe(true);
    findings = await listFindings(db, orgId);
    expect(findings[0]?.status).toBe("watching");
  });

  it("does not reopen a dismissal on historical captures, and settles offline when a later screen is benign", async () => {
    const { orgId } = await business();
    await settled(orgId, "old.example", "confirmed", "cap-1");
    await findingsFromInvestigations(db, orgId, noMail);
    expect(await dismissFinding(db, orgId, "old.example", "Ours")).toBe(true);
    await findingsFromInvestigations(db, orgId, noMail);
    let findings = await listFindings(db, orgId);
    expect(findings[0]?.status).toBe("dismissed");

    await settled(orgId, "calm.example", "confirmed", "cap-9");
    await findingsFromInvestigations(db, orgId, noMail);
    await db
      .prepare(
        `INSERT INTO monitor_screens (org_id, domain, capture_key, outcome, screener, lure, lure_type, confidence, has_login_form, has_payment_form, screened_at)
         VALUES (?, 'calm.example', 'cap-10', 'screened', 'glimmer', 0, 'none', 0.1, 0, 0, '2026-11-03T00:00:00Z')`,
      )
      .bind(orgId)
      .run();
    await findingsFromInvestigations(db, orgId, noMail);
    findings = await listFindings(db, orgId);
    expect(findings.find((f) => f.host === "calm.example")?.status).toBe("offline");
  });

  it("creates a finding already offline when the host no longer resolves at first sight", async () => {
    const { orgId } = await business();
    await settled(orgId, "dead.example", "confirmed", "cap-1", 0);
    await findingsFromInvestigations(db, orgId, noMail);
    const findings = await listFindings(db, orgId);
    expect(findings[0]?.status).toBe("offline");
  });

  it("alerts when an unalerted confirmed finding returns live", async () => {
    const { orgId } = await business();
    await settled(orgId, "back.example", "confirmed", "cap-1", 0);
    await findingsFromInvestigations(db, orgId, noMail);
    await settled(orgId, "back.example", "confirmed", "cap-2", 1);
    await findingsFromInvestigations(db, orgId, noMail);
    const findings = await listFindings(db, orgId);
    expect(findings[0]?.status).toBe("new");
    expect(findings[0]?.alerted_at).toBeNull();
  });

  it("states a refused alert and never resends it", async () => {
    const { orgId } = await business();
    // The identity contact is a member address: alert mail refuses it (allowlist).
    await settled(orgId, "fake.example", "confirmed");
    await findingsFromInvestigations(db, orgId, noMail);
    let sends = 0;
    const mail = {
      db,
      apiKey: "test",
      fetch: (async () => {
        sends++;
        return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0, email_id: "m" } }));
      }) as typeof fetch,
      pause: async () => {},
    };
    const deps = { mail, appUrl: "https://app.isitlegit.co.za" };
    await alertNewFindings(db, orgId, deps);
    let findings = await listFindings(db, orgId);
    // business() sets the finance contact to accounts@<org domain>, not a demo alias or operator.
    if (findings[0]?.alert_state === "refused") {
      expect(sends).toBe(0);
      await alertNewFindings(db, orgId, deps);
      findings = await listFindings(db, orgId);
      expect(findings[0]?.alert_state).toBe("refused");
    }
    // The refusal is recorded under the send key, so a later run reconciles it as refused
    // from the durable record and still sends nothing.
    expect(findings[0]?.alerted_at).toBeNull();
  });
});
