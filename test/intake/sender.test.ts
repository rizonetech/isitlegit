import { describe, expect, it } from "vitest";
import { EMAIL_ROUTING_AUTHSERV_ID, parseAuthenticationResults, senderAuthenticated } from "../../src/intake/sender";

// D01 T01 §3: the gate admits an envelope sender only on Email Routing's own pass for that sender's domain.
const ID = EMAIL_ROUTING_AUTHSERV_ID;
const mail = (...headers: string[]) =>
  new TextEncoder().encode(`${headers.join("\r\n")}\r\nFrom: boss@member.co.za\r\nSubject: Fwd\r\n\r\nbody\r\n`);

describe("senderAuthenticated", () => {
  it("admits an SPF pass for the envelope sender's own domain, as an address or a domain", async () => {
    expect(
      await senderAuthenticated(
        mail(`Authentication-Results: ${ID}; spf=pass smtp.mailfrom=boss@member.co.za`),
        "boss@member.co.za",
      ),
    ).toBe(true);
    expect(
      await senderAuthenticated(
        mail(`Authentication-Results: ${ID}; spf=pass smtp.mailfrom=member.co.za`),
        "Boss@Member.co.za",
      ),
    ).toBe(true);
  });

  it("admits a DKIM pass whose reported signer (header.d) has the sender's registrable domain, not header.i alone", async () => {
    expect(
      await senderAuthenticated(
        mail(
          `Authentication-Results: ${ID}; spf=softfail smtp.mailfrom=member.co.za; dkim=pass header.d=mail.member.co.za header.s=s1`,
        ),
        "boss@member.co.za",
      ),
    ).toBe(true);
    expect(
      await senderAuthenticated(
        mail(`Authentication-Results: ${ID}; dkim=pass header.d=member.co.za header.i=@sales.member.co.za`),
        "boss@sales.member.co.za",
      ),
    ).toBe(true);
    // header.i is the identity, not necessarily the signer (final review): without header.d nothing is proven.
    expect(
      await senderAuthenticated(
        mail(`Authentication-Results: ${ID}; dkim=pass header.i=@member.co.za`),
        "boss@sales.member.co.za",
      ),
    ).toBe(false);
  });

  it("reads a folded header with comments, quoted values and a method version", async () => {
    const folded = `Authentication-Results: ${ID} 1;\r\n\tdkim=fail (bad sig) header.d=evil.com;\r\n spf/1=pass (${ID}: domain of boss@member.co.za designates 192.0.2.1 as permitted sender) smtp.mailfrom="boss@member.co.za"`;
    expect(await senderAuthenticated(mail(folded), "boss@member.co.za")).toBe(true);
  });

  it("refuses a pass for another domain, a pass in a comment, and look-alike domains", async () => {
    for (const header of [
      `Authentication-Results: ${ID}; spf=fail smtp.mailfrom=boss@member.co.za; dkim=pass header.d=evil.com`,
      `Authentication-Results: ${ID}; spf=pass smtp.mailfrom=bounce@evil.com`,
      `Authentication-Results: ${ID}; dkim=pass header.d=member.co.za.evil.com`,
      `Authentication-Results: ${ID}; dkim=pass header.d=evilmember.co.za`,
      `Authentication-Results: ${ID}; spf=neutral (spf=pass smtp.mailfrom=boss@member.co.za) smtp.mailfrom=boss@member.co.za`,
      `Authentication-Results: ${ID}; dmarc=pass header.from=member.co.za`,
      `Authentication-Results: ${ID}; dkim=pass header.d=co.za`,
    ])
      expect(await senderAuthenticated(mail(header), "boss@member.co.za"), header).toBe(false);
  });

  it("trusts only the topmost header, and only when Email Routing wrote it", async () => {
    // A pass the sender wrote lower down, under Email Routing's fail.
    expect(
      await senderAuthenticated(
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
      await senderAuthenticated(
        mail("Authentication-Results: mx.evil.com; spf=pass smtp.mailfrom=boss@member.co.za"),
        "boss@member.co.za",
      ),
    ).toBe(false);
    // None at all, or one only in the body.
    expect(
      await senderAuthenticated(
        new TextEncoder().encode(
          `From: boss@member.co.za\r\n\r\nAuthentication-Results: ${ID}; spf=pass smtp.mailfrom=boss@member.co.za\r\n`,
        ),
        "boss@member.co.za",
      ),
    ).toBe(false);
  });

  it("refuses an envelope sender that is not an address", async () => {
    const header = `Authentication-Results: ${ID}; spf=pass smtp.mailfrom=member.co.za`;
    for (const from of ["member.co.za", "@member.co.za", "boss@", "a@b@member.co.za", ""])
      expect(await senderAuthenticated(mail(header), from), from).toBe(false);
  });

  it("parses each result's method, result and properties", async () => {
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

  it("for an address verified on its own, admits only mail whose signed From is that mailbox (round 1)", async () => {
    const signed = (
      from: string,
      auth = `${ID}; dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=registered.user@gmail.com`,
    ) => new TextEncoder().encode(`Authentication-Results: ${auth}\r\nFrom: ${from}\r\nSubject: Fwd\r\n\r\nbody\r\n`);
    const victim = "registered.user@gmail.com";
    expect(await senderAuthenticated(signed(victim), victim, "address")).toBe(true);
    expect(await senderAuthenticated(signed(`"Registered User" <Registered.User@Gmail.com>`), victim, "address")).toBe(
      true,
    );
    // Another gmail.com user's signed mail with the envelope forged to the registered address.
    expect(await senderAuthenticated(signed("attacker@gmail.com"), victim, "address")).toBe(false);
    expect(await senderAuthenticated(signed(`"${victim}" <attacker@gmail.com>`), victim, "address")).toBe(false);
    // The same mail passes the domain-level check, which is why the level matters.
    expect(await senderAuthenticated(signed("attacker@gmail.com"), victim, "domain")).toBe(true);
    // SPF proves no mailbox, and a From naming several addresses names none.
    expect(
      await senderAuthenticated(signed(victim, `${ID}; spf=pass smtp.mailfrom=${victim}`), victim, "address"),
    ).toBe(false);
    expect(await senderAuthenticated(signed(`${victim}, attacker@gmail.com`), victim, "address")).toBe(false);
    expect(await senderAuthenticated(signed(`<${victim}>, <attacker@gmail.com>`), victim, "address")).toBe(false);
    // A DKIM pass by another domain does not prove a gmail.com mailbox.
    expect(await senderAuthenticated(signed(victim, `${ID}; dkim=pass header.d=evil.com`), victim, "address")).toBe(
      false,
    );
  });

  it("reads whitespace RFC 8601 allows around the separators (round 1)", async () => {
    expect(
      await senderAuthenticated(
        mail(`Authentication-Results: ${ID}; spf = pass smtp . mailfrom = member.co.za`),
        "boss@member.co.za",
      ),
    ).toBe(true);
    expect(
      await senderAuthenticated(
        mail(`Authentication-Results: ${ID}; dkim / 1 = pass header.d = "member.co.za"`),
        "boss@member.co.za",
      ),
    ).toBe(true);
    expect(
      parseAuthenticationResults(`${ID}; spf = pass (a = b) smtp.mailfrom = "x y@member.co.za"`)?.results[0]?.props.get(
        "smtp.mailfrom",
      ),
    ).toBe("x y@member.co.za");
  });

  it("for an address verified on its own, takes a signature only by exactly its domain, not a sibling under a shared host (round 2)", async () => {
    const owner = "owner@legitcustomer.duckdns.org";
    const signed = (d: string) =>
      new TextEncoder().encode(
        `Authentication-Results: ${ID}; dkim=pass header.d=${d}\r\nFrom: ${owner}\r\n\r\nbody\r\n`,
      );
    expect(await senderAuthenticated(signed("legitcustomer.duckdns.org"), owner, "address")).toBe(true);
    expect(await senderAuthenticated(signed("unrelatedsender.duckdns.org"), owner, "address")).toBe(false);
    expect(await senderAuthenticated(signed("duckdns.org"), owner, "address")).toBe(false);
    expect(await senderAuthenticated(signed("mail.legitcustomer.duckdns.org"), owner, "address")).toBe(false);
  });

  it("for an address verified on its own, takes exactly one From field naming exactly one mailbox (round 3)", async () => {
    const registered = "registered@shared.example";
    const auth = `Authentication-Results: ${ID}; dkim=pass header.d=shared.example`;
    const with_ = (...headers: string[]) =>
      new TextEncoder().encode(`${[auth, ...headers].join("\r\n")}\r\nSubject: Fwd\r\n\r\nbody\r\n`);
    expect(await senderAuthenticated(with_(`From: ${registered}`), registered, "address")).toBe(true);
    for (const headers of [
      // An unsigned From prepended above the signed one: DKIM verifies the bottom one.
      [`From: ${registered}`, "From: attacker@shared.example"],
      [`From: ${registered}`, "FROM : attacker@shared.example"],
      // A list, mixed forms, or a group names no single sender.
      [`From: <${registered}>, attacker@shared.example`],
      [`From: ${registered}, attacker@shared.example`],
      [`From: Team: ${registered};`],
      // No From, or one with no address in it.
      [],
      ["From: registered"],
    ])
      expect(await senderAuthenticated(with_(...headers), registered, "address"), headers.join(" | ")).toBe(false);
  });

  it("refuses a message whose header block never ends within the limit", async () => {
    const endless = new TextEncoder().encode(
      `Authentication-Results: ${ID}; spf=pass smtp.mailfrom=member.co.za\r\n${"X-Pad: y\r\n".repeat(30_000)}`,
    );
    expect(await senderAuthenticated(endless, "boss@member.co.za")).toBe(false);
  });

  it("refuses, rather than throws on, a header block the parser will not read (final review)", async () => {
    // postal-mime counts each line as at least 64 bytes against 2 MiB: 32,769 tiny lines pass our 256 KiB limit.
    const tiny = new TextEncoder().encode(
      `Authentication-Results: ${ID}; spf=pass smtp.mailfrom=member.co.za\r\n${"A:\r\n".repeat(32_769)}\r\nbody\r\n`,
    );
    expect(tiny.byteLength).toBeLessThan(256 * 1024);
    await expect(senderAuthenticated(tiny, "boss@member.co.za")).resolves.toBe(false);
  });
});

// The topmost Authentication-Results header Email Routing wrote on a live forward to check@ (D01 T01 §9, case
// 01M62P0FCKTGQ4A6YY7XNXE933, 2026-10-29), verbatim: a Microsoft 365 mailbox forwarding an inline copy.
const LIVE =
  'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=rizonetech.com header.s=selector2 header.b=M3ym6aCz; dmarc=pass header.from=rizonetech.com policy.dmarc=none; spf=pass (mx.cloudflare.net: domain of postmaster@AS8PR04CU009.outbound.protection.outlook.com designates 2a01:111:f403:c201::3 as permitted sender) smtp.helo=AS8PR04CU009.outbound.protection.outlook.com; spf=pass (mx.cloudflare.net: domain of derick@rizonetech.com designates 2a01:111:f403:c201::3 as permitted sender) smtp.mailfrom=derick@rizonetech.com; arc=pass smtp.remote-ip="2a01:111:f403:c201::3"';

describe("the header Email Routing really writes", () => {
  it("is parsed, and admits its sender as a verified address and as a verified domain", async () => {
    const parsed = parseAuthenticationResults(LIVE.slice("Authentication-Results: ".length));
    expect(parsed?.authservId).toBe(ID);
    expect(parsed?.results.map((r) => `${r.method}=${r.result}`)).toEqual([
      "dkim=pass",
      "dmarc=pass",
      "spf=pass",
      "spf=pass",
      "arc=pass",
    ]);
    const live = new TextEncoder().encode(
      `${LIVE}\r\nFrom: Derick Payne <derick@rizonetech.com>\r\nSubject: FW: x\r\n\r\nbody\r\n`,
    );
    expect(await senderAuthenticated(live, "derick@rizonetech.com", "address")).toBe(true);
    expect(await senderAuthenticated(live, "derick@rizonetech.com", "domain")).toBe(true);
    // Another sender at the same domain is not that address.
    expect(await senderAuthenticated(live, "someone@rizonetech.com", "address")).toBe(false);
  });
});
