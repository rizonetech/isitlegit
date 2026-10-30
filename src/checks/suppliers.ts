// The organisation's suppliers' domains, which `domain.lookalike` compares against (D02 T03 §2): an empty list until the
// supplier ledger exists (D06 T01 §2, the app lane's, which fills this), so the check runs the same with or without it.
export async function listSupplierDomains(_db: D1Database, _orgId: string): Promise<string[]> {
  return [];
}

// The organisation's own verified domains (`org_domains`, D07 T02), as stored: registrable domains it proved it holds.
export async function listOwnDomains(db: D1Database, orgId: string): Promise<string[]> {
  const rows = await db
    .prepare("SELECT DISTINCT domain FROM org_domains WHERE org_id = ? AND state = 'verified' ORDER BY domain")
    .bind(orgId)
    .all<{ domain: string }>();
  return rows.results.map((r) => r.domain);
}
