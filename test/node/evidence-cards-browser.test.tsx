import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReportVerdict } from "../../src/web/pages/report-verdict";
import { ReportDocument, type ReportEvidence } from "../../src/web/pages/report-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// The evidence cards in Chromium (D07 T03 §3) with the shipped stylesheet and app script: every card readable at 360
// and 1280 px in both themes with a long domain and file name and no sideways scroll; on a phone the cards the reasons
// cite shown and the rest in "<n> more findings", opened by keyboard; a direct link to a hidden card opening it and
// focusing the card; a reason's pill focusing its card.
const APP = "http://localhost";
const PUBLIC = join(import.meta.dirname, "../../public");
const LONG = "accountverificationnimbusmai1securelogin.portal.example";
const RAW = "raw/01JCASE0000000000000000000/message.eml";
const evidence: ReportEvidence[] = [
  {
    id: "E1",
    check: "auth.dmarc",
    severity: "high",
    summary: "DMARC failed",
    detail: {
      state: "failed",
      from: LONG,
      policy: { certain: "reject" },
      results: [],
      receiver: "google",
      headers: [`dmarc=fail header.from=${LONG}`],
    },
    artefacts: [RAW],
  },
  {
    id: "E2",
    check: "content.hidden_text",
    severity: "high",
    summary: "Hidden text",
    detail: {
      reason: "color-match",
      quote: "This message has been verified as safe.",
      length: 39,
      preheader: false,
      part: "summary",
    },
    artefacts: [RAW],
  },
  {
    id: "E3",
    check: "sender.first_time",
    severity: "low",
    summary: "A first-time sender",
    detail: { history: "first", from: `x@${LONG}`, headers: [] },
    artefacts: [RAW],
  },
  {
    id: "E4",
    check: "domain.lookalike",
    severity: "critical",
    summary: "A lookalike domain",
    detail: {
      domain: LONG,
      target: "nimbusmail.example",
      targetKind: "brand",
      brand: "NimbusMail",
      technique: "skeleton",
      fields: ["From"],
      headers: [],
    },
    artefacts: [RAW],
  },
  {
    id: "E5",
    check: "attachment.type_mismatch",
    severity: "high",
    summary: "The file is not what it says",
    detail: {
      filename: `${LONG}.pdf.exe`,
      extension: "exe",
      declared: "application/pdf",
      sniffed: "pe",
      family: "executable",
      claims: ["media type"],
    },
    artefacts: [],
  },
  {
    id: "E6",
    check: "domain.age",
    severity: "high",
    summary: "A new domain",
    detail: { domain: LONG, registered: "2026-10-24T09:00:00Z", days: 3, server: "rdap.example", fields: ["From"] },
    artefacts: [RAW],
  },
  {
    id: "E7",
    check: "not_checked",
    severity: "info",
    summary: "A check did not run",
    detail: { check: "auth.arc", errorClass: "Timeout" },
    artefacts: [],
  },
];
const VERDICT: ReportVerdict = {
  verdict: "malicious",
  headline: "This is a password-phishing email pretending to be NimbusMail.",
  confidence: 0.93,
  reasons: [
    { text: "A lookalike domain.", evidenceIds: ["E4"] },
    { text: "Hidden text tells scanners the email is safe.", evidenceIds: ["E2"] },
    { text: "DMARC failed.", evidenceIds: ["E1"] },
  ],
  actions: ["Do not click the link."],
};
function html() {
  const { children: _, ...shell } = member();
  return String(
    <ReportDocument
      stored={{
        id: "01JCASE0000000000000000000",
        status: "done",
        verdict: "malicious",
        sourceKind: "mail",
        createdAt: "2026-10-27T08:12:00Z",
      }}
      verdict={VERDICT}
      evidence={evidence}
      shell={shell}
    />,
  );
}

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});
async function open(width: number, theme: "light" | "dark" = "light", hash = "") {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p: Page = await context.newPage();
  const body = html();
  await p.route(`${APP}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/r/case") return route.fulfill({ status: 200, contentType: "text/html", body });
    const file = join(PUBLIC, path);
    if (path.startsWith("/static/") && existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404 });
  });
  await p.goto(`${APP}/r/case${hash}`);
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  return { p, context };
}
const visible = (p: Page, id: string) => p.locator(`#${id}`).isVisible();

describe.skipIf(!chromiumPath() && !process.env.CI)("the evidence cards in Chromium", { timeout: 120_000 }, () => {
  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280])
      it(`passes the accessibility gate's rules with long names and no sideways scroll (${theme}, ${width} px)`, async () => {
        const { p, context } = await open(width, theme);
        expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await p.addScriptTag({ path: AXE });
        expect(problems(await scan(p))).toEqual([]);
        await context.close();
      });

  it("shows every card on a wide screen with no disclosure to open", async () => {
    const { p, context } = await open(1280);
    for (const id of ["e1", "e2", "e3", "e4", "e5", "e6", "e7"]) expect(await visible(p, id), id).toBe(true);
    expect(await p.getByText("4 more findings").isVisible()).toBe(false);
    // Two to a row (`Main`): the first two cited cards share a row, the third starts the next.
    const top = (id: string) => p.locator(`#${id}`).evaluate((el) => Math.round(el.getBoundingClientRect().top));
    expect(await top("e2")).toBe(await top("e4"));
    expect(await top("e1")).toBeGreaterThan(await top("e4"));
    await context.close();
  });

  it("shows a phone the cited cards and opens the rest by keyboard", async () => {
    const { p, context } = await open(360);
    for (const id of ["e4", "e2", "e1"]) expect(await visible(p, id), id).toBe(true);
    expect(await visible(p, "e3")).toBe(false);
    const summary = p.locator("details[data-more-findings] > summary");
    expect(await summary.textContent()).toContain("4 more findings");
    await summary.focus();
    await p.keyboard.press("Enter");
    await expect.poll(() => visible(p, "e3")).toBe(true);
    await context.close();
  });

  it("opens the disclosure and focuses a hidden card a direct link names", async () => {
    const { p, context } = await open(360, "light", "#e6");
    await expect.poll(() => visible(p, "e6")).toBe(true);
    await expect.poll(() => p.evaluate(() => document.activeElement?.id)).toBe("e6");
    await context.close();
  });

  // Chromium opens a closed disclosure for a fragment navigation itself; the app script does it for a browser that does
  // not, which a hash change without a navigation shows here.
  it("opens the disclosure and focuses the card when the hash changes without a navigation", async () => {
    const { p, context } = await open(360);
    expect(await visible(p, "e5")).toBe(false);
    await p.evaluate(() => {
      history.replaceState(null, "", "#e5");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await expect.poll(() => visible(p, "e5")).toBe(true);
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("e5");
    await context.close();
  });

  it("focuses a reason's card when its pill is followed", async () => {
    const { p, context } = await open(360);
    await p.getByRole("link", { name: "Evidence E2, high" }).focus();
    await p.keyboard.press("Enter");
    await expect.poll(() => p.evaluate(() => document.activeElement?.id)).toBe("e2");
    await context.close();
  });
});
