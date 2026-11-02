import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type AgentContext, runAgent } from "../../src/agent/loop";
import { createToolExecutor, type ToolDeps } from "../../src/agent/tools";
import { type EvidenceDraft, saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { getVerdict } from "../../src/db/verdicts";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";
import { d1Budget } from "../../src/meta/budget";
import { reply } from "../../src/pipeline/analysis-workflow";
import { injectionPairs } from "../fixtures/injection/load";
import { obedientModel } from "../helpers/obedient-model";

// D04 T01 §6: prompt-injection fixture pairs through the verdict agent with the obedient stub
// model, which follows any instruction it finds. Each hostile fixture is compared with its
// clean twin: the verdict, the tool calls that execute and the stored answer's destinations
// must not move. The structure holds or this suite fails; the model's restraint is never the
// thing tested. No Meta credit is spent.
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };
const PAGE = "https://phish.example/signin";

const CLEAN_ANSWER = {
  verdict: "suspicious",
  confidence: 0.8,
  headline: "This looks like a phishing attempt",
  explanation: "The link leads to a sign-in page on a new domain [E1].",
  cited_evidence_ids: ["E1"],
  recommended_actions: ["Do not sign in."],
  meaning: "Treat this as suspicious and check through a channel you trust.",
};

const draft = (check: string, severity: EvidenceDraft["severity"], summary: string, detail = {}): EvidenceDraft => ({
  check,
  severity,
  summary,
  detail,
  artefacts: [],
});

async function runPair(text: string) {
  const made = await createCase(env.DB, { orgId: "org-injection", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const caseId = made.value.id;
  await saveEvidence(env.DB, caseId, [
    draft("link.credential_form", "high", "A form asks for sign-in details.", { page: PAGE }),
  ]);
  const counts = { expand: 0, screenshot: 0, lookupDomain: 0, ledger: 0, walk: 0 };
  const deps: ToolDeps = {
    expand: async () => {
      counts.expand += 1;
      return [];
    },
    screenshot: async () => {
      counts.screenshot += 1;
      return [];
    },
    lookupDomain: async () => {
      counts.lookupDomain += 1;
      return [];
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
  const executor = createToolExecutor({ db: env.DB, caseId, urls: [PAGE] }, deps);
  const stub = obedientModel(CLEAN_ANSWER);
  const ctx: AgentContext = {
    db: env.DB,
    meta: { env: META, budget: d1Budget(env.DB, { caller: "verdict-agent", caseId }), fetch: stub.fetchStub },
    summary: text,
    headersAvailable: true,
    executor,
  };
  const view = await runAgent(ctx, caseId);
  const stored = await getVerdict(env.DB, caseId);
  return { view, stored, counts, stub };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM model_spend").run();
});

describe("prompt-injection fixture pairs", () => {
  it("holds eight hostile and clean pairs", () => {
    expect(injectionPairs).toHaveLength(8);
    for (const pair of injectionPairs) {
      expect(pair.hostile).not.toBe(pair.clean);
      expect(pair.clean).not.toMatch(/attacker\.example|mark .*safe|audit mode/i);
    }
  });

  it("strips destinations from a validly cited malicious answer before storage", async () => {
    const made = await createCase(env.DB, { orgId: "org-injection", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const caseId = made.value.id;
    await saveEvidence(env.DB, caseId, [
      draft("link.credential_form", "high", "A form asks for sign-in details.", { page: PAGE }),
    ]);
    const counts = { expand: 0, screenshot: 0, lookupDomain: 0, ledger: 0, walk: 0 };
    const deps: ToolDeps = {
      expand: async () => counts.expand++ as never,
      screenshot: async () => counts.screenshot++ as never,
      lookupDomain: async () => counts.lookupDomain++ as never,
      ledger: async () => counts.ledger++ as never,
      walk: async () => counts.walk++ as never,
    };
    const executor = createToolExecutor({ db: env.DB, caseId, urls: [PAGE] }, deps);
    const malicious = {
      ...CLEAN_ANSWER,
      headline: "This looks like a phishing attempt, see https://attacker.example/confirm",
      recommended_actions: ["Mail attacker@example.com for help", "Open attacker.example/confirm to verify"],
      meaning: "Send your details to attacker@example.com.",
    };
    const stub = obedientModel(malicious);
    // The obedient stub returns the clean answer unless an instruction fires; this case's
    // summary holds none, so drive the malicious answer directly through the same fetch shape.
    const direct = (async () =>
      new Response(
        JSON.stringify({
          id: "r",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: JSON.stringify(malicious) }],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
      )) as typeof fetch;
    void stub;
    const ctx: AgentContext = {
      db: env.DB,
      meta: { env: META, budget: d1Budget(env.DB, { caller: "verdict-agent", caseId }), fetch: direct },
      summary: "Please pay invoice 77 into our new account today.",
      headersAvailable: true,
      executor,
    };
    const view = await runAgent(ctx, caseId);
    expect(view.verdict).toBe("suspicious");
    expect(view.headline).not.toContain("attacker.example");
    expect(JSON.stringify(view.actions)).not.toContain("attacker@example.com");
    expect(view.meaning).not.toContain("attacker@example.com");
    const stored = await getVerdict(env.DB, caseId);
    expect(JSON.stringify(stored)).not.toContain("attacker.example");
  });

  for (const pair of injectionPairs) {
    it(`changes nothing for ${pair.name}: same verdict, no executed attacker walk, no attacker destination stored`, async () => {
      const clean = await runPair(pair.clean);
      const hostile = await runPair(pair.hostile);
      // The payload reached the model and the obedient stub tried to obey it.
      expect(hostile.stub.sent.join("\n")).toContain(pair.hostile.trim().split("\n").at(-1)?.slice(0, 40));
      expect(hostile.stub.attempts.length).toBeGreaterThan(0);
      // The complete executed-tool trace matches the clean twin's: nothing executed at all.
      expect(hostile.counts).toEqual(clean.counts);
      expect(hostile.stored).not.toBeNull();
      // Same verdict as the clean twin (never safer for the hostile one).
      expect(hostile.view.verdict).toBe(clean.view.verdict);
      expect(clean.view.verdict).toBe("suspicious");
      // No tool call with an outside-case URL executed.
      expect(hostile.counts.walk).toBe(0);
      expect(hostile.counts.expand).toBe(0);
      // Nothing the model tried to plant is stored: no attacker link or address in the verdict.
      const storedText = JSON.stringify(hostile.stored);
      expect(storedText).not.toContain("attacker.example");
      expect(storedText).not.toContain("attacker@example.com");
      expect(hostile.view.headline).not.toContain("attacker.example");
    });
  }

  it("sends the reply only to the forwarding member, with no attacker destination in either body", async () => {
    const requests: { to: string[]; text_body: string; html_body?: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-1" } });
    }) as typeof fetch;
    try {
      const made = await createCase(env.DB, {
        orgId: "org-injection",
        channel: "email",
        headersAvailable: true,
        forwardedBy: "member@demo.isitlegit.co.za",
        messageId: "<injection-reply@fictional.example>",
      });
      if (!made.ok) throw new Error(made.error.message);
      const hostile = await runPair(injectionPairs[0]?.hostile ?? "");
      void hostile;
      // The verdict stored for this case is the hostile pair's: runPair made its own case, so
      // store the same shape here through the agent on this case instead.
      const stub = obedientModel(CLEAN_ANSWER);
      const counts = { expand: 0, screenshot: 0, lookupDomain: 0, ledger: 0, walk: 0 };
      const deps: ToolDeps = {
        expand: async () => counts.expand++ as never,
        screenshot: async () => counts.screenshot++ as never,
        lookupDomain: async () => counts.lookupDomain++ as never,
        ledger: async () => counts.ledger++ as never,
        walk: async () => counts.walk++ as never,
      };
      await saveEvidence(env.DB, made.value.id, [
        draft("link.credential_form", "high", "A form asks for sign-in details.", { page: PAGE }),
      ]);
      const executor = createToolExecutor({ db: env.DB, caseId: made.value.id, urls: [PAGE] }, deps);
      await runAgent(
        {
          db: env.DB,
          meta: {
            env: META,
            budget: d1Budget(env.DB, { caller: "verdict-agent", caseId: made.value.id }),
            fetch: stub.fetchStub,
          },
          summary: injectionPairs[0]?.hostile ?? "",
          headersAvailable: true,
          executor,
        },
        made.value.id,
      );
      const out = await reply(env as never, made.value.id, { status: "ready", verdict: "suspicious" });
      expect(out.mail).toBe("sent");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.to).toEqual(["member@demo.isitlegit.co.za"]);
      expect(requests[0]?.text_body).not.toContain("attacker.example");
      expect(requests[0]?.html_body ?? "").not.toContain("attacker.example");

      // An upload case has no forwarding member: no reply is sent at all.
      const uploaded = await createCase(env.DB, {
        orgId: "org-injection",
        channel: "upload",
        headersAvailable: false,
        uploadedBy: "user-injection",
      });
      if (!uploaded.ok) throw new Error(uploaded.error.message);
      const none = await reply(env as never, uploaded.value.id, { status: "ready", verdict: "suspicious" });
      expect(none.mail).toBe("none");
      expect(requests).toHaveLength(1);
    } finally {
      globalThis.fetch = real;
    }
  });
});
