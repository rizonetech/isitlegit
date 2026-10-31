// The protected live test accounts (AGENTS.md, "Protected live test accounts", operator, 2026-10-31): kept for every
// lane's live testing and never removed, reset, merged or bulk-cleaned by any path. Both accounts are protected in every
// organisation they belong to, with their data; Fynbos Freight is the demo company whose organisation is protected with
// them. One list, imported by every path that removes data (D07 T02 §21; D07 T04 §12's case removal; the sweeps; §9).
export const PROTECTED_ACCOUNTS: readonly string[] = ["demo@rizonetech.com", "derick@rizonetech.com"];
export const PROTECTED_ORGANISATIONS: readonly string[] = ["ZF5SufztotybeXIWVncExFAVu9GYZ8Fu"];
// The refusal's code, for the pages that draw it (the Team page, D07 T04 §3).
export const PROTECTED_ACCOUNT = "PROTECTED_ACCOUNT";

export const isProtectedAccount = (email: string | null | undefined) =>
  typeof email === "string" && PROTECTED_ACCOUNTS.includes(email.trim().toLowerCase());
export const isProtectedOrganisation = (orgId: string | null | undefined) =>
  typeof orgId === "string" && PROTECTED_ORGANISATIONS.includes(orgId);
