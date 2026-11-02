import { env, introspectWorkflowInstance } from "cloudflare:test";
import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it } from "vitest";
import { BRANDS_KEY, BrandTable, bundled, forgetBrandTable, tableId } from "../../src/checks/brands";
import { SummaryRefused } from "../../src/checks/case-view";
import { readEvidence, saveEvidence } from "../../src/checks/evidence";
import { createCase, setStatus, setVerdict } from "../../src/db/cases";
import { getVerdict, saveVerdict, storeVerdict } from "../../src/db/verdicts";
import {
  parsedKey,
  putAttachment,
  putParsed,
  putRaw,
  putVisible,
  rawKey,
  readArtefact,
  type Store,
  StoreError,
} from "../../src/intake/store";
import { BudgetExceeded } from "../../src/meta/guard";
import { admit, checks, parse, recordFailure, reply, STUB_VERDICT, safely } from "../../src/pipeline/analysis-workflow";
import { recordEvent } from "../../src/pipeline/events";
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
      ...["admit", "parse", "checks", "walkthrough", "vision", "invoice"].flatMap((s) => [`${s}:started`, `${s}:done`]),
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

  it("ends partial naming parse, store or reply when each fails on every attempt", async () => {
    for (const step of ["parse", "store", "reply"] as const) {
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

  it("resumes with admission through store cached, running only reply and finish", async () => {
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
