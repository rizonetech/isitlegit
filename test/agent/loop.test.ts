import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent/loop";
import { ruleVerdict } from "../../src/agent/rule-verdict";
import { createToolExecutor, type ToolDeps } from "../../src/agent/tools";
import { type EvidenceDraft, readEvidence, saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { getVerdict } from "../../src/db/verdicts";
import { readArtefact, type Store } from "../../src/intake/store";
import { callBackAction } from "../../src/invoice/fixed-actions";
import { d1Budget } from "../../src/meta/budget";

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

async function newCase(items: EvidenceDraft[]) {
  const made = await createCase(env.DB, { orgId: "org-loop", channel: "email", headersAvailable: true });
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
      return [draft("agent.lookup_domain", "info", "The domain was registered 3 days ago.")];
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
  return {
    deps,
    ctx: {
      db: env.DB,
      meta: { env: META, budget: d1Budget(env.DB, { caller: "verdict-agent", caseId }), fetch: fetchStub },
      summary,
      headersAvailable,
      executor,
    },
  };
}

const ANSWER = {
  verdict: "suspicious",
  confidence: 0.8,
  headline: "This looks like a phishing attempt",
  explanation: "The link leads to a sign-in page on a new domain.",
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
    const events = await env.DB.prepare(
      "SELECT step, status FROM case_events WHERE case_id = ? AND step = 'agent' ORDER BY id",
    )
      .bind(caseId)
      .all<{ step: string; status: string }>();
    expect(events.results.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(events.results)).not.toContain("canary");
    expect((await readEvidence(env.DB, caseId)).some((e) => e.check === "agent.expand_link")).toBe(true);
    void readArtefact;
    void store;
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
  });

  it("falls back to the rules on a model failure, and caps confidence without headers", async () => {
    const failing = model([], 0);
    const caseId = await newCase([
      draft("link.lure_button", "medium", "A lone button says View document.", { page: PAGE }),
    ]);
    const view = await runAgent(agent(caseId, failing.fetchStub).ctx, caseId);
    expect(view.source).toBe("rules");
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
