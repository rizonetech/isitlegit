import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent/loop";
import { createToolExecutor, type ToolDeps } from "../../src/agent/tools";
import { type EvidenceDraft, saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { getVerdict } from "../../src/db/verdicts";
import { allowance, RESULT } from "../walkthrough/allowance";

// D04 T01 §4 live: the verdict agent with the live Muse Spark on five synthetic fixtures, under the allowance
// scripts/agent-live.ts reserved (US$1.00 cap). Runs only with AGENT_LIVE=1 and the keys it passes; tool
// implementations are stubs, so the run spends on model turns only.
const live = env as unknown as Record<string, string | undefined>;
const LIVE = live.AGENT_LIVE === "1";
const PAGE = "https://phish.example/signin";

const draft = (check: string, severity: EvidenceDraft["severity"], summary: string, detail = {}): EvidenceDraft => ({
  check,
  severity,
  summary,
  detail,
  artefacts: [],
});

const FIXTURES: { name: string; summary: string; items: EvidenceDraft[] }[] = [
  {
    name: "credential form",
    summary: "An invoice email links to a sign-in page.",
    items: [draft("link.credential_form", "high", "A form asks for sign-in details.", { page: PAGE })],
  },
  {
    name: "lookalike lure",
    summary: "A delivery notice with one prominent button.",
    items: [draft("link.lure_button", "medium", "A lone button says View document.", { page: PAGE })],
  },
  {
    name: "critical walk",
    summary: "The linked page was walked with test credentials.",
    items: [draft("walkthrough.credential_target", "critical", "Sign-in details would go to collect.example.", { domain: "collect.example" })],
  },
  {
    name: "clean newsletter",
    summary: "A monthly newsletter from a supplier.",
    items: [draft("auth.dmarc", "info", "DMARC passed for the sender domain.", {})],
  },
  {
    name: "voice payment request",
    summary: "A voice note asks for a payment.",
    items: [
      draft("voice.request", "high", 'The voice note asks for a payment: "pay it today"', { request: "pay" }),
      draft("voice.claimed_identity", "info", 'The speaker says they are Naledi: "it is Naledi"', { identity: "Naledi" }),
    ],
  },
];

describe.skipIf(!LIVE)("runAgent live", () => {
  it("verdicts five synthetic fixtures", { timeout: 240_000 }, async ({ task }) => {
    const budget = allowance(Number(live.AGENT_ALLOWANCE_USD ?? "0"));
    const meta = {
      env: {
        ...(live.AGENT_META_API_KEY ? { META_API_KEY: live.AGENT_META_API_KEY } : {}),
        ...(live.AGENT_CF_AIG_TOKEN ? { CF_AIG_TOKEN: live.AGENT_CF_AIG_TOKEN } : {}),
        ...(live.AGENT_GATEWAY_URL ? { META_GATEWAY_URL: live.AGENT_GATEWAY_URL } : {}),
      },
      budget,
    };
    const deps: ToolDeps = {
      expand: async () => [draft("agent.expand_link", "info", "The link ends at collect.example.")],
      screenshot: async () => [],
      lookupDomain: async () => [draft("agent.lookup_domain", "info", "The domain was registered recently.")],
      ledger: async () => [],
      walk: async () => [],
    };
    const cases: { name: string; verdict: string; source: string }[] = [];
    for (const fixture of FIXTURES) {
      const made = await createCase(env.DB, { orgId: "org-agent-live", channel: "email", headersAvailable: true });
      if (!made.ok) throw new Error(made.error.message);
      const caseId = made.value.id;
      await saveEvidence(env.DB, caseId, fixture.items);
      const executor = createToolExecutor({ db: env.DB, caseId, urls: [PAGE] }, deps);
      const view = await runAgent({ db: env.DB, meta, summary: fixture.summary, headersAvailable: true, executor }, caseId);
      const stored = await getVerdict(env.DB, caseId);
      expect(stored?.ok && stored.value.source).toBe(view.source);
      cases.push({ name: fixture.name, verdict: view.verdict, source: view.source });
    }
    (task.meta as Record<string, unknown>)[RESULT] = { outcome: "agent-live", attempts: budget.attempts(), cases };
    expect(cases).toHaveLength(5);
  });
});
