// A receiving chain behind a filtering gateway (D02 T02 §6; docs/specs/2026-10-31-receiving-chains-design.md): the
// organisation's MX names a gateway, which hands its mail to Microsoft 365 or Google. The provider's stamp is trusted
// only when the provider's own ingress hop records a connecting address that is one of the gateway's: a greeting name,
// an `X-` header or an authserv-id is never evidence, and a message handed to the provider directly keeps no boundary.
// Pure: the addresses are looked up and stored by src/auth/receiving-chains.ts.
import type { Receiver } from "../auth/receivers";

export type ChainProvider = "microsoft" | "google";
// Which addresses are the gateway's, in the order they are judged (RFC 7208 4.6.2): the first rule an address matches
// decides, `pass` true for the gateway's own (its MX hosts' addresses, its SPF's `+` terms), false for an SPF term with
// another qualifier (`-`, `~`, `?`), which is never the gateway; an `include` matches when its own rules pass, and then
// its own qualifier decides (RFC 7208 5.2: `-include:x` excludes what x passes).
export type AddressRule = { cidr: string; pass: boolean } | { include: AddressRule[]; pass: boolean };

// A stored chain as the frozen view carries it: the gateway's receiver pattern, the provider, and the gateway's address
// rules; `unverified` when its addresses could not be learned completely or looked up fresh, so it proves nothing, with
// why: `unavailable` (a lookup failed or was cut; the next case asks again) or `unsupported` (the gateway's SPF record
// can never be read completely here; D02 T02 §6, correction 18).
export type UnverifiedReason = "unavailable" | "unsupported";
export type ReceivingChain = {
  gateway: string;
  provider: ChainProvider;
  rules: readonly AddressRule[];
  unverified?: UnverifiedReason;
};

// Whether an address is the gateway's under its rules: true only on a matching `pass` rule; a non-pass match, or no
// match at all, is not the gateway (an `include` whose rules do not pass falls through to the rules after it).
export function gatewayAddress(address: string, rules: readonly AddressRule[]): boolean | null {
  for (const rule of rules) {
    if ("include" in rule) {
      if (gatewayAddress(address, rule.include) === true) return rule.pass;
      continue;
    }
    if (inAny(address, [rule.cidr])) return rule.pass;
  }
  return null;
}

// The receiver patterns the provider's hops are known by, as src/auth/receivers.ts learns them from an MX.
export const PROVIDER_RECEIVER: Record<ChainProvider, Receiver> = {
  microsoft: { kind: "microsoft", pattern: "*.outlook.com" },
  google: { kind: "google", pattern: "*.google.com" },
};

// Where each provider receives mail from outside: Exchange Online Protection's front ends
// (`<server>.mail.protection.outlook.com`) and Gmail's MX (`mx.google.com`). Every hop above that one is the provider's
// own (its internal hops, by its hosts or by an address literal); the topmost such ingress hop is the provider's, since
// nothing the message brought can sit above it.
const INGRESS: Record<ChainProvider, (by: string) => boolean> = {
  microsoft: (by) => by.endsWith(".mail.protection.outlook.com"),
  google: (by) => by === "mx.google.com",
};

const covers = (pattern: string, host: string) =>
  pattern.startsWith("*.") ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : host === pattern;
const plain = (value: string) => value.replace(/\s+/g, " ");
const byOf = (value: string) =>
  /(?:^|\s)by\s+([^\s;()]+)/i.exec(plain(value))?.[1]?.replace(/\.$/, "").toLowerCase() ?? null;
const isLiteral = (host: string) =>
  host.startsWith("[") || host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

// The connecting address a `Received` header's `from` clause records (RFC 5321 4.4, TCP-info): the address literal in
// the parentheses after the greeting (`from x (203.0.113.5)`, `from x (x. [203.0.113.5])`, `[IPv6:2001:db8::1]`);
// null when the clause carries none.
export function connectingAddress(value: string): string | null {
  const from = /(?:^|\s)from\s+\S+\s*\(([^()]*)\)/i.exec(plain(value))?.[1];
  if (from === undefined) return null;
  const bracketed = /\[(?:IPv6:)?([0-9a-f.:]+)\]/i.exec(from)?.[1];
  const bare = from
    .trim()
    .split(/\s+/)
    .find((t) => parseAddress(t) !== null);
  const address = bracketed ?? bare ?? null;
  return address !== null && parseAddress(address) !== null ? address.toLowerCase() : null;
}

// The provider's ingress hop, when the top of the message is the provider's: its connecting address and date, or
// "unprovable" when the hop records no address; null when the top of the message is not that provider's.
export function ingressOf(
  headers: readonly { name: string; value: string }[],
  provider: ChainProvider,
): { address: string; date: string | null } | "unprovable" | null {
  const own = PROVIDER_RECEIVER[provider].pattern;
  for (const { name, value } of headers) {
    if (name.trim().toLowerCase() !== "received") continue;
    const by = byOf(value);
    if (by === null) return null;
    if (INGRESS[provider](by)) {
      const address = connectingAddress(value);
      if (address === null) return "unprovable";
      const date = value.includes(";") ? value.slice(value.lastIndexOf(";") + 1).trim() : null;
      return { address, date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null };
    }
    // Above the ingress hop only the provider's own hops are passed over.
    if (!(isLiteral(by) || covers(own, by))) return null;
  }
  return null;
}

// An IPv4 or IPv6 address as a big integer and its width; null when it is neither.
function parseAddress(text: string): { value: bigint; bits: 32 | 128 } | null {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
    const parts = text.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    return { value: parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n), bits: 32 };
  }
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(":")) return null;
  // An IPv4 tail (`::ffff:192.0.2.1`) is two 16-bit groups.
  let hex = text.toLowerCase();
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(hex)?.[1];
  if (v4) {
    const tail = parseAddress(v4);
    if (!tail) return null;
    hex = `${hex.slice(0, -v4.length)}${(tail.value >> 16n).toString(16)}:${(tail.value & 0xffffn).toString(16)}`;
  }
  const halves = hex.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const left = groups(halves[0] ?? "");
  const right = groups(halves[1] ?? "");
  if ([...left, ...right].some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  return { value: words.reduce((n, w) => (n << 16n) | BigInt(`0x${w}`), 0n), bits: 128 };
}

// A CIDR (`203.0.113.0/24`, `2001:db8::/32`) or a lone address; null when it does not parse or its prefix is out of
// range, so a malformed answer never widens what is matched.
export function parseCidr(text: string): { value: bigint; bits: 32 | 128; prefix: number } | null {
  const [addr, len, extra] = text.split("/");
  if (extra !== undefined || addr === undefined) return null;
  const parsed = parseAddress(addr);
  if (!parsed) return null;
  const prefix = len === undefined ? parsed.bits : /^\d{1,3}$/.test(len) ? Number(len) : -1;
  if (prefix < 0 || prefix > parsed.bits) return null;
  return { ...parsed, prefix };
}

export function inAny(address: string, cidrs: readonly string[]): boolean {
  const a = parseAddress(address);
  if (!a) return false;
  return cidrs.some((c) => {
    const range = parseCidr(c);
    if (!range || range.bits !== a.bits) return false;
    const shift = BigInt(range.bits - range.prefix);
    return a.value >> shift === range.value >> shift;
  });
}

// The receivers this message is read with: the organisation's own, or a chain's provider alone when the provider's
// ingress hop came from that chain's gateway. "unverified" when the hop is the provider's but the gateway's addresses could not
// be looked up fresh; the receivers unchanged when no chain applies (a direct delivery keeps no boundary).
export function receiversWithChains(
  headers: readonly { name: string; value: string }[],
  receivers: readonly Receiver[],
  chains: readonly ReceivingChain[] | undefined,
): { receivers: readonly Receiver[]; unverified: UnverifiedReason | null } {
  let unverified: UnverifiedReason | null = null;
  for (const chain of chains ?? []) {
    if (!receivers.some((r) => r.pattern === chain.gateway)) continue;
    const ingress = ingressOf(headers, chain.provider);
    if (ingress === null || ingress === "unprovable") continue;
    if (chain.unverified) {
      // An unreadable record wins over a lookup that failed: asking again cannot cure it.
      unverified = unverified === "unsupported" || chain.unverified === "unsupported" ? "unsupported" : "unavailable";
      continue;
    }
    if (gatewayAddress(ingress.address, chain.rules) === true)
      // The provider alone: its zone ends at the gateway's hop, so a header below the gateway's border, a provider's
      // shape or not, is never read, whether or not the provider stamped this message.
      return { receivers: [PROVIDER_RECEIVER[chain.provider]], unverified: null };
  }
  return { receivers, unverified };
}
