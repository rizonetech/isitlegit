import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { registerAttachmentRiskChecks } from "../../src/checks/attachment-risk";
import { registerTypeMismatchCheck } from "../../src/checks/attachment-type";
import { bundled } from "../../src/checks/brands";
import { type CaseView, caseViewOf } from "../../src/checks/case-view";
import { registerLookalikeCheck } from "../../src/checks/domain-lookalike";
import { type EvidenceDraft, readCheckOutcomes, saveEvidence } from "../../src/checks/evidence";
import type { Expansion } from "../../src/checks/expand";
import { registerIntakeChecks } from "../../src/checks/intake";
import { registerLandingChecks, registerLinkExpansionChecks, registerLinkMismatchCheck } from "../../src/checks/links";
import { type Check, CheckRegistry } from "../../src/checks/registry";
import { runChecksWithOutcomes } from "../../src/checks/runner";
import { registerSenderChecks } from "../../src/checks/sender";
import { createCase } from "../../src/db/cases";

// D02 T01 §8: a clean check's examined set, stored with its outcome and read back; every other outcome
// stores none, and an examined empty set is never the null of a check that stored none.

const db = env.DB;

async function newCase() {
  const made = await createCase(db, { orgId: "org-examined", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

function view(
  headers: { name: string; value: string }[] = [{ name: "From", value: "billing@sender.example" }],
): CaseView {
  return caseViewOf(
    {
      headers,
      text: "Pay here: https://evil.example/phish and https://clean.example/",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    },
    { orgId: "org-examined", channel: "email", receivers: [], trusted: { own: [], suppliers: [] } },
    "cases/x/raw",
    bundled,
  );
}

async function storedView(registry: CheckRegistry, v: CaseView) {
  const caseId = await newCase();
  const { items, outcomes } = await runChecksWithOutcomes(v, registry);
  await saveEvidence(db, caseId, items, registry, undefined, outcomes);
  const read = await readCheckOutcomes(db, caseId);
  return new Map((read ?? []).map((o) => [o.check, o]));
}

const item = (check: string): EvidenceDraft => ({
  check,
  severity: "low",
  summary: `${check} found one.`,
  detail: {},
  artefacts: [],
});

const base = (name: string, over: Partial<Check>): Check => ({
  name,
  needs: [],
  timeoutMs: 1_000,
  run: () => [],
  ...over,
});

function registryOf(...list: Check[]): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of list) registry.register(check);
  return registry;
}

async function stored(registry: CheckRegistry) {
  const caseId = await newCase();
  const { items, outcomes } = await runChecksWithOutcomes(view(), registry);
  await saveEvidence(db, caseId, items, registry, undefined, outcomes);
  return { caseId, items, outcomes, read: await readCheckOutcomes(db, caseId) };
}

describe("the examined set through runner, storage and read-back", () => {
  it("stores a clean check's targets, and none for findings, partial, skipped, failed or hookless checks", async () => {
    const registry = registryOf(
      base("probe.clean", { examined: () => ["https://evil.example/phish", "https://clean.example/"] }),
      base("probe.finding", { run: (v) => [item("probe.finding")], examined: () => ["never stored"] }),
      base("probe.partial", {
        partial: () => "part of it could not be read",
        examined: () => ["never stored"],
      }),
      base("probe.skipped", { applies: () => "nothing to check", examined: () => ["never stored"] }),
      base("probe.failed", {
        run: () => {
          throw new Error("boom");
        },
        examined: () => ["never stored"],
      }),
      base("probe.hookless", {}),
      base("probe.empty", { examined: () => [] }),
    );
    const { read } = await stored(registry);
    const byName = new Map((read ?? []).map((o) => [o.check, o]));
    expect(byName.get("probe.clean")).toMatchObject({
      outcome: "ran",
      findings: 0,
      examined: { targets: ["https://evil.example/phish", "https://clean.example/"], omitted: 0 },
    });
    expect(byName.get("probe.finding")).toMatchObject({ outcome: "ran", findings: 1 });
    expect(byName.get("probe.finding")?.examined).toBeUndefined();
    expect(byName.get("probe.partial")?.examined).toBeUndefined();
    expect(byName.get("probe.skipped")?.examined).toBeUndefined();
    expect(byName.get("probe.failed")?.examined).toBeUndefined();
    expect(byName.get("probe.hookless")?.examined).toBeUndefined();
    // An examined empty set is stored, never confused with none.
    expect(byName.get("probe.empty")?.examined).toEqual({ targets: [], omitted: 0 });
  });

  it("loses only the examined set when a hook throws or returns malformed entries", async () => {
    const registry = registryOf(
      base("probe.throwing", {
        examined: () => {
          throw new Error("no targets");
        },
      }),
      base("probe.malformed", { examined: () => [42] as never }),
    );
    const { outcomes, read } = await stored(registry);
    expect(outcomes.map((o) => o.outcome)).toEqual(["ran", "ran"]);
    expect((read ?? []).every((o) => o.examined === undefined)).toBe(true);
  });

  it("bounds the set: 50 targets, 255 characters each, 8,000 bytes of JSON, omissions counted", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `target-${i}`);
    const registry = registryOf(
      base("probe.many", { examined: () => many }),
      base("probe.long", { examined: () => [`${"a".repeat(300)}`, "short"] }),
      base("probe.wide", { examined: () => Array.from({ length: 50 }, (_, i) => `t${i}-${"b".repeat(240)}`) }),
    );
    const { read } = await stored(registry);
    const byName = new Map((read ?? []).map((o) => [o.check, o]));
    expect(byName.get("probe.many")?.examined?.targets).toHaveLength(50);
    expect(byName.get("probe.many")?.examined?.omitted).toBe(10);
    expect(byName.get("probe.long")?.examined?.targets[0]).toHaveLength(255);
    expect(byName.get("probe.long")?.examined?.targets[0]?.endsWith("…")).toBe(true);
    const wide = byName.get("probe.wide")?.examined;
    expect(wide).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(wide)).length).toBeLessThanOrEqual(8_000);
    expect((wide?.targets.length ?? 0) + (wide?.omitted ?? 0)).toBe(50);
  });

  it("crosses the seven-row outcome batch boundary with every set read back", async () => {
    const list = Array.from({ length: 10 }, (_, i) => base(`probe.n${i}`, { examined: () => [`target-${i}`] }));
    const { read } = await stored(registryOf(...list));
    expect(read).toHaveLength(10);
    for (const [i, outcome] of (read ?? []).entries())
      expect(outcome.examined).toEqual({ targets: [`target-${i}`], omitted: 0 });
  });

  it("reads a legacy null and a malformed column as none stored, never as an empty set", async () => {
    const registry = registryOf(base("probe.clean", { examined: () => ["one"] }));
    const { caseId, read } = await stored(registry);
    expect(read?.[0]?.examined).toEqual({ targets: ["one"], omitted: 0 });
    await db.prepare("UPDATE check_outcomes SET examined = NULL WHERE case_id = ?").bind(caseId).run();
    expect((await readCheckOutcomes(db, caseId))?.[0]?.examined).toBeUndefined();
    await db.prepare("UPDATE check_outcomes SET examined = 'not json' WHERE case_id = ?").bind(caseId).run();
    expect((await readCheckOutcomes(db, caseId))?.[0]?.examined).toBeUndefined();
    await db
      .prepare("UPDATE check_outcomes SET examined = ? WHERE case_id = ?")
      .bind(JSON.stringify({ targets: [1], omitted: 0 }), caseId)
      .run();
    expect((await readCheckOutcomes(db, caseId))?.[0]?.examined).toBeUndefined();
    // A stored set past any bound of the contract reads as none stored (completion review).
    for (const bad of [
      JSON.stringify({ targets: Array.from({ length: 51 }, (_, i) => `t${i}`), omitted: 0 }),
      JSON.stringify({ targets: ["a".repeat(256)], omitted: 0 }),
      JSON.stringify({ targets: Array.from({ length: 40 }, () => "b".repeat(250)), omitted: 0 }),
    ]) {
      await db.prepare("UPDATE check_outcomes SET examined = ? WHERE case_id = ?").bind(bad, caseId).run();
      expect((await readCheckOutcomes(db, caseId))?.[0]?.examined, bad.slice(0, 40)).toBeUndefined();
    }
  });
});

// The registry audit of D02 T01 §8, recorded in the section: 17 checks can list their targets from the
// view and return nothing when clean; each is proven here through runner, storage and read-back. The
// other 21 always report, skip instead of running clean, or examine nothing enumerable from the view.
describe("every audited producer's examined set", () => {
  it("intake.truncated: an uncut message examined no cut parts", async () => {
    const registry = new CheckRegistry();
    registerIntakeChecks(registry);
    const byName = await storedView(registry, view());
    expect(byName.get("intake.truncated")).toMatchObject({ outcome: "ran", examined: { targets: [], omitted: 0 } });
    // Contrasting: a cut part is a finding, so no examined set is stored for it.
    const cut = view();
    cut.truncated = [
      { mediaType: "text/html", charset: "utf-8", fullBytes: 90_000, keptBytes: 10_000, key: "cases/x/part" },
    ] as CaseView["truncated"];
    const byCut = await storedView(registry, cut);
    expect(byCut.get("intake.truncated")).toMatchObject({ outcome: "ran", findings: 1 });
    expect(byCut.get("intake.truncated")?.examined).toBeUndefined();
  });

  it("the sender checks: the From mailbox and domain, and the reply and bounce addresses", async () => {
    const registry = new CheckRegistry();
    registerSenderChecks(registry);
    const v = view([
      { name: "From", value: "Billing Team <billing@sender.example>" },
      { name: "Reply-To", value: "billing@sender.example" },
      { name: "Return-Path", value: "<billing@sender.example>" },
    ]);
    v.senderHistory = "seen";
    const byName = await storedView(registry, v);
    expect(byName.get("sender.display_address")?.examined).toEqual({ targets: ["billing@sender.example"], omitted: 0 });
    expect(byName.get("sender.display_brand")?.examined).toEqual({ targets: ["sender.example"], omitted: 0 });
    expect(byName.get("sender.reply_to")?.examined).toEqual({ targets: ["billing@sender.example"], omitted: 0 });
    expect(byName.get("sender.return_path")?.examined).toEqual({ targets: ["<billing@sender.example>"], omitted: 0 });
    expect(byName.get("sender.first_time")?.examined).toEqual({ targets: ["billing@sender.example"], omitted: 0 });
    // Contrasting: grouped Reply-To destinations are counted one by one, and only the topmost
    // Return-Path is a target (completion review).
    const other = view([
      { name: "From", value: "Shop <shop@other.example>" },
      { name: "Reply-To", value: "one@other.example, two@other.example" },
      { name: "Return-Path", value: "<shop@other.example>" },
      { name: "Return-Path", value: "<evil@elsewhere.example>" },
    ]);
    other.senderHistory = "seen";
    const byOther = await storedView(registry, other);
    expect(byOther.get("sender.display_address")?.examined).toEqual({ targets: ["shop@other.example"], omitted: 0 });
    expect(byOther.get("sender.display_brand")?.examined).toEqual({ targets: ["other.example"], omitted: 0 });
    expect(byOther.get("sender.reply_to")?.examined).toEqual({
      targets: ["one@other.example", "two@other.example"],
      omitted: 0,
    });
    expect(byOther.get("sender.return_path")?.examined).toEqual({ targets: ["<shop@other.example>"], omitted: 0 });
    expect(byOther.get("sender.first_time")?.examined).toEqual({ targets: ["shop@other.example"], omitted: 0 });
  });

  it("domain.lookalike: the header and link domains compared", async () => {
    const registry = new CheckRegistry();
    registerLookalikeCheck(registry);
    const byName = await storedView(registry, view());
    expect(byName.get("domain.lookalike")).toMatchObject({ outcome: "ran", findings: 0 });
    expect(byName.get("domain.lookalike")?.examined).toEqual({ targets: ["sender.example"], omitted: 0 });
    // Contrasting: a link's domain joins the compared set.
    const withLink = view();
    withLink.links = {
      items: [
        {
          raw: "https://clean.example/x",
          href: "https://clean.example/x",
          host: "clean.example",
          display: "clean.example",
          kind: "text",
          part: "summary",
          anchor: "clean.example",
        },
      ],
      more: 0,
      unread: [],
    };
    withLink.expansions = {
      items: [
        {
          link: "https://clean.example/x",
          outcome: "done",
          reason: null,
          hops: [],
          final: "https://clean.example/x",
          finalHost: "clean.example",
          landing: null,
          downloads: [],
          refused: [],
          ms: 1,
        },
      ],
      skipped: [],
    };
    const byLink = await storedView(registry, withLink);
    expect(byLink.get("domain.lookalike")).toMatchObject({ outcome: "ran", findings: 0 });
    expect(byLink.get("domain.lookalike")?.examined).toEqual({
      targets: ["sender.example", "clean.example"],
      omitted: 0,
    });
  });

  it("attachment.type_mismatch: each attachment compared with its name", async () => {
    const registry = new CheckRegistry();
    registerTypeMismatchCheck(registry);
    const v = view();
    v.attachments = [{ key: "att1", filename: "invoice.pdf", mediaType: "application/pdf" }] as CaseView["attachments"];
    v.attachmentHeads = {
      heads: [{ key: "att1", head: btoa("%PDF-1.7") }],
      unread: 0,
    };
    const byName = await storedView(registry, v);
    expect(byName.get("attachment.type_mismatch")).toMatchObject({ outcome: "ran", findings: 0 });
    expect(byName.get("attachment.type_mismatch")?.examined).toEqual({ targets: ["invoice.pdf"], omitted: 0 });
    // Contrasting: a second attachment is a second target.
    v.attachments = [
      { key: "att1", filename: "invoice.pdf", mediaType: "application/pdf" },
      { key: "att2", filename: "letter.pdf", mediaType: "application/pdf" },
    ] as CaseView["attachments"];
    v.attachmentHeads = {
      heads: [
        { key: "att1", head: btoa("%PDF-1.7") },
        { key: "att2", head: btoa("%PDF-1.7") },
      ],
      unread: 0,
    };
    const byTwo = await storedView(registry, v);
    expect(byTwo.get("attachment.type_mismatch")?.examined).toEqual({
      targets: ["invoice.pdf", "letter.pdf"],
      omitted: 0,
    });
  });

  it("the attachment risk checks: each attachment read for macros, encryption and programs", async () => {
    const registry = new CheckRegistry();
    registerAttachmentRiskChecks(registry);
    const v = view();
    v.attachmentRisks = {
      items: [{ key: "att1", filename: "invoice.pdf", findings: [], notChecked: null, nested: [] }],
      unread: 0,
    };
    const byName = await storedView(registry, v);
    for (const name of ["attachment.macro", "attachment.encrypted_archive", "attachment.executable"]) {
      expect(byName.get(name), name).toMatchObject({ outcome: "ran", findings: 0 });
      expect(byName.get(name)?.examined, name).toEqual({ targets: ["invoice.pdf"], omitted: 0 });
    }
    // Contrasting: a second attachment is a second target for each of the three.
    v.attachmentRisks = {
      items: [
        { key: "att1", filename: "invoice.pdf", findings: [], notChecked: null, nested: [] },
        { key: "att2", filename: "letter.txt", findings: [], notChecked: null, nested: [] },
      ],
      unread: 0,
    };
    const byTwo = await storedView(registry, v);
    for (const name of ["attachment.macro", "attachment.encrypted_archive", "attachment.executable"])
      expect(byTwo.get(name)?.examined, name).toEqual({ targets: ["invoice.pdf", "letter.txt"], omitted: 0 });
  });

  it("the link checks: each link, followed page and landing page read", async () => {
    const registry = new CheckRegistry();
    registerLinkMismatchCheck(registry);
    registerLinkExpansionChecks(registry);
    registerLandingChecks(registry);
    const v = view();
    const link = {
      raw: "https://sender.example/pay",
      href: "https://sender.example/pay",
      host: "sender.example",
      display: "sender.example",
      kind: "text" as const,
      part: "summary",
      anchor: "sender.example",
    };
    v.links = { items: [link], more: 0, unread: [] };
    const expansion: Expansion = {
      link: "https://sender.example/pay",
      outcome: "done",
      reason: null,
      hops: [],
      final: "https://sender.example/pay",
      finalHost: "sender.example",
      landing: {
        shot: null,
        shotKey: null,
        scans: [
          {
            url: "https://sender.example/pay",
            frame: false,
            loosePasswordFields: 0,
            looseCardFields: 0,
            forms: [],
            formsTotal: 0,
            formsCut: false,
            shadowRoots: 0,
            shadowCut: false,
            text: "",
            textCut: false,
            hidden: "",
            hiddenCut: false,
            lures: [],
            luresCut: false,
          },
          {
            url: "https://frame.example/widget",
            frame: true,
            loosePasswordFields: 0,
            looseCardFields: 0,
            forms: [],
            formsTotal: 0,
            formsCut: false,
            shadowRoots: 0,
            shadowCut: false,
            text: "",
            textCut: false,
            hidden: "",
            hiddenCut: false,
            lures: [],
            luresCut: false,
          },
        ],
        coverage: { shot: "taken", scan: "ok", framesTotal: 2, framesRead: 2, closedShadows: 0 },
      },
      downloads: [],
      refused: [],
      ms: 1,
    };
    v.expansions = { items: [expansion], skipped: [] };
    const byName = await storedView(registry, v);
    expect(byName.get("link.text_mismatch")?.examined).toEqual({ targets: ["https://sender.example/pay"], omitted: 0 });
    for (const name of ["link.redirects", "link.final_domain_changed"]) {
      expect(byName.get(name), name).toMatchObject({ outcome: "ran", findings: 0 });
      expect(byName.get(name)?.examined, name).toEqual({ targets: ["https://sender.example/pay"], omitted: 0 });
    }
    // The landing checks read every scan, the frame's page included (round 1).
    for (const name of ["link.credential_form", "link.card_form", "link.lure_button"]) {
      expect(byName.get(name), name).toMatchObject({ outcome: "ran", findings: 0 });
      expect(byName.get(name)?.examined, name).toEqual({
        targets: ["https://sender.example/pay", "https://frame.example/widget"],
        omitted: 0,
      });
    }
    // Contrasting: a second link and followed page are second targets, its landing from its own scan.
    const second = {
      ...link,
      raw: "https://sender.example/about",
      href: "https://sender.example/about",
      anchor: "sender.example",
    };
    v.links = { items: [link, second], more: 0, unread: [] };
    const scan = expansion.landing?.scans[0];
    if (!scan || !expansion.landing) throw new Error("fixture landing missing");
    const secondExpansion: Expansion = {
      ...expansion,
      link: second.href,
      final: second.href,
      landing: { ...expansion.landing, scans: [{ ...scan, url: second.href }] },
    };
    v.expansions = { items: [expansion, secondExpansion], skipped: [] };
    const byTwo = await storedView(registry, v);
    const both = { targets: ["https://sender.example/pay", "https://sender.example/about"], omitted: 0 };
    expect(byTwo.get("link.text_mismatch")?.examined).toEqual(both);
    for (const name of ["link.redirects", "link.final_domain_changed"])
      expect(byTwo.get(name)?.examined, name).toEqual(both);
    for (const name of ["link.credential_form", "link.card_form", "link.lure_button"])
      expect(byTwo.get(name)?.examined, name).toEqual({
        targets: ["https://sender.example/pay", "https://frame.example/widget", "https://sender.example/about"],
        omitted: 0,
      });
  });
});
