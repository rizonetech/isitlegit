// Synthetic archives (D02 T04 §3), built byte by byte from their formats: ZIP (APPNOTE), RAR4 and RAR5 (the RAR
// technotes), 7z (7zFormat.txt). Checksums are left zero: nothing here is read by an unpacker, only by the header walker.
const enc = (s: string) => new TextEncoder().encode(s);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const le = (value: number, bytes: number) => {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
};

// A stored (uncompressed) ZIP: local headers, data, the central directory and its end record; `extra` is a member's
// central extra field.
export function zip(
  entries: { name: string; data?: Uint8Array; encrypted?: boolean; extra?: Uint8Array }[],
): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc(e.name);
    const data = e.data ?? new Uint8Array(0);
    const flags = e.encrypted ? 1 : 0;
    const local = join(
      le(0x04034b50, 4),
      le(20, 2),
      le(flags, 2),
      le(0, 2),
      le(0, 4),
      le(0, 4),
      le(data.length, 4),
      le(data.length, 4),
      le(name.length, 2),
      le(0, 2),
      name,
      data,
    );
    const extra = e.extra ?? new Uint8Array(0);
    central.push(
      join(
        le(0x02014b50, 4),
        le(20, 2),
        le(20, 2),
        le(flags, 2),
        le(0, 2),
        le(0, 4),
        le(0, 4),
        le(data.length, 4),
        le(data.length, 4),
        le(name.length, 2),
        le(extra.length, 2),
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(0, 4),
        le(offset, 4),
        name,
        extra,
      ),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = join(...central);
  return join(
    ...locals,
    cd,
    le(0x06054b50, 4),
    le(0, 2),
    le(0, 2),
    le(entries.length, 2),
    le(entries.length, 2),
    le(cd.length, 4),
    le(offset, 4),
    le(0, 2),
  );
}

// A RAR5 variable-length integer.
const vint = (value: number) => {
  const out: number[] = [];
  let v = value;
  do {
    const byte = v % 128;
    v = Math.floor(v / 128);
    out.push(v ? byte | 0x80 : byte);
  } while (v);
  return new Uint8Array(out);
};
// A RAR5 header: its type, an extra area and a payload size when given; the payload's bytes follow it.
const rar5Header = (type: number, extra?: Uint8Array, payload = 0) => {
  const flags = (extra ? 1 : 0) | (payload ? 2 : 0);
  const body = join(
    vint(type),
    vint(flags),
    ...(extra ? [vint(extra.length)] : []),
    ...(payload ? [vint(payload)] : []),
    enc("file-fields"),
    ...(extra ? [extra] : []),
  );
  return join(le(0, 4), vint(body.length), body);
};
const encryptionRecord = () => {
  const data = join(vint(1), new Uint8Array(16));
  return join(vint(data.length), data);
};
export function rar5({
  archiveEncrypted = false,
  encryptedAfter = 0,
}: {
  archiveEncrypted?: boolean;
  encryptedAfter?: number;
} = {}): Uint8Array {
  const parts = [enc("Rar!\x1a\x07\x01\x00"), rar5Header(1)];
  if (archiveEncrypted) parts.push(rar5Header(4));
  // An unencrypted member of `encryptedAfter` payload bytes, then (when asked) an encrypted one.
  parts.push(rar5Header(2, undefined, encryptedAfter || 4), new Uint8Array(encryptedAfter || 4));
  if (encryptedAfter) parts.push(rar5Header(2, encryptionRecord(), 4), new Uint8Array(4));
  parts.push(rar5Header(5));
  return join(...parts);
}

// A RAR5 archive of `count` unencrypted members of `payload` bytes each, then an encrypted one.
export function rar5Many(count: number, payload: number): Uint8Array {
  const parts = [enc("Rar!\x1a\x07\x01\x00"), rar5Header(1)];
  for (let i = 0; i < count; i++) parts.push(rar5Header(2, undefined, payload), new Uint8Array(payload));
  parts.push(rar5Header(2, encryptionRecord(), 4), new Uint8Array(4), rar5Header(5));
  return join(...parts);
}

// RAR4: the main header (encrypted headers in flag 0x0080), file headers (an encrypted file in flag 0x0004).
export function rar4({ headersEncrypted = false, fileEncrypted = false } = {}): Uint8Array {
  const main = join(
    le(0, 2),
    new Uint8Array([0x73]),
    le(headersEncrypted ? 0x0080 : 0, 2),
    le(13, 2),
    new Uint8Array(6),
  );
  const name = enc("invoice.pdf");
  const data = new Uint8Array(8);
  const file = join(
    le(0, 2),
    new Uint8Array([0x74]),
    le(0x8000 | (fileEncrypted ? 0x0004 : 0), 2),
    le(32 + name.length, 2),
    le(data.length, 4),
    le(data.length, 4),
    new Uint8Array([2]),
    le(0, 4),
    le(0, 4),
    new Uint8Array([29, 0x30]),
    le(name.length, 2),
    le(0, 4),
    name,
    data,
  );
  const end = join(le(0, 2), new Uint8Array([0x7b]), le(0, 2), le(7, 2));
  return join(enc("Rar!\x1a\x07\x00"), main, file, end);
}

// 7z: the 32-byte start header naming a next header of the given bytes.
export function sevenZip(next: Uint8Array): Uint8Array {
  const payload = new Uint8Array(16);
  return join(
    new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]),
    le(0, 4),
    le(payload.length, 8),
    le(next.length, 8),
    le(0, 4),
    payload,
    next,
  );
}
export const AES = new Uint8Array([0x06, 0xf1, 0x07, 0x01]);
export const LZMA = new Uint8Array([0x03, 0x01, 0x01]);
// A 7z StreamsInfo (7zFormat.txt) with one packed stream and one folder of one coder (with properties).
const streamsInfo = (coder: Uint8Array) =>
  join(
    new Uint8Array([0x06, 0x00, 0x01, 0x09, 0x10, 0x00]),
    new Uint8Array([0x07, 0x0b, 0x01, 0x00, 0x01, 0x20 | coder.length]),
    coder,
    new Uint8Array([0x05, 0x5d, 0x00, 0x00, 0x10, 0x00]),
    new Uint8Array([0x0c, 0x20, 0x00]),
  );
// A plain header: main streams, then (when asked) a files record holding `name` in UTF-16, then its end.
export const plainHeader = (coder: Uint8Array, name = "") => {
  const utf16 = new Uint8Array(name.length * 2);
  for (let i = 0; i < name.length; i++) utf16[i * 2] = name.charCodeAt(i);
  const files = name
    ? join(new Uint8Array([0x05, 0x01, 0x11, utf16.length + 3, 0x00]), utf16, new Uint8Array([0, 0, 0x00]))
    : new Uint8Array(0);
  return join(new Uint8Array([0x01, 0x04]), streamsInfo(coder), new Uint8Array([0x00]), files, new Uint8Array([0x00]));
};
export const encodedHeader = (coder: Uint8Array) =>
  join(new Uint8Array([0x17]), streamsInfo(coder), new Uint8Array([0x00]));
// A filename whose UTF-16 bytes hold the AES coder's ID: \u06f1? no; the bytes 06 F1 07 01 as two code units.
export const AES_IN_NAME = String.fromCharCode(0xf106, 0x0107);

// A Unicode Path extra field (APPNOTE 4.6.9) naming `name` for a member whose legacy name has the given CRC-32.
export const unicodePath = (legacyCrc: number, name: string) => {
  const utf8 = enc(name);
  return join(le(0x7075, 2), le(5 + utf8.length, 2), new Uint8Array([1]), le(legacyCrc, 4), utf8);
};
// A 7z plain header with additional streams (one coder) before main streams (another).
export const plainHeaderWithAdditional = (additional: Uint8Array, main: Uint8Array) =>
  join(
    new Uint8Array([0x01, 0x03]),
    streamsInfo(additional),
    new Uint8Array([0x00, 0x04]),
    streamsInfo(main),
    new Uint8Array([0x00, 0x00]),
  );
// A RAR5 file whose first header claims a size in a four-byte number, then `trailing` bytes.
export const rar5Oversized = (trailing: number) =>
  join(enc("Rar!\x1a\x07\x01\x00"), le(0, 4), new Uint8Array([0x80, 0x80, 0x80, 0x04]), new Uint8Array(trailing));
