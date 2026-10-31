import { describe, expect, it } from "vitest";
import { decodeLzma, LzmaError, lzmaProperties } from "../../src/checks/lzma";
import { LZMA_PROPS, lzmaStreams } from "../fixtures/attachments/lzma";
import { lzmaInputs } from "../fixtures/attachments/lzma-inputs";

// D02 T04 §7: the reference LZMA decoder against streams XZ Utils wrote (scripts/fixtures/make-7z-lzma.ts).
const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const MIB = 1024 * 1024;
const inputs = lzmaInputs();
const stream = (name: string) => bytes(lzmaStreams[name] as string);

describe("decodeLzma", () => {
  it("decodes each stream XZ Utils wrote byte for byte, the 1 MiB bound exactly included", () => {
    for (const name of ["text", "random", "matches", "single", "bound"]) {
      const want = inputs[name] as Uint8Array;
      const got = decodeLzma(stream(name), LZMA_PROPS, want.length, MIB);
      expect(got.length, name).toBe(want.length);
      expect(
        got.every((v, i) => v === want[i]),
        name,
      ).toBe(true);
    }
  });

  it("refuses a size past the bound, a properties byte out of range or past lc + lp 4, and a stream cut short", () => {
    const text = inputs.text as Uint8Array;
    expect(() => decodeLzma(stream("bound"), LZMA_PROPS, MIB + 1, MIB)).toThrow(LzmaError);
    expect(() => lzmaProperties(225)).toThrow(LzmaError);
    // lc 4, lp 1: five literal bits, past what the SDK's own decoder takes.
    expect(() => lzmaProperties(4 + 1 * 9)).toThrow(LzmaError);
    const whole = stream("text");
    expect(() => decodeLzma(whole.subarray(0, whole.length >> 1), LZMA_PROPS, text.length, MIB)).toThrow(LzmaError);
    // Asked for more than the stream holds: its end marker comes first.
    expect(() => decodeLzma(whole, LZMA_PROPS, text.length + 100, MIB)).toThrow(LzmaError);
    expect(() => decodeLzma(new Uint8Array([1, 0, 0, 0, 0]), LZMA_PROPS, 10, MIB)).toThrow(LzmaError);
  });

  it("answers a damaged stream with LzmaError or wrong bytes, never a short result or a hang", () => {
    const want = inputs.matches as Uint8Array;
    const whole = stream("matches");
    let refused = 0;
    for (let seed = 0; seed < 40; seed++) {
      const damaged = whole.slice();
      const at = 5 + ((seed * 7919) % (damaged.length - 5));
      damaged[at] = (damaged[at] as number) ^ (1 << (seed % 8));
      try {
        expect(decodeLzma(damaged, LZMA_PROPS, want.length, MIB).length).toBe(want.length);
      } catch (error) {
        expect(error).toBeInstanceOf(LzmaError);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
  });
});
