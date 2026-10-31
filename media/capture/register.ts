// pnpm capture:demo protect: register Fynbos Freight's protected identity through the member's own /protect page
// (D09 T02 §3), with the values in data/demo/fynbos-freight/brand.json. It only adds or overwrites the identity's
// fields; nothing here deletes. Every control is scoped to the page's own forms (the shell's sign-out form is never
// near it). If the page refuses a value the step throws with the page's own message, and nothing is worked around.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { APP } from "./lib.ts";

const DEMO = new URL("../../data/demo/fynbos-freight/", import.meta.url).pathname;
const brand = JSON.parse(readFileSync(join(DEMO, "brand.json"), "utf8")) as { name: string; legal_name: string };
export const LOGO = join(DEMO, "logo", "mark.svg");

export type Registered = { names: string[]; protectedOn: boolean; logo: boolean; domainsPage: number | null; still: string };

/** The page's own message after a save: its status banner or error, as text. */
async function message(page: import("playwright-core").Page): Promise<string> {
  const el = page.locator('[role="alert"], [role="status"], .flash, .error').first();
  return (await el.count()) ? (await el.innerText()).trim() : "";
}

export async function registerIdentity(ctx: BrowserContext, outDir: string): Promise<Registered> {
  mkdirSync(outDir, { recursive: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${APP}/protect`, { waitUntil: "networkidle" });
  if (page.url().includes("/signin")) throw new Error("the demo member is signed out");
  // The legal name is a trading name beside the registered one, so mail that claims either is caught.
  await page.locator('textarea[name="tradingNames"]').fill(`${brand.name}\n${brand.legal_name}`);
  await page.locator('input[name="protected"]').check();
  await page.getByRole("button", { name: "Save identity" }).click();
  await page.waitForLoadState("networkidle");
  const saved = await message(page);
  if (/can.?t|cannot|not allowed|invalid|refus|error|wrong/i.test(saved)) throw new Error(`the page refused the identity: ${saved}`);
  // The logo goes in a form of its own once the identity exists.
  const logoForm = page.locator("form").filter({ has: page.locator('input[name="logo"]') });
  await logoForm.locator('input[name="logo"]').setInputFiles(LOGO);
  await logoForm.getByRole("button", { name: "Add logo" }).click();
  await page.waitForLoadState("networkidle");
  const logoMsg = await message(page);
  if (/can.?t|cannot|not allowed|invalid|refus|error|wrong|sanitis/i.test(logoMsg)) throw new Error(`the page refused the logo: ${logoMsg}`);
  // Read it back from a fresh load.
  await page.goto(`${APP}/protect`, { waitUntil: "networkidle" });
  const names = (await page.locator('textarea[name="tradingNames"]').inputValue()).split("\n").map((n) => n.trim()).filter(Boolean);
  const protectedOn = await page.locator('input[name="protected"]').isChecked();
  const logo = (await page.locator('main img[src*="logo"], main img[alt*="ogo"]').count()) > 0;
  const still = join(outDir, "protect-identity.png");
  await page.screenshot({ path: still, fullPage: true });
  const domains = await page.goto(`${APP}/settings/domains`);
  return { names, protectedOn, logo, domainsPage: domains?.status() ?? null, still };
}
