import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bankChangeAction, callBackAction } from "../../src/invoice/fixed-actions";
import type { ReportVerdict } from "../../src/web/pages/report-verdict";
import { ReportDocument, type ReportEvidence } from "../../src/web/pages/report-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// The verdict section in Chromium (D07 T03 §2) with the shipped stylesheet: the band, then the actions, then the
// reasons on the page as drawn; each reason's pill followed by keyboard moves focus and the view to its evidence;
// every variant passing the accessibility gate's rules at 360 and 1280 px in both themes, with no sideways scroll.
const APP = "http://localhost";
const PUBLIC = join(import.meta.dirname, "../../public");
const LONG = "accountverificationnimbusmai1securelogin.portal.example";
const evidence: ReportEvidence[] = Array.from({ length: 9 }, (_, i) => ({
  id: `E${i + 1}`,
  severity: (["critical", "high", "medium", "low", "info"] as const)[i % 5] as ReportEvidence["severity"],
  summary: `Finding ${i + 1}: the link points at ${LONG} and asks for the mailbox password`,
  check: "sender.first_time",
  detail: {},
  artefacts: [],
}));
const MAIN: ReportVerdict = {
  verdict: "malicious",
  headline: `This is a password-phishing email pretending to be NimbusMail at ${LONG}.`,
  confidence: 0.93,
  reasons: [
    { text: `The login page sends passwords to ${LONG}, not NimbusMail.`, evidenceIds: ["E7"] },
    { text: "The link goes to a lookalike registered 3 days ago.", evidenceIds: ["E4"] },
    { text: "Hidden white text tells AI scanners the email is safe.", evidenceIds: ["E2"] },
  ],
  actions: [
    "Do not click the link or open the attachment.",
    "If anyone typed a password on that page, change it now and sign out of all sessions.",
    "Delete the email and warn your team.",
  ],
};
const VARIANTS: Record<string, { verdict: ReportVerdict; sourceKind: "mail" | "audio" }> = {
  main: { verdict: MAIN, sourceKind: "mail" },
  invoice: {
    verdict: { ...MAIN, actions: [bankChangeAction("011 555 0142"), "Do not pay INV-20931 until they confirm."] },
    sourceKind: "mail",
  },
  voice: {
    verdict: {
      ...MAIN,
      verdict: "suspicious",
      confidence: 0.6,
      actions: [callBackAction("Johan Visser"), "Do not pay."],
    },
    sourceKind: "audio",
  },
  safe: {
    verdict: { ...MAIN, verdict: "safe", confidence: 0.95, actions: ["Nothing special. Pay as usual."] },
    sourceKind: "mail",
  },
};

// The safe variant's stored outcomes (D07 T03 §18): its clean list holds a retired check's stored name at the column's
// 100-character limit, one unbroken word, which must wrap on a phone rather than push the page sideways.
const RETIRED = `retired.${"x".repeat(92)}`;
const COVERAGE = [
  { check: "domain.lookalike", outcome: "ran" as const, reason: null, findings: 0 },
  { check: "content.hidden_text", outcome: "ran" as const, reason: null, findings: 0 },
  { check: RETIRED, outcome: "ran" as const, reason: null, findings: 0 },
  { check: "sender.first_time", outcome: "ran" as const, reason: null, findings: 9 },
];

function html(name: string) {
  const { verdict, sourceKind } = VARIANTS[name] as (typeof VARIANTS)[string];
  const { children: _, ...shell } = member();
  return String(
    <ReportDocument
      stored={{
        id: "01JCASE0000000000000000000",
        status: "done",
        verdict: verdict.verdict,
        sourceKind,
        channel: "email",
        createdAt: "2026-10-27T08:12:00Z",
      }}
      verdict={verdict}
      evidence={evidence}
      {...(name === "safe" ? { coverage: COVERAGE } : {})}
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

async function open(body: string, width: number, theme: "light" | "dark" = "light") {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p: Page = await context.newPage();
  await p.route(`${APP}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/r/case") return route.fulfill({ status: 200, contentType: "text/html", body });
    const file = join(PUBLIC, path);
    if (path.startsWith("/static/") && existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404 });
  });
  await p.goto(`${APP}/r/case`);
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  return { p, context };
}
// Where a part of the page starts, top to bottom.
const top = (p: Page, selector: string) =>
  p
    .locator(selector)
    .first()
    .evaluate((el) => el.getBoundingClientRect().top);

describe.skipIf(!chromiumPath() && !process.env.CI)("the verdict section in Chromium", { timeout: 120_000 }, () => {
  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280])
      it(`passes the accessibility gate's rules in every variant (${theme}, ${width} px)`, async () => {
        for (const name of Object.keys(VARIANTS)) {
          const { p, context } = await open(html(name), width, theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), name).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), name).toEqual([]);
          await context.close();
        }
      });

  for (const width of [360, 1280])
    it(`draws the safe report's count line and clean checks as a heading and a list, inside the page (${width} px)`, async () => {
      const { p, context } = await open(html("safe"), width);
      await expect.poll(() => p.getByText("9 findings · 4 checks ran · nothing skipped").count()).toBe(1);
      const clean = p.getByRole("region", { name: "Checks that found nothing" });
      expect(await clean.getByRole("listitem").count()).toBe(3);
      const long = clean.getByRole("listitem").filter({ hasText: RETIRED });
      const box = await long.evaluate((el) => el.getBoundingClientRect().right);
      expect(box).toBeLessThanOrEqual(width);
      expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await context.close();
    });

  for (const width of [360, 1280])
    it(`draws the band, then the actions, then the reasons (${width} px)`, async () => {
      for (const [name, actions] of [
        ["main", "What to do now"],
        ["invoice", "Do this first"],
        ["voice", "Do this first"],
      ] as const) {
        const { p, context } = await open(html(name), width);
        const band = await top(p, '[aria-label="Verdict"]');
        const todo = await top(p, `h2:text-is("${actions}")`);
        const why = await top(p, 'h2:text-is("Why we say so")');
        expect(todo, name).toBeGreaterThan(band);
        // A phone stacks them; a wide page puts the invoice's reasons below its full-width action, and the plain and
        // voice actions beside their reasons (`Main`, `Report-Voice`).
        if (width === 360 || name === "invoice") expect(why, name).toBeGreaterThan(todo);
        else expect(Math.abs(why - todo), name).toBeLessThan(40);
        await context.close();
      }
    });

  it("moves focus and the view to a reason's evidence when its pill is followed by keyboard", async () => {
    const { p, context } = await open(html("main"), 360);
    const pill = p.getByRole("link", { name: "Evidence E7, high" });
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await p.keyboard.press("Tab");
      reached = await pill.evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await p.keyboard.press("Enter");
    await expect.poll(() => p.evaluate(() => location.hash)).toBe("#e7");
    // Focus lands on the finding itself, so the next Tab continues from there.
    await expect.poll(() => p.evaluate(() => document.activeElement?.id)).toBe("e7");
    const card = p.locator("#e7");
    await expect
      .poll(() =>
        card.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return box.top >= 0 && box.top < window.innerHeight;
        }),
      )
      .toBe(true);
    await context.close();
  });
});
