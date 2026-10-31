import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { NO_TRUSTED_RESULTS } from "../../src/checks/auth";
import { bundled } from "../../src/checks/brands";
import { type CaseView, caseViewOf } from "../../src/checks/case-view";
import { type EvidenceDraft, readCheckOutcomes, readEvidence, saveEvidence } from "../../src/checks/evidence";
import { checks as registered } from "../../src/checks/index";
import { type Check, type CheckInput, CheckRegistry } from "../../src/checks/registry";
import { type CheckOutcome, runChecksWithOutcomes } from "../../src/checks/runner";
import { createCase } from "../../src/db/cases";
import { extractOriginal } from "../../src/intake/forward";
import { parseMessage, storeParsed } from "../../src/intake/parse";
import { parsedKey, rawKey, readArtefact, type Store } from "../../src/intake/store";
import { checks as checksStep } from "../../src/pipeline/analysis-workflow";
import { forwards } from "../fixtures/forward/load";

// D02 T01 §3: each case's check outcomes stored with its evidence, read back without the registry.
const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db };

async function newCase() {
  const made = await createCase(db, { orgId: "org-outcomes", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}
// The inline forward carries no original headers, so a check that needs them is skipped.
async function inlineView(): Promise<{ caseId: string; view: CaseView }> {
  const caseId = await newCase();
  const forward = await extractOriginal(forwards["inline-forward"]);
  await storeParsed(store, caseId, await parseMessage(forward.original), forward);
  const read = await readArtefact(store, caseId, parsedKey(caseId));
  if (!read || !("body" in read)) throw new Error("no summary");
  const view = caseViewOf(
    JSON.parse(new TextDecoder().decode(read.body)),
    { orgId: "org-outcomes", channel: "email", receivers: [], trusted: { own: [], suppliers: [] } },
    rawKey(caseId),
    bundled,
  );
  return { caseId, view };
}
const said = (check: string, n: number): EvidenceDraft => ({
  check,
  severity: "low",
  summary: `${check} found item ${n}.`,
  detail: { n },
  artefacts: [],
});
const check = (name: string, run: Check["run"], needs: CheckInput[] = [], timeoutMs = 1_000): Check => ({
  name,
  needs,
  timeoutMs,
  run,
});
const registry = () => {
  const r = new CheckRegistry();
  r.register(check("t.clean", () => []));
  r.register(check("t.two", () => [said("t.two", 1), said("t.two", 2)]));
  r.register(check("t.headers", () => [said("t.headers", 1)], ["headers"]));
  r.register(check("t.slow", () => new Promise(() => {}), [], 20));
  r.register(
    check("t.throws", () => {
      throw new RangeError("hostile text that must not be stored");
    }),
  );
  return r;
};
const EXPECTED: CheckOutcome[] = [
  { check: "t.clean", outcome: "ran", reason: null, findings: 0 },
  { check: "t.two", outcome: "ran", reason: null, findings: 2 },
  { check: "t.headers", outcome: "skipped", reason: "the original's headers were not available", findings: 0 },
  { check: "t.slow", outcome: "failed", reason: "Timeout", findings: 0 },
  { check: "t.throws", outcome: "failed", reason: "RangeError", findings: 0 },
];

describe("check outcomes", () => {
  it("names each registered check's outcome in registration order: ran with its count, skipped, timed out, failed", async () => {
    const { view } = await inlineView();
    const { items, outcomes } = await runChecksWithOutcomes(view, registry());
    expect(outcomes).toEqual(EXPECTED);
    expect(items.filter((i) => i.check === "t.two")).toHaveLength(2);
  });

  it("stores them in the evidence's batch, once on a replay, and reads a retired check's name from the rows alone", async () => {
    const { caseId, view } = await inlineView();
    const r = registry();
    for (let i = 0; i < 2; i++) {
      const { items, outcomes } = await runChecksWithOutcomes(view, r);
      await saveEvidence(db, caseId, items, r, undefined, outcomes);
    }
    expect(await readCheckOutcomes(db, caseId)).toEqual(EXPECTED);
    // A check the registry no longer has, as a renamed or retired one would be: still read.
    await saveEvidence(db, caseId, [], new CheckRegistry(), undefined, [
      { check: "retired.check", outcome: "ran", reason: null, findings: 3 },
    ]);
    expect(await readCheckOutcomes(db, caseId)).toEqual([
      { check: "retired.check", outcome: "ran", reason: null, findings: 3 },
    ]);
  });

  it("replaces a set with a shorter one and with none, leaving another case's alone", async () => {
    const { caseId, view } = await inlineView();
    const other = await inlineView();
    const r = registry();
    const run = await runChecksWithOutcomes(view, r);
    await saveEvidence(db, caseId, run.items, r, undefined, run.outcomes);
    await saveEvidence(db, other.caseId, run.items, r, undefined, run.outcomes);
    const shorter: CheckOutcome[] = [{ check: "t.two", outcome: "ran", reason: null, findings: 1 }];
    await saveEvidence(db, caseId, [said("t.two", 9)], r, undefined, shorter);
    expect(await readCheckOutcomes(db, caseId)).toEqual(shorter);
    expect((await readEvidence(db, caseId)).map((e) => e.detail.n)).toEqual([9]);
    await saveEvidence(db, caseId, [], r, undefined, []);
    expect(await readCheckOutcomes(db, caseId)).toBeNull();
    expect(await readCheckOutcomes(db, other.caseId)).toEqual(EXPECTED);
  });

  it("keeps the previous evidence and outcomes when the combined batch fails, and leaves outcomes alone when given none", async () => {
    const { caseId, view } = await inlineView();
    const r = registry();
    const { items, outcomes } = await runChecksWithOutcomes(view, r);
    await saveEvidence(db, caseId, items, r, undefined, outcomes);
    const before = await readEvidence(db, caseId);
    // Different evidence and outcomes, the last outcome refused by its table inside the same batch.
    await expect(
      saveEvidence(db, caseId, [said("t.two", 7)], r, undefined, [
        { check: "t.two", outcome: "ran", reason: null, findings: 1 },
        { check: "t.clean", outcome: "ran", reason: "x".repeat(301), findings: 0 },
      ]),
    ).rejects.toThrow();
    expect(await readCheckOutcomes(db, caseId)).toEqual(EXPECTED);
    expect(await readEvidence(db, caseId)).toEqual(before);
    await saveEvidence(db, caseId, items, r);
    expect(await readCheckOutcomes(db, caseId)).toEqual(EXPECTED);
  });

  it("goes with its case when the case is deleted", async () => {
    const { caseId, view } = await inlineView();
    const r = registry();
    const { items, outcomes } = await runChecksWithOutcomes(view, r);
    await saveEvidence(db, caseId, items, r, undefined, outcomes);
    await db.prepare("DELETE FROM cases WHERE id = ?").bind(caseId).run();
    expect(await readCheckOutcomes(db, caseId)).toBeNull();
  });

  it("never runs a check whose applies names a reason, and such a check's run gives nothing for that view", async () => {
    const inline = (await inlineView()).view;
    const bare = { ...inline, attachments: [], attachmentHeads: null, attachmentRisks: null, htmlAttachments: null };
    let skipped = 0;
    for (const view of [inline, bare])
      for (const c of registered.all()) {
        const reason = c.applies?.(view);
        if (!reason) continue;
        skipped++;
        expect(await c.run(view, new AbortController().signal), `${c.name}: ${reason}`).toEqual([]);
      }
    expect(skipped).toBeGreaterThan(5);
  });

  it("stores an inline forward's authentication checks as skipped, beside checks that ran clean", async () => {
    const made = await createCase(db, { orgId: "org-outcomes", channel: "email", headersAvailable: false });
    if (!made.ok) throw new Error(made.error.message);
    const caseId = made.value.id;
    const forward = await extractOriginal(forwards["inline-forward"]);
    await storeParsed(store, caseId, await parseMessage(forward.original), forward);
    await checksStep(store, caseId, parsedKey(caseId), { orgId: "org-outcomes", channel: "email" }, async () => []);
    const stored = (await readCheckOutcomes(db, caseId)) ?? [];
    for (const name of ["auth.spf", "auth.dkim", "auth.dmarc", "auth.alignment"])
      expect(
        stored.find((o) => o.check === name),
        name,
      ).toMatchObject({ outcome: "skipped", reason: NO_TRUSTED_RESULTS });
    expect(stored.find((o) => o.check === "sender.reply_to")?.outcome).toBe("skipped");
    expect(stored.some((o) => o.outcome === "ran" && o.findings === 0)).toBe(true);
  });

  it("fails the step when the outcomes cannot be stored", async () => {
    const { caseId } = await inlineView();
    const failing = new Proxy(db, {
      get(target, key) {
        if (key === "batch") return async () => Promise.reject(new Error("D1 is unavailable"));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      checksStep(
        { bucket: env.ARTEFACTS, db: failing },
        caseId,
        parsedKey(caseId),
        { orgId: "org-outcomes", channel: "email" },
        async () => [],
      ),
    ).rejects.toThrow("D1 is unavailable");
    expect(await readCheckOutcomes(db, caseId)).toBeNull();
  });

  it("is stored by the checks step for every registered check, its counts matching the evidence", async () => {
    const { caseId } = await inlineView();
    await checksStep(store, caseId, parsedKey(caseId), { orgId: "org-outcomes", channel: "email" }, async () => []);
    const stored = (await readCheckOutcomes(db, caseId)) ?? [];
    expect(stored.map((o) => o.check)).toEqual(registered.all().map((c) => c.name));
    const evidence = await readEvidence(db, caseId);
    for (const o of stored.filter((s) => s.outcome === "ran"))
      expect(
        evidence.filter((e) => e.check === o.check),
        o.check,
      ).toHaveLength(o.findings);
  });
});
