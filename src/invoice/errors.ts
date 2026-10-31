// The supplier ledger's refusals (D06 T01 §2), each its own type so a caller never mistakes one for a mismatch. No
// message names an account number or a key.
export class SupplierRefused extends Error {
  override name = "SupplierRefused";
}
// More than one supplier fits what an invoice names (a shared domain such as gmail.com without a telling name, or a
// domain and a name that point at different suppliers): the ledger will not guess which baseline to compare with.
export class SupplierAmbiguous extends Error {
  override name = "SupplierAmbiguous";
}
