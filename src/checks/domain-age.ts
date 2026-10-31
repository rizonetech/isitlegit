// Domain age (D02 T03 §4; spec 4.3 Domains): a domain registered in the last 30 days is a strong phishing signal, under
// 90 days a weaker one. The registration dates come from RDAP (WHOIS for `.za`, D02 T03 §9) through the view (`domainAges`, read by the `checks`
// step); an age that could not be read is said to be not checked, and when none could be read the check fails and the
// runner writes `not_checked` naming it, never a guess.
import { bounded, fittedDetail, plain } from "./auth";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
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
  for (const { domain, fields, age } of read.ages) {
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

export function registerDomainAgeCheck(registry: CheckRegistry): void {
  registry.register({ name: "domain.age", needs: [], timeoutMs: 1_000, run: domainAgeEvidence });
}
