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

// What the receiver recorded: its results, and each header they came from with its own results (`sources`), so an item
// cites the header its result is in, never a neighbour (D02 T02 §2).
export type Source = { header: string; results: Result[] };
export type Trusted = { kind: ReceiverKind; authservId: string | null; results: Result[]; sources: Source[] };

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
// Only `by` is read: the `from` name is the sender's greeting (round 2).
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

// Microsoft 365 and Google stamp every message they receive (Microsoft Learn: "When an email is received in Microsoft
// 365, the service adds an Authentication-Results header"), and a stamp written on receipt sits above every header the
// sender could have supplied, so the topmost of theirs is theirs, whatever the hops below claim. Any other receiver
// promises no stamp (completion review).
const STAMPS_EVERY_MESSAGE: ReadonlySet<ReceiverKind> = new Set(["microsoft", "google"]);

type Read = { kinds: Set<ReceiverKind>; header: string; parsed: { authservId: string | null; results: Result[] } };
const only = (kind: ReceiverKind, read: Read): Trusted => ({
  kind,
  ...read.parsed,
  sources: [{ header: read.header, results: read.parsed.results }],
});

// The receiver whose hop is nearest the top took the message in last, so its rules apply.
//   Microsoft 365 or Google: the topmost header of theirs, read down to the first hop another host wrote; a header of
//   theirs above their first hop is that topmost one (round 3).
//   Another receiver: only headers above the message's topmost `Received`, which must be the receiver's own. Nothing
//   but the receiver writes above its final hop, so no hop below has to be judged: a greeting name is the sender's
//   (round 2) and a private address can be a proxy's (round 4). A receiver that writes its header lower down is not
//   trusted until its receiving chain is verified (D02 T02 §6). All its headers there count (RFC 8601 appendix B.4);
//   beside another receiver's they are ambiguous.
export function trustedAuthResults(
  headers: readonly { name: string; value: string }[],
  receivers: readonly Receiver[],
  headersAvailable = true,
): Selection {
  if (!headersAvailable || headers.length === 0) return { untrusted: "no-headers" };
  if (receivers.length === 0) return { untrusted: "unknown-receiver" };
  const ours = (host: string | null) => (host === null ? undefined : receivers.find((r) => covers(r.pattern, host)));
  const read = (value: string): Read | null => {
    const parsed = parseAuthenticationResults(value);
    return parsed ? { parsed, header: value, kinds: kindsOf(parsed, [...receivers]) } : null;
  };
  const isReceived = (name: string) => name.trim().toLowerCase() === "received";
  const isResults = (name: string) => name.trim().toLowerCase() === "authentication-results";
  // The nearest receiver hop to the top, address-literal hops (a provider's internal ones) passed over.
  let top: ReceiverKind | undefined;
  for (const { name, value } of headers) {
    if (!isReceived(name)) continue;
    const by = receivedBy(value);
    if (by === null || literal(by)) continue;
    top = ours(by)?.kind;
    break;
  }
  if (top === undefined) return { untrusted: "no-boundary" };
  if (STAMPS_EVERY_MESSAGE.has(top)) {
    for (const { name, value } of headers) {
      if (isReceived(name)) {
        const by = receivedBy(value);
        if (by !== null && !literal(by) && !ours(by)) break; // another host wrote this: the rest came with the message
        continue;
      }
      if (!isResults(name)) continue;
      const found = read(value);
      if (found?.kinds.has(top)) return { trusted: only(top, found) };
    }
    return { untrusted: "none-in-zone" };
  }
  const topmost = headers.find((h) => isReceived(h.name));
  const by = topmost ? receivedBy(topmost.value) : null;
  if (!topmost || by === null || literal(by) || !ours(by)) return { untrusted: "no-boundary" };
  const above: Read[] = [];
  for (const { name, value } of headers.slice(0, headers.indexOf(topmost))) {
    if (!isResults(name)) continue;
    const found = read(value);
    if (found && found.kinds.size > 0) above.push(found);
  }
  const first = above[0];
  if (!first) return { untrusted: "none-in-zone" };
  const kinds = new Set(above.flatMap((a) => [...a.kinds]));
  const [kind] = kinds;
  if (kinds.size > 1 || kind === undefined) return { untrusted: "ambiguous" };
  return {
    trusted: {
      kind,
      authservId: first.parsed.authservId,
      results: above.flatMap((a) => a.parsed.results),
      sources: above.map((a) => ({ header: a.header, results: a.parsed.results })),
    },
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
