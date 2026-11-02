// The fixture collector (D04 T02 §1; design spec 4.4a, 11): the one place the fictional fixture
// pages send their forms. A submission is recorded only when its values contain a canary pair
// that traces to a case (src/walkthrough/canary.ts); the record keeps only the canary-valued
// fields, under the traced case's id in the CACHE KV, and every other field is discarded. A
// submission with no matching pair is refused and stores nothing, and a failure to trace or to
// store is a 500, never the accepted page: a walk reading this endpoint sees acceptance only
// when a canary was actually recorded.
import { isCanaryPassword, isCanaryUsername, traceCanary } from "../walkthrough/canary";

export type FixtureDeps = { db: D1Database; kv: KVNamespace };

// Recorded submissions live a month: long enough for a demo or a test to read them back, short
// enough that a fixture's harvest never becomes an archive.
export const SUBMISSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const submissionKey = (caseId: string) => `fixtures:submissions:${caseId}`;

const page = (body: string, status: number) =>
  new Response(
    `<!doctype html><meta charset=utf-8><meta name=robots content='noindex,nofollow'><title>Fixture</title>${body}<footer>Test fixture for IsItLegit, not a real service</footer>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-robots-tag": "noindex, nofollow",
        "cache-control": "no-store",
      },
    },
  );

// The accepted page: no credential field and no failure word, so the driver's acceptance read
// sees what a successful harvest page shows.
const acceptedPage = () => page("<h1>Welcome back</h1><p>You are signed in. Your document is ready.</p>", 200);
// The refused page: the form again and a failure word, so a walk reads a rejection.
const rejectedPage = () =>
  page(
    `<h1>Incorrect details, try again</h1><form method="post"><input name="email" placeholder="Email address"><input name="password" type="password" placeholder="Password"><button>Sign in</button></form>`,
    403,
  );

export async function collectSubmission(request: Request, deps: FixtureDeps): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return page("<h1>That submission could not be read</h1>", 400);
  }
  const fields: { name: string; value: string }[] = [];
  for (const [name, value] of form.entries()) if (typeof value === "string") fields.push({ name, value });
  const username = fields.find((f) => isCanaryUsername(f.value))?.value;
  const password = fields.find((f) => isCanaryPassword(f.value))?.value;
  if (!username || !password) return rejectedPage();
  let traced: Awaited<ReturnType<typeof traceCanary>>;
  try {
    traced = await traceCanary(deps.db, username, password);
  } catch {
    return page("<h1>Something went wrong on our side</h1>", 500);
  }
  if (traced.kind !== "match") return rejectedPage();
  const kept = fields.filter((f) => isCanaryUsername(f.value) || isCanaryPassword(f.value));
  try {
    await deps.kv.put(submissionKey(traced.caseId), JSON.stringify({ at: new Date().toISOString(), fields: kept }), {
      expirationTtl: SUBMISSION_TTL_SECONDS,
    });
  } catch {
    return page("<h1>Something went wrong on our side</h1>", 500);
  }
  return acceptedPage();
}
