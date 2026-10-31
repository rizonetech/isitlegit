// The trust network's refusal (D05 T01): a request a business made that cannot be done as asked, with the reason in
// words the console shows. Its own module so code without Worker bindings (the SVG sanitiser) can throw it.
export class IdentityRefused extends Error {
  override name = "IdentityRefused";
}

// The bank registry's refusals (D05 T01 §2), each its own type so a caller never mistakes one for a mismatch.
// No message names a number or a key.
export class BankKeysMissing extends Error {
  override name = "BankKeysMissing";
}
export class AccountRefused extends Error {
  override name = "AccountRefused";
}
// The business has no registered account, so there is nothing to compare with: not a mismatch.
export class NoBaseline extends Error {
  override name = "NoBaseline";
}
// A registered account is under another key than the Worker holds: re-key before adding or matching.
export class KeyMismatch extends Error {
  override name = "KeyMismatch";
}
export class MatchLimited extends Error {
  override name = "MatchLimited";
}
