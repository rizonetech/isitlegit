import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CardItem } from "../../src/web/components/evidence/cards";
import { type Coverage, ReportLive } from "../../src/web/pages/report-live";
import { progressOf, type StepEvent } from "../../src/web/pages/report-progress";
import type { ReportVerdict } from "../../src/web/pages/report-verdict";
import { ReportDocument } from "../../src/web/pages/report-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// The running, partial and failed report in Chromium (D07 T03 §4), served over HTTP by this process with the shipped
// stylesheet, htmx and app script: the poll sent every 2 s and never after the finish, each change announced once and an
// unchanged poll silent, focus kept through the finish, a failed poll kept on the page and recovered, a poll that lost
// its access opening the full report, and each state passing the accessibility gate at both widths and themes.
const PUBLIC = join(import.meta.dirname, "../../public");
const ID = "01JCASE0000000000000000000";
const ev = (step: string, status: StepEvent["status"], error: string | null = null): StepEvent => ({
  step,
  status,
  startedAt: new Date(Date.now() - 20_000).toISOString(),
  ms: status === "started" ? null : 400,
  error,
});
const RUNNING_1 = progressOf([ev("admit", "started")]);
const RUNNING_3 = progressOf([ev("admit", "done"), ev("parse", "done"), ev("checks", "started")]);
const VERDICT: ReportVerdict = {
  verdict: "suspicious",
  headline: "A shared-document link leads to a sign-in page on a new domain.",
  confidence: 0.6,
  reasons: [{ text: "A first-time sender.", evidenceIds: ["E1"] }],
  actions: ["Do not sign in on that page."],
};
const EVIDENCE: CardItem[] = [
  {
    id: "E1",
    check: "sender.first_time",
    severity: "low",
    summary: "A first-time sender",
    detail: { history: "first", from: "x@new.example", headers: [] },
    artefacts: [],
  },
];
type Live = {
  status: "running" | "done" | "partial";
  verdict: ReportVerdict | null;
  progress: ReturnType<typeof progressOf>;
  coverage: Coverage;
  evidence: CardItem[];
};
const running = (progress = RUNNING_1, evidence: CardItem[] = []): Live => ({
  status: "running",
  verdict: null,
  progress,
  coverage: null,
  evidence,
});
const DONE: Live = {
  status: "done",
  verdict: VERDICT,
  progress: progressOf([ev("admit", "done")]),
  coverage: [{ check: "auth.spf", outcome: "ran", reason: null, findings: 0 }],
  evidence: EVIDENCE,
};
const PARTIAL: Live = {
  ...DONE,
  coverage: [
    { check: "domain.age", outcome: "failed", reason: "Timeout", findings: 0 },
    { check: "auth.spf", outcome: "ran", reason: null, findings: 0 },
  ],
};
const FAILED: Live = {
  status: "partial",
  verdict: null,
  progress: progressOf([ev("admit", "done"), ev("parse", "failed", "ParseError")]),
  coverage: null,
  evidence: [],
};

const region = (live: Live) =>
  String(
    <ReportLive
      caseId={ID}
      status={live.status}
      verdict={live.verdict}
      sourceKind="mail"
      evidence={live.evidence}
      progress={live.progress}
      coverage={live.coverage}
      view="member"
    />,
  );
function page(live: Live) {
  const { children: _, ...shell } = member();
  return String(
    <ReportDocument
      stored={{
        id: ID,
        status: live.status,
        verdict: live.verdict?.verdict ?? null,
        sourceKind: "mail",
        createdAt: new Date().toISOString(),
      }}
      verdict={live.verdict}
      evidence={live.evidence}
      shell={shell}
      progress={live.progress}
      coverage={live.coverage}
    />,
  );
}

// Each poll takes the next answer from the test's script; the last one repeats.
type Answer = Live | 503 | "redirect";
const state = { first: running() as Live, answers: [] as Answer[], polls: [] as number[], pages: 0 };

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === `/r/${ID}/status`) {
      state.polls.push(Date.now());
      const next = (state.answers.length > 1 ? state.answers.shift() : state.answers[0]) ?? state.first;
      if (next === 503) return res.writeHead(503).end();
      if (next === "redirect") return res.writeHead(204, { "hx-redirect": `/r/${ID}` }).end();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(region(next));
    }
    if (path === `/r/${ID}`) {
      state.pages++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(page(state.first));
    }
    const file = join(PUBLIC, path);
    if (path.startsWith("/static/") && existsSync(file)) {
      const type = path.endsWith(".css")
        ? "text/css"
        : path.endsWith(".js")
          ? "text/javascript"
          : path.endsWith(".svg")
            ? "image/svg+xml"
            : "font/woff2";
      res.writeHead(200, { "content-type": type });
      return res.end(readFileSync(file));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

async function open(first: Live, answers: Answer[], width = 1280, theme: "light" | "dark" = "light") {
  Object.assign(state, { first, answers, polls: [], pages: 0 });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p: Page = await context.newPage();
  await p.addInitScript(() => {
    const said: string[] = [];
    (window as unknown as { said: string[] }).said = said;
    new MutationObserver(() => {
      const text = document.getElementById("report-announce")?.textContent ?? "";
      if (text) said.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await p.goto(`${origin}/r/${ID}`, { waitUntil: "load" });
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  return { p, context };
}
const said = (p: Page) => p.evaluate(() => [...new Set((window as unknown as { said: string[] }).said)]);

describe.skipIf(!chromiumPath() && !process.env.CI)("the live report in Chromium", { timeout: 120_000 }, () => {
  it("polls every 2 s, says each change once and never an unchanged poll, and stops at the finish", async () => {
    const { p, context } = await open(running(), [running(), running(RUNNING_3, EVIDENCE), DONE]);
    await expect
      .poll(() => p.locator("#report-live").getAttribute("data-announce"), { timeout: 12_000 })
      .toBe("Checked: Suspicious");
    const gaps = state.polls.slice(1).map((t, i) => t - (state.polls[i] as number));
    for (const gap of gaps) expect(gap).toBeGreaterThan(1500);
    const sent = state.polls.length;
    await p.waitForTimeout(4500);
    expect(state.polls.length, "no poll after the finish").toBe(sent);
    expect(await said(p)).toEqual([
      "Step 3 of 7: Checked the sender, authentication, domains and content",
      "Checked: Suspicious",
    ]);
    await context.close();
  });

  it("keeps focus on a focused control through the finish", async () => {
    const { p, context } = await open(running(), [DONE]);
    const control = p.locator("#nav a").first();
    await control.focus();
    const before = await control.evaluate((el) => el.outerHTML);
    await expect
      .poll(() => p.locator("#report-live").getAttribute("data-announce"), { timeout: 8000 })
      .toBe("Checked: Suspicious");
    expect(await p.evaluate(() => document.activeElement?.outerHTML)).toBe(before);
    await context.close();
  });

  it("keeps the report through a failed poll, says so, and clears it when a poll answers", async () => {
    const { p, context } = await open(running(), [503, running(RUNNING_3)]);
    await expect.poll(() => p.locator("#report-stale").isVisible(), { timeout: 8000 }).toBe(true);
    expect(new URL(p.url()).pathname).toBe(`/r/${ID}`);
    await expect.poll(() => p.locator("#report-stale").count(), { timeout: 8000 }).toBe(0);
    expect(await p.getByText("Step 3 of 7", { exact: true }).isVisible()).toBe(true);
    await context.close();
  });

  it("opens the full report when a poll has lost its access", async () => {
    const { p, context } = await open(running(), ["redirect"]);
    await expect.poll(() => state.pages, { timeout: 8000 }).toBeGreaterThan(1);
    expect(new URL(p.url()).pathname).toBe(`/r/${ID}`);
    await context.close();
  });

  it("keeps progress readable with reduced motion, the running marker still", async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 900 }, reducedMotion: "reduce" });
    Object.assign(state, { first: running(RUNNING_3), answers: [running(RUNNING_3)], polls: [], pages: 0 });
    const p = await context.newPage();
    await p.goto(`${origin}/r/${ID}`, { waitUntil: "load" });
    expect(await p.getByText("Step 3 of 7", { exact: true }).isVisible()).toBe(true);
    const animated = await p.evaluate(
      () => [...document.querySelectorAll("*")].filter((el) => getComputedStyle(el).animationName !== "none").length,
    );
    expect(animated).toBe(0);
    await context.close();
  });

  it("reaches Upload it instead by keyboard on a failed check", async () => {
    const { p, context } = await open(FAILED, [FAILED], 360);
    const upload = p.getByRole("link", { name: "Upload it instead" });
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await p.keyboard.press("Tab");
      reached = await upload.evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280])
      it(`passes the accessibility gate's rules running, partly checked and failed (${theme}, ${width} px)`, async () => {
        for (const [name, live] of [
          ["running", running(RUNNING_3, EVIDENCE)],
          ["partial", PARTIAL],
          ["failed", FAILED],
        ] as const) {
          const { p, context } = await open(live, [live], width, theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), name).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), name).toEqual([]);
          await context.close();
        }
      });
});
