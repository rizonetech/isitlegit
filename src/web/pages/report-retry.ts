// "Retry the check" (D07 T03 §20; design/SPEC.md M3 failed state, board Report-Partial): a member of the case's
// organisation runs a failed check once more (`retryCase`, D01 T01 §17). Post, redirect, get: a started retry answers
// with the report, which then shows the new run; a refusal answers with the report and the refusal's code, signed
// over the case, the code and its moment, so the page says only what a retry of its own met lately.
import { Hono } from "hono";
import { createAuth } from "../../auth/auth";
import { filtersFrom } from "../../db/case-filters";
import { type RetryRefusal, retryCase } from "../../pipeline/retry";
import { fresh, resultHolds, signResult } from "../signed-result";
import { reportHref } from "./cases-view";
import { HEADERS } from "./errors";
import { RETRY_WORDS, type RetryNote } from "./retry-words";

export const retryRoutes = new Hono<{ Bindings: Env }>();

const CASE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PURPOSE = "report-retry";
// Every code the page has words for is one `retryCase` gives (a misspelt key fails the typecheck).
const WORDS: Partial<Record<RetryRefusal["code"], string>> = RETRY_WORDS;

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } });
const to = (location: string) => new Response(null, { status: 303, headers: { ...HEADERS, location } });
const signed = (caseId: string, code: string, at: number) => [caseId, code, String(at)].join("\n");

async function back(secret: string, caseId: string, code: RetryRefusal["code"] | null, nav = "") {
  if (code === null || !WORDS[code]) return to(`/r/${caseId}${nav}`);
  const at = Date.now();
  const query = new URLSearchParams({ retry: code, rt: String(at) });
  query.set("rs", await signResult(secret, PURPOSE, signed(caseId, code, at)));
  const kept = new URLSearchParams(nav.startsWith("?") ? nav.slice(1) : nav);
  for (const [name, value] of kept) query.set(name, value);
  return to(`/r/${caseId}?${query}`);
}

// The list context a retry form carries (D07 T04 §9), rebuilt canonically from its address, or nothing.
function navOf(request: Request): string {
  const url = new URL(request.url);
  if (url.searchParams.get("list") !== "1") return "";
  const filters = filtersFrom(url.searchParams);
  return reportHref(filters, url.pathname.split("/")[2] ?? "").replace(/^\/r\/[^?]+/, "");
}

// The refusal a report address carries, when its signature holds for this case and it is recent; else none.
export async function retryNoteOf(secret: string, caseId: string, url: URL): Promise<RetryNote | null> {
  const q = url.searchParams;
  const code = q.get("retry");
  const at = Number(q.get("rt"));
  if (!code || !(code in RETRY_WORDS) || !fresh(at)) return null;
  return (await resultHolds(secret, PURPOSE, signed(caseId, code, at), q.get("rs") ?? "")) ? (code as RetryNote) : null;
}

retryRoutes.post("/r/:caseId/retry", async (c) => {
  const id = c.req.param("caseId");
  // Only the app's own pages post here: a form on another site changes nothing.
  if (c.req.header("origin") !== new URL(c.env.APP_URL).origin) return plain(403, "Forbidden");
  if (!CASE_ID.test(id)) return plain(404, "Not found");
  const secret = c.env.BETTER_AUTH_SECRET ?? "";
  let member: { userId: string; orgId: string } | null;
  try {
    const user = (await createAuth(c.env).api.getSession({ headers: c.req.raw.headers }))?.user;
    // The report's member rule: any of the reader's memberships in the case's organisation. A link holder, who has
    // no session, reads only.
    const row = user
      ? await c.env.DB.prepare(
          `SELECT c.org_id AS orgId FROM cases c JOIN "member" m ON m."organizationId" = c.org_id WHERE c.id = ? AND m."userId" = ?`,
        )
          .bind(id, user.id)
          .first<{ orgId: string }>()
      : null;
    member = user && row ? { userId: user.id, orgId: row.orgId } : null;
  } catch {
    // An outage before anything was written: the report says so, never a 500.
    return back(secret, id, "database", navOf(c.req.raw));
  }
  if (!member) return plain(404, "Not found");
  const result = await retryCase(c.env.DB, c.env, member.orgId, id, member.userId);
  if (result.ok) return back(secret, id, null, navOf(c.req.raw));
  if (result.error.code === "not_found") return plain(404, "Not found");
  console.log(JSON.stringify({ event: "report-retry", outcome: result.error.code }));
  return back(secret, id, result.error.code, navOf(c.req.raw));
});
