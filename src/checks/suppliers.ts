// The organisation's suppliers' domains, which `domain.lookalike` compares against (D02 T03 §2): every domain in its
// supplier ledger (D06 T01 §2, `src/invoice/ledger.ts`), stored there as registrable domains, each once. An
// organisation with no suppliers gets an empty list, and the check runs the same.
export async function listSupplierDomains(db: D1Database, orgId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT d.value AS domain FROM suppliers s, json_each(s.domains_json) d
       WHERE s.org_id = ? AND d.type = 'text' ORDER BY d.value`,
    )
    .bind(orgId)
    .all<{ domain: string }>();
  return rows.results.map((r) => r.domain);
}

// The organisation's own verified domains (`org_domains`, D07 T02), as stored: registrable domains it proved it holds.
export async function listOwnDomains(db: D1Database, orgId: string): Promise<string[]> {
  const rows = await db
    .prepare("SELECT DISTINCT domain FROM org_domains WHERE org_id = ? AND state = 'verified' ORDER BY domain")
    .bind(orgId)
    .all<{ domain: string }>();
  return rows.results.map((r) => r.domain);
}
