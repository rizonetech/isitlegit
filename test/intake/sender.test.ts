import { describe, expect, it } from "vitest";
import { EMAIL_ROUTING_AUTHSERV_ID, parseAuthenticationResults, senderAuthenticated } from "../../src/intake/sender";

// D01 T01 §3: the gate admits an envelope sender only on Email Routing's own pass for that sender's domain.
const ID = EMAIL_ROUTING_AUTHSERV_ID;
const mail = (...headers: string[]) =>
  new TextEncoder().encode(`${headers.join("\r\n")}\r\nFrom: boss@member.co.za\r\nSubject: Fwd\r\n\r\nbody\r\n`);

describe("senderAuthenticated", () => {
  it("admits an SPF pass for the envelope sender's own domain, as an address or a domain", () => {
    expect(
      senderAuthenticated(
        mail(`Authentication-Results: ${ID}; spf=pass smtp.mailfrom=boss@member.co.za`),
        "boss@member.co.za",
      ),
    ).toBe(true);
    expect(
      senderAuthenticated(
        mail(`Authentication-Results: ${ID}; spf=pass smtp.mailfrom=member.co.za`),
        "Boss@Member.co.za",
      ),
    ).toBe(true);
  });

  it("admits a DKIM pass signed by the sender's registrable domain, from header.d or header.i", () => {
    expect(
      senderAuthenticated(
        mail(
          `Authentication-Results: ${ID}; spf=softfail smtp.mailfrom=member.co.za; dkim=pass header.d=mail.member.co.za header.s=s1`,
        ),
        "boss@member.co.za",
      ),
    ).toBe(true);
    expect(
      senderAuthenticated(
        mail(`Authentication-Results: ${ID}; dkim=pass header.i=@member.co.za`),
        "boss@sales.member.co.za",
      ),
    ).toBe(true);
  });

  it("reads a folded header with comments, quoted values and a method version", () => {
    const folded = `Authentication-Results: ${ID} 1;\r\n\tdkim=fail (bad sig) header.d=evil.com;\r\n spf/1=pass (${ID}: domain of boss@member.co.za designates 192.0.2.1 as permitted sender) smtp.mailfrom="boss@member.co.za"`;
    expect(senderAuthenticated(mail(folded), "boss@member.co.za")).toBe(true);
  });

  it("refuses a pass for another domain, a pass in a comment, and look-alike domains", () => {
    for (const header of [
      `Authentication-Results: ${ID}; spf=fail smtp.mailfrom=boss@member.co.za; dkim=pass header.d=evil.com`,
      `Authentication-Results: ${ID}; spf=pass smtp.mailfrom=bounce@evil.com`,
      `Authentication-Results: ${ID}; dkim=pass header.d=member.co.za.evil.com`,
      `Authentication-Results: ${ID}; dkim=pass header.d=evilmember.co.za`,
      `Authentication-Results: ${ID}; spf=neutral (spf=pass smtp.mailfrom=boss@member.co.za) smtp.mailfrom=boss@member.co.za`,
      `Authentication-Results: ${ID}; dmarc=pass header.from=member.co.za`,
      `Authentication-Results: ${ID}; dkim=pass header.d=co.za`,
    ])
      expect(senderAuthenticated(mail(header), "boss@member.co.za"), header).toBe(false);
  });

  it("trusts only the topmost header, and only when Email Routing wrote it", () => {
    // A pass the sender wrote lower down, under Email Routing's fail.
    expect(
      senderAuthenticated(
        mail(
          `Authentication-Results: ${ID}; spf=fail smtp.mailfrom=boss@member.co.za`,
          "Received: from relay",
          `Authentication-Results: ${ID}; spf=pass smtp.mailfrom=boss@member.co.za`,
        ),
        "boss@member.co.za",
      ),
    ).toBe(false);
    // A topmost header from another server: Email Routing added none, so the message's own proves nothing.
    expect(
      senderAuthenticated(
        mail("Authentication-Results: mx.evil.com; spf=pass smtp.mailfrom=boss@member.co.za"),
        "boss@member.co.za",
      ),
    ).toBe(false);
    // None at all, or one only in the body.
    expect(
      senderAuthenticated(
        new TextEncoder().encode(
          `From: boss@member.co.za\r\n\r\nAuthentication-Results: ${ID}; spf=pass smtp.mailfrom=boss@member.co.za\r\n`,
        ),
        "boss@member.co.za",
      ),
    ).toBe(false);
  });

  it("refuses an envelope sender that is not an address", () => {
    const header = `Authentication-Results: ${ID}; spf=pass smtp.mailfrom=member.co.za`;
    for (const from of ["member.co.za", "@member.co.za", "boss@", "a@b@member.co.za", ""])
      expect(senderAuthenticated(mail(header), from), from).toBe(false);
  });

  it("parses each result's method, result and properties", () => {
    expect(
      parseAuthenticationResults(`${ID}; dkim=pass header.d=a.com header.s=x; spf=none smtp.mailfrom=b.com`),
    ).toEqual({
      authservId: ID,
      results: [
        {
          method: "dkim",
          result: "pass",
          props: new Map([
            ["header.d", "a.com"],
            ["header.s", "x"],
          ]),
        },
        { method: "spf", result: "none", props: new Map([["smtp.mailfrom", "b.com"]]) },
      ],
    });
  });
});
