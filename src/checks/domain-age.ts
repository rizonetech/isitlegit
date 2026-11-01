// Domain age (D02 T03 §4; spec 4.3 Domains): a domain registered in the last 30 days is a strong phishing signal, under
// 90 days a weaker one. The registration dates come from RDAP (WHOIS for `.za`, D02 T03 §9) through the view (`domainAges`, read by the `checks`
// step); an age that could not be read is said to be not checked, and when none could be read the check fails and the
// runner writes `not_checked` naming it, never a guess.
import { bounded, fittedDetail, plain } from "./auth";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import { agoOf, counted } from "./outcome-summary";
import type { CheckRegistry } from "./registry";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAMED = 10;

export class RdapUnavailable extends Error {
  override name = "RdapUnavailable";
}

const REASON: Record<string, string> = {
  "no-service": "no registration service (RDAP) answers for this ending",
  unavailable: "the registration service did not answer",
  malformed: "the registration service's answer could not be read",
  "no-date": "the registration service gave no registration date",
  // A `.za` name ZACR's WHOIS has no record of (D02 T03 §9).
  "not-registered": "the registry has no record of it",
};

// Each reason once, with the domains it applies to, so a mixed failure says what happened to each (completion review).
function byReason(unchecked: { domain: string; reason: string }[]): string {
  const groups = new Map<string, string[]>();
  for (const u of unchecked) groups.set(u.reason, [...(groups.get(u.reason) ?? []), u.domain]);
  return [...groups].map(([reason, domains]) => `${domains.join(", ")} (${REASON[reason] ?? reason})`).join("; ");
}

export function domainAgeEvidence(view: CaseView): EvidenceDraft[] {
  const read = view.domainAges;
  if (!read || (!read.ages.length && !read.unread.length)) return [];
  const now = Date.parse(read.checkedAt);
  const items: EvidenceDraft[] = [];
  const unchecked: { domain: string; reason: string }[] = [];
  for (const { domain, fields, age, found, foundMore } of read.ages) {
    if (age.state !== "known") {
      unchecked.push({ domain, reason: age.reason });
      continue;
    }
    const days = Math.max(0, Math.floor((now - Date.parse(age.registered)) / DAY_MS));
    const severity = days < 30 ? "high" : days < 90 ? "medium" : "info";
    items.push({
      check: "domain.age",
      severity,
      summary: bounded(
        `${plain(domain, 80)} (${fields.join(", ")}) was registered ${days} day${days === 1 ? "" : "s"} ago, on ${age.registered.slice(0, 10)}.`,
      ),
      detail: fittedDetail({
        domain,
        registered: age.registered,
        days,
        server: age.server,
        ...(age.retrievedAt ? { retrievedAt: age.retrievedAt } : {}),
        ...(age.excerpt ? { excerpt: age.excerpt } : {}),
        fields,
        ...(found ? { found } : {}),
        ...(foundMore ? { foundMore } : {}),
      }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  }
  // Every lookup failed for want of an answer: the check could not run, which the runner says (not_checked).
  if (!items.length && unchecked.length && unchecked.every((u) => u.reason === "unavailable"))
    throw new RdapUnavailable("no registration service answered");
  if (unchecked.length || read.unread.length)
    items.push({
      check: "domain.age",
      severity: "info",
      summary: bounded(
        unchecked.length
          ? `Ages not checked: ${plain(byReason(unchecked), 170)}.`
          : `${read.unread.length} more domains' ages were not checked.`,
      ),
      // Names bounded, counts exact, so a message naming many domains keeps the ages found (plan review).
      detail: fittedDetail({
        checked: false,
        unchecked: unchecked.slice(0, MAX_NAMED),
        uncheckedCount: unchecked.length,
        unread: read.unread.slice(0, MAX_NAMED),
        unreadCount: read.unread.length,
      }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  return items;
}

// How many domains were dated and how young the youngest is (D02 T01 §7): "2 domains, the youngest registered 3 years
// ago".
export function domainAgeSummary(view: Readonly<CaseView>): string | null {
  const ages = view.domainAges;
  if (!ages?.ages.length) return null;
  const known = ages.ages.flatMap((a) => (a.age.state === "known" ? [a.age.registered] : []));
  const youngest = known.length ? known.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
  const ago = youngest ? agoOf(youngest, ages.checkedAt) : null;
  const lead = counted(ages.ages.length, "domain", "domains");
  if (!ago) return `${lead}, no registration date read`;
  return ages.ages.length === 1 ? `${lead}, registered ${ago} ago` : `${lead}, the youngest registered ${ago} ago`;
}

// Whether link or followed-page discovery stopped short, so domains that needed their age read may be undiscovered
// (D02 T03 §10, completion review): the check must not skip as if nothing needed reading.
export function ageDiscoveryIncomplete(view: CaseView): boolean {
  if ((view.links?.unread.length ?? 0) > 0 || (view.links?.more ?? 0) > 0) return true;
  if ((view.expansions?.skipped.length ?? 0) > 0) return true;
  if ((view.links?.items.length ?? 0) > 0 && !view.expansions) return true;
  return (view.expansions?.items ?? []).some((e) => e.outcome !== "done");
}

export function registerDomainAgeCheck(registry: CheckRegistry): void {
  registry.register({
    name: "domain.age",
    needs: [],
    timeoutMs: 1_000,
    run: domainAgeEvidence,
    summary: domainAgeSummary,
    applies: (view) =>
      !view.domainAges
        ? "registration dates were not looked up"
        : !view.domainAges.ages.length && !view.domainAges.unread.length && !ageDiscoveryIncomplete(view)
          ? "no domain in this case needed its age read"
          : null,
    partial: (view) => {
      const read = view.domainAges;
      if (!read) return null;
      const n = read.ages.filter((a) => a.age.state !== "known").length + read.unread.length;
      if (n) return `${n} domain${n === 1 ? "" : "s"}' age${n === 1 ? "" : "s"} could not be read`;
      if (ageDiscoveryIncomplete(view)) {
        if ((view.links?.unread.length ?? 0) > 0 || (view.links?.more ?? 0) > 0) return "some links were not read";
        if ((view.expansions?.skipped.length ?? 0) > 0) return "some followed pages were not read";
        if ((view.links?.items.length ?? 0) > 0 && !view.expansions) return "the links were not followed";
        return "some followed pages did not finish";
      }
      return null;
    },
  });
}
