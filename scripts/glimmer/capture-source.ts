// The read-only source of day-zero case capture (D03 T04 §34): production D1 and R2, read through Wrangler.
//
// Production is never written. D1 is reached only through the fixed single-statement SELECT templates below, whose only
// variable parts are an id (matched against `ID`, so no caller-supplied SQL can reach the database) or a keyset
// position. R2 is read only for a key the case's own indexed `artefacts` rows name. A payload never enters argv or a
// log: objects go to a private temporary file inside the capture folder, are read back and removed.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CaptureSource, CaseDetail, CaseRow } from "./capture-cases.ts";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ADDRESS = /^[^\s'"\\<>]{1,200}@[^\s'"\\<>]{1,200}$/;
const KEY = /^[A-Za-z0-9._/@=+-]{1,400}$/;
const DATABASE = "isitlegit";
const BUCKET = "isitlegit-artefacts";

export const CASE_COLUMNS =
  "id, org_id, channel, source_kind, status, verdict, run_id, forwarded_by, uploaded_by, original_subject, " +
  "original_from_name, original_from_address, upload_name, upload_media_type, message_id, created_at, updated_at";

export function assertId(value: string): string {
  if (!ID.test(value)) throw new Error("capture: an id outside the allowed characters was refused");
  return value;
}

// The fixed SELECT templates. Each returns one statement; the only interpolated values are validated ids.
export const QUERY = {
  cases: (after: string | null, limit: number) =>
    `SELECT ${CASE_COLUMNS} FROM cases WHERE id > '${after === null ? "" : assertId(after)}' ORDER BY id LIMIT ${Math.min(
      Math.max(1, Math.trunc(limit)),
      200,
    )}`,
  row: (id: string) => `SELECT ${CASE_COLUMNS} FROM cases WHERE id = '${assertId(id)}'`,
  artefacts: (id: string) =>
    `SELECT r2_key, kind, sha256, media_type, bytes FROM artefacts WHERE case_id = '${assertId(id)}' ORDER BY r2_key`,
  evidence: (id: string) =>
    `SELECT id, run_id, seq, "check" AS check_name, severity, summary, detail_json, artefact_keys_json, created_at FROM evidence ` +
    `WHERE case_id = '${assertId(id)}' AND run_id = COALESCE((SELECT run_id FROM cases WHERE id = '${assertId(id)}'), '${assertId(id)}') ORDER BY seq`,
  checks: (id: string) =>
    `SELECT check_name, run_id, seq, outcome, reason, findings FROM check_outcomes ` +
    `WHERE case_id = '${assertId(id)}' AND run_id = COALESCE((SELECT run_id FROM cases WHERE id = '${assertId(id)}'), '${assertId(id)}') ORDER BY seq`,
  feedback: (id: string) =>
    `SELECT id, user_id, kind, note, providers_json, created_at, updated_at FROM feedback WHERE case_id = '${assertId(id)}' ORDER BY id`,
  verdict: (id: string) =>
    `SELECT verdict, headline, confidence, reasons, actions, source, created_at FROM case_verdicts WHERE case_id = '${assertId(id)}'`,
  members: (org: string, uploadedBy: string | null, forwardedBy: string | null) => {
    const tests = [
      uploadedBy ? `u.id = '${assertId(uploadedBy)}'` : null,
      forwardedBy && ADDRESS.test(forwardedBy) ? `lower(u.email) = lower('${forwardedBy}')` : null,
    ].filter(Boolean);
    if (!tests.length) return null;
    return (
      `SELECT u.name AS name, u.email AS email FROM "user" u JOIN "member" m ON m."userId" = u.id ` +
      `WHERE m."organizationId" = '${assertId(org)}' AND (${tests.join(" OR ")})`
    );
  },
};

export type Run = (args: string[], timeoutMs?: number) => { status: number | null; stdout: string; stderr: string };

const wrangler: Run = (args, timeoutMs = 120_000) => {
  // A hung command is killed at its deadline, so the run reaches its scheduled retry instead of holding forever.
  const done = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return { status: done.status, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
};

export function d1Rows<T>(stdout: string): T[] {
  const parsed = JSON.parse(stdout) as { results?: T[]; success?: boolean }[];
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.success === false)
    throw new Error("capture: D1 returned an unexpected answer");
  return parsed[0]?.results ?? [];
}

export function openWranglerSource(scratch: string, run: Run = wrangler): CaptureSource {
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const select = <T>(sql: string): T[] => {
    if (!/^SELECT /.test(sql) || sql.includes(";")) throw new Error("capture: only one SELECT statement is allowed");
    const done = run(["d1", "execute", DATABASE, "--remote", "--json", "--command", sql], 120_000);
    // Wrangler's own diagnostics may echo the command, so a failure reports its status and nothing else.
    if (done.status !== 0) throw new Error(`capture: a D1 read failed (status ${done.status})`);
    return d1Rows<T>(done.stdout);
  };
  return {
    async cases(after, limit) {
      return select<CaseRow>(QUERY.cases(after, limit));
    },
    async row(id) {
      return select<CaseRow>(QUERY.row(id))[0] ?? null;
    },
    async detail(row): Promise<CaseDetail> {
      const members = QUERY.members(row.org_id, row.uploaded_by, row.forwarded_by);
      return {
        artefacts: select(QUERY.artefacts(row.id)),
        evidence: select(QUERY.evidence(row.id)),
        checks: select(QUERY.checks(row.id)),
        feedback: select(QUERY.feedback(row.id)),
        verdict: select<CaseDetail["verdict"] & object>(QUERY.verdict(row.id))[0] ?? null,
        members: members ? select(members) : [],
      };
    },
    async object(key) {
      if (!KEY.test(key) || key.includes(".."))
        throw new Error("capture: an R2 key outside the allowed form was refused");
      const file = join(scratch, `object-${process.pid}-${Date.now()}`);
      try {
        const done = run(["r2", "object", "get", `${BUCKET}/${key}`, "--remote", "--file", file], 300_000);
        if (done.status !== 0) return null;
        return new Uint8Array(readFileSync(file));
      } catch {
        return null;
      } finally {
        rmSync(file, { force: true });
      }
    },
  };
}
