import { describe, expect, it } from "vitest";
import { readCompoundFile } from "../../src/intake/cfb";

// D01 T01 §6 final review: the checker's per-storage name check costs one comparison an entry, so a storage holding
// thousands of entries (a few MiB of directory) is read in moments, not hundreds of millions of comparisons. A real
// clock, so in Node.

const END_OF_CHAIN = 0xfffffffe;
const NO_STREAM = 0xffffffff;

// A version 3 compound file ([MS-CFB] 2.2 to 2.6) whose root holds `count` empty streams, each the right sibling of
// the one before, written directly: the cfb package takes minutes to write this many.
function manyEntries(count: number): Uint8Array {
  const dirSectors = Math.ceil((count + 1) / 4);
  let fatSectors = 1;
  while (fatSectors * 128 < dirSectors + fatSectors) fatSectors++;
  const bytes = new Uint8Array(512 * (1 + fatSectors + dirSectors));
  const view = new DataView(bytes.buffer);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x3e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, fatSectors, true);
  view.setUint32(48, fatSectors, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, END_OF_CHAIN, true);
  view.setUint32(68, END_OF_CHAIN, true);
  for (let i = 0; i < 109; i++) view.setUint32(76 + 4 * i, i < fatSectors ? i : 0xffffffff, true);
  // The FAT: its own sectors, then the directory's chain.
  const fat = (id: number, next: number) => view.setUint32(512 + 4 * id, next, true);
  for (let id = 0; id < fatSectors * 128; id++) fat(id, 0xffffffff);
  for (let id = 0; id < fatSectors; id++) fat(id, 0xfffffffd);
  for (let i = 0; i < dirSectors; i++) fat(fatSectors + i, i + 1 < dirSectors ? fatSectors + i + 1 : END_OF_CHAIN);
  const entry = (index: number, name: string, type: number, right: number, child: number) => {
    const at = 512 * (1 + fatSectors) + 128 * index;
    for (let k = 0; k < name.length; k++) view.setUint16(at + 2 * k, name.charCodeAt(k), true);
    view.setUint16(at + 64, 2 * name.length + 2, true);
    bytes[at + 66] = type;
    view.setUint32(at + 68, NO_STREAM, true);
    view.setUint32(at + 72, right, true);
    view.setUint32(at + 76, child, true);
    view.setUint32(at + 116, END_OF_CHAIN, true);
  };
  entry(0, "Root Entry", 5, NO_STREAM, 1);
  for (let i = 1; i <= count; i++) entry(i, `s${i}`, 2, i < count ? i + 1 : NO_STREAM, NO_STREAM);
  return bytes;
}

describe("readCompoundFile on a storage of 20,000 entries", () => {
  it("checks every name in well under a second", () => {
    const bytes = manyEntries(20_000);
    const started = performance.now();
    const file = readCompoundFile(bytes);
    expect(file.root.children.length).toBe(20_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
