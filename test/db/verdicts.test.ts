import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type EvidenceDraft, saveEvidence } from "../../src/checks/evidence";
import { createCase, setStatus } from "../../src/db/cases";
import { getVerdict, saveVerdict, storeVerdict } from "../../src/db/verdicts";

// D01 T01 §7: a case's verdict, written once, removed with its case.
const view = {
  verdict: "malicious" as const,
  headline: "This invoice asks you to pay a new bank account",
  confidence: 0.82,
  reasons: [
    { text: "The sender's domain was registered last week", evidenceIds: ["E1"] },
    { text: "The bank account changed", evidenceIds: ["E2", "E3"] },
  ],
  actions: ["Do not pay", "Call the supplier on a number you already have"],
  meaning: "Treat it as unsafe: do not pay anything it asks for.",
  source: "rules" as const,
};
const items = (n: number): EvidenceDraft[] =>
  Array.from({ length: n }, (_, i) => ({
    check: "not_checked",
    severity: "info",
    summary: `item ${i + 1}`,
    detail: {},
    artefacts: [],
  }));

async function newCase(orgId = "org-verdicts", evidence = 3) {
  const made = await createCase(env.DB, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  if (evidence) await saveEvidence(env.DB, made.value.id, items(evidence));
  return made.value.id;
}

describe("saveVerdict", () => {
  it("round-trips a view with reasons, actions and source, and answers a repeat with the same row", async () => {
    const id = await newCase();
    const first = await saveVerdict(env.DB, id, view);
    expect(first).toMatchObject({ ok: true, value: { caseId: id, ...view } });
    const again = await saveVerdict(env.DB, id, view);
    expect(again).toEqual(first);
    expect(await getVerdict(env.DB, id)).toEqual(first);
  });

  it("keeps no meaning as null, and reads a row from before reasons cited evidence as reasons that cite nothing", async () => {
    const id = await newCase();
    const { meaning: _meaning, ...without } = view;
    expect(await saveVerdict(env.DB, id, without)).toMatchObject({ ok: true, value: { meaning: null } });
    const old = await newCase("org-verdicts", 0);
    await env.DB.prepare(
      "INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at) VALUES (?, 'suspicious', 'h', 0.5, '[\"E1: an old reason\"]', '[\"act\"]', 'stub', 'now')",
    )
      .bind(old)
      .run();
    expect(await getVerdict(env.DB, old)).toMatchObject({
      ok: true,
      value: { reasons: [{ text: "E1: an old reason", evidenceIds: [] }], meaning: null },
    });
  });

  it("refuses a reason that cites nothing, a marker in its words and a malformed meaning, before writing", async () => {
    const id = await newCase();
    for (const bad of [
      { ...view, reasons: [{ text: "no ids", evidenceIds: [] }] },
      { ...view, reasons: [{ text: "see [E1]", evidenceIds: ["E1"] }] },
      { ...view, reasons: [{ text: "bad id", evidenceIds: ["x1"] }] },
      { ...view, meaning: "see [E2] for why" },
      { ...view, meaning: "x".repeat(301) },
      { ...view, meaning: "   " },
    ])
      expect(await saveVerdict(env.DB, id, bad)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(await getVerdict(env.DB, id)).toBeNull();
  });

  it("refuses an id the case does not have: another case's, an earlier run's, or one past its list", async () => {
    const id = await newCase("org-verdicts", 1);
    const other = await newCase("org-verdicts", 5);
    expect(other).not.toBe(id);
    // E3 exists only on the other case; E9 on neither.
    for (const ids of [["E3"], ["E1", "E9"]]) {
      const bad = { ...view, reasons: [{ text: "cites a stranger", evidenceIds: ids }] };
      expect(await saveVerdict(env.DB, id, bad)).toMatchObject({ ok: false, error: { code: "invalid" } });
    }
    // An earlier run's id: the case now runs under a new run, whose list holds one item.
    await env.DB.prepare("UPDATE evidence SET run_id = 'earlier' WHERE case_id = ?").bind(id).run();
    await env.DB.prepare("UPDATE cases SET run_id = 'later' WHERE id = ?").bind(id).run();
    const stale = { ...view, reasons: [{ text: "cites an earlier run", evidenceIds: ["E1"] }] };
    expect(await saveVerdict(env.DB, id, stale)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(await getVerdict(env.DB, id)).toBeNull();
  });

  it("holds the same refusals through the Workflow's store entry point", async () => {
    const id = await newCase("org-verdicts", 1);
    const other = await newCase("org-verdicts", 4);
    for (const status of ["running"] as const) await setStatus(env.DB, "org-verdicts", id, status);
    // An earlier run's id: the case now runs under a new run, whose list is empty.
    await env.DB.prepare("UPDATE evidence SET run_id = 'earlier' WHERE case_id = ?").bind(id).run();
    await env.DB.prepare("UPDATE cases SET run_id = 'later' WHERE id = ?").bind(id).run();
    const stale = { ...view, reasons: [{ text: "cites an earlier run", evidenceIds: ["E1"] }] };
    expect(await storeVerdict(env.DB, "org-verdicts", id, stale)).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    await env.DB.prepare("UPDATE cases SET run_id = NULL WHERE id = ?").bind(id).run();
    await env.DB.prepare("UPDATE evidence SET run_id = ? WHERE case_id = ?").bind(id, id).run();
    const bad = { ...view, reasons: [{ text: "cites a stranger", evidenceIds: ["E4"] }] };
    expect(await storeVerdict(env.DB, "org-verdicts", id, bad)).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(
      await storeVerdict(env.DB, "org-verdicts", id, { ...view, reasons: [{ text: "none", evidenceIds: [] }] }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(await getVerdict(env.DB, id)).toBeNull();
    const good = { ...view, reasons: [{ text: "the one item", evidenceIds: ["E1"] }] };
    expect(await storeVerdict(env.DB, "org-verdicts", id, good)).toMatchObject({
      ok: true,
      value: { meaning: view.meaning },
    });
    expect(other).not.toBe(id);
  });

  it("refuses a different view as a conflict and changes nothing", async () => {
    const id = await newCase();
    const first = await saveVerdict(env.DB, id, view);
    const other = await saveVerdict(env.DB, id, { ...view, verdict: "safe", headline: "Looks fine" });
    expect(other).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await getVerdict(env.DB, id)).toEqual(first);
  });

  it("refuses an invalid view and answers a database failure as a refusal", async () => {
    const id = await newCase();
    expect(await saveVerdict(env.DB, id, { ...view, confidence: 1.5 })).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    const broken = {
      prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("D1 down")) }) }),
    } as unknown as D1Database;
    expect(await saveVerdict(broken, id, view)).toMatchObject({ ok: false, error: { code: "database" } });
  });

  it("persists the floor outcome through save, the Workflow store, and replay (D04 T01 §11)", async () => {
    const floored = {
      ...view,
      floorApplied: { from: "safe" as const, to: "malicious" as const, evidenceIds: ["E1"], revision: "1" },
    };
    const id = await newCase();
    await setStatus(env.DB, "org-verdicts", id, "running");
    expect(await saveVerdict(env.DB, id, floored)).toMatchObject({
      ok: true,
      value: { floorApplied: floored.floorApplied },
    });
    // The production sequence: the Workflow's store step with the same view answers the stored row, twice.
    expect(await storeVerdict(env.DB, "org-verdicts", id, floored)).toMatchObject({
      ok: true,
      value: { floorApplied: floored.floorApplied },
    });
    expect(await storeVerdict(env.DB, "org-verdicts", id, floored)).toMatchObject({ ok: true });
    // A changed floor record is a conflict and alters nothing stored.
    const changed = { ...floored, floorApplied: { ...floored.floorApplied, to: "suspicious" as const } };
    expect(await saveVerdict(env.DB, id, changed)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await storeVerdict(env.DB, "org-verdicts", id, changed)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(await getVerdict(env.DB, id)).toMatchObject({ ok: true, value: { floorApplied: floored.floorApplied } });
    // A row stored before the floor column (its value null) reads back no record.
    const old = await newCase("org-verdicts", 0);
    await env.DB.prepare(
      "INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at) VALUES (?, 'suspicious', 'h', 0.5, '[]', '[]', 'stub', 'now')",
    )
      .bind(old)
      .run();
    expect(await getVerdict(env.DB, old)).toMatchObject({ ok: true, value: { floorApplied: null } });
  });

  it("reads the floor coverage states apart, and a record's revision (D04 T01 §13)", async () => {
    // Stored before the floor outcome was kept: unrecorded, never confused with a measured no-raise.
    const old = await newCase("org-verdicts", 0);
    await env.DB.prepare(
      "INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at) VALUES (?, 'suspicious', 'h', 0.5, '[]', '[]', 'stub', 'now')",
    )
      .bind(old)
      .run();
    expect(await getVerdict(env.DB, old)).toMatchObject({
      ok: true,
      value: { floorApplied: null, floorCoverage: "unrecorded" },
    });
    // A verdict stored now with no raise: measured.
    const plain = await newCase();
    expect(await saveVerdict(env.DB, plain, view)).toMatchObject({
      ok: true,
      value: { floorApplied: null, floorCoverage: "measured" },
    });
    // A raise: raised, with the revision of the rules that produced it.
    const raised = await newCase();
    const floored = {
      ...view,
      floorApplied: { from: "safe" as const, to: "malicious" as const, evidenceIds: ["E1"], revision: "1" },
    };
    expect(await saveVerdict(env.DB, raised, floored)).toMatchObject({
      ok: true,
      value: { floorApplied: floored.floorApplied, floorCoverage: "raised" },
    });
    // Identical replay through the Workflow store keeps the record; a changed revision conflicts.
    await setStatus(env.DB, "org-verdicts", raised, "running");
    expect(await storeVerdict(env.DB, "org-verdicts", raised, floored)).toMatchObject({ ok: true });
    const revised = {
      ...floored,
      floorApplied: { ...floored.floorApplied, revision: "2" },
    };
    expect(await saveVerdict(env.DB, raised, revised)).toMatchObject({ ok: false, error: { code: "conflict" } });
    // A new raise that names no revision is refused at both stores.
    const unnamed = {
      ...floored,
      floorApplied: { from: "safe" as const, to: "malicious" as const, evidenceIds: ["E1"] },
    };
    const fresh = await newCase();
    expect(await saveVerdict(env.DB, fresh, unnamed)).toMatchObject({ ok: false, error: { code: "invalid" } });
    await setStatus(env.DB, "org-verdicts", fresh, "running");
    expect(await storeVerdict(env.DB, "org-verdicts", fresh, unnamed)).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(await getVerdict(env.DB, raised)).toMatchObject({
      ok: true,
      value: { floorApplied: floored.floorApplied },
    });
    // A record stored before revisions were named (no revision field) still parses and reads raised.
    const legacy = await newCase("org-verdicts", 0);
    await env.DB.prepare(
      "INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, floor_applied, created_at) VALUES (?, 'malicious', 'h', 0.5, '[]', '[]', 'agent', ?, 'now')",
    )
      .bind(legacy, JSON.stringify({ from: "safe", to: "malicious", evidenceIds: ["E1"] }))
      .run();
    expect(await getVerdict(env.DB, legacy)).toMatchObject({
      ok: true,
      value: { floorCoverage: "raised", floorApplied: { from: "safe", to: "malicious", evidenceIds: ["E1"] } },
    });
    // An identical replay of that historical revisionless raise answers its row at both stores (round 1),
    // using the stored row's own view, as the older implementation produced it.
    const storedLegacy = await getVerdict(env.DB, legacy);
    expect(storedLegacy).toMatchObject({ ok: true });
    if (storedLegacy?.ok) {
      const { caseId: _case, createdAt: _at, floorCoverage: _cov, ...rest } = storedLegacy.value;
      expect(await saveVerdict(env.DB, legacy, rest as never)).toMatchObject({ ok: true });
      await setStatus(env.DB, "org-verdicts", legacy, "running");
      await env.DB.prepare("UPDATE cases SET verdict = 'malicious' WHERE id = ?").bind(legacy).run();
      expect(await storeVerdict(env.DB, "org-verdicts", legacy, rest as never)).toMatchObject({ ok: true });
    }
    // A malformed stored floor value reads as unrecorded, never as a raise.
    const altered = await newCase("org-verdicts", 0);
    await env.DB.prepare(
      "INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, floor_applied, created_at) VALUES (?, 'suspicious', 'h', 0.5, '[]', '[]', 'stub', ' null ', 'now')",
    )
      .bind(altered)
      .run();
    expect(await getVerdict(env.DB, altered)).toMatchObject({
      ok: true,
      value: { floorApplied: null, floorCoverage: "unrecorded" },
    });
  });

  it("persists the ablation marker through save, the Workflow store, and replay (D04 T01 §14)", async () => {
    const ablated = { ...view, ablated: "no-agent-reasoning" as const };
    const id = await newCase();
    await setStatus(env.DB, "org-verdicts", id, "running");
    expect(await saveVerdict(env.DB, id, ablated)).toMatchObject({
      ok: true,
      value: { ablated: "no-agent-reasoning" },
    });
    expect(await getVerdict(env.DB, id)).toMatchObject({ ok: true, value: { ablated: "no-agent-reasoning" } });
    // An identical retry through the Workflow's store entry point answers the stored row.
    expect(await storeVerdict(env.DB, "org-verdicts", id, ablated)).toMatchObject({ ok: true });
    // A changed marker, and a dropped one, are conflicts and alter nothing stored.
    expect(await saveVerdict(env.DB, id, { ...ablated, ablated: "no-sam" as const })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(await saveVerdict(env.DB, id, view)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await getVerdict(env.DB, id)).toMatchObject({ ok: true, value: { ablated: "no-agent-reasoning" } });
    // An invalid marker is refused before writing.
    const fresh = await newCase();
    expect(await saveVerdict(env.DB, fresh, { ...view, ablated: "no-everything" as never })).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(await getVerdict(env.DB, fresh)).toBeNull();
    // A row stored before the marker column (its value null) reads back absent.
    const old = await newCase("org-verdicts", 0);
    await env.DB.prepare(
      "INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at) VALUES (?, 'suspicious', 'h', 0.5, '[]', '[]', 'stub', 'now')",
    )
      .bind(old)
      .run();
    expect(await getVerdict(env.DB, old)).toMatchObject({ ok: true, value: { ablated: null } });
  });

  it("is removed with its case while another case's verdict stays", async () => {
    const gone = await newCase();
    const kept = await newCase();
    await saveVerdict(env.DB, gone, view);
    await saveVerdict(env.DB, kept, view);
    await env.DB.prepare("DELETE FROM cases WHERE id = ?").bind(gone).run();
    expect(await getVerdict(env.DB, gone)).toBeNull();
    expect((await getVerdict(env.DB, kept))?.ok).toBe(true);
  });
});
