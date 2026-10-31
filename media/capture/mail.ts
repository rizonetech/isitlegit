// Reading the demo mailbox in Outlook on the web: the app's sign-in and sign-up mails arrive there, and the rig opens
// their link itself. Field and button names were read from the live Outlook page (2026-10-31).
import type { BrowserContext, Page } from "playwright-core";
import { APP } from "./lib.ts";

const OUTLOOK = "https://outlook.office.com/mail/inbox";

/** A link to the app in a mail body, unwrapped when Safe Links has rewritten it; null when none is there. */
export function appLink(hrefs: string[], app = APP): string | null {
  const host = new URL(app).host;
  for (const href of hrefs) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.host.endsWith("safelinks.protection.outlook.com")) {
      const inner = url.searchParams.get("url");
      if (inner) return appLink([inner], app);
      continue;
    }
    if (url.host === host) return url.toString();
  }
  return null;
}

async function dismissDialogs(page: Page): Promise<void> {
  const b = page.getByRole("button", { name: /^(Continue|Close|Got it|OK)$/ }).first();
  if (await b.isVisible().catch(() => false)) await b.click();
}

/**
 * Wait for the newest mail whose subject matches, open it and return its link to the app, then delete the mail so the
 * inbox stays empty for the next take.
 */
export async function waitForAppLink(ctx: BrowserContext, subject: RegExp, timeoutMs = 120_000): Promise<string> {
  const page = await ctx.newPage();
  try {
    await page.goto(OUTLOOK, { waitUntil: "domcontentloaded" });
    if (page.url().includes("login.microsoftonline.com")) throw new Error("the demo mailbox is signed out: run `pnpm capture:demo signin-mailbox`");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(5000);
      await dismissDialogs(page);
      const item = page.locator('div[role="option"]').filter({ hasText: subject }).first();
      if (await item.count()) {
        await item.click();
        await page.waitForTimeout(2500);
        const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
        const link = appLink(hrefs);
        if (!link) throw new Error(`the mail matching ${subject} holds no link to ${APP}`);
        await page.keyboard.press("Delete");
        await page.waitForTimeout(1500);
        return link;
      }
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    throw new Error(`no mail matching ${subject} within ${timeoutMs / 1000} s`);
  } finally {
    await page.close();
  }
}
