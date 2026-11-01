// The demo's beats that run on the live service today (docs/specs/2026-10-31-demo-video-design.md, "Shipped today"):
// a member uploads a synthetic lure, the report fills in live, and the case joins the cases list. Each beat records
// its own page to video and returns the boxes a scene zooms to; a beat that cannot run throws, and the run lists it.
// Never press a page's first submit button: the app shell's own forms (organisation switch, sign-out) come first.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { APP, type Box, box } from "./lib.ts";
import { clickOn, glide, hoverOn, smoothScroll, typeInto } from "./cursor.ts";
import { appLink } from "./mail.ts";

export type BeatResult = {
  beat: string;
  video: string | null;
  stills: string[];
  caseId: string | null;
  // Seconds from the page's first frame to each moment a scene cuts or zooms on.
  marks: Record<string, number>;
  boxes: Record<string, Box | null>;
};

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

/**
 * This run's copy of a mail fixture with its own Message-ID and Date: the service claims each delivery by Message-ID or
 * hash, so a daily capture of the same file would otherwise be a duplicate of yesterday's (intake's duplicate window).
 */
// Every Fynbos Freight fact in a fixture is a {{path}} into the shared kit (data/demo/fynbos-freight/brand.json on main),
// never typed, so a change to the company reaches the demo the same day it reaches every other lane.
const BRAND = JSON.parse(readFileSync(new URL("../../data/demo/fynbos-freight/brand.json", import.meta.url), "utf8"));

/** A fixture's {{path}} placeholders filled from the brand kit; an unknown path is an error, never left in the mail. */
export function fillBrand(text: string, brand: unknown = BRAND): string {
  return text.replace(/\{\{([a-z_.]+)\}\}/g, (_, path: string) => {
    const value = path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], brand);
    if (typeof value !== "string") throw new Error(`fixture names {{${path}}}, which brand.json does not hold as text`);
    return value;
  });
}

export function freshCopy(fixture: string, outDir: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const text = fillBrand(readFileSync(join(FIXTURES, fixture), "utf8"))
    .replace(/^Message-ID: <([^@>]+)@/m, `Message-ID: <$1-${stamp}@`)
    .replace(/^Date: .*$/m, `Date: ${now.toUTCString().replace("GMT", "+0000")}`);
  const path = join(outDir, fixture);
  writeFileSync(path, text);
  return path;
}

async function finish(page: Page, beat: string, outDir: string, result: Omit<BeatResult, "video" | "beat">): Promise<BeatResult> {
  const video = page.video();
  await page.close();
  const path = video ? join(outDir, `${beat}.webm`) : null;
  if (video && path) await video.saveAs(path);
  return { beat, video: path, ...result };
}

/** Upload the lure, then follow its report from the first poll to the finished case. */
export async function uploadAndReport(ctx: BrowserContext, outDir: string, fixture = "tcg-waybill-zz3gghz.eml"): Promise<BeatResult> {
  const page = await ctx.newPage();
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / 100) / 10;
  const marks: Record<string, number> = {};
  const boxes: Record<string, Box | null> = {};
  await page.goto(`${APP}/upload`, { waitUntil: "networkidle" });
  if (page.url().includes("/signin")) throw new Error("not signed in");
  marks.uploadPage = at();
  // The file input is hidden inside its drop zone: the pointer goes to the zone's "Choose a file" a person would press.
  const zone = page.locator('label:has(input[name="file"]), [data-upload-zone], :has(> input[name="file"])').first();
  boxes.dropZone = await box(page, 'label:has(input[name="file"]), [data-upload-zone], :has(> input[name="file"])');
  await glide(page, 980, 300);
  await page.waitForTimeout(400);
  if (!(await hoverOn(page.getByText("Choose a file", { exact: true }), 900))) await hoverOn(zone, 900);
  // Pressing it opens the file chooser, answered with the lure; choosing the file sends the form (the upload page's app
  // script): there is no button to press. A zone that opens no chooser is given the file directly.
  const chooser = page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null);
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
  const lure = freshCopy(fixture, outDir);
  const opened = await chooser;
  await Promise.all([
    page.waitForURL(/\/r\/[^/]+/, { timeout: 60_000 }),
    opened ? opened.setFiles(lure) : page.setInputFiles('input[name="file"]', lure),
  ]);
  marks.fileChosen = at();
  marks.reportOpened = at();
  const caseId = new URL(page.url()).pathname.split("/")[2] ?? null;
  // While the case runs, the pointer follows the progress the page shows; a finished case answers once with no
  // trigger (report-live.tsx).
  await hoverOn(page.locator("#report-live"), 300);
  await page.waitForFunction(() => {
    const live = document.querySelector("#report-live");
    return !!live && !live.hasAttribute("hx-trigger");
  }, null, { timeout: 180_000, polling: 1000 });
  marks.finished = at();
  await page.waitForTimeout(800);
  boxes.report = await box(page, "#report-live");
  boxes.verdict = await box(page, "#report-live section, #report-live [data-verdict]");
  boxes.evidence = await box(page, '#report-live [aria-label="Evidence"], #report-live h2:has-text("Evidence")');
  await hoverOn(page.locator("#report-live h1, #report-live h2").first(), 900);
  const still = join(outDir, "report-finished.png");
  await page.screenshot({ path: still });
  // Walk down the evidence card by card: the pointer rests on each card's heading as the page scrolls to it.
  const headings = page.locator('#report-live section[aria-labelledby="evidence-heading"] .grid > *');
  const count = Math.min(await headings.count(), 7);
  for (let i = 0; i < count; i++) {
    const b = await headings.nth(i).boundingBox();
    if (!b) continue;
    if (b.y > 760) await smoothScroll(page, b.y - 380);
    const nb = await headings.nth(i).boundingBox();
    if (nb) await glide(page, nb.x + Math.min(nb.width / 2, 220), nb.y + Math.min(nb.height / 2, 40));
    if (i === 0) marks.evidenceStart = at();
    await page.waitForTimeout(900);
  }
  marks.scrolled = at();
  await page.waitForTimeout(600);
  const full = join(outDir, "report-full.png");
  await page.screenshot({ path: full, fullPage: true });
  return finish(page, "upload-and-report", outDir, { stills: [still, full], caseId, marks, boxes });
}

/** The protected identity page (/protect) with Fynbos Freight's registered name, trading name and logo. */
export async function protectIdentity(ctx: BrowserContext, outDir: string): Promise<BeatResult> {
  const page = await ctx.newPage();
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / 100) / 10;
  const marks: Record<string, number> = {};
  await page.goto(`${APP}/protect`, { waitUntil: "networkidle" });
  if (page.url().includes("/signin")) throw new Error("not signed in");
  marks.loaded = at();
  const boxes = {
    names: await box(page, 'section[aria-labelledby="names-heading"]'),
    logo: await box(page, 'section[aria-labelledby="logo-heading"]'),
    bank: await box(page, 'section[aria-labelledby="bank-heading"]'),
  };
  const still = join(outDir, "protect.png");
  await page.screenshot({ path: still });
  // A tour, never a change: the pointer reads each registered field, rests on the logo SAM 3.1 compares, and scrolls to
  // the bank ledger. Nothing on this page is pressed, so the demo organisation's identity is never edited.
  await glide(page, 900, 240);
  await hoverOn(page.locator('section[aria-label="Protection status"]'), 900);
  const names = page.locator('section[aria-labelledby="names-heading"]');
  const fields = names.locator("dd, textarea, input:not([type=hidden])");
  const n = Math.min(await fields.count(), 3);
  for (let i = 0; i < n; i++) await hoverOn(fields.nth(i), 700);
  marks.names = at();
  const logo = page.locator('section[aria-labelledby="logo-heading"] img').first();
  if (!(await hoverOn(logo, 1400))) await hoverOn(page.locator('section[aria-labelledby="logo-heading"]'), 1400);
  marks.logo = at();
  await smoothScroll(page, 420);
  marks.scrolled = at();
  const contact = page.locator(`input[name="contact"][value="${BRAND.mailboxes.accounts}"]`).locator("xpath=..");
  if (!(await hoverOn(contact, 1100))) await hoverOn(page.locator('section[aria-labelledby="bank-heading"]'), 1100);
  await hoverOn(page.locator('section[aria-labelledby="bank-heading"] h2, #bank-heading'), 1300);
  marks.bank = at();
  await page.waitForTimeout(600);
  const full = join(outDir, "protect-full.png");
  await page.screenshot({ path: full, fullPage: true });
  return finish(page, "protect", outDir, { stills: [still, full], caseId: null, marks, boxes });
}

/** The Domains and addresses page (/settings/domains) with Fynbos Freight's verified domain and sending addresses. */
export async function domainsList(ctx: BrowserContext, outDir: string): Promise<BeatResult> {
  const page = await ctx.newPage();
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / 100) / 10;
  const marks: Record<string, number> = {};
  await page.goto(`${APP}/settings/domains`, { waitUntil: "networkidle" });
  if (page.url().includes("/signin")) throw new Error("not signed in");
  marks.loaded = at();
  const boxes = {
    domains: await box(page, 'section[aria-labelledby="domains-heading"]'),
    addresses: await box(page, 'section[aria-labelledby="addresses-heading"]'),
  };
  const still = join(outDir, "domains.png");
  await page.screenshot({ path: still });
  await glide(page, 900, 260);
  await hoverOn(page.locator('section[aria-labelledby="domains-heading"] tbody tr').first(), 1400);
  marks.domains = at();
  const addrRows = page.locator('section[aria-labelledby="addresses-heading"] tbody tr');
  for (let i = 0; i < Math.min(await addrRows.count(), 3); i++) await hoverOn(addrRows.nth(i), 800);
  marks.addresses = at();
  const full = join(outDir, "domains-full.png");
  await page.screenshot({ path: full, fullPage: true });
  return finish(page, "domains", outDir, { stills: [still, full], caseId: null, marks, boxes });
}

/** The cases list: search it, filter it by verdict, and open a case from it. Every control here is a GET. */
export async function casesList(ctx: BrowserContext, outDir: string): Promise<BeatResult> {
  const page = await ctx.newPage();
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / 100) / 10;
  const marks: Record<string, number> = {};
  await page.goto(`${APP}/cases`, { waitUntil: "networkidle" });
  if (page.url().includes("/signin")) throw new Error("not signed in");
  marks.loaded = at();
  const still = join(outDir, "cases.png");
  await page.screenshot({ path: still });
  const boxes = { list: await box(page, "main table, main ul, main [role='list']") };
  const rows = page.locator('main a[href^="/r/"]');
  await glide(page, 1100, 300);
  for (let i = 0; i < Math.min(await rows.count(), 3); i++) await hoverOn(rows.nth(i), 450);
  const search = page.locator("#case-search");
  await typeInto(search, "SARS", 140);
  await page.waitForTimeout(1600);
  marks.searched = at();
  await hoverOn(rows.first(), 700);
  await clickOn(search);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(1400);
  await clickOn(page.locator("#case-filters label").filter({ hasText: /^Malicious$/ }));
  await page.waitForTimeout(1500);
  marks.filtered = at();
  await clickOn(page.locator("#case-filters label").filter({ hasText: /^All$/ }));
  await page.waitForTimeout(1300);
  await Promise.all([page.waitForURL(/\/r\/[^/]+/, { timeout: 30_000 }), clickOn(rows.first())]);
  await page.waitForLoadState("networkidle").catch(() => {});
  marks.opened = at();
  await hoverOn(page.locator("main h1, main h2").first(), 1500);
  return finish(page, "cases", outDir, { stills: [still], caseId: null, marks, boxes });
}

// The supplier the demo adds: fictional, with a fictional Protea Bank account (data/demo/fynbos-freight/brand.json
// names Protea Bank as the demo's bank). Added once; a later capture finds it and only tours the ledger.
const DEMO_SUPPLIER = { name: "Outeniqua Paper (Pty) Ltd", domain: "outeniquapaper.example", bank: "Protea Bank", branch: "000000", number: "0000004521", phone: "044 555 0142" };

/** The supplier ledger (/suppliers): add a supplier with its bank account, which is kept match-only, then read the list. */
export async function suppliersLedger(ctx: BrowserContext, outDir: string): Promise<BeatResult> {
  const page = await ctx.newPage();
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / 100) / 10;
  const marks: Record<string, number> = {};
  await page.goto(`${APP}/suppliers`, { waitUntil: "networkidle" });
  if (page.url().includes("/signin")) throw new Error("not signed in");
  marks.loaded = at();
  await glide(page, 1000, 300);
  const listed = page.locator("main table, main ul").getByText(DEMO_SUPPLIER.name).first();
  if (!(await listed.isVisible().catch(() => false))) {
    await typeInto(page.locator("#add-name"), DEMO_SUPPLIER.name, 40);
    await typeInto(page.locator("#add-domain"), DEMO_SUPPLIER.domain, 40);
    await typeInto(page.locator("#add-bank"), DEMO_SUPPLIER.bank, 40);
    await typeInto(page.locator("#add-branch"), DEMO_SUPPLIER.branch, 60);
    await typeInto(page.locator("#add-number"), DEMO_SUPPLIER.number, 60);
    await typeInto(page.locator("#add-phone"), DEMO_SUPPLIER.phone, 50);
    marks.typed = at();
    await Promise.all([
      page.waitForLoadState("networkidle").catch(() => {}),
      clickOn(page.locator("#add-supplier button[type=submit]").first(), 500),
    ]);
    await page.waitForTimeout(1500);
    marks.saved = at();
  }
  // The ledger shows the account by its last digits only: the full number is never shown again.
  await hoverOn(page.locator("main table tr, main ul li").filter({ hasText: DEMO_SUPPLIER.name }).first(), 1600);
  marks.listed = at();
  const still = join(outDir, "suppliers.png");
  await page.screenshot({ path: still });
  await hoverOn(page.locator("#import-heading"), 1200);
  marks.importShown = at();
  return finish(page, "suppliers", outDir, { stills: [still], caseId: null, marks, boxes: { list: await box(page, "main table") } });
}

/** Compose and send the suspicious .eml from demo@rizonetech.com in Outlook on the web to check@isitlegit.co.za, and capture the reply. */
export async function mailSend(ctx: BrowserContext, outDir: string, fixture = "tcg-waybill-zz3gghz.eml"): Promise<BeatResult> {
  const page = await ctx.newPage();
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / 100) / 10;
  const marks: Record<string, number> = {};
  const boxes: Record<string, Box | null> = {};
  const stills: string[] = [];
  await page.goto("https://outlook.office.com/mail/inbox", { waitUntil: "domcontentloaded" });
  if (page.url().includes("login.microsoftonline.com")) throw new Error("the demo mailbox is signed out: run pnpm capture:demo signin-mailbox");
  await page.waitForTimeout(5000);
  const dismiss = page.getByRole("button", { name: /^(Continue|Close|Got it|OK)$/ }).first();
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
  marks.inbox = at();
  const replySubject = /Verify SA Waybill ZZ3GGHZ|Karoo Mail storage|your IsItLegit check/i;
  // The reply joins the forwarded message's conversation, so the inbox row count may not grow: the newest matching
  // row's text (its count and time) changing is the arrival.
  // A new reply is one stamped with a minute after the send (Outlook shows today's mail as HH:MM, Johannesburg time):
  // the inbox rows' text also changes when Outlook regroups them (Today becoming Yesterday), which is no arrival.
  const minute = (t: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" }).format(t);
  const freshReply = (since: number) => {
    const stamps = new Set<string>();
    for (let t = since - 60_000; t <= Date.now() + 60_000; t += 30_000) stamps.add(minute(t));
    return page.locator('div[role="option"]').filter({ hasText: replySubject }).filter({ hasText: /IsItLegit/ }).filter({ hasText: new RegExp(`\\b(${[...stamps].join("|")})\\b`) });
  };
  // The pointer runs down the lures already in the inbox, then opens a new message the way a person would.
  await glide(page, 700, 400);
  const inboxItems = page.locator('div[role="option"]');
  for (let i = 0; i < Math.min(await inboxItems.count(), 3); i++) await hoverOn(inboxItems.nth(i), 350);
  const toField = page.locator('div[aria-label="To"]').first();
  if (!(await toField.isVisible().catch(() => false))) {
    await clickOn(page.getByRole("button", { name: /New mail/i }).first());
    await page.waitForTimeout(2500);
  }
  marks.composeOpened = at();
  await clickOn(toField);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("check@isitlegit.co.za", { delay: 70 });
  await page.waitForTimeout(1500);
  await page.keyboard.press("Enter");
  marks.addressed = at();
  await page.waitForTimeout(700);
  const subject = page.locator('input[aria-label="Subject"]').first();
  await clickOn(subject);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("Fwd: Urgent Action: Verify SA Waybill ZZ3GGHZ - TCG-ZZ3GGHZ", { delay: 22 });
  await page.waitForTimeout(400);
  const bodyField = page.locator('div[aria-label="Message body"]').first();
  await clickOn(bodyField);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("Is this real? Please check.", { delay: 45 });
  await page.waitForTimeout(500);
  const eml = freshCopy(fixture, outDir);
  if (!(await page.locator('[role="main"]').getByText(fixture).isVisible().catch(() => false))) {
    await clickOn(page.locator('button[aria-label="Attach file"]').first());
    await page.waitForTimeout(700);
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      clickOn(page.getByRole("menuitem", { name: /Browse this computer/i }).first()),
    ]);
    await chooser.setFiles(eml);
    await page.waitForTimeout(3000);
  }
  marks.composed = at();
  boxes.compose = await box(page, '[role="main"]');
  boxes.sendButton = await box(page, 'button[aria-label="Send"]');
  const composeStill = join(outDir, "mail-compose.png");
  await page.screenshot({ path: composeStill });
  stills.push(composeStill);
  await clickOn(page.locator('button[aria-label="Send"]').first(), 600);
  marks.sent = at();
  const sentAt = Date.now();
  await page.waitForTimeout(3000);
  let caseId: string | null = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const items = freshReply(sentAt);
    if ((await items.count()) > 0) {
      marks.replyArrived = at();
      await clickOn(items.first(), 500);
      await page.waitForTimeout(2500);
      const showBlocked = page.getByRole("button", { name: /Show blocked content|Trust sender/i }).first();
      if (await showBlocked.isVisible().catch(() => false)) {
        await clickOn(showBlocked);
        await page.waitForTimeout(1500);
      }
      marks.replied = at();
      boxes.reply = await box(page, '[role="main"]');
      const replyStill = join(outDir, "mail-reply.png");
      await page.screenshot({ path: replyStill });
      stills.push(replyStill);
      // The pointer reads the verdict line, then rests on the signed report link.
      await hoverOn(page.locator('[role="main"] a[href*="isitlegit.co.za/r/"]').first(), 1500);
      marks.link = at();
      const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
      const link = appLink(hrefs);
      if (link) caseId = new URL(link).pathname.split("/")[2] ?? null;
      break;
    }
    await page.waitForTimeout(5000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
  }
  return finish(page, "mail-send", outDir, { stills, caseId, marks, boxes });
}

const SEED_LURES = [
  { fixture: "sars-summon-iv16.eml", subject: "Fw: SARS SUMMON STATEMENT - IV16 CORRESPONDENCE", note: "Forwarding this SARS IV16 summons notice for verification." },
  { fixture: "buffalo-logistics-shipment.eml", subject: "Fwd: Your Buffalo Logistics shipment - status update (JD014600011161686430)", note: "Forwarding this Buffalo Logistics customs hold notice for verification." },
  { fixture: "doj-default-judgement.eml", subject: "Fwd: Default Judgement - Final Notice (demo@rizonetech.com)", note: "Forwarding this DOJ default judgement notice for verification." },
  { fixture: "coupa-po-5000916586.eml", subject: "Fwd: Reminder to Acknowledge Samancor Chrome Purchase Order #5000916586", note: "Forwarding this Coupa purchase order notice for verification." },
] as const;

/** Seed demo@rizonetech.com's Outlook inbox and Fynbos Freight's /cases console with the retargeted lures. */
export async function seedLures(ctx: BrowserContext, outDir: string): Promise<string[]> {
  const page = await ctx.newPage();
  const sent: string[] = [];
  try {
    await page.goto("https://outlook.office.com/mail/inbox", { waitUntil: "domcontentloaded" });
    if (page.url().includes("login.microsoftonline.com")) throw new Error("the demo mailbox is signed out: run pnpm capture:demo signin-mailbox");
    await page.waitForTimeout(5000);
    const dismiss = page.getByRole("button", { name: /^(Continue|Close|Got it|OK)$/ }).first();
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
    for (const lure of SEED_LURES) {
      const toField = page.locator('div[aria-label="To"]').first();
      if (!(await toField.isVisible().catch(() => false))) {
        await page.getByRole("button", { name: /New mail/i }).first().click();
        await page.waitForTimeout(2500);
      }
      await toField.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type("check@isitlegit.co.za", { delay: 35 });
      await page.waitForTimeout(1500);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      await page.keyboard.type("demo@rizonetech.com", { delay: 35 });
      await page.waitForTimeout(1200);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
      await page.locator('input[aria-label="Subject"]').first().fill(lure.subject);
      await page.waitForTimeout(400);
      const bodyField = page.locator('div[aria-label="Message body"]').first();
      await bodyField.click();
      await bodyField.fill(lure.note);
      await page.waitForTimeout(500);
      const eml = freshCopy(lure.fixture, outDir);
      await page.locator('button[aria-label="Attach file"]').first().click();
      await page.waitForTimeout(800);
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        page.getByRole("menuitem", { name: /Browse this computer/i }).first().click(),
      ]);
      await chooser.setFiles(eml);
      await page.waitForTimeout(3000);
      await page.locator('button[aria-label="Send"]').first().click();
      await page.waitForTimeout(3500);
      sent.push(lure.fixture);
    }
  } finally {
    await page.close();
  }
  return sent;
}
