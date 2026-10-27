// ULIDs for case ids (D01 T01 §1, required by the artefact store in §2): 48 bits of milliseconds then 80 random bits,
// in Crockford's base32, 26 characters. Ids from different milliseconds sort by creation time; two from the same
// millisecond sort at random (the ULID spec's plain mode, not its monotonic one). Small enough to own here.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function ulid(now = Date.now()): string {
  let time = "";
  for (let rest = now, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) time = ALPHABET[rest % 32] + time;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = "";
  for (const byte of bytes) random += ALPHABET[byte % 32];
  return time + random;
}

export const isUlid = (value: string) => ULID.test(value);
