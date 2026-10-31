// The deployed service's limits, exercised from outside with synthetic inputs (D09 T01 §1). Run by the coordinator,
// never by a lane, once the operator approves: it changes production (one admitted case, one cap set and restored, an
// IP locked out of three sign-in buckets for a window, one oversized message sent).
//
//   ISITLEGIT_SESSION=<cookie header> SMTP2GO_API_KEY=<key> \
//   node eval/launch/check-limits.ts --confirm-production --org <test organisation id> [--only <check,...>]
//                                    [--base-url https://app.isitlegit.co.za]
//
// Checks: upload-size, daily-cap, sign-in-confirm-rate, sign-in-code-rate, passkey-options-rate, mail-size,
// r2-lifecycle. One line each (`ok <check>`, `FAIL <check>: <why>` or `skipped <check>: <why>`); exit 0 only when every
// check run is ok, 1 otherwise, 2 for a bad argument. The session cookie and the SMTP2GO key come from the environment
// only and are never printed. The live D1 is read and written through the operator's Wrangler login.
import { randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { execute } from "../../scripts/lib/meta-budget.ts";
import { runCommand } from "../../scripts/smoke.ts";
import type { Statement } from "../../src/meta/budget-sql.ts";

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
export type Outcome = { check: CheckName; result: "ok" | "FAIL" | "skipped"; why: string };

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
// A rejection the size caused: the Worker's own reason (src/intake/email.ts) or an SMTP size refusal.
export const SIZE_REASON = /message too large|\b552\b|\b5\.3\.4\b|exceeds? (the )?(maximum )?(message )?size/i;
const SMTP2GO = "https://api.smtp2go.com/v3";

// The SAST day's start as `src/db/cases.ts` (`sastDayStart`) counts the cap from; restated here because that module's
// extensionless imports do not load under plain Node (`test/node/check-limits.test.ts` checks the two agree).
const SAST_OFFSET_MS = 2 * 60 * 60_000;
export const sastDayStart = (now: Date) => {
  const local = now.getTime() + SAST_OFFSET_MS;
  return new Date(local - (local % 86_400_000) - SAST_OFFSET_MS).toISOString();
};

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
};

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

const ok = (check: CheckName, why = ""): Outcome => ({ check, result: "ok", why });
const fail = (check: CheckName, why: string): Outcome => ({ check, result: "FAIL", why });

// The session's own organisation must be the approved test organisation, and exist, before anything is changed.
export async function preflight(deps: LimitsDeps): Promise<string | null> {
  let body: { session?: { activeOrganizationId?: string | null } } | null;
  try {
    const answer = await deps.fetch(`${deps.base}/api/auth/get-session`, { headers: { cookie: deps.session } });
    if (answer.status !== 200) return `the session could not be read (HTTP ${answer.status})`;
    body = (await answer.json()) as typeof body;
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
  for (const [how, init] of sends) {
    const answer = await deps.fetch(`${deps.base}/api/upload`, init);
    const text = await answer.text();
    if (answer.status !== 413) return fail(check, `${how}: HTTP ${answer.status}, not 413`);
    if (!text.includes(UPLOAD_TOO_LARGE)) return fail(check, `${how}: 413 without the upload route's message`);
  }
  const after = await casesToday(deps);
  if (after !== before) return fail(check, `the organisation's cases today moved from ${before} to ${after}`);
  return ok(check, "413 declared and streamed, no case");
}

type LimitsRow = { daily_cases: number; plan: string | null; trial_ends_at: string | null } | null;
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

// The cap set to today's count plus one: one upload admitted, the next refused; then the cap restored and read back
// on every path, a restoration that fails overriding any outcome with the exact SQL that repairs it.
export async function dailyCap(deps: LimitsDeps): Promise<Outcome> {
  const check = "daily-cap";
  const original = await readLimits(deps);
  let result: Outcome;
  try {
    result = await capAttempt(deps, original);
  } catch (error) {
    result = fail(check, `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300));
  }
  const restore = restoreStatement(deps.org, original);
  let restored: LimitsRow | undefined;
  try {
    await deps.sql(restore);
    restored = await readLimits(deps);
  } catch {
    restored = undefined;
  }
  if (JSON.stringify(restored) !== JSON.stringify(original))
    return fail(
      check,
      `the cap was not restored; run: wrangler d1 execute isitlegit --remote --command ${JSON.stringify(inlineSql(restore))}`,
    );
  return result;
}

async function capAttempt(deps: LimitsDeps, original: LimitsRow): Promise<Outcome> {
  const check = "daily-cap";
  const before = await casesToday(deps);
  if (!Number.isFinite(before)) return fail(check, "today's case count could not be read");
  const cap = before + 1;
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
  const firstBody = (await first.json().catch(() => ({}))) as { caseId?: string };
  if (first.status !== 201 || !firstBody.caseId)
    return fail(check, `the first upload answered HTTP ${first.status}, not 201`);
  const owner = await deps.sql({ sql: "SELECT org_id FROM cases WHERE id = ?1", params: [firstBody.caseId] });
  if (owner[0]?.org_id !== deps.org) return fail(check, "the admitted case is not in the test organisation");
  const middle = await casesToday(deps);
  if (middle !== before + 1) return fail(check, `the first upload moved the count by ${middle - before}, not 1`);
  const second = await upload(2);
  const secondText = await second.text();
  const after = await casesToday(deps);
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
  const match = (await answer.clone().text()).match(/(\d+)\s*(second|minute)/i);
  if (!match) return null;
  return Number(match[1]) * (match[2]?.toLowerCase().startsWith("minute") ? 60_000 : 1000);
};

// A per-IP bucket from a fresh window: run it out, wait the window it reports, then 20 answered and a 21st refused,
// then after that window one answered again.
export async function rateLimit(deps: LimitsDeps, target: RateTarget): Promise<Outcome> {
  const { check } = target;
  let wait: number | null = null;
  for (let n = 0; n <= RATE_MAX + 1; n++) {
    const answer = await target.request(deps);
    if (answer.status === 403) return fail(check, "HTTP 403: the request's Origin was refused");
    if (answer.status === 429) {
      wait = await windowLeftMs(answer);
      break;
    }
  }
  const settle = async (ms: number | null) => deps.sleep(Math.min((ms ?? RATE_WINDOW_MS) + 2_000, MAX_WINDOW_WAIT_MS));
  await settle(wait);
  for (let n = 1; n <= RATE_MAX; n++) {
    const answer = await target.request(deps);
    if (answer.status === 429) return fail(check, `request ${n} of a fresh window was refused`);
    if (answer.status !== target.expect)
      return fail(check, `request ${n} answered HTTP ${answer.status}, not ${target.expect}`);
  }
  const over = await target.request(deps);
  if (over.status !== 429) return fail(check, `request ${RATE_MAX + 1} answered HTTP ${over.status}, not 429`);
  await settle(await windowLeftMs(over));
  const again = await target.request(deps);
  if (again.status === 429) return fail(check, "still refused after the window");
  return ok(check, `${RATE_MAX} answered, the ${RATE_MAX + 1}st refused, answered again after the window`);
}

// One message just over 25 MiB to check@, rejected for its size. Its sender is no member, so no case could follow it
// anyway: the size-attributed rejection is the proof.
export async function mailSize(deps: LimitsDeps): Promise<Outcome> {
  const check = "mail-size";
  if (!deps.smtp2goKey) return { check, result: "skipped", why: "SMTP2GO_API_KEY is not set" };
  const subject = `IsItLegit limits check ${deps.runId} oversized`;
  const sentAt = deps.now();
  const send = await deps.fetch(`${SMTP2GO}/email/send`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-smtp2go-api-key": deps.smtp2goKey },
    body: JSON.stringify({
      sender: MAIL_FROM,
      to: [MAIL_TO],
      subject,
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
  const sent = (await send.json().catch(() => null)) as { data?: { succeeded?: number; email_id?: string } } | null;
  if (send.status !== 200 || sent?.data?.succeeded !== 1 || !sent.data.email_id)
    return fail(check, `SMTP2GO did not take the message (HTTP ${send.status})`);
  const emailId = sent.data.email_id;
  const deadline = sentAt.getTime() + MAIL_WAIT_MS;
  while (deps.now().getTime() < deadline) {
    await deps.sleep(30_000);
    const found = await deps.fetch(`${SMTP2GO}/activity/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-smtp2go-api-key": deps.smtp2goKey },
      body: JSON.stringify({
        start_date: new Date(sentAt.getTime() - 60_000).toISOString(),
        email_id: [emailId],
        limit: 100,
      }),
    });
    const events =
      ((await found.json().catch(() => null)) as { data?: { events?: Record<string, unknown>[] } } | null)?.data
        ?.events ?? [];
    const mine = events.filter((e) => e.email_id === emailId);
    const final = mine.find((e) =>
      ["delivered", "bounce", "hard_bounced", "rejected", "reject"].includes(String(e.event)),
    );
    if (!final) continue;
    const reason = [final.smtp_response, final.reason].find((v) => typeof v === "string") ?? "";
    if (final.event === "delivered") return fail(check, "the oversized message was delivered");
    if (!SIZE_REASON.test(String(reason))) return fail(check, `rejected for another reason (${String(final.event)})`);
    return ok(check, `rejected for its size (${String(final.event)})`);
  }
  return fail(check, `no final delivery record within ${MAIL_WAIT_MS / 60_000} minutes`);
}

// The bucket's lifecycle rules as Wrangler prints them: `raw-30-days` enabled on raw/ after 30 days. Wrangler prints
// a rule either as a block of `key: value` lines or as one table row; both are read, and anything else fails closed
// (an unfamiliar format reports FAIL, never ok).
export function rawRule(out: string): { enabled: boolean; prefix: string | null; days: number | null } | null {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => /\braw-30-days\b/.test(l));
  if (at < 0) return null;
  const row = lines[at] as string;
  const block = /:\s/.test(row)
    ? lines
        .slice(at, lines.findIndex((l, i) => i > at && (l.trim() === "" || /^\s*name:/i.test(l))) >>> 0 || undefined)
        .join("\n")
    : row;
  const prefix = block.match(/(?:prefix:\s*|\s)(raw\/\S*)/i)?.[1] ?? null;
  const days = Number(block.match(/(\d+)\s*days?/i)?.[1] ?? Number.NaN);
  const enabled =
    /:\s*(yes|true|enabled)\b|\s(yes|true)\s/i.test(` ${block} `) && !/:\s*(no|false|disabled)\b/i.test(block);
  return { enabled, prefix, days: Number.isFinite(days) ? days : null };
}

export async function r2Lifecycle(deps: LimitsDeps): Promise<Outcome> {
  const check = "r2-lifecycle";
  const rule = rawRule(await deps.wrangler(["r2", "bucket", "lifecycle", "list", BUCKET]));
  if (!rule) return fail(check, "no raw-30-days rule");
  if (!rule.enabled) return fail(check, "raw-30-days is not enabled");
  if (rule.prefix !== "raw/") return fail(check, `raw-30-days applies to ${rule.prefix ?? "no prefix"}, not raw/`);
  if (rule.days !== 30) return fail(check, `raw-30-days expires after ${rule.days ?? "no"} days, not 30`);
  return ok(check, "raw-30-days: raw/, 30 days, enabled");
}

export const line = (o: Outcome) => (o.result === "ok" ? `ok ${o.check}` : `${o.result} ${o.check}: ${o.why}`);

export async function runChecks(deps: LimitsDeps, only: CheckName[]): Promise<{ outcomes: Outcome[]; code: 0 | 1 }> {
  const outcomes: Outcome[] = [];
  const needsSession = only.some((c) => c === "upload-size" || c === "daily-cap");
  if (needsSession) {
    const refused = await preflight(deps);
    if (refused) {
      const outcomes = only.map((check) => ({ check, result: "FAIL" as const, why: `preflight: ${refused}` }));
      for (const o of outcomes) deps.log(line(o));
      return { outcomes, code: 1 };
    }
  }
  for (const check of only) {
    let outcome: Outcome;
    try {
      if (check === "upload-size") outcome = await uploadSize(deps);
      else if (check === "daily-cap") outcome = await dailyCap(deps);
      else if (check === "mail-size") outcome = await mailSize(deps);
      else if (check === "r2-lifecycle") outcome = await r2Lifecycle(deps);
      else outcome = await rateLimit(deps, RATE_TARGETS.find((t) => t.check === check) as RateTarget);
    } catch (error) {
      outcome = fail(check, `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300));
    }
    outcomes.push(outcome);
    deps.log(line(outcome));
  }
  return { outcomes, code: outcomes.every((o) => o.result === "ok") ? 0 : 1 };
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
  console.log("check-limits: the sign-in checks lock this IP out of their buckets for up to 10 minutes each");
  const { code } = await runChecks(
    {
      base: args.base,
      org: args.org,
      session,
      smtp2goKey: process.env.SMTP2GO_API_KEY ?? null,
      runId: randomUUID().slice(0, 8),
      fetch,
      sql: async (statement) => (await execute(statement)).results ?? [],
      wrangler: (wranglerArgs) => runCommand("pnpm", ["exec", "wrangler", ...wranglerArgs], "", Date.now() + 120_000),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => new Date(),
      log: (l) => console.log(l),
    },
    args.only,
  );
  process.exit(code);
}
