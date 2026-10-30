// SPF, DKIM and DMARC evidence, and whether a passing identifier aligns with the visible From domain (D02 T02 §2;
// RFC 7489 section 3.1, relaxed: by registrable domain). Each check reads only what §1's selector trusts, the headers the
// organisation's own receiving system wrote, and returns nothing when it trusts none (`auth.results` says why).
//
// A method's result is one of four states, never two: passed, failed, inconclusive (an error, or a result that decides
// nothing) or unavailable (not evaluated, nothing published). An error is never read as a failure.
import { addressParser } from "postal-mime";
import { registrable } from "../auth/senders";
import type { Result } from "../intake/sender";
import { type Source, type Trusted, trustedAuthResults } from "./auth-results";
import type { CaseView } from "./case-view";
import type { EvidenceDraft, SEVERITIES } from "./evidence";
import type { CheckRegistry } from "./registry";

type Severity = (typeof SEVERITIES)[number];

export type State = "passed" | "failed" | "inconclusive" | "unavailable";

const STATES: Record<"spf" | "dkim" | "dmarc", Record<string, State>> = {
  spf: { pass: "passed", fail: "failed", softfail: "failed", none: "unavailable" },
  dkim: { pass: "passed", fail: "failed", none: "unavailable" },
  // Microsoft's `bestguesspass`: the domain publishes no DMARC record (Microsoft Learn, "Anti-spam message headers").
  dmarc: { pass: "passed", fail: "failed", none: "unavailable", bestguesspass: "unavailable" },
};

// One result's state; any result a method does not name above (`temperror`, `permerror`, `neutral`, `policy`, a value
// no RFC defines) decides nothing. Microsoft marks a DMARC evaluation that erred by its `action`.
export function stateOf(method: "spf" | "dkim" | "dmarc", r: Result): State {
  const state = STATES[method][r.result] ?? "inconclusive";
  if (method === "dmarc" && state === "failed" && /^(?:temp|perm)error$/.test(r.props.get("action") ?? ""))
    return "inconclusive";
  return state;
}

// The state of a method across its results: any pass passes (one good signature among several), then any failure, then
// any error; a method not reported is unavailable.
const RANK: State[] = ["passed", "failed", "inconclusive", "unavailable"];
function overall(states: State[]): State {
  return RANK.find((s) => states.includes(s)) ?? "unavailable";
}

// The domain of the original's From, when it names exactly one mailbox in exactly one From header; null otherwise.
export function fromDomain(headers: readonly { name: string; value: string }[]): string | null {
  const from = headers.filter((h) => h.name.trim().toLowerCase() === "from");
  if (from.length !== 1) return null;
  const mailboxes = addressParser(from[0]?.value ?? "", { flatten: true }).filter((a) => a.address);
  if (mailboxes.length !== 1) return null;
  const address = (mailboxes[0]?.address ?? "").toLowerCase();
  const at = address.lastIndexOf("@");
  return at > 0 && at < address.length - 1 ? address.slice(at + 1) : null;
}

const domainOf = (value: string) => {
  const v = value.trim().toLowerCase().replace(/^<|>$/g, "");
  return v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v;
};

// SPF's authenticated identifier: the MAIL FROM domain, or, only on the null path (no or empty `smtp.mailfrom`), the
// HELO identity SPF then checked (RFC 7208 section 2.4), said so.
export function spfIdentifier(r: Result): { domain: string; helo: boolean } | null {
  const mailfrom = domainOf(r.props.get("smtp.mailfrom") ?? "");
  if (mailfrom) return { domain: mailfrom, helo: false };
  const helo = domainOf(r.props.get("smtp.helo") ?? "");
  return helo ? { domain: helo, helo: true } : null;
}

// DKIM's: the signing domain `d`; when only `i` is given, its domain, which RFC 6376 section 3.5 requires to be `d` or
// under it, so its registrable domain is `d`'s. A signature naming neither has none.
export function dkimIdentifier(r: Result): string | null {
  const d = domainOf(r.props.get("header.d") ?? "");
  if (d) return d;
  const i = r.props.get("header.i") ?? "";
  return i.includes("@") ? domainOf(i) || null : null;
}

// Relaxed alignment: the identifier and the From domain share a registrable domain (a subdomain aligns; an unrelated
// domain, or one compared by full host name, does not).
export function aligned(identifier: string | null, from: string | null): boolean {
  if (!identifier || !from) return false;
  const a = registrable(identifier);
  return a !== null && a === registrable(from);
}

type Enforcing = "reject" | "quarantine";
const enforcing = (p: string | undefined): p is Enforcing => p === "reject" || p === "quarantine";

// The DMARC policy that applies to this From, from the receiver's own record of it: Microsoft's `action`, the policy it
// applied to this message; Google's comment (`p=REJECT sp=REJECT dis=NONE`), where `p` applies to the organisational
// domain itself and, for a subdomain, the record may be the subdomain's own (`p`) or the organisation's (`sp`), so
// both are kept when they differ; a `policy.dmarc` property. Null when the receiver recorded none.
export type Policy = { certain: string } | { either: [string, string] } | null;
export function policyOf(r: Result, from: string | null): Policy {
  const action = (r.props.get("action") ?? "").toLowerCase();
  const applied = { reject: "reject", oreject: "reject", "pct.reject": "reject", quarantine: "quarantine" } as const;
  const named = (applied as Record<string, string>)[action] ?? (action === "pct.quarantine" ? "quarantine" : undefined);
  if (named) return { certain: named };
  if (action === "none") return { certain: "none" };
  const p = /(?:^|\s)p=([a-z]+)/i.exec(r.comment)?.[1]?.toLowerCase();
  const sp = /(?:^|\s)sp=([a-z]+)/i.exec(r.comment)?.[1]?.toLowerCase();
  if (p) {
    const subdomain = from !== null && registrable(from) !== from;
    if (!subdomain || !sp || sp === p) return { certain: p };
    return { either: [p, sp] };
  }
  const property = r.props.get("policy.dmarc")?.toLowerCase();
  return property ? { certain: property } : null;
}

// Plain words on one line, bounded, for a value copied from a header into a summary.
const plain = (value: string, max = 80) => {
  const text = Array.from(value.replace(/[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim());
  return text.length <= max ? text.join("") : `${text.slice(0, max - 1).join("")}…`;
};
const MAX_HEADER = 2_000;

// The headers the given results came from, each once, bounded: an item cites the header its result is in.
function headersOf(trusted: Trusted, results: Result[]): string[] {
  const used = trusted.sources.filter((s: Source) => s.results.some((r) => results.includes(r)));
  return used.map((s) => Array.from(s.header).slice(0, MAX_HEADER).join(""));
}

function item(
  view: CaseView,
  trusted: Trusted,
  check: string,
  severity: Severity,
  summary: string,
  detail: Record<string, unknown>,
  results: Result[],
): EvidenceDraft {
  return {
    check,
    severity,
    summary,
    detail: { ...detail, receiver: trusted.kind, headers: headersOf(trusted, results) } as EvidenceDraft["detail"],
    artefacts: [view.raw],
  };
}

const ofMethod = (trusted: Trusted, method: string) => trusted.results.filter((r) => r.method === method);
const trustedOf = (view: CaseView) => {
  const selection = trustedAuthResults(view.headers, view.tenant.receivers, view.tenant.headersAvailable);
  return "trusted" in selection ? selection.trusted : null;
};

const NAMED: Record<"spf" | "dkim", string> = { spf: "SPF", dkim: "DKIM" };
const SEVERITY: Record<State, Severity> = {
  passed: "info",
  unavailable: "info",
  inconclusive: "low",
  failed: "medium",
};
const SAID: Record<State, string> = {
  passed: "passed",
  failed: "failed",
  inconclusive: "could not be evaluated",
  unavailable: "was not available",
};

function methodEvidence(method: "spf" | "dkim") {
  return (view: CaseView): EvidenceDraft[] => {
    const trusted = trustedOf(view);
    if (!trusted) return [];
    const results = ofMethod(trusted, method);
    const state = overall(results.map((r) => stateOf(method, r)));
    const identifiers = results.map((r) => (method === "spf" ? (spfIdentifier(r)?.domain ?? null) : dkimIdentifier(r)));
    const named = identifiers.filter((d): d is string => d !== null);
    const forWhom = named.length ? ` for ${plain(named.join(", "), 80)}` : "";
    return [
      item(
        view,
        trusted,
        `auth.${method}`,
        SEVERITY[state],
        `${NAMED[method]} ${SAID[state]}${forWhom}, as your receiving system recorded.`,
        {
          state,
          results: results.map((r, i) => ({
            result: r.result,
            identifier: identifiers[i] ?? null,
            comment: r.comment,
          })),
          ...(method === "spf" ? { helo: results.some((r) => spfIdentifier(r)?.helo === true) } : {}),
        },
        results,
      ),
    ];
  };
}

export function dmarcEvidence(view: CaseView): EvidenceDraft[] {
  const trusted = trustedOf(view);
  if (!trusted) return [];
  const results = ofMethod(trusted, "dmarc");
  const state = overall(results.map((r) => stateOf("dmarc", r)));
  const from = fromDomain(view.headers);
  const failed = results.find((r) => stateOf("dmarc", r) === "failed");
  const policy = failed ? policyOf(failed, from) : null;
  let severity = SEVERITY[state];
  let why = "";
  if (state === "failed") {
    const enforced =
      policy !== null &&
      ("certain" in policy ? enforcing(policy.certain) : enforcing(policy.either[0]) && enforcing(policy.either[1]));
    severity = enforced ? "high" : "medium";
    why =
      policy === null
        ? " Its policy was not recorded."
        : "certain" in policy
          ? ` Its policy is ${plain(policy.certain, 20)}.`
          : ` Its policy is ${plain(policy.either[0], 20)} or ${plain(policy.either[1], 20)} for this subdomain.`;
  }
  const domain = from ? ` for ${plain(from, 80)}` : "";
  return [
    item(
      view,
      trusted,
      "auth.dmarc",
      severity,
      `DMARC ${SAID[state]}${domain}, as your receiving system recorded.${why}`,
      { state, from, policy, results: results.map((r) => ({ result: r.result, comment: r.comment })) },
      results,
    ),
  ];
}

export function alignmentEvidence(view: CaseView): EvidenceDraft[] {
  const trusted = trustedOf(view);
  if (!trusted) return [];
  const from = fromDomain(view.headers);
  const spf = ofMethod(trusted, "spf");
  const dkim = ofMethod(trusted, "dkim");
  const considered = [...spf, ...dkim];
  const passing = [
    ...spf
      .filter((r) => stateOf("spf", r) === "passed" && aligned(spfIdentifier(r)?.domain ?? null, from))
      .map((r) => ({ method: "SPF", identifier: spfIdentifier(r)?.domain ?? null })),
    ...dkim
      .filter((r) => stateOf("dkim", r) === "passed" && aligned(dkimIdentifier(r), from))
      .map((r) => ({ method: "DKIM", identifier: dkimIdentifier(r) })),
  ];
  const detail = { from, aligned: passing };
  if (!from)
    return [
      item(
        view,
        trusted,
        "auth.alignment",
        "medium",
        "The From header names no single mailbox, so alignment could not be checked.",
        detail,
        considered,
      ),
    ];
  const domain = plain(from, 80);
  if (passing.length)
    return [
      item(
        view,
        trusted,
        "auth.alignment",
        "info",
        `${passing
          .map((p) => p.method)
          .filter((m, i, all) => all.indexOf(m) === i)
          .join(" and ")} passed for ${domain}'s own domain.`,
        detail,
        considered,
      ),
    ];
  const states = [...spf.map((r) => stateOf("spf", r)), ...dkim.map((r) => stateOf("dkim", r))];
  if (states.includes("inconclusive"))
    return [
      item(
        view,
        trusted,
        "auth.alignment",
        "medium",
        `Whether ${domain} sent this could not be confirmed: an authentication check could not be evaluated.`,
        detail,
        considered,
      ),
    ];
  return [
    item(
      view,
      trusted,
      "auth.alignment",
      "high",
      `Neither SPF nor DKIM passed for ${domain}, the domain the email claims to be from.`,
      detail,
      considered,
    ),
  ];
}

// After `auth.results`, so its explanation comes first; none needs `headers`: each returns nothing when it trusts none.
export function registerAuthChecks(registry: CheckRegistry): void {
  registry.register({ name: "auth.spf", needs: [], timeoutMs: 1_000, run: methodEvidence("spf") });
  registry.register({ name: "auth.dkim", needs: [], timeoutMs: 1_000, run: methodEvidence("dkim") });
  registry.register({ name: "auth.dmarc", needs: [], timeoutMs: 1_000, run: dmarcEvidence });
  registry.register({ name: "auth.alignment", needs: [], timeoutMs: 1_000, run: alignmentEvidence });
}
