// The admin eval runs page in Chromium (D08 T02 §9): axe-core over the page in its states (seeded with runs and
// a published report, and empty) at phone and desktop width in both themes, no sideways scroll of the page,
// and the wide tables' scrolling regions reachable from the keyboard with a visible focus ring.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PublishedReport } from "../../src/eval/report";
import { AdminEvalPage } from "../../src/web/pages/admin-eval-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";

const APP = "http://localhost";
const PUBLIC = join(import.meta.dirname, "../../public");
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

const rate = (n: number, hits: number) => ({ n, hits, rate: n ? hits / n : null });
const report: PublishedReport = {
  run: {
    id: "run-00000001",
    mode: "full",
    commit: "abcdef1234567",
    setVersion: "a".repeat(64),
    sets: ["synthetic-sa"],
    sampleLimit: null,
    status: "complete",
    selected: 150,
    stored: 150,
    startedAt: "2026-11-05T10:00:00.000Z",
    finishedAt: "2026-11-05T10:30:00.000Z",
  },
  complete: true,
  main: {
    attacks: 100,
    genuine: 50,
    measuredGenuine: 50,
    detection: rate(100, 96),
    falsePositives: rate(50, 1),
    byCategory: {},
    modelBasis: rate(40, 36),
    checksBasis: rate(60, 60),
    analysisMs: { n: 150, median: 3500, p95: 9000 },
    costUsd: { n: 150, median: 0.031, total: 4.65 },
  },
  targets: [
    {
      name: "detection",
      figure: 0.96,
      figureText: "96.0%",
      threshold: "at least 95.0%",
      denominator: 100,
      state: "met",
    },
    {
      name: "false positives",
      figure: 0.02,
      figureText: "2.0%",
      threshold: "at most 2.0%",
      denominator: 50,
      state: "met",
    },
    {
      name: "median cost per case",
      figure: 0.031,
      figureText: "US$0.0310",
      threshold: "under US$0.0500",
      denominator: 150,
      state: "met",
    },
    {
      name: "forward-to-reply time",
      figure: null,
      figureText: "not measured",
      threshold: "median under 60 s, p95 under 180 s",
      denominator: 0,
      state: "not measured",
      note: "measured by the live mail run",
    },
  ],
};
const shell = { operator: "hostmaster@rizonetech.com", feedbackOpen: 0 };
const views: Record<string, string> = {
  "/admin/eval": String(
    <AdminEvalPage
      shell={shell}
      runs={[
        {
          id: "run-00000001",
          mode: "full",
          status: "complete",
          commit: "abcdef1234567",
          setVersion: "a".repeat(64),
          sets: "synthetic-sa",
          sampleLimit: null,
          selected: 150,
          capUsd: 13,
          costUsd: 1.5,
          startedAt: "2026-11-05T10:00:00.000Z",
          finishedAt: "2026-11-05T10:30:00.000Z",
          published: { report, publishedAt: "2026-11-05T11:00:00.000Z" },
        },
        {
          id: "run-00000002",
          mode: "full",
          status: "incomplete",
          commit: "abcdef1234567",
          setVersion: "a".repeat(64),
          sets: "synthetic-sa",
          sampleLimit: null,
          selected: 150,
          capUsd: 13,
          costUsd: 0.5,
          startedAt: "2026-11-05T12:00:00.000Z",
          finishedAt: "2026-11-05T12:30:00.000Z",
          published: null,
        },
      ]}
      latest={{ report, publishedAt: "2026-11-05T11:00:00.000Z" }}
      ablations={[
        {
          mode: "no-sam",
          runId: "run-00000003",
          comparable: false,
          reason: "another deployed commit than the full run",
        },
      ]}
    />,
  ),
  "/admin/eval-empty": String(<AdminEvalPage shell={shell} runs={[]} latest={null} ablations={[]} />),
};

async function open(path: string, width: number, theme: "light" | "dark", height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  const p: Page = await context.newPage();
  await p.route(`${APP}/**`, async (route) => {
    const url = new URL(route.request().url()).pathname;
    const own = views[url];
    if (own) return route.fulfill({ status: 200, contentType: "text/html", body: own });
    const file = join(PUBLIC, url);
    if (url.startsWith("/static/") && existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404 });
  });
  await p.goto(`${APP}${path}`);
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await p.addScriptTag({ path: AXE });
  return { p, context };
}

describe.skipIf(!chromiumPath() && !process.env.CI)(
  "the admin eval runs page in a browser",
  { timeout: 300_000 },
  () => {
    for (const theme of ["light", "dark"] as const)
      for (const width of [1280, 360])
        for (const path of ["/admin/eval", "/admin/eval-empty"])
          it(`passes axe on ${path} (${theme}, ${width} px) and does not scroll the page sideways`, async () => {
            const { p, context } = await open(path, width, theme);
            expect(problems(await scan(p)), path).toEqual([]);
            const overflow = await p.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
            await context.close();
          });

    it("reaches both table regions from the keyboard with a visible focus ring, at phone width", async () => {
      const { p, context } = await open("/admin/eval", 360, "light");
      for (const label of [
        "Ablation table, scrolls sideways on a narrow screen",
        "All runs table, scrolls sideways on a narrow screen",
      ]) {
        const region = p.getByLabel(label);
        expect(await region.count()).toBe(1);
        await region.focus();
        expect(await region.evaluate((el) => el === document.activeElement)).toBe(true);
        const outline = await region.evaluate((el) => {
          const s = getComputedStyle(el);
          return { style: s.outlineStyle, width: Number.parseFloat(s.outlineWidth) };
        });
        expect(outline.style, label).not.toBe("none");
        expect(outline.width, label).toBeGreaterThan(0);
      }
      await context.close();
    });

    it("names the tables for a screen reader", async () => {
      const { p, context } = await open("/admin/eval", 1280, "light");
      const captions = await p.evaluate(() =>
        [...document.querySelectorAll("table caption")].map((c) => c.textContent?.trim() ?? ""),
      );
      expect(captions).toContain("Each model switched off against the full pipeline");
      expect(captions).toContain("Every eval run, newest first, with its own published figures");
      await context.close();
    });
  },
);
