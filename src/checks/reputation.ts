// The case's link and sender-domain reputation, read by the checks step (D02 T06 §5): the answers §1's Web Risk
// lookup, §2's Cloudflare block check and §3's well-known list give, handed to the checks on the view, since a check
// never reaches the network or KV itself. This section only reads the answers; §4 registers the checks that weigh
// them, and a listing read here never decides anything on its own (spec 4.3a).
import type { CfResult } from "./cf-block";
import { type Links, MAX_LINKS } from "./links";
import { listName } from "./top-list";
import type { WellKnown } from "./top-sites";
import { stripUrl, type WebRiskResult } from "./webrisk";

// Every lookup of one case together under this budget, started when the case's links are read and run beside the
// step's other network reads, so the step keeps its own deadline with time to store its evidence.
export const REPUTATION_BUDGET_MS = 10_000;

export type ReputationDeps = {
  webRisk: (url: string) => Promise<WebRiskResult>;
  cloudflare: (domain: string) => Promise<CfResult>;
  wellKnown: (host: string) => Promise<WellKnown>;
  // The one budget for the case's lookups, REPUTATION_BUDGET_MS unless a test shortens it.
  budgetMs?: number;
};

export type Reputation = {
  // One entry per distinct stripped URL among the case's links, in the order first seen.
  links: { url: string; webRisk: WebRiskResult }[];
  // One entry per distinct registrable domain of those URLs' hosts and of the original sender, in the order first seen.
  domains: { domain: string; cloudflare: CfResult; wellKnown: WellKnown }[];
  // What was not looked up: the links past MAX_LINKS, a link whose URL does not strip, a domain past the bound or
  // with no valid registrable name.
  notLookedUp: number;
};

// An answer in by the one deadline, or the not-checked answer the fallback makes when it settles late. A rejection
// is never converted, whenever it lands: the providers throw only when their audit write fails (§1, §2), and that
// refusal must fail the step so it retries. The providers are bounded at their own layer (a 4-second deadline and
// 500 ms cache reads, §1 and §2), so waiting for an answer to settle is bounded there; a provider that never settles
// is bounded by the Workflow step's own timeout, as every other read in the step is.
function within<T>(answer: Promise<T>, deadline: number, fallback: () => T): Promise<T> {
  return answer.then((value) => (Date.now() >= deadline ? fallback() : value));
}

// The answers for the case's links and sender domain, or null when there is neither a link nor a sender domain.
// Each provider is asked once per distinct URL or domain; an answer that misses the budget reads as not checked,
// never as the negative answer (not listed, clear or unknown).
export async function reputationOf(
  links: Links | null,
  deps: ReputationDeps,
  senderDomain: string | null = null,
): Promise<Reputation | null> {
  const budgetMs = deps.budgetMs ?? REPUTATION_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const hadInput = (links?.items.length ?? 0) > 0 || (links?.more ?? 0) > 0 || senderDomain !== null;
  let notLookedUp = links?.more ?? 0;
  const urls: string[] = [];
  for (const item of links?.items ?? []) {
    const stripped = stripUrl(item.href);
    if (stripped === null) {
      notLookedUp++;
    } else if (!urls.includes(stripped)) {
      urls.push(stripped);
    }
  }
  const domains: string[] = [];
  const addDomain = (host: string | null) => {
    const name = host ? listName(host) : null;
    if (name === null) {
      notLookedUp++;
    } else if (!domains.includes(name)) {
      if (domains.length >= MAX_LINKS) notLookedUp++;
      else domains.push(name);
    }
  };
  for (const item of links?.items ?? []) addDomain(item.host);
  if (senderDomain !== null) addDomain(senderDomain);
  // Null only for genuine absence: a case whose every input was refused still carries what was not looked up, so
  // incomplete coverage is never indistinguishable from nothing to check.
  if (!hadInput) return null;
  const [linkAnswers, domainAnswers] = await Promise.all([
    Promise.all(
      urls.map(async (url) => ({
        url,
        webRisk: await within(
          deps.webRisk(url),
          deadline,
          () => ({ state: "not_checked", reason: "timeout" }) as const,
        ),
      })),
    ),
    Promise.all(
      domains.map(async (domain) => {
        // Both providers start together against the one deadline, and both deadline handlers are attached before
        // either is awaited, so an answer in on time survives its sibling settling late.
        const cloudflare = within(
          deps.cloudflare(domain),
          deadline,
          () =>
            ({
              state: "not_checked",
              reason: "timeout",
            }) as const,
        );
        const wellKnown = within(
          deps.wellKnown(domain),
          deadline,
          () =>
            ({
              state: "not_checked",
              reason: "unavailable",
            }) as const,
        );
        return { domain, cloudflare: await cloudflare, wellKnown: await wellKnown };
      }),
    ),
  ]);
  return { links: linkAnswers, domains: domainAnswers, notLookedUp };
}
