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
import { registrable } from "../auth/senders";

// Email Routing's authserv-id in the header it adds. A topmost header naming any other server was not written by it
// (the message carried its own, and Email Routing added none above it), so it proves nothing. D01 T01 §9's live smoke
// records the header a real delivery carries.
export const EMAIL_ROUTING_AUTHSERV_ID = "mx.cloudflare.net";

// Headers end at the first empty line; a header block longer than this is not a mail anyone sends us.
const MAX_HEADER_BYTES = 256 * 1024;

type Result = { method: string; result: string; props: Map<string, string> };

export function senderAuthenticated(
  raw: Uint8Array,
  envelopeFrom: string,
  proving: "domain" | "address" = "domain",
): boolean {
  const sender = envelopeFrom.trim().toLowerCase();
  const at = sender.indexOf("@");
  if (at < 1 || at !== sender.lastIndexOf("@") || at === sender.length - 1) return false;
  const domain = sender.slice(at + 1);
  const headers = headerLines(raw);
  const header = firstHeader(headers, "authentication-results");
  if (!header) return false;
  const parsed = parseAuthenticationResults(header);
  if (!parsed || parsed.authservId !== EMAIL_ROUTING_AUTHSERV_ID) return false;
  if (proving === "address" && addressOf(firstHeader(headers, "from") ?? "") !== sender) return false;
  const site = registrable(domain);
  return parsed.results.some((r) => {
    if (r.result !== "pass") return false;
    if (r.method === "spf" && proving === "domain") {
      const mailfrom = r.props.get("smtp.mailfrom");
      return mailfrom !== undefined && domainOf(mailfrom) === domain;
    }
    if (r.method === "dkim") {
      const d = (r.props.get("header.d") ?? domainOf(r.props.get("header.i") ?? "")).toLowerCase();
      if (!d) return false;
      return proving === "address" ? d === domain : site !== null && registrable(d) === site;
    }
    return false;
  });
}

// An address's domain, or the value itself when it names only a domain (`smtp.mailfrom` may be either).
const domainOf = (value: string) => {
  const v = value.trim().toLowerCase();
  return v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v;
};

// The header block's lines, unfolded.
function headerLines(raw: Uint8Array): string[] {
  const head = new TextDecoder().decode(raw.subarray(0, MAX_HEADER_BYTES));
  const end = head.search(/\r?\n\r?\n/);
  return (end < 0 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
}

// The first header of that name (lower case), or null.
function firstHeader(lines: string[], name: string): string | null {
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === name) return line.slice(colon + 1).trim();
  }
  return null;
}

// The first `Authentication-Results` header in the header block, unfolded, or null.
export const topmostAuthenticationResults = (raw: Uint8Array) =>
  firstHeader(headerLines(raw), "authentication-results");

// The one address a From header names (`"Name" <a@b>` or `a@b`), lower case; empty when it names none or several.
function addressOf(from: string): string {
  const value = stripComments(from).trim();
  const angled = [...value.matchAll(/<([^<>]*)>/g)];
  const address = angled.length === 1 ? angled[0]?.[1] : angled.length === 0 && !value.includes(",") ? value : "";
  return (address ?? "").trim().toLowerCase();
}

// RFC 8601 section 2.2: `authserv-id [version] *( ";" resinfo )`, each resinfo `method[/version]=result` then
// `reason=...` and `ptype.property=value` pairs; comments in parentheses are ignored and values may be quoted.
export function parseAuthenticationResults(value: string): { authservId: string; results: Result[] } | null {
  const parts = splitOutsideQuotes(tightenSeparators(stripComments(value)), ";").map((p) => p.trim());
  const authservId = parts.shift()?.split(/\s+/)[0]?.toLowerCase();
  if (!authservId) return null;
  const results: Result[] = [];
  for (const part of parts) {
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
    });
  }
  return { authservId, results };
}

// Drops the whitespace RFC 8601 allows around `=`, `.` and `/` (`spf = pass`, `smtp . mailfrom`) outside quoted
// strings, so each result reads as one token.
function tightenSeparators(value: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (c === '"') quoted = !quoted;
    if (!quoted && /\s/.test(c)) {
      const next = value.slice(i).trimStart()[0];
      const previous = out.trimEnd().at(-1);
      if (next === "=" || next === "." || next === "/" || previous === "=" || previous === "." || previous === "/")
        continue;
    }
    out += c;
  }
  return out;
}

const unquote = (v: string) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

// Removes (possibly nested) comments outside quoted strings.
function stripComments(value: string): string {
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
    else if (c === ")" && !quoted && depth > 0) depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const c of value) {
    if (c === '"') quoted = !quoted;
    if (c === separator && !quoted) {
      out.push(current);
      current = "";
    } else current += c;
  }
  out.push(current);
  return out;
}
