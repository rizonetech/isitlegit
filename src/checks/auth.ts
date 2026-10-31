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

// The domain of the original's From, when it names exactly one mailbox, with a valid domain, in exactly one From header;
// null otherwise.
export function fromDomain(headers: readonly { name: string; value: string }[]): string | null {
  const from = headers.filter((h) => h.name.trim().toLowerCase() === "from");
  if (from.length !== 1) return null;
  const mailboxes = addressParser(from[0]?.value ?? "", { flatten: true }).filter((a) => a.address);
  if (mailboxes.length !== 1) return null;
  const address = (mailboxes[0]?.address ?? "").toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 1 || at === address.length - 1) return null;
  // The whole mailbox is checked, not only what follows the last `@` (round 2): a local part is a quoted string or
  // dot-separated atoms (RFC 5322 section 3.4.1, with RFC 6532's UTF-8), and the domain a domain name as a whole (round
  // 1). `a@evil.example@bank.example` names no mailbox anyone can align with.
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return LOCAL.test(local) && asciiDomain(domain) !== null ? domain : null;
}
export const ATOM = "[\\p{L}\\p{N}\\p{M}!#$%&'*+/=?^_`{|}~-]+";
export const LOCAL = new RegExp(`^(?:${ATOM}(?:\\.${ATOM})*|"(?:[^"\\\\]|\\\\.)*")$`, "u");

const domainOf = (value: string) => {
  const v = value.trim().toLowerCase().replace(/^<|>$/g, "");
  return v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v;
};

// SPF's authenticated identifier: the MAIL FROM domain, or, only on the null path (no or empty `smtp.mailfrom`), the
// HELO identity SPF then checked (RFC 7208 section 2.4), said so.
// `alignable` is false for a HELO identity outside the null path: a result that merely omits `smtp.mailfrom` has not
// shown the reverse path was null, so only an explicitly empty one (`<>`) lets HELO stand in (RFC 7489 section 3.1.2;
// round 1).
export function spfIdentifier(r: Result): { domain: string; helo: boolean; alignable: boolean } | null {
  const given = r.props.get("smtp.mailfrom");
  const mailfrom = domainOf(given ?? "");
  if (mailfrom) return { domain: mailfrom, helo: false, alignable: true };
  const helo = domainOf(r.props.get("smtp.helo") ?? "");
  if (!helo) return null;
  const nullPath = given !== undefined && /^\s*<?\s*>?\s*$/.test(given);
  return { domain: helo, helo: true, alignable: nullPath };
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
  const id = asciiDomain(identifier);
  const own = asciiDomain(from);
  const a = id === null ? null : registrable(id);
  return a !== null && own !== null && a === registrable(own);
}

// A domain in its A-label form (`bücher.example` is `xn--bcher-kva.example`), as DMARC compares them (RFC 7489 section
// 6.6.1), by the platform's own IDNA conversion; the input as given when it is not a valid host name.
// Null for anything that is not a domain name as a whole: dot-separated labels of letters, digits, marks and hyphens. A
// URL parse alone would drop a path (`bank.example/evil.example` would become `bank.example`; round 1).
const DOMAIN =
  /^[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]*[\p{L}\p{N}\p{M}])?(?:\.[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]*[\p{L}\p{N}\p{M}])?)+$/u;
export function asciiDomain(domain: string): string | null {
  const name = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN.test(name)) return null;
  try {
    const host = new URL(`http://${name}/`).hostname;
    return /^[a-z0-9.-]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
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
    const own = from === null ? null : asciiDomain(from);
    const subdomain = own === null || registrable(own) !== own;
    if (!subdomain || !sp || sp === p) return { certain: p };
    return { either: [p, sp] };
  }
  const property = r.props.get("policy.dmarc")?.toLowerCase();
  return property ? { certain: property } : null;
}

// Plain words on one line, bounded, for a value copied from a header into a summary.
export const plain = (value: string, max = 80) =>
  // Only a bounded prefix is cleaned (four times what is kept, for the characters cleaning removes), so a value of
  // megabytes costs no more than a short one (D02 T03 §2's round 1).
  cut(
    cut(value, max * 4)
      .replace(/[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
      .trim(),
    max,
  );
// Bounds on what an item's detail copies from a header, so it stays inside the schema's 64 KiB whatever the header holds
// and is never refused and replaced by `not_checked` (round 2): the outcome and the raw message's key always survive.
const MAX_HEADER = 2_000;
const MAX_SOURCES = 8;
const MAX_COMMENT = 256;
const MAX_VALUE = 255;
const MAX_NAME = 64;
const MAX_RESULTS = 20;
// Every string and list in an item's detail bounded, wherever it came from (round 3: a 66 KB result token): the header
// excerpts to MAX_HEADER, any other string to MAX_VALUE, any list to MAX_RESULTS (MAX_SOURCES for the excerpts). One
// place for all, so a field added later cannot overflow the schema either.
// The whole detail inside the store's budget (the schema refuses more than 64 KiB, and a refused item becomes
// `not_checked`, losing its outcome; D02 T02 §3's round 1): each value bounded, then, while the whole is still over
// DETAIL_BUDGET, the optional lists (`OPTIONAL`, the context an item carries beyond its outcome) shortened from the end,
// and emptied with `trimmed: true` when that is not enough. The outcome fields and the header excerpts always stay.
const DETAIL_BUDGET = 60_000;
const OPTIONAL = ["earlier", "results", "aligned"];
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function fittedDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const fitted = boundedDetail(detail) as Record<string, unknown>;
  for (const key of OPTIONAL) {
    const list = fitted[key];
    if (!Array.isArray(list)) continue;
    while (list.length && size(fitted) > DETAIL_BUDGET) {
      list.pop();
      fitted.trimmed = true;
    }
  }
  // Then any other list a caller added, the header excerpts last, down to one excerpt (D02 T02 §4's round 1: Reply-To
  // destinations): whatever a check puts in its detail, the item is stored.
  const lists = () =>
    Object.entries(fitted)
      .filter(([key, value]) => Array.isArray(value) && value.length > (key === "headers" ? 1 : 0))
      .sort(([a], [b]) => Number(a === "headers") - Number(b === "headers"));
  while (size(fitted) > DETAIL_BUDGET) {
    const [entry] = lists();
    if (!entry) break;
    (entry[1] as unknown[]).pop();
    fitted.trimmed = true;
  }
  return fitted;
}

export function boundedDetail(value: unknown, key = ""): unknown {
  if (typeof value === "string") return clip(value, key === "headers" ? MAX_HEADER : MAX_VALUE);
  if (Array.isArray(value))
    return value.slice(0, key === "headers" ? MAX_SOURCES : MAX_RESULTS).map((v) => boundedDetail(v, key));
  if (value !== null && typeof value === "object")
    // An object's entries counted and their names clipped too (D02 T02 §3's completion review: a result with 300
    // properties).
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_RESULTS)
        .map(([k, v]) => [clip(k, MAX_NAME) ?? "", boundedDetail(v, k)]),
    );
  return value;
}

function clip(value: string | null, max = MAX_VALUE): string | null {
  return value === null ? null : cut(value, max);
}
// A text cut to `max` code points (the last an ellipsis when cut), walking only as far as it keeps: a header of
// megabytes is never expanded whole to keep its first few hundred characters (D02 T03 §2's round 1).
export function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let points = 0;
  let keep = 0;
  let end = 0;
  for (const point of value) {
    if (points === max) return `${value.slice(0, keep)}…`;
    if (points === max - 1) keep = end;
    end += point.length;
    points++;
  }
  return value;
}
// The evidence schema's limit for a summary (at most 200 characters): a long one is cut, its detail keeping every result,
// so an item is never refused and replaced by `not_checked` (round 1).
export const bounded = (summary: string) => cut(summary, 200);

// The headers the given results came from, each once, bounded: an item cites the header its result is in.
// A method the receiver did not report is explained from every header it wrote, all of which were read (completion
// review): an item always cites what it rests on.
function headersOf(trusted: Trusted, results: Result[]): string[] {
  const used = results.length
    ? trusted.sources.filter((s: Source) => s.results.some((r) => results.includes(r)))
    : trusted.sources;
  return used.slice(0, MAX_SOURCES).map((s) => clip(s.header, MAX_HEADER) ?? "");
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
    summary: bounded(summary),
    detail: fittedDetail({
      ...detail,
      receiver: trusted.kind,
      headers: headersOf(trusted, results),
    }) as EvidenceDraft["detail"],
    artefacts: [view.raw],
  };
}

const ofMethod = (trusted: Trusted, method: string) => trusted.results.filter((r) => r.method === method);
export const NO_TRUSTED_RESULTS = "no authentication results this service trusts were in the original's headers";
const trustedOf = (view: CaseView) => {
  const selection = trustedAuthResults(
    view.headers,
    view.tenant.receivers,
    view.tenant.headersAvailable,
    view.tenant.chains,
  );
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
    // Each signer with its own outcome: a pass for one never reads as a pass for another (completion review).
    // Each group by its own state, a result naming no domain as such: an unnamed pass never reads as a named signer's
    // (round 1).
    const unnamed = method === "spf" ? "a result naming no domain" : "a signature naming no signer";
    const byState = RANK.map((st) => ({
      st,
      names: results
        .map((r, i) => (stateOf(method, r) === st ? (identifiers[i] ?? unnamed) : null))
        .filter((d): d is string => d !== null)
        .filter((d, i, all) => all.indexOf(d) === i),
    })).filter((g) => g.names.length);
    const said = byState.length
      ? byState.map((g) => `${SAID[g.st]} for ${plain(g.names.join(", "), 60)}`).join(" and ")
      : SAID[state];
    return [
      item(
        view,
        trusted,
        `auth.${method}`,
        SEVERITY[state],
        `${NAMED[method]} ${said}, as your receiving system recorded.`,
        {
          state,
          results: results.slice(0, MAX_RESULTS).map((r, i) => ({
            result: r.result,
            identifier: clip(identifiers[i] ?? null),
            comment: clip(r.comment, MAX_COMMENT),
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
      {
        state,
        from: clip(from),
        policy,
        results: results
          .slice(0, MAX_RESULTS)
          .map((r) => ({ result: clip(r.result), comment: clip(r.comment, MAX_COMMENT) })),
      },
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
      .filter((r) => {
        const id = spfIdentifier(r);
        return stateOf("spf", r) === "passed" && id?.alignable === true && aligned(id.domain, from);
      })
      .map((r) => ({ method: "SPF", identifier: spfIdentifier(r)?.domain ?? null })),
    ...dkim
      .filter((r) => stateOf("dkim", r) === "passed" && aligned(dkimIdentifier(r), from))
      .map((r) => ({ method: "DKIM", identifier: dkimIdentifier(r) })),
  ];
  const detail = {
    from: clip(from),
    aligned: passing.slice(0, MAX_RESULTS).map((p) => ({ method: p.method, identifier: clip(p.identifier) })),
  };
  if (!from)
    return [
      item(
        view,
        trusted,
        "auth.alignment",
        "medium",
        "The From header names no single valid address, so alignment could not be checked.",
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
  // Without trusted results each returns nothing: skipped, never clean (D02 T01 §3).
  const applies = (view: Readonly<CaseView>) => (trustedOf(view) ? null : NO_TRUSTED_RESULTS);
  registry.register({ name: "auth.spf", needs: [], timeoutMs: 1_000, run: methodEvidence("spf"), applies });
  registry.register({ name: "auth.dkim", needs: [], timeoutMs: 1_000, run: methodEvidence("dkim"), applies });
  registry.register({ name: "auth.dmarc", needs: [], timeoutMs: 1_000, run: dmarcEvidence, applies });
  registry.register({ name: "auth.alignment", needs: [], timeoutMs: 1_000, run: alignmentEvidence, applies });
}
