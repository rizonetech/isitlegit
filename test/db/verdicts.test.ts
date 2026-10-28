import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { getVerdict, saveVerdict } from "../../src/db/verdicts";

// D01 T01 §7: a case's verdict, written once, removed with its case.
const view = {
  verdict: "malicious" as const,
  headline: "This invoice asks you to pay a new bank account",
  confidence: 0.82,
  reasons: ["E1: the sender's domain was registered last week", "E3: the bank account changed"],
  actions: ["Do not pay", "Call the supplier on a number you already have"],
  source: "rules" as const,
};

async function newCase(orgId = "org-verdicts") {
  const made = await createCase(env.DB, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
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
