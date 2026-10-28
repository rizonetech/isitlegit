import { env, introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCase, setStatus } from "../../src/db/cases";
import { storeVerdict } from "../../src/db/verdicts";
import { putRaw, type Store } from "../../src/intake/store";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";
import { STUB_VERDICT } from "../../src/pipeline/analysis-workflow";
import { verifyReportLink } from "../../src/web/report-link";
import { forwards } from "../fixtures/forward/load";

// D01 T02 §3: the Workflow's reply step through the binding, reading the request it makes to SMTP2GO (stubbed).
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const ORG = "org-reply";
// A demo alias, which the allowlist admits as a reply's recipient.
const FORWARDER = "member@demo.isitlegit.co.za";

type Request_ = {
  sender: string;
  to: string[];
  subject: string;
  text_body: string;
  html_body?: string;
  custom_headers: { header: string; value: string }[];
};
type Answer = "sent" | "refused" | "silent";
function stubSmtp2go(answers: Answer[]) {
  const requests: Request_[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== SMTP2GO_URL) return real(input, init);
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)] ?? "sent";
    if (answer === "silent") throw new DOMException("timed out", "TimeoutError");
    if (answer === "refused")
      return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
    return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${requests.length}` } });
  });
  return requests;
}
afterEach(() => vi.restoreAllMocks());

async function caseFrom(raw: Uint8Array | null, forwardedBy: string | null = FORWARDER) {
  const made = await createCase(env.DB, {
    orgId: ORG,
    channel: forwardedBy ? "email" : "upload",
    headersAvailable: false,
    forwardedBy,
    messageId: forwardedBy ? "<forward-77@fictional-recipient.example>" : null,
  });
  if (!made.ok) throw new Error(made.error.message);
  if (raw) await putRaw(store, made.value.id, raw);
  return made.value.id;
}

type Mods = Parameters<Awaited<ReturnType<typeof introspectWorkflowInstance>>["modify"]>[0];
async function run(caseId: string, modify?: Mods) {
  const instance = await introspectWorkflowInstance(env.ANALYSIS, caseId);
  try {
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      if (modify) await modify(m);
    });
    await env.ANALYSIS.create({ id: caseId, params: { caseId } });
    await instance.waitForStatus("complete");
  } finally {
    await instance.dispose();
  }
}
const row = (id: string) =>
  env.DB.prepare("SELECT status FROM mail_sends WHERE case_id = ? AND kind = 'reply'")
    .bind(id)
    .all<{ status: string }>();
const caseStatus = async (id: string) =>
  (await env.DB.prepare("SELECT status FROM cases WHERE id = ?").bind(id).first<{ status: string }>())?.status;
const header = (r: Request_, name: string) => r.custom_headers.find((h) => h.header === name)?.value;

describe("the reply step", () => {
  it("sends one threaded reply to the forwarder with the stored verdict and a signed https link", async () => {
    const requests = stubSmtp2go(["sent"]);
    const id = await caseFrom(forwards["inline-forward"]);
    await run(id);
    expect(requests).toHaveLength(1);
    const [sent] = requests as [Request_];
    expect(sent.to).toEqual([FORWARDER]);
    expect(sent.sender).toBe("IsItLegit <check@isitlegit.co.za>");
    expect(sent.subject).toBe("Re: Fwd: Updated banking details");
    expect(header(sent, "In-Reply-To")).toMatch(/^<.+>$/);
    expect(header(sent, "References")).toContain(header(sent, "In-Reply-To") ?? "?");
    expect(header(sent, "Auto-Submitted")).toBe("auto-replied");
    expect(sent.text_body).toContain(STUB_VERDICT.headline);
    // An inline forward carries none of the original's headers, and the reply says how to forward it instead.
    expect(sent.text_body).toContain("Forward as attachment");
    expect(sent.text_body).not.toContain("we checked only the first");
    const link = /https:\/\/isitlegit\.test\/r\/\S+/.exec(sent.text_body)?.[0] ?? "";
    expect(await verifyReportLink(env.REPORT_LINK_SECRET, link)).toMatchObject({ ok: true });
    expect(sent.html_body).toContain(link.replace(/&/g, "&amp;"));
    expect((await row(id)).results).toEqual([{ status: "sent" }]);
    expect(await caseStatus(id)).toBe("done");
  });

  it("asks for each of several attached messages on its own", async () => {
    const requests = stubSmtp2go(["sent"]);
    const id = await caseFrom(forwards["two-originals"]);
    await run(id);
    expect(requests[0]?.text_body).toContain("we checked only the first");
  });

  it("sends the verdict that is stored, not a stand-in", async () => {
    const requests = stubSmtp2go(["sent"]);
    const id = await caseFrom(forwards["inline-forward"]);
    expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
    const stored = {
      ...STUB_VERDICT,
      headline: "Zebra-7 headline",
      reasons: ["Quokka reason"],
      actions: ["Narwhal action"],
    };
    expect((await storeVerdict(env.DB, ORG, id, stored)).ok).toBe(true);
    await run(id, async (m) => {
      await m.mockStepResult({ name: "admit" }, { admit: true, orgId: ORG });
      await m.mockStepResult({ name: "parse" }, `cases/${id}/parsed.json`);
      await m.mockStepResult({ name: "checks" }, { evidence: [] });
      await m.mockStepResult({ name: "verdict" }, stored);
      await m.mockStepResult({ name: "store" }, "stored");
    });
    expect(requests[0]?.text_body).toContain("Zebra-7 headline");
    expect(requests[0]?.text_body).toContain("Quokka reason");
    expect(requests[0]?.html_body).toContain("Narwhal action");
  });

  it("retries a failed send and sends once when it then goes", async () => {
    const requests = stubSmtp2go(["refused", "sent"]);
    const id = await caseFrom(forwards["inline-forward"]);
    await run(id);
    expect((await row(id)).results).toEqual([{ status: "sent" }]);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(await caseStatus(id)).toBe("done");
  });

  it("ends the case partial naming reply when every attempt fails", async () => {
    stubSmtp2go(["refused"]);
    const id = await caseFrom(forwards["inline-forward"]);
    await run(id);
    expect(await caseStatus(id)).toBe("partial");
    const failed = await env.DB.prepare("SELECT step FROM case_events WHERE case_id = ? AND status = 'failed'")
      .bind(id)
      .first<{ step: string }>();
    expect(failed?.step).toBe("reply");
  });

  it("leaves an uncertain send to the reconcile job and finishes the case", async () => {
    stubSmtp2go(["silent"]);
    const id = await caseFrom(forwards["inline-forward"]);
    await run(id);
    expect((await row(id)).results).toEqual([{ status: "uncertain" }]);
    expect(await caseStatus(id)).toBe("done");
  });

  it("sends nothing to a forwarder the allowlist refuses, and nothing for an upload", async () => {
    const requests = stubSmtp2go(["sent"]);
    const refused = await caseFrom(forwards["inline-forward"], "stranger@fictional-outsider.example");
    await run(refused);
    expect((await row(refused)).results).toEqual([{ status: "refused" }]);
    const upload = await caseFrom(forwards["inline-forward"], null);
    await run(upload);
    expect((await row(upload)).results).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("tells the member of a partial case with no raw message or summary, under a subject made by code", async () => {
    const requests = stubSmtp2go(["sent"]);
    const id = await caseFrom(null);
    await run(id);
    expect(await caseStatus(id)).toBe("partial");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.subject).toBe("Re: your IsItLegit check");
    expect(requests[0]?.text_body).toContain("We could not finish checking this message");
    expect(header(requests[0] as Request_, "In-Reply-To")).toBe("<forward-77@fictional-recipient.example>");
  });

  it("never sends a second reply for the same case", async () => {
    const requests = stubSmtp2go(["sent"]);
    const id = await caseFrom(forwards["inline-forward"]);
    await run(id);
    const { reply } = await import("../../src/pipeline/analysis-workflow");
    const again = await reply(env, id, { status: "ready", verdict: "suspicious" });
    expect(again.mail).toBe("duplicate");
    expect(requests).toHaveLength(1);
  });

  it("still replies, with the stored Message-ID, when the summary or the forward cannot be read", async () => {
    const { reply } = await import("../../src/pipeline/analysis-workflow");
    const partial = { status: "partial" as const, failedStep: "parse" as const, errorClass: "StoreError" };
    const broken = [
      { ...env.ARTEFACTS, get: () => Promise.reject(new Error("R2 down")) },
      {
        ...env.ARTEFACTS,
        get: async () => ({
          arrayBuffer: () => Promise.reject(new Error("cut off")),
          text: () => Promise.reject(new Error("cut off")),
        }),
      },
    ];
    for (const bucket of broken) {
      const requests = stubSmtp2go(["sent"]);
      const id = await caseFrom(forwards["inline-forward"]);
      const result = await reply({ ...env, ARTEFACTS: bucket as unknown as R2Bucket }, id, partial);
      expect(result.mail).toBe("sent");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.subject).toBe("Re: your IsItLegit check");
      expect(header(requests[0] as Request_, "In-Reply-To")).toBe("<forward-77@fictional-recipient.example>");
      expect(requests[0]?.text_body).toContain("forward the message again");
      vi.restoreAllMocks();
    }
  });

  it("sends the fallback when an optional read stalls past its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { reply, OPTIONAL_READ_MS } = await import("../../src/pipeline/analysis-workflow");
      const requests = stubSmtp2go(["sent"]);
      const id = await caseFrom(forwards["inline-forward"]);
      const stalled = { ...env.ARTEFACTS, get: () => new Promise(() => {}) } as unknown as R2Bucket;
      const pending = reply({ ...env, ARTEFACTS: stalled }, id, {
        status: "partial",
        failedStep: "checks",
        errorClass: "Error",
      });
      await vi.advanceTimersByTimeAsync(OPTIONAL_READ_MS + 1);
      await vi.advanceTimersByTimeAsync(OPTIONAL_READ_MS + 1);
      expect((await pending).mail).toBe("sent");
      expect(requests[0]?.subject).toBe("Re: your IsItLegit check");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the whole send inside one reply attempt", async () => {
    const { OPTIONAL_READ_MS, REPLY_SEND_TIMEOUT_MS, REPLY_STEP_TIMEOUT_MS } = await import(
      "../../src/pipeline/analysis-workflow"
    );
    const { MAX_ATTEMPTS } = await import("../../src/mail/smtp2go");
    // Two optional reads, every provider call at its timeout, and the 1 and 2 second pauses between them.
    const worst = 2 * OPTIONAL_READ_MS + MAX_ATTEMPTS * REPLY_SEND_TIMEOUT_MS + 3_000;
    expect(worst).toBeLessThan(REPLY_STEP_TIMEOUT_MS);
  });

  it("ends a ready case partial naming reply when its verdict row is missing, sending nothing", async () => {
    const requests = stubSmtp2go(["sent"]);
    const id = await caseFrom(forwards["inline-forward"]);
    expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
    await run(id, async (m) => {
      await m.mockStepResult({ name: "admit" }, { admit: true, orgId: ORG });
      await m.mockStepResult({ name: "parse" }, `cases/${id}/parsed.json`);
      await m.mockStepResult({ name: "checks" }, { evidence: [] });
      await m.mockStepResult({ name: "verdict" }, STUB_VERDICT);
      await m.mockStepResult({ name: "store" }, "stored");
    });
    expect(await caseStatus(id)).toBe("partial");
    const failed = await env.DB.prepare("SELECT step FROM case_events WHERE case_id = ? AND status = 'failed'")
      .bind(id)
      .first<{ step: string }>();
    expect(failed?.step).toBe("reply");
    expect(requests).toHaveLength(0);
  });

  it("threads on the stored Message-ID when the forward's own is empty", async () => {
    const { reply } = await import("../../src/pipeline/analysis-workflow");
    const requests = stubSmtp2go(["sent"]);
    const raw = new TextEncoder().encode("From: a@x.example\r\nSubject: Fwd: x\r\nMessage-ID: \r\n\r\nbody\r\n");
    const id = await caseFrom(raw);
    await reply(env, id, { status: "partial", failedStep: "checks", errorClass: "Error" });
    expect(header(requests[0] as Request_, "In-Reply-To")).toBe("<forward-77@fictional-recipient.example>");
  });
});
