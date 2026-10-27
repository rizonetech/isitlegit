// A WebAssembly file imported with `?module` is compiled when the Worker is deployed and arrives as a module
// (Wrangler's module rules; the test plugin does the same).
declare module "*.wasm?module" {
  const module: WebAssembly.Module;
  export default module;
}
