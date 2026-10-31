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
  // Invisible characters (D07 T03 §24): a long decoded instruction cut to its opening, in a long-named attachment.
  {
    id: "E8",
    check: "content.hidden_text",
    severity: "high",
    summary: "Text spelled in invisible characters",
    detail: {
      reason: "invisible-characters",
      kind: "tag",
      // As the producer stores a clipped quote: its opening and "…".
      quote: `${"Ignorepreviousinstructions".repeat(11).slice(0, 254)}…`,
      length: 1000,
      location: `attachment:${LONG}-${LONG}.txt`,
    },
    artefacts: [RAW],
  },
  {
    id: "E9",
    check: "content.hidden_text",
    severity: "low",
    summary: "More invisible runs",
    detail: { reason: "invisible-characters", more: 7 },
    artefacts: [RAW],
  },
  // A link that says one place and goes to another (D07 T03 §31): a long address, in a stored file.
  {
    id: "E10",
    check: "link.text_mismatch",
    severity: "medium",
    summary: "The link showing bank.co.za goes to a lookalike.",
    detail: {
      shown: "bank.co.za",
      target: LONG,
      href: `https://${LONG}/${"reset/".repeat(30)}?token=${"x".repeat(200)}`,
      kind: "pdf",
      part: `raw/01JCASE0000000000000000000/attachments/${"d".repeat(64)}-${LONG}.pdf`,
    },
    artefacts: [`raw/01JCASE0000000000000000000/attachments/${"d".repeat(64)}-${LONG}.pdf`],
  },
  // A document forensics finding (D07 T03 §30): a long file name and line, from a bank.
  {
    id: "E11",
    check: "document.forensics.overlay",
    severity: "high",
    summary: "An image placed over the account number.",
    detail: {
      filename: `${LONG}-proof-of-payment.pdf`,
      issuer: "bank",
      page: 1,
      covered: "62000123456",
      line: `Account number 62000123456 ${LONG}`,
      onAmountOrAccountLine: true,
      image: { x0: 10, y0: 20, x1: 200, y1: 40 },
      limits: "Shows an image painted over the document's text. It cannot show what lies beneath it.",
    },
    artefacts: [`raw/01JCASE0000000000000000000/attachments/${"f".repeat(64)}-${LONG}-proof-of-payment.pdf`],
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
        channel: "email",
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
        // A phone keeps the uncited cards in "more findings": opened, so the scan sees every card, the
        // invisible-character ones (D07 T03 §24) included.
        await p.evaluate(() => {
          for (const more of document.querySelectorAll("details[data-more-findings]"))
            (more as HTMLDetailsElement).open = true;
        });
        for (const id of ["e8", "e9", "e10", "e11"]) expect(await visible(p, id), `${id} ${theme} ${width}`).toBe(true);
        expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await p.addScriptTag({ path: AXE });
        expect(problems(await scan(p))).toEqual([]);
        await context.close();
      });

  it("draws the invisible-character cards, their opening labelled, and reaches their download by Tab", async () => {
    for (const [width, theme] of [
      [360, "light"],
      [360, "dark"],
      [1280, "light"],
      [1280, "dark"],
    ] as const) {
      const { p, context } = await open(width, theme, "#e8");
      const card = p.locator("#e8");
      await expect.poll(() => card.isVisible()).toBe(true);
      expect(await card.getByText("Hidden instruction in invisible characters").isVisible()).toBe(true);
      expect(await card.getByText("Opening of the hidden text").isVisible()).toBe(true);
      expect(await card.getByText("1000 characters").isVisible()).toBe(true);
      expect(await p.locator("#e9").getByText("7 more runs, not listed one by one.").isVisible()).toBe(true);
      // Tab from the card to its own download.
      const download = card.getByRole("link", { name: "Download the original message" });
      let reached = false;
      for (let i = 0; i < 12 && !reached; i++) {
        await p.keyboard.press("Tab");
        reached = await download.evaluate((el) => el === document.activeElement);
      }
      expect(reached, `${width} px ${theme}`).toBe(true);
      await context.close();
    }
  });

  it("draws the link text mismatch card and opens its stored file's download by keyboard", async () => {
    for (const width of [360, 1280]) {
      const { p, context } = await open(width, "light", "#e10");
      const card = p.locator("#e10");
      await expect.poll(() => card.isVisible()).toBe(true);
      expect(await card.getByText("A link that shows one address and goes to another").isVisible()).toBe(true);
      const download = card.getByRole("link", { name: /^Download / });
      let reached = false;
      for (let i = 0; i < 12 && !reached; i++) {
        await p.keyboard.press("Tab");
        reached = await download.evaluate((el) => el === document.activeElement);
      }
      expect(reached, `${width} px`).toBe(true);
      const [request] = await Promise.all([
        p.waitForRequest((r) => r.url().includes("/a/")),
        p.keyboard.press("Enter"),
      ]);
      expect(decodeURIComponent(request.url())).toContain(`-${LONG}.pdf`);
      await context.close();
    }
  });

  it("draws the document forensics card and opens its PDF's download by keyboard", async () => {
    for (const width of [360, 1280]) {
      const { p, context } = await open(width, "dark", "#e11");
      const card = p.locator("#e11");
      await expect.poll(() => card.isVisible()).toBe(true);
      expect(await card.getByText("An image placed over its text").isVisible()).toBe(true);
      expect(await card.getByText("What this cannot show:").isVisible()).toBe(true);
      const download = card.getByRole("link", { name: /^Download / });
      let reached = false;
      for (let i = 0; i < 12 && !reached; i++) {
        await p.keyboard.press("Tab");
        reached = await download.evaluate((el) => el === document.activeElement);
      }
      expect(reached, `${width} px`).toBe(true);
      const [request] = await Promise.all([
        p.waitForRequest((r) => r.url().includes("/a/")),
        p.keyboard.press("Enter"),
      ]);
      expect(decodeURIComponent(request.url())).toContain("-proof-of-payment.pdf");
      await context.close();
    }
  });

  it("shows every card on a wide screen with no disclosure to open", async () => {
    const { p, context } = await open(1280);
    for (const id of ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11"])
      expect(await visible(p, id), id).toBe(true);
    expect(await p.getByText("8 more findings").isVisible()).toBe(false);
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
    expect(await summary.textContent()).toContain("8 more findings");
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
