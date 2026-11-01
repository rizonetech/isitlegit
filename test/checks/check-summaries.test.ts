import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Receiver } from "../../src/auth/receivers";
import { bundled } from "../../src/checks/brands";
import type { CaseView } from "../../src/checks/case-view";
import { type EvidenceDraft, readCheckOutcomes, saveEvidence } from "../../src/checks/evidence";
import { checks } from "../../src/checks/index";
import type { Link } from "../../src/checks/links";
import { runChecksWithOutcomes } from "../../src/checks/runner";
import { createCase } from "../../src/db/cases";
import { parsedKey, putAttachment, putParsed, putRaw, type Store } from "../../src/intake/store";
import { checks as checksStep } from "../../src/pipeline/analysis-workflow";

// D02 T01 §7: what each registered check says it saw, without its label (the report draws "<check words>: <summary>"),
// exact for contrasting inputs, so a summary that says the same thing whatever it saw fails.
const GOOGLE: Receiver[] = [{ kind: "google", pattern: "*.google.com" }];
const h = (name: string, value: string) => ({ name, value });
function view(over: Partial<CaseView> = {}): CaseView {
  return {
    tenant: {
      orgId: "org-summaries",
      channel: "email",
      receivers: GOOGLE,
      headersAvailable: true,
      trusted: { own: [], suppliers: [] },
    },
    raw: "raw/case-summaries/message.eml",
    brands: bundled,
    senderHistory: null,
    domainAges: null,
    attachmentHeads: null,
    hiddenText: null,
    htmlAttachments: null,
    attachmentRisks: null,
    instructions: null,
    invisibleText: null,
    links: null,
    source: { kind: "message", path: "rfc822", otherOriginals: 0 },
    headers: [h("From", "Billing <billing@fynbosfreight.example>")],
    text: null,
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
    ...over,
  };
}
const summaryOf = (name: string) => {
  const check = checks.all().find((c) => c.name === name);
  if (!check?.summary) throw new Error(`${name} has no summary`);
  return check.summary;
};
const say = (name: string, v: CaseView, items: EvidenceDraft[] = []) => summaryOf(name)(v, items);
const finding = (check: string, severity: EvidenceDraft["severity"] = "low", detail = {}): EvidenceDraft => ({
  check,
  severity,
  summary: "found",
  detail,
  artefacts: [],
});
const link = (host: string): Link => ({
  raw: `https://${host}/pay`,
  href: `https://${host}/pay`,
  host,
  display: host,
  kind: "href",
  part: "summary",
  anchor: "Pay here",
});
// Mail as Gmail delivers it, its verdict trusted through GOOGLE.
const viaGoogle = (results: string) => [
  h("Received", "from mail.fynbosfreight.example ([203.0.113.7]) by mx.google.com with ESMTPS id z"),
  h("Authentication-Results", `mx.google.com; ${results}`),
  h("From", "Billing <billing@fynbosfreight.example>"),
];

describe("every registered check", () => {
  it("has a summary", () => {
    expect(
      checks
        .all()
        .filter((c) => typeof c.summary !== "function")
        .map((c) => c.name),
    ).toEqual([]);
  });
});

describe("the links summary", () => {
  it("counts the links and names their registrable domains, fitted to 120 characters", () => {
    // A body without links is skipped with its reason, so no summary is stored for it.
    const links = checks.all().find((c) => c.name === "link.text_mismatch");
    expect(links?.applies?.(view())).toBe("the case has no links");
    expect(say("link.text_mismatch", view())).toBeNull();
    expect(
      say("link.text_mismatch", view({ links: { items: [link("fynbosfreight.example")], more: 0, unread: [] } })),
    ).toBe("1, to fynbosfreight.example");
    const five = ["a.example", "www.b.example", "c.example", "d.example", "e.example"].map(link);
    expect(say("link.text_mismatch", view({ links: { items: five, more: 0, unread: [] } }))).toBe(
      "5, to a.example, b.example, c.example, d.example, e.example",
    );
    const long = Array.from({ length: 4 }, (_, i) => link(`${String.fromCharCode(97 + i).repeat(40)}.example`));
    const fitted = say("link.text_mismatch", view({ links: { items: long, more: 0, unread: [] } }));
    expect(fitted).toBe(`4, to ${"a".repeat(40)}.example, ${"b".repeat(40)}.example and 2 more`);
    expect(Array.from(fitted ?? "").length).toBeLessThanOrEqual(120);
    // One registrable domain longer than the space: a 63-character label under an unlisted 60-character top-level domain.
    const huge = [link(`${"x".repeat(63)}.${"y".repeat(60)}`)];
    expect(say("link.text_mismatch", view({ links: { items: huge, more: 0, unread: [] } }))).toBe("1, to 1 domain");
  });
});

describe("the sender summaries", () => {
  it("says whether the sender was seen before", () => {
    expect(say("sender.first_time", view({ senderHistory: "seen" }))).toBe("no, seen before");
    expect(say("sender.first_time", view({ senderHistory: "first" }))).toBe("yes");
  });

  it("says where replies and bounces go", () => {
    expect(say("sender.reply_to", view())).toBe("replies go to the sender");
    const replyTo = view({ headers: [...view().headers, h("Reply-To", "accounts@fynbosfreight.example")] });
    expect(say("sender.reply_to", replyTo)).toBe("replies go to the sender's domain");
    expect(say("sender.reply_to", replyTo, [finding("sender.reply_to", "medium")])).toBe(
      "replies go to another domain",
    );
    expect(say("sender.reply_to", replyTo, [finding("sender.reply_to", "info")])).toBe(
      "where replies go could not be compared",
    );
    expect(say("sender.return_path", view())).toBe("no bounce address was given");
    const bounce = view({ headers: [...view().headers, h("Return-Path", "<bounce@fynbosfreight.example>")] });
    expect(say("sender.return_path", bounce)).toBe("bounces go to the sender's domain or its mail service");
    expect(say("sender.return_path", bounce, [finding("sender.return_path")])).toBe("bounces go to another domain");
  });

  it("says what the sender's name shows", () => {
    expect(say("sender.display_address", view())).toBe("its name shows no other address");
    expect(say("sender.display_address", view(), [finding("sender.display_address")])).toBe(
      "its name shows another address",
    );
    expect(say("sender.display_brand", view())).toBe("its name names no other brand");
    expect(say("sender.display_brand", view(), [finding("sender.display_brand")])).toBe(
      "its name names a brand its address does not",
    );
  });
});

describe("the domain summaries", () => {
  it("dates the youngest domain read", () => {
    const known = (registered: string) => ({ state: "known" as const, registered, server: "rdap.example" });
    const ages = (list: { domain: string; registered: string | null }[]) =>
      view({
        domainAges: {
          checkedAt: "2026-11-01T00:00:00Z",
          ages: list.map(({ domain, registered }) => ({
            domain,
            fields: ["from"],
            age: registered ? known(registered) : { state: "unknown" as const, reason: "no-date" as const },
          })),
          unread: [],
        },
      });
    expect(say("domain.age", ages([{ domain: "fynbosfreight.example", registered: "2023-06-01T00:00:00Z" }]))).toBe(
      "1 domain, registered 3 years ago",
    );
    expect(
      say(
        "domain.age",
        ages([
          { domain: "fynbosfreight.example", registered: "2019-01-01T00:00:00Z" },
          { domain: "fynbos-pay.example", registered: "2026-10-25T00:00:00Z" },
        ]),
      ),
    ).toBe("2 domains, the youngest registered 7 days ago");
    expect(say("domain.age", ages([{ domain: "fynbosfreight.example", registered: null }]))).toBe(
      "1 domain, no registration date read",
    );
  });

  it("counts lookalikes", () => {
    expect(say("domain.lookalike", view())).toBe("no lookalike of a known name");
    expect(say("domain.lookalike", view(), [finding("domain.lookalike"), finding("domain.lookalike")])).toBe(
      "2 lookalike domains",
    );
  });
});

describe("the authentication summaries", () => {
  it("says each result and the domain it is for, a pass and a fail", async () => {
    const pass = await runChecksWithOutcomes(
      view({
        headers: viaGoogle(
          "spf=pass smtp.mailfrom=fynbosfreight.example; dkim=pass header.d=fynbosfreight.example; dmarc=pass header.from=fynbosfreight.example",
        ),
      }),
    );
    const fail = await runChecksWithOutcomes(
      view({
        headers: viaGoogle(
          "spf=fail smtp.mailfrom=fynbos-pay.example; dkim=fail header.d=fynbos-pay.example; dmarc=fail header.from=fynbosfreight.example",
        ),
      }),
    );
    const of = (run: typeof pass, name: string) => run.outcomes.find((o) => o.check === name)?.summary;
    expect(of(pass, "auth.spf")).toBe("passed for fynbosfreight.example");
    expect(of(fail, "auth.spf")).toBe("failed for fynbos-pay.example");
    expect(of(pass, "auth.dkim")).toBe("passed for fynbosfreight.example");
    expect(of(fail, "auth.dkim")).toBe("failed for fynbos-pay.example");
    expect(of(pass, "auth.dmarc")?.startsWith("passed")).toBe(true);
    expect(of(fail, "auth.dmarc")?.startsWith("failed")).toBe(true);
    expect(of(pass, "auth.alignment")).toBe("aligned by SPF and DKIM");
    expect(of(fail, "auth.alignment")).toBe("not aligned by a passing result");
    expect(of(pass, "auth.results")).toBe("read from a receiving system this service trusts");
  });

  it("says a message with no ARC set has none, through the runner, storage and read-back", async () => {
    const made = await createCase(env.DB, { orgId: "org-summaries", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const run = await runChecksWithOutcomes(
      view({ headers: viaGoogle("arc=none; spf=pass smtp.mailfrom=fynbosfreight.example") }),
    );
    expect(run.items.filter((i) => i.check === "auth.arc")).toEqual([]);
    await saveEvidence(env.DB, made.value.id, run.items, checks, undefined, run.outcomes);
    const stored = (await readCheckOutcomes(env.DB, made.value.id))?.find((o) => o.check === "auth.arc");
    expect(stored).toEqual({ check: "auth.arc", outcome: "ran", reason: null, findings: 0, summary: "no ARC set" });
  });
});

describe("the attachment, content and intake summaries", () => {
  it("counts what was read and what was found", () => {
    const two = view({
      attachments: [
        {
          key: "a/1",
          filename: "a.pdf",
          mediaType: "application/pdf",
          contentId: null,
          disposition: "attachment",
          charset: null,
          bytes: 10,
        },
        {
          key: "a/2",
          filename: "b.pdf",
          mediaType: "application/pdf",
          contentId: null,
          disposition: "attachment",
          charset: null,
          bytes: 10,
        },
      ],
    });
    expect(say("attachment.macro", two)).toBe("2 read, none with macros");
    expect(say("attachment.macro", two, [finding("attachment.macro")])).toBe("1 of 2 with macros");
    expect(say("attachment.executable", two)).toBe("2 read, none executable");
    expect(say("attachment.encrypted_archive", two, [finding("attachment.encrypted_archive")])).toBe(
      "1 of 2 encrypted",
    );
    expect(say("attachment.type_mismatch", two)).toBe("2 read, each the type its name says");
    expect(say("attachment.type_mismatch", two, [finding("attachment.type_mismatch")])).toBe(
      "1 of 2 not the type their names say",
    );
    expect(say("content.ai_instructions", view())).toBe("none found");
    expect(say("content.ai_instructions", view(), [finding("content.ai_instructions", "high")])).toBe(
      "1 instruction to an AI found",
    );
    expect(say("content.hidden_text", view())).toBe("none found");
    expect(
      say("content.hidden_text", view(), [
        finding("content.hidden_text", "high", { reason: "invisible-characters" }),
        finding("content.hidden_text", "medium", { reason: "hidden-css" }),
      ]),
    ).toBe("2 hidden passages");
    expect(say("intake.forward", view())).toBe("the original's headers were read");
    expect(say("intake.truncated", view())).toBe("read whole");
    expect(say("intake.truncated", view(), [finding("intake.truncated")])).toBe(
      "part of the message was not read whole",
    );
  });
});

describe("what the summaries carry", () => {
  it("holds nothing of the message beyond what each check's card shows", async () => {
    const MARK = "ZQXMARK";
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const made = await createCase(env.DB, { orgId: "org-summaries", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nHi.\r\n"));
    const stored = await putAttachment(
      store,
      id,
      `${MARK}-invoice.pdf`,
      new TextEncoder().encode("%PDF-1.7\n"),
      "application/pdf",
    );
    await putParsed(store, id, {
      headers: [
        h("From", `${MARK} Billing <billing@fynbosfreight.example>`),
        h("Subject", `${MARK} invoice 42`),
        h("Reply-To", `${MARK} <accounts@fynbosfreight.example>`),
      ],
      text: `Dear ${MARK}, see https://fynbosfreight.example/pay?ref=${MARK}`,
      html: `<p>${MARK} <a href="https://fynbosfreight.example/pay">${MARK} pay here</a></p>`,
      attachments: [
        {
          key: stored.key,
          filename: `${MARK}-invoice.pdf`,
          mediaType: "application/pdf",
          contentId: null,
          disposition: "attachment",
          charset: null,
          bytes: stored.bytes,
        },
      ],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await checksStep(store, id, parsedKey(id), { orgId: "org-summaries", channel: "email" }, async () => []);
    const outcomes = (await readCheckOutcomes(env.DB, id)) ?? [];
    const summaries = outcomes.flatMap((o) => (o.summary ? [o.summary] : []));
    expect(summaries.length).toBeGreaterThan(5);
    expect(summaries.filter((s) => s.toUpperCase().includes(MARK))).toEqual([]);
    // The text's link and the HTML's, both on one domain.
    expect(outcomes.find((o) => o.check === "link.text_mismatch")?.summary).toBe("2, to fynbosfreight.example");
  });
});
