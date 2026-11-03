// pnpm capture:demo protect: register Fynbos Freight's protected identity through the member's own /protect page
// (D09 T02 §3), with the values in data/demo/fynbos-freight/brand.json. It only adds or overwrites the identity's
// fields; nothing here deletes. Every control is scoped to the page's own forms (the shell's sign-out form is never
// near it). If the page refuses a value the step throws with the page's own message, and nothing is worked around.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { APP } from "./lib.ts";

const DEMO = new URL("../../data/demo/fynbos-freight/", import.meta.url).pathname;
const brand = JSON.parse(readFileSync(join(DEMO, "brand.json"), "utf8")) as {
  name: string;
  legal_name: string;
  mailboxes: { accounts: string };
};
export const LOGO = join(DEMO, "logo", "mark.svg");

export type Registered = {
  names: string[];
  financeContact: string | null;
  protectedOn: boolean;
  statusBanner: string;
  publicPage: string | null;
  logo: boolean;
  domainsPage: number | null;
  still: string;
  domainsStill: string;
};

/** Any visible refusal alert on the page after a form submission. */
async function alertMessage(page: import("playwright-core").Page): Promise<string> {
  const alerts = page.locator('[role="alert"]:visible');
  const count = await alerts.count();
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = (await alerts.nth(i).innerText()).trim();
    if (t) parts.push(t);
  }
  return parts.join(" | ");
}

export async function registerIdentity(ctx: BrowserContext, outDir: string): Promise<Registered> {
  mkdirSync(outDir, { recursive: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${APP}/protect`, { waitUntil: "networkidle" });
  if (page.url().includes("/signin")) throw new Error("the demo member is signed out");
  const registeredName = (await page.locator('section[aria-labelledby="names-heading"] dd').first().innerText()).trim();
  if (registeredName !== brand.name) {
    throw new Error(`expected registered name "${brand.name}", found "${registeredName}"`);
  }
  const financeSelector = `input[name="contact"][value="${brand.mailboxes.accounts}"]`;
  if ((await page.locator(financeSelector).count()) === 0) {
    throw new Error(`finance contact option "${brand.mailboxes.accounts}" is missing on /protect`);
  }
  const hasLogo = () =>
    page
      .locator('section[aria-labelledby="logo-heading"] img[src^="/protect/logo"]')
      .count()
      .then((n) => n > 0);
  // Upload the logo only if it is missing; if the logo input is disabled until the identity is saved, save first.
  if (!(await hasLogo())) {
    if (await page.locator('input[name="logo"]').isDisabled()) {
      await page.locator('textarea[name="tradingNames"]').fill(`${brand.name}\n${brand.legal_name}`);
      await page.locator(financeSelector).check();
      await page.getByRole("button", { name: "Save identity" }).click();
      await page.waitForLoadState("networkidle");
      const err = await alertMessage(page);
      if (err) throw new Error(`the page refused the identity: ${err}`);
    }
    const logoForm = page.locator("form").filter({ has: page.locator('input[name="logo"]') });
    await logoForm.locator('input[name="logo"]').setInputFiles(LOGO);
    await logoForm.getByRole("button", { name: /Add logo|Replace logo/ }).click();
    await page.waitForLoadState("networkidle");
    const logoErr = await alertMessage(page);
    if (logoErr) throw new Error(`the page refused the logo: ${logoErr}`);
  }
  // Set trading names, set finance contact to accounts@fynbosfreight.demo.isitlegit.co.za, and switch protection on.
  await page.locator('textarea[name="tradingNames"]').fill(`${brand.name}\n${brand.legal_name}`);
  await page.locator(financeSelector).check();
  await page.locator('input[name="protected"]').check();
  await page.getByRole("button", { name: "Save identity" }).click();
  await page.waitForLoadState("networkidle");
  const saveErr = await alertMessage(page);
  if (saveErr) throw new Error(`the page refused saving protection: ${saveErr}`);
  // Read it back from a fresh load.
  await page.goto(`${APP}/protect`, { waitUntil: "networkidle" });
  const regName = (await page.locator('section[aria-labelledby="names-heading"] dd').first().innerText()).trim();
  const trading = (await page.locator('textarea[name="tradingNames"]').inputValue())
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);
  const names = [regName, ...trading.filter((n) => n !== regName)];
  const checkedContact = page.locator('input[name="contact"]:checked');
  const financeContact = (await checkedContact.count()) ? await checkedContact.getAttribute("value") : null;
  const protectedOn = await page.locator('input[name="protected"]').isChecked();
  const statusBanner = (await page.locator('section[aria-label="Protection status"]').innerText()).trim().replace(/\s+/g, " ");
  if (!protectedOn || /not protected|paused/i.test(statusBanner)) {
    throw new Error(`protection did not activate: ${statusBanner}`);
  }
  const pubLink = page.locator('section[aria-labelledby="public-page-heading"] a');
  const publicPage = (await pubLink.count()) ? (await pubLink.first().innerText()).trim() : null;
  const logo = await hasLogo();
  const still = join(outDir, "protect-identity.png");
  await page.screenshot({ path: still, fullPage: true });
  const domains = await page.goto(`${APP}/settings/domains`, { waitUntil: "networkidle" });
  const domainsStill = join(outDir, "domains.png");
  await page.screenshot({ path: domainsStill, fullPage: true });
  return {
    names,
    financeContact,
    protectedOn,
    statusBanner,
    publicPage,
    logo,
    domainsPage: domains?.status() ?? null,
    still,
    domainsStill,
  };
}
