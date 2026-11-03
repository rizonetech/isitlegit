// The fixture collector (D04 T02 §1; design spec 4.4a, 11): the one place the fictional fixture
// pages send their forms. A submission is recorded only when its values contain a canary pair
// that traces to a case (src/walkthrough/canary.ts); the record keeps only the canary-valued
// fields under validated field names, under the traced case's id in the CACHE KV, and every
// other field is discarded. A submission with no matching pair is refused and stores nothing,
// and a failure to trace or to store is a 500, never the accepted page: a walk reading this
// endpoint sees acceptance only when a canary was actually recorded. Requests are bounded
// before any database work (size, field count, and a per-source rate in the KV), so a stranger
// who learns the prefix cannot make the collector do unbounded work (completion review, G3).
import { isCanaryPassword, isCanaryUsername, traceCanary } from "../walkthrough/canary";

export type FixtureDeps = { db: D1Database; kv: KVNamespace };

// Recorded submissions live a month: long enough for a demo or a test to read them back, short
// enough that a fixture's harvest never becomes an archive.
export const SUBMISSION_TTL_SECONDS = 30 * 24 * 60 * 60;
// Each attempt is its own key (round 1): KV reads can be stale, so a read-modify-write of one
// record could erase a concurrent attempt's evidence. Reading a case's attempts lists them.
export const submissionKey = (caseId: string, attemptId: string) => `fixtures:submissions:${caseId}:${attemptId}`;
export const submissionsPrefix = (caseId: string) => `fixtures:submissions:${caseId}:`;

export type StoredAttempt = { at: string; fixture: string; fields: { name: string; value: string }[] };

// A case's recorded attempts, oldest first, read back from their own keys.
export async function readSubmissions(kv: KVNamespace, caseId: string): Promise<StoredAttempt[]> {
  const attempts: StoredAttempt[] = [];
  let cursor: string | undefined;
  for (;;) {
    const listed = await kv.list({ prefix: submissionsPrefix(caseId), ...(cursor ? { cursor } : {}) });
    for (const key of listed.keys) {
      const stored = await kv.get(key.name, "json");
      if (stored && typeof stored === "object") attempts.push(stored as StoredAttempt);
    }
    if (listed.list_complete) break;
    cursor = listed.cursor;
  }
  return attempts.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
// The bounds a submission is held to before it can reach the database or the store.
export const MAX_BODY_BYTES = 16_384;
export const MAX_FIELDS = 20;
export const MAX_PER_MINUTE = 30;
// A stored field name is a form identifier, never free text a submitter chose (G2).
const FIELD_NAME = /^[a-z][a-z0-9_]{0,31}$/;

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

// The accepted page for the journey the submission came from (G5): no credential field and no
// failure word, so the driver's acceptance read sees what a successful harvest page shows.
const acceptedPage = (fixture: string) =>
  fixture === "proteabank"
    ? page("<h1>Card confirmed</h1><p>Your card is confirmed. Thank you.</p>", 200)
    : page("<h1>Welcome back</h1><p>You are signed in. Your document is ready.</p>", 200);
// The refused page for that journey: its form again and a failure word, so a walk reads a
// rejection and can retry.
const rejectedPage = (fixture: string) =>
  fixture === "proteabank"
    ? page(
        `<h1>Card not confirmed, try again</h1><form method="post"><input type="hidden" name="fixture" value="proteabank"><input name="card_number" placeholder="Card number"><input name="expiry" placeholder="Expiry"><input name="cvv" type="password" placeholder="CVV"><button>Confirm card</button></form>`,
        403,
      )
    : page(
        `<h1>Incorrect details, try again</h1><form method="post"><input type="hidden" name="fixture" value="${fixture === "fynbos-lookalike" ? "fynbos-lookalike" : "nimbusmail"}"><input name="email" placeholder="Email address"><input name="password" type="password" placeholder="Password"><button>Sign in</button></form>`,
        403,
      );

type Attempt = StoredAttempt;

// The rate bound is per isolate, in memory (round 1): KV cannot count consistently (stale
// reads admit too much, and one key takes one write a second, refusing legitimate bursts), so
// the counter that must be exact lives where it is counted. It bounds the work one isolate
// does for a stranger; the size and field bounds above it are the hard limits everywhere.
const recent = new Map<string, { minute: number; count: number }>();
function withinRate(request: Request): boolean {
  const source = request.headers.get("cf-connecting-ip") ?? "unknown";
  const minute = Math.floor(Date.now() / 60_000);
  const entry = recent.get(source);
  if (!entry || entry.minute !== minute) {
    if (recent.size > 1_000) recent.clear();
    recent.set(source, { minute, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_PER_MINUTE;
}

// The body, read with a hard stop: past the bound the rest is never buffered.
async function readBody(request: Request): Promise<{ text: string } | { tooLarge: true } | { unreadable: true }> {
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes) };
}

export async function collectSubmission(request: Request, deps: FixtureDeps): Promise<Response> {
  if (!withinRate(request)) return page("<h1>Too many requests</h1>", 429);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return page("<h1>That submission is too large</h1>", 413);
  const body = await readBody(request).catch(() => ({ unreadable: true }) as const);
  if ("tooLarge" in body) return page("<h1>That submission is too large</h1>", 413);
  if ("unreadable" in body) return page("<h1>That submission could not be read</h1>", 400);
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "application/x-www-form-urlencoded" },
      body: body.text,
    }).formData();
  } catch {
    return page("<h1>That submission could not be read</h1>", 400);
  }
  const fields: { name: string; value: string }[] = [];
  for (const [name, value] of form.entries()) if (typeof value === "string") fields.push({ name, value });
  if (fields.length > MAX_FIELDS) return page("<h1>That submission is too large</h1>", 413);
  const rawFixture = fields.find((f) => f.name === "fixture")?.value;
  const fixture =
    rawFixture === "proteabank" ? "proteabank" : rawFixture === "fynbos-lookalike" ? "fynbos-lookalike" : "nimbusmail";
  const username = fields.find((f) => isCanaryUsername(f.value))?.value;
  const password = fields.find((f) => isCanaryPassword(f.value))?.value;
  if (!username || !password) return rejectedPage(fixture);
  let traced: Awaited<ReturnType<typeof traceCanary>>;
  try {
    traced = await traceCanary(deps.db, username, password);
  } catch {
    return page("<h1>Something went wrong on our side</h1>", 500);
  }
  if (traced.kind !== "match") return rejectedPage(fixture);
  const kept = fields.filter(
    (f) => FIELD_NAME.test(f.name) && (isCanaryUsername(f.value) || isCanaryPassword(f.value)),
  );
  const attempt: Attempt = { at: new Date().toISOString(), fixture, fields: kept };
  try {
    await deps.kv.put(submissionKey(traced.caseId, crypto.randomUUID()), JSON.stringify(attempt), {
      expirationTtl: SUBMISSION_TTL_SECONDS,
    });
  } catch {
    return page("<h1>Something went wrong on our side</h1>", 500);
  }
  return acceptedPage(fixture);
}
