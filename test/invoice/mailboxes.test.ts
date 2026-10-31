// Consumer mailbox domains (D06 T01 §4, correction 10): a supplier's domain that anyone can sign up to is no supplier
// domain, while a hosted service's own domain (e-signature, accounting mail, documents) is not a mailbox.
import { describe, expect, it } from "vitest";
import { isConsumerMailbox } from "../../src/invoice/mailboxes";

describe("isConsumerMailbox", () => {
  it("names the global and South African consumer mailbox providers, with any case or trailing dot", () => {
    for (const d of ["gmail.com", "GMail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com"])
      expect(isConsumerMailbox(d), d).toBe(true);
    for (const d of ["mweb.co.za", "telkomsa.net", "vodamail.co.za", "webmail.co.za", "gmail.com."])
      expect(isConsumerMailbox(d), d).toBe(true);
  });

  it("does not count a hosted service, a business domain or a subdomain lookalike as a mailbox", () => {
    for (const d of ["docusign.net", "docs.google.com", "post.xero.com", "fynbosfreight.co.za", "gmail.com.example"])
      expect(isConsumerMailbox(d), d).toBe(false);
  });

  it("reads a mailbox's own subdomains (a regional host) as the mailbox", () => {
    expect(isConsumerMailbox("mail.yahoo.com")).toBe(true);
  });
});
