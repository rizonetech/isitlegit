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
