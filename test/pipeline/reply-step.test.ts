import { env, introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveEvidence } from "../../src/checks/evidence";
import { createCase, setStatus } from "../../src/db/cases";

import { storeVerdict } from "../../src/db/verdicts";
import { putParsed, putRaw, type Store } from "../../src/intake/store";
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
    uploadedBy: forwardedBy ? null : "user-reply",
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
    // The vision step states the pictures unread, so the verdict says some checks could not run (D03 T02 §3).
    expect(sent.text_body).toContain("No warning signs were found, but some checks could not run");
    // An inline forward carries none of the original's headers, and the reply says how to forward it instead.
    expect(sent.text_body).toContain("Forward as attachment");
    expect(sent.text_body).not.toContain("we checked only the first");
    const link = /https:\/\/isitlegit\.test\/r\/\S+/.exec(sent.text_body)?.[0] ?? "";
    expect(await verifyReportLink(env.REPORT_LINK_SECRET, link)).toMatchObject({ ok: true });
    expect(sent.html_body).toContain(link.replace(/&/g, "&amp;"));
    expect((await row(id)).results).toEqual([{ status: "sent" }]);
    expect(await caseStatus(id)).toBe("done");
  });

  it("answers a forward of several messages with one grouped reply (D01 T01 §12)", async () => {
    const requests = stubSmtp2go(["sent"]);
    const id = await caseFrom(forwards["two-originals"]);
    await run(id);
    // The grouped reply goes when the child case finishes, in its own instance.
    const { childrenOf } = await import("../../src/intake/children");
    const childId = (await childrenOf(env.DB, id))[0]?.childCaseId as string;
    const child = await introspectWorkflowInstance(env.ANALYSIS, childId);
    try {
      await child.waitForStatus("complete");
    } finally {
      await child.dispose();
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.text_body).toContain("1. Updated banking details");
    expect(requests[0]?.text_body).toContain("2. Updated banking details");
    expect(requests[0]?.text_body).not.toContain("we checked only the first");
  });

  it("sends the verdict that is stored, not a stand-in", async () => {
    const requests = stubSmtp2go(["sent"]);
    const id = await caseFrom(forwards["inline-forward"]);
    expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
    await saveEvidence(env.DB, id, [
      { check: "not_checked", severity: "info", summary: "Quokka source", detail: {}, artefacts: [] },
    ]);
    const stored = {
      ...STUB_VERDICT,
      headline: "Zebra-7 headline",
      reasons: [{ text: "Quokka reason", evidenceIds: ["E1"] }],
      actions: ["Narwhal action"],
    };
    expect((await storeVerdict(env.DB, ORG, id, stored)).ok).toBe(true);
    await run(id, async (m) => {
      await m.mockStepResult({ name: "admit" }, { admit: true, orgId: ORG });
      await m.mockStepResult({ name: "parse" }, `cases/${id}/parsed.json`);
      await m.mockStepResult({ name: "checks" }, { evidence: 0 });
      await m.mockStepResult({ name: "verdict" }, { view: stored, evidence: [] });
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
    // The agent records its own failed event when the model is unreachable, then falls back; the reply's is named.
    const failed = await env.DB.prepare(
      "SELECT step FROM case_events WHERE case_id = ? AND status = 'failed' AND step = 'reply'",
    )
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
      await putParsed(store, id, { forward: { headersAvailable: false } });
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
      await putParsed(store, id, { forward: { headersAvailable: false } });
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
      await m.mockStepResult({ name: "checks" }, { evidence: 0 });
      await m.mockStepResult({ name: "verdict" }, { view: STUB_VERDICT, evidence: [] });
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

// D07 T03 §7: the designed reply's three reads happen inside reply(), which the operator's resend calls too.
describe("the reply's design inputs", () => {
  it("names the organisation, counts this run's findings and says the checks that did not finish", async () => {
    const { reply } = await import("../../src/pipeline/analysis-workflow");
    const requests = stubSmtp2go(["sent"]);
    const orgId = `org-design-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Karoo Couriers', ?, ?)`)
      .bind(orgId, orgId, new Date().toISOString())
      .run();
    const made = await createCase(env.DB, {
      orgId,
      channel: "email",
      headersAvailable: false,
      forwardedBy: FORWARDER,
      uploadedBy: null,
      messageId: "<forward-design@fictional-recipient.example>",
    });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    expect((await setStatus(env.DB, orgId, id, "running")).ok).toBe(true);
    await saveEvidence(
      env.DB,
      id,
      [
        { check: "not_checked", severity: "info", summary: "one", detail: {}, artefacts: [] },
        { check: "not_checked", severity: "info", summary: "two", detail: {}, artefacts: [] },
      ],
      undefined,
      undefined,
      [
        { check: "auth.spf", outcome: "ran", reason: null, findings: 1 },
        { check: "domain.age", outcome: "failed", reason: "Error", findings: 0 },
      ],
    );
    expect(
      (
        await storeVerdict(env.DB, orgId, id, {
          ...STUB_VERDICT,
          reasons: [{ text: "A plain reason.", evidenceIds: ["E1"] }],
        })
      ).ok,
    ).toBe(true);
    await reply(env, id, { status: "ready", verdict: STUB_VERDICT.verdict });
    const html = requests[0]?.html_body ?? "";
    expect(html).toContain("from Karoo Couriers. The report link is signed for Karoo Couriers");
    expect(html).toContain("1 more finding is in the full report.");
    expect(html).toContain("1 check did not finish or read only part of the message");
    expect(requests[0]?.text_body).toContain("1 check did not finish or read only part of the message");
    expect(requests[0]?.text_body).toContain("The report link is signed for Karoo Couriers and expires after 7 days.");
    // The same signed link in both parts.
    const link = /The full report: (\S+)/.exec(requests[0]?.text_body ?? "")?.[1] ?? "";
    expect(link).toMatch(/^https:\/\/.+\/r\//);
    expect(html).toContain(`href="${link.replaceAll("&", "&amp;")}"`);
    // The resend's own call: the same reads, the same words.
    await reply(env, id, { status: "ready", verdict: STUB_VERDICT.verdict }, `resend:${id}`);
    // Each send signs its own link, whose expiry can tick over a second between them; the rest is the same.
    const unsigned = (body: string) => body.replace(/e=\d+&amp;s=[\w-]+/g, "e=&amp;s=");
    expect(unsigned(requests[1]?.html_body ?? "")).toBe(unsigned(html));
  });

  // Each read failing fails the attempt (the step retries it), never a reply sent without what it should say.
  for (const [name, table] of [
    ["the organisation", /FROM "organization"/],
    ["the evidence", /FROM evidence WHERE/],
    ["the check outcomes", /FROM check_outcomes/],
  ] as const)
    it(`sends nothing when ${name} cannot be read`, async () => {
      const { reply } = await import("../../src/pipeline/analysis-workflow");
      const requests = stubSmtp2go(["sent"]);
      const id = await caseFrom(null);
      expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
      expect((await storeVerdict(env.DB, ORG, id, STUB_VERDICT)).ok).toBe(true);
      const db = new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              if (!table.test(sql)) return target.prepare(sql);
              // A statement whose query fails as D1 fails: the promise rejects.
              const down = () => Promise.reject(new Error("D1_ERROR: storage down"));
              const statement = { bind: () => statement, first: down, all: down, run: down, raw: down };
              return statement;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await expect(reply({ ...env, DB: db }, id, { status: "ready", verdict: STUB_VERDICT.verdict })).rejects.toThrow(
        "storage down",
      );
      expect(requests).toHaveLength(0);
    });
});

// D01 T02 §11: the stored authentication results reach the reply SMTP2GO is sent, in both bodies.
describe("the reply's authentication results", () => {
  const authItem = (method: "spf" | "dkim" | "dmarc", state: string, ...results: string[]) => ({
    check: `auth.${method}`,
    severity: "info" as const,
    summary: `${method} ${state}`,
    detail: { state, results: results.map((result) => ({ result })) },
    artefacts: [],
  });
  async function caseWith(items: Parameters<typeof saveEvidence>[2]) {
    const made = await createCase(env.DB, {
      orgId: ORG,
      channel: "email",
      headersAvailable: true,
      forwardedBy: FORWARDER,
      uploadedBy: null,
      messageId: `<forward-auth-${crypto.randomUUID()}@fictional-recipient.example>`,
    });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    expect((await setStatus(env.DB, ORG, id, "running")).ok).toBe(true);
    await saveEvidence(env.DB, id, items);
    return id;
  }
  const authDomItem = (
    method: "spf" | "dkim" | "dmarc",
    state: string,
    pairs: [string, string | null][],
    from?: string,
  ) => ({
    check: `auth.${method}`,
    severity: "info" as const,
    summary: `${method} ${state}`,
    detail: {
      state,
      ...(from !== undefined ? { from } : {}),
      results: pairs.map(([result, identifier]) => ({ result, identifier })),
    },
    artefacts: [],
  });
  const distinct = [
    authItem("spf", "failed", "softfail"),
    authItem("dkim", "inconclusive", "permerror"),
    authItem("dmarc", "unavailable", "none"),
  ];
  const WORDS = "SPF soft-failed, DKIM is broken, DMARC found no policy to apply.";

  it("names each stored value in the text and the HTML of a ready reply", async () => {
    const { reply } = await import("../../src/pipeline/analysis-workflow");
    const requests = stubSmtp2go(["sent"]);
    const id = await caseWith(distinct);
    expect((await storeVerdict(env.DB, ORG, id, STUB_VERDICT)).ok).toBe(true);
    await reply(env, id, { status: "ready", verdict: STUB_VERDICT.verdict });
    expect(requests).toHaveLength(1);
    for (const body of [requests[0]?.text_body ?? "", requests[0]?.html_body ?? ""]) {
      expect(body).toContain("Headers checked.");
      expect(body).toContain(WORDS);
    }
  });

  it("carries the same results in a partial reply whose run stored them before a later step failed", async () => {
    const { reply } = await import("../../src/pipeline/analysis-workflow");
    const requests = stubSmtp2go(["sent"]);
    const id = await caseWith(distinct);
    await reply(env, id, { status: "partial", failedStep: "verdict", errorClass: "Error" });
    expect(requests[0]?.text_body).toContain("We could not finish checking this message");
    for (const body of [requests[0]?.text_body ?? "", requests[0]?.html_body ?? ""]) expect(body).toContain(WORDS);
  });

  it("names each reported method and each unreported one, and no panel when none was reported (D01 T02 §16)", async () => {
    const { reply } = await import("../../src/pipeline/analysis-workflow");
    const requests = stubSmtp2go(["sent"]);
    const spfAlone = await caseWith([authItem("spf", "failed", "fail")]);
    const spfAndDmarc = await caseWith([authItem("spf", "passed", "pass"), authItem("dmarc", "failed", "fail")]);
    // A reported DKIM `none` (an unsigned message) is passed as `none`, worded as §35's "found no signature".
    const unsigned = await caseWith([
      authItem("spf", "passed", "pass"),
      authItem("dkim", "unavailable", "none"),
      authItem("dmarc", "passed", "pass"),
    ]);
    const noneReported = await caseWith([]);
    for (const id of [spfAlone, spfAndDmarc, unsigned, noneReported]) {
      expect((await storeVerdict(env.DB, ORG, id, STUB_VERDICT)).ok).toBe(true);
      await reply(env, id, { status: "ready", verdict: STUB_VERDICT.verdict });
    }
    expect(requests).toHaveLength(4);
    const words = [
      "SPF failed, DKIM not reported by the receiving system, DMARC not reported by the receiving system.",
      "SPF passed, DKIM not reported by the receiving system, DMARC failed.",
      "SPF passed, DKIM found no signature, DMARC passed.",
    ];
    for (const [i, want] of words.entries()) {
      for (const body of [requests[i]?.text_body ?? "", requests[i]?.html_body ?? ""]) {
        expect(body).toContain("Headers checked.");
        expect(body).toContain(want);
      }
    }
    expect(requests[3]?.text_body).not.toContain("Headers checked");
    expect(requests[3]?.html_body ?? "").not.toContain("Headers checked");
  });

  it("names the From domain and each pass's own domain in both bodies (D01 T02 §17)", async () => {
    const { reply } = await import("../../src/pipeline/analysis-workflow");
    const requests = stubSmtp2go(["sent"]);
    const id = await caseWith([
      authDomItem("spf", "passed", [["pass", "mailer.example"]]),
      authDomItem("dkim", "passed", [["pass", "signer.example"]]),
      authDomItem("dmarc", "failed", [["fail", null]], "bank.example"),
    ]);
    expect((await storeVerdict(env.DB, ORG, id, STUB_VERDICT)).ok).toBe(true);
    await reply(env, id, { status: "ready", verdict: STUB_VERDICT.verdict });
    for (const body of [requests[0]?.text_body ?? "", requests[0]?.html_body ?? ""]) {
      expect(body).toContain("SPF passed for mailer.example and DKIM passed for signer.example");
      expect(body).toContain("the domain the message says it is from (bank.example)");
    }
  });

  it("shows no cleaned substitute for a malformed stored domain in either body (D01 T02 §17)", async () => {
    const { reply } = await import("../../src/pipeline/analysis-workflow");
    const requests = stubSmtp2go(["sent"]);
    const id = await caseWith([
      authDomItem("spf", "passed", [["pass", "bank.example\r\n"]]),
      authDomItem("dkim", "passed", [["pass", "signer.example"]]),
      authDomItem("dmarc", "failed", [["fail", null]], "bank.example\r\n"),
    ]);
    expect((await storeVerdict(env.DB, ORG, id, STUB_VERDICT)).ok).toBe(true);
    await reply(env, id, { status: "ready", verdict: STUB_VERDICT.verdict });
    for (const body of [requests[0]?.text_body ?? "", requests[0]?.html_body ?? ""]) {
      expect(body).not.toContain("SPF passed for bank.example");
      expect(body).not.toContain("from (bank.example)");
      expect(body).toContain("DKIM passed for signer.example");
    }
  });

  it("keeps a hostile stored identifier out of both bodies (D01 T02 §17)", async () => {
    const { reply } = await import("../../src/pipeline/analysis-workflow");
    const requests = stubSmtp2go(["sent"]);
    const hostile = "mailer.example\nBcc: victim@fictional-outsider.example";
    const id = await caseWith([
      authDomItem("spf", "passed", [["pass", hostile]]),
      authDomItem("dkim", "passed", [["pass", "signer.example"]]),
      authDomItem("dmarc", "failed", [["fail", null]], "bank.example"),
    ]);
    expect((await storeVerdict(env.DB, ORG, id, STUB_VERDICT)).ok).toBe(true);
    await reply(env, id, { status: "ready", verdict: STUB_VERDICT.verdict });
    for (const body of [requests[0]?.text_body ?? "", requests[0]?.html_body ?? ""]) {
      expect(body).not.toContain("Bcc:");
      expect(body).not.toContain("victim@fictional-outsider.example");
      expect(body).toContain("DKIM passed for signer.example");
    }
  });
});
