import { env } from "cloudflare:test";
import { jsx } from "hono/jsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { bankChangeAction, callBackAction, POP_ACTION } from "../../src/invoice/fixed-actions";
import { confidenceWords, type ReportVerdict } from "../../src/web/pages/report-verdict";
import { ReportDocument, type ReportEvidence } from "../../src/web/pages/report-view";
import { call, signIn } from "../auth/helpers";
import { putStoredVerdict } from "./stored-verdict";

// The report's verdict section (D07 T03 §2): the band in words, then what to do now, then why we say so; every reason's
// pill names a card the page holds; a fixed action or a voice note leads "Do this first".
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

const EVIDENCE: ReportEvidence[] = [
  {
    id: "E2",
    severity: "high",
    summary: "Hidden white text tells AI scanners the email is safe.",
    check: "sender.first_time",
    detail: {},
    artefacts: [],
  },
  {
    id: "E4",
    severity: "critical",
    summary: "A lookalike registered 3 days ago.",
    check: "sender.first_time",
    detail: {},
    artefacts: [],
  },
  {
    id: "E7",
    severity: "critical",
    summary: "The login page sends passwords elsewhere.",
    check: "sender.first_time",
    detail: {},
    artefacts: [],
  },
  { id: "E9", severity: "low", summary: "A first-time sender.", check: "sender.first_time", detail: {}, artefacts: [] },
];
const MAIN: ReportVerdict = {
  verdict: "malicious",
  headline: "This is a password-phishing email pretending to be NimbusMail.",
  confidence: 0.93,
  reasons: [
    { text: "The login page sends passwords to collect.nimbus-sync.example, not NimbusMail.", evidenceIds: ["E7"] },
    {
      text: "The link goes to nimbusmai1-login.example, a lookalike registered 3 days ago.",
      evidenceIds: ["E4", "E7"],
    },
    { text: "Hidden white text tells AI scanners the email is safe.", evidenceIds: ["E2"] },
    { text: "A fourth reason is never drawn.", evidenceIds: ["E9"] },
  ],
  actions: [
    "Do not click the link or open the attachment.",
    "If anyone typed a password on that page, change it now and sign out of all sessions.",
    "Delete the email and warn your team.",
    "A fourth action is never drawn.",
  ],
};
const draw = (verdict: ReportVerdict, sourceKind: "mail" | "audio" | "document" = "mail", status = "done" as const) =>
  String(
    jsx(ReportDocument, {
      stored: {
        id: "01JCASE0000000000000000000",
        status,
        verdict: verdict.verdict,
        sourceKind,
        createdAt: "2026-10-27T08:12:00Z",
      },
      verdict,
      evidence: EVIDENCE,
      shell: null,
      linkExpires: 1_800_000_000,
    }),
  );
const section = (html: string, heading: string) => {
  const at = html.indexOf(`>${heading}</h2>`);
  expect(at, heading).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</section>", at));
};
const ids = (html: string) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const pills = (html: string) =>
  [...html.matchAll(/<a href="#([^"]+)" aria-label="Evidence (E\d+), (\w+)"/g)].map((m) => [m[1], m[2], m[3]]);

describe("the verdict section", () => {
  it("reads confidence in words, high from 0.8 and medium from 0.5", () => {
    expect([0, 0.49, 0.5, 0.6, 0.79, 0.8, 1].map(confidenceWords)).toEqual([
      "low",
      "low",
      "medium",
      "medium",
      "medium",
      "high",
      "high",
    ]);
  });

  it("draws each verdict's band in words with its headline, meaning and motion tile", () => {
    const main = draw(MAIN);
    expect(main).toContain("Malicious · high confidence</p>");
    expect(main).toContain(`>${MAIN.headline}</h2>`);
    expect(main).toContain("do not click its links, open its attachments or pay anything it asks for.");
    expect(main).toMatch(/<img src="[^"]*malicious[^"]*" alt=""/);
    const suspicious = draw({ ...MAIN, verdict: "suspicious", confidence: 0.6 });
    expect(suspicious).toContain("Suspicious · medium confidence</p>");
    expect(suspicious).toContain("Confirm with the sender another way before you act on it.");
    const safe = draw({ ...MAIN, verdict: "safe", confidence: 0.95, reasons: [], actions: ["Pay as usual."] });
    expect(safe).toContain("Safe · high confidence</p>");
    expect(safe).toContain("We found nothing wrong in what we could check.");
    expect(safe).not.toContain("Why we say so");
    const partial = draw(MAIN, "mail", "partial" as never);
    expect(partial).toContain("Malicious · high confidence · partial check</p>");
  });

  it("draws the verdict's stored sentence in the band, and the fixed one only when none is stored (D07 T03 s10)", () => {
    const stored = draw({
      ...MAIN,
      meaning: "The link leads to a lookalike login page that sends your password to someone else.",
    });
    expect(stored).toContain("The link leads to a lookalike login page that sends your password to someone else.");
    expect(stored).not.toContain("do not click its links, open its attachments or pay anything it asks for.");
    const older = draw({ ...MAIN, meaning: null });
    expect(older).toContain("do not click its links, open its attachments or pay anything it asks for.");
    const hostile = `<script>alert(1)</script> ${"x".repeat(280)}`;
    const drawn = draw({ ...MAIN, meaning: hostile });
    expect(drawn).not.toContain("<script>alert(1)</script>");
    expect(drawn).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("draws the band, then the actions, then the reasons", () => {
    const html = draw(MAIN);
    const band = html.indexOf('aria-label="Verdict"');
    const actions = html.indexOf(">What to do now</h2>");
    const reasons = html.indexOf(">Why we say so</h2>");
    expect(band).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(band);
    expect(reasons).toBeGreaterThan(actions);
  });

  it("draws the first three reasons in order, each pill at its evidence's severity naming a card the page holds", () => {
    const html = draw(MAIN);
    const why = section(html, "Why we say so");
    expect([...why.matchAll(/<span class="min-w-0">([^<]*)<\/span>/g)].map((m) => m[1])).toEqual(
      (MAIN.reasons.slice(0, 3) as { text: string }[]).map((r) => r.text),
    );
    expect(pills(why)).toEqual([
      ["e7", "E7", "critical"],
      ["e4", "E4", "critical"],
      ["e2", "E2", "high"],
    ]);
    const anchors = ids(html);
    for (const [target] of pills(why)) expect(anchors.has(target as string), target).toBe(true);
    expect(why).not.toContain("A fourth reason");
  });

  it("links no reason whose evidence is not on the page, and draws an old row's reason as plain text", () => {
    const html = draw({
      ...MAIN,
      reasons: [{ text: "Cites a card this case lacks.", evidenceIds: ["E5"] }, "An old row's plain reason."],
    });
    const why = section(html, "Why we say so");
    expect(pills(why)).toEqual([]);
    expect(why).toContain("Cites a card this case lacks.");
    expect(why).toContain("An old row&#39;s plain reason.");
  });

  it("numbers at most three actions under What to do now, with no highlight", () => {
    const html = draw(MAIN);
    const what = section(html, "What to do now");
    expect([...what.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1])).toEqual(MAIN.actions.slice(0, 3));
    expect(html).not.toContain("Do this first");
    expect(draw({ ...MAIN, actions: [] })).not.toContain("What to do now");
  });

  it("puts a fixed action first under Do this first, for an invoice, a payment document and a voice note", () => {
    const invoice = draw({
      ...MAIN,
      actions: ["Delete the email.", bankChangeAction("011 555 0142"), "Tell whoever handles payments."],
    });
    expect(invoice).toContain("Malicious · high confidence · invoice fraud</p>");
    const first = section(invoice, "Do this first");
    expect(first).toMatch(
      new RegExp(`text-22[^>]*>${bankChangeAction("011 555 0142").replace(/[.()+]/g, "\\$&")}</p>`),
    );
    expect(first).toContain("Delete the email. Tell whoever handles payments.");
    expect(invoice).not.toContain("What to do now");
    const pop = section(draw({ ...MAIN, actions: ["Keep the document.", POP_ACTION] }, "document"), "Do this first");
    expect(pop).toMatch(new RegExp(`text-22[^>]*>${POP_ACTION}</p>`));
    const voice = draw(
      { ...MAIN, verdict: "suspicious", confidence: 0.6, actions: ["Do not pay.", callBackAction("Johan Visser")] },
      "audio",
    );
    expect(voice).toContain("Suspicious · medium confidence · voice note</p>");
    expect(section(voice, "Do this first")).toMatch(/text-22[^>]*>Call Johan Visser on the number/);
    const plainVoice = section(draw({ ...MAIN, actions: ["Do not pay until he confirms."] }, "audio"), "Do this first");
    expect(plainVoice).toMatch(/text-22[^>]*>Do not pay until he confirms.<\/p>/);
  });
});

describe("the fixed action is never lost (completion review)", () => {
  it("leads with a fixed action stored in any position up to the tenth, cutting the rest to three", () => {
    const plain = ["One.", "Two.", "Three.", "Four.", "Five.", "Six.", "Seven.", "Eight.", "Nine."];
    for (let at = 0; at < 10; at++)
      for (const fixed of [bankChangeAction("011 555 0142"), POP_ACTION, callBackAction("J. Visser")]) {
        const actions = [...plain.slice(0, at), fixed, ...plain.slice(at)].slice(0, 10);
        const first = section(draw({ ...MAIN, actions }, "audio"), "Do this first");
        expect(first, `${fixed} at ${at + 1}`).toContain(`>${fixed.replace(/&/g, "&amp;")}</p>`);
        expect((first.match(/One\.|Two\.|Three\.|Four\./g) ?? []).length, `${at + 1}`).toBe(2);
      }
  });

  it("puts a call-back naming someone by an initial first", () => {
    const voice = section(
      draw({ ...MAIN, actions: ["Do not pay.", callBackAction("J. Visser")] }, "audio"),
      "Do this first",
    );
    expect(voice).toMatch(/text-22[^>]*>Call J\. Visser on the number/);
  });
});

describe("the verdict through the report route", () => {
  async function member() {
    const orgId = `org-verdict-${crypto.randomUUID().slice(0, 8)}`;
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(orgId, "Verdict Co", orgId, new Date().toISOString())
      .run();
    const email = `verdict-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(email);
    const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
    await db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
      .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
      .run();
    const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await saveEvidence(db, id, [
      {
        check: "auth.dmarc",
        severity: "critical",
        summary: "The sender's domain fails DMARC",
        detail: {},
        artefacts: [],
      },
    ]);
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'malicious' WHERE id = ?").bind(id).run();
    return { cookie, id };
  }

  it("draws the stored verdict, its old plain reasons as text with no pill", async () => {
    const { cookie, id } = await member();
    await putStoredVerdict(db, id, {
      verdict: "malicious",
      headline: "A stored headline from the verdict row.",
      confidence: 0.6,
      reasons: ["A stored plain reason."],
      actions: ["A stored action."],
      source: "rules",
    });
    const res = await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Malicious · medium confidence</p>");
    expect(html).toContain(">A stored headline from the verdict row.</h2>");
    expect(section(html, "Why we say so")).toContain("A stored plain reason.");
    expect(pills(section(html, "Why we say so"))).toEqual([]);
    expect(section(html, "What to do now")).toContain("<li>A stored action.</li>");
    expect(html).toContain('id="e1"');
  });

  it("reads a structured reason and the distinctive stored sentence back through the route (D07 T03 s10)", async () => {
    const { cookie, id } = await member();
    await putStoredVerdict(db, id, {
      verdict: "malicious",
      headline: "A stored headline from the verdict row.",
      confidence: 0.6,
      reasons: [{ text: "A structured stored reason.", evidenceIds: ["E1"] }],
      actions: ["A stored action."],
      meaning: "This message asks for the mailbox password on a page that is not NimbusMail's.",
      source: "rules",
    });
    const res = await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This message asks for the mailbox password on a page that is not NimbusMail&#39;s.");
    expect(html).not.toContain("do not click its links, open its attachments or pay anything it asks for.");
    expect(pills(section(html, "Why we say so"))).toEqual([["e1", "E1", "critical"]]);
  });

  // Check versions on the verdict-lost finished report (D07 T03 §39, completion review): its count line carries
  // the disclosure too.
  it("carries Check versions when a finished case's verdict row is missing", () => {
    const html = String(
      jsx(ReportDocument, {
        stored: {
          id: "01JCASE0000000000000000000",
          status: "done",
          verdict: "safe",
          sourceKind: "mail",
          createdAt: "2026-10-27T08:12:00Z",
        },
        verdict: null,
        evidence: [],
        shell: null,
        coverage: [{ check: "domain.lookalike", outcome: "ran", reason: null, findings: 0, revision: "v-orphan" }],
      }),
    );
    expect(html).toContain("Check versions");
    expect(html).toContain("Lookalike domains: v-orphan");
  });

  it("answers the error page, never a report without its verdict, when the verdict cannot be read", async () => {
    const { cookie, id } = await member();
    const prepare = db.prepare.bind(db);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/FROM case_verdicts/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const res = await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const html = await res.text();
    expect(html).toContain("Sorry, something broke on our side.");
    expect(html).not.toContain("Case received");
  });
});
