import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReportVerdict } from "../../src/web/pages/report-verdict";
import { ReportDocument } from "../../src/web/pages/report-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

// A signed link's report invites its reader to sign in and come back (D07 T03 §26), drawn in Chromium with the shipped
// stylesheet: the footer's Sign in visible, reached by keyboard, its address the sign-in with the report's own path as
// `next`, and the page passing the accessibility gate's rules at a phone's and a desktop's width in both themes. The
// round trip through sign-in itself is test/web/report-access.test.ts's, since sign-in's mail is not reachable here.
const APP = "http://localhost";
const PUBLIC = join(import.meta.dirname, "../../public");
const ID = "01JCASE0000000000000000000";
const LINK = "?o=org&e=1793664000&s=sig";
const VERDICT: ReportVerdict = {
  verdict: "malicious",
  headline: "A lookalike bank asks for a new account.",
  confidence: 0.9,
  reasons: ["A lookalike domain."],
  actions: ["Do not pay."],
};
const html = String(
  <ReportDocument
    stored={{
      id: ID,
      status: "done",
      verdict: "malicious",
      sourceKind: "mail",
      channel: "email",
      createdAt: "2026-10-27T07:14:00Z",
    }}
    verdict={VERDICT}
    evidence={[]}
    shell={null}
    link={LINK}
    linkExpires={1793664000}
  />,
);

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});
async function open(width: number, theme: "light" | "dark") {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p: Page = await context.newPage();
  await p.route(`${APP}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/r/${ID}`) return route.fulfill({ status: 200, contentType: "text/html", body: html });
    const file = join(PUBLIC, path);
    if (path.startsWith("/static/") && existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404 });
  });
  await p.goto(`${APP}/r/${ID}${LINK}`);
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  return { p, context };
}

describe.skipIf(!chromiumPath() && !process.env.CI)(
  "signing in from a signed link, in Chromium",
  { timeout: 120_000 },
  () => {
    for (const width of [360, 1280])
      for (const theme of ["light", "dark"] as const)
        it(`shows Sign in, reached by keyboard, to the report's own path (${width} px, ${theme})`, async () => {
          const { p, context } = await open(width, theme);
          const signIn = p.getByRole("link", { name: "Sign in" });
          expect(await signIn.isVisible()).toBe(true);
          // The stored verdict's sign-in carries the one-press dispute return (D07 T03 §22).
          expect(await signIn.getAttribute("href")).toBe(`/signin?next=${encodeURIComponent(`/r/${ID}?dispute=1`)}`);
          expect(await p.getByText("to tell us if we got it wrong.").isVisible()).toBe(true);
          let reached = false;
          for (let i = 0; i < 60 && !reached; i++) {
            await p.keyboard.press("Tab");
            reached = await signIn.evaluate((el) => el === document.activeElement);
          }
          expect(reached).toBe(true);
          expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p))).toEqual([]);
          await context.close();
        });
  },
);
