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

async function fetchJson(fetchFn: typeof fetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchFn(url, {
      headers: { accept: "application/rdap+json, application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > MAX_BYTES) return null;
    const json: unknown = JSON.parse(text);
    return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function vcardValue(entity: Entity, field: string): string | null {
  const rows = entity.vcardArray?.[1] ?? [];
  for (const [name, , , value] of rows) if (name === field && typeof value === "string" && value) return value;
  return null;
}

function* walk(entities: Entity[]): Generator<Entity> {
  for (const entity of entities) {
    yield entity;
    if (entity.entities) yield* walk(entity.entities);
  }
}

function contactsOf(json: Record<string, unknown>): { name: string | null; abuse: string | null } {
  const entities = [...walk((json.entities as Entity[] | undefined) ?? [])];
  const registrar = entities.find((e) => e.roles?.includes("registrar"));
  const abuse = entities.find((e) => e.roles?.includes("abuse"));
  return {
    name: registrar ? (vcardValue(registrar, "fn") ?? registrar.handle ?? null) : null,
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
