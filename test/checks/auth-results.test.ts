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
    const both = gmail(
      "mx.google.com; spf=pass smtp.mailfrom=sender.example",
      h("Authentication-Results", FORGED_M365),
    );
    expect(trustedAuthResults(both, [...MICROSOFT, ...GOOGLE])).toEqual({ untrusted: "ambiguous" });
    expect(trustedAuthResults([SENDER_HOP, h("Authentication-Results", "mx.google.com; spf=pass")], GOOGLE)).toEqual({
      untrusted: "no-boundary",
    });
    expect(trustedAuthResults([h("Authentication-Results", "mx.google.com; spf=pass")], GOOGLE)).toEqual({
      untrusted: "no-boundary",
    });
  });

  it("names each other limit: no headers, no known receiver, nothing in the zone", () => {
    const headers = gmail("mx.google.com; spf=pass");
    expect(trustedAuthResults(headers, GOOGLE, false)).toEqual({ untrusted: "no-headers" });
    expect(trustedAuthResults([], GOOGLE)).toEqual({ untrusted: "no-headers" });
    expect(trustedAuthResults(headers, [])).toEqual({ untrusted: "unknown-receiver" });
    expect(trustedAuthResults(headers.slice(0, 3), GOOGLE)).toEqual({ untrusted: "none-in-zone" });
  });

  it("knows another receiving system by its MX host and registrable domain", () => {
    const other: Receiver[] = [
      { kind: "other", pattern: "mx1.mailhost.example" },
      { kind: "other", pattern: "*.mailhost.example" },
    ];
    const headers = [
      h("Received", "from mail.sender.example by mx1.mailhost.example with ESMTPS"),
      h("Authentication-Results", "filter.mailhost.example; dmarc=pass header.from=sender.example"),
      SENDER_HOP,
    ];
    expect(trustedAuthResults(headers, other)).toMatchObject({
      trusted: { kind: "other", authservId: "filter.mailhost.example" },
    });
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
