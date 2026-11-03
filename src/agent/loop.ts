// The verdict agent (D04 T01 §4; design spec 4.6, 4.6a). Muse Spark receives the case summary and the evidence
// list, never raw HTML, calls the read-only tools (§3) with `tool_choice: "auto"`, and gives its verdict as
// structured output. The model's opinion never outranks the code around it:
//
// - the deterministic floor (§1) caps the verdict, and a floored answer is stored with the rules' headline and
//   meaning, never the model's contradictory ones;
// - every cited ID must be the case's: an invalid one, or none, falls back to the rule-based verdict (§2);
// - coverage the case could not get (a failed tool, a check that did not run) keeps a safe verdict partial;
// - fixed actions (a bank change, a proof of payment, a voice call-back) are decided from evidence by code, first;
// - a model refusal, an outage or an exhausted budget stores the rule-based verdict, never a clean bill.
//
// The summary, the evidence list and every tool result reach the model inside untrusted blocks. Every turn and
// tool call is an `agent` case event.

import puppeteer from "@cloudflare/puppeteer";
import type { Response as MetaResponse } from "openai/resources/responses/responses";
import { z } from "zod";
import type { BrandTable } from "../checks/brand-schema";
import { getBrand } from "../checks/brands";
import { type Evidence, readEvidence } from "../checks/evidence";
import { expandLink, livePolicy } from "../checks/expand";
import { rdapLookup } from "../checks/rdap";
import { ulid } from "../db/ulid";
import { saveVerdict, type VerdictView } from "../db/verdicts";
import type { Store } from "../intake/store";
import { bankChangeAction, callBackAction, fixedActionOf, POP_ACTION } from "../invoice/fixed-actions";
import { d1Budget } from "../meta/budget";
import { type MetaContext, metaResponses } from "../meta/client";
import { structured } from "../meta/structured";
import { UNTRUSTED_WARNING, untrusted, untrustedBlock } from "../meta/untrusted";
import { recordEvent } from "../pipeline/events";
import type { BankKeys } from "../trust/bank";
import { SPARK_REASONING_EFFORT } from "../vision/screen-request";
import { kvCache, walkthroughStep } from "../walkthrough/trigger";
import { dohResolve } from "../walkthrough/url-policy";
import { walk } from "../walkthrough/wonder";
import { validateCitations } from "./citations";
import { applyFloor, floorFor } from "./floor";
import { PARTIAL_HEADLINE, PARTIAL_MEANING, ruleVerdict } from "./rule-verdict";
import { createToolExecutor, ledgerLookup, type ToolDeps, type ToolResult } from "./tools";

export const SPARK = "muse-spark-1.3";
export const AGENT_DEADLINE_MS = 150_000;
const MAX_TURNS = 12;
const NO_HEADERS_CAP = 0.6;
const MARKER = /\[E[0-9]+\]/;
export const VerdictAnswer = z.strictObject({
  verdict: z.enum(["safe", "suspicious", "malicious"]),
  confidence: z.number().min(0).max(1),
  headline: z.string().min(1).max(300),
  explanation: z.string().min(1).max(2000),
  cited_evidence_ids: z.array(z.string().regex(/^E[0-9]+$/)).max(10),
  recommended_actions: z.array(z.string().min(1).max(300)).max(10),
  meaning: z
    .string()
    .min(1)
    .max(300)
    .refine((s) => !MARKER.test(s), "no evidence markers"),
});
export type VerdictAnswer = z.infer<typeof VerdictAnswer>;

const RULES = [
  "You investigate one forwarded message for a small business and give a verdict: safe, suspicious or malicious.",
  "Work only from the evidence listed. You may call the tools to gather more, only about links and domains already in the case.",
  "Critical evidence is a floor, not a suggestion: a case with bank details changed, a credential form on a lookalike domain, or malware sets the minimum verdict stated in the evidence, whatever you think of the rest.",
  "Cite only the Evidence IDs listed, exactly as written. A claim without a citation will be rejected.",
  "Never invent a phone number, a link or an instruction the evidence does not carry.",
  "Judge the ask itself. A message that asks the reader to hand over sign-in details, to sign in through a link or page it supplies, to pay into new or changed bank details, or to follow a link or domain the evidence ties to harm (lookalike, newly registered, mismatched), is suspicious on its content, whatever its headers say. A routine ask the evidence does not tie to harm, such as a payment to the bank details already on file, and a message with no harmful ask, is not made suspicious by a check that could not run, an authentication result that is absent, or a header the upload never carried: that is missing evidence, and on missing evidence alone the verdict is safe, saying what could not be checked.",
].join("\n");

// Fixed actions from evidence, decided by code, in the order the report puts them first: a bank change, a proof
// of payment, a voice call-back (D04 T01 §4; the triggers are the evidence items the checks and tools produce).
export function fixedActionsFor(evidence: readonly Evidence[]): string[] {
  const request = evidence.find((e) => e.check === "voice.request");
  const identity = evidence.find((e) => e.check === "voice.claimed_identity");
  const asked = typeof request?.detail.request === "string" ? request.detail.request : null;
  // Every bank-change trigger in evidence order (D04 T01 §15): each ledger mismatch and every critical invoice
  // item, each carrying its fixed action with the ledger's own number its producer put in its detail (§12),
  // never a number from the mail. Identical actions deduplicate to one, and when any numbered action stands the
  // generic numberless one is suppressed (the §12 numbered-wins rule), so a numberless trigger beside a numbered
  // one yields the numbered action.
  const triggers = evidence.filter(
    (e) =>
      (e.check === "agent.ledger_lookup" && e.detail.match === false) ||
      (e.check.startsWith("invoice.") && e.severity === "critical"),
  );
  const perTrigger = triggers.map((e) =>
    bankChangeAction(typeof e.detail.phone === "string" ? e.detail.phone : undefined),
  );
  const numbered = perTrigger.filter((a) => a !== bankChangeAction());
  const bankActions = [...new Set(numbered.length ? numbered : perTrigger)];
  if (!triggers.length && asked === "change_bank_details") bankActions.push(bankChangeAction());
  const pop = evidence.some((e) => e.check === "document.proof_of_payment");
  const name = typeof identity?.detail.identity === "string" ? identity.detail.identity : null;
  const out: string[] = [...bankActions];
  if (pop) out.push(POP_ACTION);
  if ((asked === "pay" || asked === "change_bank_details") && name) out.push(callBackAction(name));
  return out;
}

export type AgentContext = {
  db: D1Database;
  meta: {
    env: MetaContext["env"];
    budget: MetaContext["budget"];
    fetch?: typeof fetch;
    waitUntil?: (p: Promise<unknown>) => void;
  };
  summary: string;
  headersAvailable: boolean;
  executor: ReturnType<typeof createToolExecutor>;
  deadlineMs?: number;
  now?: () => number;
};

const Item = z.union([
  z
    .object({
      type: z.literal("function_call"),
      name: z.string().min(1),
      call_id: z.string().min(1),
      arguments: z.string(),
    })
    .passthrough(),
  z
    .object({ type: z.literal("message"), content: z.array(z.object({ type: z.string() }).passthrough()).min(1) })
    .passthrough(),
  z.object({ type: z.string() }).passthrough(),
]);

type Part = { type: "input_text"; text: string };
type Input = (
  | { role: "developer" | "user"; content: string | Part[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
)[];

const outcome = (result: ToolResult) =>
  result.status === "ok"
    ? {
        status: result.status,
        evidence: result.evidence.map(({ id, check, severity, summary, detail, artefacts }) => ({
          id,
          check,
          severity,
          summary,
          detail,
          artefacts,
        })),
      }
    : result.status === "refused"
      ? { status: result.status, reason: result.reason }
      : {
          status: result.status,
          reason: result.reason,
          evidence: result.evidence.map(({ id, check }) => ({ id, check })),
        };

// A verdict that was not stored is not a verdict: the typed refusal is thrown, never reported as success.
async function mustSave(db: D1Database, caseId: string, view: VerdictView): Promise<void> {
  const saved = await saveVerdict(db, caseId, view);
  if (!saved.ok) throw new Error(`storing the verdict: ${saved.error.code}`);
}

async function fallback(ctx: AgentContext, caseId: string, fresh: readonly Evidence[]): Promise<VerdictView> {
  const rules = ruleVerdict(fresh, { headersAvailable: ctx.headersAvailable });
  const fixed = fixedActionsFor(fresh);
  // The investigation itself could not run: a safe answer from it is partial, never an ordinary clean bill.
  const partial = rules.verdict === "safe";
  const view: VerdictView = {
    ...rules,
    ...(partial ? { headline: PARTIAL_HEADLINE, meaning: PARTIAL_MEANING } : {}),
    confidence: Math.min(rules.confidence, ctx.headersAvailable ? 1 : NO_HEADERS_CAP, partial ? 0.5 : 1),
    actions: [...fixed, ...rules.actions.filter((a) => !fixed.includes(a))].slice(0, 10),
  };
  await mustSave(ctx.db, caseId, view);
  return view;
}

export async function runAgent(ctx: AgentContext, caseId: string): Promise<VerdictView> {
  const now = ctx.now ?? Date.now;
  const started = now();
  const deadline = started + (ctx.deadlineMs ?? AGENT_DEADLINE_MS);
  const meta: MetaContext = {
    env: ctx.meta.env,
    budget: ctx.meta.budget,
    owner: { kind: "case", caseId, step: "verdict" },
    ...(ctx.meta.fetch ? { fetch: ctx.meta.fetch } : {}),
    ...(ctx.meta.waitUntil ? { waitUntil: ctx.meta.waitUntil } : {}),
  };
  const event = (status: "done" | "failed", at: number, error?: unknown) =>
    recordEvent(ctx.db, caseId, "agent", status, {
      ms: Math.max(0, now() - at),
      ...(error ? { errorClass: error instanceof Error ? error.name : "Error" } : {}),
    }).catch(() => undefined);

  try {
    const evidence = await readEvidence(ctx.db, caseId);
    const lines = evidence.map(
      (e) =>
        `${e.id} [${e.check}/${e.severity}] ${e.summary}${e.artefacts.length ? ` (artefacts: ${e.artefacts.join(", ")})` : ""}`,
    );
    const input: Input = [
      { role: "developer", content: RULES },
      { role: "developer", content: [{ type: "input_text", text: UNTRUSTED_WARNING }] },
      {
        role: "user",
        content: [
          untrusted("case", `Case summary\n${ctx.summary}\n\nEvidence\n${lines.join("\n") || "(none yet)"}`, {
            limit: 24_000,
          }),
        ],
      },
    ];
    const tools = ctx.executor.definitions();
    let answered = false;
    // A call the caps refused, like a failed one, is coverage the investigation could not get.
    let exhausted = false;
    for (let turn = 0; turn < MAX_TURNS && !answered; turn++) {
      const at = now();
      const answer = await metaResponses(
        {
          model: SPARK,
          input: input as never,
          tools,
          tool_choice: "auto",
          reasoning: { effort: SPARK_REASONING_EFFORT },
          max_output_tokens: 1024,
        },
        { ...meta, deadlineMs: Math.max(1, deadline - now()) },
      );
      const items = z.array(Item).parse((answer.data as MetaResponse).output ?? []);
      const calls = items.filter((i) => i.type === "function_call") as Extract<
        z.infer<typeof Item>,
        { type: "function_call" }
      >[];
      await event("done", at);
      if (!calls.length) {
        answered = true;
        break;
      }
      for (const call of items.filter((i) => i.type === "function_call") as Extract<
        z.infer<typeof Item>,
        { type: "function_call" }
      >[]) {
        const callAt = now();
        const result = await ctx.executor.call(call.name, call.arguments);
        if (result.status !== "ok") exhausted = true;
        await event(result.status === "ok" ? "done" : "failed", callAt);
        input.push({ type: "function_call", name: call.name, call_id: call.call_id, arguments: call.arguments });
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: untrustedBlock("tool-result", JSON.stringify(outcome(result)), { limit: 12_000 }),
        });
      }
    }
    const finalAt = now();
    const first = await structured(
      VerdictAnswer,
      {
        model: SPARK,
        input: [
          ...input,
          { role: "user", content: "Give the final verdict now, citing the Evidence IDs it rests on." },
        ] as never,
        name: "verdict",
        reasoning: { effort: SPARK_REASONING_EFFORT },
        max_output_tokens: 2000,
      },
      { ...meta, deadlineMs: Math.max(1, deadline - now()), waitUntil: ctx.meta.waitUntil ?? (() => undefined) },
    );
    await event("done", finalAt);

    // Finalised on the evidence as it now stands: what a tool found floors, fixes and is citable in this run.
    // The citation validator (D04 T01 §5) refuses an answer that cites outside it, explains without markers,
    // or marks IDs it never declared: one retry carries the findings, a second failure falls back to rules.
    // Schema repair and the citation retry share one two-answer finalisation budget: what the first call
    // already spent is gone, so no sequence reaches a third accepted final answer.
    const fresh = await readEvidence(ctx.db, caseId);
    const byId = new Map(fresh.map((e) => [e.id, e]));
    let answer = first.value;
    const findings = validateCitations(answer, new Set(byId.keys()));
    if (findings.length) {
      await event("failed", finalAt);
      const left = 2 - first.attempts;
      if (left < 1 || deadline - now() <= 0) return fallback(ctx, caseId, await readEvidence(ctx.db, caseId));
      const retry = await structured(
        VerdictAnswer,
        {
          model: SPARK,
          input: [
            ...input,
            {
              role: "user" as const,
              content: `The citation validator refused the previous answer: ${findings.join("; ")}. Cite only the listed Evidence IDs, declare every ID you cite, and put a citation marker in every sentence. Give the final verdict now, citing the Evidence IDs it rests on.`,
            },
          ] as never,
          name: "verdict",
          reasoning: { effort: SPARK_REASONING_EFFORT },
          max_output_tokens: 2000,
        },
        {
          ...meta,
          deadlineMs: Math.max(1, deadline - now()),
          waitUntil: ctx.meta.waitUntil ?? (() => undefined),
          // Only what the shared budget has left: structured()'s own schema repair counts against it too.
          maxAttempts: left,
        },
      ).catch(() => null);
      if (!retry || validateCitations(retry.value, new Set(byId.keys())).length)
        return fallback(ctx, caseId, await readEvidence(ctx.db, caseId));
      answer = retry.value;
    }
    const cited = answer.cited_evidence_ids;

    const { verdict, floorApplied } = applyFloor(answer.verdict, floorFor(fresh));
    const floored = floorApplied !== null;
    const rules = ruleVerdict(fresh, { headersAvailable: ctx.headersAvailable });
    const partial =
      verdict === "safe" && (exhausted || fresh.some((e) => e.check === "not_checked" || e.detail.checked === false));
    const fixed = fixedActionsFor(fresh);
    // A floored verdict is explained by its decisive evidence first: the model's own citations may name only
    // benign items under a verdict the floor enforced.
    const floorIds = floorFor(fresh).evidenceIds.filter((id) => byId.has(id));
    const reasonIds = floored ? [...floorIds, ...cited.filter((id) => !floorIds.includes(id))] : cited;
    const view: VerdictView = {
      verdict,
      headline: floored ? rules.headline : partial ? PARTIAL_HEADLINE : answer.headline,
      confidence: Math.min(answer.confidence, ctx.headersAvailable ? 1 : NO_HEADERS_CAP, partial ? 0.5 : 1),
      reasons: reasonIds.slice(0, 3).map((id) => ({ text: (byId.get(id) as Evidence).summary, evidenceIds: [id] })),
      actions: floored
        ? [...fixed, ...rules.actions.filter((a) => !fixed.includes(a))].slice(0, 10)
        : [...fixed, ...answer.recommended_actions.filter((a) => !fixed.includes(a) && !fixedActionOf(a))].slice(0, 10),
      meaning: floored ? rules.meaning : partial ? PARTIAL_MEANING : answer.meaning,
      source: "agent",
      floorApplied: floorApplied ? { ...floorApplied, evidenceIds: floorIds } : null,
      ablated: null,
    };
    await mustSave(ctx.db, caseId, view);
    return view;
  } catch (error) {
    await event("failed", started, error);
    // An evidence list that could not be read is not an empty one: no verdict is stored from it, so the step
    // fails and the case ends partial with no verdict rather than safe over evidence it never saw.
    return fallback(ctx, caseId, await readEvidence(ctx.db, caseId));
  }
}

// The Workflow's tool implementations (D04 T01 §4): the link follower and landing capture of D02 T07, the brand
// table and RDAP, the supplier ledger, and the walkthrough step, each behind §3's executor.
export function verdictToolDeps(
  env: Env,
  db: D1Database,
  store: Store,
  caseId: string,
  orgId: string | null,
  table: BrandTable,
  keys: BankKeys | null,
) {
  const launch = () => puppeteer.launch(env.BROWSER);
  const deps: ToolDeps = {
    expand: async (url) => {
      const browser = await launch();
      try {
        const found = await expandLink(browser, url, { policy: livePolicy() });
        return [
          {
            check: "agent.expand_link",
            severity: "info",
            summary: found.final
              ? `The link ends at ${found.final} after ${found.hops.length} hop${found.hops.length === 1 ? "" : "s"} (${found.outcome}).`
              : `The link could not be followed through (${found.outcome}${found.reason ? `: ${found.reason}` : ""}).`,
            detail: { url, final: found.final, outcome: found.outcome, hops: found.hops.length },
            artefacts: [],
          },
        ];
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
    screenshot: async (url) => {
      // The link follower walks it first under the URL policy; the screenshot then loads only the page it settled
      // on, with every subresource locked to that page's host, so a redirect cannot take the browser elsewhere.
      const browser = await launch();
      try {
        const followed = await expandLink(browser, url, { policy: livePolicy() });
        if (followed.outcome !== "done" || !followed.final)
          throw new Error(`the page could not be reached (${followed.outcome})`);
        const key = `case/${caseId}/agent/screenshot-${ulid()}.png`;
        const policy = livePolicy();
        const guard = async (page: Awaited<ReturnType<typeof browser.newPage>>) => {
          // No channels the interception cannot see (WebSocket, event streams, workers, RTC): the constructors
          // are gone before any page script runs, as the link follower's own capture does (src/checks/expand.ts).
          await page.evaluateOnNewDocument(
            "for (const name of ['WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection']) { try { delete globalThis[name]; } catch (e) {} }",
          );
          await page.setRequestInterception(true);
          page.on("request", (request) => {
            const target = request.url();
            if (/^(about:|data:|blob:)/.test(target)) return request.continue().catch(() => undefined);
            return policy(target)
              .then((verdict) => (verdict.ok ? request.continue() : request.abort()))
              .catch(() => request.abort())
              .catch(() => undefined);
          });
        };
        // A page the site opens gets the same guard before it can load anything of its own.
        browser.on("targetcreated", (target) => {
          target
            .page()
            .then((child) => (child ? guard(child) : undefined))
            .catch(() => undefined);
        });
        const page = await browser.newPage();
        try {
          await guard(page);
          await page.goto(followed.final, { waitUntil: "domcontentloaded", timeout: 15_000 });
          const shot = await page.screenshot({ type: "png" });
          await store.bucket.put(key, shot, { httpMetadata: { contentType: "image/png" } });
        } finally {
          await page.close().catch(() => undefined);
        }
        return [
          {
            check: "agent.screenshot_url",
            severity: "info",
            summary: "A fresh screenshot of the page was taken.",
            detail: { url, final: followed.final },
            artefacts: [key],
          },
        ];
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
    lookupDomain: async (domain) => {
      const brand = getBrand(table, domain);
      const age = await rdapLookup(domain, { fetch, cache: null }).catch(() => null);
      return [
        {
          check: "agent.lookup_domain",
          severity: "info",
          summary: brand
            ? `${domain} is a domain of the ${brand.name} brand.`
            : `${domain} is not a known brand domain.`,
          detail: { domain, brand: brand?.name ?? null, registered: age?.state === "known" ? age.registered : null },
          artefacts: [],
        },
      ];
    },
    ledger:
      orgId && keys
        ? ledgerLookup(db, orgId, keys)
        : async () => {
            throw new Error("the supplier ledger is not available for this case");
          },
    walk: async () => {
      const result = await walkthroughStep(
        {
          db,
          store,
          cache: kvCache(env.CACHE),
          launch,
          walk,
          resolve: dohResolve(),
          meta: { env, budget: d1Budget(db, { caller: "walkthrough", caseId }) },
          table,
          revision: env.CF_VERSION_METADATA?.id ?? null,
          walkId: () => ulid(),
        },
        caseId,
      );
      void result;
      return (await readEvidence(db, caseId)).filter((e) => e.check.startsWith("walkthrough."));
    },
  };
  return deps;
}

export type { BankKeys };
export { createToolExecutor, ledgerLookup };

// The case summary the Workflow hands the agent, from the parser's stored summary: its subject and sender, and
// its visible text. An HTML-only message gives only what a reader would see: script, style and hidden elements
// removed first (hidden text is evidence, never summary), then the tags.
export function caseSummary(parsed: { headers?: unknown; text?: string | null; html?: string | null }): string {
  const pairs: [string, string][] = [];
  if (Array.isArray(parsed.headers))
    for (const h of parsed.headers) {
      if (Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string") pairs.push([h[0], h[1]]);
      else if (
        h &&
        typeof h === "object" &&
        typeof (h as { name?: unknown }).name === "string" &&
        typeof (h as { value?: unknown }).value === "string"
      )
        pairs.push([(h as { name: string }).name, (h as { value: string }).value]);
    }
  const head = pairs
    .filter(([name]) => ["subject", "from", "to", "date"].includes(name.toLowerCase()))
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  const visible = (parsed.text ?? visibleOf(parsed.html ?? "")).slice(0, 8_000);
  return `${head}\n\n${visible}`.trim() || "(the message content could not be read)";
}

// One pass over the markup, so a run of "<" costs what it costs to read: script, style and hidden elements are
// skipped with their content, every other tag is skipped alone, and the text between tags is what remains.
function visibleOf(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf("<", i);
    if (open === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, open), " ");
    const close = html.indexOf(">", open);
    if (close === -1) break;
    const tag = lower.slice(open + 1, close);
    const name = /^[a-z0-9]+/.exec(tag)?.[0] ?? "";
    const hidden =
      /(^|[\s"'])hidden([\s"'=]|$)/.test(tag) ||
      /style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden)/.test(tag);
    if (name === "script" || name === "style" || hidden) {
      const end = lower.indexOf(`</${name}`, close);
      i = end === -1 ? html.length : end;
    } else i = close + 1;
  }
  return out.join("").replace(/\s+/g, " ").trim();
}
