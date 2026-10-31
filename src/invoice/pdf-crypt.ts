// The standard security handler with an empty user password (D06 T02 §5; ISO 32000-1 section 7.6.3, revisions 2 and
// 3, RC4): a file a bank or accounting system encrypts but anyone may open. The key is derived from the empty password
// (algorithm 2), proven by the user password check (algorithms 4 and 5), and each object's strings and streams are
// decrypted with a key from the file key and the object's number and generation (algorithm 1). A non-empty password is
// never guessed: a file that needs one stays unread. AES (revisions 4 and 6) is D06 T02 §6's.

// 7.6.3.3: the 32-byte padding an empty password becomes.
const PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

// RC4, which Web Crypto lacks: the key schedule, then the keystream XORed over the data.
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + (s[i] as number) + (key[i % key.length] as number)) & 0xff;
    [s[i], s[j]] = [s[j] as number, s[i] as number];
  }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + (s[i] as number)) & 0xff;
    [s[i], s[j]] = [s[j] as number, s[i] as number];
    out[n] = (data[n] as number) ^ (s[((s[i] as number) + (s[j] as number)) & 0xff] as number);
  }
  return out;
}

// MD5 through the Workers runtime's digest (a non-standard algorithm Workers provide).
export async function md5(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("MD5", data as Uint8Array<ArrayBuffer>));
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export type Handler = {
  revision: 2 | 3;
  keyLength: number;
  owner: Uint8Array;
  user: Uint8Array;
  permissions: number;
  id: Uint8Array;
};

// The file key for the empty user password (algorithm 2), or null when the empty password does not open the file.
export async function fileKey(h: Handler): Promise<Uint8Array | null> {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setInt32(0, h.permissions, true);
  let digest = await md5(concat(PADDING, h.owner.subarray(0, 32), p, h.id));
  const n = h.revision === 2 ? 5 : h.keyLength;
  if (h.revision === 3) for (let i = 0; i < 50; i++) digest = await md5(digest.subarray(0, n));
  const key = digest.subarray(0, n);
  // Algorithms 4 (revision 2) and 5 (revision 3): the user hash the empty password gives must be the stored one.
  if (h.revision === 2) {
    const u = rc4(key, PADDING);
    return u.every((b, i) => b === h.user[i]) ? key : null;
  }
  let u = rc4(key, await md5(concat(PADDING, h.id)));
  for (let i = 1; i <= 19; i++)
    u = rc4(
      key.map((b) => b ^ i),
      u,
    );
  return u.every((b, i) => b === h.user[i]) ? key : null;
}

// An object's key (algorithm 1): the file key, the object number's low three bytes and its generation's low two bytes,
// hashed, then at most 16 bytes of it.
export async function objectKey(key: Uint8Array, num: number, gen: number): Promise<Uint8Array> {
  const extra = Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
  return (await md5(concat(key, extra))).subarray(0, Math.min(key.length + 5, 16));
}
