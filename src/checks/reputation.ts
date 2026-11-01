// The case's link and sender-domain reputation, read by the checks step (D02 T06 §5): the answers §1's Web Risk
// lookup, §2's Cloudflare block check and §3's well-known list give, handed to the checks on the view, since a check
// never reaches the network or KV itself. This section only reads the answers; §4 registers the checks that weigh
// them, and a listing read here never decides anything on its own (spec 4.3a).
import {
  aligned,
  asciiDomain,
  bounded,
  dkimIdentifier,
  fittedDetail,
  fromDomain,
  plain,
  spfIdentifier,
  stateOf,
} from "./auth";
import { trustedAuthResults } from "./auth-results";
import type { CaseView } from "./case-view";
import type { CfResult } from "./cf-block";
import { split, techniqueOf } from "./domain-lookalike";
import type { EvidenceDraft } from "./evidence";
import { type Links, MAX_LINKS } from "./links";
import type { CheckRegistry } from "./registry";
import { originalSender } from "./senders-seen";
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

// The weighting rules (D02 T06 §4; spec 4.3a): what a listing weighs, beside the counter-signals that pull the other
// way. A listing alone never decides a verdict: `weighListing` returns high only with our own evidence beside it,
// and every listing item carries `cap = "suspicious"`, which the deterministic floor (`src/agent/floor.ts`) honours.
export const REPUTATION_PROVIDERS = [
  "google-web-risk",
  "cloudflare-security-dns",
  "majestic-million",
  "domain-age",
  "dmarc-aligned",
  "trust-network",
] as const;
export type ReputationProvider = (typeof REPUTATION_PROVIDERS)[number];
export type Granularity = "url" | "domain" | "ip";
// At most this many items a check, the rest counted in one more, so a maximum-size case keeps its findings under
// the runner's MAX_ITEMS_PER_CHECK.
export const MAX_REPUTATION_ITEMS = 20;
const DELIST_URL: Partial<Record<ReputationProvider, string>> = {
  "google-web-risk": "https://safebrowsing.google.com/safebrowsing/report_error/",
  "cloudflare-security-dns": "https://radar.cloudflare.com/domains/feedback",
};

export function weighListing(input: {
  provider: ReputationProvider;
  granularity: Granularity;
  corroborated: boolean;
}): "high" | "medium" | "low" {
  if (input.corroborated) return "high";
  // An IP listing is weak (shared hosting and relays) and never raises severity on its own; no IP provider is
  // wired yet (AbuseIPDB is deferred, spec 4.3a), so no item carries this granularity today.
  return input.granularity === "ip" ? "low" : "medium";
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};
const registrableOf = (host: string | null): string | null => (host ? listName(host) : null);

// Whether the trusted authentication results hold a failure (D02 T02 §2's reading: only a receiver we trust, and
// never an unavailable result).
function authFailed(view: CaseView): boolean {
  const selection = trustedAuthResults(
    view.headers,
    view.tenant.receivers,
    view.tenant.headersAvailable,
    view.tenant.chains,
  );
  if (!("trusted" in selection)) return false;
  return selection.trusted.results.some((r) => {
    const m = r.method;
    return (m === "spf" || m === "dkim" || m === "dmarc") && stateOf(m, r) === "failed";
  });
}

// The registrable domains a link or landing host imitates, by the lookalike check's own comparison against the
// view's brands and trusted domains (its own domains exempt, so a domain never corroborates itself).
function lookalikeDomains(view: CaseView): Set<string> {
  const targets = [
    ...view.tenant.trusted.own,
    ...view.tenant.trusted.suppliers,
    ...view.brands.brands.flatMap((b) => b.domains),
  ]
    .map((d) => asciiDomain(d))
    .filter((d): d is string => d !== null);
  const targetSplits = targets.map((d) => split(d)).filter((s) => s !== null);
  const found = new Set<string>();
  const candidates = [
    ...(view.links?.items ?? []).map((l) => l.host),
    ...(view.expansions?.items ?? []).flatMap((e) => [e.finalHost, ...(e.hops ?? []).map((h) => hostOf(h.url))]),
  ];
  for (const host of candidates) {
    const domain = registrableOf(host);
    if (!domain || targets.includes(domain)) continue;
    const candidate = split(domain);
    if (candidate && targetSplits.some((t) => techniqueOf(candidate, t) !== null)) found.add(domain);
  }
  return found;
}

// The registrable domains reached by a link whose landing page asks for credentials, from the expansions' own form
// scans (the reading `link.credential_form` makes, associated with the domain of the link that was followed).
function formDomains(view: CaseView): Set<string> {
  const found = new Set<string>();
  for (const e of view.expansions?.items ?? []) {
    const asks = (e.landing?.scans ?? []).some(
      (scan) =>
        scan.loosePasswordFields > 0 ||
        scan.forms.some((f) => f.passwordFields > 0 || f.destinations.some((d) => d.offDomain)),
    );
    if (!asks) continue;
    for (const host of [hostOf(e.link), e.finalHost]) {
      const domain = registrableOf(host);
      if (domain) found.add(domain);
    }
  }
  return found;
}

type Corroboration = { any: boolean; lookalike: Set<string>; form: Set<string> };
const corroborationOf = (view: CaseView): Corroboration => ({
  any: authFailed(view),
  lookalike: lookalikeDomains(view),
  form: formDomains(view),
});
const corroboratedFor = (c: Corroboration, domain: string | null) =>
  c.any || (domain !== null && (c.lookalike.has(domain) || c.form.has(domain)));

const listedDomainsOf = (rep: Reputation): { domain: string; wellKnown: WellKnown }[] => {
  const byDomain = new Map<string, WellKnown>();
  for (const d of rep.domains) if (d.cloudflare.state === "blocked") byDomain.set(d.domain, d.wellKnown);
  for (const l of rep.links) {
    if (l.webRisk.state !== "listed") continue;
    const domain = registrableOf(hostOf(l.url));
    if (domain && !byDomain.has(domain)) {
      const entry = rep.domains.find((d) => d.domain === domain);
      byDomain.set(domain, entry?.wellKnown ?? { state: "not_loaded" });
    }
  }
  return [...byDomain].map(([domain, wellKnown]) => ({ domain, wellKnown }));
};

export function listingEvidence(view: CaseView): EvidenceDraft[] {
  const rep = view.reputation;
  if (!rep) return [];
  const corroboration = corroborationOf(view);
  const items: EvidenceDraft[] = [];
  for (const l of rep.links) {
    if (l.webRisk.state !== "listed") continue;
    const domain = registrableOf(hostOf(l.url));
    const corroborated = corroboratedFor(corroboration, domain);
    items.push({
      check: "reputation.listing",
      severity: weighListing({ provider: "google-web-risk", granularity: "url", corroborated }),
      summary: bounded(
        `${plain(l.url, 120)} is listed by Google Web Risk (${l.webRisk.threatTypes.join(", ").toLowerCase().replaceAll("_", " ")}).`,
      ),
      detail: {
        ...fittedDetail({
          provider: "google-web-risk",
          granularity: "url",
          corroborated,
          cap: "suspicious",
          delist_url: DELIST_URL["google-web-risk"],
          threatTypes: l.webRisk.threatTypes,
          expiresAt: l.webRisk.expiresAt,
        }),
        // The exact identity, past fittedDetail's 255-character clip: a listed URL is itself bounded (2,048,
        // §1's strip), so two listings that share a long prefix stay distinguishable in the stored evidence.
        listed: l.url,
      } as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  }
  for (const d of rep.domains) {
    if (d.cloudflare.state !== "blocked") continue;
    const corroborated = corroboratedFor(corroboration, d.domain);
    items.push({
      check: "reputation.listing",
      severity: weighListing({ provider: "cloudflare-security-dns", granularity: "domain", corroborated }),
      summary: bounded(`${plain(d.domain, 80)} is blocked by Cloudflare's malware-blocking resolver (1.1.1.2).`),
      detail: fittedDetail({
        provider: "cloudflare-security-dns",
        listed: d.domain,
        granularity: "domain",
        corroborated,
        cap: "suspicious",
        delist_url: DELIST_URL["cloudflare-security-dns"],
        caveat: d.cloudflare.caveat,
      }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  }
  if (items.length <= MAX_REPUTATION_ITEMS) return items;
  const kept = items.slice(0, MAX_REPUTATION_ITEMS);
  const rest = items.slice(MAX_REPUTATION_ITEMS);
  const RANK = { high: 3, medium: 2, low: 1, info: 0, critical: 4 } as const;
  const strongest = rest.reduce(
    (top, i) => (RANK[i.severity] > RANK[top.severity] ? i : top),
    rest[0] as EvidenceDraft,
  );
  kept.push({
    check: "reputation.listing",
    severity: strongest.severity,
    summary: bounded(`${rest.length} more listings in this message are not listed one by one.`),
    detail: fittedDetail({
      provider: (strongest.detail.provider as string) ?? "google-web-risk",
      more: rest.length,
      entries: rest.map((i) => ({
        provider: i.detail.provider,
        listed: i.detail.listed,
        delist_url: i.detail.delist_url,
      })),
      cap: "suspicious",
    }) as EvidenceDraft["detail"],
    artefacts: [view.raw],
  });
  return kept;
}

export function counterSignalEvidence(view: CaseView): EvidenceDraft[] {
  const rep = view.reputation;
  if (!rep) return [];
  const items: EvidenceDraft[] = [];
  const own = new Set(view.tenant.trusted.own.map((d) => registrableOf(d) ?? d.toLowerCase()));
  const senderDomain = registrableOf(fromDomain(view.headers));
  // A DMARC-aligned pass for the sender: DMARC passed and an aligned identifier passed (the alignment reading).
  const alignedPass = (() => {
    const selection = trustedAuthResults(
      view.headers,
      view.tenant.receivers,
      view.tenant.headersAvailable,
      view.tenant.chains,
    );
    if (!("trusted" in selection) || !senderDomain) return false;
    const results = selection.trusted.results;
    const dmarcPassed = results.some((r) => r.method === "dmarc" && stateOf("dmarc", r) === "passed");
    if (!dmarcPassed) return false;
    const from = fromDomain(view.headers);
    return results.some((r) => {
      if (r.method === "spf") return stateOf("spf", r) === "passed" && aligned(spfIdentifier(r)?.domain ?? null, from);
      if (r.method === "dkim") return stateOf("dkim", r) === "passed" && aligned(dkimIdentifier(r), from);
      return false;
    });
  })();
  for (const { domain, wellKnown } of listedDomainsOf(rep)) {
    const add = (provider: ReputationProvider, summary: string, extra: Record<string, unknown>) =>
      items.push({
        check: "reputation.counter_signal",
        severity: "info",
        summary: bounded(summary),
        detail: fittedDetail({ provider, domain, ...extra }) as EvidenceDraft["detail"],
        artefacts: [view.raw],
      });
    if (wellKnown.state === "known")
      add(
        "majestic-million",
        `${plain(domain, 80)} is a well-known site (${plain(wellKnown.source, 40)}), which pulls against a listing.`,
        { source: wellKnown.source, date: wellKnown.date, generation: wellKnown.generation },
      );
    const age = view.domainAges?.ages.find((a) => a.domain === domain);
    if (age?.age.state === "known") {
      const days = Math.max(
        0,
        Math.floor((Date.parse(view.domainAges?.checkedAt ?? "") - Date.parse(age.age.registered)) / 86_400_000),
      );
      if (days > 3 * 365)
        add("domain-age", `${plain(domain, 80)} was registered ${days} days ago, which pulls against a listing.`, {
          registered: age.age.registered,
          days,
        });
    }
    if (alignedPass && domain === senderDomain)
      add("dmarc-aligned", `The sender's authentication passed for ${plain(domain, 80)} and aligns with it.`, {});
    if (own.has(domain)) add("trust-network", `${plain(domain, 80)} is one of your own verified domains.`, {});
  }
  if (items.length <= MAX_REPUTATION_ITEMS) return items;
  const kept = items.slice(0, MAX_REPUTATION_ITEMS);
  const rest = items.slice(MAX_REPUTATION_ITEMS);
  kept.push({
    check: "reputation.counter_signal",
    severity: "info",
    summary: bounded(`${rest.length} more counter-signals in this message are not listed one by one.`),
    detail: fittedDetail({
      provider: (rest[0]?.detail.provider as string) ?? "majestic-million",
      more: rest.length,
      entries: rest.map((i) => ({ provider: i.detail.provider, domain: i.detail.domain })),
    }) as EvidenceDraft["detail"],
    artefacts: [view.raw],
  });
  return kept;
}

// What reputation could not check, said once: never a negative answer, and the successful listings beside it stand.
export function coverageEvidence(view: CaseView): EvidenceDraft[] {
  const rep = view.reputation;
  const gaps: string[] = [];
  if (!rep) {
    // Inputs present means links or an original sender (§5 reads both); a sender-only case is covered too.
    if ((view.links?.items.length ?? 0) > 0 || (view.links?.more ?? 0) > 0 || originalSender(view) !== null)
      gaps.push("reputation was not read");
  } else {
    const webRiskOut = rep.links.filter((l) => l.webRisk.state === "not_checked").length;
    const capped = rep.links.filter((l) => l.webRisk.state === "capped").length;
    const cfOut = rep.domains.filter((d) => d.cloudflare.state === "not_checked").length;
    const listOut = rep.domains.filter(
      (d) => d.wellKnown.state === "not_loaded" || d.wellKnown.state === "not_checked",
    ).length;
    if (webRiskOut)
      gaps.push(`${webRiskOut} link${webRiskOut === 1 ? "" : "s"} could not be checked with Google Web Risk`);
    if (capped) gaps.push(`${capped} link${capped === 1 ? "" : "s"} over the day's Web Risk allowance`);
    if (cfOut) gaps.push(`${cfOut} domain${cfOut === 1 ? "" : "s"} could not be checked with Cloudflare's resolver`);
    if (listOut)
      gaps.push(`the well-known sites list could not be read for ${listOut} domain${listOut === 1 ? "" : "s"}`);
    if (rep.notLookedUp) gaps.push(`${rep.notLookedUp} more were not looked up`);
  }
  if (!gaps.length) return [];
  return [
    {
      check: "reputation.coverage",
      severity: "info",
      summary: bounded(`Reputation not fully checked: ${gaps.join("; ")}.`),
      detail: fittedDetail({ checked: false, gaps }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    },
  ];
}

const hasListing = (view: CaseView) =>
  (view.reputation?.links.some((l) => l.webRisk.state === "listed") ?? false) ||
  (view.reputation?.domains.some((d) => d.cloudflare.state === "blocked") ?? false);

export function registerReputationChecks(registry: CheckRegistry): void {
  registry.register({
    name: "reputation.listing",
    needs: [],
    timeoutMs: 1_000,
    run: listingEvidence,
    summary: (_view, items) => {
      const listed = items.filter((i) => !i.detail.more);
      return listed.length ? `${listed.length} listing${listed.length === 1 ? "" : "s"} by reputation providers` : null;
    },
    applies: (view) =>
      !view.reputation
        ? "reputation answers were not read"
        : // While coverage is incomplete the check is partial, not skipped: an all-unavailable case still says so.
          coverageEvidence(view).length
          ? null
          : !hasListing(view)
            ? "no provider listed a link or domain in this message"
            : null,
    partial: (view) => (coverageEvidence(view).length ? "some reputation answers were not checked" : null),
  });
  registry.register({
    name: "reputation.counter_signal",
    needs: [],
    timeoutMs: 1_000,
    run: counterSignalEvidence,
    applies: (view) =>
      !view.reputation
        ? "reputation answers were not read"
        : !hasListing(view)
          ? "nothing was listed, so there is nothing to set a counter-signal beside"
          : counterSignalEvidence(view).length
            ? null
            : "no counter-signal stood beside the listings",
  });
  registry.register({
    name: "reputation.coverage",
    needs: [],
    timeoutMs: 1_000,
    run: coverageEvidence,
    applies: (view) =>
      coverageEvidence(view).length
        ? null
        : !view.reputation &&
            !((view.links?.items.length ?? 0) > 0 || (view.links?.more ?? 0) > 0 || originalSender(view) !== null)
          ? "the case had no links or sender domain to look up"
          : "every reputation answer was read",
  });
}
