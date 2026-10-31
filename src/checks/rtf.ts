// An RTF document's embedded objects, read statically (D02 T04 §9): never opened, never run. The objects are found as
// the RTF specification gives them (`\objdata` destinations, hex digits with whitespace ignored, `\bin N` runs of raw
// bytes), each decoded as an OLE 1.0 object (MS-OLEDS 2.2: ObjectHeader, then the embedded object's native data), and a
// `Package` object's native data as oletools' `OleNativeStream` reads it. Pure: the caller reads the document's bytes.

export const MAX_RTF_OBJECTS = 20;
export const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

// One `\objdata` destination: its decoded bytes, or why they could not be had.
export type RtfObject = { bytes: Uint8Array } | { unread: "damaged" | "too large" };

const isLetter = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;
const isSpace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
const hexValue = (b: number) =>
  isDigit(b) ? b - 0x30 : b >= 0x61 && b <= 0x66 ? b - 0x57 : b >= 0x41 && b <= 0x46 ? b - 0x37 : -1;

// The document's objects in order, at most MAX_RTF_OBJECTS, and how many more there were. A damaged object (an odd count
// of hex digits, a character that is not one, a group left open) is that object's alone: the reader goes on from the
// end of its group, braces counted and `\bin` runs skipped by their length, so the objects after it are still read.
export function rtfObjects(doc: Uint8Array): { objects: RtfObject[]; more: number } {
  const objects: RtfObject[] = [];
  let more = 0;
  let level = 0;
  // The open `\objdata` destination: the group level it ends below, and what it has decoded so far.
  let open: { level: number; out: Uint8Array; length: number; high: number; damaged: boolean; over: boolean } | null =
    null;
  const push = (b: number) => {
    if (!open || open.over || open.damaged) return;
    if (open.length >= MAX_OBJECT_BYTES) {
      open.over = true;
      return;
    }
    if (open.length === open.out.length) {
      const grown = new Uint8Array(Math.min(MAX_OBJECT_BYTES, Math.max(1024, open.out.length * 2)));
      grown.set(open.out);
      open.out = grown;
    }
    open.out[open.length++] = b;
  };
  const nibble = (v: number) => {
    if (!open) return;
    if (open.high < 0) open.high = v;
    else {
      push((open.high << 4) | v);
      open.high = -1;
    }
  };
  const close = () => {
    if (!open) return;
    const done = open;
    open = null;
    if (objects.length >= MAX_RTF_OBJECTS) {
      more++;
      return;
    }
    if (done.over) objects.push({ unread: "too large" });
    else if (done.damaged || done.high >= 0) objects.push({ unread: "damaged" });
    else objects.push({ bytes: done.out.slice(0, done.length) });
  };
  let i = 0;
  while (i < doc.length) {
    const b = doc[i] as number;
    if (b === 0x7b) {
      level++;
      i++;
    } else if (b === 0x7d) {
      level--;
      i++;
      if (open && level < open.level) close();
    } else if (b === 0x5c) {
      const next = doc[i + 1];
      if (next !== undefined && isLetter(next)) {
        let j = i + 1;
        while (j < doc.length && isLetter(doc[j] as number)) j++;
        const word = new TextDecoder().decode(doc.subarray(i + 1, j));
        let k = j;
        if (doc[k] === 0x2d) k++;
        while (k < doc.length && isDigit(doc[k] as number)) k++;
        const param =
          k > j && !(k === j + 1 && doc[j] === 0x2d) ? Number(new TextDecoder().decode(doc.subarray(j, k))) : null;
        if (doc[k] === 0x20) k++;
        i = k;
        if (word === "bin") {
          // `\bin N`: N raw bytes, braces and backslashes among them; a missing or negative N is none (oletools).
          const n = Math.min(Math.max(param ?? 0, 0), doc.length - i);
          if (open)
            for (let x = 0; x < n; x++) {
              const raw = doc[i + x] as number;
              nibble(raw >> 4);
              nibble(raw & 0x0f);
            }
          i += n;
        } else if (word === "objdata" && !open) {
          open = { level, out: new Uint8Array(0), length: 0, high: -1, damaged: false, over: false };
        }
      } else {
        // A control symbol (`\*`, `\{`, `\}`, `\\`, `\'hh`): taken as it stands, never a group's brace.
        i += next === 0x27 ? 4 : 2;
      }
    } else {
      if (open && !isSpace(b)) {
        const v = hexValue(b);
        if (v < 0) open.damaged = true;
        else nibble(v);
      }
      i++;
    }
  }
  // A destination left open when the document ends is damaged, never a whole object.
  if (open) {
    (open as { damaged: boolean }).damaged = true;
    close();
  }
  return { objects, more };
}

// An OLE 1.0 object's class and native data (MS-OLEDS 2.2.4 ObjectHeader, 2.2.5 EmbeddedObject); "linked" for a
// linked object (FormatID 1), which carries no data of its own; null when the header or the data does not hold.
export type OleObject = { className: string; data: Uint8Array };
export function oleObject(bytes: Uint8Array): OleObject | "linked" | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const u32 = () => {
    if (at + 4 > bytes.length) return null;
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const prefixed = () => {
    const n = u32();
    if (n === null || at + n > bytes.length) return null;
    const text = new TextDecoder("latin1").decode(bytes.subarray(at, n ? at + n - 1 : at));
    at += n;
    return text;
  };
  if (u32() === null) return null;
  const format = u32();
  if (format === 1) return "linked";
  if (format !== 2) return null;
  const className = prefixed();
  if (className === null || prefixed() === null || prefixed() === null) return null;
  const size = u32();
  if (size === null || at + size > bytes.length) return null;
  return { className, data: bytes.subarray(at, at + size) };
}

// A `Package` object's packaged file (oletools' `OleNativeStream` with `package=True`): a 2-byte header, the file name
// and source path NUL-ended, two 4-byte fields, the temporary path NUL-ended, the data's 4-byte size, then the data.
export function packagedFile(native: Uint8Array): { name: string; data: Uint8Array } | null {
  let at = 2;
  const cstring = () => {
    const end = native.indexOf(0, at);
    if (end < 0) return null;
    const text = new TextDecoder("latin1").decode(native.subarray(at, end));
    at = end + 1;
    return text;
  };
  if (native.length < 2) return null;
  const name = cstring();
  if (name === null || cstring() === null) return null;
  at += 8;
  if (cstring() === null || at + 4 > native.length) return null;
  const size = new DataView(native.buffer, native.byteOffset + at, 4).getUint32(0, true);
  at += 4;
  if (at + size > native.length) return null;
  return { name, data: native.subarray(at, at + size) };
}
