// `.za` registration dates from ZACR's WHOIS (D02 T03 §9; RFC 3912), since the IANA RDAP bootstrap has no `za` service
// and ZACR's RDAP server does not answer for second-level zones. One query over a Workers TCP socket to the zone's
// server on port 43, bounded in bytes; the caller's signal closes the socket when the lookup's budget is spent. The
// answer is read only when its `Domain Name` names the domain asked for.
import type { connect } from "cloudflare:sockets";
import type { DomainAge } from "./rdap";

export type Connect = typeof connect;
export const MAX_WHOIS_BYTES = 64 * 1024;

// ZACR's servers for the second-level zones it runs, each of which answered on 2026-10-31.
export const WHOIS_SERVERS: Readonly<Record<string, string>> = {
  "co.za": "coza-whois.registry.net.za",
  "net.za": "net-whois.registry.net.za",
  "org.za": "org-whois.registry.net.za",
  "web.za": "web-whois.registry.net.za",
};

// The server for a registrable name directly under one of the zones, else null.
export function whoisServerFor(domain: string): string | null {
  const dot = domain.indexOf(".");
  if (dot <= 0) return null;
  return WHOIS_SERVERS[domain.slice(dot + 1)] ?? null;
}

// The server's whole answer as text, at most MAX_WHOIS_BYTES: "oversized" past it, null when there is no answer (a
// refused connection, a reset, the signal's abort).
export async function whoisAnswer(
  domain: string,
  server: string,
  open: Connect,
  signal: AbortSignal,
): Promise<string | "oversized" | null> {
  if (signal.aborted) return null;
  let socket: ReturnType<Connect>;
  try {
    socket = open({ hostname: server, port: 43 });
  } catch {
    // A connection refused before it is made is no answer, as one refused after.
    return null;
  }
  // The socket's own promises reject on a failed connection or close; each is handled here, never left unhandled
  // (plan review; Cloudflare's Socket contract).
  socket.closed.catch(() => {});
  const close = () => {
    socket.close().catch(() => {});
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    await socket.opened;
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(`${domain}\r\n`));
    writer.releaseLock();
    const reader = socket.readable.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WHOIS_BYTES) return "oversized";
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      all.set(chunk, at);
      at += chunk.byteLength;
    }
    return signal.aborted ? null : new TextDecoder().decode(all);
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}

// What an answer says of the domain: its creation date, that it is not registered, that it gave no date, or that it
// could not be read as an answer about this domain.
export function readWhois(
  domain: string,
  text: string,
  rfc3339: (text: string) => Date | null,
  server: string,
  retrievedAt = new Date(),
): DomainAge {
  if (/^\s*No information was found matching that query\.?\s*$/m.test(text) || /^\s*Available\s*$/m.test(text))
    return { state: "unknown", reason: "not-registered" };
  const nameLine = /^\s*Domain Name:\s*(\S+)\s*$/im.exec(text);
  const named = nameLine?.[1]?.toLowerCase().replace(/\.$/, "");
  if (!nameLine || named !== domain.toLowerCase()) return { state: "unknown", reason: "malformed" };
  const dateLine = /^\s*Creation Date:\s*(\S+)\s*$/im.exec(text);
  const date = dateLine?.[1] ? rfc3339(dateLine[1]) : null;
  if (!date || !dateLine) return { state: "unknown", reason: "no-date" };
  return {
    state: "known",
    registered: date.toISOString(),
    server: `whois://${server}`,
    retrievedAt: retrievedAt.toISOString(),
    // The two lines the date rests on, as the registry wrote them; registrant details are never kept.
    excerpt: [nameLine[0].trim().slice(0, 200), dateLine[0].trim().slice(0, 200)],
  };
}
