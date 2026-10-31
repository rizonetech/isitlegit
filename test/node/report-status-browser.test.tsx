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
  delivery?: "sent" | "failed" | null;
  // A member's feedback on the finished report (D07 T03 §6); absent draws no control.
  feedback?: null;
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
  // Its reply has gone (the failure's own answer was emailed), so the report is settled.
  progress: progressOf([ev("admit", "done"), ev("parse", "failed", "ParseError"), ev("reply", "done")]),
  coverage: null,
  evidence: [],
  delivery: "sent",
};

const region = (live: Live) =>
  String(
    <ReportLive
      caseId={ID}
      status={live.status}
      verdict={live.verdict}
      sourceKind="mail"
      channel="email"
      delivery={live.delivery ?? null}
      {...(live.feedback !== undefined ? { feedback: live.feedback } : {})}
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
        channel: "email",
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
type Answer = Live | 503 | "redirect" | "slow" | { delay: number; live: Live };
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
      // Past the poll's own 10 s timeout.
      if (next === "slow") return void setTimeout(() => res.writeHead(503).end(), 11_000);
      if ("delay" in next)
        return void setTimeout(() => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(region(next.live));
        }, next.delay);
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
  // Every change the live region's text goes through, as a screen reader would be told it: one entry per write.
  await p.addInitScript(() => {
    const said: string[] = [];
    (window as unknown as { said: string[] }).said = said;
    document.addEventListener("DOMContentLoaded", () => {
      const region = document.getElementById("report-announce");
      if (!region) return;
      new MutationObserver(() => {
        if (region.textContent) said.push(region.textContent);
      }).observe(region, { subtree: true, childList: true, characterData: true });
    });
  });
  await p.goto(`${origin}/r/${ID}`, { waitUntil: "load" });
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  return { p, context };
}
const said = (p: Page) => p.evaluate(() => (window as unknown as { said: string[] }).said);
const announced = (p: Page) => p.locator("#report-live").getAttribute("data-announce");

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

  for (const [name, finish, words] of [
    ["partly checked", "partial", "Partly checked: Suspicious"],
    ["failed", "failed", "The check failed. Nothing was concluded."],
  ] as const)
    it(`goes from running to ${name}, saying it once`, async () => {
      const end = finish === "partial" ? PARTIAL : FAILED;
      const { p, context } = await open(running(), [running(), end]);
      await expect.poll(() => announced(p), { timeout: 10_000 }).toBe(words);
      const sent = state.polls.length;
      await p.waitForTimeout(4500);
      expect(state.polls.length).toBe(sent);
      expect(await said(p)).toEqual([words]);
      await context.close();
    });

  // How soon the answer shows once it is stored: within one poll interval plus the request and its drawing. Three
  // finishes of a large report (100 findings), the median and the slowest logged.
  it("shows a stored answer within one poll interval plus its drawing", async () => {
    const big: CardItem[] = Array.from({ length: 100 }, (_, i) => ({ ...(EVIDENCE[0] as CardItem), id: `E${i + 1}` }));
    const times: number[] = [];
    for (let run = 0; run < 3; run++) {
      const { p, context } = await open(running(), [running()]);
      await p.waitForTimeout(500 + run * 600);
      const stored = Date.now();
      state.answers = [{ ...DONE, evidence: big }];
      await expect.poll(() => announced(p), { timeout: 8000, interval: 50 }).toBe("Checked: Suspicious");
      times.push(Date.now() - stored);
      await context.close();
    }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ event: "report-update-latency", medianMs: times[1], slowestMs: times[2] }));
    expect(times[2]).toBeLessThan(3500);
  });

  it("keeps focus on an evidence download through unchanged polls and the finish", async () => {
    const withFile: CardItem[] = [{ ...(EVIDENCE[0] as CardItem), artefacts: [`raw/${ID}/message.eml`] }];
    const { p, context } = await open(running(RUNNING_3, withFile), [
      running(RUNNING_3, withFile),
      running(RUNNING_3, withFile),
      { ...DONE, evidence: withFile },
    ]);
    await p.locator("#e1-file-1").focus();
    await expect.poll(() => announced(p), { timeout: 10_000 }).toBe("Checked: Suspicious");
    expect(state.polls.length).toBeGreaterThanOrEqual(3);
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("e1-file-1");
    await context.close();
  });

  it("closes a phone's more-findings disclosure after the finish, as on a report opened finished", async () => {
    const many: CardItem[] = ["E1", "E2", "E3"].map((id) => ({ ...(EVIDENCE[0] as CardItem), id }));
    const done = { ...DONE, evidence: many };
    const live = await open(running(), [done], 360);
    await expect.poll(() => announced(live.p), { timeout: 8000 }).toBe("Checked: Suspicious");
    const after = await live.p.locator("details[data-more-findings]").evaluate((d) => (d as HTMLDetailsElement).open);
    await live.context.close();
    const direct = await open(done, [done], 360);
    const opened = await direct.p
      .locator("details[data-more-findings]")
      .evaluate((d) => (d as HTMLDetailsElement).open);
    await direct.context.close();
    expect(after).toBe(false);
    expect(after).toBe(opened);
  });

  it("says where it stands once a poll answers after an outage, the step unchanged", async () => {
    const { p, context } = await open(running(), [503, running()]);
    await expect.poll(() => p.locator("#report-stale").isVisible(), { timeout: 8000 }).toBe(true);
    await expect.poll(() => p.locator("#report-stale").count(), { timeout: 8000 }).toBe(0);
    expect(await said(p)).toEqual(["Progress is not up to date. Trying again.", "Step 1 of 7: Received and stored"]);
    await context.close();
  });

  // The notice can be up for only a moment (the poll after a timeout may answer at once), so the announcements, which
  // keep every change, are what is checked.
  it("recovers from a poll that timed out, saying so and then where it stands", async () => {
    const { p, context } = await open(running(), ["slow", running(RUNNING_3)]);
    await expect
      .poll(() => announced(p), { timeout: 20_000 })
      .toBe("Step 3 of 7: Checked the sender, authentication, domains and content");
    expect(await said(p)).toEqual([
      "Progress is not up to date. Trying again.",
      "Step 3 of 7: Checked the sender, authentication, domains and content",
    ]);
    expect(await p.locator("#report-stale").count()).toBe(0);
    await context.close();
  });

  // A poll still waiting keeps its request: a server that always takes longer than the 2 s interval is still answered.
  it("is answered by a server slower than the poll interval", async () => {
    const { p, context } = await open(running(), [{ delay: 3000, live: running(RUNNING_3) }]);
    await expect
      .poll(() => announced(p), { timeout: 12_000 })
      .toBe("Step 3 of 7: Checked the sender, authentication, domains and content");
    await context.close();
  });

  it("keeps a focused download visible on a phone when the finish moves its card into More findings", async () => {
    const two: CardItem[] = ["E1", "E2"].map((id) => ({
      ...(EVIDENCE[0] as CardItem),
      id,
      artefacts: [`raw/${ID}/message.eml`],
    }));
    const { p, context } = await open(
      running(RUNNING_3, two),
      [running(RUNNING_3, two), { ...DONE, evidence: two }],
      360,
    );
    await p.locator("#e2-file-1").focus();
    await expect.poll(() => announced(p), { timeout: 10_000 }).toBe("Checked: Suspicious");
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("e2-file-1");
    expect(await p.locator("#e2-file-1").isVisible()).toBe(true);
    await context.close();
  });

  it("offers a member This verdict is wrong once a running report finishes", async () => {
    const { p, context } = await open(running(), [{ ...DONE, feedback: null }]);
    expect(await p.getByText("This verdict is wrong").count()).toBe(0);
    await expect.poll(() => announced(p), { timeout: 10_000 }).toBe("Checked: Suspicious");
    expect(await p.getByText("This verdict is wrong").isVisible()).toBe(true);
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
