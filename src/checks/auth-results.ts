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
// 365, the service adds an Authentication-Results header"), and a stamp written on receipt sits above every header the
// sender could have supplied, so the topmost of theirs is theirs, whatever the hops below claim. Any other receiver
// promises no stamp (completion review).
const STAMPS_EVERY_MESSAGE: ReadonlySet<ReceiverKind> = new Set(["microsoft", "google"]);

// The address the receiver itself saw the previous hop connect from, in the `Received` header's TCP information
// (`from helo (rdns [203.0.113.5])`, or `(203.0.113.5)`), never the greeting name, which the sender chooses (RFC 5321
// section 4.4; round 2). Null when the header records none.
function connectedFrom(value: string): string | null {
  const info = /\bfrom\s+\S+\s*\(([^()]*)\)/i.exec(value)?.[1] ?? "";
  const bracketed = /\[(?:ipv6:)?([0-9a-f:.]+)\]/i.exec(info)?.[1];
  if (bracketed) return bracketed.toLowerCase();
  const bare = /^\s*([0-9a-f:.]+)\s*$/i.exec(info)?.[1];
  return bare && /[.:]/.test(bare) ? bare.toLowerCase() : null;
}

// Loopback, private, link-local and unique-local addresses: a hop between the receiver's own machines, never one the
// internet can reach it from.
function privateAddress(ip: string): boolean {
  if (ip.includes(":")) return ip === "::1" || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
  const [a = -1, b = -1] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  );
}

type Read = { kinds: Set<ReceiverKind>; parsed: { authservId: string | null; results: Result[] } };

// The receiver whose hop is at the top of the message took it in last, so its rules apply.
//   Microsoft 365 or Google: the topmost header of theirs, read down to the first hop another host wrote.
//   Another receiver: only headers above its entry hop, the first of its hops reading down whose connecting address
//   (as it recorded it) is not private, so where the message came in from outside; all of them (a receiver may write
//   several, RFC 8601 appendix B.4). A hop between public addresses ends the zone too: trust lost, never a forgery let
//   in. Its results beside another receiver's above the entry hop are ambiguous.
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
    return parsed ? { parsed, kinds: kindsOf(parsed, [...receivers]) } : null;
  };
  let top: ReceiverKind | undefined;
  let entered = false;
  const above: Read[] = [];
  for (const { name, value } of headers) {
    const field = name.trim().toLowerCase();
    if (field === "received") {
      const by = receivedBy(value);
      if (by === null || literal(by)) continue;
      const receiver = ours(by);
      if (!receiver) break; // another host wrote this: everything from here down came with the message
      top ??= receiver.kind;
      if (STAMPS_EVERY_MESSAGE.has(top)) continue;
      const address = connectedFrom(value);
      if (address !== null && privateAddress(address)) continue; // a hop between the receiver's own machines
      entered = true;
      break;
    }
    if (field !== "authentication-results") continue;
    const found = read(value);
    if (!found || found.kinds.size === 0) continue;
    if (top !== undefined && STAMPS_EVERY_MESSAGE.has(top)) {
      if (found.kinds.has(top)) return { trusted: { kind: top, ...found.parsed } };
      continue;
    }
    above.push(found);
  }
  if (top === undefined) return { untrusted: "no-boundary" };
  if (STAMPS_EVERY_MESSAGE.has(top)) return { untrusted: "none-in-zone" };
  if (!entered) return { untrusted: "no-boundary" };
  const first = above[0];
  if (!first) return { untrusted: "none-in-zone" };
  const kinds = new Set(above.flatMap((a) => [...a.kinds]));
  const [kind] = kinds;
  if (kinds.size > 1 || kind === undefined) return { untrusted: "ambiguous" };
  return { trusted: { kind, authservId: first.parsed.authservId, results: above.flatMap((a) => a.parsed.results) } };
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
