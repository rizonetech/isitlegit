import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { citationValidation } from "../../src/agent/citations";
import { readValidationDiagnostics, recordValidationDiagnostic } from "../../src/agent/validation-diagnostics";
import { createCase } from "../../src/db/cases";
import { deliverValidationDiagnostic, type ValidationDiagnostic } from "../../src/meta/validation-diagnostics";

const diagnostic = (): ValidationDiagnostic => ({
  phase: "structured",
  callId: crypto.randomUUID(),
  attempt: 1,
  remaining: 1,
  issues: [{ category: "schema_invalid", path: ["confidence"] }],
});
async function fixture() {
  const made = await createCase(env.DB, { orgId: "org-diagnostics", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error("fixture");
  const d = diagnostic();
  await env.DB.prepare(`INSERT INTO model_spend(id, at, day, source, caller, model, case_id, estimate_usd, state, call_id, owner, step)
    VALUES(?, '2026-11-04T12:00:00Z', '2026-11-04', 'worker', 'verdict', 'muse-spark-1.3', ?, 0, 'settled', ?, 'case', 'verdict')`)
    .bind(crypto.randomUUID(), made.value.id, d.callId)
    .run();
  return { id: made.value.id, d };
}
describe("validation diagnostic persistence", () => {
  it("round trips safe records idempotently, rejects conflicting duplicates and cascades case retention", async () => {
    const { id, d } = await fixture();
    await recordValidationDiagnostic(env.DB, id, null, d);
    await recordValidationDiagnostic(env.DB, id, null, d);
    expect(await readValidationDiagnostics(env.DB, id, null)).toEqual([d]);
    await expect(
      recordValidationDiagnostic(env.DB, id, null, { ...d, issues: [{ category: "json_invalid", path: [] }] }),
    ).rejects.toThrow();
    await env.DB.prepare("DELETE FROM cases WHERE id = ?").bind(id).run();
    expect(
      (await env.DB.prepare("SELECT * FROM model_validation_diagnostics WHERE case_id = ?").bind(id).all()).results,
    ).toEqual([]);
  });
  it("refuses absent or cross-case calls, stale runs and stale reads", async () => {
    const { id, d } = await fixture();
    const other = await fixture();
    await expect(recordValidationDiagnostic(env.DB, other.id, null, d)).rejects.toThrow();
    await expect(recordValidationDiagnostic(env.DB, id, null, { ...d, callId: crypto.randomUUID() })).rejects.toThrow();
    await env.DB.prepare("UPDATE cases SET run_id = 'new-run' WHERE id = ?").bind(id).run();
    await expect(recordValidationDiagnostic(env.DB, id, null, d)).rejects.toThrow();
    await expect(readValidationDiagnostics(env.DB, id, null)).rejects.toThrow();
    await env.DB.prepare("UPDATE model_spend SET step = 'vision' WHERE call_id = ?").bind(d.callId).run();
    await expect(recordValidationDiagnostic(env.DB, id, "new-run", d)).rejects.toThrow();
    await env.DB.prepare("UPDATE model_spend SET step = 'verdict', owner = 'script' WHERE call_id = ?")
      .bind(d.callId)
      .run();
    await expect(recordValidationDiagnostic(env.DB, id, "new-run", d)).rejects.toThrow();
    await env.DB.prepare("UPDATE model_spend SET owner = 'case' WHERE call_id = ?").bind(d.callId).run();
    await recordValidationDiagnostic(env.DB, id, "new-run", d);
    expect(await readValidationDiagnostics(env.DB, id, "new-run")).toEqual([d]);
  });
  it("refuses foreign-key orphans and hostile metadata", async () => {
    const { id, d } = await fixture();
    await expect(
      env.DB.prepare("INSERT INTO model_validation_diagnostics VALUES ('missing', '', ?, 'structured', 1, ?)")
        .bind(d.callId, JSON.stringify(d))
        .run(),
    ).rejects.toThrow();
    for (const hostile of [
      { ...d, secret: "PASSWORD" },
      { ...d, remaining: 0 },
      { ...d, callId: "PASSWORD" },
      { ...d, issues: [{ category: "schema_invalid", path: ["PASSWORD"] }] },
      { ...d, issues: Array(5).fill(d.issues[0]) },
      { ...d, phase: "citation" },
    ])
      await expect(recordValidationDiagnostic(env.DB, id, null, hostile as ValidationDiagnostic)).rejects.toThrow();
    expect(await readValidationDiagnostics(env.DB, id, null)).toEqual([]);
  });
  it("bounds rejected and stalled delivery, preserves late writes and logs static messages only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending: Promise<unknown>[] = [];
      await deliverValidationDiagnostic(
        async () => {
          throw new Error("PASSWORD");
        },
        diagnostic(),
        (p) => pending.push(p),
      );
      let finish: () => void = () => {};
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await deliverValidationDiagnostic(
        () => wait,
        diagnostic(),
        (p) => pending.push(p),
      );
      expect(pending).toHaveLength(1);
      finish();
      await pending[0];
      expect(spy.mock.calls).toEqual([["diagnostic-write-failed"], ["diagnostic-write-late"]]);
    } finally {
      spy.mockRestore();
    }
  });
});

it("categorizes citation failures without retaining evidence values", () => {
  const cases = [
    [{ cited_evidence_ids: [], explanation: "" }, "no_citations"],
    [{ cited_evidence_ids: ["E999"], explanation: "[E999]" }, "unknown_evidence_id"],
    [{ cited_evidence_ids: ["E1"], explanation: "[E2]" }, "undeclared_marker"],
    [{ cited_evidence_ids: ["E1"], explanation: "" }, "unused_declared_id"],
    [{ cited_evidence_ids: ["E1"], explanation: "PRIVATE sentence." }, "sentence_without_marker"],
  ] as const;
  for (const [answer, category] of cases) {
    const result = citationValidation(answer, new Set(["E1", "E2"]));
    expect(result.issues.some((i) => i.category === category)).toBe(true);
    expect(JSON.stringify(result.issues)).not.toMatch(/E999|E1|E2|PRIVATE/);
  }
});
