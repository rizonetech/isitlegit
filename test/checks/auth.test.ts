import { describe, expect, it } from "vitest";
import type { Receiver } from "../../src/auth/receivers";
import { alignmentEvidence, dmarcEvidence, registerAuthChecks } from "../../src/checks/auth";
import { bundled } from "../../src/checks/brands";
import type { CaseView } from "../../src/checks/case-view";
import { checks } from "../../src/checks/index";
import { CheckRegistry } from "../../src/checks/registry";
import { runChecks } from "../../src/checks/runner";

// D02 T02 §2: SPF, DKIM and DMARC evidence and alignment, read only from the headers the receiver wrote.
const GOOGLE: Receiver[] = [{ kind: "google", pattern: "*.google.com" }];
const MICROSOFT: Receiver[] = [{ kind: "microsoft", pattern: "*.outlook.com" }];
const RAW = "raw/case-auth/message.eml";
const h = (name: string, value: string) => ({ name, value });

// An original as Gmail delivers it, From the given address, with Gmail's Authentication-Results.
function gmail(results: string, from = "Accounts <billing@bank.example>") {
  return [
    h("Received", "from mail.sender.example (mail.sender.example. [203.0.113.5]) by mx.google.com with ESMTPS id z"),
    h("Authentication-Results", `mx.google.com; ${results}`),
    h("Received", "from client by mail.sender.example with ESMTP id q"),
    h("From", from),
    h("Subject", "Invoice"),
  ];
}
// The same through Microsoft 365, which writes no authserv-id.
function m365(results: string, from = "billing@bank.example") {
  return [
    h("Received", "from AM6PR01.eurprd01.prod.outlook.com by AM6PR02.eurprd01.prod.outlook.com with HTTPS"),
    h("Authentication-Results", results),
    h("Received", "from mail.sender.example (203.0.113.5) by AM5EUR01FT001.mail.protection.outlook.com with ESMTP"),
    h("From", from),
  ];
}
function view(headers: { name: string; value: string }[], receivers: Receiver[] = GOOGLE): CaseView {
  return {
    tenant: {
      orgId: "org-auth",
      channel: "email",
      receivers,
      headersAvailable: true,
      trusted: { own: [], suppliers: [] },
    },
    raw: RAW,
    brands: bundled,
    senderHistory: null,
    domainAges: null,
    attachmentHeads: null,
    hiddenText: null,
    htmlAttachments: null,
    attachmentRisks: null,
    source: { kind: "message", path: "rfc822", otherOriginals: 0 },
    headers,
    text: null,
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
  };
}
const run = async (v: CaseView) => {
  const registry = new CheckRegistry();
  registerAuthChecks(registry);
  return runChecks(v, registry);
};
const one = async (v: CaseView, check: string) => (await run(v)).find((e) => e.check === check);

describe("auth.spf and auth.dkim", () => {
  it.each([
    ["pass", "info", "passed"],
    ["fail", "medium", "failed"],
    ["softfail", "medium", "failed"],
    ["temperror", "low", "inconclusive"],
    ["permerror", "low", "inconclusive"],
    ["neutral", "low", "inconclusive"],
    ["none", "info", "unavailable"],
  ])("reads SPF %s as %s (%s)", async (result, severity, state) => {
    const item = await one(view(gmail(`spf=${result} smtp.mailfrom=billing@bank.example`)), "auth.spf");
    expect(item).toMatchObject({ severity, detail: { state, results: [{ identifier: "bank.example" }] } });
    expect(item?.artefacts).toEqual([RAW]);
  });

  it("names SPF's HELO identity only on the null path", async () => {
    const item = await one(view(gmail("spf=pass smtp.mailfrom=<> smtp.helo=mail.bank.example")), "auth.spf");
    expect(item?.detail).toMatchObject({ helo: true, results: [{ identifier: "mail.bank.example" }] });
  });

  it("passes DKIM on any good signature among several, naming each signer, and reads a signer from header.i", async () => {
    const two = await one(
      view(gmail("dkim=fail header.d=bank.example; dkim=pass header.i=@mail.bank.example")),
      "auth.dkim",
    );
    expect(two).toMatchObject({
      severity: "info",
      detail: { state: "passed", results: [{ identifier: "bank.example" }, { identifier: "mail.bank.example" }] },
    });
    expect(await one(view(gmail("dkim=fail header.d=bank.example")), "auth.dkim")).toMatchObject({
      severity: "medium",
    });
    expect(await one(view(gmail("spf=pass smtp.mailfrom=bank.example")), "auth.dkim")).toMatchObject({
      severity: "info",
      detail: { state: "unavailable" },
    });
  });

  it("says nothing when no header is trusted: auth.results says why", async () => {
    expect(await run(view(gmail("spf=fail"), []))).toEqual([]);
  });
});

describe("auth.dmarc", () => {
  const dmarc = (v: CaseView) => dmarcEvidence(v)[0];

  it("is high when Google's recorded policy for the organisational domain enforces", () => {
    expect(dmarc(view(gmail("dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=bank.example")))).toMatchObject({
      severity: "high",
      detail: { policy: { certain: "reject" } },
    });
    // The organisational domain itself: p applies, whatever sp says.
    expect(dmarc(view(gmail("dmarc=fail (p=QUARANTINE sp=NONE dis=NONE)")))).toMatchObject({ severity: "high" });
  });

  it("keeps a subdomain's policy uncertain when p and sp differ, high only when both enforce", () => {
    const sub = "billing@pay.bank.example";
    expect(dmarc(view(gmail("dmarc=fail (p=REJECT sp=NONE dis=NONE)", sub)))).toMatchObject({
      severity: "medium",
      detail: { policy: { either: ["reject", "none"] } },
    });
    expect(dmarc(view(gmail("dmarc=fail (p=NONE sp=REJECT dis=NONE)", sub)))).toMatchObject({
      severity: "medium",
      detail: { policy: { either: ["none", "reject"] } },
    });
    expect(dmarc(view(gmail("dmarc=fail (p=REJECT sp=QUARANTINE dis=NONE)", sub)))).toMatchObject({ severity: "high" });
  });

  it.each([
    ["reject", "high"],
    ["oreject", "high"],
    ["quarantine", "high"],
    ["pct.reject", "high"],
    ["pct.quarantine", "high"],
    ["none", "medium"],
  ])("takes Microsoft 365's action=%s as the policy it applied (%s)", (action, severity) => {
    const item = dmarc(
      view(m365(`dmarc=fail action=${action} header.from=bank.example; compauth=fail reason=000`), MICROSOFT),
    );
    expect(item?.severity).toBe(severity);
  });

  it("reads an erred evaluation as inconclusive, a missing record as unavailable, and an unrecorded policy as medium", () => {
    const erred = dmarc(
      view(m365("dmarc=fail action=temperror header.from=bank.example; compauth=none reason=905"), MICROSOFT),
    );
    expect(erred).toMatchObject({ severity: "low", detail: { state: "inconclusive" } });
    expect(dmarc(view(gmail("dmarc=temperror header.from=bank.example")))).toMatchObject({ severity: "low" });
    const guess = dmarc(
      view(m365("dmarc=bestguesspass action=none header.from=bank.example; compauth=pass reason=109"), MICROSOFT),
    );
    expect(guess).toMatchObject({ severity: "info", detail: { state: "unavailable" } });
    expect(dmarc(view(gmail("dmarc=fail header.from=bank.example")))).toMatchObject({
      severity: "medium",
      detail: { policy: null },
    });
    expect(dmarc(view(gmail("dmarc=fail policy.dmarc=reject header.from=bank.example")))).toMatchObject({
      severity: "high",
    });
  });
});

describe("auth.alignment", () => {
  const align = (results: string, from?: string) => alignmentEvidence(view(gmail(results, from)))[0];

  it("is high when SPF passes only for an unrelated domain", () => {
    expect(align("spf=pass smtp.mailfrom=bounce@mailer.example; dkim=none")).toMatchObject({ severity: "high" });
  });

  it("aligns DKIM alone, any one of several signatures, a subdomain, and a mailbox-form MAIL FROM", () => {
    expect(align("spf=fail smtp.mailfrom=x.example; dkim=pass header.d=bank.example")).toMatchObject({
      severity: "info",
      detail: { aligned: [{ method: "DKIM", identifier: "bank.example" }] },
    });
    expect(align("dkim=pass header.d=mailer.example; dkim=pass header.d=mail.bank.example")).toMatchObject({
      severity: "info",
    });
    expect(align("spf=pass smtp.mailfrom=bounces@bank.example")).toMatchObject({
      severity: "info",
      detail: { aligned: [{ method: "SPF", identifier: "bank.example" }] },
    });
  });

  it("does not align a failed same-domain signature, nor a signature naming no signer", () => {
    expect(align("dkim=fail header.d=bank.example; spf=none")).toMatchObject({ severity: "high" });
    expect(align("dkim=pass header.s=selector1; spf=none")).toMatchObject({
      severity: "high",
      detail: { aligned: [] },
    });
  });

  it("is medium, not high, when an error leaves it unconfirmed", () => {
    expect(align("spf=temperror smtp.mailfrom=bank.example; dkim=none")).toMatchObject({ severity: "medium" });
  });

  it("compares registrable domains, not full host names", () => {
    expect(align("spf=pass smtp.mailfrom=bounce.mail.bank.example", "billing@pay.bank.example")).toMatchObject({
      severity: "info",
    });
    expect(align("spf=pass smtp.mailfrom=bank.example.evil.example", "billing@bank.example")).toMatchObject({
      severity: "high",
    });
  });

  it("says when the From names no single valid address", () => {
    expect(align("spf=pass smtp.mailfrom=bank.example", "a@bank.example, b@other.example")).toMatchObject({
      severity: "medium",
      detail: { from: null },
    });
  });
});

describe("completion review", () => {
  it("aligns an internationalised From with its A-label signer, either way round", () => {
    expect(
      alignmentEvidence(view(gmail("dkim=pass header.d=xn--bcher-kva.example", "a@bücher.example")))[0],
    ).toMatchObject({
      severity: "info",
    });
    expect(
      alignmentEvidence(view(gmail("dkim=pass header.d=bücher.example", "a@xn--bcher-kva.example")))[0],
    ).toMatchObject({
      severity: "info",
    });
  });

  it("gives each signer its own outcome in the summary", async () => {
    const item = await one(
      view(gmail("dkim=fail header.d=bank.example; dkim=pass header.d=mailer.example")),
      "auth.dkim",
    );
    expect(item?.summary).toBe(
      "DKIM passed for mailer.example and failed for bank.example, as your receiving system recorded.",
    );
    expect(item?.summary).not.toContain("passed for bank.example");
  });

  it("cites the receiver's headers for a method it did not report", async () => {
    const headers = gmail("spf=pass smtp.mailfrom=bounce@mailer.example");
    const items = await run(view(headers));
    for (const check of ["auth.dkim", "auth.dmarc"]) {
      expect(items.find((e) => e.check === check)).toMatchObject({
        detail: { state: "unavailable", headers: [headers[1]?.value] },
      });
    }
    const silent = gmail("iprev=pass policy.iprev=203.0.113.5");
    expect((await one(view(silent), "auth.alignment"))?.detail.headers).toEqual([silent[1]?.value]);
  });
});

describe("round 1", () => {
  it("never aligns a From whose domain is not a domain name, however a URL would read it", () => {
    expect(
      alignmentEvidence(view(gmail("dkim=pass header.d=bank.example", "a@bank.example/evil.example")))[0],
    ).toMatchObject({
      severity: "medium",
      detail: { from: null },
    });
  });

  it("lets a HELO identity align only on an explicit null path", () => {
    const helo = "spf=pass smtp.helo=bank.example; spf=fail smtp.mailfrom=other.example; dkim=none";
    expect(alignmentEvidence(view(gmail(helo)))[0]).toMatchObject({ severity: "high" });
    expect(alignmentEvidence(view(gmail("spf=pass smtp.mailfrom=<> smtp.helo=bank.example")))[0]).toMatchObject({
      severity: "info",
    });
  });

  it("keeps a long three-signer summary within the schema, so the item is stored", async () => {
    const d = (c: string) => `${c.repeat(32)}.example`;
    const items = await run(
      view(gmail(`dkim=pass header.d=${d("a")}; dkim=fail header.d=${d("b")}; dkim=temperror header.d=${d("c")}`)),
    );
    const dkim = items.find((e) => e.check === "auth.dkim");
    expect(Array.from(dkim?.summary ?? "").length).toBeLessThanOrEqual(200);
    expect(items.some((e) => e.check === "not_checked")).toBe(false);
    expect((dkim?.detail as { results: unknown[] } | undefined)?.results).toHaveLength(3);
  });

  it("never lets an unnamed pass read as a named signer's", async () => {
    const item = await one(view(gmail("dkim=pass; dkim=fail header.d=bank.example")), "auth.dkim");
    expect(item?.summary).toBe(
      "DKIM passed for a signature naming no signer and failed for bank.example, as your receiving system recorded.",
    );
  });

  it("checks the whole mailbox, not only what follows its last @ (round 2)", () => {
    expect(
      alignmentEvidence(view(gmail("dkim=pass header.d=bank.example", "a@evil.example@bank.example")))[0],
    ).toMatchObject({
      severity: "medium",
      detail: { from: null },
    });
    expect(alignmentEvidence(view(gmail("dkim=pass header.d=bank.example", '"a@b"@bank.example')))[0]).toMatchObject({
      severity: "info",
    });
  });

  it("keeps an item inside the schema however long a comment is, so the failure is stored (round 2)", async () => {
    const items = await run(view(gmail(`dkim=fail (${"x".repeat(66_000)}) header.d=bank.example`)));
    expect(items.some((e) => e.check === "not_checked")).toBe(false);
    const dkim = items.find((e) => e.check === "auth.dkim");
    expect(dkim).toMatchObject({ severity: "medium", artefacts: [RAW] });
    expect(new TextEncoder().encode(JSON.stringify(dkim?.detail)).length).toBeLessThanOrEqual(64 * 1024);
  });

  it.each(["dkim", "spf"])(
    "stores an inconclusive %s with its raw key however long its result token is (round 3)",
    async (method) => {
      const items = await run(view(gmail(`${method}=${"x".repeat(66_000)} header.d=bank.example`)));
      expect(items.some((e) => e.check === "not_checked")).toBe(false);
      const item = items.find((e) => e.check === `auth.${method}`);
      expect(item).toMatchObject({ severity: "low", detail: { state: "inconclusive" }, artefacts: [RAW] });
      expect(new TextEncoder().encode(JSON.stringify(item?.detail)).length).toBeLessThanOrEqual(64 * 1024);
    },
  );

  it("reads an internationalised apex as the organisational domain for its policy", () => {
    expect(dmarcEvidence(view(gmail("dmarc=fail (p=REJECT sp=NONE dis=NONE)", "a@bücher.example")))[0]).toMatchObject({
      severity: "high",
      detail: { policy: { certain: "reject" } },
    });
  });
});

describe("each item cites its own header", () => {
  it("cites the header its result came from, never a neighbour or a rejected forgery", async () => {
    const other: Receiver[] = [{ kind: "other", pattern: "*.mailhost.example" }];
    const headers = [
      h("Authentication-Results", "filter.mailhost.example; spf=pass smtp.mailfrom=bank.example"),
      h("Authentication-Results", "filter.mailhost.example; dkim=fail header.d=bank.example"),
      h("Received", "from mail.sender.example (203.0.113.5) by mx1.mailhost.example with ESMTPS"),
      h("Authentication-Results", "filter.mailhost.example; dkim=pass header.d=bank.example"),
      h("From", "billing@bank.example"),
    ];
    const items = await run(view(headers, other));
    expect(items.find((e) => e.check === "auth.spf")?.detail.headers).toEqual([headers[0]?.value]);
    expect(items.find((e) => e.check === "auth.dkim")).toMatchObject({
      severity: "medium",
      detail: { headers: [headers[1]?.value] },
    });
  });

  it("runs in the production registry after auth.results", () => {
    const names = checks.names();
    expect(names.indexOf("auth.results")).toBeLessThan(names.indexOf("auth.spf"));
    expect(names).toEqual(expect.arrayContaining(["auth.spf", "auth.dkim", "auth.dmarc", "auth.alignment"]));
  });
});
