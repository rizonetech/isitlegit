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

// The host a `Received` header says received the message (`by <host>`), lowercased, comments removed; null when none.
export function receivedBy(value: string): string | null {
  const plain = value.replace(/\([^()]*\)/g, " ");
  const by = /(?:^|\s)by\s+([^\s;]+)/i.exec(plain)?.[1];
  return by ? by.replace(/\.$/, "").toLowerCase() : null;
}

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

export function trustedAuthResults(
  headers: readonly { name: string; value: string }[],
  receivers: readonly Receiver[],
  headersAvailable = true,
): Selection {
  if (!headersAvailable || headers.length === 0) return { untrusted: "no-headers" };
  if (receivers.length === 0) return { untrusted: "unknown-receiver" };
  let opened = false;
  const found: { kinds: Set<ReceiverKind>; trusted: Trusted }[] = [];
  for (const { name, value } of headers) {
    const field = name.trim().toLowerCase();
    if (field === "received") {
      const host = receivedBy(value);
      if (host === null || literal(host)) continue;
      if (receivers.some((r) => covers(r.pattern, host))) {
        opened = true;
        continue;
      }
      break; // a host outside the receiver wrote this: everything below came with the message
    }
    if (field !== "authentication-results") continue;
    const parsed = parseAuthenticationResults(value);
    if (!parsed) continue;
    const kinds = kindsOf(parsed, [...receivers]);
    const [kind] = kinds;
    if (kind !== undefined)
      found.push({ kinds, trusted: { kind, authservId: parsed.authservId, results: parsed.results } });
  }
  if (!opened) return { untrusted: "no-boundary" };
  const first = found[0];
  if (!first) return { untrusted: "none-in-zone" };
  const kinds = new Set(found.flatMap((f) => [...f.kinds]));
  if (kinds.size > 1) return { untrusted: "ambiguous" };
  return { trusted: first.trusted };
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
