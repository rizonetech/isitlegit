// Writes the Opus decoder's WebAssembly as a file the Worker imports (D01 T03 §2). `opus-decoder` embeds its WASM as
// compressed text and compiles it at runtime, which a Cloudflare Worker refuses ("Wasm code generation disallowed by
// embedder"); a `.wasm` file the Worker imports is compiled at deploy instead and handed to the decoder through
// `OpusDecoder.module`. This runs the installed decoder once in Node and keeps the module it compiles, so the file is
// always the installed version's; `test/node/opus-wasm.test.ts` fails when the committed file differs.
//
//   node scripts/build-opus-wasm.ts [--out src/voice/opus-decoder.wasm]
import { renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

export async function extractOpusWasm(): Promise<Uint8Array> {
  const compiled: Uint8Array[] = [];
  const compile = WebAssembly.compile;
  WebAssembly.compile = (bytes: BufferSource) => {
    compiled.push(
      new Uint8Array(
        ArrayBuffer.isView(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes,
      ),
    );
    return compile(bytes);
  };
  try {
    const { OpusDecoder } = await import("opus-decoder");
    const decoder = new OpusDecoder();
    await decoder.ready;
    decoder.free();
  } finally {
    WebAssembly.compile = compile;
  }
  // The decoder compiles a small inflater first, then itself: the last module is the decoder's.
  const module = compiled.at(-1);
  if (!module) throw new Error("build-opus-wasm: the decoder compiled no WebAssembly");
  return module;
}

if (import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({ options: { out: { type: "string", default: "src/voice/opus-decoder.wasm" } } });
  const out = values.out as string;
  const bytes = await extractOpusWasm();
  writeFileSync(`${out}.tmp`, bytes);
  renameSync(`${out}.tmp`, out);
  console.log(`build-opus-wasm: wrote ${out} (${bytes.length} bytes)`);
}
