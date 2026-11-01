// Sign-in code storage (D07 T02 §11; migration 0035): a row per link a browser asked for, a typed code checked with an
// atomic attempt claim, and a row closed. The code, the seal and the cookie are ./signin-code, which has no storage, so
// the pages that show the code field can be rendered and checked in a browser without D1.
//
// Every request leaves the same state whatever becomes of its mail: its row is written before the mail goes, and a
// refused mail turns the row's token into a decoy rather than removing it. A browser's codes are claimed together, so
// what it sees of its own code (works, how many tries are left, locked) never tells whether a later request it made was
// for an address that may sign in.
import { MAGIC_LINK_SECONDS } from "./schema";
import {
  codeMac,
  codeMatches,
  drawCode,
  handleHash,
  MAX_ATTEMPTS,
  newHandle,
  sealToken,
  unsealToken,
  validHandle,
} from "./signin-code";

// The token's SHA-256, hex: what the row keeps to be found by from its link (migration 0066).
export async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Issue = { email: string; token: string; callbackURL: string; handle: string; now?: number };

// Store a code for a link the browser holding `handle` asked for, before its mail goes; expired rows are swept on the
// way. Returns the row's id, for `decoy` or `withdraw` once the send's outcome is known.
export async function issueSignInCode(db: D1Database, secret: string, issue: Issue, code = drawCode()) {
  const now = issue.now ?? Date.now();
  const id = crypto.randomUUID();
  const [hash, box, mac, tokenHash] = await Promise.all([
    handleHash(issue.handle),
    sealToken(secret, issue.token),
    codeMac(secret, issue.handle, code),
    tokenFingerprint(issue.token),
  ]);
  await db.batch([
    db.prepare("DELETE FROM signin_codes WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        "INSERT INTO signin_codes (id, handle_hash, email, token_box, code_mac, callback_url, issued_at, expires_at, attempts, used_at, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)",
      )
      .bind(id, hash, issue.email, box, mac, issue.callbackURL, now, now + MAGIC_LINK_SECONDS * 1000, tokenHash),
  ]);
  return id;
}

// Whether a link was asked for by another browser than the one opening it (D07 T02 §12), by one read and no write: a
// live row (unused, unexpired, with code tries left) names the link's token under a handle that is not the opening
// browser's, or the browser holds no handle at all. False when the browser holds it, when no row names the token (an
// invitation, a link issued before the column), or when the asking device's tries are used up: its code can no longer
// sign in, so this device is the member's only way.
export async function askedElsewhere(
  db: D1Database,
  handle: string | undefined,
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const rows = await db
    .prepare(
      "SELECT handle_hash FROM signin_codes WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?",
    )
    .bind(await tokenFingerprint(token), now, MAX_ATTEMPTS)
    .all<{ handle_hash: string }>();
  if (rows.results.length === 0) return false;
  const mine = validHandle(handle) ? await handleHash(handle) : null;
  return !rows.results.some((row) => row.handle_hash === mine);
}

// A refused mail: the row stays, its token replaced by a random one that opens nothing.
export async function decoy(db: D1Database, secret: string, id: string) {
  await db
    .prepare("UPDATE signin_codes SET token_box = ? WHERE id = ?")
    .bind(await sealToken(secret, `decoy-${newHandle()}`), id)
    .run();
}

// A send that failed (the request answers with an error, not a neutral page): the row goes.
export async function withdraw(db: D1Database, id: string) {
  await db.prepare("DELETE FROM signin_codes WHERE id = ?").bind(id).run();
}

type Row = { id: string; email: string; token_box: string; code_mac: string; callback_url: string; attempts: number };

export type CodeCheck =
  | { kind: "match"; id: string; token: string; callbackURL: string; email: string; claimed: string[] }
  | { kind: "wrong"; left: number }
  | { kind: "locked" }
  | { kind: "expired" }
  | { kind: "no-request" };

// Check a typed code against the browser's codes. One statement claims an attempt on every live row of the handle, so
// parallel guesses take at most three from each between them; the code is then compared with each row's MAC.
export async function checkCode(
  db: D1Database,
  secret: string,
  handle: string | undefined,
  code: string,
  now = Date.now(),
): Promise<CodeCheck> {
  if (!validHandle(handle)) return { kind: "no-request" };
  const hash = await handleHash(handle);
  const claimed = (
    await db
      .prepare(
        "UPDATE signin_codes SET attempts = attempts + 1 WHERE handle_hash = ? AND used_at IS NULL AND expires_at > ? AND attempts < ? RETURNING id, email, token_box, code_mac, callback_url, attempts",
      )
      .bind(hash, now, MAX_ATTEMPTS)
      .all<Row>()
  ).results;
  if (claimed.length === 0) {
    const last = await db
      .prepare(
        "SELECT expires_at, used_at FROM signin_codes WHERE handle_hash = ? ORDER BY issued_at DESC, rowid DESC LIMIT 1",
      )
      .bind(hash)
      .first<{ expires_at: number; used_at: number | null }>();
    if (!last || last.used_at !== null) return { kind: "no-request" };
    return last.expires_at <= now ? { kind: "expired" } : { kind: "locked" };
  }
  for (const row of claimed)
    if (await codeMatches(secret, handle, code, row.code_mac)) {
      const token = await unsealToken(secret, row.token_box);
      if (token === null) break;
      return {
        kind: "match",
        id: row.id,
        token,
        callbackURL: row.callback_url,
        email: row.email,
        claimed: claimed.map((r) => r.id),
      };
    }
  // The most tries any of the browser's codes has left: a later code it asked for is a fresh start.
  const left = Math.max(...claimed.map((row) => MAX_ATTEMPTS - row.attempts));
  return left > 0 ? { kind: "wrong", left } : { kind: "locked" };
}

// A right code whose verify was throttled gives back the attempts it claimed: the same code works once the limiter lets
// it.
export async function giveBack(db: D1Database, ids: string[]) {
  if (ids.length === 0) return;
  await db.batch(
    ids.map((id) =>
      db
        .prepare("UPDATE signin_codes SET attempts = attempts - 1 WHERE id = ? AND attempts > 0 AND used_at IS NULL")
        .bind(id),
    ),
  );
}

// Async, so any failure (a throw from `prepare` included) is a rejection its caller's catch sees.
export async function markUsed(db: D1Database, id: string, now = Date.now()) {
  await db.prepare("UPDATE signin_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, id).run();
}
