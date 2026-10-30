// Whether Email Routing authenticated the envelope sender of a forward (D01 T01 §3; spec 4.1). Email Routing passes a
// message on when SPF or DKIM passes for any domain and rejects it only on the sender's own DMARC policy, so an envelope
// sender of `boss@member.co.za` signed by an unrelated domain still arrives. The gate therefore reads the topmost
// `Authentication-Results` header (RFC 8601), the one Email Routing prepends (any lower one may have been written by the
// sender), and admits the sender only on a pass that belongs to it. What must be proven depends on what the
// organisation verified (`memberOfSender`):
//   a domain     a pass for the domain: SPF for the envelope sender's own domain, or DKIM signed by a domain with the
//                same registrable domain. Every mailbox at the domain is the organisation's, so the domain is enough.
//   an address   the mailbox itself: the message's own From is that address and a DKIM signature by exactly its domain
//                passed (DKIM always signs From; DMARC's strict alignment). A domain-level pass is not enough for one
//                address at a shared provider: any other gmail.com user's signed mail passes DKIM for gmail.com, and only
//                its signed From tells them apart. Nor is a signer that merely shares the registrable domain: names under
//                a shared host (`*.duckdns.org`) belong to unrelated owners, and none of them proves another's mailbox.
import PostalMime, { addressParser } from "postal-mime";
import { registrable } from "../auth/senders";

// Email Routing's authserv-id in the header it adds. A topmost header naming any other server was not written by it
// (the message carried its own, and Email Routing added none above it), so it proves nothing. D01 T01 §9's live smoke
// records the header a real delivery carries.
export const EMAIL_ROUTING_AUTHSERV_ID = "mx.cloudflare.net";

// Headers end at the first empty line; a header block longer than this is not a mail anyone sends us.
const MAX_HEADER_BYTES = 256 * 1024;

// One result; `comment` keeps the text of its comments (Google writes the DMARC policy there: `dmarc=fail (p=REJECT
// sp=REJECT dis=NONE)`, D02 T02 §2), empty when it has none.
export type Result = { method: string; result: string; props: Map<string, string>; comment: string };

export async function senderAuthenticated(
  raw: Uint8Array,
  envelopeFrom: string,
  proving: "domain" | "address" = "domain",
): Promise<boolean> {
  const sender = envelopeFrom.trim().toLowerCase();
  const at = sender.indexOf("@");
  if (at < 1 || at !== sender.lastIndexOf("@") || at === sender.length - 1) return false;
  const domain = sender.slice(at + 1);
  const headers = await headersOf(raw);
  if (!headers) return false;
  const header = headers.find((h) => h.name === "authentication-results")?.value;
  if (!header) return false;
  const parsed = parseAuthenticationResults(header);
  if (!parsed || parsed.authservId !== EMAIL_ROUTING_AUTHSERV_ID) return false;
  if (proving === "address" && singleFromMailbox(headers) !== sender) return false;
  const site = registrable(domain);
  return parsed.results.some((r) => {
    if (r.result !== "pass") return false;
    if (r.method === "spf" && proving === "domain") {
      const mailfrom = r.props.get("smtp.mailfrom");
      return mailfrom !== undefined && domainOf(mailfrom) === domain;
    }
    if (r.method === "dkim") {
      // The signing domain as reported (`header.d`); `header.i` is the identity, not necessarily the signer.
      const d = (r.props.get("header.d") ?? "").toLowerCase();
      if (!d) return false;
      return proving === "address" ? d === domain : site !== null && registrable(d) === site;
    }
    return false;
  });
}

// What the topmost Authentication-Results header says, for the intake's log when a delivery is not admitted (D01 T01
// §9): its authserv-id and each method's result with the domain it names (`header.d`, the `smtp.mailfrom` domain,
// `header.from`), never an address or a local part. Null fields when the header block or the header is unreadable.
export type AuthSummary = {
  authservId: string | null;
  results: { method: string; result: string; domain: string | null }[];
};

export async function authenticationSummary(raw: Uint8Array): Promise<AuthSummary> {
  const header = (await headersOf(raw))?.find((h) => h.name === "authentication-results")?.value;
  const parsed = header ? parseAuthenticationResults(header) : null;
  if (!parsed) return { authservId: null, results: [] };
  return {
    authservId: parsed.authservId,
    results: parsed.results.map((r) => {
      const named = r.props.get("header.d") ?? r.props.get("smtp.mailfrom") ?? r.props.get("header.from");
      return { method: r.method, result: r.result, domain: named ? domainOf(named) : null };
    }),
  };
}

// An address's domain, or the value itself when it names only a domain (`smtp.mailfrom` may be either).
const domainOf = (value: string) => {
  const v = value.trim().toLowerCase();
  return v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v;
};

// The message's header fields in order, as postal-mime reads them (unfolded; names lower-cased and trimmed, since DKIM's
// relaxed canonicalization treats `From :` as From), or null when the header block has no end within the limit. Only
// the header block is parsed: the body plays no part here.
async function headersOf(raw: Uint8Array): Promise<{ name: string; value: string }[] | null> {
  const head = new TextDecoder().decode(raw.subarray(0, MAX_HEADER_BYTES));
  const end = head.search(/\r?\n\r?\n/);
  if (end < 0) return null;
  // postal-mime refuses a header block past its own budget (each line counted as at least 64 bytes against 2 MiB,
  // `EMAXHEADERSIZE`), which a message of many tiny lines reaches inside our limit: anything it cannot read proves
  // nothing.
  try {
    const parsed = await PostalMime.parse(`${head.slice(0, end)}\r\n\r\n`);
    return parsed.headers.map((h) => ({ name: h.key.trim().toLowerCase(), value: h.value }));
  } catch {
    return null;
  }
}

// The one mailbox of the message's one From field, lower case, or "" for anything else. DKIM verifies a repeated
// header from the bottom (RFC 6376 section 8.15), so with two From fields a passing signature may cover the other one;
// and a From naming a list or a group names no single sender. postal-mime's address parser reads the field.
function singleFromMailbox(headers: { name: string; value: string }[]): string {
  const froms = headers.filter((h) => h.name === "from");
  if (froms.length !== 1) return "";
  const list = addressParser(froms[0]?.value ?? "");
  const only = list.length === 1 ? list[0] : undefined;
  if (!only || "group" in only) return "";
  const address = (only.address ?? "").trim().toLowerCase();
  const at = address.indexOf("@");
  return at > 0 && at === address.lastIndexOf("@") && at < address.length - 1 && !/\s/.test(address) ? address : "";
}

// RFC 8601 section 2.2: `authserv-id [version] *( ";" resinfo )`, each resinfo `method[/version]=result` then
// `reason=...` and `ptype.property=value` pairs; comments in parentheses are ignored and values may be quoted.
// Microsoft 365 writes no authserv-id (`spf=pass (...) smtp.mailfrom=contoso.com; dkim=...; compauth=pass reason=100`,
// Microsoft Learn's "Anti-spam message headers"): a first part that is itself a result gives `authservId: null` and is
// read as a result (D02 T02 §1). The intake's own check needs Email Routing's authserv-id, so it refuses such a header.
export function parseAuthenticationResults(value: string): { authservId: string | null; results: Result[] } | null {
  // Split first, at semicolons outside quoted strings and comments, so each result keeps its own comments.
  const raw = splitOutside(value, ";");
  const parts = raw.map((p) => tightenSeparators(stripComments(p)).trim());
  const first = parts[0]?.split(/\s+/)[0] ?? "";
  if (!first) return null;
  const authservId = first.indexOf("=") > 0 ? null : unquote(first).toLowerCase();
  if (authservId !== null) {
    parts.shift();
    raw.shift();
  }
  const results: Result[] = [];
  for (const [n, part] of parts.entries()) {
    const tokens = splitOutsideQuotes(part.replace(/\s/g, " "), " ")
      .map((t) => t.trim())
      .filter(Boolean);
    const [head, ...rest] = tokens;
    const eq = head?.indexOf("=") ?? -1;
    if (!head || eq < 1) continue;
    const props = new Map<string, string>();
    for (const token of rest) {
      const i = token.indexOf("=");
      if (i < 1) continue;
      props.set(token.slice(0, i).toLowerCase(), unquote(token.slice(i + 1)));
    }
    results.push({
      method: head.slice(0, eq).split("/")[0]?.toLowerCase() ?? "",
      result: unquote(head.slice(eq + 1)).toLowerCase(),
      props,
      comment: commentsOf(raw[n] ?? ""),
    });
  }
  return { authservId, results };
}

// Drops the whitespace RFC 8601 allows around `=`, `.` and `/` (`spf = pass`, `smtp . mailfrom`) outside quoted
// strings, so each result reads as one token. One pass each way: the next non-space character is found from the end and
// the previous one is carried, so a long run of folding whitespace costs linear time, never a rescan (D02 T02 §1's
// completion review: a folded 100 KB header took seconds).
function tightenSeparators(value: string): string {
  const next: string[] = new Array(value.length + 1).fill("");
  for (let i = value.length - 1; i >= 0; i--) {
    const c = value[i] as string;
    next[i] = /\s/.test(c) ? (next[i + 1] as string) : c;
  }
  const out: string[] = [];
  let previous = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (quoted && c === "\\") {
      out.push(c, value[i + 1] ?? "");
      previous = value[i + 1] ?? previous;
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (!quoted && /\s/.test(c)) {
      const after = next[i + 1] as string;
      if (SEPARATORS.has(after) || SEPARATORS.has(previous)) continue;
      out.push(c);
      continue;
    }
    out.push(c);
    previous = c;
  }
  return out.join("");
}
const SEPARATORS = new Set(["=", ".", "/"]);

// A value with its quotes removed and its quoted-pairs (`\"`, `\\`) decoded (RFC 5322 section 3.2.4).
function unquote(v: string): string {
  if (!(v.length >= 2 && v.startsWith('"') && v.endsWith('"'))) return v;
  return v.slice(1, -1).replace(/\\(.)/g, "$1");
}

// Splits at the separator outside quoted strings and comments (a `;` inside `(...)` belongs to the comment).
export function splitOutside(value: string, separator: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (c === "\\" && (quoted || depth > 0)) {
      current.push(c, value[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"' && depth === 0) quoted = !quoted;
    else if (c === "(" && !quoted) depth++;
    else if (c === ")" && !quoted && depth > 0) depth--;
    if (c === separator && !quoted && depth === 0) {
      out.push(current.join(""));
      current = [];
    } else current.push(c);
  }
  out.push(current.join(""));
  return out;
}

// The text of the comments outside quoted strings, joined by a space (nested ones read as part of their outer one).
function commentsOf(value: string): string {
  const found: string[] = [];
  let current: string[] = [];
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (c === "\\" && (quoted || depth > 0)) {
      if (depth > 0) current.push(value[i + 1] ?? "");
      i++;
    } else if (c === '"' && depth === 0) quoted = !quoted;
    else if (c === "(" && !quoted) {
      if (depth > 0) current.push(c);
      depth++;
    } else if (c === ")" && !quoted && depth > 0) {
      depth--;
      if (depth === 0) {
        found.push(current.join("").trim());
        current = [];
      } else current.push(c);
    } else if (depth > 0) current.push(c);
  }
  return found.filter(Boolean).join(" ");
}

// Removes (possibly nested) comments outside quoted strings.
export function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && (quoted || depth > 0)) {
      if (depth === 0) out += c + (value[i + 1] ?? "");
      i++;
    } else if (c === '"' && depth === 0) {
      quoted = !quoted;
      out += c;
    } else if (c === "(" && !quoted) depth++;
    else if (c === ")" && !quoted && depth > 0) {
      depth--;
      // A comment separates what is on either side of it, as whitespace does (`spf=fail(why)smtp.mailfrom=...`).
      if (depth === 0) out += " ";
    } else if (depth === 0) out += c;
  }
  return out;
}

// Splits at the separator outside quoted strings; a quoted-pair (`\"`) inside one neither ends it nor splits it.
function splitOutsideQuotes(value: string, separator: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (quoted && c === "\\") {
      current.push(c, value[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === separator && !quoted) {
      out.push(current.join(""));
      current = [];
    } else current.push(c);
  }
  out.push(current.join(""));
  return out;
}
