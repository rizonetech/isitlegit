// One domain claim as its page draws it (D07 T02 §15), read by src/auth/domains.ts `domainClaimView`; kept apart, with
// no database in it, so the page and its browser tests read the shape without the Worker's types.
import type { Checker } from "../db/checker";

export type DomainClaimView = {
  domain: string;
  state: "pending" | "verified";
  method: "dns" | "email" | null;
  verifiedAt: string | null;
  // Who verified it (D07 T02 §24), by the report header's rule: a current member named, a member since gone, or nothing
  // recorded (pending, or verified before the column).
  verifiedBy: Checker;
  txt: { name: string; value: string };
  // `expired`: a code was sent and has run out (send a new one); `attempts`: wrong codes so far against the live one.
  code: {
    expiresAt: string | null;
    expired: boolean;
    attempts: number;
    lockedUntil: string | null;
    nextCodeAt: string | null;
  };
  lastCheck: { at: string; outcome: string } | null;
};
