import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createCase, setStatus, setVerdict } from "../../src/db/cases";
import { getVerdict, saveVerdict } from "../../src/db/verdicts";
import { parsedKey, putRaw, readArtefact, type Store, StoreError } from "../../src/intake/store";
import { admit, checks, parse, recordFailure, reply, STUB_VERDICT, safely } from "../../src/pipeline/analysis-workflow";
import { recordEvent } from "../../src/pipeline/events";
import { forwards } from "../fixtures/forward/load";
import { msgs } from "../fixtures/msg/load";

// D01 T01 §7: the analysis Workflow through its binding, sleeps and retry delays disabled.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const ORG = "org-workflow";

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
  it("ends an inline forward done with the stub verdict, two events a step, and the reply before done", async () => {
    const id = await caseWith(forwards["inline-forward"]);
    const { reply } = await run(id);
    expect(await caseRow(id)).toMatchObject({ status: "done", verdict: "suspicious", headers_available: 0 });
    const verdict = await getVerdict(env.DB, id);
    expect(verdict?.ok && verdict.value).toMatchObject({
      headline: "Analysis in progress: checks are not built yet",
      confidence: 0,
      source: "stub",
    });
    const steps = (await events(id)).map((e) => `${e.step}:${e.status}`);
    expect(steps).toEqual([
      ...["admit", "parse", "checks", "verdict", "store", "reply", "finish"].flatMap((s) => [
        `${s}:started`,
        `${s}:done`,
      ]),
    ]);
    // The reply step ran while the case was still running, with the ready state; nothing was mailed.
    expect(reply).toEqual({ state: { status: "ready", verdict: "suspicious" }, caseStatus: "running" });
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
    expect(rows.at(-3)).toEqual({ step: "parse", status: "failed", error: "ParseError" });
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
      expect((await events(id)).find((e) => e.status === "failed")?.step, step).toBe(step);
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
    expect(await admit(env.DB, id)).toEqual({ admit: true, orgId: ORG });
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
    await run(id);
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
    expect(await caseRow(id)).toMatchObject({ status: "partial", verdict: "suspicious" });
    expect((await events(id)).find((e) => e.status === "failed")?.step).toBe("finish");
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
    await expect(parse({ bucket: bucketDown, db: env.DB }, id)).rejects.toThrow();
    const headersDown = {
      prepare: (sql: string) =>
        sql.startsWith("UPDATE cases SET headers_available")
          ? { bind: () => ({ first: () => Promise.reject(new Error("D1 down")) }) }
          : env.DB.prepare(sql),
    } as unknown as D1Database;
    await expect(parse({ bucket: env.ARTEFACTS, db: headersDown }, id)).rejects.toThrow(
      /storing the header state: database/,
    );
    // Neither is a refusal the Workflow would not retry.
    for (const broken of [
      { bucket: bucketDown, db: env.DB },
      { bucket: env.ARTEFACTS, db: headersDown },
    ])
      expect(await parse(broken, id).catch((error: Error) => error.name)).not.toBe("NonRetryableError");
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
    await expect(reply(broken, id, { status: "ready", verdict: "suspicious" })).rejects.toThrow(
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
      await m.mockStepResult({ name: "verdict" }, STUB_VERDICT);
      await m.mockStepResult({ name: "store" }, "stored");
    });
    expect((await events(id)).map((e) => `${e.step}:${e.status}`)).toEqual([
      "reply:started",
      "reply:done",
      "finish:started",
      "finish:done",
    ]);
    expect((await caseRow(id))?.status).toBe("done");
  });
});

describe("the checks step and the event writer", () => {
  it("fails checks given a key with no summary", async () => {
    const id = await caseWith(null);
    await expect(checks(store, id, parsedKey(id))).rejects.toThrow(/not stored/);
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
