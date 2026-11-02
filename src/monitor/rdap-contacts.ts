// Registrar and hosting abuse contacts for a takedown pack (D05 T04 §5): the domain's RDAP answer
// (registrar entity and its abuse email) and the hosting IP's RDAP answer (network and its abuse
// email), parsed from the responses themselves. An answer that cannot be had, or holds no abuse
// contact, states itself; a contact is never guessed.
export type RdapContacts = {
  domain: string;
  registrar: string | null;
  registrarAbuse: string | null;
  ip: string | null;
  network: string | null;
  networkAbuse: string | null;
  unavailable: string[];
};

type Entity = {
  handle?: string;
  roles?: string[];
  vcardArray?: [string, [string, unknown, string, string][]];
  entities?: Entity[];
  fn?: string;
};

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 256 * 1024;

// The body read with the byte limit enforced while reading (as src/checks/rdap.ts reads), so an
// oversized answer is cancelled instead of buffered whole.
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

async function fetchJson(fetchFn: typeof fetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchFn(url, {
      headers: { accept: "application/rdap+json, application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (!response.ok) return null;
    const text = await boundedText(response);
    if (text === null) return null;
    const json: unknown = JSON.parse(text);
    return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function vcardValue(entity: Entity, field: string): string | null {
  const rows = Array.isArray(entity.vcardArray?.[1]) ? entity.vcardArray[1] : [];
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row)) continue;
    const [name, , , value] = row as unknown[];
    if (name === field && typeof value === "string" && value) return value;
  }
  return null;
}

const hasRole = (entity: Entity, role: string) =>
  Array.isArray(entity.roles) && entity.roles.some((r) => typeof r === "string" && r === role);

// Bounded traversal: a hostile RDAP answer nests entities to exhaust the stack, so depth and
// count are capped and anything deeper is simply not read.
const MAX_DEPTH = 8;
const MAX_ENTITIES = 200;
function* walk(entities: unknown, depth = 0, seen = { n: 0 }): Generator<Entity> {
  if (!Array.isArray(entities) || depth > MAX_DEPTH) return;
  for (const entity of entities as (Entity | null)[]) {
    if (typeof entity !== "object" || entity === null) continue;
    if (++seen.n > MAX_ENTITIES) return;
    yield entity;
    if (Array.isArray(entity.entities)) yield* walk(entity.entities, depth + 1, seen);
  }
}

function contactsOf(json: Record<string, unknown>): { name: string | null; abuse: string | null } {
  const entities = [...walk(json.entities)];
  const registrar = entities.find((e) => hasRole(e, "registrar"));
  const abuse = entities.find((e) => hasRole(e, "abuse"));
  return {
    name: registrar
      ? (vcardValue(registrar, "fn") ?? (typeof registrar.handle === "string" ? registrar.handle : null))
      : null,
    // An abuse contact only where RDAP gives that role: an ordinary registrar email is never
    // relabelled as one.
    abuse: abuse ? vcardValue(abuse, "email") : null,
  };
}

// The domain RDAP service from the IANA bootstrap (RFC 9224), the same source src/checks/rdap.ts
// uses; the IP answer comes from rdap.org's redirector. Both bounded; neither throws.
export async function rdapContacts(
  fetchFn: typeof fetch,
  input: { domain: string; bootstrap: [string[], string[]][] | null; ip?: string | null },
): Promise<RdapContacts> {
  const unavailable: string[] = [];
  const out: RdapContacts = {
    domain: input.domain,
    registrar: null,
    registrarAbuse: null,
    ip: input.ip ?? null,
    network: null,
    networkAbuse: null,
    unavailable,
  };
  let base: string | null = null;
  if (input.bootstrap) {
    const labels = input.domain.toLowerCase().split(".");
    for (let i = 1; i < labels.length && !base; i++) {
      const suffix = labels.slice(i).join(".");
      const found = input.bootstrap.find(([tlds]) => tlds.includes(suffix));
      base = found?.[1].find((u) => u.startsWith("https://")) ?? found?.[1][0] ?? null;
    }
  }
  if (!base) unavailable.push("domain-rdap-service");
  else {
    const json = await fetchJson(fetchFn, `${base.replace(/\/?$/, "/")}domain/${encodeURIComponent(input.domain)}`);
    if (!json) unavailable.push("domain-rdap");
    else {
      const { name, abuse } = contactsOf(json);
      out.registrar = name;
      out.registrarAbuse = abuse;
      if (!abuse) unavailable.push("registrar-abuse-contact");
    }
  }
  if (input.ip) {
    const json = await fetchJson(fetchFn, `https://rdap.org/ip/${encodeURIComponent(input.ip)}`);
    if (!json) unavailable.push("ip-rdap");
    else {
      out.network = typeof json.name === "string" ? json.name : null;
      out.networkAbuse = contactsOf(json).abuse;
      if (!out.networkAbuse) unavailable.push("network-abuse-contact");
    }
  }
  return out;
}
