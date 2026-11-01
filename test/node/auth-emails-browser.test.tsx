import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimCodeEmail, inviteEmail, signinEmail } from "../../src/mail/templates/auth-mail";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

// The sign-in, invitation and verification-code emails in Chromium (D07 T08 §6), each HTML part set into a page at a phone
// and a desktop width, with long names and images blocked: no sideways scroll, the link and code inside the column, named
// links the keyboard reaches, the alt text readable where an image is blocked, and the accessibility rules (contrast
// included) on the rendered mail.
const APP = "https://app.isitlegit.co.za";
const LONG = "Karoo-Courier-and-Logistics-Holdings-".repeat(4);
const at = new Date("2026-10-27T07:14:00.000Z");
const mails = {
  signin: signinEmail({
    appUrl: APP,
    email: `${"a".repeat(60)}@${"b".repeat(60)}.example`,
    link: `${APP}/auth/confirm?token=${"V2h5IGFyZSB5b3U".repeat(8)}`,
    code: "482 917",
    lifetimeSeconds: 900,
    requestedAt: at,
  }),
  invite: inviteEmail({
    appUrl: APP,
    inviter: `Thandi ${LONG}`,
    organisation: LONG,
    role: "member",
    link: `${APP}/invite/inv_3Jd82kQp`,
    expiresAt: new Date("2026-10-29T08:02:00.000Z"),
    lifetimeSeconds: 48 * 3600,
  }),
  domain: claimCodeEmail({
    appUrl: APP,
    kind: "domain",
    what: `${LONG}.example`,
    code: "482917",
    lifetimeSeconds: 1800,
    expiresAt: new Date(at.getTime() + 1_800_000),
  }),
  address: claimCodeEmail({
    appUrl: APP,
    kind: "address",
    what: `${"x".repeat(60)}@gmail.com`,
    code: "482917",
    lifetimeSeconds: 1800,
    expiresAt: new Date(at.getTime() + 1_800_000),
  }),
};

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!chromiumPath() && !process.env.CI)("the auth emails in Chromium", { timeout: 120_000 }, () => {
  for (const width of [360, 1280]) {
    it(`render inside the column with named focusable links, readable alt text and passing rules at ${width} px`, async () => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      // The mail client blocks images: the logo's alt text is what shows.
      await ctx.route("**/*", (route) =>
        route.request().resourceType() === "image" ? route.abort() : route.fulfill({ status: 204 }),
      );
      for (const [name, mail] of Object.entries(mails)) {
        const p = await ctx.newPage();
        await p.setContent(mail.html, { waitUntil: "load" });
        expect(await p.evaluate(() => document.documentElement.scrollWidth), `${name} scroll`).toBeLessThanOrEqual(
          width,
        );
        // Every link and the code stay inside the viewport's column.
        const outside = await p.evaluate(
          (w) =>
            [...document.querySelectorAll("a, p, h1")].filter((el) => el.getBoundingClientRect().right > w + 1).length,
          width,
        );
        expect(outside, `${name} overflow`).toBe(0);
        // The logo's alt text is readable with the image blocked.
        expect(await p.getByRole("img", { name: "IsItLegit" }).count(), name).toBe(1);
        // A link has a name and Tab reaches it (the code email has none to click).
        const links = await p.getByRole("link").all();
        if (name === "domain" || name === "address") expect(links.length, name).toBe(0);
        else {
          expect(links.length, name).toBeGreaterThanOrEqual(2);
          for (const link of links) expect(((await link.textContent()) ?? "").trim().length, name).toBeGreaterThan(0);
          await p.keyboard.press("Tab");
          expect(await p.evaluate(() => document.activeElement?.tagName), name).toBe("A");
        }
        await p.addScriptTag({ path: AXE });
        expect(problems(await scan(p)), `${name} rules`).toEqual([]);
        await p.close();
      }
      await ctx.close();
    });
  }
});
