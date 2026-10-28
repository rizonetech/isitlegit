// An Outlook .msg's compound file ([MS-CFB]) read and checked before @kenjiuno/msgreader sees it (D01 T01 §6 round 1).
// msgreader trusts the file's structure: a DIFAT chain that loops ran it for ever, a forged stream size had it allocate
// 256 MiB, and directory entries sharing one long chain would have it read the same bytes once per entry. This reads
// the header, the DIFAT, the FAT, the directory, the mini FAT and every stream's chain, and refuses a file where any
// chain leaves the file, loops, ends short of its stream's size, or uses a sector another chain already owns, or whose
// directory tree loops. What passes is bounded by the file: each sector belongs to at most one chain, so reading every
// stream costs at most the file's own size.
import { ParseError } from "./mime";

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const NO_STREAM = 0xffffffff;
const MINI_SECTOR = 64;
const MINI_STREAM_CUTOFF = 4096;
const ENTRY_BYTES = 128;

export type CfbEntry = {
  // The entry's index in the directory: msgreader's `dataId` and `folderId`.
  id: number;
  name: string;
  kind: "root" | "storage" | "stream" | "unused";
  size: number;
  // Where the entry sits in the file, so a copy can hide it from msgreader (see `hide`).
  offset: number;
  parent: CfbEntry | null;
  children: CfbEntry[];
};

export type CompoundFile = {
  root: CfbEntry;
  entries: CfbEntry[];
  // A stream's bytes, read from its checked chain.
  read(entry: CfbEntry): Uint8Array;
};

const refuse = (why: string): never => {
  throw new ParseError(`the .msg is not a readable Outlook message file: ${why}`);
};

export function readCompoundFile(bytes: Uint8Array): CompoundFile {
  if (bytes.byteLength < 512 || SIGNATURE.some((b, i) => bytes[i] !== b)) refuse("it is not a compound file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => view.getUint32(at, true);
  const major = view.getUint16(26, true);
  const shift = view.getUint16(30, true);
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12))) refuse("its version or sector size is wrong");
  if (view.getUint16(28, true) !== 0xfffe || view.getUint16(32, true) !== 6) refuse("its header is malformed");
  if (u32(56) !== MINI_STREAM_CUTOFF) refuse("its mini stream cutoff is not 4096");
  const sector = 1 << shift;
  // Sectors after the header sector; the last may be short.
  const sectors = Math.ceil((bytes.byteLength - sector) / sector);
  const valid = (id: number) => id < sectors;
  const sectorBytes = (id: number) => bytes.subarray((id + 1) * sector, Math.min((id + 2) * sector, bytes.byteLength));
  // Every sector belongs to one chain at most ([MS-CFB] 2.3).
  const owner = new Uint8Array(sectors);
  const own = (id: number, what: string) => {
    if (!valid(id)) refuse(`${what} points past the end of the file (it may be cut off)`);
    if (owner[id]) refuse(`${what} uses a sector that is already in use`);
    owner[id] = 1;
  };

  // The FAT's sectors: the header's 109 DIFAT entries, then the DIFAT chain.
  const fatCount = u32(44);
  const difatCount = u32(72);
  if (fatCount > sectors || difatCount > sectors) refuse("its sector tables are larger than the file");
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < fatCount; i++) {
    const id = u32(76 + 4 * i);
    if (id !== FREE_SECTOR) fatSectors.push(id);
  }
  let difat = u32(68);
  // Walked to its end even when the header already named every FAT sector: msgreader walks all of it.
  for (let n = 0; n < difatCount && difat !== END_OF_CHAIN && difat !== FREE_SECTOR; n++) {
    own(difat, "the DIFAT");
    const at = (difat + 1) * sector;
    if (at + sector > bytes.byteLength) refuse("the DIFAT is cut off");
    for (let i = 0; i < sector / 4 - 1 && fatSectors.length < fatCount; i++) {
      const id = u32(at + 4 * i);
      if (id !== FREE_SECTOR) fatSectors.push(id);
    }
    difat = u32(at + sector - 4);
  }
  if (fatSectors.length !== fatCount) refuse("its FAT is incomplete");
  const fat = new Uint32Array((fatCount * sector) / 4);
  for (const [i, id] of fatSectors.entries()) {
    own(id, "the FAT");
    const at = (id + 1) * sector;
    if (at + sector > bytes.byteLength) refuse("the FAT is cut off");
    for (let k = 0; k < sector / 4; k++) fat[(i * sector) / 4 + k] = u32(at + 4 * k);
  }

  // A chain from `start` through `table`, owning each sector; refused when it leaves the file, loops or is shared.
  const chain = (start: number, table: Uint32Array, ownIt: (id: number, what: string) => void, what: string) => {
    const ids: number[] = [];
    for (let id = start; id !== END_OF_CHAIN; id = table[id] as number) {
      if (id >= table.length) refuse(`${what} points outside its table`);
      ownIt(id, what);
      ids.push(id);
    }
    return ids;
  };

  // The directory, 128 bytes an entry.
  const directory = chain(u32(48), fat, own, "the directory");
  const entries: CfbEntry[] = [];
  const raw: { left: number; right: number; child: number; start: number }[] = [];
  for (const id of directory) {
    for (let at = (id + 1) * sector; at + ENTRY_BYTES <= (id + 2) * sector; at += ENTRY_BYTES) {
      if (at + ENTRY_BYTES > bytes.byteLength) refuse("the directory is cut off");
      const type = bytes[at + 66];
      const nameBytes = view.getUint16(at + 64, true);
      if (nameBytes > 64 || nameBytes % 2) refuse("a directory entry's name is malformed");
      const name = new TextDecoder("utf-16le").decode(bytes.subarray(at, at + Math.max(0, nameBytes - 2)));
      const size = u32(at + 120);
      if (major === 4 && u32(at + 124) !== 0) refuse("a stream declares more than 4 GiB");
      entries.push({
        id: entries.length,
        name,
        kind: type === 5 ? "root" : type === 1 ? "storage" : type === 2 ? "stream" : "unused",
        size,
        offset: at,
        parent: null,
        children: [],
      });
      raw.push({ left: u32(at + 68), right: u32(at + 72), child: u32(at + 76), start: u32(at + 116) });
      if (type !== 0 && type !== 1 && type !== 2 && type !== 5) refuse("a directory entry has an unknown type");
      if (size > bytes.byteLength && type === 2)
        refuse(`a stream in the .msg declares ${size} bytes, more than the file holds`);
    }
  }
  const root = entries[0];
  if (root?.kind !== "root") refuse("it has no root entry");

  // The tree: each storage's children are the red-black tree under its child link, every entry reached once.
  const reached = new Uint8Array(entries.length);
  const link = (id: number) => {
    if (id === NO_STREAM) return null;
    if (id >= entries.length) refuse("a directory link points outside the directory");
    if (reached[id]) refuse("the directory tree loops");
    reached[id] = 1;
    return entries[id] as CfbEntry;
  };
  reached[0] = 1;
  const storages: CfbEntry[] = [root as CfbEntry];
  while (storages.length) {
    const storage = storages.pop() as CfbEntry;
    const pending = [link((raw[storage.id] as { child: number }).child)];
    while (pending.length) {
      const entry = pending.pop();
      if (!entry) continue;
      entry.parent = storage;
      storage.children.push(entry);
      if (entry.kind === "root" || entry.kind === "unused")
        refuse("the directory tree links an unused or second root entry");
      if (entry.kind === "storage") storages.push(entry);
      const links = raw[entry.id] as { left: number; right: number };
      pending.push(link(links.left), link(links.right));
    }
  }

  // The mini stream (the root's chain) and the mini FAT.
  const rootEntry = root as CfbEntry;
  const miniStream = chain((raw[0] as { start: number }).start, fat, own, "the mini stream");
  if (miniStream.length * sector < rootEntry.size) refuse("the mini stream is shorter than it declares");
  const miniSectors = Math.ceil(rootEntry.size / MINI_SECTOR);
  const miniFatChain = chain(u32(60), fat, own, "the mini FAT");
  const miniFat = new Uint32Array((miniFatChain.length * sector) / 4);
  for (const [i, id] of miniFatChain.entries()) {
    const at = (id + 1) * sector;
    if (at + sector > bytes.byteLength) refuse("the mini FAT is cut off");
    for (let k = 0; k < sector / 4; k++) miniFat[(i * sector) / 4 + k] = u32(at + 4 * k);
  }
  const miniOwner = new Uint8Array(miniSectors);
  const ownMini = (id: number, what: string) => {
    if (id >= miniSectors) refuse(`${what} points past the end of the mini stream`);
    if (miniOwner[id]) refuse(`${what} uses a mini sector that is already in use`);
    miniOwner[id] = 1;
  };

  // Every reachable stream's chain covers its size.
  const chains = new Map<CfbEntry, number[]>();
  for (const entry of entries) {
    if (entry.kind !== "stream" || !reached[entry.id] || entry.size === 0) continue;
    const start = (raw[entry.id] as { start: number }).start;
    const mini = entry.size < MINI_STREAM_CUTOFF;
    const ids = mini
      ? chain(start, miniFat, ownMini, `stream ${entry.name}`)
      : chain(start, fat, own, `stream ${entry.name}`);
    if (ids.length * (mini ? MINI_SECTOR : sector) < entry.size)
      refuse(`stream ${entry.name} is shorter than it declares`);
    chains.set(entry, ids);
  }

  const miniBytes = (id: number) => {
    const at = id * MINI_SECTOR;
    const host = miniStream[Math.floor(at / sector)] as number;
    const from = (host + 1) * sector + (at % sector);
    return bytes.subarray(from, Math.min(from + MINI_SECTOR, bytes.byteLength));
  };
  return {
    root: rootEntry,
    entries: entries.filter((entry) => reached[entry.id]),
    read(entry) {
      const out = new Uint8Array(entry.size);
      let at = 0;
      for (const id of chains.get(entry) ?? []) {
        const part = entry.size < MINI_STREAM_CUTOFF ? miniBytes(id) : sectorBytes(id);
        const take = Math.min(part.byteLength, entry.size - at);
        out.set(part.subarray(0, take), at);
        at += take;
        if (at === entry.size) break;
      }
      if (at < entry.size) refuse(`stream ${entry.name} is cut off`);
      return out;
    },
  };
}

// The child named `name` of `storage`, or null.
export const child = (storage: CfbEntry, name: string) =>
  storage.children.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) ?? null;

// A copy of the file in which `entries` are renamed out of msgreader's view ("__substg1.0_" becomes "__hidden1.0_",
// which it skips), so it never decodes them; the caller reads them itself.
export function hide(bytes: Uint8Array, entries: CfbEntry[]): Uint8Array {
  const copy = bytes.slice();
  // UTF-16LE, as directory names are stored.
  const hidden = Uint8Array.from([..."__hidden1.0_"].flatMap((c) => [c.charCodeAt(0), 0]));
  for (const entry of entries) copy.set(hidden, entry.offset);
  return copy;
}
