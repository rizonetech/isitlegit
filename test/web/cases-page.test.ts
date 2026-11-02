import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS, filtersFrom } from "../../src/db/case-filters";
import { type Checker, checkerName, FORMER_MEMBER, listCases } from "../../src/db/case-list";
import { refreshSearchText, scheduledSearchRefresh, searchText } from "../../src/db/case-search";
import { ulid } from "../../src/db/ulid";
import { casesHref, fullTime, whenText } from "../../src/web/pages/cases-view";
import { call, signIn, target } from "../auth/helpers";

// The Cases list (D07 T04 §1): the active organisation's cases only, newest first, filtered and paged through the query
// string, each case's real state, who checked it, the first-run and filtered-empty states, and its refusals as pages.
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function org(name: string) {
  const id = `org-cases-${++n}-${crypto.randomUUID().slice(0, 6)}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(id, name, id, new Date().toISOString())
    .run();
  return id;
}
const userId = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())?.id;
async function join(email: string, orgId: string) {
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'member', ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, await userId(email), new Date().toISOString())
    .run();
}
// A signed-in member of `orgId` with it active, named `name`.
async function member(orgId: string, name = "") {
  const email = `cases-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  await join(email, orgId);
  await db.prepare(`UPDATE "user" SET name = ? WHERE lower(email) = ?`).bind(name, email).run();
  await db
    .prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`)
    .bind(orgId, await userId(email))
    .run();
  return { cookie, email };
}
type Made = {
  at?: string;
  ageMs?: number;
  channel?: "email" | "upload";
  sourceKind?: "mail" | "document" | "image" | "audio";
  status?: "received" | "running" | "done" | "partial";
  verdict?: "safe" | "suspicious" | "malicious" | null;
  forwardedBy?: string | null;
  subject?: string | null;
  fromName?: string | null;
  fromAddress?: string | null;
  uploadName?: string | null;
  uploadMediaType?: string | null;
  uploadedBy?: string | null;
};
async function made(orgId: string, c: Made = {}) {
  const id = ulid();
  const at = c.at ?? new Date(Date.now() - (c.ageMs ?? 0)).toISOString();
  const channel = c.channel ?? "email";
  await db
    .prepare(
      `INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, created_at, updated_at, forwarded_by, source_kind,
         original_subject, original_from_name, original_from_address, upload_name, upload_media_type, uploaded_by, search_text)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      orgId,
      channel,
      c.status ?? "done",
      c.verdict === undefined ? "safe" : c.verdict,
      at,
      at,
      c.forwardedBy === undefined ? (channel === "email" ? "someone@demo.isitlegit.co.za" : null) : c.forwardedBy,
      c.sourceKind ?? (channel === "email" ? "mail" : "document"),
      c.subject ?? null,
      c.fromName ?? null,
      c.fromAddress ?? null,
      c.uploadName ?? null,
      c.uploadMediaType ?? null,
      c.uploadedBy ?? null,
      searchText({ subject: c.subject, fromName: c.fromName, fromAddress: c.fromAddress, uploadName: c.uploadName }),
    )
    .run();
  return id;
}
const DAY = 86_400_000;
const get = (path: string, cookie?: string) =>
  call(path, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });
const page = async (path: string, cookie: string) => {
  const res = await get(path, cookie);
  expect(res.status, path).toBe(200);
  return res.text();
};
// The ids of the cases a page lists, in order (each row links its report once in the table and once on a phone).
const listed = (html: string) => [...new Set([...html.matchAll(/href="\/r\/([0-9A-Z]{26})[?"]/g)].map((m) => m[1]))];

describe("the cases list", () => {
  it("sends a visitor with no session to sign in, back to the list after", async () => {
    const res = await get("/cases?verdict=safe");
    expect(res.status).toBe(303);
    expect(target(res)).toBe(`/signin?next=${encodeURIComponent("/cases?verdict=safe")}`);
  });

  it("answers a member with no active organisation, or one just removed, with the 403 page", async () => {
    const a = await org("Karoo Couriers");
    const { cookie, email } = await member(a);
    await db
      .prepare(`DELETE FROM "member" WHERE "userId" = ?`)
      .bind(await userId(email))
      .run();
    const removed = await get("/cases", cookie);
    expect(removed.status).toBe(403);
    const html = await removed.text();
    expect(html).toContain("You&#39;re not a member of this organisation.");
    expect(html).toContain(email);
    expect(html).toContain('action="/auth/sign-out"');
    await db
      .prepare(`UPDATE "session" SET "activeOrganizationId" = NULL WHERE "userId" = ?`)
      .bind(await userId(email))
      .run();
    expect((await get("/cases", cookie)).status).toBe(403);
  });

  it("lists the organisation's cases newest first, each opening its report, and none of another's", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const old = await made(a, { ageMs: 2 * DAY });
    const fresh = await made(a, { ageMs: 1000 });
    const theirs = await made(b);
    const { cookie } = await member(a);
    const res = await get("/cases", cookie);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(listed(html)).toEqual([fresh, old]);
    expect(html).not.toContain(theirs);
    expect(html).toContain("Everything Karoo Couriers has checked");
    expect(html).toContain("Showing 1 to 2 of 2");
  });

  it("filters by verdict, channel and period, alone and together", async () => {
    const a = await org("Karoo Couriers");
    const mal = await made(a, { verdict: "malicious" });
    const sus = await made(a, { verdict: "suspicious", channel: "upload" });
    const safe = await made(a, { verdict: "safe" });
    const oldMal = await made(a, { verdict: "malicious", ageMs: 40 * DAY });
    const { cookie } = await member(a);
    expect(listed(await page("/cases?verdict=malicious", cookie))).toEqual([mal]);
    expect(listed(await page("/cases?channel=upload", cookie))).toEqual([sus]);
    expect(listed(await page("/cases?period=all&verdict=malicious", cookie))).toEqual([mal, oldMal]);
    expect(listed(await page("/cases?channel=email&verdict=safe", cookie))).toEqual([safe]);
    expect(listed(await page("/cases?period=90&channel=email", cookie))).toEqual([safe, mal, oldMal]);
    // The form shows what the address asks for.
    const html = await page("/cases?verdict=suspicious&channel=upload&period=7", cookie);
    expect(html).toMatch(/value="suspicious"[^>]*checked/);
    expect(html).toMatch(/<option value="upload" selected/);
    expect(html).toMatch(/<option value="7" selected/);
  });

  it("answers a bad filter value with its default, never an error", async () => {
    const a = await org("Karoo Couriers");
    const one = await made(a);
    const { cookie } = await member(a);
    expect(listed(await page("/cases?verdict=evil&channel=fax&period=9999&page=-3", cookie))).toEqual([one]);
    expect(listed(await page("/cases?page=abc", cookie))).toEqual([one]);
  });

  it("pages 25 at a time, keeping the filters, clamping a page past the end, disabling the ends", async () => {
    const a = await org("Karoo Couriers");
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await made(a, { verdict: "malicious", ageMs: i * 60_000 }));
    await made(a, { verdict: "safe" });
    const { cookie } = await member(a);
    const first = await page("/cases?verdict=malicious", cookie);
    expect(listed(first)).toEqual(ids.slice(0, 25));
    expect(first).toContain("Showing 1 to 25 of 30");
    expect(first).toContain('href="/cases?verdict=malicious&amp;page=2"');
    expect(first).toMatch(/<button id="case-previous" type="button" disabled[^>]*>Previous<\/button>/);
    const second = await page("/cases?verdict=malicious&page=2", cookie);
    expect(listed(second)).toEqual(ids.slice(25));
    expect(second).toContain("Showing 26 to 30 of 30");
    expect(second).toContain('href="/cases?verdict=malicious"');
    expect(second).toMatch(/<button id="case-next" type="button" disabled[^>]*>Next<\/button>/);
    // Past the end: the last page. A filter change carries no page, so it starts at page 1.
    expect(listed(await page("/cases?verdict=malicious&page=9", cookie))).toEqual(ids.slice(25));
    expect(second).not.toMatch(/<input[^>]*name="page"/);
  });

  it("names who checked each case: the member, a former member's address, an upload's Not recorded", async () => {
    const a = await org("Karoo Couriers");
    const { cookie, email } = await member(a, "Thandi Nkosi");
    const mine = await made(a, { forwardedBy: email });
    const gone = await made(a, { forwardedBy: "left@demo.isitlegit.co.za", ageMs: 1000 });
    const upload = await made(a, { channel: "upload", forwardedBy: null, ageMs: 2000 });
    const read = await listCases(db, a, {
      verdict: "all",
      channel: "all",
      period: "30",
      page: 1,
      q: "",
      from: "",
      to: "",
      checker: "",
    });
    if (!read.ok) throw new Error(read.error.message);
    const by = Object.fromEntries(read.value.cases.map((c) => [c.id, c.checkedBy]));
    expect(by).toEqual({ [mine]: "Thandi Nkosi", [gone]: "left@demo.isitlegit.co.za", [upload]: null });
    const html = await page("/cases", cookie);
    expect(html).toContain("Thandi Nkosi");
    expect(html).toContain("Not recorded");
  });

  // D07 T03 §42, the production defect of 2026-10-31 (app.isitlegit.co.za at 46e92188): every upload read "Not
  // recorded" in the list while its report header named the uploader. The list and the header must name the same one.
  it("names an upload's uploader alike in the list and the report header", async () => {
    const a = await org("Fynbos Freight");
    const { cookie, email } = await member(a, "Lindiwe Dlamini");
    const named = (await userId(email)) as string;
    const blank = await member(a, "  ");
    const blankId = (await userId(blank.email)) as string;
    const leaver = await member(a, "Gone Member");
    const leaverId = (await userId(leaver.email)) as string;
    await db.prepare(`DELETE FROM "member" WHERE "userId" = ? AND "organizationId" = ?`).bind(leaverId, a).run();
    // Each upload: the list's words and the report header's, which must agree.
    const cases: [string | null, string, string, Checker][] = [
      [named, "Lindiwe Dlamini", "Uploaded by Lindiwe Dlamini", { kind: "member", name: "Lindiwe Dlamini" }],
      [blankId, blank.email, `Uploaded by ${blank.email}`, { kind: "member", name: blank.email }],
      [leaverId, FORMER_MEMBER, "Uploaded by a former member", { kind: "former" }],
      [null, "Not recorded", "Uploaded ·", null],
    ];
    const ids: string[] = [];
    for (const [uploadedBy] of cases) ids.push(await made(a, { channel: "upload", forwardedBy: null, uploadedBy }));
    const read = await listCases(db, a, {
      verdict: "all",
      channel: "all",
      period: "30",
      page: 1,
      q: "",
      from: "",
      to: "",
      checker: "",
    });
    if (!read.ok) throw new Error(read.error.message);
    const list = await page("/cases", cookie);
    for (const [k, [uploadedBy, listed, header, checker]] of cases.entries()) {
      const id = ids[k] as string;
      expect(read.value.cases.find((c) => c.id === id)?.checkedBy ?? "Not recorded", listed).toBe(listed);
      expect(await checkerName(db, a, { channel: "upload", forwardedBy: null, uploadedBy }), listed).toEqual(checker);
      const report = await (await get(`/r/${id}`, cookie)).text();
      expect(report, listed).toContain(header);
    }
    expect(list).toContain("Lindiwe Dlamini");
    expect(list).toContain(FORMER_MEMBER);
  });

  it("names an upload's checker: the member who uploaded it, Former member once they left, never another's user", async () => {
    const a = await org("Karoo Couriers");
    const { cookie, email } = await member(a, "Ayesha Patel");
    const uploader = (await userId(email)) as string;
    const blank = await member(a, "  ");
    const blankId = (await userId(blank.email)) as string;
    const outsider = await member(await org("Elsewhere"), "Not Ours");
    const outsiderId = (await userId(outsider.email)) as string;
    const theirs = await made(a, { channel: "upload", forwardedBy: null, uploadedBy: uploader });
    const unnamed = await made(a, { channel: "upload", forwardedBy: null, uploadedBy: blankId, ageMs: 1000 });
    const foreign = await made(a, { channel: "upload", forwardedBy: null, uploadedBy: outsiderId, ageMs: 2000 });
    const before = await made(a, { channel: "upload", forwardedBy: null, uploadedBy: null, ageMs: 3000 });
    const read = await listCases(db, a, filtersFrom(new URLSearchParams()));
    if (!read.ok) throw new Error(read.error.message);
    const by = Object.fromEntries(read.value.cases.map((c) => [c.id, c.checkedBy]));
    expect(by).toEqual({
      [theirs]: "Ayesha Patel",
      [unnamed]: blank.email,
      [foreign]: FORMER_MEMBER,
      [before]: null,
    });
    // The uploader leaves: their uploads read Former member, never their name.
    await db.prepare(`DELETE FROM "member" WHERE "userId" = ?`).bind(uploader).run();
    const after = await listCases(db, a, filtersFrom(new URLSearchParams()));
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.cases.find((c) => c.id === theirs)?.checkedBy).toBe(FORMER_MEMBER);
    const html = await page("/cases", blank.cookie);
    expect(html).not.toContain("Not Ours");
    expect(html).not.toContain("Ayesha Patel");
    expect(html).toContain(FORMER_MEMBER);
    expect(html).toContain("Not recorded");
  });

  it("names each row by its subject over its sender, or an upload's file name over how it came in", async () => {
    const a = await org("Karoo Couriers");
    await made(a, {
      subject: "Invoice INV-20931 and new banking details",
      fromName: "Fynbos",
      fromAddress: "debtors@fynbos.example",
    });
    await made(a, { subject: null, fromAddress: "no-subject@sender.example", ageMs: 1000 });
    await made(a, { subject: "Named only", fromName: "Sipho Mokoena", ageMs: 2000 });
    await made(a, { ageMs: 3000 });
    await made(a, {
      channel: "upload",
      forwardedBy: null,
      uploadName: "Proof of payment.pdf",
      uploadMediaType: "application/pdf",
      ageMs: 4000,
    });
    await made(a, { channel: "upload", forwardedBy: null, sourceKind: "audio", ageMs: 5000 });
    const { cookie } = await member(a);
    const html = await page("/cases", cookie);
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    expect(table).toContain(">Subject and sender<");
    const rows = table.split("<tr").slice(2);
    const text = rows.map((row) => row.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|"));
    expect(text[0]).toContain("|Invoice INV-20931 and new banking details|debtors@fynbos.example|");
    expect(text[0]).not.toContain("Fynbos|");
    expect(text[1]).toContain("|No subject|no-subject@sender.example|");
    expect(text[2]).toContain("|Named only|Sipho Mokoena|");
    expect(text[3]).toContain("|Forwarded email|");
    expect(text[4]).toContain("|Proof of payment.pdf|Uploaded PDF|");
    expect(text[5]).toContain("|Uploaded voice note|");
    // The phone cards name each the same way.
    const cards = html.slice(html.indexOf('<ol class="md:hidden'));
    expect(cards).toContain("Proof of payment.pdf");
    expect(cards).toContain("debtors@fynbos.example");
  });

  it("finds a case by a subject word, a sender's address or name, a file name, across case and accents", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const subject = await made(a, { subject: "Remittance advice 4471", fromAddress: "accounts@outeniqua.example" });
    const named = await made(a, {
      subject: "Hello",
      fromName: "Zoë Müller",
      fromAddress: "zoe@m.example",
      ageMs: 1000,
    });
    const cafe = await made(a, { subject: "CAFÉ invoice", fromAddress: "x@y.example", ageMs: 2000 });
    const file = await made(a, { channel: "upload", forwardedBy: null, uploadName: "Bank letter.PDF", ageMs: 3000 });
    const percent = await made(a, { subject: "50% off_today", ageMs: 4000 });
    await made(a, { subject: "Unrelated", fromAddress: "other@z.example", ageMs: 5000 });
    const theirs = await made(b, { subject: "Remittance advice 4471", fromAddress: "accounts@outeniqua.example" });
    const { cookie } = await member(a);
    expect(listed(await page("/cases?q=remittance", cookie))).toEqual([subject]);
    expect(listed(await page("/cases?q=ACCOUNTS%40OUTENIQUA", cookie))).toEqual([subject]);
    expect(listed(await page("/cases?q=zoe+muller", cookie))).toEqual([named]);
    expect(listed(await page("/cases?q=caf%C3%A9", cookie))).toEqual([cafe]);
    expect(listed(await page("/cases?q=cafe", cookie))).toEqual([cafe]);
    expect(listed(await page("/cases?q=bank+letter", cookie))).toEqual([file]);
    // % and _ are themselves, never wildcards.
    expect(listed(await page("/cases?q=%25", cookie))).toEqual([percent]);
    expect(listed(await page("/cases?q=of_", cookie))).toEqual([]);
    expect(listed(await page("/cases?q=off_", cookie))).toEqual([percent]);
    // Another organisation's case with the same subject never.
    const html = await page("/cases?q=remittance", cookie);
    expect(html).not.toContain(theirs);
    // Every word must be in the case, in any order, in any of the fields (D07 T04 §14): a subject word and a sender word
    // find it, and a word it lacks does not.
    expect(listed(await page("/cases?q=hello+zoe", cookie))).toEqual([named]);
    expect(listed(await page("/cases?q=zoe+hello", cookie))).toEqual([named]);
    expect(listed(await page("/cases?q=hello+nobody", cookie))).toEqual([]);
    // The box shows the search the address asks for.
    expect(html).toMatch(/<input[^>]*id="case-search"[^>]*value="remittance"/);
    expect(html).toMatch(/<label for="case-search" class="sr-only">Search cases<\/label>/);
  });

  it("finds a case by every word, in any order, across the subject, sender and file name, and never by a word it lacks (D07 T04 §14)", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const remit = await made(a, {
      subject: "Remittance advice 4471",
      fromName: "Outeniqua Accounts",
      fromAddress: "accounts@outeniqua.example",
    });
    const other = await made(a, {
      subject: "Remittance advice 9980",
      fromAddress: "pay@elsewhere.example",
      ageMs: 1000,
    });
    const file = await made(a, {
      channel: "upload",
      forwardedBy: null,
      uploadName: "Statement march.PDF",
      ageMs: 2000,
    });
    const theirs = await made(b, { subject: "Remittance advice 4471", fromAddress: "accounts@outeniqua.example" });
    const { cookie } = await member(a);
    const q = async (query: string) => listed(await page(`/cases?q=${encodeURIComponent(query)}`, cookie));
    // The scraps a person remembers.
    expect(await q("remittance 4471")).toEqual([remit]);
    expect(await q("4471 remittance")).toEqual([remit]);
    expect(await q("remittance advice")).toEqual([remit, other]);
    // A sender word and a subject word, and a file-name word with another.
    expect(await q("outeniqua 4471")).toEqual([remit]);
    expect(await q("statement march")).toEqual([file]);
    expect(await q("march statement")).toEqual([file]);
    // Never by a word the case lacks, and never another organisation's.
    expect(await q("remittance 4471 nonesuch")).toEqual([]);
    expect(await q("remittance 9980 outeniqua")).toEqual([]);
    expect((await page("/cases?q=remittance+4471", cookie)).includes(theirs)).toBe(false);
    // A quoted phrase is one contiguous run: "advice 4471" matches, "4471 advice" does not, though both unquoted do.
    expect(await q('"advice 4471"')).toEqual([remit]);
    expect(await q('"4471 advice"')).toEqual([]);
    expect(await q("4471 advice")).toEqual([remit]);
    // Curly quotes read as straight, and an unmatched quote is a space.
    expect(await q("\u201Cadvice 4471\u201D")).toEqual([remit]);
    expect(await q('"advice 4471')).toEqual([remit]);
    expect(await q('remittance "4471')).toEqual([remit]);
    // Accents and case fold per term.
    expect(await q("REMITTANCE Advïce")).toEqual([remit, other]);
  });

  it("uses the first 8 distinct search terms and says so, counting a quoted phrase as one and a repeat as none", async () => {
    const a = await org("Karoo Couriers");
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
    // A case holding the first eight and lacking the ninth, and one lacking a retained term.
    const first8 = await made(a, { subject: words.slice(0, 8).join(" ") });
    const lacking = await made(a, { subject: words.filter((w) => w !== "delta").join(" "), ageMs: 1000 });
    const { cookie } = await member(a);
    const run = async (query: string) => {
      const html = await page(`/cases?q=${encodeURIComponent(query)}`, cookie);
      return { ids: listed(html), html };
    };
    // Nine distinct terms: the ninth is not used, so the case lacking it matches; a case lacking a retained one does not.
    const nine = await run(words.join(" "));
    expect(nine.ids).toEqual([first8]);
    expect(nine.ids).not.toContain(lacking);
    const sentence = "Searching the first 8 search terms. A quoted phrase counts as one.";
    expect(nine.html.split(sentence).length - 1).toBe(2);
    // Eight terms: no notice. Nine with one repeated is eight distinct: no notice.
    expect((await run(words.slice(0, 8).join(" "))).html).not.toContain("Searching the first 8");
    expect((await run(`${words.slice(0, 8).join(" ")} alpha ALPHA`)).html).not.toContain("Searching the first 8");
    // A quoted phrase is one term: eight terms with a phrase in them are not cut, nine are.
    const phrase = await made(a, {
      subject: "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      ageMs: 2000,
    });
    const eight = await run('"alpha bravo" charlie delta echo foxtrot golf hotel india');
    expect(eight.html).not.toContain("Searching the first 8");
    expect(eight.ids).toContain(phrase);
    const nineWithPhrase = await run('"alpha bravo" charlie delta echo foxtrot golf hotel india juliet');
    expect(nineWithPhrase.html.split(sentence).length - 1).toBe(2);
    expect(nineWithPhrase.ids).toContain(phrase);
    // The status line carries it too, for the screen reader.
    expect(nine.html).toMatch(/id="case-count"[^>]*>[^<]*Searching the first 8 search terms\./);
  });

  it("says when the search was cut at 100 characters, and when that cut a quoted phrase open, instead of searching less in silence", async () => {
    const a = await org("Karoo Couriers");
    const phrase = "remittance advice for the november supplier statement run";
    const hit = await made(a, { subject: `${phrase} 4471` });
    await made(a, { subject: "remittance something else entirely", ageMs: 1000 });
    const { cookie } = await member(a);
    const LONG = "Your search was longer than 100 characters, so only the first 100 were used.";
    const QUOTE = "A quoted phrase was cut off, so it was searched as separate words.";
    const text = (html: string) =>
      html
        .replace(/<[^>]+>/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ");
    // Within the limit: no notice.
    const within = await page(`/cases?q=${encodeURIComponent(`"${phrase}"`)}`, cookie);
    expect(listed(within)).toEqual([hit]);
    expect(text(within)).not.toContain("longer than 100");
    // A direct request of 102 characters whose closing quote is cut off: the notice says both, in the status line and the
    // results, and the phrase was searched as words (so the broader case is found too, which the notice explains).
    const long = `"${phrase} ${"x".repeat(100 - phrase.length)}"`;
    expect(Array.from(long).length).toBeGreaterThan(100);
    const cut = await page(`/cases?q=${encodeURIComponent(long)}`, cookie);
    const body = text(cut);
    expect(body.split(LONG).length - 1).toBe(2);
    expect(body.split(QUOTE).length - 1).toBe(2);
    expect(cut).toMatch(/id="case-count"[^>]*>[^<]*longer than 100 characters/);
    // The same length with no quote cut says only the length.
    const plain = await page(`/cases?q=${encodeURIComponent("remittance ".repeat(12))}`, cookie);
    expect(text(plain).split(LONG).length - 1).toBe(2);
    expect(text(plain)).not.toContain(QUOTE);
    // The box carries what the request held, not cut short by the browser's own limit: the input has no maxlength.
    expect(cut).not.toMatch(/<input[^>]*id="case-search"[^>]*maxlength/);
  });

  it("finds a case stored before migration 0052 by ASCII words at once, and by any once the schedule folds it", async () => {
    const a = await org("Karoo Couriers");
    const old = await made(a, { subject: "Rémittance ADVICE 9", fromAddress: "pay@old.example" });
    await db.prepare("UPDATE cases SET search_text = NULL WHERE id = ?").bind(old).run();
    const { cookie } = await member(a);
    // Pending: ASCII words find it through SQLite's lower().
    expect(listed(await page("/cases?q=advice+9", cookie))).toEqual([old]);
    expect(listed(await page("/cases?q=PAY%40OLD", cookie))).toEqual([old]);
    // A failed refill leaves it found the same way.
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("search_text IS NULL AND")) throw new Error("D1_ERROR: refill down");
      return prepare(sql);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await scheduledSearchRefresh({ DB: db })).toBe(0);
    vi.restoreAllMocks();
    expect(listed(await page("/cases?q=advice+9", cookie))).toEqual([old]);
    // Recovered: folded, so the accent-free word finds it too.
    while ((await refreshSearchText(db)) > 0);
    expect(listed(await page("/cases?q=remittance", cookie))).toEqual([old]);
  });

  it("searches 10,000 cases of one organisation, the matching count and a page, within a second", async () => {
    const a = await org("Large Tenant");
    const at = Date.now();
    for (let start = 0; start < 10_000; start += 500) {
      const batch = [];
      for (let i = start; i < start + 500; i++) {
        const when = new Date(at - i * 60_000).toISOString();
        const subject = i % 1000 === 7 ? `Needle invoice ${i}` : `Routine statement ${i}`;
        batch.push(
          db
            .prepare(
              `INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, created_at, updated_at, forwarded_by, source_kind, original_subject, original_from_address, search_text)
               VALUES (?, ?, 'email', 'done', 'safe', 1, ?, ?, 'someone@demo.isitlegit.co.za', 'mail', ?, ?, ?)`,
            )
            .bind(
              ulid(),
              a,
              when,
              when,
              subject,
              `s${i}@sender.example`,
              searchText({ subject, fromAddress: `s${i}@sender.example` }),
            ),
        );
      }
      await db.batch(batch);
    }
    const timed = async (q: string) => {
      const started = performance.now();
      const read = await listCases(db, a, filtersFrom(new URLSearchParams({ q, period: "all" })));
      const ms = performance.now() - started;
      if (!read.ok) throw new Error(read.error.message);
      return { ms, matching: read.value.matching };
    };
    const hit = await timed("needle");
    const miss = await timed("nothing like this at all");
    console.log(
      JSON.stringify({
        event: "case-search-bench",
        cases: 10_000,
        hitMs: Math.round(hit.ms),
        missMs: Math.round(miss.ms),
      }),
    );
    expect(hit.matching).toBe(10);
    expect(miss.matching).toBe(0);
    expect(hit.ms).toBeLessThan(1000);
    expect(miss.ms).toBeLessThan(1000);
  }, 120_000);

  it("names an uploaded email by its file name over its sender, as a search for either shows", async () => {
    const a = await org("Karoo Couriers");
    const eml = await made(a, {
      channel: "upload",
      forwardedBy: null,
      sourceKind: "mail",
      uploadName: "supplier-query.eml",
      subject: "Payment requested",
      fromAddress: "accounts@supplier.example",
    });
    const { cookie } = await member(a);
    for (const q of ["supplier-query", "payment+requested"]) {
      const html = await page(`/cases?q=${q}`, cookie);
      expect(listed(html)).toEqual([eml]);
      const table = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>")).replace(/<[^>]+>/g, "|");
      expect(table).toContain("supplier-query.eml");
      expect(table).toContain("Uploaded email from accounts@supplier.example");
      const cards = html.slice(html.indexOf('<ol class="md:hidden'));
      expect(cards).toContain("supplier-query.eml");
      expect(cards).toContain("Uploaded email from accounts@supplier.example");
    }
  });

  it("keeps the search in the address, cut to 100 characters and its space made one", () => {
    expect(filtersFrom(new URLSearchParams({ q: `  ${"é".repeat(300)} ` })).q).toBe("é".repeat(100));
    expect(filtersFrom(new URLSearchParams({ q: " a \t  b " })).q).toBe("a b");
    const f = filtersFrom(new URLSearchParams({ q: "café & co", verdict: "safe", page: "2" }));
    expect(casesHref(f)).toBe("/cases?verdict=safe&q=caf%C3%A9+%26+co&page=2");
    expect(filtersFrom(new URL(`https://x${casesHref(f)}`).searchParams)).toEqual(f);
  });

  it("pages a search 25 at a time with the filters, its count honouring the search and a verdict", async () => {
    const a = await org("Karoo Couriers");
    const hits: string[] = [];
    for (let i = 0; i < 30; i++)
      hits.push(await made(a, { subject: `Statement ${i}`, verdict: i % 2 ? "safe" : "malicious", ageMs: i * 60_000 }));
    for (let i = 0; i < 5; i++) await made(a, { subject: `Other ${i}`, ageMs: i * 60_000 + 1 });
    const { cookie } = await member(a);
    const first = await page("/cases?q=statement", cookie);
    expect(listed(first)).toEqual(hits.slice(0, 25));
    expect(first).toContain("Showing 1 to 25 of 30");
    expect(first).toContain('href="/cases?q=statement&amp;page=2"');
    const second = await page("/cases?q=statement&page=2", cookie);
    expect(listed(second)).toEqual(hits.slice(25));
    expect(second).toContain("Showing 26 to 30 of 30");
    expect(second).toContain('href="/cases?q=statement"');
    const safe = await page("/cases?q=statement&verdict=safe", cookie);
    expect(safe).toContain("Showing 1 to 15 of 15");
    expect(listed(safe)).toEqual(hits.filter((_, i) => i % 2));
    // A changed search carries no page, so it starts at page 1: the form holds no page field.
    expect(second).not.toMatch(/<input[^>]*name="page"/);
    // A quoted phrase is the contiguous run, as the search was before every word was required (D07 T04 §14): the eleven that
    // read "statement 2" (2, then 20 to 29), all on one page.
    expect(listed(await page("/cases?q=%22statement+2%22", cookie))).toEqual(
      hits.filter((_, i) => /^2/.test(String(i))),
    );
    // Unquoted, both words are required, in either order: every "Statement" with a 2 in its number (2, 12, 20 to 29).
    expect(listed(await page("/cases?q=2+statement", cookie))).toEqual(hits.filter((_, i) => String(i).includes("2")));
  });

  it("names the search when nothing matches, and Clear filters drops it", async () => {
    const a = await org("Karoo Couriers");
    await made(a, { subject: "Something" });
    const { cookie } = await member(a);
    const html = await page("/cases?q=invoice", cookie);
    expect(html).toContain("No cases match &quot;invoice&quot;, last 30 days.");
    expect(html).toContain('href="/cases?period=all"');
  });

  it("draws each case's real state, all of them under All and only verdicts under a verdict", async () => {
    const a = await org("Karoo Couriers");
    const received = await made(a, { status: "received", verdict: null });
    const running = await made(a, { status: "running", verdict: null, ageMs: 1000 });
    const partial = await made(a, { status: "partial", verdict: "suspicious", ageMs: 2000 });
    const failed = await made(a, { status: "partial", verdict: null, ageMs: 3000 });
    const done = await made(a, { status: "done", verdict: "malicious", ageMs: 4000 });
    const { cookie } = await member(a);
    const html = await page("/cases", cookie);
    expect(listed(html)).toEqual([received, running, partial, failed, done]);
    const rows = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>")).split("<tr").slice(1);
    const pills = rows.map((row) => (row.match(/>(Checking|Partial|Malicious|Suspicious|Safe)</) ?? [])[1]);
    expect(pills).toEqual(["Checking", "Checking", "Partial", "Partial", "Malicious"]);
    expect(rows[3]).toContain("Could not be checked");
    expect(rows[2]).not.toContain("Could not be checked");
    expect(listed(await page("/cases?verdict=suspicious", cookie))).toEqual([partial]);
  });

  it("shows a new organisation the first-run state, with the senders it accepts in each of four ways", async () => {
    const domainOnly = await org("Karoo Couriers");
    const now = new Date().toISOString();
    const domain = (o: string, d: string) =>
      db
        .prepare(
          "INSERT INTO org_domains (id, org_id, domain, token, state, created_at) VALUES (?, ?, ?, ?, 'verified', ?)",
        )
        .bind(crypto.randomUUID(), o, d, "t".repeat(20), now)
        .run();
    const address = (o: string, a: string) =>
      db
        .prepare("INSERT INTO org_addresses (id, org_id, address, state, created_at) VALUES (?, ?, ?, 'verified', ?)")
        .bind(crypto.randomUUID(), o, a, now)
        .run();
    const tag = crypto.randomUUID().slice(0, 6);
    await domain(domainOnly, `karoo-${tag}.example`);
    const first = await page("/cases", (await member(domainOnly)).cookie);
    expect(first).toContain("Check your first suspicious email.");
    expect(first).toContain("Copy address");
    expect(first).toContain("Outlook on the web");
    expect(first).toContain("Tick the email in your inbox, then More at the top, Forward as attachment.");
    expect(first).toContain(
      `<strong class="text-ink">karoo-${tag}.example</strong>, your verified domain, is accepted.`,
    );
    expect(first).not.toContain("Showing");

    const addressOnly = await org("Fynbos Freight");
    await address(addressOnly, `owner-${tag}@gmail.example`);
    expect(await page("/cases", (await member(addressOnly)).cookie)).toContain(
      `mail from <strong class="text-ink">owner-${tag}@gmail.example</strong>, your verified address, is accepted.`,
    );

    const both = await org("Outeniqua Paper");
    await domain(both, `outeniqua-${tag}.example`);
    await address(both, `a-${tag}@gmail.example`);
    await address(both, `b-${tag}@gmail.example`);
    const mixed = await page("/cases", (await member(both)).cookie);
    expect(mixed).toContain("your verified domain, and mail from");
    expect(mixed).toContain("your verified addresses, is accepted.");

    const neither = await org("Sasol Tours");
    const none = await page("/cases", (await member(neither)).cookie);
    expect(none).toContain("No mail is accepted yet");
    expect(none).toContain('href="/settings/domains"');
  });

  it("says when filters match nothing, and Clear filters shows every case, older ones too", async () => {
    const a = await org("Karoo Couriers");
    const old = await made(a, { ageMs: 60 * DAY });
    const { cookie } = await member(a);
    const html = await page("/cases?verdict=malicious&period=7", cookie);
    expect(html).toContain("No cases match Malicious, last 7 days.");
    expect(html).toContain("1 case in total. Try a wider date range or another verdict.");
    expect(html).toContain('href="/cases?period=all"');
    // The default (last 30 days) does not reach the old case; Clear filters' address does.
    expect(listed(await page("/cases", cookie))).toEqual([]);
    expect(listed(await page("/cases?period=all", cookie))).toEqual([old]);
  });

  it("answers a read that fails with the 503 page, its reference logged and Try again keeping the filters", async () => {
    const a = await org("Karoo Couriers");
    await made(a);
    const { cookie } = await member(a);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/COUNT\(\*\) AS n FROM cases/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const res = await get("/cases?verdict=safe&period=all", cookie);
    vi.restoreAllMocks();
    expect(res.status).toBe(503);
    const html = await res.text();
    const shown = /Reference (500-[0-9A-F]{6})/.exec(html)?.[1];
    expect(lines.map((l) => JSON.parse(l)).find((e) => e.event === "cases")).toMatchObject({ reference: shown });
    expect(html).toContain('href="/cases?verdict=safe&amp;period=all"');
  });

  it("answers a session store it cannot read with the 503 page, Try again keeping the filters", async () => {
    const a = await org("Karoo Couriers");
    const { cookie } = await member(a);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/from "session"/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const res = await get("/cases?verdict=malicious", cookie);
    vi.restoreAllMocks();
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Sorry, something broke on our side.");
    expect(html).toContain('href="/cases?verdict=malicious"');
    const shown = /Reference (500-[0-9A-F]{6})/.exec(html)?.[1];
    expect(lines.map((l) => JSON.parse(l)).find((e) => e.event === "cases")).toMatchObject({
      reference: shown,
      error: "session",
    });
  });

  it("reloads the whole page for a results request drawn for another organisation than the active one", async () => {
    const a = await org("Karoo Couriers");
    await made(a);
    const { cookie } = await member(a);
    const stale = await call("/cases?verdict=safe", {
      headers: { cookie, "hx-request": "true", "x-cases-org": "org-somewhere-else" },
    });
    expect(stale.status).toBe(204);
    expect(stale.headers.get("hx-redirect")).toMatch(/\/cases\?verdict=safe$/);
    const fresh = await call("/cases?verdict=safe", { headers: { cookie, "hx-request": "true", "x-cases-org": a } });
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toContain(`&quot;x-cases-org&quot;:&quot;${a}&quot;`);
  });

  it("reloads the whole page for a results request once the organisation has no cases left", async () => {
    const a = await org("Karoo Couriers");
    const only = await made(a, { status: "received", verdict: null });
    const { cookie } = await member(a);
    expect(listed(await page("/cases", cookie))).toEqual([only]);
    await db.prepare("DELETE FROM cases WHERE id = ?").bind(only).run();
    const res = await call("/cases?verdict=safe", { headers: { cookie, "hx-request": "true", "x-cases-org": a } });
    expect(res.status).toBe(204);
    expect(res.headers.get("hx-redirect")).toMatch(/\/cases\?verdict=safe$/);
    // The page itself, asked for whole, is the first-run state.
    expect(await page("/cases?verdict=safe", cookie)).toContain("Check your first suspicious email.");
  });
});

describe("the date range (D07 T04 §8)", () => {
  const F = (q: string) => filtersFrom(new URLSearchParams(q));
  it("reads the dates from the address, a bad date as unset, and round-trips through casesHref", () => {
    expect(F("from=2026-10-03&to=2026-10-09")).toMatchObject({ from: "2026-10-03", to: "2026-10-09" });
    expect(F("from=2026-13-40&to=not-a-date")).toMatchObject({ from: "", to: "" });
    expect(F("from=2026-02-30")).toMatchObject({ from: "" });
    expect(casesHref(F("from=2026-10-03&to=2026-10-09&verdict=safe"))).toBe(
      "/cases?verdict=safe&from=2026-10-03&to=2026-10-09",
    );
    expect(casesHref(F(""))).toBe("/cases");
  });

  it("keeps the SAST days at both ends, inclusive, whatever the period says", async () => {
    const a = await org("Karoo Couriers");
    const b = await org("Other Org");
    const before = await made(a, { at: "2026-10-02T21:59:59Z" });
    const first = await made(a, { at: "2026-10-02T22:00:00Z" });
    const last = await made(a, { at: "2026-10-09T21:59:59Z" });
    const after = await made(a, { at: "2026-10-09T22:00:00Z" });
    const foreign = await made(b, { at: "2026-10-05T10:00:00Z" });
    const ranged = await listCases(db, a, F("period=7&from=2026-10-03&to=2026-10-09"));
    expect(ranged.ok).toBe(true);
    if (!ranged.ok) return;
    expect(ranged.value.cases.map((c) => c.id)).toEqual([last, first]);
    expect(ranged.value.matching).toBe(2);
    expect([before, after, foreign]).toHaveLength(3);
    const sameDay = await listCases(db, a, F("from=2026-10-09&to=2026-10-09"));
    expect(sameDay.ok).toBe(true);
    if (sameDay.ok) expect(sameDay.value.cases.map((c) => c.id)).toEqual([last]);
    const fromOnly = await listCases(db, a, F("from=2026-10-09"));
    expect(fromOnly.ok).toBe(true);
    if (fromOnly.ok) expect(fromOnly.value.cases.map((c) => c.id)).toEqual([after, last]);
    const toOnly = await listCases(db, a, F("to=2026-10-03"));
    expect(toOnly.ok).toBe(true);
    if (toOnly.ok) expect(toOnly.value.cases.map((c) => c.id)).toEqual([first, before]);
  });

  it("combines with verdict, channel and search, and pages inside the range", async () => {
    const a = await org("Karoo Couriers");
    for (let i = 0; i < 30; i++)
      await made(a, { at: `2026-10-05T10:${String(i).padStart(2, "0")}:00Z`, subject: `Invoice ${i}` });
    await made(a, { at: "2026-10-05T11:00:00Z", verdict: "malicious", subject: "Invoice bad" });
    await made(a, {
      at: "2026-10-05T12:00:00Z",
      channel: "upload",
      sourceKind: "document",
      subject: null,
      uploadName: "Invoice up.pdf",
    });
    const one = await listCases(db, a, F("from=2026-10-05&to=2026-10-05"));
    expect(one.ok).toBe(true);
    if (one.ok) {
      expect(one.value.matching).toBe(32);
      expect(one.value.cases).toHaveLength(25);
    }
    const two = await listCases(db, a, F("from=2026-10-05&to=2026-10-05&page=2"));
    expect(two.ok).toBe(true);
    if (two.ok) expect(two.value.cases).toHaveLength(7);
    const narrowed = await listCases(db, a, F("from=2026-10-05&to=2026-10-05&verdict=malicious&q=invoice"));
    expect(narrowed.ok).toBe(true);
    if (narrowed.ok) expect(narrowed.value.matching).toBe(1);
    const uploads = await listCases(db, a, F("from=2026-10-05&to=2026-10-05&channel=upload"));
    expect(uploads.ok).toBe(true);
    if (uploads.ok) expect(uploads.value.matching).toBe(1);
  });

  it("draws both inputs, disables the period under a range, and clears back to it keeping the other filters", async () => {
    const a = await org("Karoo Couriers");
    await made(a, { at: "2026-10-05T10:00:00Z", subject: "Invoice in range" });
    const { cookie } = await member(a);
    const html = await page("/cases?verdict=safe&period=7&from=2026-10-03&to=2026-10-09", cookie);
    expect(html).toContain('name="period" value="7"');
    expect(html).toContain("/cases?verdict=safe&amp;period=7");
    expect(html).toContain('id="case-from"');
    expect(html).toContain('name="from" value="2026-10-03"');
    expect(html).toContain('name="to" value="2026-10-09"');
    expect(html).toMatch(/id="case-period"[^>]*disabled/);
    expect(html).toContain("Clear dates");
    expect(html).toContain("/cases?verdict=safe");
    expect(listed(html)).toHaveLength(1);
    const cleared = await page("/cases?verdict=safe", cookie);
    expect(cleared).not.toMatch(/id="case-period"[^>]*disabled/);
  });

  it("names the range in the filtered-empty heading and offers to swap a reversed pair", async () => {
    const a = await org("Karoo Couriers");
    const inWeek = await made(a, { at: "2026-10-05T10:00:00Z", subject: "Invoice in week" });
    const { cookie } = await member(a);
    const empty = await page("/cases?from=2026-11-03&to=2026-11-09", cookie);
    expect(empty).toContain("No cases match");
    expect(empty).toContain("3 Nov");
    expect(empty).toContain("9 Nov");
    const ignored = await page("/cases?from=2026-02-30&to=2026-10-09", cookie);
    expect(ignored).toContain("The From date was not a real date, so it was left out.");
    const reversed = await page("/cases?from=2026-10-09&to=2026-10-03", cookie);
    expect(reversed).toContain("From is after To");
    expect(reversed).toContain('aria-describedby="case-range-hint"');
    expect(reversed).toContain('id="case-range-error"');
    expect(reversed).toContain("Swap them");
    expect(reversed).toContain("from=2026-10-03&amp;to=2026-10-09");
    expect(listed(reversed)).toEqual([]);
    expect(listed(await page("/cases?from=2026-10-03&to=2026-10-09", cookie))).toEqual([inWeek]);
  });
});

describe("when a case arrived", () => {
  // 2026-10-30 is a Friday; SAST is UTC+2.
  const now = new Date("2026-10-30T12:00:00Z");
  it("says Just now, the time today, Yesterday, then the day, in SAST", () => {
    expect(whenText("2026-10-30T11:59:30Z", now)).toBe("Just now");
    expect(whenText("2026-10-30T07:14:00Z", now)).toBe("09:14");
    expect(whenText("2026-10-29T08:00:00Z", now)).toBe("Yesterday");
    expect(whenText("2026-10-24T08:00:00Z", now)).toBe("Sat 24 Oct");
    expect(whenText("2025-10-24T08:00:00Z", now)).toBe("Fri 24 Oct 2025");
    expect(fullTime("2026-10-30T07:14:00Z")).toBe("Fri 30 Oct 2026, 09:14 SAST");
  });
  it("counts days at SAST midnight, not UTC's", () => {
    // 22:30 UTC on the 29th is 00:30 SAST on the 30th: today, not yesterday.
    expect(whenText("2026-10-29T22:30:00Z", now)).toBe("00:30");
    // 21:30 UTC on the 29th is 23:30 SAST on the 29th: yesterday.
    expect(whenText("2026-10-29T21:30:00Z", now)).toBe("Yesterday");
  });
});

describe("checked by (D07 T04 §10)", () => {
  it("filters an email and an upload by the same member, and no one else's", async () => {
    const a = await org("Karoo Couriers");
    const first = await member(a, "Thandi Nkosi");
    const thandi = (await userId(first.email)) ?? "";
    await member(a, "Pieter Botha");
    const mine = await made(a, { forwardedBy: first.email });
    const upload = await made(a, { channel: "upload", forwardedBy: null });
    await db.prepare("UPDATE cases SET uploaded_by = ? WHERE id = ?").bind(thandi, upload).run();
    await made(a, { forwardedBy: "pieter@demo.isitlegit.co.za" });
    const read = await listCases(db, a, { ...DEFAULT_FILTERS, period: "all", checker: thandi });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.matching).toBe(2);
      expect(read.value.cases.map((c) => c.id).sort()).toEqual([mine, upload].sort());
    }
  });

  it("lists nothing for a member of another organisation or an invented id", async () => {
    const a = await org("Karoo Couriers");
    const b = await org("Other Org");
    await made(a, { forwardedBy: "thandi@demo.isitlegit.co.za" });
    const foreignMember = await member(b, "Foreign Member");
    const foreign = (await userId(foreignMember.email)) ?? "";
    const byForeign = await listCases(db, a, { ...DEFAULT_FILTERS, period: "all", checker: foreign });
    expect(byForeign.ok).toBe(true);
    if (byForeign.ok) expect(byForeign.value.matching).toBe(0);
    const invented = await listCases(db, a, { ...DEFAULT_FILTERS, period: "all", checker: "nobody-at-all" });
    if (invented.ok) expect(invented.value.matching).toBe(0);
  });

  it("draws the select with the members, the chosen one selected, and names them in the empty heading", async () => {
    const a = await org("Karoo Couriers");
    const first = await member(a, "Thandi Nkosi");
    const thandi = (await userId(first.email)) ?? "";
    await made(a, { forwardedBy: "someone-else@demo.isitlegit.co.za" });
    const html = await page(`/cases?checker=${thandi}`, first.cookie);
    expect(html).toContain('id="case-checker"');
    expect(html).toMatch(new RegExp(`<option value="${thandi}" selected`));
    expect(html).toContain("Thandi Nkosi");
    expect(html).toContain("Everyone");
    expect(html).toContain("checked by Thandi Nkosi");
  });

  it("draws a departed checker as unavailable, the filter kept", async () => {
    const a = await org("Karoo Couriers");
    const { cookie } = await member(a, "Thandi Nkosi");
    await made(a, {});
    const html = await page("/cases?checker=departed-member-id", cookie);
    expect(html).toContain("Member no longer available");
    expect(html).toMatch(/value="departed-member-id" selected[^>]*disabled/);
    expect(html).toContain("checked by Member no longer available");
  });
});
