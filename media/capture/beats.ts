// The demo's beats that run on the live service today (docs/specs/2026-10-31-demo-video-design.md, "Shipped today"):
// a member uploads a synthetic lure, the report fills in live, and the case joins the cases list. Each beat records
// its own page to video and returns the boxes a scene zooms to; a beat that cannot run throws, and the run lists it.
// Never press a page's first submit button: the app shell's own forms (organisation switch, sign-out) come first.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { APP, type Box, box } from "./lib.ts";
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
  boxes.dropZone = await box(page, 'input[name="file"]');
  await page.waitForTimeout(1500);
  // Choosing the file sends the form (the upload page's app script): there is no button to press.
  await Promise.all([page.waitForURL(/\/r\/[^/]+/, { timeout: 60_000 }), page.setInputFiles('input[name="file"]', freshCopy(fixture, outDir))]);
  marks.fileChosen = at();
  marks.reportOpened = at();
  const caseId = new URL(page.url()).pathname.split("/")[2] ?? null;
  // A running case polls #report-live every 2 s; a finished one answers once with no trigger (report-live.tsx).
  await page.waitForFunction(() => {
    const live = document.querySelector("#report-live");
    return !!live && !live.hasAttribute("hx-trigger");
  }, null, { timeout: 180_000, polling: 1000 });
  marks.finished = at();
  await page.waitForTimeout(1500);
  boxes.report = await box(page, "#report-live");
  boxes.verdict = await box(page, "#report-live section, #report-live [data-verdict]");
  boxes.evidence = await box(page, '#report-live [aria-label="Evidence"], #report-live h2:has-text("Evidence")');
  const still = join(outDir, "report-finished.png");
  await page.screenshot({ path: still });
  // Walk down the evidence so the take shows every card.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 540) {
    await page.mouse.wheel(0, 540);
    await page.waitForTimeout(900);
  }
  marks.scrolled = at();
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
  await page.waitForTimeout(1800);
  const still = join(outDir, "protect.png");
  await page.screenshot({ path: still });
  await page.mouse.wheel(0, 480);
  marks.scrolled = at();
  await page.waitForTimeout(1800);
  const full = join(outDir, "protect-full.png");
  await page.screenshot({ path: full, fullPage: true });
  return finish(page, "protect", outDir, { stills: [still, full], caseId: null, marks, boxes });
}

/** The cases list with the new case at its top. */
export async function casesList(ctx: BrowserContext, outDir: string): Promise<BeatResult> {
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`${APP}/cases`, { waitUntil: "networkidle" });
  if (page.url().includes("/signin")) throw new Error("not signed in");
  await page.waitForTimeout(2500);
  const still = join(outDir, "cases.png");
  await page.screenshot({ path: still });
  const boxes = { list: await box(page, "main table, main ul, main [role='list']") };
  return finish(page, "cases", outDir, { stills: [still], caseId: null, marks: { loaded: Math.round((Date.now() - t0) / 100) / 10 }, boxes });
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
  const before = await page.locator('div[role="option"]').filter({ hasText: replySubject }).count();
  const toField = page.locator('div[aria-label="To"]').first();
  if (!(await toField.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /New mail/i }).first().click();
    await page.waitForTimeout(2500);
  }
  marks.composeOpened = at();
  await toField.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("check@isitlegit.co.za", { delay: 40 });
  await page.waitForTimeout(1500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
  await page.locator('input[aria-label="Subject"]').first().fill("Fwd: Urgent Action: Verify SA Waybill ZZ3GGHZ - TCG-ZZ3GGHZ");
  await page.waitForTimeout(500);
  const bodyField = page.locator('div[aria-label="Message body"]').first();
  await bodyField.click();
  await bodyField.fill("Forwarding this Courier Guy waybill security notice to check@isitlegit.co.za for verification.");
  await page.waitForTimeout(600);
  const eml = freshCopy(fixture, outDir);
  if (!(await page.locator('[role="main"]').getByText(fixture).isVisible().catch(() => false))) {
    await page.locator('button[aria-label="Attach file"]').first().click();
    await page.waitForTimeout(800);
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      page.getByRole("menuitem", { name: /Browse this computer/i }).first().click(),
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
  await page.locator('button[aria-label="Send"]').first().click();
  marks.sent = at();
  await page.waitForTimeout(3000);
  let caseId: string | null = null;
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    const items = page.locator('div[role="option"]').filter({ hasText: replySubject });
    if ((await items.count()) > before) {
      await items.first().click();
      await page.waitForTimeout(2500);
      const showBlocked = page.getByRole("button", { name: /Show blocked content|Trust sender/i }).first();
      if (await showBlocked.isVisible().catch(() => false)) {
        await showBlocked.click();
        await page.waitForTimeout(1500);
      }
      marks.replied = at();
      boxes.reply = await box(page, '[role="main"]');
      const replyStill = join(outDir, "mail-reply.png");
      await page.screenshot({ path: replyStill });
      stills.push(replyStill);
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
