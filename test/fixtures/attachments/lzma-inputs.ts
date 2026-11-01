// The bytes D02 T04 §7's LZMA fixtures compress (scripts/fixtures/make-7z-lzma.ts), made the same way in Node and in
// workerd, so a test compares what it decoded with what was compressed without storing both.
export const lzmaInputs = (): Record<string, Uint8Array> => {
  const random = new Uint8Array(4096);
  let x = 7;
  for (let i = 0; i < random.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    random[i] = x >>> 24;
  }
  const matches = new Uint8Array(200_000);
  for (let i = 0; i < matches.length; i++) matches[i] = i % 97 < 40 ? (i * 31) & 0xff : i % 7;
  // Exactly the decoder's 1 MiB bound, compressible so its stream stays small.
  const bound = new Uint8Array(1024 * 1024);
  for (let i = 0; i < bound.length; i++) bound[i] = (i >> 10) & 0xff;
  return {
    text: new TextEncoder().encode("Please pay the new account today, the managing director said. ".repeat(40)),
    random,
    matches,
    single: new Uint8Array([42]),
    bound,
  };
};
