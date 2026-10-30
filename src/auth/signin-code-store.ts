// Sign-in code storage (D07 T02 §11; migration 0035): issuing a code for a link, checking a typed one with an atomic
// attempt claim, and closing a row. The code, the seal and the cookie are ./signin-code, which has no storage, so the
// pages that show the code field can be rendered and checked in a browser without D1.
import { MAGIC_LINK_SECONDS } from "./schema";
import {
  codeMac,
  codeMatches,
  drawCode,
  handleHash,
  MAX_ATTEMPTS,
  sealToken,
  unsealToken,
  validHandle,
} from "./signin-code";

export type Issue = { email: string; token: string; callbackURL: string; handle: string; now?: number };

// Store a code for a link the browser holding `handle` asked for: one row per handle, the latest replacing the last
// (the attempts start again), and expired rows swept on the way.
export async function issueSignInCode(db: D1Database, secret: string, issue: Issue, code = drawCode()) {
  const now = issue.now ?? Date.now();
  const [hash, box, mac] = await Promise.all([
    handleHash(issue.handle),
    sealToken(secret, issue.token),
    codeMac(secret, issue.handle, code),
  ]);
  await db.batch([
    db.prepare("DELETE FROM signin_codes WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        "INSERT INTO signin_codes (handle_hash, email, token_box, code_mac, callback_url, expires_at, attempts, used_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL) ON CONFLICT (handle_hash) DO UPDATE SET email = excluded.email, token_box = excluded.token_box, code_mac = excluded.code_mac, callback_url = excluded.callback_url, expires_at = excluded.expires_at, attempts = 0, used_at = NULL",
      )
      .bind(hash, issue.email, box, mac, issue.callbackURL, now + MAGIC_LINK_SECONDS * 1000),
  ]);
  return code;
}

type Row = { email: string; token_box: string; code_mac: string; callback_url: string; attempts: number };

export type CodeCheck =
  | { kind: "match"; token: string; callbackURL: string; email: string; handleHash: string }
  | { kind: "wrong"; left: number }
  | { kind: "locked" }
  | { kind: "expired" }
  | { kind: "no-request" };

// Check a typed code against the browser's row. One statement claims an attempt, so parallel guesses take at most three
// between them; the code is then compared by its MAC.
export async function checkCode(
  db: D1Database,
  secret: string,
  handle: string | undefined,
  code: string,
  now = Date.now(),
): Promise<CodeCheck> {
  if (!validHandle(handle)) return { kind: "no-request" };
  const hash = await handleHash(handle);
  const claimed = await db
    .prepare(
      "UPDATE signin_codes SET attempts = attempts + 1 WHERE handle_hash = ? AND used_at IS NULL AND expires_at > ? AND attempts < ? RETURNING email, token_box, code_mac, callback_url, attempts",
    )
    .bind(hash, now, MAX_ATTEMPTS)
    .first<Row>();
  if (!claimed) {
    const row = await db
      .prepare("SELECT attempts, expires_at, used_at FROM signin_codes WHERE handle_hash = ?")
      .bind(hash)
      .first<{ attempts: number; expires_at: number; used_at: number | null }>();
    if (!row || row.used_at !== null) return { kind: "no-request" };
    return row.expires_at <= now ? { kind: "expired" } : { kind: "locked" };
  }
  if (await codeMatches(secret, handle, code, claimed.code_mac)) {
    const token = await unsealToken(secret, claimed.token_box);
    if (token === null) return { kind: "no-request" };
    return { kind: "match", token, callbackURL: claimed.callback_url, email: claimed.email, handleHash: hash };
  }
  const left = MAX_ATTEMPTS - claimed.attempts;
  return left > 0 ? { kind: "wrong", left } : { kind: "locked" };
}

// A right code whose verify was throttled gives its attempt back: the same code works once the limiter lets it.
export const giveBack = (db: D1Database, hash: string) =>
  db
    .prepare(
      "UPDATE signin_codes SET attempts = attempts - 1 WHERE handle_hash = ? AND attempts > 0 AND used_at IS NULL",
    )
    .bind(hash)
    .run();

export const markUsed = (db: D1Database, hash: string, now = Date.now()) =>
  db.prepare("UPDATE signin_codes SET used_at = ? WHERE handle_hash = ? AND used_at IS NULL").bind(now, hash).run();
