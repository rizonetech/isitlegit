// Monitor seeds (D05 T04 §6): candidate hosts seeded for demo organisations only. Demo means
// `organization.metadata.demo === true` exactly (src/demo/seed.ts), never an owner-editable
// approximation: an ordinary organisation's run never reads this table.
import { registrable } from "../auth/senders";

export type MonitorSeed = { host: string; path: string };

export async function isDemoOrg(db: D1Database, orgId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT metadata FROM "organization" WHERE id = ?`)
    .bind(orgId)
    .first<{ metadata: string | null }>()
    .catch(() => null);
  if (!row?.metadata) return false;
  try {
    return (JSON.parse(row.metadata) as { demo?: unknown }).demo === true;
  } catch {
    return false;
  }
}

export async function seedsFor(db: D1Database, orgId: string): Promise<MonitorSeed[]> {
  if (!(await isDemoOrg(db, orgId))) return [];
  const rows = await db
    .prepare("SELECT host, path FROM monitor_seeds WHERE org_id = ? ORDER BY host")
    .bind(orgId)
    .all<MonitorSeed>()
    .catch(() => ({ results: [] as MonitorSeed[] }));
  return rows.results.filter((s) => registrable(s.host) !== null);
}

// Provision one seed, idempotently, with read-back.
export async function addSeed(
  db: D1Database,
  orgId: string,
  seed: MonitorSeed,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  if (!registrable(seed.host) || seed.path.includes("..")) return false;
  await db
    .prepare(
      `INSERT INTO monitor_seeds (org_id, host, path, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (org_id, host) DO UPDATE SET path = excluded.path`,
    )
    .bind(orgId, seed.host.toLowerCase(), seed.path.replace(/^\/+/, ""), now().toISOString())
    .run();
  const back = await db
    .prepare("SELECT path FROM monitor_seeds WHERE org_id = ? AND host = ?")
    .bind(orgId, seed.host.toLowerCase())
    .first<{ path: string }>();
  return back?.path === seed.path.replace(/^\/+/, "");
}

export async function removeSeed(db: D1Database, orgId: string, host: string): Promise<boolean> {
  const done = await db
    .prepare("DELETE FROM monitor_seeds WHERE org_id = ? AND host = ?")
    .bind(orgId, host.toLowerCase())
    .run();
  return (done.meta?.changes ?? 0) > 0;
}
