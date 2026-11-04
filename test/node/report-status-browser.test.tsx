import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CardItem } from "../../src/web/components/evidence/cards";
import { TraceMail } from "../../src/web/components/model-trace";
import { MetaLine } from "../../src/web/pages/report-header";
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
  // An upload's stored file name: draws the case as an upload (D07 T03 §40).
  upload?: string;
  // The model trace a member's finished report carries (D07 T03 §5), and whether the address asked for it open.
  trace?: boolean | "unsettled";
  traceOpen?: boolean;
};
const UNSETTLED_TRACE = (): NonNullable<Parameters<typeof ReportLive>[0]["trace"]> => ({
  ...TRACE,
  data: {
    ...TRACE.data,
    sends: [{ kind: "reply", status: "uncertain", attempts: 1, error: null, at: "2026-10-31T10:00:00.000Z" }],
  },
});
const TRACE = {
  data: {
    calls: [
      {
        id: "c1",
        step: "verdict",
        model: "Muse Spark 1.3",
        ms: 2600,
        attempt: 1,
        outcome: "ok",
        errorClass: null,
        cached: false,
        usd: 0.004,
        certainty: "measured",
      },
    ],
    actions: [],
    sends: [],
    total: { ms: 2600, unknownTime: 0, measuredUsd: 0.004, estimatedUsd: 0, estimatedCalls: 0 },
  },
  facts: { findings: 1, cited: [] },
  run: ID,
} as unknown as NonNullable<Parameters<typeof ReportLive>[0]["trace"]>;
const running = (progress = RUNNING_1, evidence: CardItem[] = []): Live => ({
  status: "running",
  verdict: null,
  progress,
  coverage: null,
  evidence,
});
// No trusted authentication results were stored (D07 T03 §37): every auth check skipped, the explanation item stored.
const NO_AUTH: Live = {
  status: "running",
  verdict: null,
  progress: RUNNING_3,
  coverage: [
    { check: "auth.spf", outcome: "skipped", reason: null, findings: 0 },
    { check: "auth.dkim", outcome: "skipped", reason: null, findings: 0 },
    { check: "auth.dmarc", outcome: "skipped", reason: null, findings: 0 },
  ],
  evidence: [
    {
      id: "E2",
      check: "auth.results",
      severity: "info",
      summary:
        "Your organisation's receiving system is not known yet, so no Authentication-Results header could be trusted.",
      detail: { trusted: false, reason: "unknown-receiver" },
      artefacts: [],
    },
  ],
};
// The early authentication card's stored facts (D07 T03 §37, D07 T09 §19): the outcomes have run and each method's
// item is stored with supporting diagnostic detail (including long addresses/identifiers, mixed DKIM signatures, DMARC
// policy and compauth).
const LONG_HOST = `mail-${"x".repeat(48)}.sender-verification.example`;
const EARLY: Live = {
  status: "running",
  verdict: null,
  progress: RUNNING_3,
  coverage: [
    { check: "auth.results", outcome: "ran", reason: null, findings: 1 },
    { check: "auth.spf", outcome: "ran", reason: null, findings: 1 },
    { check: "auth.dkim", outcome: "ran", reason: null, findings: 1 },
    { check: "auth.dmarc", outcome: "ran", reason: null, findings: 1 },
  ],
  evidence: [
    {
      id: "E1",
      check: "auth.results",
      severity: "info",
      summary: "Microsoft 365, your receiving system, recorded spf fail, dkim none, dmarc pass.",
      detail: {
        trusted: true,
        receiver: "microsoft",
        authservId: "mx.outlook.com",
        results: [
          {
            method: "spf",
            result: "fail",
            props: { "smtp.mailfrom": `bounce@${LONG_HOST}`, "client-ip": "198.51.100.42" },
          },
          { method: "dkim", result: "none", props: {} },
          { method: "dmarc", result: "pass", props: { "header.from": "sender.example", action: "none" } },
          { method: "compauth", result: "fail", props: { reason: "000" } },
        ],
      },
      artefacts: [],
    },
    {
      id: "E2",
      check: "auth.spf",
      severity: "medium",
      summary: "SPF failed for sender.example, as your receiving system recorded.",
      detail: {
        state: "failed",
        results: [
          {
            result: "fail",
            identifier: "sender.example",
            comment: `domain of ${LONG_HOST} does not designate 198.51.100.42 as permitted sender`,
          },
        ],
      },
      artefacts: [],
    },
    {
      id: "E3",
      check: "auth.dkim",
      severity: "info",
      summary: "DKIM was not available, as your receiving system recorded.",
      detail: { state: "unavailable", results: [{ result: "none", identifier: null }] },
      artefacts: [],
    },
    {
      id: "E4",
      check: "auth.dmarc",
      severity: "info",
      summary: "DMARC passed for sender.example, as your receiving system recorded.",
      detail: {
        state: "passed",
        from: "sender.example",
        policy: { certain: "reject" },
        results: [{ result: "pass", identifier: null, comment: "p=REJECT" }],
      },
      artefacts: [],
    },
  ],
};
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

// An upload whose file never arrived, named by 255 unbroken characters (the column's bound).
const GONE: Live = {
  ...FAILED,
  progress: progressOf([ev("admit", "failed", "RawMissing"), ev("reply", "done")]),
  upload: `${"x".repeat(251)}.pdf`,
};
const region = (live: Live) =>
  String(
    <ReportLive
      caseId={ID}
      status={live.status}
      verdict={live.verdict}
      sourceKind={live.upload ? "document" : "mail"}
      channel={live.upload ? "upload" : "email"}
      uploadName={live.upload ?? null}
      {...(live.trace ? { trace: live.trace === "unsettled" ? UNSETTLED_TRACE() : TRACE } : {})}
      traceOpen={live.traceOpen ?? false}
      delivery={live.delivery ?? null}
      {...(live.feedback !== undefined ? { feedback: live.feedback } : {})}
      evidence={live.evidence}
      progress={live.progress}
      coverage={live.coverage}
      view="member"
      meta={
        <MetaLine
          facts={{
            subject: "October statement",
            fromName: null,
            fromAddress: "sender@fynbos.example",
            channel: "email",
            headersAvailable: false,
            forwardedBy: null,
            checker: { kind: "member", name: "Sipho Dube" },
            at: "Sun 26 Oct, 16:40",
          }}
          view="member"
        />
      }
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
        sourceKind: live.upload ? "document" : "mail",
        channel: live.upload ? "upload" : "email",
        ...(live.upload ? { uploadName: live.upload } : {}),
        createdAt: new Date().toISOString(),
      }}
      verdict={live.verdict}
      evidence={live.evidence}
      shell={shell}
      progress={live.progress}
      coverage={live.coverage}
      traceOpen={live.traceOpen ?? false}
      {...(live.trace ? { trace: live.trace === "unsettled" ? UNSETTLED_TRACE() : TRACE } : {})}
    />,
  );
}

// The mail section asks again every 15 seconds; the test asks every second (the only change to what the server sends).
const quick = (html: string) => html.replace("every 15s", "every 1s");

// Each poll takes the next answer from the test's script; the last one repeats.
type Answer = Live | 503 | "redirect" | "slow" | { delay: number; live: Live };
const state = {
  first: running() as Live,
  answers: [] as Answer[],
  polls: [] as number[],
  pollUrls: [] as string[],
  pages: 0,
  // "Retry the check" (D07 T03 §20): each POST counted; `accept` starts the new run and answers with the report,
  // `withhold` starts it and answers nothing the page can follow, as a lost answer or a stopped page leaves it.
  mailAnswers: [] as ("503" | "sent")[],
  mailPolls: 0,
  mailUrls: [] as string[],
  retries: 0,
  retry: "accept" as "accept" | "withhold",
};

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === `/r/${ID}/trace-mail`) {
      state.mailPolls++;
      state.mailUrls.push(req.url ?? "");
      const next = state.mailAnswers.shift() ?? "sent";
      if (next === "503") return res.writeHead(503).end();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(
        quick(
          String(
            <TraceMail
              caseId={ID}
              run={ID}
              awaiting={false}
              sends={[{ kind: "reply", status: next, attempts: 1, error: null, at: "2026-10-31T10:00:00.000Z" }]}
            />,
          ),
        ),
      );
    }
    if (path === `/r/${ID}/retry` && req.method === "POST") {
      state.retries++;
      state.first = running();
      state.answers = [running()];
      // An answer the page cannot follow: a 204 leaves the page where it is, as a lost answer or a stopped page does.
      if (state.retry === "withhold") return res.writeHead(204).end();
      return res.writeHead(303, { location: `/r/${ID}` }).end();
    }
    if (path === `/r/${ID}/status`) {
      state.polls.push(Date.now());
      state.pollUrls.push(req.url ?? "");
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
      return res.end(quick(page(state.first)));
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
  Object.assign(state, {
    first,
    answers,
    polls: [],
    pollUrls: [],
    pages: 0,
    retries: 0,
    retry: "accept",
    mailAnswers: [],
    mailPolls: 0,
  });
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
  // D07 T03 §37: a watched report gains the early authentication card on the poll that stores the outcomes, said once.
  it("gains the early authentication card on a later poll, announced once, at both widths and themes", async () => {
    for (const [width, theme] of [
      [360, "light"],
      [360, "dark"],
      [1280, "light"],
      [1280, "dark"],
    ] as const) {
      const later = {
        ...EARLY,
        progress: progressOf([
          ev("admit", "done"),
          ev("parse", "done"),
          ev("checks", "done"),
          ev("verdict", "started"),
        ]),
      };
      const { p, context } = await open(running(RUNNING_3), [EARLY, later], width, theme);
      expect(await p.getByText("What the receiving mail system recorded").count()).toBe(0);
      await expect
        .poll(() => p.getByText("What the receiving mail system recorded").count(), { timeout: 10_000 })
        .toBe(1);
      expect(await p.getByText("Not signed").isVisible()).toBe(true);
      expect(await p.getByText(`smtp.mailfrom=bounce@${LONG_HOST}`, { exact: false }).isVisible()).toBe(true);
      expect(await p.getByText("From domain: sender.example").isVisible()).toBe(true);
      expect(await p.getByText("Composite authentication (compauth): fail · reason 000").isVisible()).toBe(true);
      const cardOverflow = await p.evaluate(() => {
        const sec = document.querySelector("section[aria-labelledby='early-auth-title']");
        if (!sec) return true;
        return [...sec.querySelectorAll("li, p, span, strong")].some(
          (el) => (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1,
        );
      });
      expect(cardOverflow, `${width} ${theme}`).toBe(false);
      expect(await announced(p)).toContain("Early authentication results are in.");
      // The next step is announced too, without the early words a second time.
      await expect.poll(() => announced(p), { timeout: 10_000 }).toContain("Step 4 of 7");
      expect((await said(p)).filter((s) => s.includes("Step 4 of 7"))).toHaveLength(1);
      expect((await said(p)).filter((s) => s.includes("Early authentication results are in."))).toHaveLength(1);
      expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await p.addScriptTag({ path: AXE });
      expect(problems(await scan(p))).toEqual([]);
      await context.close();
    }
    // The no-trusted-results state arrives announced once, with its own words and no method pill.
    const { p, context } = await open(running(RUNNING_3), [NO_AUTH], 360, "light");
    await expect
      .poll(() => p.getByText("What the receiving mail system recorded").count(), { timeout: 10_000 })
      .toBe(1);
    expect(await p.getByText("receiving system is not known yet", { exact: false }).first().isVisible()).toBe(true);
    expect((await said(p)).filter((s) => s.includes("No trusted authentication results were stored."))).toHaveLength(1);
    await context.close();
  });

  // D07 T09 §1: the card lands on the first poll after the auth outcomes are stored, not a poll later.
  it("shows the early card on the first poll after the auth outcomes land", async () => {
    const { p, context } = await open(running(RUNNING_3), [EARLY], 360, "light");
    expect(await p.getByText("What the receiving mail system recorded").count()).toBe(0);
    await expect
      .poll(() => p.getByText("What the receiving mail system recorded").count(), { timeout: 10_000 })
      .toBe(1);
    expect(state.polls).toHaveLength(1);
    await context.close();
  });

  // D07 T03 §5: a report watched while it runs receives its completed model trace in the poll that finishes it, with no
  // navigation; asked open by its address, it finishes open, and the poll carried that ask.
  it("gives a watched report its model trace at the finishing poll, collapsed or open as asked, without navigation", async () => {
    const finished = { ...DONE, trace: true };
    for (const traceOpen of [false, true]) {
      const { p, context } = await open({ ...running(RUNNING_3, EVIDENCE), traceOpen }, [{ ...finished, traceOpen }]);
      expect(await p.locator("details[data-model-trace]").count()).toBe(0);
      await expect.poll(() => p.locator("details[data-model-trace]").count(), { timeout: 10_000 }).toBe(1);
      expect(await p.locator("details[data-model-trace]").evaluate((el) => el.hasAttribute("open"))).toBe(traceOpen);
      expect(await p.getByText("How Meta's models worked on this case").isVisible()).toBe(true);
      expect(state.pages).toBe(1);
      expect(state.pollUrls.some((u) => u.includes("trace=1"))).toBe(traceOpen);
      await context.close();
    }
  });

  // D07 T03 §5 (completion review): a send still unsettled when the report stops polling is refreshed in the mail section
  // alone: a failed refresh says nothing and moves nothing, and the one that finds it settled updates that section while
  // the open panel and the page stay as they were.
  it("refreshes an unsettled send in its own section, silently through a failure, keeping the panel open and the page", async () => {
    const { p, context } = await open({ ...DONE, trace: "unsettled", traceOpen: true }, [DONE]);
    state.mailAnswers = ["503", "sent"];
    expect(await p.getByText("Reply: may have been sent").count()).toBe(1);
    await expect.poll(() => p.getByText("Reply: sent").count(), { timeout: 15_000 }).toBe(1);
    expect(await p.getByText("Reply: may have been sent").count()).toBe(0);
    expect(state.mailPolls).toBeGreaterThanOrEqual(2);
    // Every refresh named the run it was drawn for.
    expect(state.mailUrls.every((u) => u.includes(`run=${ID}`))).toBe(true);
    // No stale line, no navigation, the panel still open: only the mail section changed.
    expect(await p.locator("#report-stale").count()).toBe(0);
    expect(state.pages).toBe(1);
    expect(await p.locator("details[data-model-trace]").evaluate((el) => el.hasAttribute("open"))).toBe(true);
    // Settled, it stops asking.
    const asked = state.mailPolls;
    await p.waitForTimeout(2500);
    expect(state.mailPolls).toBe(asked);
    await context.close();
  });

  // D07 T03 §20: one retry for two presses, the button busy while it posts, landing on the running report.
  it("retries a failed check once for two presses, reading Retrying, and lands on the running report", async () => {
    const { p, context } = await open(FAILED, [FAILED]);
    const button = p.getByRole("button", { name: "Retry the check" });
    await button.click({ noWaitAfter: true });
    await button.click({ force: true, noWaitAfter: true, timeout: 1_000 }).catch(() => undefined);
    await p.waitForURL(`${origin}/r/${ID}`);
    await expect.poll(() => p.getByText("We are investigating this message.").count()).toBe(1);
    expect(state.retries).toBe(1);
    await context.close();
  });

  it("offers where the retry stands when its answer never comes, sending nothing again", async () => {
    const { p, context } = await open(FAILED, [FAILED]);
    state.retry = "withhold";
    const button = p.getByRole("button", { name: "Retry the check" });
    await button.click({ noWaitAfter: true });
    await expect.poll(() => p.locator("form[data-busy] button[type=submit]").textContent()).toBe("Retrying");
    expect(await p.locator("form[data-busy] button[type=submit]").isDisabled()).toBe(true);
    const check = p.getByRole("link", { name: "Taking a while? See where it stands" });
    await expect.poll(() => check.count(), { timeout: 15_000 }).toBe(1);
    // Followed through the page: Playwright's own click would wait on the POST navigation that never finishes.
    await p.evaluate(() => (document.querySelector("a[data-busy-check-link]") as HTMLAnchorElement).click());
    await expect.poll(() => p.getByText("We are investigating this message.").count()).toBe(1);
    expect(state.retries).toBe(1);
    await context.close();
  });

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

  it("offers a member the dispute once a running report finishes", async () => {
    const { p, context } = await open(running(), [{ ...DONE, feedback: null }]);
    expect(await p.getByText("Was this verdict wrong?").count()).toBe(0);
    await expect.poll(() => announced(p), { timeout: 10_000 }).toBe("Checked: Suspicious");
    expect(await p.getByText("Was this verdict wrong?").isVisible()).toBe(true);
    await context.close();
  });

  // D07 T03 §43: the phone attribution survives a real status swap, under the subject and before the band.
  it("keeps who brought the case in on a phone through the finish", async () => {
    const { p, context } = await open(running(), [{ ...DONE, feedback: null }], 360);
    await expect.poll(() => announced(p), { timeout: 10_000 }).toBe("Checked: Suspicious");
    const line = p.locator("p.md\\:hidden", { hasText: "Forwarded by Sipho Dube" });
    await expect.poll(() => line.isVisible()).toBe(true);
    const order = await p.evaluate(() => {
      const all = [...document.querySelectorAll("p")];
      const attr = all.find((el) => el.textContent?.includes("Forwarded by Sipho Dube"));
      const band = document.querySelector("section");
      return { attr: attr?.getBoundingClientRect().top ?? -1, band: band?.getBoundingClientRect().top ?? -1 };
    });
    expect(order.attr).toBeGreaterThanOrEqual(0);
    expect(order.attr).toBeLessThan(order.band);
    await context.close();
    // The same through a failed finish, and the subject line before the attribution in the DOM.
    const failed = await open(running(), [FAILED], 360);
    await expect
      .poll(() => failed.p.locator("p.md\\:hidden", { hasText: "Forwarded by Sipho Dube" }).isVisible(), {
        timeout: 10_000,
      })
      .toBe(true);
    const dom = await failed.p.evaluate(() => {
      const all = [...document.querySelectorAll("p")];
      const subject = all.findIndex((el) => el.textContent?.includes("October statement"));
      const attr = all.findIndex((el) => el.textContent?.includes("Forwarded by Sipho Dube"));
      return { subject, attr };
    });
    expect(dom.subject).toBeGreaterThanOrEqual(0);
    expect(dom.subject).toBeLessThan(dom.attr);
    await failed.context.close();
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
          ["file never arrived", GONE],
        ] as const) {
          const { p, context } = await open(live, [live], width, theme);
          expect(await p.evaluate(() => document.documentElement.scrollWidth), name).toBeLessThanOrEqual(width);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p)), name).toEqual([]);
          await context.close();
        }
      });
});
