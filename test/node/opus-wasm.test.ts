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

  it("commits minimp3-wasm's WebAssembly unchanged (D01 T03 §7)", () => {
    const committed = readFileSync(join(ROOT, "src/voice/minimp3.wasm"));
    // Copy node_modules/minimp3-wasm/dist/decoder.opt.wasm again after upgrading minimp3-wasm.
    expect(committed.equals(readFileSync(join(ROOT, "node_modules/minimp3-wasm/dist/decoder.opt.wasm")))).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(committed))).toEqual([]);
  });

  it("aliases the decoder's Web Worker import to the same stub in both configs", () => {
    const text = readFileSync(join(ROOT, "wrangler.jsonc"), "utf-8");
    // The file's comments are whole lines, and its objects may end with a trailing comma.
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
    expect(config.alias).toEqual(VOICE_ALIASES);
  });
});
