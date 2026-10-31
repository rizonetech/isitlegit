// The walkthrough's URL policy (D04 T02 §3; design spec 4.4a; AGENTS.md safety contract). Every request the
// contained browser makes passes `allowedUrl` before the driver performs it with the Worker's own `fetch`: http(s)
// on the default port, no credentials, no IP literal (a Worker subrequest cannot use one either), no local name, and
// a name whose every A and AAAA answer is a public address. The Worker's `fetch` owns the connection, and its egress
// has no route to private networks without a VPC binding, so this check and the connection agree; the DNS check is a
// second layer, not the only one. D04 T02 §7 merges this policy with the checks lane's (D02 T07 §2).

// --- Addresses ---------------------------------------------------------------------------------------------------

function ipv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^(0|[1-9]\d{0,2})$/.test(p) ? Number(p) : Number.NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

// Eight 16-bit groups, with `::` expanded and a trailing dotted IPv4 folded into the last two; null when malformed.
function ipv6(text: string): number[] | null {
  let body = text.toLowerCase();
  const tail: number[] = [];
  const at = body.lastIndexOf(":");
  if (at >= 0 && body.slice(at + 1).includes(".")) {
    const v4 = ipv4(body.slice(at + 1));
    if (!v4) return null;
    tail.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
    // `::ffff:1.2.3.4` keeps its `::`; `0:0:0:0:0:ffff:1.2.3.4` loses the colon before the dotted part.
    body = body.slice(0, at + 1);
    if (!body.endsWith("::")) body = body.slice(0, -1);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const read = (part: string) => (part === "" ? [] : part.split(":"));
  const head = read(halves[0] ?? "");
  const rest = halves.length === 2 ? read(halves[1] ?? "") : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const value = (g: string) => Number.parseInt(g, 16);
  const fill = Array.from({ length: 8 - known }, () => 0);
  return halves.length === 2
    ? [...head.map(value), ...fill, ...rest.map(value), ...tail]
    : [...head.map(value), ...tail];
}

function publicIpv4([a = 0, b = 0, c = 0]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast and up
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  return true;
}

// Whether an address (IPv4 dotted, or IPv6 with or without brackets) is a public one the walkthrough may reach.
// Anything malformed is not.
export function isPublicAddress(address: string): boolean {
  const text = address.replace(/^\[|\]$/g, "");
  const v4 = ipv4(text);
  if (v4) return publicIpv4(v4);
  const v6 = ipv6(text);
  if (!v6) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = v6;
  const embedded = [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255];
  if (v6.every((g) => g === 0)) return false; // unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return false; // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return publicIpv4(embedded); // mapped
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return publicIpv4(embedded); // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique-local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return false; // multicast ff00::/8
  return true;
}

export const isIpLiteral = (host: string) => ipv4(host) !== null || ipv6(host.replace(/^\[|\]$/g, "")) !== null;

// --- Names -------------------------------------------------------------------------------------------------------

// The A and AAAA answers for a name, or null when it cannot be resolved (no answer, a failure, a timeout).
export type Resolve = (name: string) => Promise<string[] | null>;

const DOH = "https://cloudflare-dns.com/dns-query";

// Cloudflare's DNS over HTTPS, A and AAAA, cached for the walk that made it and bounded to three seconds per query.
export function dohResolve(fetcher: typeof fetch = fetch): Resolve {
  const cache = new Map<string, Promise<string[] | null>>();
  const query = async (name: string, type: "A" | "AAAA"): Promise<string[] | null> => {
    try {
      const answer = await fetcher(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!answer.ok) return null;
      const body = (await answer.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
      if (body.Status !== 0 && body.Status !== 3) return null;
      const want = type === "A" ? 1 : 28;
      return (body.Answer ?? []).filter((a) => a.type === want).map((a) => a.data);
    } catch {
      return null;
    }
  };
  return (name) => {
    const key = name.toLowerCase();
    let found = cache.get(key);
    if (!found) {
      found = Promise.all([query(key, "A"), query(key, "AAAA")]).then(([a, aaaa]) =>
        a === null || aaaa === null ? null : [...a, ...aaaa],
      );
      cache.set(key, found);
    }
    return found;
  };
}

// --- URLs --------------------------------------------------------------------------------------------------------

const LOCAL = /(^|\.)(localhost|local|internal|home\.arpa)$/i;

export type Verdict = { ok: true; url: URL } | { ok: false; reason: string };

export async function allowedUrl(raw: string, resolve: Resolve): Promise<Verdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `scheme ${url.protocol}` };
  if (url.port !== "") return { ok: false, reason: `port ${url.port}` };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials in the URL" };
  const host = url.hostname.replace(/\.$/, "");
  if (isIpLiteral(host)) return { ok: false, reason: "an IP address, not a name" };
  if (host === "" || LOCAL.test(host) || !host.includes(".")) return { ok: false, reason: `local name ${host}` };
  const answers = await resolve(host);
  if (!answers || answers.length === 0) return { ok: false, reason: `${host} does not resolve` };
  const inner = answers.find((a) => !isPublicAddress(a));
  if (inner !== undefined) return { ok: false, reason: `${host} resolves to a non-public address` };
  return { ok: true, url };
}
