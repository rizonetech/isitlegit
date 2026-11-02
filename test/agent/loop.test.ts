import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type AgentContext, runAgent } from "../../src/agent/loop";
import { ruleVerdict } from "../../src/agent/rule-verdict";
import { createToolExecutor, ledgerLookup, type ToolDeps } from "../../src/agent/tools";
import { type EvidenceDraft, readEvidence, saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { getVerdict } from "../../src/db/verdicts";
import { readArtefact, type Store } from "../../src/intake/store";
import { bankChangeAction, callBackAction } from "../../src/invoice/fixed-actions";
import { importSuppliers, siteOf } from "../../src/invoice/ledger";
import { checkImport } from "../../src/invoice/ledger-csv";
import { d1Budget } from "../../src/meta/budget";
import { bankKeys } from "../../src/trust/bank";
import { makeOrg } from "../trust/helpers";

// D04 T01 §4: the verdict agent loop over a scripted Meta transport, the real tool executor with stubbed
// implementations, and real D1. No Meta credit is spent.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };
const PAGE = "https://phish.example/signin";

const answer = (output: unknown[]) =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status: "completed",
      output,
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );
let callIds = 0;
const call = (name: string, args: Record<string, unknown>) =>
  answer([{ type: "function_call", name, call_id: `call_${++callIds}`, arguments: JSON.stringify(args) }]);
const message = (text: string) =>
  answer([{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }]);
const final = (value: Record<string, unknown>) => message(JSON.stringify(value));

function model(script: (() => Response)[], failAt = -1) {
  const sent: string[] = [];
  let i = 0;
  const fetchStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(String(init?.body));
    if (i === failAt) throw new TypeError("network down");
    const next = script[i++];
    if (!next) throw new Error("the script has no more answers");
    return next();
  }) as typeof fetch;
  return { fetchStub, sent, calls: () => i };
}

const draft = (check: string, severity: EvidenceDraft["severity"], summary: string, detail = {}): EvidenceDraft => ({
  check,
  severity,
  summary,
  detail,
  artefacts: [],
});

async function newCase(items: EvidenceDraft[], orgId = "org-loop") {
  const made = await createCase(env.DB, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  if (items.length) await saveEvidence(env.DB, made.value.id, items);
  return made.value.id;
}

function toolDeps(): ToolDeps & { counts: Record<string, number> } {
  const counts = { expand: 0, screenshot: 0, lookupDomain: 0, ledger: 0, walk: 0 };
  return {
    counts,
    expand: async () => {
      counts.expand += 1;
      return [draft("agent.expand_link", "info", "The link ends at collect.example.")];
    },
    screenshot: async () => {
      counts.screenshot += 1;
      return [];
    },
    lookupDomain: async () => {
      counts.lookupDomain += 1;
      return [
        draft("agent.lookup_domain", "info", "The domain was registered 3 days ago.", {
          domain: "phish.example",
          registered: "2026-10-30",
        }),
      ];
    },
    ledger: async () => {
      counts.ledger += 1;
      return [];
    },
    walk: async () => {
      counts.walk += 1;
      return [];
    },
  };
}

function agent(
  caseId: string,
  fetchStub: typeof fetch,
  headersAvailable = true,
  summary = "Invoice attached. Pay today.",
) {
  const deps = toolDeps();
  const executor = createToolExecutor({ db: env.DB, caseId, urls: [PAGE] }, deps);
  const ctx: AgentContext = {
    db: env.DB,
    meta: { env: META, budget: d1Budget(env.DB, { caller: "verdict-agent", caseId }), fetch: fetchStub },
    summary,
    headersAvailable,
    executor,
  };
  return { deps, ctx };
}

const ANSWER = {
  verdict: "suspicious",
  confidence: 0.8,
  headline: "This looks like a phishing attempt",
  explanation: "The link leads to a sign-in page on a new domain [E1].",
  cited_evidence_ids: ["E1"],
  recommended_actions: ["Do not sign in."],
  meaning: "Treat this as suspicious and check through a channel you trust.",
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM model_spend").run();
});

describe("runAgent", () => {
  it("drives two tool calls to a stored agent verdict, every request carrying the case in an untrusted block", async () => {
    const caseId = await newCase([
      draft("link.credential_form", "high", "A form asks for sign-in details.", { page: PAGE }),
    ]);
    const m = model([
      () => call("expand_link", { url: PAGE }),
      () => call("lookup_domain", { domain: "phish.example" }),
      () => message("done"),
      () => final(ANSWER),
    ]);
    const { ctx, deps } = agent(caseId, m.fetchStub, true, "Pay now <script>alert(1)</script> at the link.");
    const view = await runAgent(ctx, caseId);
    expect(view.source).toBe("agent");
    expect(view.verdict).toBe("suspicious");
    expect(deps.counts.expand).toBe(1);
    expect(deps.counts.lookupDomain).toBe(1);
    for (const body of m.sent) {
      expect(body).toContain("<<UNTRUSTED:case:");
      expect(body).not.toContain("<html");
    }
    // The tool's detail reaches the model, not only its summary.
    expect(m.sent.join("\n")).toContain("2026-10-30");
    const hostile = m.sent.join("\n");
    expect(hostile.indexOf("<script>")).toBeGreaterThan(hostile.indexOf("<<UNTRUSTED:case:"));
    // One call entry per call_id in every request: no duplicated history.
    for (const body of m.sent) {
      const ids = [...body.matchAll(/"type":"function_call","name":"[a-z_]+","call_id":"(call_\d+)"/g)].map(
        (x) => x[1],
      );
      expect(new Set(ids).size).toBe(ids.length);
    }
    const stored = await getVerdict(env.DB, caseId);
    expect(stored?.ok && stored.value.verdict).toBe("suspicious");
    // Above the floor, the stored row carries no floor record (D04 T01 §11).
    expect(stored?.ok && stored.value.floorApplied).toBeNull();
    const events = await env.DB.prepare(
      "SELECT step, status FROM case_events WHERE case_id = ? AND step = 'agent' ORDER BY id",
    )
      .bind(caseId)
      .all<{ step: string; status: string }>();
    // Three turns, two tool calls and the finalisation, each recorded in order.
    expect(events.results.map((e) => e.status)).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect((await readEvidence(env.DB, caseId)).some((e) => e.check === "agent.expand_link")).toBe(true);
    void readArtefact;
    void store;
  });

  it("sends the calibration that missing evidence alone is not suspicion", async () => {
    const caseId = await newCase([draft("vision.not_checked", "info", "The page could not be read.")]);
    const m = model([() => message("done"), () => final(ANSWER)]);
    const { ctx } = agent(caseId, m.fetchStub);
    await runAgent(ctx, caseId);
    // Every request (investigation turns and the final verdict request share the prefix) carries the
    // substantive rule, not only its headline: a harmful ask defined by content, a routine ask protected.
    expect(m.sent.length).toBeGreaterThanOrEqual(2);
    for (const body of m.sent) {
      expect(body).toContain("Judge the ask itself");
      expect(body).toContain("to pay into new or changed bank details");
      expect(body).toContain("A routine ask the evidence does not tie to harm");
      expect(body).toContain("that is missing evidence, and on missing evidence alone the verdict is safe");
    }
  });

  it("floors a safe answer over critical evidence, with the rules headline and meaning", async () => {
    const caseId = await newCase([
      draft("walkthrough.credential_target", "critical", "Sign-in details would go to collect.example.", {
        domain: "collect.example",
      }),
    ]);
    const m = model([
      () => message("done"),
      () =>
        final({ ...ANSWER, verdict: "safe", headline: "This message is safe to act on", cited_evidence_ids: ["E1"] }),
    ]);
    const { ctx } = agent(caseId, m.fetchStub);
    const view = await runAgent(ctx, caseId);
    const rules = ruleVerdict(await readEvidence(env.DB, caseId), { headersAvailable: true });
    expect(view.verdict).toBe("malicious");
    expect(view.headline).toBe(rules.headline);
    expect(view.meaning).toBe(rules.meaning);
    expect(view.source).toBe("agent");
    // The model's own actions give way to the rules' under a floor, and the decisive evidence leads the reasons.
    expect(view.actions).toEqual(rules.actions);
    expect(view.reasons[0]?.evidenceIds).toEqual(["E1"]);
    // The floor outcome is persisted with the verdict (D04 T01 §11), so the eval can measure it per case.
    expect(view.floorApplied).toEqual({ from: "safe", to: "malicious", evidenceIds: ["E1"] });
    expect(await getVerdict(env.DB, caseId)).toMatchObject({
      ok: true,
      value: { floorApplied: { from: "safe", to: "malicious", evidenceIds: ["E1"] } },
    });
  });

  it("stores no floor record when the answer sits exactly at the floor (D04 T01 §11)", async () => {
    const caseId = await newCase([
      draft("walkthrough.credential_target", "critical", "Sign-in details would go to collect.example.", {
        domain: "collect.example",
      }),
    ]);
    const m = model([
      () => message("done"),
      () => final({ ...ANSWER, verdict: "malicious", cited_evidence_ids: ["E1"] }),
    ]);
    const view = await runAgent(agent(caseId, m.fetchStub).ctx, caseId);
    expect(view.verdict).toBe("malicious");
    expect(view.floorApplied).toBeNull();
    expect(await getVerdict(env.DB, caseId)).toMatchObject({ ok: true, value: { floorApplied: null } });
  });

  it("falls back to the rules on a model failure, and caps confidence without headers", async () => {
    const failing = model([], 0);
    const caseId = await newCase([
      draft("link.lure_button", "medium", "A lone button says View document.", { page: PAGE }),
    ]);
    const view = await runAgent(agent(caseId, failing.fetchStub).ctx, caseId);
    expect(view.source).toBe("rules");
    // A fallback verdict is never below its floor, so it stores no floor record (D04 T01 §11).
    expect(view.floorApplied).toBeNull();
    expect(await getVerdict(env.DB, caseId)).toMatchObject({ ok: true, value: { floorApplied: null } });
    const failedEvents = await env.DB.prepare(
      "SELECT error FROM case_events WHERE case_id = ? AND step = 'agent' AND status = 'failed'",
    )
      .bind(caseId)
      .all<{ error: string | null }>();
    expect(failedEvents.results).toHaveLength(1);
    expect(failedEvents.results[0]?.error).toMatch(/^[A-Za-z]+$/);
    // The investigation could not run, so its safe answer is stated partial, never an ordinary clean bill.
    expect(view.headline).toBe("No warning signs were found, but some checks could not run");
    expect(view.confidence).toBeLessThanOrEqual(0.5);
    const second = await newCase([
      draft("link.credential_form", "high", "A form asks for sign-in details.", { page: PAGE }),
    ]);
    const m = model([() => message("done"), () => final({ ...ANSWER, confidence: 0.95 })]);
    const noHeaders = await runAgent(agent(second, m.fetchStub, false).ctx, second);
    expect(noHeaders.confidence).toBe(0.6);
    expect(noHeaders.source).toBe("agent");
  });

  it("puts the voice call-back first, and a tool-discovered mismatch floors a safe answer", async () => {
    const voice = await newCase([
      draft("voice.request", "high", 'The voice note asks for a payment: "pay it today"', { request: "pay" }),
      draft("voice.claimed_identity", "info", 'The speaker says they are Naledi: "it is Naledi"', {
        identity: "Naledi",
      }),
    ]);
    const m = model([
      () => message("done"),
      () => final({ ...ANSWER, verdict: "safe", cited_evidence_ids: ["E1"], recommended_actions: ["Pay it."] }),
    ]);
    const view = await runAgent(agent(voice, m.fetchStub).ctx, voice);
    expect(view.actions[0]).toBe(callBackAction("Naledi"));

    const found = await newCase([draft("link.credential_form", "high", "A form asks for details.", { page: PAGE })]);
    const deps = toolDeps();
    deps.ledger = async () => [
      draft("agent.ledger_lookup", "critical", "The claimed account does not match.", {
        supplier: "Acme",
        known: true,
        match: false,
      }),
    ];
    const executor = createToolExecutor({ db: env.DB, caseId: found, urls: [PAGE] }, deps);
    const m2 = model([
      () => call("ledger_lookup", { supplier: "Acme", account_number: "1", branch_code: "2" }),
      () => message("done"),
      () => final({ ...ANSWER, verdict: "safe", cited_evidence_ids: ["E2"] }),
    ]);
    const view2 = await runAgent(
      {
        db: env.DB,
        meta: { env: META, budget: d1Budget(env.DB, { caller: "verdict-agent", caseId: found }), fetch: m2.fetchStub },
        summary: "Invoice.",
        headersAvailable: true,
        executor,
      },
      found,
    );
    expect(view2.verdict).toBe("malicious");
    expect(view2.actions[0]).toContain("phoning the supplier");
  });
});

describe("caseSummary and finalisation edges", () => {
  it("attaches the numbered bank-change action on the invoice trigger alone (D04 T01 §12)", async () => {
    const caseId = await newCase([
      draft("invoice.bank_changed", "critical", "The account on the invoice differs from the ledger.", {
        phone: "+27115550123",
      }),
    ]);
    const m = model([() => message("done"), () => final({ ...ANSWER, verdict: "safe", cited_evidence_ids: ["E1"] })]);
    const view = await runAgent(agent(caseId, m.fetchStub).ctx, caseId);
    expect(view.actions[0]).toBe(bankChangeAction("+27115550123"));
    const stored = await getVerdict(env.DB, caseId);
    expect(stored?.ok && stored.value.actions[0]).toBe(bankChangeAction("+27115550123"));
  });

  it("takes the bank-change number from the seeded ledger, never the message (D04 T01 §12)", async () => {
    const keys = await bankKeys(env);
    const text = [
      "name,domain,bank,branch_code,account_number,phone",
      "Acme Supplies,acme.example,Kestrel Bank,250655,62004417731,+27115550123",
      "NoPhone Traders,nophone.example,Kestrel Bank,250655,62004417733,",
    ].join("\r\n");
    const checked = checkImport(new TextEncoder().encode(text).length, text, siteOf);
    if (!checked.ok) throw new Error("seed refused");
    const org = await makeOrg();
    await importSuppliers(env.DB, keys, org, "owner", checked.rows);
    const run = async (supplier: string, summary: string) => {
      const caseId = await newCase([], org);
      const deps = { ...toolDeps(), ledger: ledgerLookup(env.DB, org, keys) };
      const executor = createToolExecutor({ db: env.DB, caseId, urls: [PAGE] }, deps);
      const m = model([
        () => call("ledger_lookup", { supplier, account_number: "62004417732", branch_code: "250655" }),
        () => message("done"),
        () => final({ ...ANSWER, verdict: "safe", cited_evidence_ids: ["E1"] }),
      ]);
      const ctx: AgentContext = {
        db: env.DB,
        meta: { env: META, budget: d1Budget(env.DB, { caller: "verdict-agent", caseId }), fetch: m.fetchStub },
        summary,
        headersAvailable: true,
        executor,
      };
      const view = await runAgent(ctx, caseId);
      const stored = await getVerdict(env.DB, caseId);
      expect(stored?.ok && stored.value.actions[0]).toBe(view.actions[0]);
      return view;
    };
    const numbered = await run("Acme Supplies", "Invoice attached. Call us on +27999999999 to confirm.");
    expect(numbered.actions[0]).toBe(bankChangeAction("+27115550123"));
    expect(numbered.actions.join(" ")).not.toContain("99999");
    const numberless = await run("NoPhone Traders", "Invoice attached.");
    expect(numberless.actions[0]).toBe(bankChangeAction());
  });

  it("uses a later numbered trigger when an earlier one carries no number (D04 T01 §12)", async () => {
    const caseId = await newCase([
      draft("agent.ledger_lookup", "critical", "The claimed account does not match.", {
        supplier: "NoPhone Traders",
        known: true,
        match: false,
        phone: null,
      }),
      draft("invoice.bank_changed", "critical", "The account on the invoice differs from the ledger.", {
        phone: "+27115550123",
      }),
    ]);
    const m = model([() => message("done"), () => final({ ...ANSWER, verdict: "safe", cited_evidence_ids: ["E1"] })]);
    const view = await runAgent(agent(caseId, m.fetchStub).ctx, caseId);
    expect(view.actions[0]).toBe(bankChangeAction("+27115550123"));
  });

  it("attaches the numbered action on the fallback path too (D04 T01 §12)", async () => {
    const caseId = await newCase([
      draft("invoice.bank_changed", "critical", "The account on the invoice differs from the ledger.", {
        phone: "+27115550123",
      }),
    ]);
    const failing = model([], 0);
    const view = await runAgent(agent(caseId, failing.fetchStub).ctx, caseId);
    expect(view.source).toBe("rules");
    expect(view.actions[0]).toBe(bankChangeAction("+27115550123"));
    const stored = await getVerdict(env.DB, caseId);
    expect(stored?.ok && stored.value.actions[0]).toBe(bankChangeAction("+27115550123"));
  });

  it("reads real stored headers and only visible HTML text", async () => {
    const { caseSummary } = await import("../../src/agent/loop");
    const summary = caseSummary({
      headers: [
        { name: "Subject", value: "Invoice 12" },
        { name: "From", value: "Acme <billing@acme.example>" },
      ],
      text: null,
      html: '<p>Pay <b>today</b></p><div style="display:none">Hidden instructions</div><SCRIPT>evil()</SCRIPT>',
    });
    expect(summary).toContain("Subject: Invoice 12");
    expect(summary).toContain("Pay today");
    expect(summary).not.toContain("Hidden instructions");
    expect(summary).not.toContain("evil");
  });

  it("retries an invalid citation once with the validator findings and accepts the corrected answer", async () => {
    // D04 T01 §5: first final cites E99, the retry carries the finding and the corrected answer passes
    // validation: the stored verdict is the agent's, after exactly two final attempts.
    const caseId = await newCase([draft("link.credential_form", "high", "A form asks for details.", { page: PAGE })]);
    const bad = { ...ANSWER, cited_evidence_ids: ["E99"], explanation: "A form asks for details [E99]." };
    const m = model([() => message("done"), () => final(bad), () => final(ANSWER)]);
    const view = await runAgent(agent(caseId, m.fetchStub).ctx, caseId);
    expect(view.source).toBe("agent");
    expect(m.calls()).toBe(3);
    expect(m.sent[2]).toContain("cited E99 is not on the case");
    // The stored read-back: the agent's verdict, its confidence, and reasons citing only declared IDs.
    const stored = await getVerdict(env.DB, caseId);
    expect(stored?.ok).toBe(true);
    if (stored?.ok) {
      expect(stored.value.source).toBe("agent");
      expect(stored.value.verdict).toBe(ANSWER.verdict);
      expect(stored.value.confidence).toBeGreaterThan(0);
      expect(stored.value.reasons.length).toBeGreaterThan(0);
      expect(stored.value.reasons.every((r) => r.evidenceIds.every((id) => id === "E1"))).toBe(true);
    }
  });

  it("shares the two-answer finalisation budget between schema repair and citation retry", async () => {
    // D04 T01 §5 (round 1 P2): a malformed first answer repaired into a citation-invalid one has spent
    // both finalisation attempts, so no citation retry is sent and the rule verdict is stored.
    const caseId = await newCase([draft("link.credential_form", "high", "A form asks for details.", { page: PAGE })]);
    const bad = { ...ANSWER, cited_evidence_ids: ["E99"], explanation: "A form asks for details [E99]." };
    const m = model([() => message("done"), () => message("{oops"), () => final(bad), () => final(ANSWER)]);
    expect((await runAgent(agent(caseId, m.fetchStub).ctx, caseId)).source).toBe("rules");
    expect(m.sent.length).toBe(3);
  });

  it("never accepts a third final answer when the citation retry is malformed", async () => {
    // D04 T01 §5 (completion review P2): the citation retry gets one attempt; a malformed retry answer
    // falls back instead of letting structured() repair it into a third accepted final answer.
    const caseId = await newCase([draft("link.credential_form", "high", "A form asks for details.", { page: PAGE })]);
    const bad = { ...ANSWER, cited_evidence_ids: ["E99"], explanation: "A form asks for details [E99]." };
    const m = model([() => message("done"), () => final(bad), () => message("{oops"), () => final(ANSWER)]);
    expect((await runAgent(agent(caseId, m.fetchStub).ctx, caseId)).source).toBe("rules");
    expect(m.sent.length).toBe(3);
  });

  it("falls back when the citation retry request fails, is refused, or the deadline has passed", async () => {
    // D04 T01 §5: the retry shares the run's deadline, and any of its failures stores the rule verdict
    // with no third final answer.
    const bad = { ...ANSWER, cited_evidence_ids: ["E99"], explanation: "A form asks for details [E99]." };
    // The retry request itself fails on the network.
    const failedCase = await newCase([
      draft("link.credential_form", "high", "A form asks for details.", { page: PAGE }),
    ]);
    const failed = model([() => message("done"), () => final(bad)], 2);
    expect((await runAgent(agent(failedCase, failed.fetchStub).ctx, failedCase)).source).toBe("rules");
    expect(failed.sent.length).toBe(3);
    // The model refuses the retry.
    const refusedCase = await newCase([
      draft("link.credential_form", "high", "A form asks for details.", { page: PAGE }),
    ]);
    const refusal = () =>
      answer([{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I cannot answer." }] }]);
    const refused = model([() => message("done"), () => final(bad), refusal]);
    expect((await runAgent(agent(refusedCase, refused.fetchStub).ctx, refusedCase)).source).toBe("rules");
    expect(refused.sent.length).toBe(3);
    // The shared deadline expires after the first answer: the retry is never sent.
    const lateCase = await newCase([draft("link.credential_form", "high", "A form asks for details.", { page: PAGE })]);
    let clock = 1_000_000;
    const base = model([() => message("done"), () => final(bad), () => final(ANSWER)]);
    const advancing = (async (...args: Parameters<typeof fetch>) => {
      const response = await base.fetchStub(...args);
      if (base.sent.length === 2) clock += 61_000;
      return response;
    }) as typeof fetch;
    const { ctx } = agent(lateCase, advancing);
    ctx.now = () => clock;
    ctx.deadlineMs = 60_000;
    expect((await runAgent(ctx, lateCase)).source).toBe("rules");
    expect(base.sent.length).toBe(2);
  });

  it("repairs a malformed final answer, falls back on an invalid citation, and states a failed tool beside a safe answer", async () => {
    // Malformed once, then repaired by structured()'s own retry.
    const repaired = await newCase([draft("link.credential_form", "high", "A form asks for details.", { page: PAGE })]);
    const m1 = model([() => message("done"), () => message("{oops"), () => final(ANSWER)]);
    expect((await runAgent(agent(repaired, m1.fetchStub).ctx, repaired)).source).toBe("agent");
    // A citation the case does not have, answered invalidly twice, is a rules fallback, never a trimmed
    // claim: the validator retries once with its findings, never a third answer.
    const stray = await newCase([draft("link.credential_form", "high", "A form asks for details.", { page: PAGE })]);
    const bad = { ...ANSWER, cited_evidence_ids: ["E99"], explanation: "A form asks for details [E99]." };
    const m2 = model([() => message("done"), () => final(bad), () => final(bad)]);
    expect((await runAgent(agent(stray, m2.fetchStub).ctx, stray)).source).toBe("rules");
    expect(m2.calls()).toBe(3);
    expect(m2.sent.join("\n")).toContain("cited E99 is not on the case");
    // A failed tool beside a safe answer: partial, capped.
    const failedTool = await newCase([
      draft("link.lure_button", "medium", "A lone button says View document.", { page: PAGE }),
    ]);
    const deps = toolDeps();
    deps.lookupDomain = async () => {
      throw new TypeError("network down");
    };
    const executor = createToolExecutor({ db: env.DB, caseId: failedTool, urls: [PAGE] }, deps);
    const m3 = model([
      () => call("lookup_domain", { domain: "phish.example" }),
      () => message("done"),
      () => final({ ...ANSWER, verdict: "safe", cited_evidence_ids: ["E1"] }),
    ]);
    const view = await runAgent(
      {
        db: env.DB,
        meta: {
          env: META,
          budget: d1Budget(env.DB, { caller: "verdict-agent", caseId: failedTool }),
          fetch: m3.fetchStub,
        },
        summary: "Invoice.",
        headersAvailable: true,
        executor,
      },
      failedTool,
    );
    expect(view.verdict).toBe("safe");
    expect(view.headline).toContain("could not run");
    expect(view.confidence).toBeLessThanOrEqual(0.6);
  });
});

describe("exhausted tools", () => {
  it("states a cap-refused investigation partial beside a safe answer", async () => {
    const caseId = await newCase([
      draft("link.lure_button", "medium", "A lone button says View document.", { page: PAGE }),
    ]);
    const deps = toolDeps();
    const executor = createToolExecutor({ db: env.DB, caseId, urls: [PAGE] }, deps, { maxCalls: 0 });
    const m = model([
      () => call("expand_link", { url: PAGE }),
      () => message("done"),
      () => final({ ...ANSWER, verdict: "safe", cited_evidence_ids: ["E1"] }),
    ]);
    const view = await runAgent(
      {
        db: env.DB,
        meta: { env: META, budget: d1Budget(env.DB, { caller: "verdict-agent", caseId }), fetch: m.fetchStub },
        summary: "Invoice.",
        headersAvailable: true,
        executor,
      },
      caseId,
    );
    expect(view.verdict).toBe("safe");
    expect(view.headline).toBe("No warning signs were found, but some checks could not run");
    expect(view.confidence).toBeLessThanOrEqual(0.5);
    expect(deps.counts.expand).toBe(0);
  });
});
