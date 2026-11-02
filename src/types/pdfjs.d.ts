// The PDF library's bundles, read as text under the Text rule in wrangler.jsonc and injected into the Browser Run
// page (D03 T02 §2): the module's value is the file's text, never executed by the Worker.
declare module "pdfjs-dist/build/pdf.min.mjs" {
  const text: string;
  export default text;
}
declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  const text: string;
  export default text;
}

// The JPEG2000 and JBIG2/CCITT decoder binaries, read as data under the Data rule in wrangler.jsonc and handed
// to the Browser Run page (D03 T02 §2): the Worker's only copy is these bytes, passed base64 for the transfer.
declare module "pdfjs-dist/wasm/openjpeg.wasm" {
  const bytes: ArrayBuffer;
  export default bytes;
}
declare module "pdfjs-dist/wasm/jbig2.wasm" {
  const bytes: ArrayBuffer;
  export default bytes;
}
