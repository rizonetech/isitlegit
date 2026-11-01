// The standard security handler with an empty user password (D06 T02 §5; ISO 32000-1 section 7.6.3, revisions 2 and
// 3, RC4): a file a bank or accounting system encrypts but anyone may open. The key is derived from the empty password
// (algorithm 2), proven by the user password check (algorithms 4 and 5), and each object's strings and streams are
// decrypted with a key from the file key and the object's number and generation (algorithm 1). A non-empty password is
// never guessed: a file that needs one stays unread. D06 T02 §6 adds AES: revision 4 (AES-128, the `AESV2` crypt
// filter, the same key derivation with the `sAlT` object key of 7.6.2) and revision 6 (AES-256, `AESV3`, ISO 32000-2
// 7.6.4.3.3 algorithms 2.A and 2.B, the file key used for every object), all through Web Crypto.

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
  revision: 2 | 3 | 4;
  // Revision 4's /EncryptMetadata false adds 0xFFFFFFFF to the key's hash (algorithm 2, step f).
  encryptMetadata?: boolean;
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
  const unencryptedMetadata =
    h.revision === 4 && h.encryptMetadata === false ? [Uint8Array.of(0xff, 0xff, 0xff, 0xff)] : [];
  let digest = await md5(concat(PADDING, h.owner.subarray(0, 32), p, h.id, ...unencryptedMetadata));
  const n = h.revision === 2 ? 5 : h.keyLength;
  if (h.revision >= 3) for (let i = 0; i < 50; i++) digest = await md5(digest.subarray(0, n));
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
// and for AES-128 the bytes `sAlT`, hashed, then at most 16 bytes of it.
const SALT = Uint8Array.from([0x73, 0x41, 0x6c, 0x54]);
export async function objectKey(key: Uint8Array, num: number, gen: number, aes = false): Promise<Uint8Array> {
  const extra = Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
  return (await md5(aes ? concat(key, extra, SALT) : concat(key, extra))).subarray(0, Math.min(key.length + 5, 16));
}

const buffer = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
const aesKey = (key: Uint8Array, use: "encrypt" | "decrypt") =>
  crypto.subtle.importKey("raw", buffer(key), { name: "AES-CBC" }, false, [use]);

// A string's or stream's AES data (7.6.2): a 16-byte IV, then CBC ciphertext padded as PKCS#7. Null when it is not:
// shorter than the IV, not whole blocks, or padding that fails, so the caller names it damaged; never a throw.
export async function aesDecrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array | null> {
  if (data.length < 16 || data.length % 16 !== 0) return null;
  // An IV and nothing after it is how some writers store an empty string.
  if (data.length === 16) return new Uint8Array(0);
  try {
    const iv = data.subarray(0, 16);
    const out = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: buffer(iv) },
      await aesKey(key, "decrypt"),
      buffer(data.subarray(16)),
    );
    return new Uint8Array(out);
  } catch {
    return null;
  }
}

// CBC without padding, which Web Crypto always adds: encrypting whole blocks gives them, then one padding block, so the
// last block is dropped; decrypting whole blocks needs a valid last block, so one is made that decrypts to a full
// padding block (the encryption, chained on the last ciphertext block, of sixteen 0x10 bytes) and the padding it
// becomes is removed by Web Crypto. Both are revision 6's (algorithm 2.B's rounds and the `UE` key, 7.6.4.3.3).
async function cbcEncryptWhole(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const out = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: buffer(iv) },
    await aesKey(key, "encrypt"),
    buffer(data),
  );
  return new Uint8Array(out).subarray(0, data.length);
}
async function cbcDecryptWhole(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array | null> {
  if (data.length === 0 || data.length % 16 !== 0) return null;
  const last = data.subarray(data.length - 16);
  const pad = await cbcEncryptWhole(key, last, new Uint8Array(16).fill(0x10));
  try {
    const out = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: buffer(iv) },
      await aesKey(key, "decrypt"),
      buffer(concat(data, pad)),
    );
    return new Uint8Array(out);
  } catch {
    return null;
  }
}

const sha = async (name: "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest(name, buffer(data)));

// ISO 32000-2 algorithm 2.B: the hash of a password, a salt and (for the owner) the user key data. Rounds of AES-128-CBC
// over 64 copies of the password, the last hash and the user data, each round's hash chosen by the first 16 bytes of
// its output taken as a number modulo 3, until at least 64 rounds and the last byte of the output is no more than the
// round number less 32.
export async function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Uint8Array> {
  let k = await sha("SHA-256", concat(password, salt, udata));
  for (let round = 0; ; ) {
    const one = concat(password, k, udata);
    const k1 = new Uint8Array(one.length * 64);
    for (let i = 0; i < 64; i++) k1.set(one, i * one.length);
    const e = await cbcEncryptWhole(k.subarray(0, 16), k.subarray(16, 32), k1);
    // A 128-bit big-endian number modulo 3 is the sum of its bytes modulo 3, as 256 is 1 modulo 3.
    const mod = e.subarray(0, 16).reduce((sum, b) => sum + b, 0) % 3;
    k = await sha(mod === 0 ? "SHA-256" : mod === 1 ? "SHA-384" : "SHA-512", e);
    round++;
    if (round >= 64 && (e[e.length - 1] as number) <= round - 32) break;
  }
  return k.subarray(0, 32);
}

// Revision 6's file key for the empty user password (algorithm 2.A): the stored `U` is a 32-byte hash, an 8-byte
// validation salt and an 8-byte key salt; the empty password opens the file when its hash with the validation salt is
// the stored one, and the file key is `UE` decrypted under its hash with the key salt (a zero IV, no padding). Null when
// the empty password does not open it.
export async function fileKeyV6(u: Uint8Array, ue: Uint8Array): Promise<Uint8Array | null> {
  if (u.length < 48 || ue.length !== 32) return null;
  const empty = new Uint8Array(0);
  const check = await hash2B(empty, u.subarray(32, 40), empty);
  if (!check.every((b, i) => b === u[i])) return null;
  const intermediate = await hash2B(empty, u.subarray(40, 48), empty);
  const key = await cbcDecryptWhole(intermediate, new Uint8Array(16), ue);
  return key && key.length === 32 ? key : null;
}
