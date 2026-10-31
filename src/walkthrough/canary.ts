// Per-case canary credentials (D04 T02 §2; design spec 4.4a, 4.6a; migration 0046). The walkthrough types only these:
// values that name the case and could never be anyone's real credential, on a domain IsItLegit owns. The username is
// `canary-<caseShort>@canary.isitlegit.co.za`, `<caseShort>` being the last 12 characters of the case's ULID, lowercased
// (its random tail: the full case id is never handed to a phishing site). The password is `IsItLegit-Canary-` and 20
// Crockford base32 characters (100 random bits). Only the password's SHA-256 is stored, so the plaintext lives only in
// the walk that minted it; a retried walk mints a fresh password under the same username, one row per issue.
//
// Refusals are answers; a D1 failure is thrown, never answered as credentials or as "never issued", so a Workflow step
// that meets one retries it.
import { isUlid, ulid } from "../db/ulid";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DOMAIN = "canary.isitlegit.co.za";
const PASSWORD_PREFIX = "IsItLegit-Canary-";
const USERNAME = /^canary-[0-9a-hjkmnp-tv-z]{12}@canary\.isitlegit\.co\.za$/;
const PASSWORD = /^IsItLegit-Canary-[0-9A-HJKMNP-TV-Z]{20}$/;

export type Canary = { username: string; password: string };
export type CanaryIssue = ({ ok: true } & Canary) | { ok: false; reason: "invalid_case_id" | "no_case" };
export type CanaryTrace =
  | { kind: "not_canary" }
  | { kind: "unknown_username" }
  | { kind: "wrong_password"; caseId: string }
  | { kind: "match"; caseId: string };

export const isCanaryUsername = (value: string) => USERNAME.test(value);
export const isCanaryPassword = (value: string) => PASSWORD.test(value);

// True only for a value in exact canary form: no trimming and no case folding, so a near miss is not a canary.
export const isCanary = (value: string) => isCanaryUsername(value) || isCanaryPassword(value);

export const canaryUsername = (caseId: string) => `canary-${caseId.slice(-12).toLowerCase()}@${DOMAIN}`;

function randomPassword(): string {
  // 256 is a multiple of 32, so `byte % 32` is uniform over the alphabet.
  let tail = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(20))) tail += ALPHABET[byte % 32];
  return PASSWORD_PREFIX + tail;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mints and records a canary for a stored case. Every call is a new issue with a new password.
export async function canaryFor(db: D1Database, caseId: string): Promise<CanaryIssue> {
  if (!isUlid(caseId)) return { ok: false, reason: "invalid_case_id" };
  const username = canaryUsername(caseId);
  const password = randomPassword();
  // One statement, so a case deleted between a check and the insert cannot leave a row: the insert selects the case.
  const result = await db
    .prepare(
      `INSERT INTO canaries (id, case_id, username, password_hash, created_at)
       SELECT ?, id, ?, ?, ? FROM cases WHERE id = ?`,
    )
    .bind(ulid(), username, await sha256Hex(password), new Date().toISOString(), caseId)
    .run();
  if (result.meta.changes !== 1) return { ok: false, reason: "no_case" };
  return { ok: true, username, password };
}

// Traces a submitted pair to the case it was issued to.
export async function traceCanary(db: D1Database, username: string, password: string): Promise<CanaryTrace> {
  if (!isCanaryUsername(username) || !isCanaryPassword(password)) return { kind: "not_canary" };
  const { results } = await db
    .prepare("SELECT case_id, password_hash FROM canaries WHERE username = ? ORDER BY id")
    .bind(username)
    .all<{ case_id: string; password_hash: string }>();
  const [first] = results;
  if (!first) return { kind: "unknown_username" };
  const hash = await sha256Hex(password);
  const issue = results.find((row) => row.password_hash === hash);
  if (issue) return { kind: "match", caseId: issue.case_id };
  return { kind: "wrong_password", caseId: first.case_id };
}
