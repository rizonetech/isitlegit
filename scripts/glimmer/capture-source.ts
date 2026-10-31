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
// Any key the producer writes, spaces and non-ASCII letters included (attachment names are kept in keys), but never a
// control character, a leading slash or a `..` segment. It is also only ever asked for keys the case's own rows name.
const KEY = /^[^\p{Cc}/][^\p{Cc}]{0,1023}$/u;
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
  // One statement for everything a case holds, so a case costs one Wrangler call, not six: each part is a JSON array
  // built by SQLite from the case's own rows (the current run's evidence and outcomes, `COALESCE(cases.run_id, id)`).
  detail: (row: Pick<CaseRow, "id" | "org_id" | "uploaded_by" | "forwarded_by">) => {
    const id = assertId(row.id);
    const run = `COALESCE((SELECT run_id FROM cases WHERE id = '${id}'), '${id}')`;
    const tests = [
      row.uploaded_by ? `u.id = '${assertId(row.uploaded_by)}'` : null,
      row.forwarded_by && ADDRESS.test(row.forwarded_by) ? `lower(u.email) = lower('${row.forwarded_by}')` : null,
    ].filter(Boolean);
    const members = tests.length
      ? `(SELECT json_group_array(json_object('name', name, 'email', email)) FROM (SELECT u.name AS name, u.email AS email ` +
        `FROM "user" u JOIN "member" m ON m."userId" = u.id WHERE m."organizationId" = '${assertId(row.org_id)}' AND (${tests.join(" OR ")})))`
      : `'[]'`;
    return (
      `SELECT ` +
      `(SELECT json_group_array(json_object('r2_key', r2_key, 'kind', kind, 'sha256', sha256, 'media_type', media_type, 'bytes', bytes)) ` +
      `FROM (SELECT * FROM artefacts WHERE case_id = '${id}' ORDER BY r2_key)) AS artefacts, ` +
      `(SELECT json_group_array(json_object('id', id, 'run_id', run_id, 'seq', seq, 'check_name', "check", 'severity', severity, 'summary', summary, 'detail_json', detail_json, 'artefact_keys_json', artefact_keys_json, 'created_at', created_at)) ` +
      `FROM (SELECT * FROM evidence WHERE case_id = '${id}' AND run_id = ${run} ORDER BY seq)) AS evidence, ` +
      `(SELECT json_group_array(json_object('check_name', check_name, 'run_id', run_id, 'seq', seq, 'outcome', outcome, 'reason', reason, 'findings', findings)) ` +
      `FROM (SELECT * FROM check_outcomes WHERE case_id = '${id}' AND run_id = ${run} ORDER BY seq)) AS checks, ` +
      `(SELECT json_group_array(json_object('id', id, 'user_id', user_id, 'kind', kind, 'note', note, 'providers_json', providers_json, 'created_at', created_at, 'updated_at', updated_at)) ` +
      `FROM (SELECT * FROM feedback WHERE case_id = '${id}' ORDER BY id)) AS feedback, ` +
      `(SELECT json_object('verdict', verdict, 'headline', headline, 'confidence', confidence, 'reasons', reasons, 'actions', actions, 'source', source, 'created_at', created_at) ` +
      `FROM case_verdicts WHERE case_id = '${id}') AS verdict, ` +
      `${members} AS members`
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
      const got = select<Record<string, string | null>>(QUERY.detail(row))[0];
      if (!got) throw new Error("capture: a case's rows could not be read");
      const part = <T>(name: string, fallback: T): T => (got[name] ? (JSON.parse(got[name] as string) as T) : fallback);
      return {
        artefacts: part("artefacts", []),
        evidence: part("evidence", []),
        checks: part("checks", []),
        feedback: part("feedback", []),
        verdict: part("verdict", null),
        members: part("members", []),
      };
    },
    async object(key) {
      if (!KEY.test(key) || /(^|\/)\.\.(\/|$)/.test(key))
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
