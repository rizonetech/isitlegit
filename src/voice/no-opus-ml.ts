// WORKAROUND: `ogg-opus-decoder` 1.7.5 imports its speech-enhancement decoder (`@wasm-audio-decoders/opus-ml`, 2.7 MB
// of embedded WebAssembly) dynamically, only when constructed with `speechQualityEnhancement`, but a bundler includes
// it anyway, which would more than triple the Worker's size. `src/voice/decode.ts` never asks for it, so
// `wrangler.jsonc` and `vitest.config.ts` alias the package to these classes, which refuse to be built.
const refuse = () => {
  throw new Error("Opus speech enhancement is not bundled with the Worker");
};
export class OpusMLDecoder {
  constructor() {
    refuse();
  }
}
export class OpusMLDecoderWebWorker {
  constructor() {
    refuse();
  }
}
