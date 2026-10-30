import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Receiver } from "../../src/auth/receivers";
import { authResultsEvidence, receivedBy, trustedAuthResults } from "../../src/checks/auth-results";
import type { CaseView } from "../../src/checks/case-view";
import { readEvidence, saveEvidence } from "../../src/checks/evidence";
import { checks } from "../../src/checks/index";
import { runChecks } from "../../src/checks/runner";
import { createCase } from "../../src/db/cases";
import { parseAuthenticationResults } from "../../src/intake/sender";

// D02 T02 §1: only the Authentication-Results headers the organisation's own receiving system wrote are trusted, found
// by the receiving boundary, never by a provider match alone.
const MICROSOFT: Receiver[] = [{ kind: "microsoft", pattern: "*.outlook.com" }];
const GOOGLE: Receiver[] = [{ kind: "google", pattern: "*.google.com" }];
const h = (name: string, value: string) => ({ name, value });
const results = (selection: ReturnType<typeof trustedAuthResults>) =>
  "trusted" in selection ? selection.trusted.results.map((r) => `${r.method}=${r.result}`) : selection.untrusted;

// Microsoft Learn, "Anti-spam message headers in cloud organizations": the header Microsoft 365 writes, no authserv-id.
const M365 =
  "spf=fail (sender IP is 192.168.50.50) smtp.mailfrom=contoso.com; dkim=pass (signature was verified) header.d=contoso.com; dmarc=fail action=quarantine header.from=contoso.com; compauth=fail reason=000";
// A sender's own header, claiming what Microsoft 365 would write for a pass.
const FORGED_M365 =
  "spf=pass (sender IP is 192.168.50.50) smtp.mailfrom=contoso.com; dkim=pass header.d=contoso.com; dmarc=pass action=none header.from=contoso.com; compauth=pass reason=100";

describe("parseAuthenticationResults", () => {
  it("reads the RFC 8601 appendix B forms", () => {
    expect(parseAuthenticationResults("example.org 1; none")).toEqual({ authservId: "example.org", results: [] });
    const spf = parseAuthenticationResults("example.com; spf=pass smtp.mailfrom=example.net");
    expect(spf?.authservId).toBe("example.com");
    expect(spf?.results.map((r) => [r.method, r.result, r.props.get("smtp.mailfrom")])).toEqual([
      ["spf", "pass", "example.net"],
    ]);
    const auth = parseAuthenticationResults(
      "example.com; auth=pass (cram-md5) smtp.auth=sender@example.net; spf=pass smtp.mailfrom=example.net",
    );
    expect(auth?.results.map((r) => r.method)).toEqual(["auth", "spf"]);
    expect(
      parseAuthenticationResults("example.com; iprev=pass policy.iprev=192.0.2.200")?.results[0]?.props.get(
        "policy.iprev",
      ),
    ).toBe("192.0.2.200");
    const dkim = parseAuthenticationResults(
      'example.com; dkim=pass reason="good signature" header.i=@mail-router.example.net; dkim=fail reason="bad signature" header.i=@newyork.example.com',
    );
    expect(dkim?.results.map((r) => [r.result, r.props.get("reason"), r.props.get("header.i")])).toEqual([
      ["pass", "good signature", "@mail-router.example.net"],
      ["fail", "bad signature", "@newyork.example.com"],
    ]);
  });

  it("decodes a quoted authserv-id and quoted-pairs without losing the results after them (completion review)", () => {
    expect(parseAuthenticationResults('"mx.google.com"; spf=pass smtp.mailfrom=a.example')?.authservId).toBe(
      "mx.google.com",
    );
    const escaped = parseAuthenticationResults(
      'example.com; dkim=fail reason="bad \\" signature" header.d=x.example; spf=pass smtp.mailfrom=y.example',
    );
    expect(escaped?.results.map((r) => [r.method, r.result, r.props.get("reason"), r.props.get("header.d")])).toEqual([
      ["dkim", "fail", 'bad " signature', "x.example"],
      ["spf", "pass", undefined, undefined],
    ]);
    expect(escaped?.results[1]?.props.get("smtp.mailfrom")).toBe("y.example");
  });

  it("reads a long folded header in linear time (completion review: 100 KB took 4.4 seconds)", () => {
    const folded = (n: number) =>
      `mx.google.com; ${Array.from({ length: n }, (_, i) => `x${i} = pass${" ".repeat(40)}`).join("; ")}; spf=pass`;
    const timed = (value: string) => {
      const start = performance.now();
      const parsed = parseAuthenticationResults(value);
      return { ms: performance.now() - start, last: parsed?.results.at(-1) };
    };
    const small = timed(folded(2_000));
    const large = timed(folded(8_000));
    expect(folded(2_000).length).toBeGreaterThan(100_000);
    expect(small.last).toMatchObject({ method: "spf", result: "pass" });
    expect(large.last).toMatchObject({ method: "spf", result: "pass" });
    expect(small.ms).toBeLessThan(100);
    // Four times the input in well under sixteen times the time: linear, not quadratic.
    expect(large.ms).toBeLessThan(Math.max(8 * small.ms, 200));
  });

  it("reads Microsoft 365's header, which has no authserv-id, as results only", () => {
    const parsed = parseAuthenticationResults(M365);
    expect(parsed?.authservId).toBeNull();
    expect(parsed?.results.map((r) => `${r.method}=${r.result}`)).toEqual([
      "spf=fail",
      "dkim=pass",
      "dmarc=fail",
      "compauth=fail",
    ]);
    expect(parsed?.results[3]?.props.get("reason")).toBe("000");
  });
});

describe("receivedBy", () => {
  it("names the receiving host, ignoring comments, or null", () => {
    expect(
      receivedBy("from mail.sender.example (mail.sender.example. [203.0.113.5]) by mx.google.com with ESMTPS id x"),
    ).toBe("mx.google.com");
    expect(receivedBy("by 2002:a05:6a10:1234::5 with SMTP id y; Thu, 30 Oct 2026 10:00:00 -0700")).toBe(
      "2002:a05:6a10:1234::5",
    );
    expect(receivedBy("from x (by nobody) with local")).toBeNull();
  });
});

// A message as Gmail delivers it: its own internal hop, then the border hop, its Authentication-Results below that.
const gmail = (real: string, ...rest: { name: string; value: string }[]) => [
  h("Received", "by 2002:a05:6a10:1234::5 with SMTP id y; Thu, 30 Oct 2026 10:00:01 -0700"),
  h("Received", "from mail.sender.example (mail.sender.example. [203.0.113.5]) by mx.google.com with ESMTPS id z"),
  h("Received-SPF", "fail (google.com: domain of x@sender.example does not designate 203.0.113.5)"),
  h("Authentication-Results", real),
  ...rest,
];
// The sender's own hop: everything below it came with the message.
const SENDER_HOP = h("Received", "from client by mail.sender.example with ESMTP id q");

describe("trustedAuthResults", () => {
  it("trusts Google's header and ignores a same-provider forgery below the boundary", () => {
    const headers = gmail(
      "mx.google.com; spf=fail smtp.mailfrom=sender.example; dkim=none",
      SENDER_HOP,
      h(
        "Authentication-Results",
        "mx.google.com; spf=pass smtp.mailfrom=sender.example; dkim=pass header.d=sender.example",
      ),
    );
    expect(results(trustedAuthResults(headers, GOOGLE))).toEqual(["spf=fail", "dkim=none"]);
  });

  it("trusts the topmost header in the zone when a sender put one straight under the receiver's", () => {
    const headers = gmail(
      "mx.google.com; spf=fail smtp.mailfrom=sender.example",
      h("Authentication-Results", "mx.google.com; spf=pass smtp.mailfrom=sender.example"),
    );
    expect(results(trustedAuthResults(headers, GOOGLE))).toEqual(["spf=fail"]);
  });

  it("trusts Microsoft 365's header and ignores a forged one of its shape, or Google's, below the boundary", () => {
    const headers = [
      h("Received", "from AM6PR01.eurprd01.prod.outlook.com by AM6PR02.eurprd01.prod.outlook.com with HTTPS"),
      h("Authentication-Results", M365),
      h("Received", "from mail.sender.example (203.0.113.5) by AM5EUR01FT001.mail.protection.outlook.com with ESMTP"),
      SENDER_HOP,
      h("Authentication-Results", FORGED_M365),
      h("Authentication-Results", "mx.google.com; spf=pass smtp.mailfrom=contoso.com; dkim=pass header.d=contoso.com"),
    ];
    const selection = trustedAuthResults(headers, [...MICROSOFT, ...GOOGLE]);
    expect(selection).toMatchObject({ trusted: { kind: "microsoft", authservId: null } });
    expect(results(selection)).toEqual(["spf=fail", "dkim=pass", "dmarc=fail", "compauth=fail"]);
  });

  it("trusts no Microsoft-shaped header without compauth, nor an authserv-id outside the receiver", () => {
    const top = h("Received", "from a by AM6PR02.eurprd01.prod.outlook.com with HTTPS");
    expect(
      trustedAuthResults([top, h("Authentication-Results", "spf=pass smtp.mailfrom=contoso.com")], MICROSOFT),
    ).toEqual({
      untrusted: "none-in-zone",
    });
    expect(trustedAuthResults([top, h("Authentication-Results", "mail.evil.example; spf=pass")], MICROSOFT)).toEqual({
      untrusted: "none-in-zone",
    });
    expect(
      results(trustedAuthResults([top, h("Authentication-Results", "eur.prod.outlook.com; spf=pass")], MICROSOFT)),
    ).toEqual(["spf=pass"]);
  });

  it("refuses ambiguous provenance: two receiving systems' results in one zone, or a top the receiver did not write", () => {
    // Two systems' results above the entry hop: which one wrote what cannot be told.
    const both = [
      h("Received", "from AM6PR01.eurprd01.prod.outlook.com by AM6PR02.eurprd01.prod.outlook.com with HTTPS"),
      h("Authentication-Results", "mx.google.com; spf=pass smtp.mailfrom=sender.example"),
      h("Authentication-Results", M365),
      h("Received", "from mail.sender.example (203.0.113.5) by AM5EUR01FT001.mail.protection.outlook.com with ESMTP"),
    ];
    expect(trustedAuthResults(both, [...MICROSOFT, ...GOOGLE])).toEqual({ untrusted: "ambiguous" });
    // Under Google's entry hop only Google's own stamp counts: a Microsoft-shaped one beside it is the sender's.
    const underGoogle = gmail(
      "mx.google.com; spf=fail smtp.mailfrom=sender.example",
      h("Authentication-Results", FORGED_M365),
    );
    expect(trustedAuthResults(underGoogle, [...MICROSOFT, ...GOOGLE])).toMatchObject({ trusted: { kind: "google" } });
    expect(results(trustedAuthResults(underGoogle, [...MICROSOFT, ...GOOGLE]))).toEqual(["spf=fail"]);
    expect(trustedAuthResults([SENDER_HOP, h("Authentication-Results", "mx.google.com; spf=pass")], GOOGLE)).toEqual({
      untrusted: "no-boundary",
    });
    expect(trustedAuthResults([h("Authentication-Results", "mx.google.com; spf=pass")], GOOGLE)).toEqual({
      untrusted: "no-boundary",
    });
  });

  it("keeps the boundary at the entry hop: a sender's forged hop below it moves nothing (round 1)", () => {
    const other: Receiver[] = [{ kind: "other", pattern: "*.mailhost.example" }];
    const forged = [
      h("Received", "from attacker.example (203.0.113.9) by mx.mailhost.example with ESMTP"),
      h(
        "Authentication-Results",
        "mx.mailhost.example; spf=pass smtp.mailfrom=bank.example; dmarc=pass header.from=bank.example",
      ),
      h("Received", "from attacker.example by mx.mailhost.example with ESMTP"),
    ];
    expect(trustedAuthResults(forged, other)).toEqual({ untrusted: "none-in-zone" });
  });

  it("lets a provider's stamp vouch only under its own entry hop (round 1)", () => {
    const mixed: Receiver[] = [...GOOGLE, { kind: "other", pattern: "*.mailhost.example" }];
    const viaOther = [
      h("Received", "from attacker.example (203.0.113.9) by mx.mailhost.example with ESMTP"),
      h("Authentication-Results", "mx.google.com; spf=pass smtp.mailfrom=bank.example"),
    ];
    expect(trustedAuthResults(viaOther, mixed)).toEqual({ untrusted: "none-in-zone" });
  });

  it("reports every proven header above the entry hop, not only the first (round 1, RFC 8601 appendix B.4)", () => {
    const other: Receiver[] = [{ kind: "other", pattern: "*.mailhost.example" }];
    const headers = [
      h("Received", "from mx1.mailhost.example by store.mailhost.example with LMTP"),
      h("Authentication-Results", "filter.mailhost.example; spf=pass smtp.mailfrom=sender.example"),
      h("Authentication-Results", "filter.mailhost.example; dkim=fail header.d=sender.example; dmarc=fail"),
      h("Received", "from mail.sender.example (203.0.113.5) by mx1.mailhost.example with ESMTPS"),
      SENDER_HOP,
    ];
    expect(results(trustedAuthResults(headers, other))).toEqual(["spf=pass", "dkim=fail", "dmarc=fail"]);
  });

  it("reads a comment between tokens as the space it stands for (round 1)", () => {
    const parsed = parseAuthenticationResults("mx.google.com; spf=fail(no match)smtp.mailfrom=bank.example");
    expect(parsed?.results.map((r) => [r.result, r.props.get("smtp.mailfrom")])).toEqual([["fail", "bank.example"]]);
  });

  it("names each other limit: no headers, no known receiver, nothing in the zone", () => {
    const headers = gmail("mx.google.com; spf=pass");
    expect(trustedAuthResults(headers, GOOGLE, false)).toEqual({ untrusted: "no-headers" });
    expect(trustedAuthResults([], GOOGLE)).toEqual({ untrusted: "no-headers" });
    expect(trustedAuthResults(headers, [])).toEqual({ untrusted: "unknown-receiver" });
    expect(trustedAuthResults(headers.slice(0, 3), GOOGLE)).toEqual({ untrusted: "none-in-zone" });
  });

  it("knows another receiving system by its MX host and registrable domain, trusting only a header above its border hop", () => {
    const other: Receiver[] = [
      { kind: "other", pattern: "mx1.mailhost.example" },
      { kind: "other", pattern: "*.mailhost.example" },
    ];
    const inside = [
      h("Received", "from mx1.mailhost.example by store.mailhost.example with LMTP"),
      h("Authentication-Results", "filter.mailhost.example; dmarc=pass header.from=sender.example"),
      h("Received", "from mail.sender.example by mx1.mailhost.example with ESMTPS"),
      SENDER_HOP,
    ];
    expect(trustedAuthResults(inside, other)).toMatchObject({
      trusted: { kind: "other", authservId: "filter.mailhost.example" },
    });
    // Completion review: a receiver that adds no result of its own, and a message sent straight to it with a forged
    // one and no hop of the sender's, leaves the forgery just under the border hop. Another receiver promises no
    // stamp, so a header there is never trusted.
    const injected = [
      h("Received", "from 203.0.113.9 by mx1.mailhost.example with ESMTP"),
      h("Authentication-Results", "mx1.mailhost.example; spf=pass smtp.mailfrom=bank.example; dmarc=pass"),
    ];
    expect(trustedAuthResults(injected, other)).toEqual({ untrusted: "none-in-zone" });
  });
});

// A case view as the runner builds it: a forwarded or uploaded message with the given headers.
function view(headers: { name: string; value: string }[], tenant: Partial<CaseView["tenant"]> = {}): CaseView {
  return {
    tenant: { orgId: "org-auth", channel: "email", receivers: GOOGLE, headersAvailable: true, ...tenant },
    source: { kind: "message", path: "rfc822", otherOriginals: 0 },
    headers,
    text: "Pay the invoice.",
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
  };
}

describe("auth.results", () => {
  const trusted = gmail("mx.google.com; spf=pass smtp.mailfrom=sender.example; dkim=pass header.d=sender.example");

  it("classifies each case: an uploaded original with headers, a headerless upload, an inline forward, an unknown receiver, none in the zone", () => {
    const [uploaded] = authResultsEvidence(view(trusted, { channel: "upload" }));
    expect(uploaded).toMatchObject({
      check: "auth.results",
      severity: "info",
      detail: { trusted: true, fromFile: true },
    });
    expect(uploaded?.summary).toContain("as read from the uploaded file");
    expect(authResultsEvidence(view([], { channel: "upload", headersAvailable: false }))[0]?.detail).toEqual({
      trusted: false,
      reason: "no-headers",
      fromFile: true,
    });
    expect(
      authResultsEvidence({
        ...view([]),
        source: { kind: "message", path: "inline", otherOriginals: 0 },
        tenant: { ...view([]).tenant, headersAvailable: false },
      })[0]?.detail,
    ).toMatchObject({
      reason: "no-headers",
    });
    expect(authResultsEvidence(view(trusted, { receivers: [] }))[0]?.detail).toMatchObject({
      reason: "unknown-receiver",
    });
    expect(authResultsEvidence(view(trusted.slice(0, 3)))[0]?.detail).toMatchObject({ reason: "none-in-zone" });
  });

  it("keeps the summary plain and bounded whatever the header holds", () => {
    const hostile = gmail(
      `mx.google.com; ${Array.from({ length: 80 }, (_, i) => `x${i}=<b>pass</b>\u202e`).join("; ")}`,
    );
    const [item] = authResultsEvidence(view(hostile));
    expect(Array.from(item?.summary ?? "").length).toBeLessThanOrEqual(200);
    expect(item?.summary).not.toMatch(/[<>\u202e]/);
    expect((item?.detail as { results: unknown[] } | undefined)?.results).toHaveLength(50);
  });

  it("is stored and read back through the registry, the runner and the store", async () => {
    expect(checks.names()).toContain("auth.results");
    const made = await createCase(env.DB, { orgId: "org-auth", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    await saveEvidence(env.DB, made.value.id, await runChecks(view(trusted)));
    const item = (await readEvidence(env.DB, made.value.id)).find((e) => e.check === "auth.results");
    expect(item).toMatchObject({
      severity: "info",
      detail: {
        trusted: true,
        receiver: "google",
        authservId: "mx.google.com",
        fromFile: false,
        results: [
          { method: "spf", result: "pass", props: { "smtp.mailfrom": "sender.example" } },
          { method: "dkim", result: "pass", props: { "header.d": "sender.example" } },
        ],
      },
    });
    expect(item?.summary).toBe("Google, your receiving system, recorded spf pass, dkim pass.");
    // Run by the runner when the headers are missing too: no `needs` keeps it from being skipped.
    const headerless = { ...view([]), tenant: { ...view([]).tenant, headersAvailable: false } };
    expect(
      (await runChecks(headerless)).filter((e) => e.check === "auth.results" || e.check === "not_checked"),
    ).toEqual([
      expect.objectContaining({
        check: "auth.results",
        detail: { trusted: false, reason: "no-headers", fromFile: false },
      }),
    ]);
  });
});
