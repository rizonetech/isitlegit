// ARC chain evidence (D02 T02 §3; RFC 8617). A forwarder or mailing list breaks SPF and DKIM; ARC carries the earlier
// hop's results in a sealed set. The receiver's own ARC verdict is read under §1's provenance rules, and, when it passes,
// the earlier results of the instance the receiver validated are reported as context with their sealer named, never as
// proof: they change none of §2's items.
//
// Where each receiver writes its verdict: Google in its trusted Authentication-Results (`arc=pass (i=1 spf=pass ...)`,
// the comment naming the instance it validated); Microsoft 365 inside its own ARC set, added on receipt
// (`ARC-Authentication-Results: i=2; mx.microsoft.com 1; ... arc=pass`), whose validated instance is the one below its
// own; any other receiver only in its trusted header. The receiver's boundary selects the verdict; the earlier set it
// names may sit lower, where the earlier hop wrote it.
import { parseAuthenticationResults, type Result } from "../intake/sender";
import { bounded, boundedDetail, plain } from "./auth";
import { receiverZone, trustedAuthResults } from "./auth-results";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import type { CheckRegistry } from "./registry";

// Microsoft 365's authserv-id inside its own ARC set (Microsoft Learn, "Configure trusted ARC sealers").
const MICROSOFT_ARC_ID = "mx.microsoft.com";

// An `ARC-Authentication-Results` value: `i=<n>;` and then an Authentication-Results payload (RFC 8617 section 4.1.1).
export function readArcResults(
  value: string,
): { instance: number; authservId: string | null; results: Result[] } | null {
  const match = /^\s*i\s*=\s*([0-9]{1,2})\s*;([\s\S]*)$/.exec(value);
  if (!match) return null;
  const parsed = parseAuthenticationResults(match[2] ?? "");
  return parsed ? { instance: Number(match[1]), ...parsed } : null;
}

// An `ARC-Seal`'s instance and signing domain, from its tag list (RFC 8617 section 4.1.3); null when either is missing.
export function readArcSeal(value: string): { instance: number; domain: string } | null {
  const tags = new Map(
    value.split(";").map((tag) => {
      const at = tag.indexOf("=");
      return [tag.slice(0, at).trim().toLowerCase(), tag.slice(at + 1).replace(/\s+/g, "")] as const;
    }),
  );
  const instance = /^[0-9]{1,2}$/.test(tags.get("i") ?? "") ? Number(tags.get("i")) : null;
  const domain = (tags.get("d") ?? "").toLowerCase();
  return instance !== null && domain ? { instance, domain } : null;
}

type Verdict = { result: Result; header: string; validated: number | null };

// The receiver's ARC verdict and the instance it says it validated, or null when it recorded none it can be trusted for.
export function arcVerdict(view: CaseView): Verdict | null {
  const selection = trustedAuthResults(view.headers, view.tenant.receivers, view.tenant.headersAvailable);
  if ("trusted" in selection) {
    for (const source of selection.trusted.sources) {
      const result = source.results.find((r) => r.method === "arc");
      if (!result) continue;
      const named = /(?:^|\s)i=([0-9]{1,2})(?:\s|$)/.exec(result.comment)?.[1];
      return { result, header: source.header, validated: named === undefined ? null : Number(named) };
    }
  }
  if (!view.tenant.headersAvailable) return null;
  const { top, zone } = receiverZone(view.headers, view.tenant.receivers);
  if (top !== "microsoft") return null;
  // Microsoft's own set: the topmost ARC-Authentication-Results it wrote, read as its topmost stamp is.
  for (const { name, value } of zone) {
    if (name.trim().toLowerCase() !== "arc-authentication-results") continue;
    const read = readArcResults(value);
    if (read?.authservId !== MICROSOFT_ARC_ID) continue;
    const result = read.results.find((r) => r.method === "arc");
    return result ? { result, header: value, validated: read.instance > 1 ? read.instance - 1 : null } : null;
  }
  return null;
}

// The earlier hop's set for the instance the receiver validated: exactly one ARC-Authentication-Results and one
// ARC-Seal with that instance, anywhere in the message; null when either is missing or doubled (never a guess).
function earlierSet(view: CaseView, instance: number) {
  const results = view.headers.filter(
    (h) =>
      h.name.trim().toLowerCase() === "arc-authentication-results" && readArcResults(h.value)?.instance === instance,
  );
  const seals = view.headers.filter(
    (h) => h.name.trim().toLowerCase() === "arc-seal" && readArcSeal(h.value)?.instance === instance,
  );
  if (results.length !== 1 || seals.length !== 1) return null;
  const read = readArcResults(results[0]?.value ?? "");
  const seal = readArcSeal(seals[0]?.value ?? "");
  if (!read || !seal) return null;
  return { read, sealer: seal.domain, headers: [results[0]?.value ?? "", seals[0]?.value ?? ""] };
}

const json = (r: Result) => ({ method: r.method, result: r.result, props: Object.fromEntries(r.props) });

export function arcEvidence(view: CaseView): EvidenceDraft[] {
  const verdict = arcVerdict(view);
  if (!verdict) return [];
  const outcome = verdict.result.result;
  // No chain arrived: normal for mail sent straight to the receiver (RFC 8617 section 4.4), so nothing is said.
  if (outcome === "none") return [];
  const make = (
    severity: EvidenceDraft["severity"],
    summary: string,
    detail: Record<string, unknown>,
    headers: string[],
  ) => ({
    check: "auth.arc",
    severity,
    summary: bounded(summary),
    detail: boundedDetail({ verdict: outcome, ...detail, headers }) as EvidenceDraft["detail"],
    artefacts: [view.raw],
  });
  if (outcome === "fail")
    return [
      make("medium", "ARC failed, as your receiving system recorded: the forwarded chain does not hold.", {}, [
        verdict.header,
      ]),
    ];
  if (outcome !== "pass")
    return [make("low", "ARC could not be evaluated, as your receiving system recorded.", {}, [verdict.header])];
  const set = verdict.validated === null ? null : earlierSet(view, verdict.validated);
  if (!set)
    return [
      make(
        "info",
        "ARC passed, as your receiving system recorded; the earlier hop's results are not available.",
        { instance: verdict.validated, context: "unavailable" },
        [verdict.header],
      ),
    ];
  const said = set.read.results
    .slice(0, 4)
    .map((r) => `${r.method} ${r.result}`)
    .join(", ");
  return [
    make(
      "info",
      `ARC passed: the earlier hop, sealed by ${plain(set.sealer, 60)}, recorded ${plain(said, 80) || "no results"}. Context, not proof.`,
      { instance: verdict.validated, sealer: set.sealer, earlier: set.read.results.map(json) },
      [verdict.header, ...set.headers],
    ),
  ];
}

// After §2's checks: the chain is context for what they say, never a change to it.
export function registerArcCheck(registry: CheckRegistry): void {
  registry.register({ name: "auth.arc", needs: [], timeoutMs: 1_000, run: arcEvidence });
}
