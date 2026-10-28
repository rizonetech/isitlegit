import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createCase, setStatus, setVerdict } from "../../src/db/cases";
import { getVerdict, saveVerdict } from "../../src/db/verdicts";
import { parsedKey, putRaw, readArtefact, type Store } from "../../src/intake/store";
import { admit, checks, STUB_VERDICT } from "../../src/pipeline/analysis-workflow";
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
      "admit:done",
      ...["parse", "checks", "verdict", "store", "reply", "finish"].flatMap((s) => [`${s}:started`, `${s}:done`]),
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
