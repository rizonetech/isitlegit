// The verdict agent's read-only tools (D04 T01 §3; design spec 4.6, 4.6a). The model proposes; this module decides
// what runs: every call's arguments pass a zod schema before anything is invoked (Meta does not guarantee that
// arguments match the schema, and only `tool_choice: "auto"` is offered), a URL or domain argument is refused
// unless the case already holds it, and each implementation is injected so the tests stub them and §4 wires the
// real ones (`expandLink`, the landing capture, the brand table and RDAP, the supplier ledger, `walkthroughStep`).
//
// Tool evidence is the `agent` later producer (D02 T01 §5): items named `agent.<tool>`, written through
// `addEvidence` beside the items from earlier calls in the same order, so an issued Evidence ID never moves (no
// other producer writes between calls inside the verdict step, and the walk tool never rewrites walkthrough
// evidence). A failed implementation is stated as coverage the case could not get (`detail.checked: false`, the
// verdict's own flag), never as a negative finding. At most 8 calls and 90 seconds per case; a call raced past
// the time left writes nothing.

import { z } from "zod";
import { addEvidence, type Evidence, type EvidenceDraft, readEvidence } from "../checks/evidence";
import { findSupplier, matchSupplierAccount } from "../invoice/ledger";
import type { BankKeys } from "../trust/bank";

export const MAX_TOOL_CALLS = 8;
export const TOOL_BUDGET_MS = 90_000;

const Url = z.strictObject({ url: z.string().min(1).max(2048) });
export const TOOL_SCHEMAS = {
  expand_link: Url,
  screenshot_url: Url,
  lookup_domain: z.strictObject({ domain: z.string().min(1).max(253) }),
  ledger_lookup: z.strictObject({
    supplier: z.string().min(1).max(200),
    account_number: z.string().min(1).max(64).optional(),
    branch_code: z.string().min(1).max(32).optional(),
  }),
  walk_phishing_site: Url,
} as const;
export type ToolName = keyof typeof TOOL_SCHEMAS;

const DESCRIPTIONS: Record<ToolName, string> = {
  expand_link: "Follow a link already in the case and report where it ends, hop by hop.",
  screenshot_url: "Take a fresh screenshot of a page already in the case.",
  lookup_domain: "Look up a domain already in the case: whose brand it resembles, and when it was registered.",
  ledger_lookup:
    "Check the case organisation's supplier ledger: whether the supplier is known, and whether a claimed bank account matches the recorded one (match or no match only).",
  walk_phishing_site:
    "Walk a phishing page already in the case with test credentials, or return the walk already stored for it.",
};

export type ToolDefinition = {
  type: "function";
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
};

// One function tool per tool, its parameters generated from that tool's own zod schema, so the model is offered
// exactly what the executor accepts.
export function toolDefinitions(): ToolDefinition[] {
  return (Object.keys(TOOL_SCHEMAS) as ToolName[]).map((name) => {
    const { $schema: _schema, ...parameters } = z.toJSONSchema(TOOL_SCHEMAS[name]) as Record<string, unknown>;
    return { type: "function", name, description: DESCRIPTIONS[name], parameters, strict: true };
  });
}

// What one tool does, injected: drafts in the `agent` family for the first four; the walk returns evidence the
// walkthrough step already stored (its own producer), so a second walk never runs and nothing is rewritten.
export type ToolDeps = {
  expand: (url: string) => Promise<EvidenceDraft[]>;
  screenshot: (url: string) => Promise<EvidenceDraft[]>;
  lookupDomain: (domain: string) => Promise<EvidenceDraft[]>;
  ledger: (args: { supplier: string; accountNumber?: string; branchCode?: string }) => Promise<EvidenceDraft[]>;
  walk: (url: string) => Promise<Evidence[]>;
};

export type ToolResult =
  | { status: "ok"; tool: string; evidence: Evidence[] }
  | { status: "refused"; tool: string; reason: string }
  | { status: "failed"; tool: string; reason: string; evidence: Evidence[] };

export type ToolContext = { db: D1Database; caseId: string; urls: readonly string[] };

const CLASS = /^[A-Z][A-Za-z0-9]{0,63}$/;
const errorClass = (error: unknown) => (error instanceof Error && CLASS.test(error.name) ? error.name : "Error");

export function createToolExecutor(
  ctx: ToolContext,
  deps: ToolDeps,
  opts: { maxCalls?: number; budgetMs?: number; now?: () => number } = {},
) {
  const maxCalls = opts.maxCalls ?? MAX_TOOL_CALLS;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? TOOL_BUDGET_MS);
  let calls = 0;

  const allowed = new Map<string, string>();
  for (const raw of ctx.urls) {
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") allowed.set(url.href, url.hostname.toLowerCase());
    } catch {
      // Not a URL the case can offer a tool.
    }
  }
  const hosts = new Set(allowed.values());

  // This producer's items as drafts again, in order, with the new ones after them: one replacing write whose
  // stored IDs are the ones already issued plus the new ones at the end.
  async function save(drafts: EvidenceDraft[]): Promise<Evidence[]> {
    const existing = (await readEvidence(ctx.db, ctx.caseId)).filter((e) => e.check.startsWith("agent."));
    const kept: EvidenceDraft[] = existing.map(({ check, severity, summary, detail, artefacts }) => ({
      check,
      severity,
      summary,
      detail,
      artefacts,
    }));
    const stored = await addEvidence(ctx.db, ctx.caseId, "agent", [...kept, ...drafts]);
    return stored.slice(kept.length);
  }

  async function failed(tool: ToolName, error: unknown): Promise<ToolResult> {
    const reason = errorClass(error);
    const draft: EvidenceDraft = {
      check: `agent.${tool}`,
      severity: "info",
      summary: `The ${tool.replaceAll("_", " ")} tool could not run.`,
      detail: { checked: false, error: reason },
      artefacts: [],
    };
    const evidence = await save([draft]).catch(() => []);
    return { status: "failed", tool, reason, evidence };
  }

  async function call(name: string, rawArgs: unknown): Promise<ToolResult> {
    calls += 1;
    if (!(name in TOOL_SCHEMAS)) return { status: "refused", tool: name, reason: "unknown_tool" };
    const tool = name as ToolName;
    if (calls > maxCalls) return { status: "refused", tool, reason: "call_cap" };
    if (now() >= deadline) return { status: "refused", tool, reason: "time_cap" };
    let args: unknown = rawArgs;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        return { status: "refused", tool, reason: "invalid_arguments" };
      }
    }
    const parsed = TOOL_SCHEMAS[tool].safeParse(args);
    if (!parsed.success) return { status: "refused", tool, reason: "invalid_arguments" };
    const value = parsed.data as { url?: string; domain?: string };

    // The work raced against the time left, its evidence saved only when it wins: a result that arrives late is
    // discarded and writes nothing. (A walk's own writes belong to the walkthrough step, which caps itself.)
    let work: () => Promise<EvidenceDraft[]>;
    if (tool === "expand_link" || tool === "screenshot_url" || tool === "walk_phishing_site") {
      let href: string;
      try {
        href = new URL(value.url as string).href;
      } catch {
        return { status: "refused", tool, reason: "invalid_arguments" };
      }
      if (!allowed.has(href)) return { status: "refused", tool, reason: "url_not_in_case" };
      if (tool === "walk_phishing_site") {
        const walkWork = async (): Promise<Evidence[]> => {
          // One walk per case: what the Workflow's walkthrough step stored is the walk; only a case with none
          // delegates, and `walkthroughStep` itself trigger-gates and caps.
          const stored = (await readEvidence(ctx.db, ctx.caseId)).filter((e) => e.check.startsWith("walkthrough."));
          if (stored.length) return stored;
          return deps.walk(href);
        };
        const remaining = deadline - now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<ToolResult>((resolve) => {
          timer = setTimeout(() => resolve({ status: "refused", tool, reason: "time_cap" }), remaining);
        });
        try {
          const evidence = await Promise.race([walkWork(), late.then(() => null)]);
          return evidence === null ? { status: "refused", tool, reason: "time_cap" } : { status: "ok", tool, evidence };
        } catch (error) {
          return failed(tool, error);
        } finally {
          clearTimeout(timer);
        }
      }
      const impl = tool === "expand_link" ? deps.expand : deps.screenshot;
      work = () => impl(href);
    } else if (tool === "lookup_domain") {
      const domain = (value.domain as string).toLowerCase();
      if (!hosts.has(domain)) return { status: "refused", tool, reason: "domain_not_in_case" };
      work = () => deps.lookupDomain(domain);
    } else {
      const ledgerArgs = parsed.data as z.infer<typeof TOOL_SCHEMAS.ledger_lookup>;
      work = () =>
        deps.ledger({
          supplier: ledgerArgs.supplier,
          ...(ledgerArgs.account_number ? { accountNumber: ledgerArgs.account_number } : {}),
          ...(ledgerArgs.branch_code ? { branchCode: ledgerArgs.branch_code } : {}),
        });
    }

    const remaining = deadline - now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), remaining);
    });
    try {
      const drafts = await Promise.race([work(), late]);
      if (drafts === "late") return { status: "refused", tool, reason: "time_cap" };
      return { status: "ok", tool, evidence: await save(drafts) };
    } catch (error) {
      return failed(tool, error);
    } finally {
      clearTimeout(timer);
    }
  }

  return { call, definitions: toolDefinitions };
}

// The ledger tool's real implementation (D06 T01 §2): the supplier by name in the case's own organisation (the
// organisation comes from here, never from arguments), and, with a claimed account, match or no match only. An
// unknown supplier is an answer, not a failure; an ambiguity, a missing baseline or a key mismatch throws, which
// the executor states as a failed call, never as "no match". No account number reaches the evidence or the result.
export function ledgerLookup(db: D1Database, orgId: string, keys: BankKeys): ToolDeps["ledger"] {
  return async ({ supplier, accountNumber, branchCode }) => {
    const found = await findSupplier(db, orgId, { name: supplier });
    if (!found)
      return [
        {
          check: "agent.ledger_lookup",
          severity: "info",
          summary: `The supplier ledger has no supplier named ${supplier}.`,
          detail: { supplier: null, known: false },
          artefacts: [],
        },
      ];
    if (!accountNumber || !branchCode)
      return [
        {
          check: "agent.ledger_lookup",
          severity: "info",
          summary: `${found.name} is a known supplier in the ledger.`,
          detail: { supplier: found.name, known: true },
          artefacts: [],
        },
      ];
    const { match } = await matchSupplierAccount(db, keys, orgId, found.id, {
      number: accountNumber,
      branchCode,
    });
    return [
      {
        check: "agent.ledger_lookup",
        severity: match ? "info" : "high",
        summary: match
          ? `The claimed account matches the one recorded for ${found.name}.`
          : `The claimed account does not match the one recorded for ${found.name}.`,
        detail: { supplier: found.name, known: true, match },
        artefacts: [],
      },
    ];
  };
}
