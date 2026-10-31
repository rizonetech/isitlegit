// Every address the marketing site links to (D07 T06 §2), in one place so the header, footer and pages never drift.
// Site routes follow design/SPEC.md 0.1, each with the section that builds it; Results is served by the app host
// (coordinator, 2026-10-31), and the site's /eval redirects there (site/public/_redirects).
export const APP = "https://app.isitlegit.co.za";

export const app = {
  signup: `${APP}/signup`,
  signin: `${APP}/signin`,
  upload: `${APP}/upload`,
  results: `${APP}/eval`,
} as const;

export const site = {
  home: "/", // S1, D07 T06 §2
  howItWorks: "/how-it-works", // S2, D07 T06 §3
  invoiceFraud: "/invoice-fraud", // S3, D07 T06 §3
  protect: "/protect", // S4, D07 T06 §7
  pricing: "/pricing", // S5, D07 T06 §4
  privacy: "/privacy", // S6, D07 T06 §5
  terms: "/terms", // S7, D07 T06 §8
  security: "/security", // S8, D07 T06 §8
  about: "/about", // S9, D07 T06 §8
} as const;

// The demo business's public verify page (T1, D05 T02 §6), served by the Worker on this host once D07 T07 §1 has seeded
// Fynbos Freight as a protected identity; §6 reads this exact link back over HTTPS before deploy.
export const demoVerify = "/v/fynbos-freight";

export const CHECK_ADDRESS = "check@isitlegit.co.za";
// The operator's contact address (Email Routing to the operator's mailbox; docs/live-checks.md), and the invite request.
export const HELLO_ADDRESS = "hello@isitlegit.co.za";
export const inviteRequest = `mailto:${HELLO_ADDRESS}?subject=${encodeURIComponent("Invite code for IsItLegit")}`;
export const trialRequest = `mailto:${HELLO_ADDRESS}?subject=${encodeURIComponent("Longer trial for IsItLegit")}`;
export const contact = `mailto:${HELLO_ADDRESS}`;

// The header's and footer's product links, in the boards' order (design/SPEC.md P3, P4).
export const productLinks = [
  { label: "How it works", href: site.howItWorks },
  { label: "Invoice fraud", href: site.invoiceFraud },
  { label: "Protect your business", href: site.protect },
  { label: "Pricing", href: site.pricing },
  { label: "Results", href: app.results },
] as const;

export const companyLinks = [
  { label: "About and contact", href: site.about },
  { label: "Security", href: site.security },
  { label: "Privacy and POPIA", href: site.privacy },
  { label: "Terms", href: site.terms },
] as const;

// Every address above, for the tests that check no page links anywhere else.
export const allAddresses: readonly string[] = [...Object.values(app), ...Object.values(site), demoVerify, inviteRequest, trialRequest, contact];
