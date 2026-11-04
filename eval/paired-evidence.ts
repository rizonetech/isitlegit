// Read-only paired evidence (D08 T02 section 15). Public projection only, scoped to the authenticated eval member.
import { z } from "zod";
import { inlineLong, type Statement } from "../src/meta/budget-sql.ts";
import { checkStored, compareRuns, pairForCompare } from "./metrics.ts";
import { type Api, type Db, liveApi, liveDb, type ResultRow, type RunRow } from "./run.ts";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Plain = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u.test(s));
const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
const EvidenceSchema = z.strictObject({
  id: z
    .string()
    .max(32)
    .regex(/^E[1-9][0-9]*$/),
  check: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
  severity: z.enum(SEVERITIES),
  summary: Plain,
});
export type PublicEvidence = z.infer<typeof EvidenceSchema>;
const SnapshotSchema = z.strictObject({
  caseId: Id,
  analysisRun: Id,
  status: z.enum(["received", "running", "done", "partial"]),
  verdict: z.enum(["safe", "suspicious", "malicious"]).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  evidence: z.array(EvidenceSchema).max(1000),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type EvidenceReader = (orgId: string, userId: string, caseId: string) => Promise<Snapshot | null>;
export type PairedDeps = {
  api: Pick<Api, "whoami">;
  db: Pick<Db, "orgId" | "memberships" | "readRun">;
  evidence: EvidenceReader;
};
type Change = {
  kind: "unchanged" | "severity-changed" | "removed" | "added";
  source: PublicEvidence | null;
  replay: PublicEvidence | null;
};
type Group = { check: string; changes: Change[] };
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ordered = (a: PublicEvidence, b: PublicEvidence) =>
  lexical(a.summary, b.summary) ||
  SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
  (BigInt(a.id.slice(1)) < BigInt(b.id.slice(1)) ? -1 : BigInt(a.id.slice(1)) > BigInt(b.id.slice(1)) ? 1 : 0);
export function alignEvidence(source: PublicEvidence[], replay: PublicEvidence[]): Group[] {
  const checks = [...new Set([...source, ...replay].map((e) => e.check))].sort(lexical);
  return checks.map((check) => {
    const left = source.filter((e) => e.check === check).sort(ordered);
    const right = replay.filter((e) => e.check === check).sort(ordered);
    const changes: Change[] = [];
    const unmatched: PublicEvidence[] = [];
    for (const item of left) {
      const index = right.findIndex((other) => other.summary === item.summary && other.severity === item.severity);
      if (index < 0) unmatched.push(item);
      else changes.push({ kind: "unchanged", source: item, replay: right.splice(index, 1)[0] ?? null });
    }
    for (const item of unmatched) {
      const index = right.findIndex((other) => other.summary === item.summary);
      changes.push(
        index < 0
          ? { kind: "removed", source: item, replay: null }
          : { kind: "severity-changed", source: item, replay: right.splice(index, 1)[0] ?? null },
      );
    }
    for (const item of right) changes.push({ kind: "added", source: null, replay: item });
    return { check, changes };
  });
}

// One SQLite statement pins the case and its current analysis evidence to the same read snapshot.
// Membership is checked here too, so a revoked membership cannot use the earlier command preflight.
export function liveEvidenceReader(
  execute: (s: Statement) => Promise<{ results?: Record<string, unknown>[] }>,
): EvidenceReader {
  return async (orgId, userId, caseId) => {
    const row = (
      await execute({
        sql: `SELECT c.id AS caseId,COALESCE(c.run_id,c.id) AS analysisRun,c.status,c.verdict,
        c.created_at AS createdAt,c.updated_at AS updatedAt,
        (SELECT json_group_array(json_object('id',e.id,'check',e."check",'severity',e.severity,'summary',e.summary))
         FROM (SELECT id,"check",severity,summary FROM evidence WHERE case_id=c.id AND run_id=COALESCE(c.run_id,c.id) ORDER BY seq LIMIT 1001) e) AS evidenceJson
        FROM cases c WHERE c.id=?1 AND c.org_id=?2 AND EXISTS
        (SELECT 1 FROM member m WHERE m.userId=?3 AND m.organizationId=c.org_id)`,
        params: [caseId, orgId, userId],
      })
    ).results?.[0];
    if (!row) return null;
    return SnapshotSchema.parse({
      caseId: row.caseId,
      analysisRun: row.analysisRun,
      status: row.status,
      verdict: row.verdict,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      evidence: JSON.parse(String(row.evidenceJson)),
    });
  };
}
type Side = {
  status: "available" | "unavailable";
  reason: string | null;
  caseId: string | null;
  analysisRun: string | null;
  verdict: string | null;
  report: string | null;
  evidence: PublicEvidence[];
};
const unavailable = (reason: string): Side => ({
  status: "unavailable",
  reason,
  caseId: null,
  analysisRun: null,
  verdict: null,
  report: null,
  evidence: [],
});
async function readSide(d: PairedDeps, orgId: string, userId: string, row: ResultRow, run: RunRow): Promise<Side> {
  if (!row.caseId) return unavailable("No case was recorded for this side.");
  if (!Id.safeParse(row.caseId).success) return unavailable("The recorded case identity is invalid.");
  try {
    const raw = await d.evidence(orgId, userId, row.caseId);
    if (!raw) return unavailable("The case is missing or not accessible under your current membership.");
    const snap = SnapshotSchema.parse(raw);
    const start = Date.parse(snap.createdAt),
      end = Date.parse(snap.updatedAt),
      finish = Date.parse(run.finishedAt ?? "");
    if (snap.caseId !== row.caseId || new Set(snap.evidence.map((e) => e.id)).size !== snap.evidence.length)
      return unavailable("The stored evidence identity is inconsistent.");
    if (
      ![start, end, finish].every(Number.isFinite) ||
      end < start ||
      end > finish ||
      row.ms !== end - start ||
      snap.status !== row.outcome ||
      snap.verdict !== row.verdict ||
      snap.verdict === null
    )
      return unavailable(
        "The analysis changed or cannot be bound to the recorded measurement; rerun the evaluation before pairing it.",
      );
    return {
      status: "available",
      reason: null,
      caseId: snap.caseId,
      analysisRun: snap.analysisRun,
      verdict: snap.verdict,
      report: `https://app.isitlegit.co.za/cases/${encodeURIComponent(snap.caseId)}`,
      evidence: [...snap.evidence].sort((a, b) => lexical(a.check, b.check) || ordered(a, b)),
    };
  } catch {
    return unavailable("This side could not be read safely. Retry the read-only command.");
  }
}
const NOTICE =
  "Report links require membership. Evidence changes do not prove why a model changed its verdict. Evidence IDs belong to each case separately.";
export const USAGE =
  "usage: node eval/paired-evidence.ts --replay <run-id> --sample <set-qualified-id> [--json]\nExit 0 both sides available, 2 partial/unavailable, 3 refused. Read-only; no model calls.";
export type PairedOutput = {
  sample: string;
  sourceRun: string;
  replayRun: string;
  sourceCommit: string;
  replayCommit: string;
  source: Side;
  replay: Side;
  alignment: Group[] | null;
  notice: string;
};
export function renderPaired(value: PairedOutput): string {
  const lines = [
    `Paired evidence: ${value.sample}`,
    `Source run: ${value.sourceRun} (${value.sourceCommit})`,
    `Replay run: ${value.replayRun} (${value.replayCommit})`,
  ];
  for (const name of ["source", "replay"] as const) {
    const side = value[name];
    lines.push(`${name}: ${side.status === "available" ? side.verdict : side.reason}`);
    if (side.report) lines.push(`${name} report: ${side.report}`);
    if (side.status === "available" && !side.evidence.length) lines.push(`${name} evidence: empty`);
    for (const e of side.evidence) lines.push(`  ${name} ${e.check} ${e.id} [${e.severity}]: ${e.summary}`);
  }
  if (value.alignment === null) lines.push("Alignment unavailable: one or both sides could not be read.");
  else
    for (const group of value.alignment)
      for (const change of group.changes)
        lines.push(
          `${group.check}: ${change.kind}; source ${change.source?.id ?? "none"}; replay ${change.replay?.id ?? "none"}`,
        );
  lines.push(value.notice);
  return `${lines.join("\n")}\n`;
}
export async function pairedCommand(
  argv: string[],
  d?: PairedDeps,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const refuse = (message: string) => ({ code: 3, stdout: "", stderr: `paired-evidence: ${message}\n` });
  if (argv.length === 1 && argv[0] === "--help") return { code: 0, stdout: `${USAGE}\n`, stderr: "" };
  let replayId = "",
    sample = "",
    json = false;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag || seen.has(flag)) return refuse("duplicate or invalid option");
    seen.add(flag);
    if (flag === "--json") json = true;
    else if (flag === "--replay") replayId = argv[++i] ?? "";
    else if (flag === "--sample") sample = argv[++i] ?? "";
    else return refuse("unknown option; use --help");
  }
  if (!/^[a-z0-9-]{8,64}$/.test(replayId) || !Plain.safeParse(sample).success || !/^[^/]+\/.+/.test(sample))
    return refuse("a bounded replay ID and set-qualified sample are required; use --help");
  try {
    if (!d) {
      const cookie = environment.EVAL_SESSION_COOKIE;
      if (!cookie) return refuse("EVAL_SESSION_COOKIE is required");
      const { execute } = await import("../scripts/lib/meta-budget.ts");
      const read = (s: Statement) => execute({ sql: inlineLong(s), params: [] });
      d = {
        api: liveApi(environment.EVAL_BASE_URL ?? "https://app.isitlegit.co.za", cookie),
        db: liveDb(environment.EVAL_ORG_NAME ?? "IsItLegit Eval", read),
        evidence: liveEvidenceReader(read),
      };
    }
    const user = await d.api.whoami();
    if (!user) return refuse("sign in to the eval organisation first");
    const org = await d.db.orgId(),
      memberships = await d.db.memberships(user);
    if (memberships.length !== 1 || memberships[0] !== org)
      return refuse("the session must belong to the eval organisation alone");
    const replay = checkStored(await d.db.readRun(replayId), replayId);
    if (typeof replay === "string" || !replay.run.mode.startsWith("replay:"))
      return refuse("the stored replay is missing or invalid");
    const sourceId = replay.run.mode.slice(7);
    const source = checkStored(await d.db.readRun(sourceId), sourceId);
    if (typeof source === "string" || pairForCompare(source, replay))
      return refuse("source and replay are not a fully measured matching population");
    if (![source.run.commitSha, replay.run.commitSha].every((sha) => /^[a-f0-9]{7,64}$/.test(sha)))
      return refuse("stored deployment identities are invalid");
    const changed = compareRuns(source, replay).changed.find((row) => row.sample === sample);
    if (!changed) return refuse("sample is unknown or its verdict did not change");
    const a = source.results.find((row) => row.sample === sample),
      b = replay.results.find((row) => row.sample === sample);
    if (!a || !b) return refuse("sample binding is missing");
    const [left, right] = await Promise.all([
      readSide(d, org, user, a, source.run),
      readSide(d, org, user, b, replay.run),
    ]);
    const available = left.status === "available" && right.status === "available";
    const value: PairedOutput = {
      sample,
      sourceRun: sourceId,
      replayRun: replayId,
      sourceCommit: source.run.commitSha,
      replayCommit: replay.run.commitSha,
      source: left,
      replay: right,
      alignment: available ? alignEvidence(left.evidence, right.evidence) : null,
      notice: NOTICE,
    };
    return {
      code: available ? 0 : 2,
      stdout: json ? `${JSON.stringify(value, null, 2)}\n` : renderPaired(value),
      stderr: "",
    };
  } catch {
    return refuse("the comparison could not be read safely; retry this read-only command");
  }
}
export async function main(
  argv: string[],
  d?: PairedDeps,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const out = await pairedCommand(argv, d, environment);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  return out.code;
}
if (process.argv[1] === import.meta.filename)
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
