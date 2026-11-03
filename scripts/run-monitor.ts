// Run the monitor for one organisation in production (D05 T04 §6): creates today's
// MonitorWorkflow instance (or joins the one already running for today), waits for it, and
// exits 0 only when a finding for the fixture host is stored from this run's window. An old
// finding never satisfies a new run: the investigation must have settled after the run
// started. Credentials come from the environment (the vault), never printed.
//
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/run-monitor.ts --org demo-fynbos --wait 300
import { FYNBOS_ORG_ID } from "../src/demo/seed";

export const FIXTURE_HOST = "fixtures.isitlegit.co.za";

export function instanceIdFor(orgId: string, day: string): string {
  return `monitor-${orgId}-${day}`;
}

// Whether the stored rows prove this run found the fixture: a finding for the host whose
// latest investigation settled (updated) at or after the run started.
export function findingSatisfied(
  finding: { host: string } | null,
  investigation: { state: string; updated_at: string } | null,
  startedAtIso: string,
): boolean {
  return (
    finding?.host === FIXTURE_HOST &&
    investigation?.state === "confirmed" &&
    investigation.updated_at >= startedAtIso
  );
}

type Api = (path: string, init?: RequestInit) => Promise<Response>;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const orgArg = args[args.indexOf("--org") + 1] ?? "";
  const waitSeconds = Number(args[args.indexOf("--wait") + 1] ?? "300");
  const orgId = orgArg === "demo-fynbos" ? FYNBOS_ORG_ID : orgArg;
  if (!orgId) {
    console.error("usage: run-monitor.ts --org demo-fynbos|<org id> --wait <seconds>");
    process.exit(2);
  }
  const token = process.env.CF_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID;
  if (!token || !account) {
    console.error("CF_API_TOKEN and CF_ACCOUNT_ID are required (from the vault, never printed).");
    process.exit(2);
  }
  const api: Api = (path, init) =>
    fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  const day = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
  const id = instanceIdFor(orgId, day);
  const startedAt = new Date().toISOString();
  const create = await api(`/accounts/${account}/workflows/isitlegit-monitor/instances`, {
    method: "POST",
    body: JSON.stringify({ id, params: { orgId, day } }),
  });
  if (!create.ok && create.status !== 409) {
    console.error(`workflow create answered ${create.status}`);
    process.exit(1);
  }
  const deadline = Date.now() + waitSeconds * 1000;
  let status = "";
  while (Date.now() < deadline) {
    const res = await api(`/accounts/${account}/workflows/isitlegit-monitor/instances/${encodeURIComponent(id)}/status`);
    if (res.ok) {
      const body = (await res.json()) as { result?: { status?: string } };
      status = body.result?.status ?? "";
      if (status === "complete") break;
      if (status === "errored" || status === "terminated") {
        console.error(`workflow instance ${status}`);
        process.exit(1);
      }
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (status !== "complete") {
    console.error(`timed out after ${waitSeconds}s waiting for ${id} (last status ${status || "unknown"})`);
    process.exit(2);
  }
  const dbId = process.env.D1_DATABASE_ID;
  if (!dbId) {
    console.error("D1_DATABASE_ID is required to read the finding back.");
    process.exit(2);
  }
  const query = async (sql: string, params: string[]) => {
    const res = await api(`/accounts/${account}/d1/database/${dbId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    });
    if (!res.ok) throw new Error(`D1 query answered ${res.status}`);
    const body = (await res.json()) as { result?: { results?: Record<string, string>[] }[] };
    return body.result?.[0]?.results ?? [];
  };
  const findings = await query("SELECT host FROM monitor_findings WHERE org_id = ? AND host = ?", [orgId, FIXTURE_HOST]);
  const investigations = await query(
    "SELECT state, updated_at FROM monitor_investigations WHERE org_id = ? AND domain = ? ORDER BY updated_at DESC LIMIT 1",
    [orgId, FIXTURE_HOST],
  );
  const ok = findingSatisfied(findings[0] ?? null, investigations[0] ?? null, startedAt);
  console.log(
    JSON.stringify({ event: "run-monitor", instance: id, finding: findings.length > 0, investigation: investigations[0]?.state ?? null }),
  );
  process.exit(ok ? 0 : 1);
}

if (process.argv[1]?.endsWith("run-monitor.ts")) await main();
