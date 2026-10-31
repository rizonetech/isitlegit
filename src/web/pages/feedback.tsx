// "This verdict is wrong" (D07 T03 §6; design spec 4.7, 4.3a; design/SPEC.md M3 footer and N9): a member of the case's
// organisation disputes its verdict with one choice and an optional note. It never edits the case or its evidence; it
// records the reputation providers the verdict's reasons cited, for their false-alarm counts, and tells the operator
// once (N9), never with the note. `POST /r/:caseId/feedback` answers the control's region: the saved state, or the form
// again with its errors and what was typed.
import { Hono } from "hono";
import { createAuth } from "../../auth/auth";
import { readSmallForm } from "../../auth/form";
import { readEvidence } from "../../checks/evidence";
import { getCase } from "../../db/cases";
import {
  type Feedback,
  feedbackWaiting,
  markNotified,
  readFeedback,
  saveFeedback,
  waitingNotices,
} from "../../db/feedback";
import { getVerdict } from "../../db/verdicts";
import { sendMail } from "../../mail/smtp2go";
import { HEADERS } from "./errors";
import { FeedbackControl, type FeedbackState, MAX_NOTE } from "./feedback-control";
import { reasonsOf } from "./report-verdict";

export const feedbackRoutes = new Hono<{ Bindings: Env }>();

const CASE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const VERDICT_WORDS = { malicious: "Malicious", suspicious: "Suspicious", safe: "Safe" } as const;

const fragment = (state: FeedbackState, status = 200) =>
  new Response(String(<FeedbackControl {...state} />), { status, headers: HEADERS });
const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } });

// The member, their case and its verdict, by the report's member rule (any of their memberships in the case's
// organisation); null when they are not one, or the case has no verdict to dispute.
async function memberCase(env: Env, request: Request, caseId: string) {
  const read = await createAuth(env).api.getSession({ headers: request.headers });
  const user = read?.user;
  if (!user) return null;
  const member = await env.DB.prepare(
    `SELECT c.org_id AS orgId FROM cases c JOIN "member" m ON m."organizationId" = c.org_id WHERE c.id = ? AND m."userId" = ?`,
  )
    .bind(caseId, user.id)
    .first<{ orgId: string }>();
  if (!member) return null;
  const found = await getCase(env.DB, member.orgId, caseId);
  if (!found.ok) {
    if (found.error.code === "not_found") return null;
    throw new Error(found.error.message);
  }
  const verdict = await getVerdict(env.DB, caseId);
  if (verdict && !verdict.ok) throw new Error(verdict.error.message);
  if (!verdict) return { user, orgId: member.orgId, stored: found.value, verdict: null };
  return { user, orgId: member.orgId, stored: found.value, verdict: verdict.value };
}

// The control filled with the member's saved feedback (Change).
feedbackRoutes.get("/r/:caseId/feedback", async (c) => {
  const id = c.req.param("caseId");
  if (!CASE_ID.test(id)) return plain(404, "Not found");
  try {
    const mine = await memberCase(c.env, c.req.raw, id);
    if (!mine?.verdict) return plain(404, "Not found");
    const saved = await readFeedback(c.env.DB, id, mine.user.id);
    return fragment({
      caseId: id,
      verdict: mine.verdict.verdict,
      saved: saved && { kind: saved.kind, note: saved.note },
      open: true,
      ...(saved ? { form: { kind: saved.kind, note: saved.note ?? "", errors: {} } } : {}),
    });
  } catch {
    return plain(503, "The feedback could not be read just now.");
  }
});

feedbackRoutes.post("/r/:caseId/feedback", async (c) => {
  const id = c.req.param("caseId");
  if (c.req.header("origin") !== new URL(c.env.APP_URL).origin) return plain(403, "Forbidden");
  if (!CASE_ID.test(id)) return plain(404, "Not found");
  // The note is read past its limit so a long one is refused as long, never dropped as if empty.
  const body = await readSmallForm(c.req.raw, { kind: 32, note: MAX_NOTE * 4 }, 16 * 1024);
  if (!body) return plain(413, "Request too large");
  let mine: Awaited<ReturnType<typeof memberCase>>;
  try {
    mine = await memberCase(c.env, c.req.raw, id);
  } catch {
    return plain(503, "That did not go through just now. Nothing was saved: send it again in a moment.");
  }
  if (!mine) return plain(404, "Not found");
  if (!mine.verdict) return plain(409, "This check has no verdict to dispute.");
  const kind = body.kind === "false_alarm" || body.kind === "missed" ? body.kind : null;
  const note = (body.note ?? "").trim();
  const errors: { kind?: string; note?: string } = {};
  if (!kind) errors.kind = "Choose whether it is safe or a scam.";
  if (Array.from(note).length > MAX_NOTE)
    errors.note = `The note is longer than ${MAX_NOTE} characters. Shorten it and send it again.`;
  const verdictName = mine.verdict.verdict;
  if (!kind || errors.note)
    return fragment(
      { caseId: id, verdict: verdictName, saved: null, form: { kind: body.kind ?? "", note: body.note ?? "", errors } },
      400,
    );
  try {
    const providers = await citedProviders(c.env.DB, id, mine.verdict.reasons);
    const row = await saveFeedback(c.env.DB, { caseId: id, userId: mine.user.id, kind, note: note || null, providers });
    if (!row.notifiedAt) c.executionCtx.waitUntil(sendFeedbackNotice(c.env, row).catch(() => undefined));
    return fragment({ caseId: id, verdict: verdictName, saved: { kind: row.kind, note: row.note } });
  } catch {
    return fragment(
      {
        caseId: id,
        verdict: verdictName,
        saved: null,
        form: {
          kind,
          note: body.note ?? "",
          errors: { note: "That did not go through just now. Nothing was saved: send it again in a moment." },
        },
      },
      503,
    );
  }
});

// The providers of the reputation listings the verdict's reasons cite (`detail.provider`, a stable id from D02 T06's
// `REPUTATION_PROVIDERS`): every cited id, each provider once.
export async function citedProviders(
  db: D1Database,
  caseId: string,
  reasons: readonly (string | { text: string; evidenceIds: string[] })[],
) {
  const cited = new Set(reasonsOf(reasons).flatMap((r) => r.evidenceIds));
  if (cited.size === 0) return [];
  const evidence = await readEvidence(db, caseId);
  const providers = evidence
    // A listing is what the verdict leaned on; a counter-signal argues the other way (D02 T06 §4's contract).
    .filter((item) => cited.has(item.id) && item.check === "reputation.listing")
    .map((item) => (item.detail as { provider?: unknown }).provider)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  return [...new Set(providers)];
}

// N9's feedback notice (board `Email-Operator-Feedback`): once per feedback row by its own send key; the row is marked
// only when its send went or was settled for good, so the cron sends any still waiting. Never the member's note.
export async function sendFeedbackNotice(env: Env, row: Feedback): Promise<boolean> {
  if (!env.OPERATOR_EMAIL) return false;
  const found = await env.DB.prepare(
    `SELECT o.name AS org, v.verdict, v.confidence FROM cases c JOIN "organization" o ON o.id = c.org_id
     LEFT JOIN case_verdicts v ON v.case_id = c.id WHERE c.id = ?`,
  )
    .bind(row.caseId)
    .first<{ org: string; verdict: keyof typeof VERDICT_WORDS | null; confidence: number | null }>();
  if (!found) return false;
  const waiting = await feedbackWaiting(env.DB);
  const queue = new URL("/admin/feedback", env.APP_URL).toString();
  const leaned = row.providers.length ? row.providers.join(", ") : "No reputation listing";
  const outcome = await sendMail(
    { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL },
    {
      sendKey: `feedback:${row.id}`,
      kind: "notice",
      to: env.OPERATOR_EMAIL,
      from: "IsItLegit Alerts <alerts@isitlegit.co.za>",
      subject: "Feedback: a member marked a verdict wrong",
      caseId: row.caseId,
      text: [
        "A member says a verdict is wrong.",
        "The case and its evidence are unchanged. Any note the member wrote stays in the app, not in this email.",
        "",
        `Organisation: ${found.org}`,
        `Verdict given: ${found.verdict ? VERDICT_WORDS[found.verdict] : "Not recorded"}`,
        `Member says: ${row.kind === "false_alarm" ? "It is safe (false alarm)" : "It is a scam (missed)"}`,
        `Verdict leaned on: ${leaned}`,
        `Open feedback: ${waiting} waiting`,
        "",
        `Open the feedback queue: ${queue}`,
        "",
        "Feedback never edits a case. It feeds the eval set and the false-alarm count of the provider the verdict leaned on.",
      ].join("\n"),
    },
  );
  const gone =
    outcome.status === "sent" ||
    outcome.status === "refused" ||
    (outcome.status === "duplicate" && (outcome.previous === "sent" || outcome.previous === "refused"));
  if (gone) await markNotified(env.DB, row.id);
  return gone;
}

// The cron's part: every feedback whose notice has not gone yet.
export async function sendPendingFeedbackNotices(env: Env): Promise<number> {
  let sent = 0;
  for (const row of await waitingNotices(env.DB)) if (await sendFeedbackNotice(env, row).catch(() => false)) sent++;
  return sent;
}
