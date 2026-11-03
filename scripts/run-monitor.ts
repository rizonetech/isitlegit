// Run the monitor for one organisation in production (D05 T04 §6): checks demo eligibility,
// provisions the lookalike seed idempotently with read-back, creates today's MonitorWorkflow
// instance (or a fresh correlated instance when an earlier same-day instance already finished),
// waits for completion with bounded polling, and exits 0 only when the run, capture, confirmed
// investigation, finding and sent alert all correlate to this execution. Credentials come from
// the environment or local Wrangler login, never printed.
//
//   pnpm exec tsx scripts/run-monitor.ts --org demo-fynbos --wait 300
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROTECTED_ORGANISATIONS } from "../src/auth/protected.ts";

export const FYNBOS_ORG_ID = PROTECTED_ORGANISATIONS[0] as string;
export const FIXTURE_HOST = "fixtures.isitlegit.co.za";
export const FIXTURE_PATH = "fynbos-lookalike/";
const TRIAL_DAYS = 14;
const DAY_MS = 86_400_000;

export function resolveTargetOrg(orgArg: string): string | null {
  const trimmed = orgArg.trim();
  if (!trimmed) return null;
  return trimmed === "demo-fynbos" ? FYNBOS_ORG_ID : trimmed;
}

export function instanceIdFor(orgId: string, day: string, suffix?: string): string {
  return suffix ? `monitor-${orgId}-${day}-${suffix}` : `monitor-${orgId}-${day}`;
}

export type OrgEligibilityInput = {
  metadata: string | null;
  createdAt: string | null;
  plan: string | null;
  trialEndsAt: string | null;
  protectedFlag: number | null;
  financeContact: string | null;
  logoKey: string | null;
  verifiedDomains: string[];
  verifiedAddresses: string[];
  now?: Date;
};

export function checkOrgEligibility(
  input: OrgEligibilityInput,
): { ok: true; alertRecipient: string } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  let isDemo = false;
  if (input.metadata) {
    try {
      isDemo = (JSON.parse(input.metadata) as { demo?: unknown }).demo === true;
    } catch {
      isDemo = false;
    }
  }
  if (!isDemo) reasons.push("not-demo-org");
  if (input.protectedFlag !== 1) reasons.push("protection-off");
  if (input.verifiedDomains.length === 0) reasons.push("no-verified-domain");
  if (!input.logoKey) reasons.push("no-registered-logo");

  const now = input.now ?? new Date();
  let hasMonitorPlan = false;
  if (input.plan === "protect" || input.plan === "msp") {
    hasMonitorPlan = true;
  } else if (input.plan !== "free" && input.createdAt) {
    const end = input.trialEndsAt
      ? new Date(input.trialEndsAt)
      : new Date(new Date(input.createdAt).getTime() + TRIAL_DAYS * DAY_MS);
    if (!Number.isNaN(end.getTime()) && now < end) hasMonitorPlan = true;
  }
  if (!hasMonitorPlan) reasons.push("no-monitor-plan");

  const contact = input.financeContact?.trim().toLowerCase() ?? "";
  const verifiedSet = new Set(input.verifiedAddresses.map((a) => a.toLowerCase()));
  if (!contact || !verifiedSet.has(contact)) {
    reasons.push("alert-recipient-unverified");
  }
  if (reasons.length > 0) return { ok: false, reasons };
  const alertRecipient = contact.endsWith(".demo.isitlegit.co.za") ? "alerts@demo.isitlegit.co.za" : contact;
  return { ok: true, alertRecipient };
}

// Backwards-compatible helper checking whether the finding and confirmed investigation settled at or after startedAtIso.
export function findingSatisfied(
  finding: { host: string; outcome?: string; alert_state?: string | null; alerted_at?: string | null } | null,
  investigation: { state: string; updated_at: string } | null,
  startedAtIso: string,
): boolean {
  if (!finding || finding.host !== FIXTURE_HOST || !investigation) return false;
  if (investigation.state !== "confirmed" || investigation.updated_at < startedAtIso) return false;
  if (finding.outcome !== undefined && finding.outcome !== "confirmed") return false;
  if (finding.alert_state !== undefined && finding.alert_state !== "sent") return false;
  if (finding.alerted_at !== undefined && (!finding.alerted_at || finding.alerted_at < startedAtIso)) return false;
  return true;
}

export type MonitorRunProof = {
  expectedRunId: string;
  run: { run_id: string; outcome: string; finished_at: string | null } | null;
  capture: {
    domain: string;
    capture_key: string | null;
    capture_url: string | null;
    captured_at: string | null;
  } | null;
  investigation: {
    domain: string;
    capture_key: string;
    case_id: string | null;
    state: string;
    updated_at: string;
  } | null;
  finding: {
    host: string;
    capture_key: string;
    case_id: string | null;
    outcome: string;
    alert_state: string | null;
    alerted_at: string | null;
  } | null;
  mailSend: { send_key: string; status: string } | null;
};

export function proofSatisfied(
  proof: MonitorRunProof,
  startedAtIso: string,
): { ok: true } | { ok: false; reason: string } {
  if (
    !proof.run ||
    proof.run.run_id !== proof.expectedRunId ||
    (proof.run.outcome !== "completed" && proof.run.outcome !== "partial") ||
    !proof.run.finished_at ||
    proof.run.finished_at < startedAtIso
  ) {
    return { ok: false, reason: "run-not-finished" };
  }
  if (
    !proof.capture ||
    proof.capture.domain !== FIXTURE_HOST ||
    !proof.capture.capture_key ||
    !proof.capture.captured_at ||
    proof.capture.captured_at < startedAtIso ||
    !proof.capture.capture_url?.startsWith(`https://${FIXTURE_HOST}/`)
  ) {
    return { ok: false, reason: "capture-stale-or-missing" };
  }
  if (
    !proof.investigation ||
    proof.investigation.domain !== FIXTURE_HOST ||
    proof.investigation.capture_key !== proof.capture.capture_key ||
    proof.investigation.state !== "confirmed" ||
    !proof.investigation.case_id ||
    proof.investigation.updated_at < startedAtIso
  ) {
    return { ok: false, reason: "investigation-not-confirmed" };
  }
  if (
    !proof.finding ||
    proof.finding.host !== FIXTURE_HOST ||
    proof.finding.outcome !== "confirmed" ||
    proof.finding.case_id !== proof.investigation.case_id
  ) {
    return { ok: false, reason: "finding-missing-or-unconfirmed" };
  }
  if (proof.finding.alert_state !== "sent" || !proof.finding.alerted_at) {
    return { ok: false, reason: "alert-not-sent" };
  }
  if (proof.mailSend?.status !== "sent") {
    return { ok: false, reason: "mail-send-not-confirmed" };
  }
  return { ok: true };
}

export type Api = (path: string, init?: RequestInit) => Promise<Response>;
export type D1Query = (sql: string, params: string[]) => Promise<Record<string, string | number | null>[]>;

export type RunnerDeps = {
  account: string;
  api: Api;
  query: D1Query;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
};

export type RunnerOptions = {
  orgArg: string;
  waitSeconds: number;
};

export type RunnerOutcome = {
  exitCode: 0 | 1 | 2;
  reason?: string;
  orgId?: string;
  instanceId?: string;
  caseId?: string | null;
  captureKey?: string | null;
  alertedAt?: string | null;
  alertRecipient?: string;
};

function parseWorkflowStatus(
  body: {
    result?: { status?: string; start?: string | null; end?: string | null; success?: boolean | null };
  } | null,
): string {
  const r = body?.result;
  if (!r) return "";
  if (typeof r.status === "string" && r.status.length > 0) return r.status;
  if (r.end) return r.success === true ? "complete" : "errored";
  if (r.start) return "running";
  return "";
}

export async function executeMonitorRun(deps: RunnerDeps, options: RunnerOptions): Promise<RunnerOutcome> {
  const orgId = resolveTargetOrg(options.orgArg);
  if (!orgId || !Number.isFinite(options.waitSeconds) || options.waitSeconds <= 0) {
    return { exitCode: 2, reason: "invalid-arguments" };
  }
  const clock = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollIntervalMs ?? 10_000;

  // 1. Check demo eligibility and alert recipient readiness in D1 before starting the Workflow.
  const orgRows = await deps.query(
    `SELECT o.metadata, o."createdAt" AS createdAt, l.plan, l.trial_ends_at
     FROM "organization" o LEFT JOIN org_limits l ON l.org_id = o.id WHERE o.id = ?`,
    [orgId],
  );
  const idRows = await deps.query(
    "SELECT protected, finance_contact_email, logo_r2_key FROM identities WHERE org_id = ?",
    [orgId],
  );
  const domainRows = await deps.query("SELECT domain FROM org_domains WHERE org_id = ? AND state = 'verified'", [
    orgId,
  ]);
  const addrRows = await deps.query("SELECT address FROM org_addresses WHERE org_id = ? AND state = 'verified'", [
    orgId,
  ]);
  const orgRow = orgRows[0];
  const idRow = idRows[0];
  const eligibility = checkOrgEligibility({
    metadata: orgRow?.metadata !== undefined && orgRow.metadata !== null ? String(orgRow.metadata) : null,
    createdAt: orgRow?.createdAt !== undefined && orgRow.createdAt !== null ? String(orgRow.createdAt) : null,
    plan: orgRow?.plan !== undefined && orgRow.plan !== null ? String(orgRow.plan) : null,
    trialEndsAt:
      orgRow?.trial_ends_at !== undefined && orgRow.trial_ends_at !== null ? String(orgRow.trial_ends_at) : null,
    protectedFlag: idRow?.protected !== undefined && idRow.protected !== null ? Number(idRow.protected) : null,
    financeContact:
      idRow?.finance_contact_email !== undefined && idRow.finance_contact_email !== null
        ? String(idRow.finance_contact_email)
        : null,
    logoKey: idRow?.logo_r2_key !== undefined && idRow.logo_r2_key !== null ? String(idRow.logo_r2_key) : null,
    verifiedDomains: domainRows.map((r) => String(r.domain ?? "")).filter(Boolean),
    verifiedAddresses: addrRows.map((r) => String(r.address ?? "")).filter(Boolean),
    now: clock(),
  });
  if (!eligibility.ok) {
    return { exitCode: 1, reason: `ineligible:${eligibility.reasons.join(",")}`, orgId };
  }

  // 2. Provision the fixture seed idempotently and verify read-back.
  const startedAtDate = clock();
  const startedAt = startedAtDate.toISOString();
  await deps.query(
    `INSERT INTO monitor_seeds (org_id, host, path, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (org_id, host) DO UPDATE SET path = excluded.path`,
    [orgId, FIXTURE_HOST, FIXTURE_PATH, startedAt],
  );
  const seedBack = await deps.query("SELECT path FROM monitor_seeds WHERE org_id = ? AND host = ?", [
    orgId,
    FIXTURE_HOST,
  ]);
  if (String(seedBack[0]?.path ?? "") !== FIXTURE_PATH) {
    return { exitCode: 1, reason: "seed-readback-failed", orgId };
  }
  // Ensure the fixture host is due for capture in this execution even if an earlier run today observed it.
  await deps.query("UPDATE monitor_hosts SET captured_dns_hash = NULL WHERE org_id = ? AND domain = ?", [
    orgId,
    FIXTURE_HOST,
  ]);

  // 3. Create or join today's Workflow instance; if an instance for today already finished before this run,
  // start a fresh correlated instance with a unique runId suffix.
  const day = new Date(startedAtDate.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
  const priorRuns = await deps.query("SELECT finished_at FROM monitor_runs WHERE org_id = ? AND day = ?", [orgId, day]);
  const priorFinishedAt = priorRuns[0]?.finished_at ? String(priorRuns[0].finished_at) : null;
  let instanceId =
    priorFinishedAt && priorFinishedAt <= startedAt
      ? instanceIdFor(orgId, day, startedAtDate.getTime().toString(36))
      : instanceIdFor(orgId, day);
  let pollId = instanceId;
  const createFirst = await deps.api(`/accounts/${deps.account}/workflows/isitlegit-monitor/instances`, {
    method: "POST",
    body: JSON.stringify({ id: instanceId, params: { orgId, day, runId: instanceId } }),
  });
  if (!createFirst.ok && createFirst.status !== 409) {
    return { exitCode: 1, reason: `workflow-create-${createFirst.status}`, orgId, instanceId };
  }
  if (createFirst.ok) {
    const createdBody = (await createFirst.json().catch(() => null)) as { result?: { id?: string } } | null;
    if (createdBody?.result?.id) pollId = createdBody.result.id;
  } else if (createFirst.status === 409) {
    const statusRes = await deps.api(
      `/accounts/${deps.account}/workflows/isitlegit-monitor/instances/${encodeURIComponent(instanceId)}`,
    );
    const existingStatus = statusRes.ok ? parseWorkflowStatus((await statusRes.json().catch(() => null)) as never) : "";
    if (existingStatus === "complete" || existingStatus === "errored" || existingStatus === "terminated") {
      const suffix = startedAtDate.getTime().toString(36);
      instanceId = instanceIdFor(orgId, day, suffix);
      pollId = instanceId;
      const createCorrelated = await deps.api(`/accounts/${deps.account}/workflows/isitlegit-monitor/instances`, {
        method: "POST",
        body: JSON.stringify({ id: instanceId, params: { orgId, day, runId: instanceId } }),
      });
      if (!createCorrelated.ok) {
        return { exitCode: 1, reason: `workflow-create-${createCorrelated.status}`, orgId, instanceId };
      }
      const corrBody = (await createCorrelated.json().catch(() => null)) as { result?: { id?: string } } | null;
      if (corrBody?.result?.id) pollId = corrBody.result.id;
    }
  }

  // 4. Poll with bounded timeout.
  const deadline = clock().getTime() + options.waitSeconds * 1000;
  let status = "";
  while (clock().getTime() < deadline) {
    const res = await deps.api(
      `/accounts/${deps.account}/workflows/isitlegit-monitor/instances/${encodeURIComponent(pollId)}`,
    );
    if (res.ok) {
      status = parseWorkflowStatus((await res.json().catch(() => null)) as never);
      if (status === "complete") break;
      if (status === "errored" || status === "terminated") {
        return { exitCode: 1, reason: `workflow-${status}`, orgId, instanceId };
      }
    }
    await sleep(pollMs);
  }
  if (status !== "complete") {
    return { exitCode: 2, reason: `timeout:${status || "unknown"}`, orgId, instanceId };
  }

  // 5. Read back the run, capture, investigation, finding, and mail send, correlated to startedAt.
  const runs = await deps.query("SELECT run_id, outcome, finished_at FROM monitor_runs WHERE org_id = ? AND day = ?", [
    orgId,
    day,
  ]);
  const captures = await deps.query(
    "SELECT domain, capture_key, capture_url, captured_at FROM monitor_hosts WHERE org_id = ? AND domain = ?",
    [orgId, FIXTURE_HOST],
  );
  const investigations = await deps.query(
    "SELECT domain, capture_key, case_id, state, updated_at FROM monitor_investigations WHERE org_id = ? AND domain = ? ORDER BY updated_at DESC LIMIT 1",
    [orgId, FIXTURE_HOST],
  );
  const findings = await deps.query(
    "SELECT host, capture_key, case_id, outcome, alert_state, alerted_at FROM monitor_findings WHERE org_id = ? AND host = ?",
    [orgId, FIXTURE_HOST],
  );
  const sends = await deps.query("SELECT send_key, status FROM mail_sends WHERE send_key = ?", [
    `monitor-finding:${orgId}:${FIXTURE_HOST}`,
  ]);

  const proof: MonitorRunProof = {
    expectedRunId: instanceId,
    run: runs[0]
      ? {
          run_id: String(runs[0].run_id ?? ""),
          outcome: String(runs[0].outcome ?? ""),
          finished_at:
            runs[0].finished_at !== null && runs[0].finished_at !== undefined ? String(runs[0].finished_at) : null,
        }
      : null,
    capture: captures[0]
      ? {
          domain: String(captures[0].domain ?? ""),
          capture_key: captures[0].capture_key ? String(captures[0].capture_key) : null,
          capture_url: captures[0].capture_url ? String(captures[0].capture_url) : null,
          captured_at: captures[0].captured_at ? String(captures[0].captured_at) : null,
        }
      : null,
    investigation: investigations[0]
      ? {
          domain: String(investigations[0].domain ?? ""),
          capture_key: String(investigations[0].capture_key ?? ""),
          case_id: investigations[0].case_id ? String(investigations[0].case_id) : null,
          state: String(investigations[0].state ?? ""),
          updated_at: String(investigations[0].updated_at ?? ""),
        }
      : null,
    finding: findings[0]
      ? {
          host: String(findings[0].host ?? ""),
          capture_key: String(findings[0].capture_key ?? ""),
          case_id: findings[0].case_id ? String(findings[0].case_id) : null,
          outcome: String(findings[0].outcome ?? ""),
          alert_state: findings[0].alert_state ? String(findings[0].alert_state) : null,
          alerted_at: findings[0].alerted_at ? String(findings[0].alerted_at) : null,
        }
      : null,
    mailSend: sends[0]
      ? {
          send_key: String(sends[0].send_key ?? ""),
          status: String(sends[0].status ?? ""),
        }
      : null,
  };
  const verified = proofSatisfied(proof, startedAt);
  if (!verified.ok) {
    return {
      exitCode: 1,
      reason: verified.reason,
      orgId,
      instanceId,
      caseId: proof.investigation?.case_id ?? null,
      captureKey: proof.capture?.capture_key ?? null,
      alertedAt: proof.finding?.alerted_at ?? null,
      alertRecipient: eligibility.alertRecipient,
    };
  }
  return {
    exitCode: 0,
    orgId,
    instanceId,
    caseId: proof.investigation?.case_id ?? null,
    captureKey: proof.capture?.capture_key ?? null,
    alertedAt: proof.finding?.alerted_at ?? null,
    alertRecipient: eligibility.alertRecipient,
  };
}

async function resolveRunnerAuth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token: string; account: string; dbId: string } | null> {
  let token = env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  let account = env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  let dbId = env.D1_DATABASE_ID;

  if (!dbId) {
    try {
      const raw = readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf-8");
      const match = /"database_id"\s*:\s*"([0-9a-f-]+)"/i.exec(raw);
      if (match?.[1]) dbId = match[1];
    } catch {
      // ignore
    }
  }

  const home = env.HOME || homedir();
  const candidates = [
    join(home, ".config", ".wrangler", "config", "default.toml"),
    join(home, ".wrangler", "config", "default.toml"),
  ];
  const readTomlToken = () => {
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      try {
        const raw = readFileSync(file, "utf-8");
        const match = /oauth_token\s*=\s*"([^"]+)"/.exec(raw);
        if (match?.[1]) return match[1];
      } catch {
        // continue
      }
    }
    return undefined;
  };
  if (!token) token = readTomlToken();
  if (!token || !dbId) return null;

  const fetchAccount = async (bearer: string) => {
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { id?: string }[] };
    return body.result?.[0]?.id ?? null;
  };
  if (!account) {
    account = (await fetchAccount(token)) ?? undefined;
    if (!account) {
      spawnSync("pnpm", ["exec", "wrangler", "whoami"], { stdio: "ignore", timeout: 30_000 });
      token = readTomlToken();
      if (token) account = (await fetchAccount(token)) ?? undefined;
    }
  }
  return token && account && dbId ? { token, account, dbId } : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const orgIdx = args.indexOf("--org");
  const waitIdx = args.indexOf("--wait");
  const orgArg = orgIdx >= 0 ? (args[orgIdx + 1] ?? "") : "";
  const waitSeconds = waitIdx >= 0 ? Number(args[waitIdx + 1] ?? "300") : 300;
  if (!resolveTargetOrg(orgArg) || !Number.isFinite(waitSeconds) || waitSeconds <= 0) {
    console.error("usage: run-monitor.ts --org demo-fynbos|<org id> --wait <seconds>");
    process.exit(2);
  }
  const auth = await resolveRunnerAuth();
  if (!auth) {
    console.error("CF_API_TOKEN, CF_ACCOUNT_ID and D1_DATABASE_ID (or local Wrangler login) are required.");
    process.exit(2);
  }
  const api: Api = (path, init) =>
    fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  const query: D1Query = async (sql, params) => {
    const res = await api(`/accounts/${auth.account}/d1/database/${auth.dbId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    });
    if (!res.ok) throw new Error(`D1 query answered ${res.status}`);
    const body = (await res.json()) as { result?: { results?: Record<string, string | number | null>[] }[] };
    return body.result?.[0]?.results ?? [];
  };
  const outcome = await executeMonitorRun({ account: auth.account, api, query }, { orgArg, waitSeconds });
  console.log(
    JSON.stringify({
      event: "run-monitor",
      ok: outcome.exitCode === 0,
      orgId: outcome.orgId ?? null,
      instance: outcome.instanceId ?? null,
      caseId: outcome.caseId ?? null,
      captureKey: outcome.captureKey ?? null,
      alertedAt: outcome.alertedAt ?? null,
      alertRecipient: outcome.alertRecipient ?? null,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    }),
  );
  process.exit(outcome.exitCode);
}

if (process.argv[1]?.endsWith("run-monitor.ts")) await main();
