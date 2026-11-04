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
    expansions: null,
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
    expect(say("domain.lookalike", view())).toBe("no lookalike among 1 domain, from fynbosfreight.example");
    expect(say("domain.lookalike", view({ headers: [] }))).toBe("no lookalike of a known name");
    expect(say("domain.lookalike", view(), [finding("domain.lookalike"), finding("domain.lookalike")])).toBe(
      "2 lookalike domains",
    );
    // A note that a domain was not compared is no lookalike; an overflow card counts what it stands for (round 1).
    const notCompared = finding("domain.lookalike", "info", { compared: false });
    expect(say("domain.lookalike", view(), [notCompared])).toBe(
      "no lookalike among 1 domain compared, from fynbosfreight.example, some not compared",
    );
    expect(say("domain.lookalike", view({ headers: [] }), [notCompared])).toBe(
      "no lookalike among the domains compared, some not compared",
    );
    const kept = Array.from({ length: 20 }, () => finding("domain.lookalike", "high", { domain: "x.example" }));
    expect(say("domain.lookalike", view(), [...kept, finding("domain.lookalike", "high", { more: 10 })])).toBe(
      "30 lookalike domains",
    );
  });

  it("counts lookalikes the check finds, through the runner (round 1)", async () => {
    const trusted = view({
      tenant: { ...view().tenant, trusted: { own: ["fynbosfreight.co.za"], suppliers: [] } },
      headers: [
        h("From", "x@\u05d0\u05d1\u05d2\u05d3.co.za"),
        ...Array.from({ length: 30 }, (_, n) => h("Reply-To", `a@fynbosfreight${n}.co.za`)),
      ],
    });
    const run = await runChecksWithOutcomes(trusted);
    const outcome = run.outcomes.find((o) => o.check === "domain.lookalike");
    // Twenty listed, ten on the overflow card; the right-to-left From not compared.
    expect(outcome?.summary).toBe("30 lookalike domains, some domains not compared");
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
    expect(of(pass, "auth.dmarc")).toBe("passed for fynbosfreight.example");
    expect(of(fail, "auth.dmarc")).toBe("failed for fynbosfreight.example");
    expect(of(pass, "auth.alignment")).toBe("aligned by SPF and DKIM");
    expect(of(fail, "auth.alignment")).toBe("not aligned by a passing result");
    expect(of(pass, "auth.results")).toBe("read from a receiving system this service trusts");
  });

  it("keeps each domain under its own result, through storage and read-back (completion review)", async () => {
    const made = await createCase(env.DB, { orgId: "org-summaries", channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const run = await runChecksWithOutcomes(
      view({
        headers: viaGoogle(
          "spf=pass smtp.mailfrom=a.example; dkim=pass header.d=a.example; dkim=fail header.d=b.example",
        ),
      }),
    );
    await saveEvidence(env.DB, made.value.id, run.items, checks, undefined, run.outcomes);
    const read = await readCheckOutcomes(env.DB, made.value.id);
    expect(read?.find((o) => o.check === "auth.dkim")?.summary).toBe("passed for a.example and failed for b.example");
    expect(read?.find((o) => o.check === "auth.spf")?.summary).toBe("passed for a.example");
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
    const file = (key: string, filename: string) => ({
      key,
      filename,
      mediaType: "application/pdf",
      contentId: null,
      disposition: "attachment" as const,
      charset: null,
      bytes: 10,
    });
    const risk = (key: string, filename: string) => ({ key, filename, findings: [], notChecked: null, nested: [] });
    const two = view({
      attachments: [file("a/1", "a.pdf"), file("a/2", "b.pdf")],
      attachmentRisks: { items: [risk("a/1", "a.pdf"), risk("a/2", "b.pdf")], unread: 0 },
    });
    expect(say("attachment.macro", two)).toBe("2 read, none with macros");
    expect(say("attachment.macro", two, [finding("attachment.macro")])).toBe("1 of 2 with macros");
    expect(say("attachment.executable", two)).toBe("2 read, none executable");
    expect(say("attachment.encrypted_archive", two, [finding("attachment.encrypted_archive")])).toBe(
      "1 of 2 encrypted",
    );
    expect(say("attachment.type_mismatch", two)).toBe("2 files read, each what it claims to be");
    expect(say("attachment.type_mismatch", two, [finding("attachment.type_mismatch")])).toBe(
      "1 of 2 not what they claim to be",
    );
    expect(say("content.hidden_text", view())).toBe("none found");
    expect(say("intake.forward", view())).toBe("the original's headers were read");
    expect(say("intake.truncated", view())).toBe("read whole");
    expect(say("intake.truncated", view(), [finding("intake.truncated")])).toBe(
      "part of the message was not read whole",
    );
  });

  it("counts an uploaded file as the one it compares, a declared type's mismatch included (completion review)", () => {
    const upload = view({
      source: {
        kind: "upload",
        fileKind: "document",
        mediaType: "application/pdf",
        key: "u/1",
        bytes: 10,
        claimed: { name: "invoice.pdf", mediaType: "application/pdf" },
      },
      attachmentRisks: {
        items: [{ key: "u/1", filename: "invoice.pdf", findings: [], notChecked: null, nested: [] }],
        unread: 0,
      },
    });
    expect(say("attachment.type_mismatch", upload)).toBe("1 file read, each what it claims to be");
    const byType = finding("attachment.type_mismatch", "high", { claims: ["media type"] });
    expect(say("attachment.type_mismatch", upload, [byType])).toBe("1 of 1 not what it claims to be");
    expect(say("attachment.macro", upload)).toBe("1 read, none with macros");
  });

  it("counts every detection an overflow card stands for, through the runner (completion review)", async () => {
    const match = (n: number) => ({
      pattern: "ignore-instructions",
      quote: `ignore previous instructions ${n}`,
      location: "text",
    });
    const run = await runChecksWithOutcomes(
      view({
        text: "Hello.",
        instructions: {
          texts: 1,
          matches: Array.from({ length: 20 }, (_, n) => match(n)),
          more: 10,
          notChecked: [],
          notCheckedMore: 0,
        },
      }),
    );
    const ai = run.outcomes.find((o) => o.check === "content.ai_instructions");
    expect(ai?.summary ?? ai?.reason).toBe("30 instructions to an AI found");
    expect(say("content.ai_instructions", view())).toBe("none found");
    // A text it could not read is no detection (and makes the outcome partial, so no summary is stored for it).
    expect(
      say("content.ai_instructions", view(), [
        finding("content.ai_instructions", "high"),
        finding("content.ai_instructions", "info"),
      ]),
    ).toBe("1 instruction to an AI found");
    const passages = [
      ...Array.from({ length: 20 }, () => finding("content.hidden_text", "high", { reason: "invisible-characters" })),
      finding("content.hidden_text", "high", { reason: "invisible-characters", more: 10 }),
      finding("content.hidden_text", "medium", { more: 3, byReason: {}, omitted: 0 }),
    ];
    expect(say("content.hidden_text", view(), passages)).toBe("33 hidden passages");
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
