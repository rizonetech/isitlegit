import { describe, expect, it } from "vitest";
import { bundled } from "../../src/checks/brands";
import type { CaseView } from "../../src/checks/case-view";
import { checks } from "../../src/checks/index";
import { CheckRegistry } from "../../src/checks/registry";
import { runChecks } from "../../src/checks/runner";
import {
  displayAddressEvidence,
  displayBrandEvidence,
  mailbox,
  registerSenderChecks,
  replyToEvidence,
  returnPathEvidence,
} from "../../src/checks/sender";

// D02 T02 §4: a display name over a different address or a brand's name, replies or bounces sent elsewhere.
const RAW = "raw/case-sender/message.eml";
const h = (name: string, value: string) => ({ name, value });
function view(headers: { name: string; value: string }[], headersAvailable = true): CaseView {
  return {
    tenant: { orgId: "org-sender", channel: "email", receivers: [], headersAvailable },
    raw: RAW,
    brands: bundled,
    senderHistory: null,
    source: { kind: "message", path: "rfc822", otherOriginals: 0 },
    headers,
    text: null,
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
  };
}
const from = (value: string, ...rest: { name: string; value: string }[]) => view([h("From", value), ...rest]);

describe("sender.display_address", () => {
  it("flags a shown address or domain other than the From, and a different mailbox at the same domain", () => {
    for (const shown of [
      '"debtors@fynbosfreight.example" <x@freemail.example>',
      '"fynbosfreight.example" <x@freemail.example>',
      '"debtors@fynbosfreight.example" <accounts@fynbosfreight.example>',
    ]) {
      const [item] = displayAddressEvidence(from(shown));
      expect(item, shown).toMatchObject({ check: "sender.display_address", severity: "medium", artefacts: [RAW] });
      expect((item?.detail as { headers: string[] } | undefined)?.headers).toEqual([`From: ${shown}`]);
    }
  });

  it("passes a matching mailbox, a matching domain, and a plain name", () => {
    for (const shown of [
      '"Debtors@FynbosFreight.example" <debtors@fynbosfreight.example>',
      '"fynbosfreight.example accounts" <accounts@mail.fynbosfreight.example>',
      '"Thandi Mokoena" <thandi@fynbosfreight.example>',
    ])
      expect(displayAddressEvidence(from(shown)), shown).toEqual([]);
  });
});

describe("sender.display_brand", () => {
  it("flags a bank's name from a free mailbox, and Apple's name from an iCloud mailbox (its user content)", () => {
    expect(displayBrandEvidence(from('"FNB Online Banking" <alerts@freemail.example>'))[0]).toMatchObject({
      severity: "medium",
      detail: { brand: "FNB" },
    });
    expect(displayBrandEvidence(from('"Apple Support" <help@icloud.com>'))[0]).toMatchObject({
      detail: { brand: "Apple" },
    });
  });

  it("passes the brand's own domain and subdomain, and a brand name inside a longer word", () => {
    expect(displayBrandEvidence(from('"FNB" <alerts@fnb.co.za>'))).toEqual([]);
    expect(displayBrandEvidence(from('"FNB Online Banking" <alerts@secure.fnb.co.za>'))).toEqual([]);
    expect(displayBrandEvidence(from('"FNBX Logistics" <ops@freemail.example>'))).toEqual([]);
  });

  it("matches across case and NFKC forms", () => {
    expect(displayBrandEvidence(from('"ｆｎｂ online banking" <alerts@freemail.example>'))[0]).toMatchObject({
      detail: { brand: "FNB" },
    });
  });
});

describe("sender.reply_to", () => {
  it("flags an external destination wherever it sits, groups included, and passes the same domain", () => {
    const base = '"Accounts" <accounts@fynbosfreight.example>';
    expect(replyToEvidence(from(base, h("Reply-To", "pay@elsewhere.example")))[0]).toMatchObject({
      severity: "medium",
    });
    expect(replyToEvidence(from(base, h("Reply-To", "billing@fynbosfreight.example")))).toEqual([]);
    for (const list of [
      "billing@fynbosfreight.example, pay@elsewhere.example",
      "pay@elsewhere.example, billing@fynbosfreight.example",
      "Team: billing@fynbosfreight.example, pay@elsewhere.example;",
    ])
      expect(replyToEvidence(from(base, h("Reply-To", list)))[0], list).toMatchObject({
        severity: "medium",
        detail: { elsewhere: ["pay@elsewhere.example"] },
      });
  });

  it("says the comparison could not be made, never a mismatch, when the From or a destination cannot be read", () => {
    expect(replyToEvidence(from("not an address", h("Reply-To", "pay@elsewhere.example")))[0]).toMatchObject({
      severity: "info",
    });
    expect(replyToEvidence(from("a@fynbosfreight.example", h("Reply-To", "garbled@@")))[0]).toMatchObject({
      severity: "info",
    });
  });
});

describe("sender.return_path", () => {
  const base = "accounts@fynbosfreight.example";
  const path = (value: string) => returnPathEvidence(from(base, h("Return-Path", value)));

  it("says nothing for an absent or empty path, or the sender's own domain", () => {
    expect(returnPathEvidence(from(base))).toEqual([]);
    expect(path("<>")).toEqual([]);
    expect(path("<bounces@mail.fynbosfreight.example>")).toEqual([]);
  });

  it("is low for an unrelated domain and for a lookalike of a service, and quiet for each known service", () => {
    expect(path("<b@elsewhere.example>")[0]).toMatchObject({ severity: "low" });
    expect(path("<b@smtp2go.com.evil.example>")[0]).toMatchObject({ severity: "low" });
    for (const service of [
      "bounce@em123.smtp2go.com",
      "x@eur.outlook.com",
      "x@bounce.google.com",
      "bounce-mc.us1_1.123-x@mail123.mcsv.net",
    ])
      expect(path(`<${service}>`), service).toEqual([]);
  });

  it("says an unreadable path could not be compared, and reads only the topmost", () => {
    expect(path("<garbled@@>")[0]).toMatchObject({ severity: "info" });
    expect(
      returnPathEvidence(
        from(base, h("Return-Path", "<bounces@fynbosfreight.example>"), h("Return-Path", "<b@elsewhere.example>")),
      ),
    ).toEqual([]);
  });
});

describe("completion review", () => {
  it("validates mailboxes by RFC 5322 and reads a needless quote as the plain form", () => {
    expect(mailbox('"accounts"@fynbosfreight.example')).toBe(mailbox("accounts@fynbosfreight.example"));
    expect(mailbox('"pay@desk"@elsewhere.example')).toBe('"pay@desk"@elsewhere.example');
    expect(mailbox("bad..local@elsewhere.example")).toBeNull();
    const base = "accounts@fynbosfreight.example";
    expect(replyToEvidence(from(base, h("Reply-To", '"pay@desk"@elsewhere.example')))[0]).toMatchObject({
      severity: "medium",
    });
    expect(returnPathEvidence(from(base, h("Return-Path", "<bad..local@elsewhere.example>")))[0]).toMatchObject({
      severity: "info",
    });
    expect(
      displayAddressEvidence(from('"\\"accounts\\"@fynbosfreight.example" <accounts@fynbosfreight.example>')),
    ).toEqual([]);
  });

  it("trims prose punctuation from a shown address and reads an A-label top-level domain", () => {
    expect(
      displayAddressEvidence(from('"Contact accounts@fynbosfreight.example!" <accounts@fynbosfreight.example>')),
    ).toEqual([]);
    expect(
      displayAddressEvidence(from('"Pay debtors@elsewhere.example." <accounts@fynbosfreight.example>'))[0],
    ).toMatchObject({
      detail: { shown: "debtors@elsewhere.example" },
    });
    expect(displayAddressEvidence(from('"example.xn--p1ai" <x@elsewhere.example>'))[0]).toMatchObject({
      detail: { shown: "example.xn--p1ai" },
    });
  });

  it("cites the Reply-To field that holds the outside destination, in either order", () => {
    const inside = h("Reply-To", "billing@fynbosfreight.example");
    const outside = h("Reply-To", "pay@elsewhere.example");
    for (const order of [
      [inside, outside],
      [outside, inside],
    ])
      expect(replyToEvidence(from("accounts@fynbosfreight.example", ...order))[0]?.detail).toMatchObject({
        headers: ["Reply-To: pay@elsewhere.example"],
      });
  });

  it("reads an 80 KB display name in linear time and still finds the address in it", () => {
    const name = `${"word ".repeat(16_000)}debtors@fynbosfreight.example`;
    const started = performance.now();
    const [item] = displayAddressEvidence(from(`"${name}" <x@freemail.example>`));
    expect(performance.now() - started).toBeLessThan(250);
    expect(item).toMatchObject({ detail: { shown: "debtors@fynbosfreight.example" } });
  });
});

describe("round 1", () => {
  it("reads 80 KB of punctuation in linear time and still finds the address after it", () => {
    const name = `a${"!".repeat(80_000)}b debtors@fynbosfreight.example`;
    const started = performance.now();
    const [item] = displayAddressEvidence(from(`"${name}" <x@freemail.example>`));
    expect(performance.now() - started).toBeLessThan(250);
    expect(item).toMatchObject({ detail: { shown: "debtors@fynbosfreight.example" } });
  });

  it("finds an address behind a label, and keeps an apostrophe in a local part", () => {
    expect(displayAddressEvidence(from('"Email:debtors@fynbosfreight.example" <x@freemail.example>'))[0]).toMatchObject(
      {
        severity: "medium",
        detail: { shown: "debtors@fynbosfreight.example" },
      },
    );
    expect(
      displayAddressEvidence(from(`"O'Connor o'connor@fynbosfreight.example" <o'connor@fynbosfreight.example>`)),
    ).toEqual([]);
    expect(
      displayAddressEvidence(from(`"O'Connor o'connor@fynbosfreight.example" <connor@fynbosfreight.example>`))[0],
    ).toMatchObject({ detail: { shown: "o'connor@fynbosfreight.example" } });
  });

  it("reads a quoted local part, and still reads the domain when no mailbox reads (round 2)", () => {
    expect(displayAddressEvidence(from('"\\"debtors\\"@fynbosfreight.example" <x@freemail.example>'))[0]).toMatchObject(
      {
        severity: "medium",
      },
    );
    expect(
      displayAddressEvidence(from('"\\"debtors\\"@fynbosfreight.example" <accounts@fynbosfreight.example>'))[0],
    ).toMatchObject({ severity: "medium" });
    expect(displayAddressEvidence(from('"@fynbosfreight.example" <x@freemail.example>'))[0]).toMatchObject({
      detail: { shown: "fynbosfreight.example" },
    });
  });

  it("treats a brand's mail domain as its own even where its website hosts others' content on some paths", () => {
    expect(displayBrandEvidence(from('"PayPal" <service@paypal.com>'))).toEqual([]);
    expect(displayBrandEvidence(from('"PayPal" <service@freemail.example>'))[0]).toMatchObject({
      detail: { brand: "PayPal" },
    });
  });

  it("stores a Reply-To finding however large its fields", async () => {
    const registry = new CheckRegistry();
    registerSenderChecks(registry);
    const field = (n: number) =>
      h(
        "Reply-To",
        `"${"\u{10400}".repeat(2_000)}" <${"a".repeat(64)}${n}@elsewhere.example>, ${"b".repeat(64)}@elsewhere.example, ${"c".repeat(64)}@elsewhere.example`,
      );
    const items = await runChecks(
      from("accounts@fynbosfreight.example", ...Array.from({ length: 8 }, (_, n) => field(n))),
      registry,
    );
    expect(items.map((e) => e.check)).toEqual(["sender.reply_to"]);
    expect(new TextEncoder().encode(JSON.stringify(items[0]?.detail)).length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("all four", () => {
  it("say nothing when the original's headers did not come", () => {
    const none = view([h("From", '"FNB" <x@freemail.example>'), h("Reply-To", "a@b.example")], false);
    expect(
      [displayAddressEvidence, displayBrandEvidence, replyToEvidence, returnPathEvidence].flatMap((c) => c(none)),
    ).toEqual([]);
  });

  it("keep their items however hostile or long the display name", async () => {
    const registry = new CheckRegistry();
    registerSenderChecks(registry);
    const name = `FNB ${"<b>\u202e".repeat(4_000)} debtors@fynbosfreight.example`;
    const items = await runChecks(
      from(`"${name}" <x@freemail.example>`, h("Reply-To", "a@elsewhere.example")),
      registry,
    );
    expect(items.map((e) => e.check).sort()).toEqual([
      "sender.display_address",
      "sender.display_brand",
      "sender.reply_to",
    ]);
    for (const e of items) {
      expect(Array.from(e.summary).length).toBeLessThanOrEqual(200);
      expect(e.summary).not.toMatch(/[<>\u202e]/);
    }
  });

  it("run in the production registry after the authentication checks", () => {
    const names = checks.names();
    expect(names.indexOf("sender.display_address")).toBeGreaterThan(names.indexOf("auth.arc"));
  });
});
