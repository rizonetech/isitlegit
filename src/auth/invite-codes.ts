// Invite codes the operator makes on /admin/invites (D07 T05 §2; design/SPEC.md X3): the script's alphabet and its
// one-print shape (scripts/invite-code.ts), reimplemented on Web Crypto so the Worker makes them too. A code is
// random, shown once on the page that makes it, and stored only as its SHA-256; no later visit shows or copies it
// (the X3 Deviation in design/SPEC.md). The hash is the same bytes the script and signup store
// (scripts/invite-code.ts `hashCode`, src/auth/signup.ts `codeHash`), so a code made here redeems there; the agreement
// is tested, not assumed.
const encoder = new TextEncoder();
export const hashInviteCode = async (code: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(code.trim())))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// The script's unambiguous letters and digits, in four groups of four.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newInviteCode(
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const bytes = randomBytes(16);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

// An empty Expires date reads Never: the far-future instant stored for it, past any real code and accepted by
// signup's `expires_at > now` check. A date reads back from SAST, not UTC, so a code for 13 Nov works all of 13 Nov
// in South Africa.
export const NEVER_EXPIRES = "9999-12-31T00:00:00.000Z";
const SAST_MS = 2 * 3_600_000;

// A SAST calendar day ("2026-11-13"), or null when the text is not one.
export function parseSastDate(text: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split("-").map(Number);
  const atMidnightUtc = Date.parse(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(atMidnightUtc)) return null;
  const back = new Date(atMidnightUtc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== m || back.getUTCDate() !== d) return null;
  return text;
}

// The SAST day an instant falls on ("2026-11-13").
export const sastDayOf = (iso: string): string => new Date(Date.parse(iso) + SAST_MS).toISOString().slice(0, 10);

export type InviteDraft = { label: string; uses: string; expires: string };
export type InviteErrors = { label?: string; uses?: string; expires?: string };
export type InviteValue = { label: string; maxUses: number; expiresAt: string };

// What the form keeps: the label rule is the script's (scripts/invite-code.ts), the uses bound its own, and an empty
// expiry reads Never. A field error is refused under its field with the typed values kept and nothing stored.
const LABEL = /^[A-Za-z0-9 _.,:()-]{1,200}$/;
export function parseInviteForm(draft: InviteDraft, today: string): { value: InviteValue } | { errors: InviteErrors } {
  const errors: InviteErrors = {};
  const label = draft.label.trim();
  if (!LABEL.test(label)) errors.label = "a label is 1 to 200 letters, digits, spaces and _.,:()-";
  const uses = Number(draft.uses);
  if (!Number.isInteger(uses) || uses < 1 || uses > 10_000)
    errors.uses = "organisations is a whole number from 1 to 10000";
  let expiresAt = NEVER_EXPIRES;
  if (draft.expires.trim()) {
    const day = parseSastDate(draft.expires.trim());
    if (!day || day <= today) errors.expires = "expires is a date like 2026-11-13 after today, or empty for never";
    else expiresAt = `${day}T22:00:00.000Z`;
  }
  if (errors.label ?? errors.uses ?? errors.expires) return { errors };
  return { value: { label, maxUses: uses, expiresAt } };
}

export type InviteRow = { uses: number; max_uses: number; expires_at: string; revoked_at: string | null };
export type InviteStatus = "Active" | "Used up" | "Expired" | "Revoked";

// Revoked first (a deliberate stop stays one), then used up (every organisation joined), then expired by time.
export function inviteStatus(row: InviteRow, nowIso: string): InviteStatus {
  if (row.revoked_at !== null) return "Revoked";
  if (row.uses >= row.max_uses) return "Used up";
  if (row.expires_at <= nowIso) return "Expired";
  return "Active";
}

// A code's identifier in the list: the hash cannot show the code, so the first bytes stand in for it. They identify
// the row (and match logs) without letting anyone sign up: the preimage still does not exist.
export const codeTag = (hash: string): string => hash.slice(0, 8);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "27 Oct".
export function sastShort(iso: string): string {
  const at = new Date(Date.parse(iso) + SAST_MS);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}
// The expiry as the operator picked it: a code running to the end of a SAST day reads that day ("Thu 13 Nov 2026"),
// not the midnight instant after it that is stored, and the sentinel reads Never.
export function sastExpiry(expiresAt: string): string {
  if (expiresAt >= "9999-01-01") return "Never";
  const at = new Date(Date.parse(expiresAt) - 1000 + SAST_MS);
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

// "51 s", "2 min 40 s", "3 h 5 min": the time-to-verdict tile's words.
export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return s % 60 ? `${minutes} min ${s % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

// One CSV cell: quoted when it holds a comma, quote, or line break, and guarded with a leading `'` when a
// spreadsheet would read it as a formula, so an organisation named `=cmd()` exports as text.
export function csvCell(value: string | number): string {
  const text = String(value);
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
