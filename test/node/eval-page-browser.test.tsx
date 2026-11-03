// The results page in Chromium (D08 T02 §4, plan review gap 7): axe-core over the page in every state it has (published
// with ablations, empty, failed) at phone and desktop width in both themes, no sideways scroll of the page at phone width
// or at enlarged text, the ablation table's scrolling region reachable and visibly focused from the keyboard, and
// meaningful table headers and link names.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AblationRow, HistoryRow, ProductionCounts, PublishedReport } from "../../src/eval/report.ts";
import { EvalPage, EvalUnavailable, type EvalView } from "../../src/web/pages/eval-view.tsx";
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
    byCategory: {
      "credential-phishing": { attacks: 60, detected: 58, genuine: 0, measuredGenuine: 0, falsePositives: 0 },
      "bec-payment": { attacks: 40, detected: 38, genuine: 0, measuredGenuine: 0, falsePositives: 0 },
      "genuine-business": { attacks: 0, detected: 0, genuine: 50, measuredGenuine: 50, falsePositives: 1 },
    },
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
  ],
};
const counts: ProductionCounts = {
  since: "2026-10-26T22:00:00.000Z",
  cases: 12,
  flagged: 4,
  invoiceFlags: 2,
  bankChanges: null,
  reportedWrong: 1,
  medianSeconds: 21.5,
};
const ablations: AblationRow[] = [
  {
    mode: "ablate:no-sam",
    runId: "run-00000002",
    comparable: true,
    detection: rate(100, 90),
    falsePositives: rate(50, 1),
    medianMs: 3400,
    medianUsd: 0.03,
    detectionDelta: -0.06,
    falsePositiveDelta: 0,
    msDelta: -100,
    usdDelta: -0.001,
  },
  {
    mode: "ablate:no-agent-reasoning",
    runId: "run-00000003",
    comparable: false,
    reason: "another deployed commit than the full run",
  },
];
const history: HistoryRow[] = [
  { report, publishedAt: "2026-11-05T11:00:00.000Z", comparable: true, reason: null },
  {
    report: {
      ...report,
      run: { ...report.run, id: "run-00000009", commit: "1234567abcdef", setVersion: "b".repeat(64) },
    },
    publishedAt: "2026-11-04T11:00:00.000Z",
    comparable: false,
    reason: "another dataset version than the latest run",
  },
];
const views: Record<string, string> = {
  "/eval": String(
    <EvalPage view={{ kind: "report", report, publishedAt: "2026-11-05T11:00:00.000Z", ablations, counts, history }} />,
  ),
  "/eval-empty": String(
    <EvalPage
      view={
        {
          kind: "empty",
          history: [],
          counts: { ...counts, cases: 0, flagged: 0, invoiceFlags: 0, reportedWrong: 0, medianSeconds: null },
        } satisfies EvalView
      }
    />,
  ),
  "/eval-error": String(
    <EvalUnavailable reference="500-ABC123" now={new Date("2026-11-05T11:00:00.000Z")} retry="/eval" />,
  ),
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

describe.skipIf(!chromiumPath() && !process.env.CI)("the results page in a browser", { timeout: 300_000 }, () => {
  for (const theme of ["light", "dark"] as const)
    for (const width of [1280, 360])
      for (const path of ["/eval", "/eval-empty", "/eval-error"])
        it(`passes axe on ${path} (${theme}, ${width} px) and does not scroll the page sideways`, async () => {
          const { p, context } = await open(path, width, theme);
          expect(problems(await scan(p)), path).toEqual([]);
          const overflow = await p.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
          await context.close();
        });

  it("keeps every state free of sideways scroll at enlarged text (200%), at phone and desktop width, and passes axe there", async () => {
    for (const width of [1280, 360])
      for (const path of ["/eval", "/eval-empty", "/eval-error"]) {
        // Tall enough that nothing is below the fold: axe cannot decide the background of a partly hidden element.
        const { p, context } = await open(path, width, "light", 8000);
        await p.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
        // Colour does not change with the text size and the normal-size scans above decide it on these same colours; at
        // 200% axe reports the pills' background as undecidable, so this scan keeps every other WCAG rule.
        const result = await scan(p);
        expect(
          problems({ ...result, incomplete: result.incomplete.filter((f) => f.id !== "color-contrast") }),
          `${path} ${width}`,
        ).toEqual([]);
        const overflow = await p.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${path} at 200%, ${width} px`).toBeLessThanOrEqual(0);
        await context.close();
      }
  });

  it("is traversed by the Tab key: every stop has a name and a visible focus ring, and the links and the table region are all reached", async () => {
    for (const width of [1280, 360]) {
      const { p, context } = await open("/eval", width, "light");
      await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const stops: { name: string; outline: string; width: number }[] = [];
      for (let i = 0; i < 60; i++) {
        await p.keyboard.press("Tab");
        const stop = await p.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const s = getComputedStyle(el);
          const name =
            el.getAttribute("aria-label") ||
            (el.textContent ?? "").trim() ||
            el.querySelector("img")?.getAttribute("alt") ||
            "";
          return {
            name: name.slice(0, 60) || el.getAttribute("aria-label") || "",
            outline: s.outlineStyle,
            width: Number.parseFloat(s.outlineWidth),
          };
        });
        if (!stop) break;
        stops.push(stop);
      }
      const names = stops.map((s) => s.name);
      expect(stops.length, `${width} px`).toBeGreaterThan(3);
      expect(
        names.every((n) => n.length > 0),
        names.join(" | "),
      ).toBe(true);
      for (const s of stops) {
        expect(s.outline, s.name).not.toBe("none");
        expect(s.width, s.name).toBeGreaterThan(0);
      }
      expect(names).toContain("Sign in");
      expect(names).toContain("eval/DATASETS.md");
      expect(names.some((n) => n.startsWith("Ablation table"))).toBe(true);
      expect(names.some((n) => n.startsWith("Run history table"))).toBe(true);
      await context.close();
    }
  });

  it("reaches the ablation table's scrolling region from the keyboard, with a visible focus ring, at phone width", async () => {
    const { p, context } = await open("/eval", 360, "light");
    const region = p.getByLabel("Ablation table, scrolls sideways on a narrow screen");
    expect(await region.count()).toBe(1);
    await region.focus();
    expect(await region.evaluate((el) => el === document.activeElement)).toBe(true);
    const outline = await region.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: Number.parseFloat(s.outlineWidth) };
    });
    expect(outline.style).not.toBe("none");
    expect(outline.width).toBeGreaterThan(0);
    // The wide table scrolls inside its own region, and the page does not.
    expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await context.close();
  });

  it("names its tables with captions and column headers, and every link by its words", async () => {
    const { p, context } = await open("/eval", 1280, "light");
    const tables = await p.locator("table").count();
    expect(tables).toBe(4);
    for (let i = 0; i < tables; i++) {
      expect(await p.locator("table").nth(i).locator("caption").count()).toBe(1);
      expect(await p.locator("table").nth(i).locator('thead th[scope="col"]').count()).toBeGreaterThan(0);
    }
    const names = await p
      .locator("a")
      .evaluateAll((els) =>
        els.map(
          (e) =>
            (e.textContent ?? "").trim() ||
            e.getAttribute("aria-label") ||
            e.querySelector("img")?.getAttribute("alt") ||
            "",
        ),
      );
    expect(
      names.every((n) => n.length > 0),
      names.join(" | "),
    ).toBe(true);
    expect(names).toContain("eval/DATASETS.md");
    await context.close();
  });

  it("keeps the content of every table readable: nothing is clipped by its panel at phone width or at enlarged text (round 1)", async () => {
    for (const [width, size] of [
      [360, "100%"],
      [360, "200%"],
      [1280, "200%"],
    ] as const) {
      const { p, context } = await open("/eval", width, "light", 8000);
      await p.evaluate((fs) => {
        document.documentElement.style.fontSize = fs;
      }, size);
      const clipped = await p.evaluate(() => {
        const out: string[] = [];
        for (const table of document.querySelectorAll("table")) {
          const caption = table.querySelector("caption")?.textContent ?? "table";
          // A table inside a scrolling region (the ablation table) may be wider than it; elsewhere it must fit its panel.
          const region = table.closest('[aria-label*="scrolls"]');
          const box = (region ?? table.closest("section") ?? table.parentElement) as HTMLElement;
          const panel = box.getBoundingClientRect();
          for (const cell of table.querySelectorAll("th, td")) {
            const r = cell.getBoundingClientRect();
            if (region ? false : r.right > panel.right + 1 || r.left < panel.left - 1)
              out.push(`${caption}: ${cell.textContent?.trim().slice(0, 30)}`);
          }
          if (region && (region as HTMLElement).scrollWidth < table.getBoundingClientRect().width - 1)
            out.push(`${caption}: the region cannot scroll to its table`);
        }
        return out;
      });
      expect(clipped, `${width} px at ${size}`).toEqual([]);
      await context.close();
    }
  });
});
