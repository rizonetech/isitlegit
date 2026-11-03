import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { NO_TRUSTED_RESULTS } from "../../src/checks/auth";
import { bundled } from "../../src/checks/brands";
import { type CaseView, caseViewOf } from "../../src/checks/case-view";
import {
  type EvidenceDraft,
  OUTCOMES_PER_INSERT,
  readCheckOutcomes,
  readEvidence,
  saveEvidence,
} from "../../src/checks/evidence";
import { checks as registered } from "../../src/checks/index";
import { type Check, type CheckInput, CheckRegistry } from "../../src/checks/registry";
import { type CheckOutcome, runChecksWithOutcomes } from "../../src/checks/runner";
import { createCase } from "../../src/db/cases";
import { extractOriginal } from "../../src/intake/forward";
import { parseMessage, storeParsed } from "../../src/intake/parse";
import { parsedKey, putAttachment, putParsed, putRaw, rawKey, readArtefact, type Store } from "../../src/intake/store";
import { checks as checksStep } from "../../src/pipeline/analysis-workflow";
import { LZMA, plainHeader, rar5, sevenZip, zip } from "../fixtures/attachments/archives";
import { plainNames7z } from "../fixtures/attachments/lzma";
import { damagedThenProgramRtf, plainRtf } from "../fixtures/attachments/rtf";
import { damagedThenProgramZip } from "../fixtures/attachments/zips";
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
    // A ZIP of PDFs inside a ZIP is read whole since D02 T04 §8: every check ran, nothing left unopened.
    const nested = zip([{ name: "inner.zip", data: zipped }]);
    expect((await archiveOutcomes([["outer.zip", nested]])).map((o) => [o.check, o.outcome, o.reason])).toEqual([
      ["attachment.macro", "ran", null],
      ["attachment.encrypted_archive", "ran", null],
      ["attachment.executable", "ran", null],
    ]);
    // A damaged member beside a program: the program found, the member counted, the checks partial (D02 T04 §8).
    const damagedZip = Uint8Array.from(atob(damagedThenProgramZip), (c) => c.charCodeAt(0));
    const counted = await archiveOutcomes([["damaged.zip", damagedZip]]);
    expect(counted.map((o) => [o.check, o.outcome, o.reason, o.findings])).toEqual([
      ["attachment.macro", "partial", "1 archive member not read by content", 0],
      ["attachment.encrypted_archive", "ran", null, 0],
      ["attachment.executable", "partial", "1 archive member not read by content", 1],
    ]);
    // A member of a method not read (12, bzip2) and an encrypted one: each counted, the checks partial, stored
    // (completion review).
    const unread = zip([
      { name: "a.pdf", data: new Uint8Array(40), method: 12 },
      { name: "b.pdf", data: new Uint8Array(40), encrypted: true },
    ]);
    expect((await archiveOutcomes([["unread.zip", unread]])).map((o) => [o.check, o.outcome, o.reason])).toEqual([
      ["attachment.macro", "partial", "2 archive members not read by content"],
      ["attachment.encrypted_archive", "ran", null],
      ["attachment.executable", "partial", "2 archive members not read by content"],
    ]);
    // An RTF document: one without objects ran; one with a damaged object beside a program keeps the finding and is
    // partial (D02 T04 §9).
    const rtf = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    expect((await archiveOutcomes([["plain.rtf", rtf(plainRtf)]])).map((o) => [o.check, o.outcome])).toEqual([
      ["attachment.macro", "ran"],
      ["attachment.encrypted_archive", "ran"],
      ["attachment.executable", "ran"],
    ]);
    const objects = await archiveOutcomes([["letter.rtf", rtf(damagedThenProgramRtf)]]);
    expect(objects.map((o) => [o.check, o.outcome, o.reason, o.findings])).toEqual([
      ["attachment.macro", "partial", "1 embedded object not read", 0],
      ["attachment.encrypted_archive", "ran", null, 0],
      ["attachment.executable", "partial", "1 embedded object not read", 1],
    ]);
    // A cabinet attached as a PDF: its members are not read, so the checks are partial (D02 T04 §9's completion review).
    const cabinet = Uint8Array.of(0x4d, 0x53, 0x43, 0x46, 0, 0, 0, 0, ...new Uint8Array(200).fill(0x20));
    expect((await archiveOutcomes([["invoice.pdf", cabinet]])).map((o) => [o.check, o.outcome, o.reason])).toEqual([
      ["attachment.macro", "partial", "1 RAR, 7z or CAB archive's contents not read"],
      ["attachment.encrypted_archive", "ran", null],
      ["attachment.executable", "partial", "1 RAR, 7z or CAB archive's contents not read"],
    ]);
    // One a level deeper is named, not opened: still partial.
    const third = zip([{ name: "level2.zip", data: zip([{ name: "level3.zip", data: zipped }]) }]);
    expect((await archiveOutcomes([["outer.zip", third]])).map((o) => [o.check, o.outcome, o.reason])).toEqual([
      ["attachment.macro", "partial", "1 archive inside an archive not opened"],
      ["attachment.encrypted_archive", "partial", "1 archive inside an archive not opened"],
      ["attachment.executable", "partial", "1 archive inside an archive not opened"],
    ]);
    // A readable RAR or 7z: its encryption is read, its members are not (round 3).
    for (const [name, body] of [
      ["invoice.rar", rar5()],
      ["invoice.7z", sevenZip(plainHeader(LZMA))],
    ] as [string, Uint8Array][])
      expect(
        (await archiveOutcomes([[name, body]])).map((o) => [o.check, o.outcome, o.reason]),
        name,
      ).toEqual([
        ["attachment.macro", "partial", "1 RAR, 7z or CAB archive's contents not read"],
        ["attachment.encrypted_archive", "ran", null],
        ["attachment.executable", "partial", "1 RAR, 7z or CAB archive's contents not read"],
      ]);
    // D02 T04 §7: a 7z whose LZMA-compressed header cannot be decoded is not checked, beside an encrypted ZIP whose
    // finding still stands: the archive check is partial with one finding, never clean and never lost.
    const lzmaArchive = Uint8Array.from(atob(plainNames7z), (c) => c.charCodeAt(0));
    for (let i = 32 + 48 + 1; i < 32 + 48 + 12; i++) lzmaArchive[i] = (lzmaArchive[i] as number) ^ 0xa5;
    const locked = zip([{ name: "a.pdf", data: pdf, encrypted: true }]);
    const beside = await archiveOutcomes([
      ["corrupt.7z", lzmaArchive],
      ["locked.zip", locked],
    ]);
    expect(beside.find((o) => o.check === "attachment.encrypted_archive")).toEqual({
      check: "attachment.encrypted_archive",
      outcome: "partial",
      reason: "1 attachment could not be read",
      findings: 1,
    });
    // Each with what it saw since D02 T01 §7, and what it examined since D02 T01 §8.
    expect(await archiveOutcomes([["clean.zip", zipped]])).toEqual([
      {
        check: "attachment.macro",
        outcome: "ran",
        reason: null,
        findings: 0,
        summary: "1 read, none with macros",
        examined: { targets: ["clean.zip"], omitted: 0 },
      },
      {
        check: "attachment.encrypted_archive",
        outcome: "ran",
        reason: null,
        findings: 0,
        summary: "1 read, none encrypted",
        examined: { targets: ["clean.zip"], omitted: 0 },
      },
      {
        check: "attachment.executable",
        outcome: "ran",
        reason: null,
        findings: 0,
        summary: "1 read, none executable",
        examined: { targets: ["clean.zip"], omitted: 0 },
      },
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

// D02 T01 §4: the Worker version that ran each outcome, stored with it and read back.
describe("an outcome's revision", () => {
  // More outcomes than one statement takes, so the twelve-row split is crossed.
  const many: CheckOutcome[] = Array.from({ length: OUTCOMES_PER_INSERT * 2 + 1 }, (_, i) => ({
    check: `t.many${i}`,
    outcome: "ran",
    reason: null,
    findings: 0,
  }));

  it("is stored on every outcome of a set longer than one statement takes, and absent when none was given", async () => {
    const caseId = await newCase();
    await saveEvidence(db, caseId, [], undefined, undefined, many, "rev-a");
    const stored = (await readCheckOutcomes(db, caseId)) ?? [];
    expect(stored).toHaveLength(many.length);
    expect(stored.every((o) => o.revision === "rev-a")).toBe(true);
    expect(stored.map((o) => o.check)).toEqual(many.map((o) => o.check));
    const plain = await newCase();
    await saveEvidence(db, plain, [], undefined, undefined, many);
    expect(await readCheckOutcomes(db, plain)).toEqual(many);
  });

  it("leaves another case's revision alone, and keeps each run of one case its own", async () => {
    const first = await newCase();
    await saveEvidence(db, first, [], undefined, undefined, many.slice(0, 3), "rev-a");
    const other = await newCase();
    await saveEvidence(db, other, [], undefined, undefined, many.slice(0, 3), "rev-b");
    expect((await readCheckOutcomes(db, first))?.map((o) => o.revision)).toEqual(["rev-a", "rev-a", "rev-a"]);
    // A retry run of the first case (its run named as retryCase names it), checked under another revision.
    await db.prepare("UPDATE cases SET run_id = 'run-retry' WHERE id = ?").bind(first).run();
    await saveEvidence(db, first, [], undefined, undefined, many.slice(0, 2), "rev-c");
    expect((await readCheckOutcomes(db, first, first))?.map((o) => o.revision)).toEqual(["rev-a", "rev-a", "rev-a"]);
    expect((await readCheckOutcomes(db, first))?.map((o) => o.revision)).toEqual(["rev-c", "rev-c"]);
  });

  it("is the running Worker's version when the Workflow checks a case", async () => {
    const made = await createCase(db, {
      orgId: "org-outcomes",
      channel: "upload",
      headersAvailable: false,
      uploadedBy: "user-outcomes",
      sourceKind: "mail",
    });
    if (!made.ok) throw new Error(made.error.message);
    const caseId = made.value.id;
    await putRaw(store, caseId, forwards["inline-forward"]);
    const instance = await introspectWorkflowInstance(env.ANALYSIS, caseId);
    try {
      await instance.modify(async (m) => {
        await m.disableRetryDelays();
      });
      await env.ANALYSIS.create({ id: caseId, params: { caseId } });
      await instance.waitForStatus("complete");
    } finally {
      await instance.dispose();
    }
    const stored = (await readCheckOutcomes(db, caseId)) ?? [];
    expect(stored.length).toBeGreaterThan(0);
    expect(env.CF_VERSION_METADATA.id).toBeTruthy();
    expect(stored.every((o) => o.revision === env.CF_VERSION_METADATA.id)).toBe(true);
  });
});

// D01 T03 §12: the file check says why it does not apply, an uploaded email and a forward each in its own words.
describe("the uploaded-file check's reason", () => {
  it("names an uploaded email as checked as its message, and a forward as not uploaded", async () => {
    const { view } = await inlineView();
    const reasonFor = async (channel: "email" | "upload") =>
      (await runChecksWithOutcomes({ ...view, tenant: { ...view.tenant, channel } })).outcomes.find(
        (o) => o.check === "intake.upload",
      );
    expect(await reasonFor("email")).toMatchObject({
      outcome: "skipped",
      reason: "the case was forwarded, not uploaded",
    });
    expect(await reasonFor("upload")).toMatchObject({
      outcome: "skipped",
      reason: "an uploaded email is checked as the message it holds, not as a file",
    });
  });
});

// D02 T01 §7: what each check saw, stored with its outcome and read back with it; a summary that cannot be stored safely
// is dropped, never the outcome or the evidence.
describe("each check's result summary", () => {
  const sums = (entries: [string, Check["summary"], Partial<Check>?][]) => {
    const r = new CheckRegistry();
    for (const [name, summary, extra] of entries)
      r.register({ ...check(name, () => [said(name, 1)]), ...(summary ? { summary } : {}), ...(extra ?? {}) });
    return r;
  };

  it("stores a check's summary with its outcome and reads it back, absent when it gave none", async () => {
    const { caseId, view } = await inlineView();
    const r = sums([
      ["s.saw", () => "2, to fynbosfreight.example"],
      ["s.quiet", () => null],
      ["s.none", undefined],
    ]);
    const run = await runChecksWithOutcomes(view, r);
    await saveEvidence(db, caseId, run.items, r, undefined, run.outcomes);
    expect(await readCheckOutcomes(db, caseId)).toEqual([
      { check: "s.saw", outcome: "ran", reason: null, findings: 1, summary: "2, to fynbosfreight.example" },
      { check: "s.quiet", outcome: "ran", reason: null, findings: 1 },
      { check: "s.none", outcome: "ran", reason: null, findings: 1 },
    ]);
  });

  it("stores none for a skipped, partial or failed check, the outcome and its reason kept", async () => {
    const { caseId, view } = await inlineView();
    const said1 = () => "should not be stored";
    const r = sums([
      ["s.skipped", said1, { applies: () => "nothing to read" }],
      ["s.partial", said1, { partial: () => "one part was not read" }],
      [
        "s.failed",
        said1,
        {
          run: () => {
            throw new Error("down");
          },
        },
      ],
    ]);
    const run = await runChecksWithOutcomes(view, r);
    await saveEvidence(db, caseId, run.items, r, undefined, run.outcomes);
    const read = await readCheckOutcomes(db, caseId);
    expect(read?.map((o) => [o.check, o.outcome, o.summary])).toEqual([
      ["s.skipped", "skipped", undefined],
      ["s.partial", "partial", undefined],
      ["s.failed", "failed", undefined],
    ]);
    expect(read?.map((o) => o.reason)).toEqual(["nothing to read", "one part was not read", "Error"]);
  });

  it("drops a summary that throws, is empty, runs past 120 characters or is not plain, keeping outcome and evidence", async () => {
    const { caseId, view } = await inlineView();
    const r = sums([
      [
        "s.throws",
        () => {
          throw new Error("hostile");
        },
      ],
      ["s.empty", () => "  "],
      ["s.long", () => "x".repeat(121)],
      ["s.fits", () => "é".repeat(120)],
      ["s.bell", () => "rang\u0007"],
      ["s.bidi", () => "safe \u202egnp.exe"],
      ["s.line", () => "one\u2028two"],
      ["s.markup", () => "<b>bold</b>"],
    ]);
    const run = await runChecksWithOutcomes(view, r);
    await saveEvidence(db, caseId, run.items, r, undefined, run.outcomes);
    const read = (await readCheckOutcomes(db, caseId)) ?? [];
    expect(read.map((o) => [o.check, o.outcome, o.findings, o.summary ?? null])).toEqual([
      ["s.throws", "ran", 1, null],
      ["s.empty", "ran", 1, null],
      ["s.long", "ran", 1, null],
      ["s.fits", "ran", 1, "é".repeat(120)],
      ["s.bell", "ran", 1, null],
      ["s.bidi", "ran", 1, null],
      ["s.line", "ran", 1, null],
      ["s.markup", "ran", 1, null],
    ]);
    expect((await readEvidence(db, caseId)).length).toBe(8);
  });

  it("stores every summary of a set longer than one statement takes, within D1's hundred parameters", async () => {
    // Thirteen bindings a row (case, run, check, seq, outcome, reason, findings, revision, summary, data
    // revision, id, source, and the examined set since D02 T01 §8).
    expect(OUTCOMES_PER_INSERT * 13).toBeLessThanOrEqual(100);
    expect((OUTCOMES_PER_INSERT + 1) * 13).toBeGreaterThan(100);
    const { caseId, view } = await inlineView();
    const names = Array.from({ length: OUTCOMES_PER_INSERT * 2 + 1 }, (_, i) => `s.n${i}`);
    const r = sums(names.map((n): [string, Check["summary"]] => [n, () => `saw ${n}`]));
    const run = await runChecksWithOutcomes(view, r);
    await saveEvidence(db, caseId, run.items, r, undefined, run.outcomes);
    expect((await readCheckOutcomes(db, caseId))?.map((o) => o.summary)).toEqual(names.map((n) => `saw ${n}`));
  });

  it("refuses a summary past 120 characters at the database too", async () => {
    const caseId = await newCase();
    await expect(
      saveEvidence(db, caseId, [], new CheckRegistry(), undefined, [
        { check: "s.direct", outcome: "ran", reason: null, findings: 0, summary: "x".repeat(121) },
      ]),
    ).rejects.toThrow();
  });
});

// D02 T01 §6: the data a run judged by, stored beside its outcomes.
describe("an outcome's detection data", () => {
  const set = (n: number): CheckOutcome[] =>
    Array.from({ length: n }, (_, i) => ({
      check: `t.data${i}`,
      outcome: "ran",
      reason: null,
      findings: 0,
      summary: `saw ${i}`,
    }));

  it("keeps each run of one case its own table's revision and source under one Worker version", async () => {
    const caseId = await newCase();
    await saveEvidence(db, caseId, [], undefined, undefined, set(3), "worker-1", {
      revision: "2026-11-05",
      id: "aaaaaaaaaaaa",
      source: "kv",
    });
    const firstRun = (
      await db.prepare("SELECT run_id FROM check_outcomes WHERE case_id = ? LIMIT 1").bind(caseId).first<{
        run_id: string;
      }>()
    )?.run_id;
    // A retry run of the case (its run named as retryCase names it) falls back to the bundled table, same Worker version.
    await db.prepare("UPDATE cases SET run_id = 'run-retry' WHERE id = ?").bind(caseId).run();
    await saveEvidence(db, caseId, [], undefined, undefined, set(3), "worker-1", {
      revision: "2026-10-30",
      id: "bbbbbbbbbbbb",
      source: "bundled",
    });
    const first = await readCheckOutcomes(db, caseId, firstRun);
    const second = await readCheckOutcomes(db, caseId);
    expect(first?.map((o) => o.data)).toEqual(
      Array(3).fill({ revision: "2026-11-05", id: "aaaaaaaaaaaa", source: "kv" }),
    );
    expect(second?.map((o) => o.data)).toEqual(
      Array(3).fill({ revision: "2026-10-30", id: "bbbbbbbbbbbb", source: "bundled" }),
    );
    expect(first?.every((o) => o.revision === "worker-1")).toBe(true);
    expect(second?.every((o) => o.revision === "worker-1")).toBe(true);
  });

  it("tells two tables published under one revision date apart by their identity", async () => {
    const caseId = await newCase();
    await saveEvidence(db, caseId, [], undefined, undefined, set(2), "worker-1", {
      revision: "2026-11-05",
      id: "111111111111",
      source: "kv",
    });
    const firstRun = (
      await db.prepare("SELECT run_id FROM check_outcomes WHERE case_id = ? LIMIT 1").bind(caseId).first<{
        run_id: string;
      }>()
    )?.run_id;
    await db.prepare("UPDATE cases SET run_id = 'run-retry2' WHERE id = ?").bind(caseId).run();
    await saveEvidence(db, caseId, [], undefined, undefined, set(2), "worker-1", {
      revision: "2026-11-05",
      id: "222222222222",
      source: "kv",
    });
    expect((await readCheckOutcomes(db, caseId, firstRun))?.[0]?.data).toEqual({
      revision: "2026-11-05",
      id: "111111111111",
      source: "kv",
    });
    expect((await readCheckOutcomes(db, caseId))?.[0]?.data).toEqual({
      revision: "2026-11-05",
      id: "222222222222",
      source: "kv",
    });
  });

  it("stores and reads back every outcome of a set of several statements: its data, revision and summary", async () => {
    const caseId = await newCase();
    const many = set(OUTCOMES_PER_INSERT * 2 + 1);
    await saveEvidence(db, caseId, [], undefined, undefined, many, "worker-2", {
      revision: "2026-11-05",
      id: "cccccccccccc",
      source: "kv",
    });
    const stored = (await readCheckOutcomes(db, caseId)) ?? [];
    expect(stored).toHaveLength(many.length);
    expect(stored.map((o) => o.summary)).toEqual(many.map((o) => o.summary));
    expect(stored.every((o) => o.revision === "worker-2")).toBe(true);
    expect(
      stored.every((o) => o.data?.revision === "2026-11-05" && o.data.id === "cccccccccccc" && o.data.source === "kv"),
    ).toBe(true);
  });

  it("reads an outcome written before the columns existed with every field it had and no data", async () => {
    const caseId = await newCase();
    await db
      .prepare(
        `INSERT INTO check_outcomes (case_id, run_id, check_name, seq, outcome, reason, findings, revision, summary)
         VALUES (?, (SELECT COALESCE(run_id, id) FROM cases WHERE id = ?), 't.old', 1, 'ran', NULL, 2, 'worker-old', 'saw old')`,
      )
      .bind(caseId, caseId)
      .run();
    expect(await readCheckOutcomes(db, caseId)).toEqual([
      { check: "t.old", outcome: "ran", reason: null, findings: 2, revision: "worker-old", summary: "saw old" },
    ]);
  });

  it("stores nothing for a run with no recorded data, and the database refuses a source that is neither kv nor bundled", async () => {
    const caseId = await newCase();
    await saveEvidence(db, caseId, [], undefined, undefined, set(2));
    expect((await readCheckOutcomes(db, caseId))?.every((o) => o.data === undefined)).toBe(true);
    await expect(
      db
        .prepare("UPDATE check_outcomes SET data_revision = '2026-11-05', data_source = 'cache' WHERE case_id = ?")
        .bind(caseId)
        .run(),
    ).rejects.toThrow();
  });
});
