// One domain claim as its page draws it (D07 T02 §15), read by src/auth/domains.ts `domainClaimView`; kept apart, with
// no database in it, so the page and its browser tests read the shape without the Worker's types.
export type DomainClaimView = {
  domain: string;
  state: "pending" | "verified";
  method: "dns" | "email" | null;
  verifiedAt: string | null;
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

// One single-address claim as its page draws it (D07 T04 §27), read by src/auth/domains.ts `addressClaimView`: the
// state, when it was verified, and the code's own challenge (the same shape the domain claim's code has).
export type AddressClaimView = {
  address: string;
  state: "pending" | "verified";
  verifiedAt: string | null;
  code: DomainClaimView["code"];
};
