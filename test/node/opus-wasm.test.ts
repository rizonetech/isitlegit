import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractOpusWasm } from "../../scripts/build-opus-wasm.ts";
import { VOICE_ALIASES } from "../../vitest.config.ts";

// D01 T03 §2: the Opus decoder's WebAssembly the Worker imports is the installed package's own, and the Web Worker
// stub is named the same way where the Worker is bundled (wrangler.jsonc) and where it is tested (vitest.config.ts).
const ROOT = join(import.meta.dirname, "../..");

describe("the voice decoder's build inputs", () => {
  it("commits the WebAssembly the installed opus-decoder compiles", async () => {
    const committed = new Uint8Array(readFileSync(join(ROOT, "src/voice/opus-decoder.wasm")));
    // Regenerate with `node scripts/build-opus-wasm.ts` after upgrading opus-decoder.
    expect(Buffer.from(committed).equals(Buffer.from(await extractOpusWasm()))).toBe(true);
    expect(WebAssembly.validate(committed)).toBe(true);
  });

  it("commits an MP3 decoder with no imports and the binding's exports (D01 T03 §7)", () => {
    // That it is native/minimp3 built with the pinned Zig is CI's check (scripts/build-minimp3-wasm.py --check).
    const module = new WebAssembly.Module(readFileSync(join(ROOT, "src/voice/minimp3.wasm")));
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(WebAssembly.Module.exports(module).map((e) => e.name)).toEqual([
      "memory",
      "input_offset",
      "set_input_size",
      "decode_frame",
      "frame_bytes",
      "frame_channels",
      "frame_rate",
      "pcm_offset",
    ]);
  });

  it("aliases the decoder's Web Worker import to the same stub in both configs", () => {
    const text = readFileSync(join(ROOT, "wrangler.jsonc"), "utf-8");
    // The file's comments are whole lines, and its objects may end with a trailing comma.
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
    expect(config.alias).toEqual(VOICE_ALIASES);
  });
});
