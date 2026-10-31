import { APIError } from "better-auth/api";

// A name as stored: trimmed, at most 100 characters, one line with no control characters (D07 T02 §22); anything else
// is refused with a typed 400 and nothing stored. A user written without a name keeps Better Auth's own default.
export const NAME_LIMIT = 100;
// Not one line of plain text: every control character (C0 and C1, \p{Cc}), the Unicode line and paragraph separators
// (\p{Zl}, \p{Zp}), and the bidirectional overrides and isolates, which would reverse a name drawn in mail or a page.
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u;
export function boundedName(name: unknown): { name?: string } {
  if (name === undefined) return {};
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (typeof name !== "string" || trimmed.length > NAME_LIMIT || UNSAFE.test(trimmed))
    throw new APIError("BAD_REQUEST", {
      code: "INVALID_NAME",
      message: `a name is one line of at most ${NAME_LIMIT} characters`,
    });
  return { name: trimmed };
}
