// The demo's beats that run on the live service today (docs/specs/2026-10-31-demo-video-design.md, "Shipped today"):
// a member uploads a synthetic lure, the report fills in live, and the case joins the cases list. Each beat records
// its own page to video and returns the boxes a scene zooms to; a beat that cannot run throws, and the run lists it.
// Never press a page's first submit button: the app shell's own forms (organisation switch, sign-out) come first.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { APP, type Box, box } from "./lib.ts";

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
export async function uploadAndReport(ctx: BrowserContext, outDir: string, fixture = "karoo-mail-storage.eml"): Promise<BeatResult> {
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
