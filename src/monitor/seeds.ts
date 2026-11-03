// Monitor seeds (D05 T04 §6): candidate hosts seeded for demo organisations only. Demo means
// `organization.metadata.demo === true` exactly (src/demo/seed.ts), never an owner-editable
// approximation: an ordinary organisation's run never reads this table.
import { registrable } from "../auth/senders";
import { FIXTURES_HOST } from "../fixtures/redirects";

export type MonitorSeed = { host: string; path: string };

const VALID_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const VALID_PATH = /^[a-z0-9][a-z0-9/_.-]{0,199}$/i;

function normaliseSeed(seed: MonitorSeed): MonitorSeed | null {
  const host = seed.host.trim().toLowerCase();
  const path = seed.path.trim().replace(/^\/+/, "");
  if (!VALID_HOST.test(host) || !registrable(host)) return null;
  if (!path || path.includes("..") || !VALID_PATH.test(path)) return null;
  return { host, path };
}

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

// Revoke the demo flag on an organisation without deleting the organisation row, with read-back.
export async function revokeDemoFlag(db: D1Database, orgId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT metadata FROM "organization" WHERE id = ?`)
    .bind(orgId)
    .first<{ metadata: string | null }>()
    .catch(() => null);
  if (!row) return false;
  let parsed: Record<string, unknown> = {};
  if (row.metadata) {
    try {
      const candidate = JSON.parse(row.metadata) as unknown;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = { ...(candidate as Record<string, unknown>) };
      }
    } catch {
      parsed = {};
    }
  }
  parsed.demo = false;
  await db.prepare(`UPDATE "organization" SET metadata = ? WHERE id = ?`).bind(JSON.stringify(parsed), orgId).run();
  return !(await isDemoOrg(db, orgId));
}

export async function seedsFor(db: D1Database, orgId: string): Promise<MonitorSeed[]> {
  if (!(await isDemoOrg(db, orgId))) return [];
  const rows = await db
    .prepare("SELECT host, path FROM monitor_seeds WHERE org_id = ? ORDER BY host")
    .bind(orgId)
    .all<MonitorSeed>()
    .catch(() => ({ results: [] as MonitorSeed[] }));
  return rows.results.map(normaliseSeed).filter((s): s is MonitorSeed => s !== null);
}

// Hosts that are seeded in `monitor_seeds` (or the fixtures host itself) but not active for this
// organisation right now, so an ordinary organisation or one whose demo flag or seed was removed
// never resolves, captures, or screens a previously persisted seed host.
export async function inactiveSeedHosts(
  db: D1Database,
  orgId: string,
  activeSeeds: readonly MonitorSeed[],
): Promise<Set<string>> {
  const active = new Set(activeSeeds.map((s) => s.host.toLowerCase()));
  const inactive = new Set<string>();
  if (!active.has(FIXTURES_HOST)) inactive.add(FIXTURES_HOST);
  const rows = await db
    .prepare("SELECT DISTINCT lower(host) AS host FROM monitor_seeds WHERE org_id = ? OR host IS NOT NULL")
    .bind(orgId)
    .all<{ host: string }>()
    .catch(() => ({ results: [] as { host: string }[] }));
  for (const r of rows.results) {
    if (r.host && !active.has(r.host)) inactive.add(r.host);
  }
  return inactive;
}

// Provision one seed, idempotently, with read-back.
export async function addSeed(
  db: D1Database,
  orgId: string,
  seed: MonitorSeed,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const clean = normaliseSeed(seed);
  if (!clean) return false;
  await db
    .prepare(
      `INSERT INTO monitor_seeds (org_id, host, path, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (org_id, host) DO UPDATE SET path = excluded.path`,
    )
    .bind(orgId, clean.host, clean.path, now().toISOString())
    .run();
  const back = await db
    .prepare("SELECT path FROM monitor_seeds WHERE org_id = ? AND host = ?")
    .bind(orgId, clean.host)
    .first<{ path: string }>();
  return back?.path === clean.path;
}

export async function removeSeed(db: D1Database, orgId: string, host: string): Promise<boolean> {
  const done = await db
    .prepare("DELETE FROM monitor_seeds WHERE org_id = ? AND host = ?")
    .bind(orgId, host.trim().toLowerCase())
    .run();
  return (done.meta?.changes ?? 0) > 0;
}
