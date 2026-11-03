// Signing the demo member in to the live app. The app mails a scanner-safe link (src/auth/confirm.tsx): the link opens
// a page with one button, and the button's POST signs in. The rig reads that mail in the demo mailbox and presses it.
// Sign-up takes the invite code from CAPTURE_INVITE only (read from the vault by the caller, never argv), on a page
// that is never recorded or screenshotted, so the code reaches no frame and no file.
import type { BrowserContext, Page } from "playwright-core";
import { APP, MAILBOX, ORGANISATION } from "./lib.ts";
import { watchForAppLink } from "./mail.ts";

const LINK_MAIL = /Your IsItLegit sign-in link/;

/** True when the app answers /cases with the member's page rather than the sign-in gate. */
export async function signedIn(ctx: BrowserContext): Promise<boolean> {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(`${APP}/cases`, { waitUntil: "domcontentloaded" });
    return !!res && res.status() === 200 && !page.url().includes("/signin");
  } finally {
    await page.close();
  }
}

async function pressConfirm(page: Page, link: string): Promise<void> {
  await page.goto(link, { waitUntil: "domcontentloaded" });
  await page.locator('form[action="/signin/confirm"] button[type="submit"]').click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);
}

/** Request a sign-in link for the demo mailbox, read it from Outlook and press the confirm button. */
export async function signIn(ctx: BrowserContext): Promise<void> {
  const page = await ctx.newPage();
  try {
    const mail = await watchForAppLink(ctx, LINK_MAIL);
    await page.goto(`${APP}/signin`, { waitUntil: "domcontentloaded" });
    await page.fill("#signin-email", MAILBOX);
    await page.locator('form[action="/signin/link"] button[type="submit"]').click();
    await page.waitForLoadState("domcontentloaded");
    await pressConfirm(page, await mail.next());
  } finally {
    await page.close();
  }
  if (!(await signedIn(ctx))) throw new Error("the sign-in link did not sign the demo member in");
}

/**
 * Create the demo member and its organisation with the invite code in CAPTURE_INVITE. Each submit spends one of the
 * code's uses, so this runs once, by hand (`pnpm capture:demo signup`), never as part of a capture.
 */
export async function signUp(ctx: BrowserContext): Promise<void> {
  const invite = process.env.CAPTURE_INVITE;
  if (!invite) throw new Error("CAPTURE_INVITE is not set: read it from the vault item 'IsItLegit demo invite code'");
  const page = await ctx.newPage();
  try {
    const mail = await watchForAppLink(ctx, LINK_MAIL);
    await page.goto(`${APP}/signup`, { waitUntil: "domcontentloaded" });
    await page.fill("#signup-invite", invite);
    await page.fill("#signup-email", MAILBOX);
    await page.fill("#signup-organisation", ORGANISATION);
    await page.check("#signup-consent");
    // 201 is the account made and its link mailed (src/auth/confirm.tsx); anything else re-draws the form with the
    // fields' errors, whose status alone is reported (the re-drawn form holds the code, so its text is never read).
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/signup"),
      page.locator('form[action="/signup"] button[type="submit"]').click(),
    ]);
    if (res.status() !== 201) throw new Error(`sign-up refused with status ${res.status()} (409: the address has an account; 400: a field or the code)`);
    await pressConfirm(page, await mail.next());
  } finally {
    await page.close();
  }
  if (!(await signedIn(ctx))) throw new Error("sign-up finished but the demo member is not signed in");
}
