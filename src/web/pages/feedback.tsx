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
  feedbackStillThere,
  feedbackWaiting,
  markNotified,
  markTried,
  readFeedback,
  saveFeedback,
  waitingNotices,
  withdrawFeedback,
} from "../../db/feedback";
import { getVerdict } from "../../db/verdicts";
import { sendMail } from "../../mail/smtp2go";
import { HEADERS } from "./errors";
import { FeedbackControl, type FeedbackState, MAX_NOTE } from "./feedback-control";
import { feedbackNotice } from "./feedback-notice";
import { reasonsOf } from "./report-verdict";

export const feedbackRoutes = new Hono<{ Bindings: Env }>();

const CASE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// The route's own answers say so (`x-feedback`): the page draws a refusal in place only when it is one of them, never
// a gateway's error page, which would take the form and the note with it.
const fragment = (state: FeedbackState, status = 200) =>
  new Response(String(<FeedbackControl {...state} />), { status, headers: { ...HEADERS, "x-feedback": "1" } });
// The form again after an outage that came before the verdict could be read, kept as typed; the choice order is the
// malicious one, the commonest dispute.
const outageForm = (caseId: string, body: Record<string, string>, words: string) =>
  fragment(
    {
      caseId,
      verdict: "malicious",
      saved: null,
      form: { kind: body.kind ?? "", note: body.note ?? "", errors: { note: words } },
    },
    503,
  );
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
      saved: saved && { kind: saved.kind, note: saved.note, at: saved.updatedAt },
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
  // The note's field limit is the whole body's, so no note that fits the request is ever dropped as if empty.
  const BODY = 16 * 1024;
  const body = await readSmallForm(c.req.raw, { kind: 32, note: BODY, base: 64 }, BODY);
  if (!body) return plain(413, "Request too large");
  let mine: Awaited<ReturnType<typeof memberCase>>;
  try {
    mine = await memberCase(c.env, c.req.raw, id);
  } catch {
    // An outage before anything is written: the form again, its input kept.
    return outageForm(id, body, "That did not go through just now. Nothing was saved: send it again in a moment.");
  }
  if (!mine) return plain(404, "Not found");
  if (!mine.verdict) return plain(409, "This check has no verdict to dispute.");
  // A send that began from a saved state it has since lost (the member withdrew it in another tab, or its send
  // outlived its own timeout and the member withdrew) does not recreate what was taken back (D07 T03 §22 round 3):
  // it answers the withdrawn state, and a fresh press, which carries no base, may dispute again.
  if (body.base) {
    const current = await readFeedback(c.env.DB, id, mine.user.id).catch(() => undefined);
    if (current !== undefined && (!current || current.updatedAt !== body.base))
      return current
        ? fragment(
            {
              caseId: id,
              verdict: mine.verdict.verdict,
              saved: { kind: current.kind, note: current.note, at: current.updatedAt },
            },
            409,
          )
        : fragment({ caseId: id, verdict: mine.verdict.verdict, saved: null, withdrawn: true }, 409);
  }
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
    return fragment({ caseId: id, verdict: verdictName, saved: { kind: row.kind, note: row.note, at: row.updatedAt } });
  } catch {
    // The write may or may not have landed: sending again replaces it, so asking for that is always safe.
    return fragment(
      {
        caseId: id,
        verdict: verdictName,
        saved: null,
        form: {
          kind,
          note: body.note ?? "",
          errors: { note: "We could not confirm that was saved. Send it again: it replaces anything that did arrive." },
        },
      },
      503,
    );
  }
});

// "Withdraw" (D07 T03 §21): the member takes their own feedback back in one press. The answer is the control's region, the
// closed control offered again with a sentence said once; a second press (nothing saved) is the closed control alone.
// A write that did not go through leaves the feedback where it was and says so, in the saved state, never a 500.
feedbackRoutes.post("/r/:caseId/feedback/withdraw", async (c) => {
  const id = c.req.param("caseId");
  if (c.req.header("origin") !== new URL(c.env.APP_URL).origin) return plain(403, "Forbidden");
  if (!CASE_ID.test(id)) return plain(404, "Not found");
  let mine: Awaited<ReturnType<typeof memberCase>>;
  try {
    mine = await memberCase(c.env, c.req.raw, id);
  } catch {
    return plain(503, "The feedback could not be read just now.");
  }
  if (!mine?.verdict) return plain(404, "Not found");
  const verdictName = mine.verdict.verdict;
  try {
    const removed = await withdrawFeedback(c.env.DB, id, mine.user.id);
    return fragment({ caseId: id, verdict: verdictName, saved: null, withdrawn: removed });
  } catch {
    // The delete may or may not have landed: the saved state, if it is still there, says it did not go through.
    try {
      const saved = await readFeedback(c.env.DB, id, mine.user.id);
      // The delete landed though its answer did not: it is withdrawn, and the member is told so.
      if (!saved) return fragment({ caseId: id, verdict: verdictName, saved: null, withdrawn: true });
      return fragment(
        {
          caseId: id,
          verdict: verdictName,
          saved: saved && { kind: saved.kind, note: saved.note, at: saved.updatedAt },
          failed: "That did not go through. Your feedback is still there: try again in a moment.",
        },
        503,
      );
    } catch {
      return plain(503, "The feedback could not be read just now.");
    }
  }
});

// The reputation listings the verdict's reasons cite (`detail.provider`, a stable id from D02 T06's
// `REPUTATION_PROVIDERS`): every cited id, in order. A counter-signal argues the other way and is left out.
export async function citedListings(
  db: D1Database,
  caseId: string,
  reasons: readonly (string | { text: string; evidenceIds: string[] })[],
) {
  const cited = new Set(reasonsOf(reasons).flatMap((r) => r.evidenceIds));
  if (cited.size === 0) return [];
  const evidence = await readEvidence(db, caseId);
  return evidence
    .filter((item) => cited.has(item.id) && item.check === "reputation.listing")
    .map((item) => ({ id: item.id, provider: (item.detail as { provider?: unknown }).provider }))
    .filter((l): l is { id: string; provider: string } => typeof l.provider === "string" && l.provider.length > 0);
}
// Each cited listing's provider once: what the providers' false-alarm counts read.
export async function citedProviders(
  db: D1Database,
  caseId: string,
  reasons: readonly (string | { text: string; evidenceIds: string[] })[],
) {
  return [...new Set((await citedListings(db, caseId, reasons)).map((l) => l.provider))];
}

// N9's feedback notice: once per feedback row by its own send key; the row is marked tried at each attempt (so the
// cron takes the least recently tried first) and notified only when its send went or was settled for good. Never the
// member's note.
export async function sendFeedbackNotice(env: Env, row: Feedback): Promise<boolean> {
  if (!env.OPERATOR_EMAIL) return false;
  await markTried(env.DB, row.id);
  const found = await env.DB.prepare(
    `SELECT o.name AS org FROM cases c JOIN "organization" o ON o.id = c.org_id WHERE c.id = ?`,
  )
    .bind(row.caseId)
    .first<{ org: string }>();
  if (!found) return false;
  // A verdict that cannot be read leaves the notice waiting, never sent as if there were none.
  const stored = await getVerdict(env.DB, row.caseId);
  if (stored && !stored.ok) throw new Error(stored.error.message);
  const verdict = stored?.value ?? null;
  const listings = verdict ? await citedListings(env.DB, row.caseId, verdict.reasons) : [];
  const notice = feedbackNotice({
    appUrl: env.APP_URL,
    at: new Date(row.createdAt),
    organisation: found.org,
    verdict: verdict?.verdict ?? null,
    confidence: verdict?.confidence ?? null,
    kind: row.kind,
    listings,
    waiting: await feedbackWaiting(env.DB),
  });
  // The cron holds a batch in memory: a feedback its member has taken back since is not announced. A notice whose send has
  // begun goes (the operator is told of a dispute that existed when it began).
  if (!(await feedbackStillThere(env.DB, row.id))) return false;
  const outcome = await sendMail(
    { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL },
    {
      sendKey: `feedback:${row.id}`,
      kind: "notice",
      to: env.OPERATOR_EMAIL,
      from: "IsItLegit Alerts <alerts@isitlegit.co.za>",
      subject: notice.subject,
      text: notice.text,
      html: notice.html,
      caseId: row.caseId,
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
