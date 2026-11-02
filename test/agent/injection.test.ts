import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type AgentContext, runAgent } from "../../src/agent/loop";
import { createToolExecutor, type ToolDeps } from "../../src/agent/tools";
import { type EvidenceDraft, saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { getVerdict } from "../../src/db/verdicts";
import { d1Budget } from "../../src/meta/budget";
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

  for (const pair of injectionPairs) {
    it(`changes nothing for ${pair.name}: same verdict, no executed attacker walk, no attacker destination stored`, async () => {
      const clean = await runPair(pair.clean);
      const hostile = await runPair(pair.hostile);
      // The payload reached the model and the obedient stub tried to obey it.
      expect(hostile.stub.sent.join("\n")).toContain(pair.hostile.trim().split("\n").at(-1)?.slice(0, 40));
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
});
