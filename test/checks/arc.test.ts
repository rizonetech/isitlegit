import { describe, expect, it } from "vitest";
import type { Receiver } from "../../src/auth/receivers";
import { arcEvidence, arcVerdict, readArcResults, readArcSeal, registerArcCheck } from "../../src/checks/arc";
import { bundled } from "../../src/checks/brands";
import type { CaseView } from "../../src/checks/case-view";
import { checks } from "../../src/checks/index";
import { CheckRegistry } from "../../src/checks/registry";
import { runChecks } from "../../src/checks/runner";

// D02 T02 §3: the receiver's ARC verdict, and the earlier hop's results as context.
const GOOGLE: Receiver[] = [{ kind: "google", pattern: "*.google.com" }];
const MICROSOFT: Receiver[] = [{ kind: "microsoft", pattern: "*.outlook.com" }];
const RAW = "raw/case-arc/message.eml";
const h = (name: string, value: string) => ({ name, value });

// The forwarder's set, instance 1: what it saw before it forwarded.
const EARLIER = h(
  "ARC-Authentication-Results",
  "i=1; mx.lists.example; spf=pass smtp.mailfrom=bank.example; dkim=pass header.d=bank.example",
);
const SEAL = h("ARC-Seal", "i=1; a=rsa-sha256; t=1730000000; cv=none; d=lists.example; s=arc; b=abc");

function view(headers: { name: string; value: string }[], receivers: Receiver[] = GOOGLE): CaseView {
  return {
    tenant: {
      orgId: "org-arc",
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
// A forwarded message as Gmail delivers it: Gmail's verdict names instance 1, the forwarder's set below its boundary.
const viaGoogle = (arc: string, ...rest: { name: string; value: string }[]) => [
  h("Received", "from lists.example (lists.example. [203.0.113.7]) by mx.google.com with ESMTPS id z"),
  h("Authentication-Results", `mx.google.com; ${arc}; spf=fail smtp.mailfrom=lists.example`),
  h("Received", "from client by lists.example with ESMTP id q"),
  ...rest,
  h("From", "billing@bank.example"),
];
// Microsoft 365 seals on receipt: its own set (instance 2) above, the forwarder's (instance 1) lower.
const viaMicrosoft = (arc: string, instance = 2, ...rest: { name: string; value: string }[]) => [
  h("ARC-Seal", `i=${instance}; a=rsa-sha256; s=arcselector; d=microsoft.com; cv=pass; b=x`),
  h("ARC-Authentication-Results", `i=${instance}; mx.microsoft.com 1; spf=fail smtp.mailfrom=lists.example; ${arc}`),
  h("Received", "from AM6PR01.eurprd01.prod.outlook.com by AM6PR02.eurprd01.prod.outlook.com with HTTPS"),
  h("Authentication-Results", "spf=fail smtp.mailfrom=lists.example; compauth=pass reason=130"),
  h("Received", "from lists.example (203.0.113.7) by AM5EUR01FT001.mail.protection.outlook.com with ESMTP"),
  ...rest,
  h("From", "billing@bank.example"),
];
const one = (v: CaseView) => arcEvidence(v)[0];

describe("reading ARC headers", () => {
  it("reads an ARC-Authentication-Results' instance and payload, and an ARC-Seal's instance and signer", () => {
    expect(readArcResults(EARLIER.value)).toMatchObject({ instance: 1, authservId: "mx.lists.example" });
    expect(readArcResults(EARLIER.value)?.results.map((r) => r.method)).toEqual(["spf", "dkim"]);
    expect(readArcSeal(SEAL.value)).toEqual({ instance: 1, domain: "lists.example" });
    expect(readArcResults("no instance; spf=pass")).toBeNull();
    expect(readArcSeal("i=1; a=rsa-sha256; b=x")).toBeNull();
  });
});

describe("auth.arc", () => {
  it("reports Google's pass with the forwarder's results and sealer as context", () => {
    const item = one(view(viaGoogle("arc=pass (i=1 spf=pass spfdomain=bank.example)", EARLIER, SEAL)));
    expect(item).toMatchObject({
      check: "auth.arc",
      severity: "info",
      artefacts: [RAW],
      detail: {
        verdict: "pass",
        instance: 1,
        sealer: "lists.example",
        earlier: [
          { method: "spf", result: "pass", props: { "smtp.mailfrom": "bank.example" } },
          { method: "dkim", result: "pass", props: { "header.d": "bank.example" } },
        ],
      },
    });
    expect(item?.summary).toBe(
      "ARC passed, context not proof: the earlier hop, sealed by lists.example, recorded spf pass, dkim pass.",
    );
    expect((item?.detail as { headers: string[] } | undefined)?.headers).toEqual([
      expect.stringContaining("arc=pass"),
      EARLIER.value,
      SEAL.value,
    ]);
  });

  it("reads Microsoft 365's verdict from its own seal, and the instance below as the earlier context", () => {
    expect(arcVerdict(view(viaMicrosoft("arc=pass", 2, EARLIER, SEAL), MICROSOFT))).toMatchObject({ validated: 1 });
    expect(one(view(viaMicrosoft("arc=pass", 2, EARLIER, SEAL), MICROSOFT))).toMatchObject({
      severity: "info",
      detail: { instance: 1, sealer: "lists.example" },
    });
  });

  it("says nothing for arc=none, Microsoft's first set included, and reads no instance zero", () => {
    expect(arcEvidence(view(viaGoogle("arc=none")))).toEqual([]);
    expect(arcVerdict(view(viaMicrosoft("arc=none", 1), MICROSOFT))).toMatchObject({ validated: null });
    expect(arcEvidence(view(viaMicrosoft("arc=none", 1), MICROSOFT))).toEqual([]);
  });

  it("is medium on a failure and low when it could not be evaluated", () => {
    expect(one(view(viaGoogle("arc=fail (i=1)", EARLIER, SEAL)))).toMatchObject({ severity: "medium" });
    expect(one(view(viaGoogle("arc=temperror")))).toMatchObject({ severity: "low" });
    expect(one(view(viaMicrosoft("arc=permerror", 2), MICROSOFT))).toMatchObject({ severity: "low" });
  });

  it("names the context unavailable rather than guess an instance", () => {
    const unavailable = { severity: "info", detail: { context: "unavailable" } };
    expect(one(view(viaGoogle("arc=pass", EARLIER, SEAL)))).toMatchObject(unavailable); // no instance named
    expect(one(view(viaGoogle("arc=pass (i=1)", SEAL)))).toMatchObject(unavailable); // no earlier results
    expect(one(view(viaGoogle("arc=pass (i=1)", EARLIER)))).toMatchObject(unavailable); // no seal
    expect(one(view(viaGoogle("arc=pass (i=1)", EARLIER, EARLIER, SEAL)))).toMatchObject(unavailable); // doubled
  });

  it("never reads a forged verdict below the receiver's boundary", () => {
    const forged = [
      h("Received", "from lists.example (203.0.113.7) by mx.google.com with ESMTPS"),
      h("Authentication-Results", "mx.google.com; spf=fail smtp.mailfrom=lists.example"),
      h("Received", "from attacker.example by lists.example"),
      h("Authentication-Results", "mx.google.com; arc=pass (i=1)"),
      EARLIER,
      SEAL,
    ];
    expect(arcEvidence(view(forged))).toEqual([]);
    // Microsoft: a forged set of its authserv-id below its boundary is not its own.
    const forgedMs = [
      h("Received", "from AM6PR01.eurprd01.prod.outlook.com by AM6PR02.eurprd01.prod.outlook.com with HTTPS"),
      h("Authentication-Results", "spf=fail smtp.mailfrom=lists.example; compauth=fail reason=001"),
      h("Received", "from attacker.example by mail.attacker.example"),
      h("ARC-Authentication-Results", "i=2; mx.microsoft.com 1; arc=pass"),
      EARLIER,
      SEAL,
    ];
    expect(arcEvidence(view(forgedMs, MICROSOFT))).toEqual([]);
  });

  it("reads a Microsoft-authserv ARC set only when Microsoft is the receiver", () => {
    const underGoogle = [
      h("ARC-Authentication-Results", "i=2; mx.microsoft.com 1; arc=pass"),
      ...viaGoogle("dkim=none", EARLIER, SEAL),
    ];
    expect(arcEvidence(view(underGoogle))).toEqual([]);
  });

  it("keeps the item inside the schema whatever the headers hold", async () => {
    const huge = h(
      "ARC-Authentication-Results",
      `i=1; mx.lists.example; ${Array.from({ length: 60 }, (_, i) => `x${i}=<b>${"y".repeat(2_000)}</b>`).join("; ")}`,
    );
    const registry = new CheckRegistry();
    registerArcCheck(registry);
    const items = await runChecks(view(viaGoogle("arc=pass (i=1)", huge, SEAL)), registry);
    expect(items.map((e) => e.check)).toEqual(["auth.arc"]);
    expect(Array.from(items[0]?.summary ?? "").length).toBeLessThanOrEqual(200);
    expect(items[0]?.summary).not.toMatch(/[<>]/);
    expect(new TextEncoder().encode(JSON.stringify(items[0]?.detail)).length).toBeLessThanOrEqual(64 * 1024);
  });

  it("keeps the item, its verdict and its raw key with 300 properties in one earlier result (completion review)", async () => {
    const props = Array.from({ length: 300 }, (_, i) => `p${i}.${"n".repeat(200)}=${"v".repeat(200)}`).join(" ");
    const crowded = h("ARC-Authentication-Results", `i=1; mx.lists.example; spf=pass ${props}`);
    const registry = new CheckRegistry();
    registerArcCheck(registry);
    const [item, ...rest] = await runChecks(view(viaGoogle("arc=pass (i=1)", crowded, SEAL)), registry);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ check: "auth.arc", detail: { verdict: "pass" }, artefacts: [RAW] });
    expect(new TextEncoder().encode(JSON.stringify(item?.detail)).length).toBeLessThanOrEqual(64 * 1024);
  });

  it('keeps "not proof" in the summary at the longest sealer and results, and says so in the detail', () => {
    const sealer = `${"s".repeat(60)}.${"t".repeat(60)}.example`;
    const longSeal = h("ARC-Seal", `i=1; a=rsa-sha256; cv=none; d=${sealer}; s=arc; b=x`);
    const longEarlier = h(
      "ARC-Authentication-Results",
      `i=1; mx.lists.example; ${["spf", "dkim", "dmarc", "arc"].map((m) => `${m}=${"pass".repeat(20)}`).join("; ")}`,
    );
    const item = one(view(viaGoogle("arc=pass (i=1)", longEarlier, longSeal)));
    expect(item?.summary).toContain("context not proof");
    expect(Array.from(item?.summary ?? "").length).toBeLessThanOrEqual(200);
    expect(item?.detail).toMatchObject({ proof: false });
  });

  it("reads an instance tag with comments, and counts it against a duplicate (round 1)", () => {
    const commented = h(
      "ARC-Authentication-Results",
      "i (forwarder) = 1; mx.lists.example; spf=pass smtp.mailfrom=bank.example",
    );
    expect(one(view(viaGoogle("arc=pass (i=1)", commented, SEAL)))).toMatchObject({
      detail: { sealer: "lists.example" },
    });
    const second = h(
      "ARC-Authentication-Results",
      "i (again) = 1; mx.lists.example; spf=fail smtp.mailfrom=bank.example",
    );
    expect(one(view(viaGoogle("arc=pass (i=1)", EARLIER, second, SEAL)))).toMatchObject({
      detail: { context: "unavailable" },
    });
  });

  it("splits an instance tag outside comments, escapes included, and never lets a set it cannot read hide a duplicate (round 2)", () => {
    for (const tag of ["i (forwarder; note) = 1", "i (forwarder\\) note) = 1"]) {
      const hidden = h("ARC-Authentication-Results", `${tag}; mx.lists.example; spf=fail`);
      expect(one(view(viaGoogle("arc=pass (i=1)", EARLIER, hidden, SEAL)))).toMatchObject({
        detail: { context: "unavailable" },
      });
    }
    expect(readArcResults("i (forwarder; note) = 1; mx.lists.example; spf=fail")).toMatchObject({ instance: 1 });
    const unreadable = h("ARC-Authentication-Results", "garbled without an instance");
    expect(one(view(viaGoogle("arc=pass (i=1)", EARLIER, unreadable, SEAL)))).toMatchObject({
      detail: { context: "unavailable" },
    });
  });

  it("counts a seal by its instance alone, so a seal missing its signer still makes a duplicate (round 3)", () => {
    const first = h("ARC-Seal", "i=1; d=lists.example; b=abc");
    const second = h("ARC-Seal", "i=1; b=def");
    expect(one(view(viaGoogle("arc=pass (i=1)", EARLIER, first, second)))).toMatchObject({
      detail: { context: "unavailable" },
    });
    const unreadable = h("ARC-Seal", "no instance here; d=lists.example");
    expect(one(view(viaGoogle("arc=pass (i=1)", EARLIER, SEAL, unreadable)))).toMatchObject({
      detail: { context: "unavailable" },
    });
  });

  it("runs in the production registry after §2's checks", () => {
    const names = checks.names();
    expect(names.indexOf("auth.arc")).toBeGreaterThan(names.indexOf("auth.alignment"));
  });
});
