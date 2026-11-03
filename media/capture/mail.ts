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

async function inbox(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(OUTLOOK, { waitUntil: "domcontentloaded" });
  if (page.url().includes("login.microsoftonline.com")) {
    await page.close();
    throw new Error("the demo mailbox is signed out: run `pnpm capture:demo signin-mailbox`");
  }
  await page.waitForTimeout(5000);
  await dismissDialogs(page);
  return page;
}

const matching = (page: Page, subject: RegExp) => page.locator('div[role="option"]').filter({ hasText: subject });

/**
 * Watch the inbox for the next mail whose subject matches. The demo mailbox is protected (operator, 2026-10-31): the
 * rig never deletes or moves its mail, so earlier sign-in mails stay, and only a mail that arrives after the watch
 * began is taken. Start the watch, then make the request that sends the mail, then call `next()`.
 */
export async function watchForAppLink(ctx: BrowserContext, subject: RegExp): Promise<{ next: (timeoutMs?: number) => Promise<string> }> {
  const page = await inbox(ctx);
  const before = await matching(page, subject).count();
  return {
    async next(timeoutMs = 120_000) {
      try {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await page.waitForTimeout(5000);
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForTimeout(4000);
          await dismissDialogs(page);
          const items = matching(page, subject);
          if ((await items.count()) > before) {
            // Outlook lists the newest first.
            await items.first().click();
            await page.waitForTimeout(2500);
            const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
            const link = appLink(hrefs);
            if (!link) throw new Error(`the mail matching ${subject} holds no link to ${APP}`);
            return link;
          }
        }
        throw new Error(`no new mail matching ${subject} within ${timeoutMs / 1000} s`);
      } finally {
        await page.close();
      }
    },
  };
}

/** Sign the persistent profile in to Outlook on the web, with the password in CAPTURE_MAILBOX_PASSWORD only. */
export async function signInMailbox(ctx: BrowserContext, mailbox: string): Promise<void> {
  const password = process.env.CAPTURE_MAILBOX_PASSWORD;
  if (!password) throw new Error("CAPTURE_MAILBOX_PASSWORD is not set: read it from the vault item 'IsItLegit demo mailbox'");
  const page = await ctx.newPage();
  try {
    await page.goto(OUTLOOK, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (page.url().includes("login.microsoftonline.com")) {
      await page.fill('input[name="loginfmt"]', mailbox);
      await page.click("#idSIButton9");
      await page.waitForSelector('input[name="passwd"]', { timeout: 20_000 });
      await page.fill('input[name="passwd"]', password);
      await page.click("#idSIButton9");
      await page.waitForTimeout(5000);
      // "Stay signed in?": yes, so the session outlives this browser.
      if ((await page.textContent("body"))?.includes("Stay signed in")) await page.click("#idSIButton9");
      await page.waitForURL(/outlook\.(office|cloud\.microsoft)/, { timeout: 45_000 });
    }
  } finally {
    await page.close();
  }
}
