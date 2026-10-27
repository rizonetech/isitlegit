// WORKAROUND: `@wasm-audio-decoders/common` 9.0.7, which `ogg-opus-decoder` imports, defines a decoder class on top of
// `@eshaz/web-worker` when its index is imported, and that package refers to a `Worker` global a Cloudflare Worker
// does not have, so the import alone throws. `wrangler.jsonc` and `vitest.config.ts` alias the package to this class,
// which nothing here constructs: decoding runs in the Worker's own thread (`src/voice/decode.ts`).
export default class NoWebWorker {
  constructor() {
    throw new Error("Web Workers are not available in a Cloudflare Worker; decode on the main thread");
  }
}
