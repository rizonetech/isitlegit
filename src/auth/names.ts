import { APIError } from "better-auth/api";

// A name as stored: trimmed, at most 100 characters, one line with no control characters (D07 T02 §22); anything else
// is refused with a typed 400 and nothing stored. A user written without a name keeps Better Auth's own default.
export const NAME_LIMIT = 100;
export function boundedName(name: unknown): { name?: string } {
  if (name === undefined) return {};
  const trimmed = typeof name === "string" ? name.trim() : "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  if (typeof name !== "string" || trimmed.length > NAME_LIMIT || /[\u0000-\u001f\u007f]/.test(trimmed))
    throw new APIError("BAD_REQUEST", {
      code: "INVALID_NAME",
      message: `a name is one line of at most ${NAME_LIMIT} characters`,
    });
  return { name: trimmed };
}
