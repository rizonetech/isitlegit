// The deployed service's limits, exercised from outside with synthetic inputs (D09 T01 §1). Run by the coordinator,
// never by a lane, once the operator approves: it changes production (one admitted case, one cap set and restored, an
// IP locked out of three sign-in buckets for a window, one oversized message sent).
//
//   ISITLEGIT_SESSION=<cookie header> SMTP2GO_API_KEY=<key> \
//   node eval/launch/check-limits.ts --confirm-production --org <test organisation id> [--only <check,...>]
//                                    [--base-url https://app.isitlegit.co.za]
//
// Checks: upload-size, daily-cap, sign-in-confirm-rate, sign-in-code-rate, passkey-options-rate, mail-size,
// r2-lifecycle. One line each (`ok <check>: <evidence>`, `FAIL <check>: <why>` or `skipped <check>: <why>`), progress
// at least once a minute through the sign-in waits (the three buckets wait together, about 21 minutes), and a run
// record (secret-free JSON: times, target, every response and id observed, the cap's restoration) printed last and
// kept in the launch folder (`~/isitlegit-data/launch/`, `ISITLEGIT_LAUNCH_DIR` moves it) for docs/live-checks.md. Exit
// 0 only when every check run is ok, 1 otherwise, 2 for a bad argument. The session cookie and the SMTP2GO key come from
// the environment only and are never printed. The live D1 is read and written through the operator's Wrangler login.
//
// The cap check writes its recovery record (the row as first read and the SQL that restores it) to the launch folder
// before it changes anything, and refuses to change anything when it cannot; a run interrupted by Ctrl+C or SIGTERM
// restores before it exits, and every run first restores what an earlier run left unrestored.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { execute } from "../../scripts/lib/meta-budget.ts";
import { runCommand } from "../../scripts/smoke.ts";
import type { Statement } from "../../src/meta/budget-sql.ts";
import { sastDayStart } from "./sast-day.ts";

export const CHECKS = [
  "upload-size",
  "daily-cap",
  "sign-in-confirm-rate",
  "sign-in-code-rate",
  "passkey-options-rate",
  "mail-size",
  "r2-lifecycle",
] as const;
export type CheckName = (typeof CHECKS)[number];
export type Evidence = Record<string, string | number | boolean | null>;
export type Outcome = { check: CheckName; result: "ok" | "FAIL" | "skipped"; why: string; evidence: Evidence };

export const MIB = 1024 * 1024;
export const UPLOAD_LIMIT = 25 * MIB; // src/intake/upload.ts MAX_UPLOAD_BYTES
export const UPLOAD_TOO_LARGE = "The file is larger than 25 MB, which is the most that can be checked.";
export const CAP_MESSAGE = "Today's checks for your organisation are used up. They reset at midnight.";
export const RATE_MAX = 20; // src/auth/ratelimit.ts LINK_MAX, a 600 s window
export const RATE_WINDOW_MS = 600_000;
export const MAX_WINDOW_WAIT_MS = 11 * 60_000;
export const BUCKET = "isitlegit-artefacts";
export const MAIL_TO = "check@isitlegit.co.za";
export const MAIL_FROM = "alerts@isitlegit.co.za";
export const MAIL_WAIT_MS = 10 * 60_000;
// A rejection the size caused: the Worker's own reason (src/intake/email.ts) or an SMTP refusal that names the size.
// A bare 552 is not enough: 552 5.2.2 is a full mailbox (completion review).
export const SIZE_REASON =
  /message too large|message size exceeds|exceeds? (the )?(maximum )?(message )?size|size limit|\b5\.3\.4\b/i;
// SMTP2GO's final activity events (https://developers.smtp2go.com/reference/search-activity); a soft bounce is retried.
export const FINAL_EVENTS = ["delivered", "hard-bounced", "rejected"];
export const REQUEST_MS = 120_000; // a 25 MiB upload included
export const BODY_MAX = 64 * 1024; // the most of any answer read
const SMTP2GO = "https://api.smtp2go.com/v3";

export type Sql = (statement: Statement) => Promise<Record<string, unknown>[]>;
export type LimitsDeps = {
  base: string;
  org: string;
  session: string;
  smtp2goKey: string | null;
  runId: string;
  fetch: typeof fetch;
  sql: Sql;
  wrangler: (args: string[]) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  // The cap's recovery record, kept outside the repository before the cap is changed.
  state: RecoveryStore;
};

export type Recovery = { runId: string; org: string; at: string; original: LimitsRow; restore: Statement };
export type RecoveryStore = {
  read(): Recovery | null;
  write(record: Recovery): void;
  remove(): void;
};

export const launchDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.ISITLEGIT_LAUNCH_DIR || join(env.HOME || homedir(), "isitlegit-data", "launch");

// JSON written temp-file-then-rename, so a crash never leaves half a file.
export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
  renameSync(tmp, file);
}

// The recovery record as a file in the launch folder.
export function fileStore(file: string): RecoveryStore {
  return {
    read: () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Recovery) : null),
    write: (record) => writeJsonAtomic(file, record),
    remove: () => rmSync(file, { force: true }),
  };
}

// The SQL a run sends, made stoppable: once `stop()` is called no new statement starts (each throws), and `stop()`
// resolves only after every statement already sent has settled, so a restoration that follows can never be
// overwritten by a change still on its way (round 1).
export function stoppable(sql: Sql): { sql: Sql; stop: () => Promise<void> } {
  const inflight = new Set<Promise<unknown>>();
  let stopped = false;
  return {
    sql: (statement) => {
      if (stopped) return Promise.reject(new Error("the run was interrupted; no further SQL is sent"));
      const sent = sql(statement);
      inflight.add(sent);
      const forget = () => inflight.delete(sent);
      sent.then(forget, forget);
      return sent;
    },
    stop: async () => {
      stopped = true;
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
}

// One way out of the process (round 2): an interruption's recovery is started once, and the run's own end waits for
// it, so the process never exits while a restoration is still on its way.
export function exitGate(exit: (code: number) => void) {
  let recovering: Promise<void> | null = null;
  return {
    interrupt(recover: () => Promise<void>) {
      recovering ??= recover().finally(() => exit(130));
      return recovering;
    },
    async finish(code: number) {
      if (recovering) return recovering;
      exit(code);
    },
  };
}

// Every request bounded in time, and every answer read only so far.
export const timed =
  (fetchImpl: typeof fetch, ms = REQUEST_MS): typeof fetch =>
  (input, init) =>
    fetchImpl(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms),
    });
export async function bodyText(answer: Response, max = BODY_MAX): Promise<string> {
  if (!answer.body) return "";
  const reader = answer.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}
const bodyJson = async <T>(answer: Response): Promise<T | null> => {
  try {
    return JSON.parse(await bodyText(answer)) as T;
  } catch {
    return null;
  }
};

// A wait the operator can follow: what it waits for and when it resumes, then a line at least once a minute.
async function wait(deps: LimitsDeps, ms: number, why: string): Promise<void> {
  const until = new Date(deps.now().getTime() + ms);
  deps.log(`waiting ${Math.round(ms / 1000)} s: ${why} (resumes about ${until.toISOString()})`);
  for (let left = ms; left > 0; left -= 60_000) {
    await deps.sleep(Math.min(60_000, left));
    if (left > 60_000) deps.log(`  still waiting: ${Math.round((left - 60_000) / 1000)} s left`);
  }
}

export type LimitsArgs = { base: string; org: string; only: CheckName[] };

// The whole argument list, strictly: nothing runs without --confirm-production and an organisation.
export function parseLimitsArgs(argv: string[]): LimitsArgs | { error: string } {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "confirm-production": { type: "boolean" },
        org: { type: "string" },
        only: { type: "string" },
        "base-url": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (values["confirm-production"] !== true)
    return { error: "--confirm-production is required: this changes production" };
  const org = values.org as string | undefined;
  if (!org || !/^[\w-]{1,64}$/.test(org)) return { error: "--org names the test organisation's id" };
  const base = ((values["base-url"] as string | undefined) ?? "https://app.isitlegit.co.za").replace(/\/+$/, "");
  if (!/^https:\/\/[\w.-]+$/.test(base)) return { error: "--base-url is an https origin" };
  const only = values.only ? (values.only as string).split(",").map((s) => s.trim()) : [...CHECKS];
  const unknown = only.filter((c) => !(CHECKS as readonly string[]).includes(c));
  if (unknown.length) return { error: `unknown check ${unknown.join(", ")}` };
  return { base, org, only: only as CheckName[] };
}

const ok = (check: CheckName, why: string, evidence: Evidence = {}): Outcome => ({
  check,
  result: "ok",
  why,
  evidence,
});
const fail = (check: CheckName, why: string, evidence: Evidence = {}): Outcome => ({
  check,
  result: "FAIL",
  why,
  evidence,
});

// The session's own organisation must be the approved test organisation, and exist, before anything is changed.
export async function preflight(deps: LimitsDeps): Promise<string | null> {
  let body: { session?: { activeOrganizationId?: string | null } } | null;
  try {
    const answer = await deps.fetch(`${deps.base}/api/auth/get-session`, { headers: { cookie: deps.session } });
    if (answer.status !== 200) return `the session could not be read (HTTP ${answer.status})`;
    body = await bodyJson<NonNullable<typeof body>>(answer);
  } catch (error) {
    return `the session could not be read (${(error as Error).name})`;
  }
  if (!body?.session) return "the session is not signed in";
  if (body.session.activeOrganizationId !== deps.org)
    return "the session's active organisation is not --org; nothing was changed";
  const rows = await deps.sql({ sql: 'SELECT id FROM "organization" WHERE id = ?1', params: [deps.org] });
  return rows.length === 1 ? null : "--org names no organisation in the live database";
}

const casesToday = async (deps: LimitsDeps) =>
  Number(
    (
      await deps.sql({
        sql: "SELECT COUNT(*) AS n FROM cases WHERE org_id = ?1 AND created_at >= ?2",
        params: [deps.org, sastDayStart(deps.now())],
      })
    )[0]?.n ?? Number.NaN,
  );

const form = (name: string, type: string, bytes: Uint8Array<ArrayBuffer>) => {
  const body = new FormData();
  body.set("file", new File([bytes], name, { type }));
  return body;
};

// 25 MiB and a byte, once with a declared length and once streamed without one: both refused with 413, no case made.
export async function uploadSize(deps: LimitsDeps): Promise<Outcome> {
  const check = "upload-size";
  const before = await casesToday(deps);
  const bytes = new Uint8Array(UPLOAD_LIMIT + 1);
  const declared = new Request(`${deps.base}/api/upload`, {
    method: "POST",
    headers: { cookie: deps.session, origin: deps.base },
    body: form(`limits-check-${deps.runId}.pdf`, "application/pdf", bytes),
  });
  const encoded = new Uint8Array(await declared.arrayBuffer());
  const contentType = declared.headers.get("content-type") as string;
  const sends: [string, RequestInit][] = [
    [
      "declared",
      {
        method: "POST",
        headers: {
          cookie: deps.session,
          origin: deps.base,
          "content-type": contentType,
          "content-length": String(encoded.length),
        },
        body: encoded,
      },
    ],
    [
      "streamed",
      {
        method: "POST",
        headers: { cookie: deps.session, origin: deps.base, "content-type": contentType },
        body: new Blob([encoded]).stream(),
        duplex: "half",
      } as RequestInit,
    ],
  ];
  const evidence: Evidence = { bytes: UPLOAD_LIMIT + 1, casesBefore: before };
  for (const [how, init] of sends) {
    const answer = await deps.fetch(`${deps.base}/api/upload`, init);
    const text = await bodyText(answer);
    evidence[how] = answer.status;
    if (answer.status !== 413) return fail(check, `${how}: HTTP ${answer.status}, not 413`, evidence);
    if (!text.includes(UPLOAD_TOO_LARGE))
      return fail(check, `${how}: 413 without the upload route's message`, evidence);
  }
  const after = await casesToday(deps);
  evidence.casesAfter = after;
  if (after !== before) return fail(check, `the organisation's cases today moved from ${before} to ${after}`, evidence);
  return ok(check, "413 declared and streamed, no case", evidence);
}

export type LimitsRow = { daily_cases: number; plan: string | null; trial_ends_at: string | null } | null;
const readLimits = async (deps: LimitsDeps): Promise<LimitsRow> => {
  const rows = await deps.sql({
    sql: "SELECT daily_cases, plan, trial_ends_at FROM org_limits WHERE org_id = ?1",
    params: [deps.org],
  });
  const row = rows[0];
  return row
    ? {
        daily_cases: Number(row.daily_cases),
        plan: (row.plan as string | null) ?? null,
        trial_ends_at: (row.trial_ends_at as string | null) ?? null,
      }
    : null;
};
// The SQL that puts the row back as it was first read, printed when a restoration fails.
export const restoreStatement = (org: string, original: LimitsRow): Statement =>
  original
    ? { sql: "UPDATE org_limits SET daily_cases = ?1 WHERE org_id = ?2", params: [original.daily_cases, org] }
    : { sql: "DELETE FROM org_limits WHERE org_id = ?1", params: [org] };

// A small synthetic message, distinct for each run and each upload, so intake's repeat detection never answers it.
export const syntheticEml = (runId: string, n: number) =>
  new TextEncoder().encode(
    [
      `From: Limits Check <limits-check@example.invalid>`,
      `To: Accounts <accounts@example.invalid>`,
      `Subject: IsItLegit limits check ${runId} upload ${n}`,
      `Message-ID: <limits-check-${runId}-${n}@example.invalid>`,
      `Date: ${new Date().toUTCString()}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      `A synthetic message for the daily cap check, run ${runId}, upload ${n}. Nothing to act on.`,
      "",
    ].join("\r\n"),
  );

// Puts back the row a recovery record holds and reads it back; null when restored, else the SQL that repairs it.
async function restoreFrom(deps: LimitsDeps, record: Recovery): Promise<string | null> {
  let restored: LimitsRow | undefined;
  try {
    await deps.sql(record.restore);
    restored = await readLimits({ ...deps, org: record.org });
  } catch {
    restored = undefined;
  }
  if (JSON.stringify(restored) !== JSON.stringify(record.original))
    return `wrangler d1 execute isitlegit --remote --command ${JSON.stringify(inlineSql(record.restore))}`;
  deps.state.remove();
  return null;
}

// What an earlier, interrupted run left unrestored, restored before anything else; null when there was nothing or it
// is restored, else why the run must stop.
export async function recoverPending(deps: LimitsDeps): Promise<string | null> {
  let record: Recovery | null;
  try {
    record = deps.state.read();
  } catch (error) {
    return `the recovery record cannot be read (${(error as Error).message}); restore by hand before running again`;
  }
  if (!record) return null;
  const repair = await restoreFrom(deps, record);
  if (repair) return `run ${record.runId} left the cap changed and it could not be restored; run: ${repair}`;
  deps.log(`restored the cap run ${record.runId} left changed`);
  return null;
}

// The cap set to today's count plus one: one upload admitted, the next refused; then the cap restored and read back
// on every path, a restoration that fails overriding any outcome with the exact SQL that repairs it. Nothing is
// changed until the recovery record is written.
export async function dailyCap(deps: LimitsDeps): Promise<Outcome> {
  const check = "daily-cap";
  const original = await readLimits(deps);
  const record: Recovery = {
    runId: deps.runId,
    org: deps.org,
    at: deps.now().toISOString(),
    original,
    restore: restoreStatement(deps.org, original),
  };
  try {
    deps.state.write(record);
  } catch (error) {
    return fail(check, `the recovery record could not be written (${(error as Error).message}); nothing was changed`);
  }
  const evidence: Evidence = { original: original ? original.daily_cases : null };
  let result: Outcome;
  try {
    result = await capAttempt(deps, original, evidence);
  } catch (error) {
    result = fail(check, `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300), evidence);
  }
  const repair = await restoreFrom(deps, record);
  evidence.restored = repair === null;
  if (repair) return fail(check, `the cap was not restored; run: ${repair}`, evidence);
  return { ...result, evidence };
}

async function capAttempt(deps: LimitsDeps, original: LimitsRow, evidence: Evidence): Promise<Outcome> {
  const check = "daily-cap";
  const before = await casesToday(deps);
  if (!Number.isFinite(before)) return fail(check, "today's case count could not be read");
  const cap = before + 1;
  Object.assign(evidence, { casesBefore: before, cap });
  await deps.sql(
    original
      ? { sql: "UPDATE org_limits SET daily_cases = ?1 WHERE org_id = ?2", params: [cap, deps.org] }
      : { sql: "INSERT INTO org_limits (org_id, daily_cases) VALUES (?1, ?2)", params: [deps.org, cap] },
  );
  const upload = (n: number) =>
    deps.fetch(`${deps.base}/api/upload`, {
      method: "POST",
      headers: { cookie: deps.session, origin: deps.base },
      body: form(`limits-check-${deps.runId}-${n}.eml`, "message/rfc822", syntheticEml(deps.runId, n)),
    });
  const first = await upload(1);
  const firstBody = (await bodyJson<{ caseId?: string }>(first)) ?? {};
  Object.assign(evidence, { first: first.status, caseId: firstBody.caseId ?? null });
  if (first.status !== 201 || !firstBody.caseId)
    return fail(check, `the first upload answered HTTP ${first.status}, not 201`);
  const owner = await deps.sql({ sql: "SELECT org_id FROM cases WHERE id = ?1", params: [firstBody.caseId] });
  if (owner[0]?.org_id !== deps.org) return fail(check, "the admitted case is not in the test organisation");
  const middle = await casesToday(deps);
  if (middle !== before + 1) return fail(check, `the first upload moved the count by ${middle - before}, not 1`);
  const second = await upload(2);
  const secondText = await bodyText(second);
  const after = await casesToday(deps);
  Object.assign(evidence, { second: second.status, casesAfter: after });
  if (second.status !== 429) return fail(check, `the upload past the cap answered HTTP ${second.status}, not 429`);
  if (!secondText.includes(CAP_MESSAGE)) return fail(check, "429 without the cap's message");
  if (after !== middle) return fail(check, "the refused upload created a case");
  return ok(check, `case ${firstBody.caseId} admitted at cap ${cap}, the next refused`);
}

const inlineSql = (s: Statement) =>
  s.sql.replace(/\?(\d+)/g, (_, n: string) => {
    const v = s.params[Number(n) - 1];
    return typeof v === "number" ? String(v) : v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
  });

type RateTarget = { check: CheckName; request: (deps: LimitsDeps) => Promise<Response>; expect: number };
export const RATE_TARGETS: RateTarget[] = [
  {
    check: "sign-in-confirm-rate",
    expect: 400,
    request: (deps) =>
      deps.fetch(`${deps.base}/signin/confirm`, {
        method: "POST",
        headers: { origin: deps.base, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: randomBytes(16).toString("hex"), callbackURL: "/cases" }),
        redirect: "manual",
      }),
  },
  {
    check: "sign-in-code-rate",
    expect: 400,
    request: (deps) =>
      deps.fetch(`${deps.base}/signin/code`, {
        method: "POST",
        headers: { origin: deps.base, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "limits-check@example.invalid", code: "000000", callbackURL: "/cases" }),
        redirect: "manual",
      }),
  },
  {
    check: "passkey-options-rate",
    expect: 200,
    request: (deps) => deps.fetch(`${deps.base}/api/auth/passkey/generate-authenticate-options`, { method: "GET" }),
  },
];

// Seconds until the window ends, from a 429's Retry-After or its page ("try again in N seconds"), or null.
const windowLeftMs = async (answer: Response): Promise<number | null> => {
  const header = Number(answer.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const match = (await bodyText(answer)).match(/(\d+)\s*(second|minute)/i);
  if (!match) return null;
  return Number(match[1]) * (match[2]?.toLowerCase().startsWith("minute") ? 60_000 : 1000);
};
const windowWait = (ms: number | null) => Math.min((ms ?? RATE_WINDOW_MS) + 2_000, MAX_WINDOW_WAIT_MS);

// Per-IP buckets from a fresh window, each independent, their waits taken together: run each out, wait the longest
// window reported, then 20 answered and a 21st refused on each, wait again, then each answers as it should once more.
export async function rateLimits(deps: LimitsDeps, targets: RateTarget[]): Promise<Outcome[]> {
  const results = new Map<CheckName, Outcome>();
  const evidence = new Map<CheckName, Evidence>(targets.map((t) => [t.check, {}]));
  const live = () => targets.filter((t) => !results.has(t.check));
  const end = (t: RateTarget, why: string) => results.set(t.check, fail(t.check, why, evidence.get(t.check)));
  deps.log(`sign-in buckets: running out ${targets.map((t) => t.check).join(", ")}`);
  let longest = 0;
  for (const t of live()) {
    let left: number | null = null;
    let sent = 0;
    for (; sent <= RATE_MAX + 1; ) {
      const answer = await t.request(deps);
      sent++;
      if (answer.status === 403) {
        end(t, "HTTP 403: the request's Origin was refused");
        break;
      }
      if (answer.status === 429) {
        left = await windowLeftMs(answer);
        break;
      }
    }
    (evidence.get(t.check) as Evidence).runOut = sent;
    longest = Math.max(longest, windowWait(left));
  }
  if (live().length) await wait(deps, longest, "the sign-in buckets' windows to close");
  longest = 0;
  for (const t of live()) {
    const ev = evidence.get(t.check) as Evidence;
    let n = 1;
    for (; n <= RATE_MAX; n++) {
      const answer = await t.request(deps);
      if (answer.status === 429) {
        end(t, `request ${n} of a fresh window was refused`);
        break;
      }
      if (answer.status !== t.expect) {
        end(t, `request ${n} answered HTTP ${answer.status}, not ${t.expect}`);
        break;
      }
    }
    if (results.has(t.check)) continue;
    const over = await t.request(deps);
    ev.answered = RATE_MAX;
    ev.over = over.status;
    if (over.status !== 429) end(t, `request ${RATE_MAX + 1} answered HTTP ${over.status}, not 429`);
    else longest = Math.max(longest, windowWait(await windowLeftMs(over)));
  }
  if (live().length) await wait(deps, longest, "the windows that refused the 21st requests to close");
  for (const t of live()) {
    const again = await t.request(deps);
    (evidence.get(t.check) as Evidence).after = again.status;
    if (again.status !== t.expect) end(t, `after the window it answered HTTP ${again.status}, not ${t.expect}`);
    else
      results.set(
        t.check,
        ok(
          t.check,
          `${RATE_MAX} answered, the ${RATE_MAX + 1}st refused, answered again after the window`,
          evidence.get(t.check),
        ),
      );
  }
  return targets.map((t) => results.get(t.check) as Outcome);
}

export const rateLimit = async (deps: LimitsDeps, target: RateTarget) =>
  (await rateLimits(deps, [target]))[0] as Outcome;

// One message just over 25 MiB to check@, rejected for its size. Its sender is no member, so no case could follow it
// anyway: the size-attributed rejection is the proof.
export async function mailSize(deps: LimitsDeps): Promise<Outcome> {
  const evidence: Evidence = {};
  try {
    return await mailSizeSteps(deps, evidence);
  } catch (error) {
    // What was sent stays on the record (round 1): a failed poll never loses the message's id.
    return fail("mail-size", `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300), evidence);
  }
}

async function mailSizeSteps(deps: LimitsDeps, evidence: Evidence): Promise<Outcome> {
  const check = "mail-size";
  if (!deps.smtp2goKey) return { check, result: "skipped", why: "SMTP2GO_API_KEY is not set", evidence: {} };
  const headers = { "content-type": "application/json", "x-smtp2go-api-key": deps.smtp2goKey };
  const sentAt = deps.now();
  Object.assign(evidence, { sentAt: sentAt.toISOString(), bytes: UPLOAD_LIMIT + MIB });
  const send = await deps.fetch(`${SMTP2GO}/email/send`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sender: MAIL_FROM,
      to: [MAIL_TO],
      subject: `IsItLegit limits check ${deps.runId} oversized`,
      text_body: `A synthetic oversized message for the mail size check, run ${deps.runId}.`,
      attachments: [
        {
          filename: "padding.bin",
          fileblob: randomBytes(UPLOAD_LIMIT + MIB).toString("base64"),
          mimetype: "application/octet-stream",
        },
      ],
    }),
  });
  const sent = await bodyJson<{ data?: { succeeded?: number; email_id?: string } }>(send);
  if (send.status !== 200 || sent?.data?.succeeded !== 1 || !sent.data.email_id)
    return fail(check, `SMTP2GO did not take the message (HTTP ${send.status})`, evidence);
  const emailId = sent.data.email_id;
  evidence.emailId = emailId;
  const deadline = sentAt.getTime() + MAIL_WAIT_MS;
  while (deps.now().getTime() < deadline) {
    await wait(deps, 30_000, `SMTP2GO's record of message ${emailId}`);
    const found = await deps.fetch(`${SMTP2GO}/activity/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        search_email_id: emailId,
        start_date: new Date(sentAt.getTime() - 60_000).toISOString(),
        end_date: new Date(deps.now().getTime() + 60_000).toISOString(),
        limit: 100,
      }),
    });
    if (found.status === 401 || found.status === 403)
      return fail(check, `SMTP2GO refused the activity search (HTTP ${found.status})`, evidence);
    if (found.status !== 200) {
      deps.log(`  SMTP2GO answered HTTP ${found.status}; asking again`);
      continue;
    }
    const events = (await bodyJson<{ data?: { events?: Record<string, unknown>[] } }>(found))?.data?.events ?? [];
    const final = events.find((e) => e.email_id === emailId && FINAL_EVENTS.includes(String(e.event)));
    if (!final) continue;
    const reason = String([final.smtp_response, final.reason].find((v) => typeof v === "string") ?? "");
    evidence.event = String(final.event);
    evidence.code = reason.match(/\b[245]\d\d\b|\b[245]\.\d{1,3}\.\d{1,3}\b/g)?.join(" ") ?? null;
    if (final.event === "delivered") return fail(check, "the oversized message was delivered", evidence);
    if (!SIZE_REASON.test(reason)) return fail(check, `rejected for another reason (${String(final.event)})`, evidence);
    return ok(check, `rejected for its size (${String(final.event)}, ${evidence.code ?? "no code"})`, evidence);
  }
  return fail(check, `no final delivery record within ${MAIL_WAIT_MS / 60_000} minutes`, evidence);
}

// The bucket's lifecycle rules as Wrangler prints them: `raw-30-days` enabled on raw/, expiring (deleting) objects
// after 30 days. Wrangler prints a rule either as a block of `key: value` lines or as one table row; both are read,
// and anything else fails closed (an unfamiliar format reports FAIL, never ok). Only an expiration counts: a
// transition to another storage class or a multipart abort keeps the content (completion review).
export function rawRule(out: string): { enabled: boolean; prefix: string | null; expireDays: number | null } | null {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => /\braw-30-days\b/.test(l));
  if (at < 0) return null;
  const row = lines[at] as string;
  const next = lines.findIndex((l, i) => i > at && (l.trim() === "" || /^\s*name:/i.test(l)));
  const block = /:\s/.test(row) ? lines.slice(at, next < 0 ? undefined : next).join("\n") : row;
  const prefix = block.match(/(?:prefix:\s*|\s)(raw\/\S*)/i)?.[1] ?? null;
  const expire = block.match(/\b(?:expire|delete)\w*\b(?:(?!transition|abort)[^\n])*?\b(\d+)\s*days?\b/i);
  const enabled =
    /:\s*(yes|true|enabled)\b|\s(yes|true)\s/i.test(` ${block} `) && !/:\s*(no|false|disabled)\b/i.test(block);
  return { enabled, prefix, expireDays: expire ? Number(expire[1]) : null };
}

export async function r2Lifecycle(deps: LimitsDeps): Promise<Outcome> {
  const check = "r2-lifecycle";
  const rule = rawRule(await deps.wrangler(["r2", "bucket", "lifecycle", "list", BUCKET]));
  if (!rule) return fail(check, "no raw-30-days rule");
  const evidence: Evidence = { enabled: rule.enabled, prefix: rule.prefix, expireDays: rule.expireDays };
  if (!rule.enabled) return fail(check, "raw-30-days is not enabled", evidence);
  if (rule.prefix !== "raw/")
    return fail(check, `raw-30-days applies to ${rule.prefix ?? "no prefix"}, not raw/`, evidence);
  if (rule.expireDays !== 30)
    return fail(
      check,
      `raw-30-days does not expire objects after 30 days (${rule.expireDays ?? "no expiration"})`,
      evidence,
    );
  return ok(check, "raw-30-days: raw/, objects expire after 30 days, enabled", evidence);
}

export const line = (o: Outcome) => `${o.result} ${o.check}: ${o.why}`;

export type RunRecord = {
  runId: string;
  base: string;
  org: string;
  startedAt: string;
  endedAt: string;
  code: 0 | 1;
  outcomes: Outcome[];
};

export async function runChecks(
  deps: LimitsDeps,
  only: CheckName[],
): Promise<{ outcomes: Outcome[]; code: 0 | 1; record: RunRecord }> {
  const startedAt = deps.now().toISOString();
  const finish = (outcomes: Outcome[]) => {
    const code: 0 | 1 = outcomes.every((o) => o.result === "ok") ? 0 : 1;
    const record = {
      runId: deps.runId,
      base: deps.base,
      org: deps.org,
      startedAt,
      endedAt: deps.now().toISOString(),
      code,
      outcomes,
    };
    return { outcomes, code, record };
  };
  const stopAll = (why: string) => {
    const outcomes = only.map((check) => fail(check, why));
    for (const o of outcomes) deps.log(line(o));
    return finish(outcomes);
  };
  const pending = await recoverPending(deps);
  if (pending) return stopAll(`recovery: ${pending}`);
  if (only.some((c) => c === "upload-size" || c === "daily-cap")) {
    const refused = await preflight(deps);
    if (refused) return stopAll(`preflight: ${refused}`);
  }
  const outcomes: Outcome[] = [];
  const guarded = async (check: CheckName, run: () => Promise<Outcome>) => {
    try {
      return await run();
    } catch (error) {
      return fail(check, `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300));
    }
  };
  const rates = RATE_TARGETS.filter((t) => only.includes(t.check));
  for (const check of only) {
    if (rates.some((t) => t.check === check)) continue;
    deps.log(`checking ${check}`);
    const outcome = await guarded(check, () =>
      check === "upload-size"
        ? uploadSize(deps)
        : check === "daily-cap"
          ? dailyCap(deps)
          : check === "mail-size"
            ? mailSize(deps)
            : r2Lifecycle(deps),
    );
    outcomes.push(outcome);
    deps.log(line(outcome));
  }
  if (rates.length) {
    let rated: Outcome[];
    try {
      rated = await rateLimits(deps, rates);
    } catch (error) {
      rated = rates.map((t) => fail(t.check, `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300)));
    }
    for (const o of rated) {
      outcomes.push(o);
      deps.log(line(o));
    }
  }
  const order = new Map(only.map((c, i) => [c, i]));
  return finish(outcomes.sort((a, b) => (order.get(a.check) ?? 0) - (order.get(b.check) ?? 0)));
}

if (import.meta.filename === process.argv[1]) {
  const args = parseLimitsArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(`check-limits: ${args.error}`);
    process.exit(2);
  }
  const session = process.env.ISITLEGIT_SESSION ?? "";
  if (!session && args.only.some((c) => c === "upload-size" || c === "daily-cap")) {
    console.error("check-limits: ISITLEGIT_SESSION (a signed-in test member's cookie header) is not set");
    process.exit(2);
  }
  const dir = launchDir();
  const runId = randomUUID().slice(0, 8);
  const run = stoppable(async (statement) => (await execute(statement)).results ?? []);
  const deps: LimitsDeps = {
    base: args.base,
    org: args.org,
    session,
    smtp2goKey: process.env.SMTP2GO_API_KEY ?? null,
    runId,
    fetch: timed(fetch),
    sql: run.sql,
    wrangler: (wranglerArgs) => runCommand("pnpm", ["exec", "wrangler", ...wranglerArgs], "", Date.now() + 120_000),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    log: (l) => console.log(l),
    state: fileStore(join(dir, "limits-recovery.json")),
  };
  // Interrupted: stop sending SQL, wait for what was sent, restore what the cap check changed, then exit; the run's
  // own end waits for this rather than exiting under it.
  const gate = exitGate((code) => process.exit(code));
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () =>
      gate.interrupt(async () => {
        console.log(`check-limits: ${signal}; waiting for SQL already sent, then restoring before exit`);
        await run.stop();
        const left = await recoverPending({
          ...deps,
          sql: (statement) => execute(statement).then((a) => a.results ?? []),
        });
        if (left) console.log(`check-limits: ${left}`);
      }),
    );
  console.log(
    `check-limits: run ${runId} against ${args.base}; the sign-in checks lock this IP out of their buckets for about 21 minutes`,
  );
  const { code, record } = await runChecks(deps, args.only);
  const file = join(dir, `limits-${runId}.json`);
  try {
    writeJsonAtomic(file, record);
    console.log(`check-limits: the run record is ${file}`);
  } catch (error) {
    console.log(`check-limits: the run record could not be written (${(error as Error).message}); it follows`);
  }
  console.log(`record: ${JSON.stringify(record)}`);
  await gate.finish(code);
}
