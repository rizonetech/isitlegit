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
import { parsedKey, putAttachment, putParsed, putRaw, rawKey, readArtefact, type Store } from "../../src/intake/store";
import { checks as checksStep } from "../../src/pipeline/analysis-workflow";
import { rar5, zip } from "../fixtures/attachments/archives";
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

  it("stores the archive checks as partial when an attachment could not be read, and ran when every one was", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n");
    const zipped = zip([{ name: "a.pdf", data: pdf }]);
    const miscounted = zipped.slice();
    miscounted[miscounted.length - 22 + 10] = 3;
    miscounted[miscounted.length - 22 + 8] = 3;
    const damaged: [string, Uint8Array][] = [
      ["m.zip", miscounted],
      ["c.rar", rar5({ encryptedAfter: 5_000 }).subarray(0, 2_000)],
      ["s.7z", new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
    ];
    const archiveOutcomes = async (files: [string, Uint8Array][]) => {
      const caseId = await newCase();
      await putRaw(store, caseId, new TextEncoder().encode("From: x@y.example\r\n\r\nSee attached.\r\n"));
      const attachments = [];
      for (const [name, body] of files) {
        const stored = await putAttachment(store, caseId, name, body, "application/octet-stream");
        attachments.push({
          key: stored.key,
          filename: name,
          mediaType: "application/octet-stream",
          contentId: null,
          disposition: "attachment",
          charset: null,
          bytes: stored.bytes,
        });
      }
      await putParsed(store, caseId, {
        headers: [],
        text: "See attached.",
        html: null,
        attachments,
        truncated: [],
        omitted: 0,
        forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
      });
      await checksStep(store, caseId, parsedKey(caseId), { orgId: "org-outcomes", channel: "email" }, async () => []);
      return ((await readCheckOutcomes(db, caseId)) ?? []).filter(
        (o) =>
          o.check.startsWith("attachment.") && o.check !== "attachment.type_mismatch" && o.check !== "attachment.html",
      );
    };
    for (const file of damaged)
      expect(await archiveOutcomes([file]), file[0]).toEqual([
        { check: "attachment.macro", outcome: "partial", reason: "1 attachment could not be read", findings: 0 },
        {
          check: "attachment.encrypted_archive",
          outcome: "partial",
          reason: "1 attachment could not be read",
          findings: 0,
        },
        { check: "attachment.executable", outcome: "partial", reason: "1 attachment could not be read", findings: 1 },
      ]);
    const nested = zip([{ name: "inner.zip", data: zipped }]);
    expect((await archiveOutcomes([["outer.zip", nested]])).map((o) => [o.check, o.outcome, o.reason])).toEqual([
      ["attachment.macro", "partial", "1 archive inside an archive not opened"],
      ["attachment.encrypted_archive", "partial", "1 archive inside an archive not opened"],
      ["attachment.executable", "partial", "1 archive inside an archive not opened"],
    ]);
    expect(await archiveOutcomes([["clean.zip", zipped]])).toEqual([
      { check: "attachment.macro", outcome: "ran", reason: null, findings: 0 },
      { check: "attachment.encrypted_archive", outcome: "ran", reason: null, findings: 0 },
      { check: "attachment.executable", outcome: "ran", reason: null, findings: 0 },
    ]);
  });

  it("stores what was not read as partial, and a message with no text as skipped (round 1)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    const caseOf = async (text: string | null, files: [string, string, Uint8Array][]) => {
      const caseId = await newCase();
      await putRaw(store, caseId, new TextEncoder().encode("From: x@y.example\r\n\r\n\r\n"));
      const attachments = [];
      for (const [name, type, body] of files) {
        const stored = await putAttachment(store, caseId, name, body, type);
        attachments.push({
          key: stored.key,
          filename: name,
          mediaType: type,
          contentId: null,
          disposition: "attachment",
          charset: null,
          bytes: stored.bytes,
        });
      }
      await putParsed(store, caseId, {
        headers: [],
        text,
        html: null,
        attachments,
        truncated: [],
        omitted: 0,
        forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
      });
      await checksStep(store, caseId, parsedKey(caseId), { orgId: "org-outcomes", channel: "email" }, async () => []);
      const stored = (await readCheckOutcomes(db, caseId)) ?? [];
      return (name: string) => stored.find((o) => o.check === name);
    };
    const imageOnly = await caseOf(null, [["photo.png", "image/png", png]]);
    expect(imageOnly("content.ai_instructions")).toMatchObject({ outcome: "skipped", reason: "no text was read" });
    const pdfOnly = await caseOf(null, [["invoice.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.7\n")]]);
    expect(pdfOnly("content.ai_instructions")).toMatchObject({
      outcome: "partial",
      reason: "1 text could not be read",
    });
    const many = await caseOf(
      "See attached.",
      Array.from({ length: 21 }, (_, i): [string, string, Uint8Array] => [
        `p${i}.png`,
        "image/png",
        png.slice().fill(i, 11),
      ]),
    );
    expect(many("attachment.type_mismatch")).toMatchObject({
      outcome: "partial",
      reason: "1 attachment could not be read",
    });
    const textOnly = await caseOf("Hello, the invoice is attached.", []);
    expect(textOnly("content.ai_instructions")).toMatchObject({ outcome: "ran", reason: null, findings: 0 });
  });

  it("stores a check whose own item says it did not check something as partial, predicate or not", async () => {
    const { view } = await inlineView();
    const r = new CheckRegistry();
    r.register(check("t.gap", () => [{ ...said("t.gap", 1), severity: "info", detail: { checked: false } }]));
    const { outcomes } = await runChecksWithOutcomes(view, r);
    expect(outcomes).toEqual([
      { check: "t.gap", outcome: "partial", reason: "part of what it reads could not be checked", findings: 1 },
    ]);
  });
});
