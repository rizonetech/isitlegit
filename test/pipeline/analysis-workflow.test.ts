import { env, introspectWorkflowInstance } from "cloudflare:test";
import { NonRetryableError } from "cloudflare:workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as agentModule from "../../src/agent/loop";
import { BRANDS_KEY, BrandTable, bundled, forgetBrandTable, tableId } from "../../src/checks/brands";
import type { ProtectedCandidates } from "../../src/checks/case-view";
import { SummaryRefused } from "../../src/checks/case-view";
import { readCheckOutcomes, readEvidence, saveEvidence } from "../../src/checks/evidence";
import { checks as checkRegistry } from "../../src/checks/index";
import { createCase, setStatus, setVerdict } from "../../src/db/cases";
import { getVerdict, saveVerdict, storeVerdict } from "../../src/db/verdicts";
import {
  parsedKey,
  putArtefact,
  putAttachment,
  putParsed,
  putRaw,
  putVisible,
  rawKey,
  readArtefact,
  type Store,
  StoreError,
} from "../../src/intake/store";
import { addSupplier, addSupplierAccount } from "../../src/invoice/ledger";
import { BudgetExceeded } from "../../src/meta/guard";
import {
  admit,
  checks,
  parse,
  recordFailure,
  reply,
  STUB_VERDICT,
  safely,
  verdict,
} from "../../src/pipeline/analysis-workflow";
import { recordEvent } from "../../src/pipeline/events";
import { bankKeys } from "../../src/trust/bank";
import { protectedIdentities, setIdentity } from "../../src/trust/identity";
import { storeVoice } from "../../src/voice/step";
import { bindExperiment } from "../fixtures/ablation";
import { forwards } from "../fixtures/forward/load";
import { msgs } from "../fixtures/msg/load";

// D01 T01 §7: the analysis Workflow through its binding, sleeps and retry delays disabled.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
// A forward's source, as the admit step answers it for an email case.
const MAIL = { channel: "email" as const, sourceKind: "mail" as const, headersAvailable: false };
const ORG = "org-workflow";
const TENANT = { orgId: ORG, channel: "email" as const };

async function caseWith(raw: Uint8Array | null) {
  const made = await createCase(env.DB, { orgId: ORG, channel: "email", headersAvailable: false });
  if (!made.ok) throw new Error(made.error.message);
  if (raw) await putRaw(store, made.value.id, raw);
  return made.value.id;
}

type Mods = Parameters<Awaited<ReturnType<typeof introspectWorkflowInstance>>["modify"]>[0];
async function run(caseId: string, modify?: Mods, instanceId = caseId) {
  const instance = await introspectWorkflowInstance(env.ANALYSIS, instanceId);
  try {
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.disableSleeps();
      if (modify) await modify(m);
    });
    await env.ANALYSIS.create({ id: instanceId, params: { caseId } });
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as { skipped?: boolean } | null;
    // A skipped run has no reply step to wait for, and a reply step that failed has no result.
    const reply = output?.skipped ? null : await instance.waitForStepResult({ name: "reply" }).catch(() => null);
    return { output, reply };
  } finally {
    await instance.dispose();
  }
}

const caseRow = (id: string) =>
  env.DB.prepare("SELECT status, verdict, headers_available FROM cases WHERE id = ?")
    .bind(id)
    .first<{ status: string; verdict: string | null; headers_available: number }>();
const events = async (id: string) =>
  (
    await env.DB.prepare("SELECT step, status, error FROM case_events WHERE case_id = ? ORDER BY id")
      .bind(id)
      .all<{ step: string; status: string; error: string | null }>()
  ).results;
const summary = async (id: string) => {
  const read = await readArtefact(store, id, parsedKey(id));
  if (!read || !("body" in read)) throw new Error("no summary");
  return JSON.parse(new TextDecoder().decode(read.body));
};

// A forward carrying, as an attached message, an original with a text body and a small PDF.
const ORIGINAL_PDF = "%PDF-1.4\n% invoice 77\n%%EOF\n";

// A minimal renderable PDF with one text page per entry, the generator the vision tests use.
function makePdf(texts: string[]): Uint8Array {
  const objects: string[] = [];
  const kids = texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${texts.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  texts.forEach((text, i) => {
    const page = 4 + i * 2;
    const content = 5 + i * 2;
    objects[page] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    const stream = `BT /F1 48 Tf 72 700 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
    objects[content] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) pdf += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function forwardWithOriginal() {
  const original = [
    "From: billing@fictional-supplier.example",
    "To: accounts@fictional-recipient.example",
    "Subject: Invoice 77 with new bank details",
    "Message-ID: <inv77@fictional-supplier.example>",
    'Content-Type: multipart/mixed; boundary="o"',
    "",
    "--o",
    "Content-Type: text/plain",
    "",
    "Please pay invoice 77 into our new account.",
    "--o",
    'Content-Type: application/pdf; name="invoice-77.pdf"',
    'Content-Disposition: attachment; filename="invoice-77.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa(ORIGINAL_PDF),
    "--o--",
    "",
  ].join("\r\n");
  return new TextEncoder().encode(
    [
      "From: boss@fictional-recipient.example",
      "To: check@isitlegit.co.za",
      "Subject: Fwd: Invoice 77",
      'Content-Type: multipart/mixed; boundary="f"',
      "",
      "--f",
      "Content-Type: text/plain",
      "",
      "Is this real?",
      "--f",
      "Content-Type: message/rfc822",
      "",
      original,
      "--f--",
      "",
    ].join("\r\n"),
  );
}

// A forward carrying `bytes` as an attached Outlook message.
function forwardWithMsg(bytes: Uint8Array) {
  const base64 = btoa(String.fromCharCode(...bytes)).replace(/.{76}/g, "$&\r\n");
  return new TextEncoder().encode(
    [
      "From: boss@fictional-recipient.example",
      "To: check@isitlegit.co.za",
      "Subject: Fwd: see attached",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "Is this real?",
      "--b",
      'Content-Type: application/vnd.ms-outlook; name="original.msg"',
      'Content-Disposition: attachment; filename="original.msg"',
      "Content-Transfer-Encoding: base64",
      "",
      base64,
      "--b--",
      "",
    ].join("\r\n"),
  );
}

describe("AnalysisWorkflow", () => {
  it("stores the checks' evidence, passes on its count, and the verdict reads it back", async () => {
    await env.DB.prepare("DELETE FROM sender_observations WHERE org_id = ?").bind(ORG).run();
    const id = await caseWith(forwards["attached-rfc822"]);
    const instance = await introspectWorkflowInstance(env.ANALYSIS, id);
    try {
      await instance.modify(async (m) => {
        await m.disableRetryDelays();
        await m.disableSleeps();
      });
      await env.ANALYSIS.create({ id, params: { caseId: id } });
      await instance.waitForStatus("complete");
      expect(await instance.waitForStepResult({ name: "checks" })).toEqual({ evidence: 4 });
      expect(await instance.waitForStepResult({ name: "verdict" })).toEqual({
        view: expect.objectContaining({ source: "rules" }),
        evidence: [
          { id: "E1", check: "intake.forward" },
          { id: "E2", check: "auth.results" },
          { id: "E3", check: "sender.first_time" },
          { id: "E4", check: "reputation.coverage" },
          // The vision step ran before the verdict and stated the pictures unread here (D03 T02 §3).
          { id: "E5", check: "vision.not_checked" },
        ],
      });
    } finally {
      await instance.dispose();
    }
    expect(await readEvidence(env.DB, id)).toMatchObject([
      { id: "E1", check: "intake.forward", severity: "info", detail: { path: "rfc822", otherOriginals: 0 } },
      // The organisation verified no domain, so its receiving system is not known (D02 T02 §1).
      { id: "E2", check: "auth.results", severity: "info", detail: { trusted: false, reason: "unknown-receiver" } },
      // The organisation's first case from this sender (D02 T02 §5).
      { id: "E3", check: "sender.first_time", severity: "low" },
      // What reputation could not check, said once (D02 T06 §4).
      { id: "E4", check: "reputation.coverage", severity: "info", detail: { checked: false } },
      { id: "E5", check: "vision.not_checked", severity: "info" },
    ]);
  });

  it("ablates the bound case walkthrough and retains an ordinary neighbour (D04 T02 §9)", async () => {
    const page = "https://phish-workflow.example/signin";
    const flagged = await caseWith(forwards["attached-rfc822"]);
    await saveEvidence(env.DB, flagged, [
      {
        check: "link.credential_form",
        severity: "high",
        summary: "A form asks for sign-in details.",
        detail: { page },
        artefacts: [],
      },
    ]);
    await bindExperiment(flagged, "no-walkthrough");
    await env.CACHE.put(`ablate:${ORG}`, "no-sam");
    try {
      await run(flagged, async (m) => {
        await m.mockStepResult({ name: "checks" }, { evidence: 1 });
      });
    } finally {
      await env.CACHE.delete(`ablate:${ORG}`);
    }
    const items = await readEvidence(env.DB, flagged);
    expect(items.find((e) => e.check === "walkthrough.ablated")?.detail).toMatchObject({
      ablated: "no-walkthrough",
      url: page,
    });
    // Cleared: the same organisation's next case is not ablated (its walk states it could not run here).
    const cleared = await caseWith(forwards["attached-rfc822"]);
    await saveEvidence(env.DB, cleared, [
      {
        check: "link.credential_form",
        severity: "high",
        summary: "A form asks for sign-in details.",
        detail: { page },
        artefacts: [],
      },
    ]);
    await run(cleared, async (m) => {
      await m.mockStepResult({ name: "checks" }, { evidence: 1 });
    });
    const clearedItems = await readEvidence(env.DB, cleared);
    expect(clearedItems.some((e) => e.check === "walkthrough.ablated")).toBe(false);
    // The walk ran its normal path and stated it could not run in this environment, not silently skipped.
    expect(clearedItems.some((e) => e.check === "walkthrough.not_checked")).toBe(true);
  });

  it("hands the verdict this case's stored evidence in its order, not_checked lines included", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    const other = await caseWith(forwards["inline-forward"]);
    const line = (check: string, n: number) => ({
      check,
      severity: "info" as const,
      summary: `Line ${n}.`,
      detail: { n },
      artefacts: [],
    });
    await saveEvidence(env.DB, other, [line("intake.forward", 9)]);
    await saveEvidence(env.DB, id, [line("intake.forward", 1), line("not_checked", 2), line("intake.truncated", 3)]);
    const instance = await introspectWorkflowInstance(env.ANALYSIS, id);
    try {
      await instance.modify(async (m) => {
        await m.disableRetryDelays();
        await m.disableSleeps();
        // The checks step's own write is replaced by the list stored above.
        await m.mockStepResult({ name: "checks" }, { evidence: 3 });
      });
      await env.ANALYSIS.create({ id, params: { caseId: id } });
      await instance.waitForStatus("complete");
      expect(await instance.waitForStepResult({ name: "verdict" })).toEqual({
        view: expect.objectContaining({ source: "rules" }),
        evidence: [
          { id: "E1", check: "intake.forward" },
          { id: "E2", check: "not_checked" },
          { id: "E3", check: "intake.truncated" },
          { id: "E4", check: "vision.not_checked" },
        ],
      });
    } finally {
      await instance.dispose();
    }
  });

  it("stores and reads back a floored verdict: critical evidence is malicious, whatever else the run found", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    const item = (check: string, severity: "info" | "critical", summary: string) => ({
      check,
      severity,
      summary,
      detail: {},
      artefacts: [],
    });
    await saveEvidence(env.DB, id, [
      item("intake.forward", "info", "Forwarded by the member."),
      item("attachment.executable", "critical", "A program is attached."),
    ]);
    const instance = await introspectWorkflowInstance(env.ANALYSIS, id);
    let reply: unknown;
    try {
      await instance.modify(async (m) => {
        await m.disableRetryDelays();
        await m.disableSleeps();
        await m.mockStepResult({ name: "checks" }, { evidence: 2 });
      });
      await env.ANALYSIS.create({ id, params: { caseId: id } });
      await instance.waitForStatus("complete");
      reply = await instance.waitForStepResult({ name: "reply" });
    } finally {
      await instance.dispose();
    }
    expect(await caseRow(id)).toMatchObject({ status: "done", verdict: "malicious" });
    const stored = await getVerdict(env.DB, id);
    expect(stored?.ok && stored.value).toMatchObject({
      verdict: "malicious",
      source: "rules",
      reasons: [{ text: "A program is attached.", evidenceIds: ["E2"] }],
    });
    expect(reply).toMatchObject({ state: { status: "ready", verdict: "malicious" } });
  });

  it("stores a safe verdict from a run with a check that timed out as partial, never a clean one", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    await saveEvidence(env.DB, id, [
      { check: "intake.forward", severity: "info", summary: "Forwarded by the member.", detail: {}, artefacts: [] },
      { check: "not_checked", severity: "info", summary: "The domain age check timed out.", detail: {}, artefacts: [] },
    ]);
    await run(id, (m) => m.mockStepResult({ name: "checks" }, { evidence: 2 }));
    const stored = await getVerdict(env.DB, id);
    expect(stored?.ok && stored.value).toMatchObject({
      verdict: "safe",
      headline: "No warning signs were found, but some checks could not run",
      reasons: [
        { text: "The domain age check timed out.", evidenceIds: ["E2"] },
        // The vision step could not read the pictures either, and states so as a reason (D03 T02 §3).
        { text: "The message's pictures were not read, so what they show was not checked.", evidenceIds: ["E3"] },
      ],
    });
  });

  it("ends an inline forward done with the rule-based verdict, two events a step, and the reply before done", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    const { reply } = await run(id);
    expect(await caseRow(id)).toMatchObject({ status: "done", verdict: "safe", headers_available: 0 });
    const verdict = await getVerdict(env.DB, id);
    // No original headers: a safe verdict on what could be checked, its confidence capped.
    expect(verdict?.ok && verdict.value).toMatchObject({
      verdict: "safe",
      // The agent could not run in this environment, so its rules fallback states the investigation as partial.
      headline: "No warning signs were found, but some checks could not run",
      confidence: 0.5,
      source: "rules",
    });
    expect(verdict?.ok && verdict.value.reasons.every((r) => r.evidenceIds.length > 0)).toBe(true);
    const steps = (await events(id)).map((e) => `${e.step}:${e.status}`);
    // The verdict step is the agent's now (D04 T01 §4): with no Meta key in this environment it records its
    // fallback and stores the rule-based verdict above.
    expect(steps).toEqual([
      ...["admit", "parse", "checks", "walkthrough", "vision", "invoice", "verification"].flatMap((s) => [
        `${s}:started`,
        `${s}:done`,
      ]),
      "verdict:started",
      "agent:failed",
      "verdict:done",
      ...["store", "reply", "finish"].flatMap((s) => [`${s}:started`, `${s}:done`]),
    ]);
    // No link in this forward leads to a form or a lure, so the walkthrough step ran and walked nothing (D04 T02 §6).
    expect((await readEvidence(env.DB, id)).some((e) => e.check.startsWith("walkthrough."))).toBe(false);
    // The reply step ran while the case was still running, with the ready state; nothing was mailed.
    // No forwarder on this case, so nothing to send (test/pipeline/reply-step.test.ts sends).
    expect(reply).toEqual({ state: { status: "ready", verdict: "safe" }, caseStatus: "running", mail: "none" });
    const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_sends WHERE case_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(sent?.n).toBe(0);
  });

  it("parses the attached original, not the forward, and keeps its header state", async () => {
    const id = await caseWith(forwards["attached-eml-file"]);
    await run(id);
    expect(await caseRow(id)).toMatchObject({ status: "done", headers_available: 1 });
    const stored = await summary(id);
    const subject = stored.headers.find((h: { name: string }) => h.name.toLowerCase() === "subject")?.value;
    expect(subject).toBe("Updated banking details");
    expect(stored.forward).toMatchObject({ path: "eml", headersAvailable: true });
  });

  it("applies a draft .msg's missing headers to the case and the summary, and stores its attachments", async () => {
    const id = await caseWith(forwardWithMsg(msgs.draft));
    await run(id);
    expect(await caseRow(id)).toMatchObject({ status: "done", headers_available: 0 });
    const stored = await summary(id);
    expect(stored.forward).toMatchObject({ path: "msg", headersAvailable: false });
    const pdf = stored.attachments.find((a: { filename: string }) => a.filename === "invoice-77.pdf");
    const bytes = await readArtefact(store, id, pdf.key);
    expect(bytes && "body" in bytes ? new TextDecoder().decode(bytes.body.subarray(0, 5)) : "").toBe("%PDF-");
  });

  it("ends a message the parsers refuse partial after one attempt, naming parse and ParseError", async () => {
    const id = await caseWith(forwardWithMsg(msgs.notAMsg));
    const { reply } = await run(id);
    expect(await caseRow(id)).toMatchObject({ status: "partial", verdict: null });
    const rows = await events(id);
    expect(rows.filter((e) => e.step === "parse" && e.status === "started")).toHaveLength(1);
    // The attempt's own end, then the step's failure, each once.
    expect(rows.filter((e) => e.step === "parse").map((e) => `${e.status}:${e.error}`)).toEqual([
      "started:null",
      "error:ParseError",
      "failed:ParseError",
    ]);
    expect(reply).toMatchObject({ state: { status: "partial", failedStep: "parse", errorClass: "ParseError" } });
  });

  it("recovers on the fourth attempt and ends partial after four failures", async () => {
    const recovered = await caseWith(forwards["inline-forward"]);
    await run(recovered, (m) => m.mockStepError({ name: "checks" }, new Error("down"), 3));
    expect((await caseRow(recovered))?.status).toBe("done");

    const failed = await caseWith(forwards["inline-forward"]);
    const { reply } = await run(failed, (m) => m.mockStepError({ name: "checks" }, new Error("down"), 4));
    expect(await caseRow(failed)).toMatchObject({ status: "partial", verdict: null });
    expect((await events(failed)).find((e) => e.status === "failed")).toEqual({
      step: "checks",
      status: "failed",
      error: "Error",
    });
    expect(reply).toMatchObject({ state: { status: "partial", failedStep: "checks" } });
  });

  it("ends partial naming parse, verification, store or reply when each fails on every attempt", async () => {
    for (const step of ["parse", "verification", "store", "reply"] as const) {
      const id = await caseWith(forwards["inline-forward"]);
      await run(id, (m) => m.mockStepError({ name: step }, new Error("down"), 4));
      expect((await caseRow(id))?.status, step).toBe("partial");
      // The agent's fallback records its own failed event inside the verdict step; the named step's is the one
      // this loop drives to failure.
      expect((await events(id)).find((e) => e.status === "failed" && e.step === step)?.step, step).toBe(step);
      expect(
        (await events(id)).some((e) => e.step === "finish"),
        step,
      ).toBe(false);
    }
  });

  it("retries a failed lookup rather than taking it for a missing case", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    const broken = {
      prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error("D1 down")) }) }),
    } as unknown as D1Database;
    await expect(admit(broken, id)).rejects.toThrow(/looking the case up: database/);
    await run(id, (m) => m.mockStepError({ name: "admit" }, new Error("database down"), 1));
    expect((await caseRow(id))?.status).toBe("done");
  });

  it("throws a refused event write, so the step retries it", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    // The real database, except that writing an event fails.
    const eventsDown = {
      prepare: (sql: string) =>
        sql.startsWith("INSERT INTO case_events")
          ? { bind: () => ({ run: () => Promise.reject(new Error("D1 down")) }) }
          : env.DB.prepare(sql),
    } as unknown as D1Database;
    await expect(admit(eventsDown, id)).rejects.toThrow(/recording admit: database/);
    expect(await events(id)).toEqual([]);
  });

  it("retries a parse that fails once and still ends done", async () => {
    const id = await caseWith(forwards["attached-eml-file"]);
    await run(id, (m) => m.mockStepError({ name: "parse" }, new Error("R2 down"), 1));
    expect(await caseRow(id)).toMatchObject({ status: "done", headers_available: 1 });
  });

  it("admits a case already running as it is, and skips a finished one", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
    expect(await admit(env.DB, id)).toEqual({
      admit: true,
      orgId: ORG,
      channel: "email",
      sourceKind: "mail",
      headersAvailable: false,
    });
    expect((await setVerdict(env.DB, ORG, id, "suspicious")).ok).toBe(true);
    expect((await setStatus(env.DB, ORG, id, "done")).ok).toBe(true);
    expect(await admit(env.DB, id)).toEqual({ admit: false });
  });

  it("writes nothing for a case that does not exist or has finished", async () => {
    for (const id of ["smoke-test", "01JD0000000000000000000000"]) {
      const { output } = await run(id);
      expect(output).toEqual({ caseId: id, skipped: true });
      expect(await events(id)).toEqual([]);
    }
    const finished = await caseWith(forwards["inline-forward"]);
    await run(finished);
    const before = (await events(finished)).length;
    // A second instance for the same, now done, case.
    const { output } = await run(finished, undefined, `${finished}-again`);
    expect(output).toEqual({ caseId: finished, skipped: true });
    expect((await events(finished)).length).toBe(before);
  });

  it("finishes a case left running with its verdict stored, as a run interrupted before reply", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    const ran = await setStatus(env.DB, ORG, id, "running");
    expect(ran.ok).toBe(true);
    expect((await saveVerdict(env.DB, id, STUB_VERDICT)).ok).toBe(true);
    expect((await setVerdict(env.DB, ORG, id, "suspicious")).ok).toBe(true);
    // The stored verdict stands: the verdict step's result is the same view again.
    await run(id, (m) => m.mockStepResult({ name: "verdict" }, { view: STUB_VERDICT, evidence: [] }));
    expect(await caseRow(id)).toMatchObject({ status: "done", verdict: "suspicious" });
  });
});

describe("the ablated verdict step (D04 T01 §14)", () => {
  const draft = (check: string, severity: "info" | "low" | "critical", summary: string, detail = {}) => ({
    check,
    severity,
    summary,
    detail,
    artefacts: [],
  });

  async function ablatedCase(flag: string | null, items: ReturnType<typeof draft>[], headersAvailable = true) {
    const orgId = `org-ablate-${crypto.randomUUID().slice(0, 8)}`;
    const made = await createCase(env.DB, { orgId, channel: "email", headersAvailable });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await putParsed(store, id, {
      headers: [{ name: "From", value: "billing@sender.example" }],
      text: "Please pay into our new account.",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable, otherOriginals: 0 },
    });
    await saveEvidence(env.DB, id, items);
    if (flag) await bindExperiment(id, flag);
    return { id, orgId };
  }

  it("never calls the agent under no-agent-reasoning: the rules decide, at the floor, with the flag stored", async () => {
    const { id, orgId } = await ablatedCase("no-agent-reasoning", [
      draft("intake.forward", "info", "Forwarded by the member."),
      draft("attachment.executable", "critical", "A program is attached."),
      draft("invoice.bank_changed", "critical", "The bank account changed.", { phone: "012 555 0100" }),
    ]);
    const { view } = await verdict(env, env.DB, store, id);
    expect(view).toMatchObject({ verdict: "malicious", source: "rules", ablated: "no-agent-reasoning" });
    expect(view.reasons).toEqual([
      { text: "A program is attached.", evidenceIds: ["E2"] },
      { text: "The bank account changed.", evidenceIds: ["E3"] },
    ]);
    // The deterministic bank-change action, with the ledger's number, comes first as on the agent path.
    expect(view.actions[0]).toContain("012 555 0100");
    // No agent step ran for the case.
    expect((await events(id)).filter((e) => e.step === "agent")).toEqual([]);
    // Stored through the Workflow's store entry point, the marker reads back.
    await setStatus(env.DB, orgId, id, "running");
    expect(await storeVerdict(env.DB, orgId, id, view)).toMatchObject({ ok: true });
    expect(await getVerdict(env.DB, id)).toMatchObject({
      ok: true,
      value: { verdict: "malicious", ablated: "no-agent-reasoning" },
    });
  });

  it("carries every critical invoice item's action on the rule-only branch (D04 T01 §15)", async () => {
    const { id, orgId } = await ablatedCase("no-agent-reasoning", [
      draft("intake.forward", "info", "Forwarded by the member."),
      draft("invoice.bank_changed", "critical", "The account on the invoice differs from the ledger.", {
        phone: "+27115550123",
      }),
      draft("invoice.supplier_domain_changed", "critical", "The invoice domain differs from the ledger.", {
        phone: "+27215550124",
      }),
    ]);
    const { view } = await verdict(env, env.DB, store, id);
    const expected = [
      "Confirm by phoning the supplier on +27115550123, the number in your records, never one from this email.",
      "Confirm by phoning the supplier on +27215550124, the number in your records, never one from this email.",
    ];
    expect(view.actions.slice(0, 2)).toEqual(expected);
    await setStatus(env.DB, orgId, id, "running");
    expect(await storeVerdict(env.DB, orgId, id, view)).toMatchObject({ ok: true });
    const stored = await getVerdict(env.DB, id);
    expect(stored?.ok && stored.value.actions.slice(0, 2)).toEqual(expected);
  });

  it("keeps the confidence cap without headers and the warning when a check could not run", async () => {
    const { id } = await ablatedCase(
      "no-agent-reasoning",
      [
        draft("intake.forward", "info", "Forwarded by the member."),
        draft("not_checked", "info", "The domain age check timed out."),
      ],
      false,
    );
    const { view } = await verdict(env, env.DB, store, id);
    expect(view).toMatchObject({
      verdict: "safe",
      source: "rules",
      ablated: "no-agent-reasoning",
      headline: "No warning signs were found, but some checks could not run",
    });
    expect(view.confidence).toBeLessThanOrEqual(0.5);
    expect(view.reasons).toEqual([{ text: "The domain age check timed out.", evidenceIds: ["E2"] }]);
  });

  it("stores every deterministic action, in the agent path's order, and reads them back (completion review)", async () => {
    const { id, orgId } = await ablatedCase("no-agent-reasoning", [
      draft("intake.forward", "info", "Forwarded by the member."),
      draft("voice.request", "info", "The caller asks for a payment.", { request: "pay" }),
      draft("voice.claimed_identity", "info", "The caller claims to be the bank.", { identity: "the bank" }),
      draft("invoice.bank_changed", "critical", "The bank account changed.", { phone: "012 555 0100" }),
    ]);
    // The document step's own item, as a stored row of its producer.
    await env.DB.prepare(
      `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, detail_json, artefact_keys_json, created_at, producer)
       VALUES (?, (SELECT COALESCE(run_id, id) FROM cases WHERE id = ?), 'E6', 6, 'document.proof_of_payment', 'info', 'A proof of payment is attached.', '{}', '[]', 'now', 'document')`,
    )
      .bind(id, id)
      .run();
    const { view } = await verdict(env, env.DB, store, id);
    // The three deterministic actions come first, in the agent path's order, before any rules action.
    expect(view.actions.length).toBeGreaterThanOrEqual(3);
    expect(view.actions[0]).toContain("012 555 0100");
    expect(view.actions[1]).toBe("Confirm the money has cleared in your own banking app before releasing goods.");
    expect(view.actions[2]).toContain("the bank");
    await setStatus(env.DB, orgId, id, "running");
    expect(await storeVerdict(env.DB, orgId, id, view)).toMatchObject({ ok: true });
    expect(await getVerdict(env.DB, id)).toMatchObject({
      ok: true,
      value: { ablated: "no-agent-reasoning", actions: view.actions },
    });
  });

  it("caps confidence on missing headers alone, with every check complete (completion review)", async () => {
    const { id } = await ablatedCase(
      "no-agent-reasoning",
      [draft("intake.forward", "info", "Forwarded by the member.")],
      false,
    );
    const { view } = await verdict(env, env.DB, store, id);
    expect(view).toMatchObject({ verdict: "safe", ablated: "no-agent-reasoning" });
    expect(view.headline).not.toContain("could not run");
    expect(view.confidence).toBeLessThanOrEqual(0.5);
  });

  it("keeps the immutable arm when KV changes and leaves an ordinary neighbour unablated", async () => {
    const first = await ablatedCase("no-agent-reasoning", [
      draft("intake.forward", "info", "Forwarded by the member."),
    ]);
    await env.CACHE.put(`ablate:${first.orgId}`, "no-sam");
    expect((await verdict(env, env.DB, store, first.id)).view.ablated).toBe("no-agent-reasoning");
    const second = await ablatedCase(null, [draft("intake.forward", "info", "Forwarded by the member.")]);
    await env.DB.prepare("UPDATE cases SET org_id = ? WHERE id = ?").bind(first.orgId, second.id).run();
    await env.CACHE.put(`ablate:${first.orgId}`, "no-agent-reasoning");
    const ordinary = await verdict(env, env.DB, store, second.id);
    expect(ordinary.view.ablated ?? null).toBeNull();
    expect((await events(second.id)).some((e) => e.step === "agent")).toBe(true);
    await env.CACHE.delete(`ablate:${first.orgId}`);
  });

  it("leaves the agent eligible for every other arm and ordinary cases", async () => {
    for (const flag of ["no-walkthrough", "no-sam", "no-transcribe", "no-screening", "full", null]) {
      const { id, orgId } = await ablatedCase(flag, [draft("intake.forward", "info", "Forwarded by the member.")]);
      const { view } = await verdict(env, env.DB, store, id);
      expect(view.ablated ?? null, flag ?? "cleared").toBeNull();
      // The agent path ran (its fallback in this environment) and recorded its step.
      expect(
        (await events(id)).some((e) => e.step === "agent"),
        flag ?? "cleared",
      ).toBe(true);
      await env.CACHE.delete(`ablate:${orgId}`);
    }
  });
});

describe("failures past their last attempt", () => {
  it("ends a case partial when admission fails after it was already running", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
    const { reply } = await run(id, (m) => m.mockStepError({ name: "admit" }, new Error("down"), 4));
    expect((await caseRow(id))?.status).toBe("partial");
    expect((await events(id)).find((e) => e.status === "failed")).toEqual({
      step: "admit",
      status: "failed",
      error: "Error",
    });
    expect(reply).toMatchObject({ state: { status: "partial", failedStep: "admit" } });
  });

  it("ends a case partial when finish fails, its verdict kept", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    await run(id, (m) => m.mockStepError({ name: "finish" }, new Error("down"), 4));
    expect(await caseRow(id)).toMatchObject({ status: "partial", verdict: "safe" });
    expect((await events(id)).find((e) => e.status === "failed" && e.step === "finish")?.step).toBe("finish");
  });

  it("records a partial reply's own failure and keeps the first failure as the report's", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    const { output } = await run(id, async (m) => {
      await m.mockStepError({ name: "checks" }, new Error("down"), 4);
      await m.mockStepError({ name: "reply" }, new Error("down"), 4);
    });
    expect((await caseRow(id))?.status).toBe("partial");
    expect((await events(id)).filter((e) => e.status === "failed").map((e) => e.step)).toEqual(["checks", "reply"]);
    expect(output).toMatchObject({ state: { status: "partial", failedStep: "checks" } });
  });

  it("leaves a done case done when only what followed its finish failed", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    await run(id);
    expect(await recordFailure(env.DB, id, "finish", "Error")).toEqual({
      status: "partial",
      failedStep: "finish",
      errorClass: "Error",
    });
    expect((await caseRow(id))?.status).toBe("done");
    expect((await events(id)).at(-1)).toEqual({ step: "finish", status: "failed", error: "Error" });
  });

  it("ends a step that times out on every attempt partial", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    await run(id, (m) => m.forceStepTimeout({ name: "checks" }, 4));
    expect((await caseRow(id))?.status).toBe("partial");
    expect((await events(id)).find((e) => e.status === "failed")?.step).toBe("checks");
  });
});

describe("the parse step", () => {
  it("stores the attached original's body and attachment bytes, not the forward's", async () => {
    const id = await caseWith(forwardWithOriginal());
    await run(id);
    const stored = await summary(id);
    expect(stored.text).toContain("Please pay invoice 77 into our new account.");
    expect(stored.text).not.toContain("Is this real?");
    const pdf = stored.attachments.find((a: { filename: string }) => a.filename === "invoice-77.pdf");
    const bytes = await readArtefact(store, id, pdf.key);
    expect(bytes && "body" in bytes ? new TextDecoder().decode(bytes.body) : "").toBe(ORIGINAL_PDF);
  });

  it("throws, to be retried, when storage or the header write fails", async () => {
    const id = await caseWith(forwardWithOriginal());
    const bucketDown = {
      get: (key: string) => env.ARTEFACTS.get(key),
      head: (key: string) => env.ARTEFACTS.head(key),
      put: () => Promise.reject(new Error("R2 down")),
    } as unknown as R2Bucket;
    await expect(parse({ bucket: bucketDown, db: env.DB }, id, MAIL)).rejects.toThrow();
    const headersDown = {
      prepare: (sql: string) =>
        sql.startsWith("UPDATE cases SET headers_available")
          ? { bind: () => ({ first: () => Promise.reject(new Error("D1 down")) }) }
          : env.DB.prepare(sql),
    } as unknown as D1Database;
    await expect(parse({ bucket: env.ARTEFACTS, db: headersDown }, id, MAIL)).rejects.toThrow(
      /storing the header state: database/,
    );
    // Neither is a refusal the Workflow would not retry.
    for (const broken of [
      { bucket: bucketDown, db: env.DB },
      { bucket: env.ARTEFACTS, db: headersDown },
    ])
      expect(await parse(broken, id, MAIL).catch((error: Error) => error.name)).not.toBe("NonRetryableError");
  });
});

describe("round 1 cases", () => {
  it("lets only an error's class leave a step, never its message", async () => {
    const leaked = await safely(async () => {
      throw new StoreError("storage", "putting cases/x/attachments/ab/Acme-payroll-March.pdf: R2 down");
    }).catch((error: Error) => error);
    expect(leaked).toBeInstanceOf(Error);
    expect((leaked as Error).message).toBe("StoreError");
    expect(String((leaked as Error).stack)).not.toContain("Acme");
    const plain = await safely(async () => {
      throw new Error("the subject was 'pay now'");
    }).catch((error: Error) => error.message);
    expect(plain).toBe("Error");
  });

  it("retries a reply whose case lookup fails rather than answering ready", async () => {
    const id = await caseWith(null);
    const broken = {
      prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error("D1 down")) }) }),
    } as unknown as D1Database;
    await expect(reply({ ...env, DB: broken }, id, { status: "ready", verdict: "suspicious" })).rejects.toThrow(
      /reading the case for the reply/,
    );
  });

  it("resumes with core results cached and runs the remaining steps once", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
    expect((await saveVerdict(env.DB, id, STUB_VERDICT)).ok).toBe(true);
    expect((await setVerdict(env.DB, ORG, id, "suspicious")).ok).toBe(true);
    // The results a resumed instance finds cached: those steps' callbacks do not run again.
    await run(id, async (m) => {
      await m.mockStepResult({ name: "admit" }, { admit: true, orgId: ORG });
      await m.mockStepResult({ name: "parse" }, parsedKey(id));
      await m.mockStepResult({ name: "checks" }, { evidence: [] });
      await m.mockStepResult({ name: "verdict" }, { view: STUB_VERDICT, evidence: [] });
      await m.mockStepResult({ name: "store" }, "stored");
    });
    // The walkthrough and vision steps are not mocked, so they run (and find nothing: the mocked checks
    // stored no evidence, and no summary stands for the vision step to render).
    expect((await events(id)).map((e) => `${e.step}:${e.status}`)).toEqual([
      "walkthrough:started",
      "walkthrough:done",
      "vision:started",
      "vision:done",
      "invoice:started",
      "invoice:done",
      "verification:started",
      "verification:done",
      "reply:started",
      "reply:done",
      "finish:started",
      "finish:done",
    ]);
    expect((await caseRow(id))?.status).toBe("done");
  });

  it("runs the walkthrough step for a case with a form, before the verdict reads the evidence", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
    // The checks' finding, as the checks step would have stored it: a credential form on a page the URL policy
    // refuses by name, so the walk ends at once with no network and no model call (D04 T02 §6).
    await saveEvidence(env.DB, id, [
      {
        check: "link.credential_form",
        severity: "high",
        summary: "A form asks for sign-in details.",
        detail: { page: "https://localhost/signin" },
        artefacts: [],
      },
    ]);
    await run(id, async (m) => {
      await m.mockStepResult({ name: "admit" }, { admit: true, orgId: ORG });
      await m.mockStepResult({ name: "parse" }, parsedKey(id));
      await m.mockStepResult({ name: "checks" }, { evidence: 1 });
    });
    const steps = (await events(id)).map((e) => `${e.step}:${e.status}`);
    expect(steps.indexOf("walkthrough:done")).toBeGreaterThan(-1);
    expect(steps.indexOf("walkthrough:done")).toBeLessThan(steps.indexOf("verdict:started"));
    // The refused page was stated on the case by the step itself, before the verdict ran: a no-op step leaves none.
    const walked = (await readEvidence(env.DB, id)).filter((e) => e.check.startsWith("walkthrough."));
    expect(walked.map((e) => e.check)).toEqual(["walkthrough.not_checked"]);
    expect(walked[0]).toMatchObject({ detail: { checked: false } });
    expect((await caseRow(id))?.status).toBe("done");
    const verdict = await getVerdict(env.DB, id);
    expect(verdict?.ok && verdict.value.verdict).toBe("suspicious");
  });

  it("runs the vision step after walkthrough, records an unreadable PDF and states the reading not checked when the model cannot run", async () => {
    // D03 T02 §3: a stored case with a valid and an unreadable PDF. No Meta key stands in this
    // environment, so the reading states itself not checked and the case still reaches a verdict.
    const id = await caseWith(null);
    await putParsed(store, id, {
      headers: [],
      text: "Pay invoice 77 today.",
      html: null,
      attachments: [],
      forward: {},
    });
    await putVisible(store, id, "Pay invoice 77 today.");
    await putAttachment(store, id, "invoice.pdf", makePdf(["Invoice 77"]), "application/pdf");
    await putAttachment(store, id, "broken.pdf", new TextEncoder().encode("not a pdf"), "application/pdf");
    expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
    await run(id, async (m) => {
      await m.mockStepResult({ name: "admit" }, { admit: true, orgId: ORG, ...MAIL });
      await m.mockStepResult({ name: "parse" }, parsedKey(id));
      await m.mockStepResult({ name: "checks" }, { evidence: 0 });
    });
    const steps = (await events(id)).map((e) => `${e.step}:${e.status}`);
    expect(steps.indexOf("vision:started")).toBeGreaterThan(steps.indexOf("walkthrough:done"));
    expect(steps.indexOf("vision:done")).toBeLessThan(steps.indexOf("verdict:started"));
    const vision = (await readEvidence(env.DB, id)).filter((e) => e.check.startsWith("vision."));
    expect(vision.map((e) => e.check)).toEqual(["vision.pdf_unreadable", "vision.not_checked"]);
    expect(vision[0]).toMatchObject({ detail: { checked: false, kind: "malformed" } });
    expect(vision[1]).toMatchObject({ detail: { checked: false } });
    expect((await caseRow(id))?.status).toBe("done");
    expect((await getVerdict(env.DB, id))?.ok).toBe(true);
  }, 180_000);

  it("runs the invoice step after vision and before the verdict, stating its failure and sealing nothing when the model cannot run", async () => {
    // D06 T01 §1: a stored case with a PDF invoice. No Meta key stands in this environment, so the
    // extraction states itself not checked, no account is sealed, and the case still reaches a verdict;
    // the persisted extraction on a successful reading is proven in test/invoice/step.test.ts.
    const id = await caseWith(null);
    await putParsed(store, id, {
      headers: [],
      text: "Pay invoice 77 today.",
      html: null,
      attachments: [],
      forward: {},
    });
    await putVisible(store, id, "Pay invoice 77 today.");
    await putAttachment(store, id, "invoice.pdf", makePdf(["Invoice 77"]), "application/pdf");
    expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
    await run(id, async (m) => {
      await m.mockStepResult({ name: "admit" }, { admit: true, orgId: ORG, ...MAIL });
      await m.mockStepResult({ name: "parse" }, parsedKey(id));
      await m.mockStepResult({ name: "checks" }, { evidence: 0 });
    });
    const steps = (await events(id)).map((e) => `${e.step}:${e.status}`);
    expect(steps.indexOf("invoice:started")).toBeGreaterThan(steps.indexOf("vision:done"));
    expect(steps.indexOf("invoice:done")).toBeLessThan(steps.indexOf("verdict:started"));
    const invoice = (await readEvidence(env.DB, id)).filter((e) => e.check.startsWith("invoice."));
    expect(invoice.map((e) => e.check)).toEqual(["invoice.not_checked"]);
    const sealed = await env.DB.prepare("SELECT COUNT(*) AS n FROM case_invoice_accounts WHERE case_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(sealed?.n).toBe(0);
    expect((await caseRow(id))?.status).toBe("done");
  }, 180_000);

  it("carries a tampered invoice's critical item and fixed action to the verdict through the Workflow", async () => {
    // D06 T01 §3 gap 6: an attached tampered invoice, extracted by a stubbed Meta answer, yields
    // invoice.bank_changed persisted before the verdict, the deterministic floor caps the
    // verdict, and the fixed action carries the ledger phone, never one from the message.
    await env.DB.prepare(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    )
      .bind(ORG, "Workflow Org", "org-workflow", new Date().toISOString())
      .run();
    const { id: supplierId } = await addSupplier(env.DB, ORG, "owner", {
      name: "Karoo Parts",
      domains: ["karooparts.co.za"],
      phone: "+27 21 555 0100",
      notes: null,
    });
    await addSupplierAccount(env.DB, await bankKeys(env as unknown as Env), ORG, "owner", supplierId, {
      number: "06200441773",
      branchCode: "250655",
      bankName: "Kestrel Bank (fictional)",
      holder: "Karoo Parts (Pty) Ltd",
    });
    const extraction = {
      is_invoice: true,
      supplier_name: "Karoo Parts (Pty) Ltd",
      supplier_domain: "karooparts.co.za",
      bank_name: "Kestrel Bank (fictional)",
      account_holder: "Karoo Parts (Pty) Ltd",
      account_number: "06200999999",
      branch_code: "250655",
      amount_cents: 123456,
      currency: "ZAR",
      reference: "INV-1042",
      due_date: "2026-11-30",
    };
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("gateway.ai.cloudflare.com"))
        return new Response(
          JSON.stringify({
            id: "r",
            object: "response",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: JSON.stringify(extraction) }],
              },
            ],
            usage: { input_tokens: 100, output_tokens: 20 },
          }),
          { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
        );
      return real(input as never, init as never);
    });
    try {
      const id = await caseWith(null);
      await putParsed(store, id, {
        headers: [],
        text: "Please pay invoice 77 into our new account 06200999999.",
        html: null,
        attachments: [],
        forward: {},
      });
      await putVisible(store, id, "Please pay invoice 77 into our new account.");
      await putAttachment(store, id, "invoice.pdf", makePdf(["Invoice 77"]), "application/pdf");
      expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
      await run(id, async (m) => {
        await m.mockStepResult({ name: "admit" }, { admit: true, orgId: ORG, ...MAIL });
        await m.mockStepResult({ name: "parse" }, parsedKey(id));
        await m.mockStepResult({ name: "checks" }, { evidence: 0 });
      });
      const invoice = (await readEvidence(env.DB, id)).filter((e) => e.check.startsWith("invoice."));
      expect(invoice.map((e) => e.check)).toContain("invoice.bank_changed");
      const stored = await getVerdict(env.DB, id);
      expect(stored?.ok && stored.value.verdict).not.toBe("safe");
      expect(stored?.ok && stored.value.actions.join("\n")).toContain("+27 21 555 0100");
      expect(stored?.ok && stored.value.actions.join("\n")).not.toContain("06200999999");
    } finally {
      spy.mockRestore();
    }
  }, 180_000);
});

describe("final review cases", () => {
  it("stores the verdict row and the case's label together, or neither", async () => {
    const id = await caseWith(null);
    expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
    const failing = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: () => Promise.reject(new Error("D1 down")),
    } as unknown as D1Database;
    expect(await storeVerdict(failing, ORG, id, STUB_VERDICT)).toMatchObject({
      ok: false,
      error: { code: "database" },
    });
    expect(await getVerdict(env.DB, id)).toBeNull();
    expect((await caseRow(id))?.verdict).toBeNull();
    expect((await storeVerdict(env.DB, ORG, id, STUB_VERDICT)).ok).toBe(true);
    expect((await caseRow(id))?.verdict).toBe("suspicious");
    // Again, as a replay would: the same answer; another view is a conflict.
    expect((await storeVerdict(env.DB, ORG, id, STUB_VERDICT)).ok).toBe(true);
    expect(await storeVerdict(env.DB, ORG, id, { ...STUB_VERDICT, headline: "Other" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("writes no verdict for a case that is not running", async () => {
    const id = await caseWith(null);
    expect(await storeVerdict(env.DB, ORG, id, STUB_VERDICT)).toMatchObject({
      ok: false,
      error: { code: "transition" },
    });
    expect(await getVerdict(env.DB, id)).toBeNull();
  });

  it("writes a step's failure once, however often its record is retried", async () => {
    const id = await caseWith(null);
    for (let i = 0; i < 3; i++) await recordEvent(env.DB, id, "checks", "failed", { errorClass: "Error", once: true });
    expect((await events(id)).filter((e) => e.status === "failed")).toHaveLength(1);
  });

  it("gives a failure's record more attempts than a step", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    await run(id, async (m) => {
      await m.mockStepError({ name: "checks" }, new Error("down"), 4);
      await m.mockStepError({ name: "fail:checks" }, new Error("down"), 10);
    });
    expect((await caseRow(id))?.status).toBe("partial");
  });

  it("re-drives a case from its stored summary once the raw message is gone", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    await run(id);
    await env.ARTEFACTS.delete(`raw/${id}/message.eml`);
    expect(await parse(store, id, MAIL)).toBe(parsedKey(id));
  });
});

describe("the checks step and the event writer", () => {
  it("fails checks given a key with no summary", async () => {
    const id = await caseWith(null);
    await expect(checks(store, id, parsedKey(id), TENANT)).rejects.toThrow(/not stored/);
  });

  it("fails checks on a summary of neither shape, storing no evidence", async () => {
    const id = await caseWith(null);
    await putParsed(store, id, { forward: { path: "carrier-pigeon" } });
    await expect(checks(store, id, parsedKey(id), TENANT)).rejects.toThrow(SummaryRefused);
    expect(await readEvidence(env.DB, id)).toEqual([]);
  });

  it("reads the organisation's receivers into the view, learning missing ones, and stores what they wrote (D02 T02 §1)", async () => {
    const org = "org-receivers";
    const made = await createCase(env.DB, { orgId: org, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
    )
      .bind("claim-receivers", org, "member.co.za", "t".repeat(16), now, now)
      .run();
    const message = (top: string) => ({
      headers: [
        { name: "Received", value: "from AM6PR01.eurprd01.prod.outlook.com by AM6PR02.eurprd01.prod.outlook.com" },
        { name: "Authentication-Results", value: top },
        { name: "Received", value: "from mail.sender.example by AM5EUR01FT001.mail.protection.outlook.com" },
        { name: "Received", value: "from client by mail.sender.example" },
        { name: "Authentication-Results", value: "spf=pass smtp.mailfrom=sender.example; compauth=pass reason=100" },
      ],
      text: "Pay.",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await putParsed(store, id, message("spf=fail smtp.mailfrom=sender.example; compauth=fail reason=000"));
    const asked: string[] = [];
    const lookup = async (domain: string) => {
      asked.push(domain);
      return ["member-co-za.mail.protection.outlook.com"];
    };
    // intake.forward, auth.results, then the four auth checks (D02 T02 §2).
    expect(await checks(store, id, parsedKey(id), { orgId: org, channel: "email" }, lookup)).toEqual({ evidence: 6 });
    expect(asked).toEqual(["member.co.za"]);
    const item = (await readEvidence(env.DB, id)).find((e) => e.check === "auth.results");
    expect(item?.detail).toMatchObject({
      trusted: true,
      receiver: "microsoft",
      authservId: null,
      results: [
        { method: "spf", result: "fail" },
        { method: "compauth", result: "fail" },
      ],
    });
    // Learned once: the next run reads them without a lookup.
    await checks(store, id, parsedKey(id), { orgId: org, channel: "email" }, lookup);
    expect(asked).toEqual(["member.co.za"]);
  });

  it("stores the auth checks' evidence through the step, each item citing its header and the stored raw message (D02 T02 §2)", async () => {
    const org = "org-auth-step";
    const made = await createCase(env.DB, { orgId: org, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
    )
      .bind("claim-auth-step", org, "auth-step.co.za", "t".repeat(16), now, now)
      .run();
    await putRaw(store, id, new TextEncoder().encode("From: billing@bank.example\r\n\r\nPay.\r\n"));
    const header =
      "mx.google.com; spf=pass smtp.mailfrom=bounce@mailer.example; dkim=none; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=bank.example";
    await putParsed(store, id, {
      headers: [
        { name: "Received", value: "from mail.sender.example (mail.sender.example. [203.0.113.5]) by mx.google.com" },
        { name: "Authentication-Results", value: header },
        { name: "Received", value: "from client by mail.sender.example" },
        { name: "From", value: "billing@bank.example" },
      ],
      text: "Pay.",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await checks(store, id, parsedKey(id), { orgId: org, channel: "email" }, async () => ["aspmx.l.google.com"]);
    const stored = await readEvidence(env.DB, id);
    const auth = stored.filter((e) => e.check.startsWith("auth.") && e.check !== "auth.results");
    expect(auth.map((e) => [e.check, e.severity])).toEqual([
      ["auth.spf", "info"],
      ["auth.dkim", "info"],
      ["auth.dmarc", "high"],
      ["auth.alignment", "high"],
    ]);
    for (const e of auth) {
      expect(e.detail.headers).toEqual([header]);
      expect(e.artefacts).toEqual([rawKey(id)]);
      expect(await env.ARTEFACTS.head(rawKey(id))).not.toBeNull();
    }
  });

  it("stores the auth prefix before a blocked enrichment, and keeps its IDs after (D01 T01 §23)", async () => {
    const org = "org-auth-first";
    const made = await createCase(env.DB, { orgId: org, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await putRaw(
      store,
      id,
      new TextEncoder().encode("From: billing@bank.example\r\n\r\nPay https://collect.example/x\r\n"),
    );
    const header =
      "mx.google.com; spf=pass smtp.mailfrom=bounce@mailer.example; dkim=none; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=bank.example";
    await putParsed(store, id, {
      headers: [
        { name: "Received", value: "from mail.sender.example (mail.sender.example. [203.0.113.5]) by mx.google.com" },
        { name: "Authentication-Results", value: header },
        { name: "From", value: "billing@bank.example" },
      ],
      text: "Pay https://collect.example/x",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    let release: (error: Error) => void = () => undefined;
    const blocked = new Promise<never>((_resolve, reject) => {
      release = reject;
    });
    const startedAt = Date.now();
    const pending = checks(
      store,
      id,
      parsedKey(id),
      { orgId: org, channel: "email" },
      async () => ["aspmx.l.google.com"],
      undefined,
      null,
      { read: () => blocked },
    );
    // While the link following is blocked, the intake and auth rows are already stored, promptly:
    // the measured admission-to-auth-storage latency on this synthetic case (completion review gap 5).
    await expect
      .poll(async () => (await readEvidence(env.DB, id)).filter((e) => e.check.startsWith("auth.")).length, {
        timeout: 10_000,
        interval: 100,
      })
      .toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    const early = await readEvidence(env.DB, id);
    const earlyAuth = early.filter((e) => e.check.startsWith("auth."));
    expect(((await readCheckOutcomes(env.DB, id)) ?? []).map((o) => o.check)).toEqual(
      expect.arrayContaining(earlyAuth.map((e) => e.check)),
    );
    release(new Error("browser down"));
    await pending;
    // The enrichment failed and the full run still stored everything: every early item (intake included)
    // keeps its complete identity, and a replay of the step stores the identical set (completion review).
    const stored = await readEvidence(env.DB, id);
    for (const item of early) {
      const after = stored.find((e) => e.id === item.id);
      expect(after).toEqual(item);
    }
    const outcomes = await readCheckOutcomes(env.DB, id);
    expect(outcomes?.length).toBeGreaterThan(0);
    await checks(store, id, parsedKey(id), { orgId: org, channel: "email" }, async () => ["aspmx.l.google.com"]);
    expect(await readEvidence(env.DB, id)).toEqual(stored);
    expect(await readCheckOutcomes(env.DB, id)).toEqual(outcomes);
  });

  it("keeps the auth prefix when the checks step itself fails, and a retry completes it (D01 T01 §23)", async () => {
    const org = "org-auth-first-fail";
    const made = await createCase(env.DB, { orgId: org, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await putRaw(
      store,
      id,
      new TextEncoder().encode("From: billing@bank.example\r\n\r\nPay https://collect.example/x\r\n"),
    );
    const header =
      "mx.google.com; spf=pass smtp.mailfrom=bounce@mailer.example; dkim=none; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=bank.example";
    await putParsed(store, id, {
      headers: [
        { name: "Received", value: "from mail.sender.example (mail.sender.example. [203.0.113.5]) by mx.google.com" },
        { name: "Authentication-Results", value: header },
        { name: "From", value: "billing@bank.example" },
      ],
      text: "Pay https://collect.example/x",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    // A storage failure after the early save (putting the visible text) propagates out of the step.
    const failingStore: Store = {
      db: env.DB,
      bucket: new Proxy(env.ARTEFACTS, {
        get: (target, name) =>
          name === "put"
            ? async () => {
                throw new Error("R2 down");
              }
            : Reflect.get(target, name).bind(target),
      }) as unknown as Store["bucket"],
    };
    await expect(
      checks(failingStore, id, parsedKey(id), { orgId: org, channel: "email" }, async () => ["aspmx.l.google.com"]),
    ).rejects.toThrow();
    const early = await readEvidence(env.DB, id);
    expect(early.filter((e) => e.check.startsWith("auth.")).length).toBeGreaterThan(0);
    await checks(store, id, parsedKey(id), { orgId: org, channel: "email" }, async () => ["aspmx.l.google.com"]);
    const stored = await readEvidence(env.DB, id);
    for (const item of early) expect(stored.find((e) => e.id === item.id)).toEqual(item);
  });

  it("stores each recording's transcript item through the step, a malformed one beside it (D01 T03 §16)", async () => {
    const turn = { chunk: 1, speaker: "A", startMs: 0, endMs: 1000, text: "Please pay today." };
    const mail = await createCase(env.DB, { orgId: "org-transcript-mail", channel: "email", headersAvailable: true });
    if (!mail.ok) throw new Error(mail.error.message);
    const mid = mail.value.id;
    await putRaw(store, mid, new TextEncoder().encode("From: a@bank.example\r\n\r\nTwo voice notes attached.\r\n"));
    await putParsed(store, mid, {
      headers: [{ name: "From", value: "a@bank.example" }],
      text: "Two voice notes attached.",
      html: null,
      attachments: [
        {
          key: `raw/${mid}/attachments/aa-first.ogg`,
          filename: "first.ogg",
          mediaType: "audio/ogg",
          contentId: null,
          disposition: "attachment",
          bytes: 10,
        },
        {
          key: `raw/${mid}/attachments/bb-second.ogg`,
          filename: "second.ogg",
          mediaType: "audio/ogg",
          contentId: null,
          disposition: "attachment",
          bytes: 10,
        },
        {
          key: `raw/${mid}/attachments/cc-third.ogg`,
          filename: "third.ogg",
          mediaType: "audio/ogg",
          contentId: null,
          disposition: "attachment",
          bytes: 10,
        },
        {
          key: `raw/${mid}/attachments/dd-fourth.ogg`,
          filename: "fourth.ogg",
          mediaType: "audio/ogg",
          contentId: null,
          disposition: "attachment",
          bytes: 10,
        },
        {
          key: `raw/${mid}/attachments/ee-fifth.ogg`,
          filename: "fifth.ogg",
          mediaType: "audio/ogg",
          contentId: null,
          disposition: "attachment",
          bytes: 10,
        },
      ],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await putArtefact(
      store,
      mid,
      "audio",
      "transcript-1.json",
      new TextEncoder().encode(JSON.stringify({ turns: [turn], gaps: [], complete: true })),
      "application/json",
    );
    await putArtefact(
      store,
      mid,
      "audio",
      "transcript-2.json",
      new TextEncoder().encode(JSON.stringify({ turns: [turn], gaps: [], complete: true })),
      "application/json",
    );
    await putArtefact(
      store,
      mid,
      "audio",
      "transcript-3.json",
      new TextEncoder().encode(JSON.stringify({ text: "no turns here" })),
      "application/json",
    );
    const gone = await putArtefact(
      store,
      mid,
      "audio",
      "transcript-4.json",
      new TextEncoder().encode(JSON.stringify({ turns: [turn], gaps: [], complete: true })),
      "application/json",
    );
    await env.ARTEFACTS.delete(gone.key);
    await putArtefact(
      store,
      mid,
      "audio",
      "transcript-5.json",
      new TextEncoder().encode(
        JSON.stringify({
          turns: Array.from({ length: 30 }, (_, i) => ({ ...turn, startMs: i * 1000, text: "é".repeat(1500) })),
          gaps: [],
          complete: true,
        }),
      ),
      "application/json",
    );
    // The mail case's aggregate transcript holds no turns and is excluded, never a fourth item.
    await putArtefact(
      store,
      mid,
      "audio",
      "transcript.json",
      new TextEncoder().encode(JSON.stringify({ text: "joined words", complete: true })),
      "application/json",
    );
    // The claim extraction failed; the transcripts were still stored and must still become evidence.
    await storeVoice(store, mid, { state: "not_checked", reason: "the reading did not finish" });
    await checks(store, mid, parsedKey(mid), { orgId: "org-transcript-mail", channel: "email" }, async () => []);
    const items = (await readEvidence(env.DB, mid)).filter((e) => e.check === "voice.transcript");
    expect(items).toHaveLength(5);
    const byName = (name: string) => items.find((i) => i.detail.filename === name);
    expect(byName("fourth.ogg")?.detail).toMatchObject({ malformed: true });
    const fifth = byName("fifth.ogg");
    expect(fifth?.detail.trimmed).toBe(true);
    expect((fifth?.detail.segmentsOmitted as number) ?? 0).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(fifth?.detail)).length).toBeLessThanOrEqual(65_536);
    expect(byName("first.ogg")?.detail).toMatchObject({
      recording: `raw/${mid}/attachments/aa-first.ogg`,
      segments: [{ text: "Please pay today.", startMs: 0, endMs: 1000, chunk: 1, speaker: "A" }],
    });
    expect(byName("second.ogg")?.detail).toMatchObject({ complete: true });
    expect(byName("third.ogg")?.detail).toMatchObject({ malformed: true });

    const up = await createCase(env.DB, {
      orgId: "org-transcript-up",
      channel: "upload",
      headersAvailable: false,
      uploadedBy: "user-transcript",
    });
    if (!up.ok) throw new Error(up.error.message);
    const uid = up.value.id;
    await putRaw(store, uid, new Uint8Array([1, 2, 3]));
    await putParsed(store, uid, {
      source: { kind: "audio", mediaType: "audio/ogg", key: `art/${uid}/audio/rec.ogg`, bytes: 3 },
      forward: { headersAvailable: false },
    });
    await putArtefact(
      store,
      uid,
      "audio",
      "transcript.json",
      new TextEncoder().encode(JSON.stringify({ turns: [turn], gaps: [], complete: true })),
      "application/json",
    );
    await storeVoice(store, uid, { state: "not_checked", reason: "the reading did not finish" });
    await checks(store, uid, parsedKey(uid), { orgId: "org-transcript-up", channel: "upload" }, async () => []);
    const upItems = (await readEvidence(env.DB, uid)).filter((e) => e.check === "voice.transcript");
    expect(upItems).toHaveLength(1);
    expect(upItems[0]?.detail).toMatchObject({ recording: `art/${uid}/audio/rec.ogg` });
  });

  it("stores auth.arc through the step with its earlier context, headers and raw key (D02 T02 §3)", async () => {
    const org = "org-arc-step";
    const made = await createCase(env.DB, { orgId: org, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
    )
      .bind("claim-arc-step", org, "arc-step.co.za", "t".repeat(16), now, now)
      .run();
    await putRaw(store, id, new TextEncoder().encode("From: billing@bank.example\r\n\r\nPay.\r\n"));
    const verdict =
      "mx.google.com; arc=pass (i=1 spf=pass spfdomain=bank.example); spf=fail smtp.mailfrom=lists.example";
    const earlier = "i=1; mx.lists.example; spf=pass smtp.mailfrom=bank.example";
    const seal = "i=1; a=rsa-sha256; cv=none; d=lists.example; s=arc; b=x";
    await putParsed(store, id, {
      headers: [
        { name: "Received", value: "from lists.example (lists.example. [203.0.113.7]) by mx.google.com" },
        { name: "Authentication-Results", value: verdict },
        { name: "Received", value: "from client by lists.example" },
        { name: "ARC-Authentication-Results", value: earlier },
        { name: "ARC-Seal", value: seal },
        { name: "From", value: "billing@bank.example" },
      ],
      text: "Pay.",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await checks(store, id, parsedKey(id), { orgId: org, channel: "email" }, async () => ["aspmx.l.google.com"]);
    const arc = (await readEvidence(env.DB, id)).find((e) => e.check === "auth.arc");
    expect(arc).toMatchObject({
      severity: "info",
      artefacts: [rawKey(id)],
      detail: { verdict: "pass", sealer: "lists.example", headers: [verdict, earlier, seal] },
    });
    expect(await env.ARTEFACTS.head(rawKey(id))).not.toBeNull();
  });

  it("stores auth.arc with its verdict however large the earlier results are (D02 T02 §3, round 1)", async () => {
    const org = "org-arc-big";
    const made = await createCase(env.DB, { orgId: org, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
    )
      .bind("claim-arc-big", org, "arc-big.co.za", "t".repeat(16), now, now)
      .run();
    await putRaw(store, id, new TextEncoder().encode("From: billing@bank.example\r\n\r\nPay.\r\n"));
    const props = Array.from({ length: 20 }, (_, p) => `p${p}=${"v".repeat(200)}`).join(" ");
    const earlier = `i=1; mx.lists.example; ${Array.from({ length: 20 }, (_, r) => `m${r}=pass ${props}`).join("; ")}`;
    await putParsed(store, id, {
      headers: [
        { name: "Received", value: "from lists.example (lists.example. [203.0.113.7]) by mx.google.com" },
        { name: "Authentication-Results", value: "mx.google.com; arc=pass (i=1)" },
        { name: "Received", value: "from client by lists.example" },
        { name: "ARC-Authentication-Results", value: earlier },
        { name: "ARC-Seal", value: "i=1; a=rsa-sha256; cv=none; d=lists.example; s=arc; b=x" },
        { name: "From", value: "billing@bank.example" },
      ],
      text: "Pay.",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await checks(store, id, parsedKey(id), { orgId: org, channel: "email" }, async () => ["aspmx.l.google.com"]);
    const stored = await readEvidence(env.DB, id);
    expect(stored.some((e) => e.check === "not_checked")).toBe(false);
    expect(stored.find((e) => e.check === "auth.arc")).toMatchObject({
      artefacts: [rawKey(id)],
      detail: { verdict: "pass", sealer: "lists.example", trimmed: true },
    });
  });

  it("stores the sender checks through a Workflow run, the brand table read from KV in the step (D02 T02 §4)", async () => {
    // KV's table gains a fictional bank the bundled one lacks: only a step that reads KV can name it.
    const table = structuredClone(bundled);
    table.brands.push({
      name: "Fynbos Bank",
      display_names: ["Fynbos Bank"],
      domains: ["fynbosbank.co.za"],
      user_content: [],
      sources: [
        {
          url: "https://www.fynbosbank.co.za/about",
          read: "2026-10-30",
          names: ["fynbosbank.co.za"],
          evidence: "fynbosbank.co.za",
        },
      ],
    });
    await env.CACHE.put(BRANDS_KEY, JSON.stringify(table));
    forgetBrandTable();
    const raw = new TextEncoder().encode(
      [
        "From: Fictional Boss <boss@fictional-recipient.example>",
        "To: check@isitlegit.co.za",
        "Subject: Fwd: sender checks",
        "Message-ID: <sender-checks-outer@fictional-recipient.example>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Is it real?",
        "--b",
        "Content-Type: message/rfc822",
        'Content-Disposition: attachment; filename="original.eml"',
        "",
        "Return-Path: <bounce@elsewhere.example>",
        'From: "Fynbos Bank debtors@fynbosbank.co.za" <accounts@freemail.example>',
        "Reply-To: pay@elsewhere.example",
        "To: accounts@fictional-recipient.example",
        "Subject: Updated banking details",
        "Message-ID: <sender-checks-1@freemail.example>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Please pay into our new account.",
        "",
        "--b--",
        "",
      ].join("\r\n"),
    );
    try {
      const id = await caseWith(raw);
      await run(id);
      const stored = await readEvidence(env.DB, id);
      const sender = stored.filter((e) => e.check.startsWith("sender."));
      // All four, each citing the exact header it rests on (completion review).
      const from = 'From: "Fynbos Bank debtors@fynbosbank.co.za" <accounts@freemail.example>';
      expect(sender.map((e) => [e.check, e.severity, (e.detail as { headers: string[] }).headers])).toEqual([
        ["sender.display_address", "medium", [from]],
        ["sender.display_brand", "medium", [from]],
        ["sender.reply_to", "medium", ["Reply-To: pay@elsewhere.example"]],
        ["sender.return_path", "low", ["Return-Path: <bounce@elsewhere.example>"]],
        ["sender.first_time", "low", [from]],
      ]);
      expect(sender[1]?.detail).toMatchObject({ brand: "Fynbos Bank" });
      for (const e of sender) expect(e.artefacts).toEqual([rawKey(id)]);
      expect(await env.ARTEFACTS.head(rawKey(id))).not.toBeNull();
    } finally {
      await env.CACHE.delete(BRANDS_KEY);
      forgetBrandTable();
    }
  });

  it("stores each run's own table revision and source through a Workflow run, the evidence it produced agreeing (D02 T01 §6)", async () => {
    const table = structuredClone(bundled);
    table.revision = "2026-11-06";
    table.brands.push({
      name: "Fynbos Bank",
      display_names: ["Fynbos Bank"],
      domains: ["fynbosbank.co.za"],
      user_content: [],
      sources: [
        {
          url: "https://www.fynbosbank.co.za/about",
          read: "2026-10-30",
          names: ["fynbosbank.co.za"],
          evidence: "fynbosbank.co.za",
        },
      ],
    });
    const mail = (n: number) =>
      new TextEncoder().encode(
        [
          "From: Fictional Boss <boss@fictional-recipient.example>",
          "To: check@isitlegit.co.za",
          `Subject: Fwd: data revision ${n}`,
          `Message-ID: <data-revision-outer-${n}@fictional-recipient.example>`,
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="b"',
          "",
          "--b",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Is it real?",
          "--b",
          "Content-Type: message/rfc822",
          'Content-Disposition: attachment; filename="original.eml"',
          "",
          'From: "Fynbos Bank debtors@fynbosbank.co.za" <accounts@freemail.example>',
          "To: accounts@fictional-recipient.example",
          "Subject: Updated banking details",
          `Message-ID: <data-revision-${n}@freemail.example>`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Please pay into our new account.",
          "",
          "--b--",
          "",
        ].join("\r\n"),
      );
    const outcomesOf = async (id: string) =>
      (
        await env.DB.prepare(
          "SELECT data_revision, data_id, data_source, revision FROM check_outcomes WHERE case_id = ?",
        )
          .bind(id)
          .all<{
            data_revision: string | null;
            data_id: string | null;
            data_source: string | null;
            revision: string | null;
          }>()
      ).results;
    try {
      // The identities of the two tables, taken from their content.
      const kvId = await tableId(BrandTable.parse(table));
      const bundledId = await tableId(bundled);
      // Run one: KV holds the table that names the bank.
      await env.CACHE.put(BRANDS_KEY, JSON.stringify(table));
      forgetBrandTable();
      const withKv = await caseWith(mail(1));
      await run(withKv);
      // Run two, under the same Worker version: KV is empty, so the bundled table, which does not name the bank, is used.
      await env.CACHE.delete(BRANDS_KEY);
      forgetBrandTable();
      const bundledRun = await caseWith(mail(2));
      await run(bundledRun);
      const brandEvidence = async (id: string) =>
        (await readEvidence(env.DB, id)).filter((e) => e.check === "sender.display_brand").length;
      // The evidence each run produced depends on its table, and its stored provenance is that table's.
      expect(await brandEvidence(withKv)).toBe(1);
      expect(await brandEvidence(bundledRun)).toBe(0);
      const first = await outcomesOf(withKv);
      const second = await outcomesOf(bundledRun);
      expect(first.length).toBeGreaterThan(0);
      expect(first.every((o) => o.data_revision === "2026-11-06" && o.data_source === "kv")).toBe(true);
      expect(first.every((o) => o.data_id === kvId)).toBe(true);
      expect(second.every((o) => o.data_id === bundledId)).toBe(true);
      expect(kvId).not.toBe(bundledId);
      expect(second.length).toBeGreaterThan(0);
      expect(second.every((o) => o.data_revision === bundled.revision && o.data_source === "bundled")).toBe(true);
      expect(new Set([...first, ...second].map((o) => o.revision)).size).toBe(1);
    } finally {
      await env.CACHE.delete(BRANDS_KEY);
      forgetBrandTable();
    }
  });

  it("stores one list however often the step runs, and returns only its count", async () => {
    await env.DB.prepare("DELETE FROM sender_observations WHERE org_id = ?").bind(ORG).run();
    const id = await caseWith(forwards["attached-rfc822"]);
    await parse(store, id, MAIL);
    // The sender is first for this case on both runs: a retried step reads its own observation (D02 T02 §5).
    expect(await checks(store, id, parsedKey(id), TENANT)).toEqual({ evidence: 4 });
    expect(await checks(store, id, parsedKey(id), TENANT)).toEqual({ evidence: 4 });
    expect((await readEvidence(env.DB, id)).map((e) => [e.id, e.check])).toEqual([
      ["E1", "intake.forward"],
      ["E2", "auth.results"],
      ["E3", "sender.first_time"],
      ["E4", "reputation.coverage"],
    ]);
  });

  it("answers a database refusal, and stores only an error class", async () => {
    const id = await caseWith(null);
    const broken = {
      prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("D1 down")) }) }),
    } as unknown as D1Database;
    expect(await recordEvent(broken, id, "parse", "started")).toMatchObject({ ok: false, error: { code: "database" } });
    const named = await recordEvent(env.DB, id, "parse", "failed", { errorClass: "ParseError" });
    expect(named.ok && named.value.error).toBe("ParseError");
    const quoted = await recordEvent(env.DB, id, "parse", "failed", { errorClass: "the subject was 'pay now'" });
    expect(quoted.ok && quoted.value.error).toBe("Error");
  });
});

describe("a model call the budget refused (D03 T01 §2)", () => {
  it("ends the step at once, never retried, and keeps the cap and model as the case's reason", async () => {
    const refused = await safely(async () => {
      throw new BudgetExceeded("day", "muse-spark-1.3");
    }).catch((error: Error) => error);
    expect((refused as Error).message).toBe("budget:day:muse-spark-1.3");
    const id = await caseWith(forwards["inline-forward"]);
    const { output } = await run(id, (m) =>
      m.mockStepError({ name: "checks" }, new NonRetryableError("budget:day:muse-spark-1.3"), 1),
    );
    expect((await caseRow(id))?.status).toBe("partial");
    expect(output).toMatchObject({
      state: { status: "partial", failedStep: "checks", errorClass: "budget:day:muse-spark-1.3" },
    });
  });
});

it("fills the protected candidates across organisations, and fails the step when that read fails (D02 T01 §9)", async () => {
  // Another business, effectively protected: a member of org A checking mail that claims it must carry it.
  const other = "org-candidate-other";
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(other, "Other Freight (fictional)", `org-${other}`, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
  )
    .bind("claim-candidate-other", other, "other-freight.example", "t".repeat(16), now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO org_addresses (id, org_id, address, state, verified_at, created_at) VALUES (?, ?, ?, 'verified', ?, ?)",
  )
    .bind("addr-candidate-other", other, "money@other-freight.example", now, now)
    .run();
  await setIdentity(env.DB, other, "u1", {
    displayNames: ["Other Freight"],
    financeContact: "money@other-freight.example",
    protected: true,
  });
  expect(await protectedIdentities(env.DB)).toContainEqual({
    orgId: other,
    names: ["Other Freight"],
    domains: ["other-freight.example"],
    logo: null,
  });
  // A protected identity whose verified domain is then removed is not a candidate.
  const lapsed = "org-candidate-lapsed";
  await env.DB.prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(lapsed, "Lapsed Freight (fictional)", `org-${lapsed}`, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
  )
    .bind("claim-candidate-lapsed", lapsed, "lapsed-freight.example", "t".repeat(16), now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO org_addresses (id, org_id, address, state, verified_at, created_at) VALUES (?, ?, ?, 'verified', ?, ?)",
  )
    .bind("addr-candidate-lapsed", lapsed, "money@lapsed-freight.example", now, now)
    .run();
  await setIdentity(env.DB, lapsed, "u1", {
    displayNames: ["Lapsed Freight"],
    financeContact: "money@lapsed-freight.example",
    protected: true,
  });
  await env.DB.prepare("DELETE FROM org_domains WHERE org_id = ?").bind(lapsed).run();
  const org = "org-candidate-case";
  const made = await createCase(env.DB, { orgId: org, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  await putRaw(store, id, new TextEncoder().encode("From: billing@other-freight.example\r\n\r\nPay.\r\n"));
  await putParsed(store, id, {
    headers: [{ name: "From", value: "billing@other-freight.example" }],
    text: "Pay.",
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
    forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
  });
  // A probe check (this file's last test, so its registration reaches no other test) reads what a check
  // receives: protected B present for A's case with its exact keys, the lapsed identity absent.
  let seen: ProtectedCandidates | undefined;
  checkRegistry.register({
    name: "probe.candidates",
    needs: [],
    timeoutMs: 1000,
    run: (view) => {
      seen = view.protectedCandidates;
      return [];
    },
  });
  await checks(store, id, parsedKey(id), { orgId: org, channel: "email" }, async () => []);
  expect(((await readCheckOutcomes(env.DB, id)) ?? []).length).toBeGreaterThan(0);
  expect(seen?.omitted).toBe(0);
  expect(seen?.candidates).toContainEqual({
    orgId: other,
    names: ["Other Freight"],
    namesOmitted: 0,
    domains: ["other-freight.example"],
    domainsOmitted: 0,
    logo: null,
  });
  expect(seen?.candidates.map((c) => c.orgId)).not.toContain(lapsed);
  expect(Object.keys(seen?.candidates[0] as object).sort()).toEqual([
    "domains",
    "domainsOmitted",
    "logo",
    "names",
    "namesOmitted",
    "orgId",
  ]);
  // A failed candidate read fails the step; it never reads as no candidate.
  const failingDb = new Proxy(env.DB, {
    get: (target, name) =>
      name === "prepare"
        ? (sql: string) => {
            if (sql.includes("FROM identities")) throw new Error("identity store down");
            return target.prepare(sql);
          }
        : Reflect.get(target, name).bind(target),
  }) as unknown as D1Database;
  await expect(
    checks(
      { db: failingDb, bucket: store.bucket },
      id,
      parsedKey(id),
      { orgId: org, channel: "email" },
      async () => [],
    ),
  ).rejects.toThrow(/identity store down/);
});

describe("several originals in one forward (D01 T01 §12)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM cases WHERE org_id = ?").bind(ORG).run();
  });

  it("makes a case of the second original, records it before starting it, and resumes the same child on retry", async () => {
    const id = await caseWith(forwards["two-originals"]);
    const started: string[] = [];
    const fanout = {
      start: async (childCaseId: string) => {
        started.push(childCaseId);
      },
    };
    await parse(store, id, MAIL, fanout);
    const { childrenOf } = await import("../../src/intake/children");
    const children = await childrenOf(env.DB, id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ position: 2, state: "started" });
    expect(started).toEqual([children[0]?.childCaseId]);
    const childId = children[0]?.childCaseId as string;
    // The child's own message is stored, and its parse reads it as the original itself.
    const childRaw = await readArtefact(store, childId, rawKey(childId));
    expect(childRaw && "body" in childRaw).toBe(true);
    await parse(store, childId, MAIL, fanout);
    const childSummary = await readArtefact(store, childId, parsedKey(childId));
    if (!childSummary || !("body" in childSummary)) throw new Error("the child's summary is missing");
    expect(JSON.parse(new TextDecoder().decode(childSummary.body)).forward.path).not.toBe("inline");
    // A retried parent parse makes no second child and starts nothing new.
    await parse(store, id, MAIL, fanout);
    expect(await childrenOf(env.DB, id)).toHaveLength(1);
    expect(started).toHaveLength(1);
  });

  it("resumes an interrupted fan-out on retry with the same derived child", async () => {
    const id = await caseWith(forwards["two-originals"]);
    const { childrenOf, childCaseIdFor } = await import("../../src/intake/children");
    await expect(
      parse(store, id, MAIL, {
        start: async () => {
          throw new Error("workflow create lost");
        },
      }),
    ).rejects.toThrow(/workflow create lost/);
    const started: string[] = [];
    await parse(store, id, MAIL, {
      start: async (childCaseId: string) => {
        started.push(childCaseId);
      },
    });
    const children = await childrenOf(env.DB, id);
    expect(children).toHaveLength(1);
    expect(children[0]?.childCaseId).toBe(await childCaseIdFor(id, 2));
    expect(children[0]?.state).toBe("started");
    expect(started).toEqual([children[0]?.childCaseId]);
  });

  it("sends one grouped reply when every case is terminal, and nothing before", async () => {
    const parentId = await caseWith(forwards["two-originals"]);
    const started: string[] = [];
    await parse(store, parentId, MAIL, {
      start: async (childCaseId: string) => {
        started.push(childCaseId);
      },
    });
    const { childrenOf } = await import("../../src/intake/children");
    const childId = (await childrenOf(env.DB, parentId))[0]?.childCaseId as string;
    // The child parses its own original, which stores its subject for its block.
    await parse(store, childId, MAIL, { start: async () => {} });
    // Both cases need a forwarder for the reply; the parent's case was made without one here.
    await env.DB.prepare("UPDATE cases SET forwarded_by = ? WHERE id IN (?, ?)")
      .bind("member@demo.isitlegit.co.za", parentId, childId)
      .run();
    const requests: { text_body: string }[] = [];
    const real = globalThis.fetch;
    const { SMTP2GO_URL } = await import("../../src/mail/smtp2go");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-1" } });
    });
    try {
      // The child is still running: the parent sends nothing.
      const waiting = await reply(env, parentId, { status: "ready", verdict: "safe" });
      expect(waiting.mail).toBe("waiting");
      expect(requests).toHaveLength(0);
      // The child finishing first sends nothing either: the parent is not finished.
      const childWaiting = await reply(env, childId, { status: "ready", verdict: "safe" });
      expect(childWaiting.mail).toBe("waiting");
      expect(requests).toHaveLength(0);
      // Both terminal with verdicts: one grouped reply, each original with its own link.
      for (const [caseId, verdict] of [
        [parentId, "suspicious"],
        [childId, "malicious"],
      ] as const) {
        await setStatus(env.DB, ORG, caseId, "running");
        const stored = await storeVerdict(env.DB, ORG, caseId, {
          verdict,
          headline: "h",
          meaning: "m",
          confidence: 0.5,
          reasons: [],
          actions: [],
          source: "rules",
        });
        expect(stored.ok).toBe(true);
        await setStatus(env.DB, ORG, caseId, "done");
      }
      const sent = await reply(env, childId, { status: "ready", verdict: "malicious" });
      expect(sent.mail).toBe("sent");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.text_body).toContain("1. Updated banking details");
      expect(requests[0]?.text_body).toContain("2. Updated banking details");
      expect(requests[0]?.text_body).toContain("Fraud");
      // A second attempt under the same group key sends nothing new.
      const again = await reply(env, parentId, { status: "ready", verdict: "suspicious" });
      expect(again.mail).toBe("duplicate");
      expect(requests).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("preserves counterparty origin and isolation on fan-out children (round 1 finding 1)", async () => {
    const cpOrg = "org-cp-fanout";
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(cpOrg, "CP Freight (fictional)", `org-${cpOrg}`, now)
      .run();
    const { addSupplier } = await import("../../src/invoice/ledger");
    await addSupplier(env.DB, cpOrg, "owner", {
      name: "Secret Supplier",
      domains: ["secretsupplier.example"],
    });
    // Set member cap to 0 so a member admission would be refused; counterparty admission uses counterparty limits.
    await env.DB.prepare("INSERT OR REPLACE INTO org_limits (org_id, daily_cases_override) VALUES (?, 0)")
      .bind(cpOrg)
      .run();
    const { admitCase } = await import("../../src/db/cases");
    const checker = "outsider@customer-cp.example";
    const forwardBytes = new TextEncoder().encode(
      [
        `From: ${checker}`,
        "To: check@isitlegit.co.za",
        "Subject: Fwd: two supplier mails",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: message/rfc822",
        "",
        "From: Billing <billing@secretsupplier.com>",
        "Subject: First invoice",
        "",
        "Pay 1.",
        "--b",
        "Content-Type: message/rfc822",
        "",
        "From: Billing <billing@secretsupplier.com>",
        "Subject: Second invoice",
        "",
        "Pay 2.",
        "--b--",
        "",
      ].join("\r\n"),
    );
    const made = await admitCase(env.DB, {
      orgId: cpOrg,
      channel: "email",
      headersAvailable: false,
      forwardedBy: checker,
      origin: "counterparty",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.error.message);
    const parentId = made.value.id;
    await putRaw(store, parentId, forwardBytes);
    await parse(store, parentId, MAIL, { start: async () => {} });
    const { childrenOf } = await import("../../src/intake/children");
    const children = await childrenOf(env.DB, parentId);
    expect(children).toHaveLength(1);
    expect(children[0]?.state).toBe("started");
    const childId = children[0]?.childCaseId as string;
    const childRow = await env.DB.prepare("SELECT origin FROM cases WHERE id = ?")
      .bind(childId)
      .first<{ origin: string | null }>();
    expect(childRow?.origin).toBe("counterparty");
    await parse(store, childId, MAIL, { start: async () => {} });
    await checks(store, childId, parsedKey(childId), { orgId: cpOrg, channel: "email" }, async () => []);
    const childEvidence = await readEvidence(env.DB, childId);
    expect(JSON.stringify(childEvidence)).not.toContain("secretsupplier.example");
    const seen = await env.DB.prepare("SELECT COUNT(*) AS n FROM sender_observations WHERE case_id = ?")
      .bind(childId)
      .first<{ n: number }>();
    expect(seen?.n ?? 0).toBe(0);
  });

  it("settles an unstarted child after exhausted fan-out retries so the group still replies (round 1 finding 2)", async () => {
    const threeForward = new TextEncoder().encode(
      [
        "From: member@demo.isitlegit.co.za",
        "To: check@isitlegit.co.za",
        "Subject: Fwd: three originals",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: message/rfc822",
        "",
        "From: a@bank.example",
        "Subject: First original",
        "",
        "One.",
        "--b",
        "Content-Type: message/rfc822",
        "",
        "From: b@bank.example",
        "Subject: Second original",
        "",
        "Two.",
        "--b",
        "Content-Type: message/rfc822",
        "",
        "From: c@bank.example",
        "Subject: Third original",
        "",
        "Three.",
        "--b--",
        "",
      ].join("\r\n"),
    );
    const parentId = await caseWith(threeForward);
    await env.DB.prepare("UPDATE cases SET forwarded_by = ? WHERE id = ?")
      .bind("member@demo.isitlegit.co.za", parentId)
      .run();
    let starts = 0;
    await expect(
      parse(store, parentId, MAIL, {
        start: async () => {
          starts += 1;
          if (starts === 2) throw new Error("second child workflow create failed");
        },
      }),
    ).rejects.toThrow(/second child workflow create failed/);
    // All manifest rows were recorded before the first child started, and the parent then exhausted its parse retries.
    const { childrenOf } = await import("../../src/intake/children");
    const children = await childrenOf(env.DB, parentId);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.state)).toEqual(["started", "admitted"]);
    await recordFailure(env.DB, parentId, "parse", "Error");
    const firstChildId = children[0]?.childCaseId as string;
    const secondChildId = children[1]?.childCaseId as string;
    await parse(store, firstChildId, MAIL, { start: async () => {} });
    await setStatus(env.DB, ORG, firstChildId, "running");
    await storeVerdict(env.DB, ORG, firstChildId, {
      verdict: "safe",
      headline: "h",
      meaning: "m",
      confidence: 0.9,
      reasons: [],
      actions: [],
      source: "rules",
    });
    await setStatus(env.DB, ORG, firstChildId, "done");
    const requests: { text_body: string }[] = [];
    const real = globalThis.fetch;
    const { SMTP2GO_URL } = await import("../../src/mail/smtp2go");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-1" } });
    });
    const unstartableEnv: Env = {
      ...env,
      ANALYSIS: {
        create: () => Promise.reject(new Error("workflow unavailable")),
        get: () => Promise.reject(new Error("workflow unavailable")),
      } as unknown as Env["ANALYSIS"],
    };
    try {
      const sent = await reply(unstartableEnv, firstChildId, { status: "ready", verdict: "safe" });
      expect(sent.mail).toBe("sent");
      expect((await caseRow(secondChildId))?.status).toBe("partial");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.text_body).toContain("2. Second original");
      expect(requests[0]?.text_body).toContain("Looks legitimate");
      expect(requests[0]?.text_body).toContain("3. A message with no subject");
      expect(requests[0]?.text_body).toContain("Check failed · no verdict");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("fans out valid siblings even when the first original is a malformed .msg (round 1 finding 3)", async () => {
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
    // OLE magic header followed by truncated bytes: extractOriginals recognises it as a .msg, parseMsg throws ParseError.
    const malformedMsg = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3, 4]);
    const validMsg = msgs.full;
    const forwardBytes = new TextEncoder().encode(
      [
        "From: member@demo.isitlegit.co.za",
        "To: check@isitlegit.co.za",
        "Subject: Fwd: two msg files",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        'Content-Type: application/vnd.ms-outlook; name="bad.msg"',
        'Content-Disposition: attachment; filename="bad.msg"',
        "Content-Transfer-Encoding: base64",
        "",
        b64(malformedMsg),
        "--b",
        'Content-Type: application/vnd.ms-outlook; name="good.msg"',
        'Content-Disposition: attachment; filename="good.msg"',
        "Content-Transfer-Encoding: base64",
        "",
        b64(validMsg),
        "--b--",
        "",
      ].join("\r\n"),
    );
    const parentId = await caseWith(forwardBytes);
    await env.DB.prepare("UPDATE cases SET forwarded_by = ? WHERE id = ?")
      .bind("member@demo.isitlegit.co.za", parentId)
      .run();
    const started: string[] = [];
    await expect(
      parse(store, parentId, MAIL, {
        start: async (childCaseId) => {
          started.push(childCaseId);
        },
      }),
    ).rejects.toThrow("ParseError");
    expect(started).toHaveLength(1);
    await recordFailure(env.DB, parentId, "parse", "ParseError");
    const childId = started[0] as string;
    await parse(store, childId, MAIL, { start: async () => {} });
    await setStatus(env.DB, ORG, childId, "running");
    await storeVerdict(env.DB, ORG, childId, {
      verdict: "suspicious",
      headline: "h",
      meaning: "m",
      confidence: 0.8,
      reasons: [],
      actions: [],
      source: "rules",
    });
    await setStatus(env.DB, ORG, childId, "done");
    const requests: { text_body: string; html_body: string }[] = [];
    const real = globalThis.fetch;
    const { SMTP2GO_URL } = await import("../../src/mail/smtp2go");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-1" } });
    });
    try {
      const sent = await reply(env, childId, { status: "ready", verdict: "suspicious" });
      expect(sent.mail).toBe("sent");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.text_body).toContain(
        "We could not read the message you forwarded. Forward it again as an attachment; if it was an Outlook .msg file, save it as .eml first.",
      );
      expect(requests[0]?.text_body).toContain("Suspicious");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("throws ReplyNotSent on a failed grouped send, and resends it under reply:group:<parent> (round 1 findings 4, 5, 6)", async () => {
    const capOrg = "org-grouped-cap-resend";
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(capOrg, "Cap & Resend Co", `org-${capOrg}`, now)
      .run();
    // Allow 2 cases today (parent + 1 child), refusing a 3rd original by the daily cap.
    await env.DB.prepare("INSERT OR REPLACE INTO org_limits (org_id, daily_cases_override) VALUES (?, 2)")
      .bind(capOrg)
      .run();
    const { admitCase } = await import("../../src/db/cases");
    const part = (n: number) =>
      `--b\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="o${n}.eml"\r\n\r\nFrom: a@bank.example\r\nSubject: Original ${n}\r\n\r\nPay ${n}.\r\n`;
    const three = new TextEncoder().encode(
      `From: member@demo.isitlegit.co.za\r\nSubject: Fwd: batch check\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n${[1, 2, 3].map(part).join("")}--b--\r\n`,
    );
    const made = await admitCase(env.DB, {
      orgId: capOrg,
      channel: "email",
      headersAvailable: false,
      forwardedBy: "member@demo.isitlegit.co.za",
    });
    if (!made.ok) throw new Error(made.error.message);
    const parentId = made.value.id;
    await putRaw(store, parentId, three);
    await parse(store, parentId, MAIL, { start: async () => {} });
    const { childrenOf } = await import("../../src/intake/children");
    const children = await childrenOf(env.DB, parentId);
    expect(children.map((c) => [c.position, c.state])).toEqual([
      [2, "started"],
      [3, "refused-cap"],
    ]);
    const childId = children[0]?.childCaseId as string;
    await parse(store, childId, MAIL, { start: async () => {} });
    await setStatus(env.DB, capOrg, parentId, "running");
    await storeVerdict(env.DB, capOrg, parentId, {
      verdict: "safe",
      headline: "h",
      meaning: "m",
      confidence: 0.9,
      reasons: [],
      actions: [],
      source: "rules",
    });
    await setStatus(env.DB, capOrg, parentId, "done");
    // Child ends partial on the daily model budget so its block carries the budget:day advice.
    await recordFailure(env.DB, childId, "verdict", "budget:day:muse-spark-1.3");

    let failProvider = true;
    const requests: { text_body: string; html_body: string; subject: string }[] = [];
    const real = globalThis.fetch;
    const { SMTP2GO_URL } = await import("../../src/mail/smtp2go");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      if (failProvider)
        return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-group-1" } });
    });
    try {
      await expect(
        reply(env, childId, { status: "partial", failedStep: "verdict", errorClass: "budget:day:muse-spark-1.3" }),
      ).rejects.toThrow("ReplyNotSent");

      // Request a resend of the failed grouped send and run the resend job.
      const { requeueStatement } = await import("../../src/mail/settle");
      const { resendRequested } = await import("../../src/mail/resend");
      await env.DB.prepare(requeueStatement(`reply:group:${parentId}`, new Date().toISOString())).run();
      failProvider = false;
      const report = await resendRequested(env);
      expect(report.done).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.subject).toBe("Re: Fwd: batch check");
      expect(requests[0]?.text_body).toContain("1. Original 1");
      expect(requests[0]?.text_body).toContain("2. Original 2");
      expect(requests[0]?.text_body).toContain(
        "Today's checking capacity is used up. Forward the message again tomorrow. Until it is checked, do not pay, click or reply.",
      );
      expect(requests[0]?.text_body).toContain("1 more message was not checked: 1 over today's check limit.");
      // Member frame and linked dispute footer in the HTML body (SPEC N1).
      expect(requests[0]?.html_body).toContain('<table role="presentation" width="600"');
      expect(requests[0]?.html_body).toContain('alt="IsItLegit"');
      expect(requests[0]?.html_body).toMatch(/<a href="[^"]*dispute=1"[^>]*>Tell us on the report page<\/a>\./);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("recovers an interrupted manifest and retries transient child or verdict read failures (round 2 findings 1, 2, 3)", async () => {
    const part = (n: number) =>
      `--b\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="o${n}.eml"\r\n\r\nFrom: a@bank.example\r\nSubject: Original ${n}\r\n\r\nPay ${n}.\r\n`;
    const three = new TextEncoder().encode(
      `From: member@demo.isitlegit.co.za\r\nSubject: Fwd: three check\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n${[1, 2, 3].map(part).join("")}--b--\r\n`,
    );
    const parentId = await caseWith(three);
    await env.DB.prepare("UPDATE cases SET forwarded_by = ? WHERE id = ?")
      .bind("member@demo.isitlegit.co.za", parentId)
      .run();
    // Simulate a D1 failure on the second child admission in fanOut, after the expected manifest batch and
    // the first child's admission have already succeeded, then exhaust parse retries on the parent.
    let admitCount = 0;
    const flakyAdmitDb = new Proxy(env.DB, {
      get: (target, name) =>
        name === "prepare"
          ? (sql: string) => {
              if (sql.startsWith("INSERT INTO cases (")) {
                admitCount += 1;
                if (admitCount === 2) throw new Error("transient D1 failure on third original admission");
              }
              return target.prepare(sql);
            }
          : Reflect.get(target, name).bind(target),
    }) as unknown as D1Database;
    await expect(
      parse({ db: flakyAdmitDb, bucket: store.bucket }, parentId, MAIL, { start: async () => {} }),
    ).rejects.toThrow(/transient D1 failure on third original admission/);
    const { childrenOf } = await import("../../src/intake/children");
    const recorded = await childrenOf(env.DB, parentId);
    expect(recorded.map((c) => [c.position, c.state])).toEqual([
      [2, "admitted"],
      [3, "pending"],
    ]);
    // Also simulate a case where position 3's row was missing before parent parse retries exhausted.
    await env.DB.prepare("DELETE FROM case_children WHERE parent_case_id = ? AND position = 3").bind(parentId).run();
    await recordFailure(env.DB, parentId, "parse", "Error");

    const firstChildId = recorded[0]?.childCaseId as string;
    const secondChildId = recorded[1]?.childCaseId as string;
    await recordFailure(env.DB, firstChildId, "parse", "Error");
    await reply(env, parentId, { status: "partial", failedStep: "parse", errorClass: "Error" });
    const afterRecovery = await childrenOf(env.DB, parentId);
    expect(afterRecovery).toHaveLength(2);
    expect(afterRecovery.map((c) => c.position)).toEqual([2, 3]);
    // Finish the recovered third original with a safe verdict.
    await parse(store, secondChildId, MAIL, { start: async () => {} });
    await setStatus(env.DB, ORG, secondChildId, "running");
    await storeVerdict(env.DB, ORG, secondChildId, {
      verdict: "safe",
      headline: "h",
      meaning: "m",
      confidence: 0.9,
      reasons: [],
      actions: [],
      source: "rules",
    });
    await setStatus(env.DB, ORG, secondChildId, "done");

    // Finding 2: a transient D1 failure reading a child case in groupedReply throws instead of returning waiting.
    let caseReads = 0;
    const failChildLookupEnv: Env = {
      ...env,
      DB: new Proxy(env.DB, {
        get: (target, name) =>
          name === "prepare"
            ? (sql: string) => {
                if (sql.includes("FROM cases WHERE id = ?")) {
                  caseReads += 1;
                  if (caseReads === 3) throw new Error("child lookup D1 down");
                }
                return target.prepare(sql);
              }
            : Reflect.get(target, name).bind(target),
      }) as unknown as D1Database,
    };
    await expect(reply(failChildLookupEnv, secondChildId, { status: "ready", verdict: "safe" })).rejects.toThrow(
      /reading a fan-out child for its grouped reply: database/,
    );

    // Finding 3: a transient D1 failure in getVerdict throws instead of sending a false "no verdict" reply.
    const failVerdictEnv: Env = {
      ...env,
      DB: new Proxy(env.DB, {
        get: (target, name) =>
          name === "prepare"
            ? (sql: string) => {
                if (sql.includes("FROM case_verdicts WHERE case_id = ?")) throw new Error("verdict table D1 down");
                return target.prepare(sql);
              }
            : Reflect.get(target, name).bind(target),
      }) as unknown as D1Database,
    };
    await expect(reply(failVerdictEnv, secondChildId, { status: "ready", verdict: "safe" })).rejects.toThrow(
      /verdict table D1 down/,
    );

    // Once D1 recovers, the grouped reply sends all 3 originals (none silently dropped, verdict preserved).
    const requests: { text_body: string }[] = [];
    const real = globalThis.fetch;
    const { SMTP2GO_URL } = await import("../../src/mail/smtp2go");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-r2" } });
    });
    try {
      const sent = await reply(env, secondChildId, { status: "ready", verdict: "safe" });
      expect(sent.mail).toBe("sent");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.text_body).toContain("1. A message with no subject");
      expect(requests[0]?.text_body).toContain("2. A message with no subject");
      expect(requests[0]?.text_body).toContain("3. Original 3");
      expect(requests[0]?.text_body).toContain("Looks legitimate");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("recovers from an empty manifest when recordExpectedChildren fails throughout parse (round 3 finding 1)", async () => {
    const parentId = await caseWith(forwards["two-originals"]);
    await env.DB.prepare("UPDATE cases SET forwarded_by = ? WHERE id = ?")
      .bind("member@demo.isitlegit.co.za", parentId)
      .run();
    const failBatchDb = new Proxy(env.DB, {
      get: (target, name) =>
        name === "batch"
          ? () => Promise.reject(new Error("manifest batch D1 down"))
          : Reflect.get(target, name).bind(target),
    }) as unknown as D1Database;
    await expect(
      parse({ db: failBatchDb, bucket: store.bucket }, parentId, MAIL, { start: async () => {} }),
    ).rejects.toThrow(/manifest batch D1 down/);
    const { childrenOf } = await import("../../src/intake/children");
    expect(await childrenOf(env.DB, parentId)).toHaveLength(0);
    await recordFailure(env.DB, parentId, "parse", "Error");

    const requests: { text_body: string }[] = [];
    const real = globalThis.fetch;
    const { SMTP2GO_URL } = await import("../../src/mail/smtp2go");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-r3" } });
    });
    try {
      // With an empty manifest and no summary, reply still inspects the stored raw forward, enters grouped
      // recovery, records and admits the second original, starts its Workflow and waits instead of sending a
      // single-case reply that drops original 2.
      const firstReply = await reply(env, parentId, { status: "partial", failedStep: "parse", errorClass: "Error" });
      expect(firstReply.mail).toBe("waiting");
      expect(requests).toHaveLength(0);
      const children = await childrenOf(env.DB, parentId);
      expect(children).toHaveLength(1);
      const childId = children[0]?.childCaseId as string;
      const childInstance = await introspectWorkflowInstance(env.ANALYSIS, childId);
      try {
        await childInstance.waitForStatus("complete");
      } finally {
        await childInstance.dispose();
      }
      expect(requests).toHaveLength(1);
      expect(requests[0]?.text_body).toContain("1. A message with no subject");
      expect(requests[0]?.text_body).toContain("Check failed · no verdict");
      expect(requests[0]?.text_body).toContain("2. Updated banking details");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("retries failed raw discovery and restores missing raw bytes for admitted unstarted children (round 4 findings 1, 2)", async () => {
    const parentId = await caseWith(forwards["two-originals"]);
    await env.DB.prepare("UPDATE cases SET forwarded_by = ? WHERE id = ?")
      .bind("member@demo.isitlegit.co.za", parentId)
      .run();
    const brokenReadBucket = new Proxy(env.ARTEFACTS, {
      get: (target, name) =>
        name === "get" ? () => Promise.reject(new Error("R2 read down")) : Reflect.get(target, name).bind(target),
    }) as unknown as R2Bucket;
    // Finding 1: R2 reads fail through parse exhaustion and the first reply attempt. With no manifest or summary,
    // reply throws so discovery retries instead of sending a single-case reply that drops original 2.
    await expect(
      parse({ db: env.DB, bucket: brokenReadBucket }, parentId, MAIL, { start: async () => {} }),
    ).rejects.toThrow(/R2 read down/);
    await recordFailure(env.DB, parentId, "parse", "StoreError");
    await expect(
      reply({ ...env, ARTEFACTS: brokenReadBucket }, parentId, {
        status: "partial",
        failedStep: "parse",
        errorClass: "StoreError",
      }),
    ).rejects.toThrow(/R2 read down/);

    // Finding 2: child admission succeeds in fanOut, then child raw put fails throughout parse retries;
    // when storage recovers before reply, groupedReply restores the admitted child's raw bytes from the parent forward.
    const parent2Id = await caseWith(forwards["two-originals"]);
    await env.DB.prepare("UPDATE cases SET forwarded_by = ? WHERE id = ?")
      .bind("member@demo.isitlegit.co.za", parent2Id)
      .run();
    const brokenPutBucket = new Proxy(env.ARTEFACTS, {
      get: (target, name) =>
        name === "put" ? () => Promise.reject(new Error("R2 put down")) : Reflect.get(target, name).bind(target),
    }) as unknown as R2Bucket;
    await expect(
      parse({ db: env.DB, bucket: brokenPutBucket }, parent2Id, MAIL, { start: async () => {} }),
    ).rejects.toThrow(/R2 put down/);
    const { childrenOf } = await import("../../src/intake/children");
    const children = await childrenOf(env.DB, parent2Id);
    expect(children).toHaveLength(1);
    expect(children[0]?.state).toBe("admitted");
    const childId = children[0]?.childCaseId as string;
    expect(await readArtefact(store, childId, rawKey(childId))).toBeNull();
    await recordFailure(env.DB, parent2Id, "parse", "StoreError");

    const requests: { text_body: string }[] = [];
    const real = globalThis.fetch;
    const { SMTP2GO_URL } = await import("../../src/mail/smtp2go");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-r4" } });
    });
    try {
      const firstReply = await reply(env, parent2Id, {
        status: "partial",
        failedStep: "parse",
        errorClass: "StoreError",
      });
      expect(firstReply.mail).toBe("waiting");
      expect(await readArtefact(store, childId, rawKey(childId))).toMatchObject({ body: expect.any(Uint8Array) });
      const childInstance = await introspectWorkflowInstance(env.ANALYSIS, childId);
      try {
        await childInstance.waitForStatus("complete");
      } finally {
        await childInstance.dispose();
      }
      expect(requests).toHaveLength(1);
      expect(requests[0]?.text_body).toContain("2. Updated banking details");
      expect(requests[0]?.text_body).toContain("Looks legitimate");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("persists the mapped consequence sentence through the verdict step and renders it in both the reply and report consumers (D04 T01 §16)", async () => {
    const { FLOOR_CONSEQUENCES } = await import("../../src/agent/rule-verdict");
    const { buildReply } = await import("../../src/mail/reply");
    const { meaningOf, VerdictSection } = await import("../../src/web/pages/report-verdict");

    const caseId = await caseWith(forwards["inline-forward"]);
    await saveEvidence(env.DB, caseId, [
      {
        check: "invoice.bank_changed",
        severity: "critical",
        summary: "The invoice's bank account differs from the supplier's recorded account.",
        detail: { supplier: "Fynbos Freight" },
        artefacts: [],
      },
    ]);

    await env.DB.prepare("UPDATE cases SET status = 'running' WHERE id = ?").bind(caseId).run();
    const { view } = await verdict(env, env.DB, store, caseId);
    expect(view.verdict).toBe("malicious");
    expect(view.meaning).toBe(FLOOR_CONSEQUENCES.bank);

    const stored = await storeVerdict(env.DB, ORG, caseId, view);
    expect(stored.ok).toBe(true);
    const readBack = await getVerdict(env.DB, caseId);
    if (!readBack?.ok) throw new Error("expected stored verdict");
    expect(readBack.value.meaning).toBe(FLOOR_CONSEQUENCES.bank);

    // Reply consumer reads the stored consequence sentence as meaning
    const built = buildReply({
      parentSubject: "Fwd: Invoice 104",
      headersAvailable: true,
      otherOriginals: 0,
      report: { status: "ready", view: readBack.value },
      reportUrl: "https://isitlegit.co.za/r/tok",
      design: { appUrl: "https://isitlegit.co.za" },
    });
    expect(built.text).toContain(FLOOR_CONSEQUENCES.bank);
    expect(built.html).toContain(FLOOR_CONSEQUENCES.bank.replaceAll("'", "&#39;"));

    // Report consumer reads the stored consequence sentence as meaning
    const reportVal = readBack.value;
    expect(meaningOf(reportVal)).toBe(FLOOR_CONSEQUENCES.bank);
    const rendered = String(
      VerdictSection({
        state: "complete",
        stored: reportVal,
        evidence: [{ id: "E1", severity: "critical" }],
        voice: false,
      }),
    );
    expect(rendered).toContain(FLOOR_CONSEQUENCES.bank.replaceAll("'", "&#39;"));
  });
});

it("retains delayed validation writes through the production Workflow verdict caller", async () => {
  const id = await caseWith(forwards["inline-forward"]);
  await saveEvidence(env.DB, id, [
    {
      check: "link.credential_form",
      severity: "high",
      summary: "A sign-in form.",
      detail: { page: "https://phish.example/signin" },
      artefacts: [],
    },
  ]);
  const good = {
    verdict: "suspicious",
    confidence: 0.8,
    headline: "Check this request",
    explanation: "A sign-in form is present [E1].",
    cited_evidence_ids: ["E1"],
    recommended_actions: ["Verify the sender."],
    meaning: "Check through a known channel.",
  };
  const bodies = ["done", "PRIVATE invalid JSON", JSON.stringify(good)];
  let calls = 0;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: bodies[calls++] }] }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let retained = 0;
  let lifetimeSupplied = false;
  const delayedDb = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("INSERT INTO model_validation_diagnostics")) return statement;
          return {
            bind: (...args: unknown[]) => ({
              first: () =>
                new Promise<void>((resolve) => setTimeout(resolve, 150)).then(() => statement.bind(...args).first()),
            }),
          };
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const originalRunAgent = agentModule.runAgent;
  const agentSpy = vi.spyOn(agentModule, "runAgent").mockImplementation(async (ctx, caseId) => {
    lifetimeSupplied = typeof ctx.meta.waitUntil === "function";
    const retain = ctx.meta.waitUntil;
    return originalRunAgent(
      {
        ...ctx,
        db: delayedDb,
        meta: {
          ...ctx.meta,
          ...(retain
            ? {
                waitUntil: (promise: Promise<unknown>) => {
                  retained++;
                  retain(promise);
                },
              }
            : {}),
        },
      },
      caseId,
    );
  });
  const instance = await introspectWorkflowInstance(env.ANALYSIS, id);
  try {
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.disableSleeps();
      for (const name of ["checks", "walkthrough", "vision", "invoice", "verification"])
        await m.mockStepResult({ name }, { skipped: true });
      await m.mockStepResult({ name: "reply" }, { mail: "none" });
    });
    await env.ANALYSIS.create({ id, params: { caseId: id } });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toMatchObject({ state: { status: "ready", verdict: "suspicious" } });
    expect(calls).toBe(3);
    expect(await getVerdict(env.DB, id)).toMatchObject({ ok: true, value: { source: "agent" } });
    expect(lifetimeSupplied).toBe(true);
    expect(retained).toBe(1);
    expect(errors.mock.calls).toEqual([["diagnostic-write-late"]]);
    await vi.waitFor(async () => {
      expect(
        (await env.DB.prepare("SELECT call_id FROM model_validation_diagnostics WHERE case_id = ?").bind(id).all())
          .results,
      ).toHaveLength(1);
    });
    const rows = (
      await env.DB.prepare("SELECT diagnostic_json FROM model_validation_diagnostics WHERE case_id = ?")
        .bind(id)
        .all<{ diagnostic_json: string }>()
    ).results;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.diagnostic_json ?? "null")).toMatchObject({
      phase: "structured",
      attempt: 1,
      remaining: 1,
      issues: [{ category: "json_invalid", path: [] }],
    });
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
    expect(
      (
        await env.DB.prepare("SELECT id FROM model_spend WHERE case_id = ? AND error_class = 'output-invalid'")
          .bind(id)
          .all()
      ).results,
    ).toHaveLength(1);
  } finally {
    await instance.dispose();
    fetchSpy.mockRestore();
    agentSpy.mockRestore();
    errors.mockRestore();
  }
});
