// Fictional organisations for the trust tests (D05 T01): each with its own verified or pending domains and addresses,
// as D07 T02 §5's verification leaves them.
import { env } from "cloudflare:test";

export async function makeOrg(name = "Hadeda Couriers (fictional)"): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(id, name, `org-${id.slice(0, 8)}`, new Date().toISOString())
    .run();
  return id;
}

export async function addDomain(orgId: string, domain: string, state: "verified" | "pending" = "verified") {
  await env.DB.prepare(
    "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, ?, 'dns', ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      orgId,
      domain,
      "t".repeat(32),
      state,
      state === "verified" ? new Date().toISOString() : null,
      new Date().toISOString(),
    )
    .run();
}

export async function addAddress(orgId: string, address: string, state: "verified" | "pending" = "verified") {
  await env.DB.prepare(
    "INSERT INTO org_addresses (id, org_id, address, state, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      orgId,
      address,
      state,
      state === "verified" ? new Date().toISOString() : null,
      new Date().toISOString(),
    )
    .run();
}

// An organisation ready for protection: a verified domain and a verified finance address.
export async function protectableOrg(domain: string, contact: string, name?: string) {
  const orgId = await makeOrg(name);
  await addDomain(orgId, domain);
  await addAddress(orgId, contact);
  return orgId;
}

export const events = async (orgId: string) =>
  (
    await env.DB.prepare("SELECT kind, actor, detail_json FROM trust_events WHERE org_id = ? ORDER BY rowid")
      .bind(orgId)
      .all<{ kind: string; actor: string; detail_json: string }>()
  ).results.map((e) => ({
    kind: e.kind,
    actor: e.actor,
    detail: JSON.parse(e.detail_json) as Record<string, unknown>,
  }));
