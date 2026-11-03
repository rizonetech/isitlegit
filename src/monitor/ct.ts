// Certificate-transparency search (D05 T04 §7; spec 4.11): new certificates whose names
// contain the business's brand tokens reveal lookalikes before they are used. The source is
// crt.sh (terms in NOTICE.md). Queries and answers are bounded, names are validated, and a
// failed token is stated on the run, never read as no names and never fatal to the day's
// ordinary monitoring.
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1 << 20;
const MAX_RECORDS = 5_000;
export const MAX_TOKENS = 8;

const STOPWORDS = new Set(["the", "and", "for", "with", "company", "group", "limited", "holdings", "south", "africa"]);

// Brand tokens: normalised words from the display names plus verified domain labels, at
// least four characters, deduped, bounded. No usable token means no query and no error.
export function brandTokens(names: string[], domains: string[]): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const token = raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (token.length >= 4 && !STOPWORDS.has(token) && !out.includes(token)) out.push(token);
  };
  for (const domain of domains) add(domain.split(".")[0] ?? "");
  for (const name of names) for (const word of name.split(/[^A-Za-z0-9]+/)) add(word);
  return out.slice(0, MAX_TOKENS);
}

async function boundedText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

const HOSTNAME = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// The names one token's answer carries: split, wildcards stripped, validated, token-matching.
// A non-array answer is not a search result at all, and an answer past the record bound is
// truncated: both are stated by the caller, never read as a complete empty search.
export function ctNames(json: unknown, token: string): { names: string[]; truncated: boolean } {
  if (!Array.isArray(json)) return { names: [], truncated: true };
  const out = new Set<string>();
  for (const record of json.slice(0, MAX_RECORDS) as { name_value?: unknown }[]) {
    if (typeof record?.name_value !== "string") continue;
    for (const line of record.name_value.split(/\n/)) {
      const host = line.trim().toLowerCase().replace(/^\*\./, "");
      if (host.includes(token) && HOSTNAME.test(host)) out.add(host);
    }
  }
  return { names: [...out], truncated: json.length > MAX_RECORDS };
}

export type CtResult = { names: string[]; failed: string[] };

// Query crt.sh once per token. A token that times out, errors, or answers past the bounds is
// named in `failed`; the names that did arrive still count.
export async function ctCandidates(fetchFn: typeof fetch, tokens: string[]): Promise<CtResult> {
  const names = new Set<string>();
  const failed: string[] = [];
  for (const token of tokens.slice(0, MAX_TOKENS)) {
    try {
      const response = await fetchFn(`https://crt.sh/?q=${encodeURIComponent(`%${token}%`)}&output=json`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        failed.push(token);
        continue;
      }
      const text = await boundedText(response);
      if (text === null) {
        failed.push(token);
        continue;
      }
      const parsed = ctNames(JSON.parse(text) as unknown, token);
      for (const host of parsed.names) names.add(host);
      if (parsed.truncated) failed.push(token);
    } catch {
      failed.push(token);
    }
  }
  return { names: [...names].sort(), failed };
}
