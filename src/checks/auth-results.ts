// Trusted Authentication-Results (D02 T02 §1; spec 4.3). Anyone can write an Authentication-Results header into a
// message, and a forged one can name the receiver's own authserv-id (RFC 8601 section 7.1), so a provider match proves
// nothing on its own. Trust is by the receiving boundary: headers are newest first, and the receiver's own `Received`
// headers sit at the top. Reading down, the receiver's zone runs until the first `Received` another host wrote; only a
// header inside it, matching the receiver, was written after the receiver took the message in. The topmost such header
// is the receiver's (each receipt writes one); one from the sender sits below the boundary and is never read.
//
// The selector is pure and shared: `auth.results` reports what it found, and the alignment check (§2) calls it itself,
// since checks run side by side on one frozen view and never read each other's output.
import type { Receiver, ReceiverKind } from "../auth/receivers";
import { parseAuthenticationResults, type Result } from "../intake/sender";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import type { CheckRegistry } from "./registry";

export type Untrusted =
  | "no-headers" // the original's headers did not come with it (an inline forward, a file without them)
  | "unknown-receiver" // the organisation's receiving system is not known yet
  | "no-boundary" // the top of the message was not written by the receiver: where it was received is not known
  | "ambiguous" // results from two receiving systems sit inside the zone: which is genuine cannot be told
  | "none-in-zone"; // the receiver's zone holds no Authentication-Results header it wrote

export type Trusted = { kind: ReceiverKind; authservId: string | null; results: Result[] };

export type Selection = { trusted: Trusted } | { untrusted: Untrusted };

const PROVIDERS: Record<ReceiverKind, string> = {
  microsoft: "Microsoft 365",
  google: "Google",
  other: "your receiving system",
};

// `*.example.com` covers example.com and every host under it; any other pattern is one host.
function covers(pattern: string, host: string): boolean {
  if (!pattern.startsWith("*.")) return host === pattern;
  const base = pattern.slice(2);
  return host === base || host.endsWith(`.${base}`);
}

// The host a `Received` header names after `by` (who received it) or `from` (who handed it over), lowercased, comments
// removed; null when it names none.
function receivedHost(value: string, side: "by" | "from"): string | null {
  const plain = value.replace(/\([^()]*\)/g, " ");
  const host = new RegExp(`(?:^|\\s)${side}\\s+([^\\s;]+)`, "i").exec(plain)?.[1];
  return host ? host.replace(/\.$/, "").toLowerCase() : null;
}
export const receivedBy = (value: string) => receivedHost(value, "by");

// An address literal (`[203.0.113.1]`, `[IPv6:...]`, or the bare IPv6 Gmail's internal hops write): a hop inside a
// receiver that names no host, so it neither opens nor ends the zone.
function literal(host: string): boolean {
  return host.startsWith("[") || host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

// The kinds of receiver an Authentication-Results header could be from. Microsoft 365 writes no authserv-id and is
// known by `compauth`, its own method; an authserv-id is matched to the receivers' patterns.
function kindsOf(parsed: { authservId: string | null; results: Result[] }, receivers: Receiver[]): Set<ReceiverKind> {
  const kinds = new Set<ReceiverKind>();
  for (const r of receivers) {
    if (parsed.authservId === null) {
      if (r.kind === "microsoft" && parsed.results.some((x) => x.method === "compauth")) kinds.add(r.kind);
    } else if (covers(r.pattern, parsed.authservId)) kinds.add(r.kind);
  }
  return kinds;
}

// Microsoft 365 and Google stamp every message they receive (Microsoft Learn: "When an email is received in Microsoft
// 365, the service adds an Authentication-Results header"), writing it just under their own entry hop, as Gmail does;
// any other receiver promises no stamp (completion review).
const STAMPS_EVERY_MESSAGE: ReadonlySet<ReceiverKind> = new Set(["microsoft", "google"]);

// The receiver's zone ends at its entry hop: reading down, the first `Received` a receiver wrote (`by` one of its
// hosts) whose `from` is not one of them, where the message came in from outside. Hops below it, and every header
// there, came with the message, whatever host they name, so a sender's forged hop cannot move the boundary (round 1).
// Trusted are the headers above the entry hop that match a receiver, all of them (a receiver may write several, RFC
// 8601 appendix B.4); and, only when the entry hop is Microsoft 365's or Google's and none of theirs sits above it, the
// first of theirs in the block they write just under it, before the next `Received`. One receiver's stamp never vouches
// for a header under another receiver's hop.
export function trustedAuthResults(
  headers: readonly { name: string; value: string }[],
  receivers: readonly Receiver[],
  headersAvailable = true,
): Selection {
  if (!headersAvailable || headers.length === 0) return { untrusted: "no-headers" };
  if (receivers.length === 0) return { untrusted: "unknown-receiver" };
  const ours = (host: string | null) => (host === null ? undefined : receivers.find((r) => covers(r.pattern, host)));
  const results = (value: string) => {
    const parsed = parseAuthenticationResults(value);
    return parsed ? { parsed, kinds: kindsOf(parsed, [...receivers]) } : null;
  };
  let entry = -1;
  let entryKind: ReceiverKind | undefined;
  const above: { kinds: Set<ReceiverKind>; parsed: { authservId: string | null; results: Result[] } }[] = [];
  for (const [at, { name, value }] of headers.entries()) {
    const field = name.trim().toLowerCase();
    if (field === "received") {
      const by = receivedBy(value);
      if (by === null || literal(by)) continue;
      const receiver = ours(by);
      if (!receiver) break; // a host outside the receivers wrote this above any entry: no boundary
      const from = receivedHost(value, "from");
      if (from !== null && !literal(from) && ours(from)) continue; // a hop inside the receiver
      entry = at;
      entryKind = receiver.kind;
      break;
    }
    if (field !== "authentication-results") continue;
    const read = results(value);
    if (read && read.kinds.size > 0) above.push(read);
  }
  if (entry < 0 || entryKind === undefined) return { untrusted: "no-boundary" };
  const trusted = [...above];
  if (STAMPS_EVERY_MESSAGE.has(entryKind) && !above.some((a) => a.kinds.has(entryKind))) {
    for (const { name, value } of headers.slice(entry + 1)) {
      const field = name.trim().toLowerCase();
      if (field === "received") break;
      if (field !== "authentication-results") continue;
      const read = results(value);
      if (read?.kinds.has(entryKind)) {
        trusted.push({ kinds: new Set([entryKind]), parsed: read.parsed });
        break;
      }
    }
  }
  const first = trusted[0];
  if (!first) return { untrusted: "none-in-zone" };
  const kinds = new Set(trusted.flatMap((t) => [...t.kinds]));
  const [kind] = kinds;
  if (kinds.size > 1 || kind === undefined) return { untrusted: "ambiguous" };
  return {
    trusted: { kind, authservId: first.parsed.authservId, results: trusted.flatMap((t) => t.parsed.results) },
  };
}

const UNTRUSTED: Record<Untrusted, string> = {
  "no-headers":
    "The original email's headers did not come with it, so how its sender was authenticated could not be read.",
  "unknown-receiver":
    "Your organisation's receiving system is not known yet, so no Authentication-Results header could be trusted.",
  "no-boundary":
    "The top of the original email was not written by your receiving system, so its Authentication-Results headers are not trusted.",
  ambiguous:
    "Results from more than one receiving system sit where your receiving system took the email in, so none is trusted.",
  "none-in-zone":
    "Your receiving system added no Authentication-Results header to this email; any lower one may be the sender's and is not trusted.",
};

// Bounds on what the item carries: a header with more results, or longer values, than any receiver writes is cut.
const MAX_RESULTS = 50;
const MAX_VALUE = 256;

export function authResultsEvidence(view: CaseView): EvidenceDraft[] {
  const fromFile = view.tenant.channel === "upload";
  const selection = trustedAuthResults(view.headers, view.tenant.receivers, view.tenant.headersAvailable);
  if ("untrusted" in selection) {
    return [
      {
        check: "auth.results",
        severity: "info",
        summary: UNTRUSTED[selection.untrusted],
        detail: { trusted: false, reason: selection.untrusted, fromFile },
        artefacts: [],
      },
    ];
  }
  const { kind, authservId, results } = selection.trusted;
  const kept = results.slice(0, MAX_RESULTS).map((r) => ({
    method: r.method.slice(0, MAX_VALUE),
    result: r.result.slice(0, MAX_VALUE),
    props: Object.fromEntries(
      [...r.props].slice(0, MAX_RESULTS).map(([k, v]) => [k.slice(0, MAX_VALUE), v.slice(0, MAX_VALUE)]),
    ),
  }));
  const said = kept
    .slice(0, 4)
    .map((r) => `${r.method} ${r.result}`)
    .join(", ");
  const who = kind === "other" ? "Your receiving system" : `${PROVIDERS[kind]}, your receiving system,`;
  const where = fromFile ? " (as read from the uploaded file, which cannot be confirmed)" : "";
  const summary = `${who} recorded ${said || "no results"}${where}.`.replace(/[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  return [
    {
      check: "auth.results",
      severity: "info",
      summary: Array.from(summary).length <= 200 ? summary : `${Array.from(summary).slice(0, 199).join("")}.`,
      detail: { trusted: true, receiver: kind, authservId, fromFile, results: kept },
      artefacts: [],
    },
  ];
}

// No `needs`: the check runs when the headers are missing too, to say so (a check needing `headers` would be skipped).
export function registerAuthResultsCheck(registry: CheckRegistry): void {
  registry.register({ name: "auth.results", needs: [], timeoutMs: 1_000, run: authResultsEvidence });
}
