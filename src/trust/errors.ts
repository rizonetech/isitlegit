// The trust network's refusal (D05 T01): a request a business made that cannot be done as asked, with the reason in
// words the console shows. Its own module so code without Worker bindings (the SVG sanitiser) can throw it.
export class IdentityRefused extends Error {
  override name = "IdentityRefused";
}
