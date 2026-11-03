import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CaseFilters,
  type CasePage,
  filtersFrom,
  type ListedCase,
  type WeeklyStats,
} from "../../src/db/case-filters";
import { anchorOf, GalleryState } from "../../src/web/dev/gallery";
import { AdminEvalPage } from "../../src/web/pages/admin-eval-view";
import { FeedbackQueuePage } from "../../src/web/pages/admin-feedback-view";
import { OrgDetailPage } from "../../src/web/pages/admin-org-view";
import { OverviewPage } from "../../src/web/pages/admin-view";
import { CasesPage } from "../../src/web/pages/cases-view";
import { errorPage } from "../../src/web/pages/errors";
import { EvalPage } from "../../src/web/pages/eval-view";
import { ReportLive } from "../../src/web/pages/report-live";
import { progressOf } from "../../src/web/pages/report-progress";
import { ReportDocument } from "../../src/web/pages/report-view";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// Premium polish sweep over every surface in Chromium (D07 T01 §17):
// 1. Browser autofill (`-webkit-autofill` / `[data-autofilled="true"]`) uses token surface and ink colours in both
//    `app.css` and `site.css` across light and dark themes.
// 2. Text selection (`::selection`) uses `--color-orange-wash` background and `--color-ink` text in both `app.css` and
//    `site.css` across light and dark themes.
// 3. Numbers line up (`font-variant-numeric: tabular-nums`) on Cases stats, counts export preview, admin tables/cards,
//    admin-eval and public eval pages, with equal advance width across changing digits (`111` vs `888`).
// 4. Wide tables survive a 360 px phone (`admin-org-view.tsx`, `admin-feedback-view.tsx`, `admin-eval-view.tsx`, and
//    gallery `polish/wide-table`) via horizontal scroll with a sticky first column and reachable actions.
// 5. Motion respects `prefers-reduced-motion: reduce` across `app.css` and `site.css` in both themes, with zero box-size
//    shift on hover or focus.
// 6. Long organisation names, case titles and file names truncate cleanly at 360 px with zero horizontal overflow and
//    expose the full text via `title` and the report link one activation away.
// 7. Loading reads as loading: full-document navigation vs in-page HTMX Cases filter/pagination updates (`#case-loading`
//    within one frame while delayed, swapping to results or genuine empty state, and recovering via error page on
//    outage) and `report-live.tsx` polling `Report-Running` until settled.
// 8. Per-surface evidence table recorded in `todo/07-app/TODO-01-design-system.md` §17.

const ROOT = join(import.meta.dirname, "../..");
const PUBLIC = join(ROOT, "public");
const DIR = join(ROOT, `build/test-polish-${process.pid}`);
const colors = JSON.parse(readFileSync(join(ROOT, "design/tokens/colors.json"), "utf-8")).themes;
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const NOW = new Date("2026-11-03T12:00:00Z");

const STATS: WeeklyStats = {
  thisWeek: {
    weekStart: "2026-11-01T22:00:00.000Z",
    checked: 111,
    malicious: 12,
    suspicious: 7,
    safe: 89,
    unfinished: 3,
    kinds: { phishing: 12, invoice: 7, impersonation: 0 },
    medianSecondsToVerdict: 48,
  },
  lastWeekChecked: 888,
};

const LONG_CASE: ListedCase = {
  id: "01LONGCASE0000000000000000",
  channel: "upload",
  sourceKind: "document",
  status: "done",
  verdict: "malicious",
  createdAt: NOW.toISOString(),
  checkedBy: "Thandi Nkosi",
  hasInvoice: true,
  hasPaymentDocument: true,
  subject: null,
  senderName: "Bloemfonteinvervoerdienstverskaffers Mountain View Logistics (Pty) Ltd",
  senderAddress: "accounts-payable-verification@bloemfonteinvervoerdienstverskaffers-logistics.co.za",
  uploadName:
    "URGENT-REMITTANCE-ADVICE-Bloemfonteinvervoerdienstverskaffers-Mountain-View-Logistics-2026-11-03-revised-banking-confirmation.pdf",
  uploadMediaType: "application/pdf",
};

const ALL_CASES: ListedCase[] = [
  LONG_CASE,
  ...Array.from({ length: 29 }, (_, idx) => ({
    ...LONG_CASE,
    id: `01CASE${String(idx + 2).padStart(20, "0")}`,
    uploadName: `invoice-${idx + 2}.pdf`,
  })),
];

let browser: Browser;
let appCss = "";
let siteCss = "";
let server: Server;
let origin = "";

const serverState = {
  delayMs: 0,
  fail: false,
  pollFinished: false,
};

async function handleRequest(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/cases") {
    const filters: CaseFilters = filtersFrom(url.searchParams);
    if (serverState.delayMs > 0 && req.headers["hx-request"] === "true") {
      await new Promise((done) => setTimeout(done, serverState.delayMs));
    }
    if (serverState.fail) {
      return errorPage(500, "", { retry: `${url.pathname}${url.search}` });
    }
    const matched = filters.verdict === "safe" ? [] : ALL_CASES;
    const pages = Math.max(1, Math.ceil(matched.length / 25));
    const pageNum = Math.min(Math.max(1, filters.page), pages);
    const slice = matched.slice((pageNum - 1) * 25, pageNum * 25);
    const list: CasePage = {
      cases: slice,
      page: pageNum,
      pages,
      matching: matched.length,
      total: ALL_CASES.length,
    };
    const { children: _, ...shell } = member({
      organization: {
        id: "org-long",
        name: "Bloemfonteinvervoerdienstverskaffers Mountain View Logistics (Pty) Ltd",
      },
    });
    return new Response(
      String(
        <CasesPage
          shell={shell}
          list={list}
          filters={filters}
          senders={{ domains: ["karoocouriers.example"], addresses: [] }}
          stats={STATS}
          now={NOW}
          members={[{ id: "thandi", label: "Thandi Nkosi" }]}
        />,
      ),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } },
    );
  }
  if (url.pathname === "/r/01RUNNING" || url.pathname === "/r/01RUNNING/status") {
    const isPoll = url.pathname.endsWith("/status");
    const done = isPoll && serverState.pollFinished;
    const progress = progressOf(
      done
        ? [
            { step: "admit", status: "done", startedAt: NOW.toISOString(), ms: 120, error: null },
            { step: "parse", status: "done", startedAt: NOW.toISOString(), ms: 180, error: null },
          ]
        : [{ step: "admit", status: "started", startedAt: NOW.toISOString(), ms: null, error: null }],
    );
    const live = (
      <ReportLive
        caseId="01RUNNING"
        channel="upload"
        delivery={null}
        status={done ? "done" : "running"}
        verdict={
          done
            ? {
                verdict: "safe",
                headline: "No phishing or invoice fraud indicators were found.",
                confidence: 0.92,
                reasons: [{ text: "Known sender and unchanged bank details.", evidenceIds: ["E1"] }],
                actions: ["You can proceed with your normal approval checks."],
              }
            : null
        }
        sourceKind="document"
        evidence={[
          {
            id: "E1",
            check: "invoice.bank_match",
            severity: "info",
            summary: "Bank details match the supplier record.",
            detail: {},
            artefacts: [],
          },
        ]}
        progress={progress}
        coverage={[{ check: "invoice.bank_match", outcome: "ran", reason: null, findings: 1 }]}
        view="member"
        now={NOW}
      />
    );
    if (isPoll) {
      return new Response(String(live), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
      });
    }
    const { children: _, ...shell } = member();
    return new Response(
      String(
        <ReportDocument
          stored={{
            id: "01RUNNING",
            status: done ? "done" : "running",
            verdict: done ? "safe" : null,
            sourceKind: "document",
            channel: "upload",
            uploadName: "invoice.pdf",
            createdAt: NOW.toISOString(),
          }}
          verdict={
            done
              ? {
                  verdict: "safe",
                  headline: "No phishing or invoice fraud indicators were found.",
                  confidence: 0.92,
                  reasons: [{ text: "Known sender and unchanged bank details.", evidenceIds: ["E1"] }],
                  actions: ["You can proceed with your normal approval checks."],
                }
              : null
          }
          evidence={[
            {
              id: "E1",
              check: "invoice.bank_match",
              severity: "info",
              summary: "Bank details match the supplier record.",
              detail: {},
              artefacts: [],
            },
          ]}
          shell={shell}
          progress={progress}
          coverage={[{ check: "invoice.bank_match", outcome: "ran", reason: null, findings: 1 }]}
        />,
      ),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } },
    );
  }
  const file = join(PUBLIC, url.pathname);
  if (url.pathname.startsWith("/static/") && existsSync(file)) {
    const type = url.pathname.endsWith(".css")
      ? "text/css"
      : url.pathname.endsWith(".js")
        ? "text/javascript"
        : url.pathname.endsWith(".svg")
          ? "image/svg+xml"
          : "font/woff2";
    return new Response(readFileSync(file), {
      headers: { "content-type": type, "cache-control": "public, max-age=3600, immutable" },
    });
  }
  return new Response("not found", { status: 404 });
}

beforeAll(async () => {
  mkdirSync(DIR, { recursive: true });
  const appOut = join(DIR, "app.css");
  const siteOut = join(DIR, "site.css");
  const runApp = spawnSync(process.execPath, [join(ROOT, "scripts/build-css.ts"), "--no-tokens", "--out", appOut], {
    encoding: "utf-8",
  });
  expect(runApp.status, runApp.stderr).toBe(0);
  const runSite = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/build-css.ts"), "--no-tokens", "--input", "site/src/styles/site.css", "--out", siteOut],
    { encoding: "utf-8" },
  );
  expect(runSite.status, runSite.stderr).toBe(0);
  appCss = readFileSync(appOut, "utf-8");
  siteCss = readFileSync(siteOut, "utf-8");
  browser = await launch();
  server = createServer(async (req, res) => {
    const out = await handleRequest(req);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
  rmSync(DIR, { recursive: true, force: true });
});

async function openStyled(
  body: string,
  options: { theme?: "light" | "dark"; css?: string; width?: number; reducedMotion?: "reduce" | "no-preference" } = {},
): Promise<{ page: Page; close: () => Promise<void> }> {
  const theme = options.theme ?? "light";
  const css = options.css ?? appCss;
  const width = options.width ?? 1280;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  const page = await context.newPage();
  await page.route("http://app.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en-ZA" data-theme="${theme}"><head><style>${css}</style></head><body class="bg-surface text-ink">${body}</body></html>`,
      });
    const file = join(PUBLIC, path);
    if (!path.startsWith("/static/") || !existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
  await page.goto("http://app.test/", { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  return { page, close: () => context.close() };
}

describe.skipIf(!chromiumPath() && !process.env.CI)(
  "premium polish sweep in Chromium (D07 T01 §17)",
  { timeout: 60_000 },
  () => {
    for (const theme of ["light", "dark"] as const) {
      for (const [surfaceName, cssText] of [
        ["app.css", () => appCss],
        ["site.css", () => siteCss],
      ] as const) {
        it(`keeps theme surface and ink colours on autofilled inputs and ::selection in ${surfaceName} (${theme})`, async () => {
          const stateMarkup = String(GalleryState(anchorOf("state", "polish/signin-autofill")));
          const { page, close } = await openStyled(
            `<div id="selectable">Report text and marketing copy for selection check.</div><input id="native-autofill-email" type="email" value="thandi@karoocouriers.co.za" class="h-control px-16 rounded-control border border-control-border bg-surface text-ink" />${stateMarkup}`,
            { theme, css: cssText() },
          );
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("DOM.enable");
          await cdp.send("CSS.enable");
          const doc = await cdp.send("DOM.getDocument");
          const node = await cdp.send("DOM.querySelector", {
            nodeId: doc.root.nodeId,
            selector: "#native-autofill-email",
          });
          await cdp.send("CSS.forcePseudoState", {
            nodeId: node.nodeId,
            forcedPseudoClasses: ["autofill"],
          });
          const t = colors[theme];
          const shotBase64 = (await page.locator("#native-autofill-email").screenshot()).toString("base64");
          const styles = await page.evaluate(async (pngB64) => {
            const nativeInput = document.getElementById("native-autofill-email") as HTMLInputElement;
            const ns = getComputedStyle(nativeInput);
            const galleryInput = document.getElementById("g-autofill-email") as HTMLInputElement;
            const gs = getComputedStyle(galleryInput);
            const sel = getComputedStyle(document.getElementById("selectable") as HTMLElement, "::selection");
            const img = new Image();
            img.src = `data:image/png;base64,${pngB64}`;
            await img.decode();
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("no 2d context");
            ctx.drawImage(img, 0, 0);
            // Sample a background pixel near the right inner padding of the input (away from the left-aligned text)
            const px = ctx.getImageData(Math.max(2, img.width - 10), Math.floor(img.height / 2), 1, 1).data;
            return {
              nativeWebkitTextFill: ns.getPropertyValue("-webkit-text-fill-color").trim(),
              nativeCaret: ns.caretColor,
              nativeShadow: ns.boxShadow,
              paintedSurfaceRgb: `rgb(${px[0]}, ${px[1]}, ${px[2]})`,
              galleryColor: gs.color,
              galleryWebkitTextFill: gs.getPropertyValue("-webkit-text-fill-color").trim(),
              galleryBg: gs.backgroundColor,
              galleryShadow: gs.boxShadow,
              selectionBg: sel.backgroundColor,
              selectionColor: sel.color,
            };
          }, shotBase64);
          expect(styles.nativeWebkitTextFill).toBe(rgb(t.ink));
          expect(styles.nativeCaret).toBe(rgb(t.ink));
          expect(styles.nativeShadow).toContain(rgb(t.surface));
          expect(styles.paintedSurfaceRgb).toBe(rgb(t.surface));
          expect(styles.galleryColor).toBe(rgb(t.ink));
          expect(styles.galleryWebkitTextFill).toBe(rgb(t.ink));
          expect(styles.galleryBg).toBe(rgb(t.surface));
          expect(styles.galleryShadow).toContain(rgb(t.surface));
          expect(styles.selectionBg).toBe(rgb(t["orange-wash"]));
          expect(styles.selectionColor).toBe(rgb(t.ink));
          await close();
        });
      }
    }

    for (const theme of ["light", "dark"] as const) {
      it(`renders tabular-nums on stats tiles, counts export preview and admin/eval figures with equal digit advance width (${theme})`, async () => {
        const statsMarkup = String(GalleryState(anchorOf("state", "polish/cases-stats")));
        const adminOverview = String(
          <OverviewPage
            shell={{ operator: "Thandi", feedbackOpen: 2 }}
            generatedAt="3 Nov 2026, 12:00 SAST"
            organisations={14}
            orgsVerified={11}
            casesToday={27}
            casesTotal={888}
            medianSeconds={48}
            p95Seconds={112}
            feedbackOpen={2}
            spend={[]}
            query=""
            capDraft={null}
            rows={[
              {
                id: "org-1",
                name: "Karoo Couriers",
                created: "2026-10-27T10:00:00Z",
                plan: "Protect",
                domainsVerified: 1,
                domainsPending: false,
                members: 5,
                casesWeek: 27,
                topCheck: "phishing",
                feedbackOpen: 2,
                capOverride: null,
                capEffective: 100,
              },
            ]}
            incidents={[]}
          />,
        );
        const adminEval = String(
          <AdminEvalPage shell={{ operator: "Thandi", feedbackOpen: 0 }} runs={[]} latest={null} ablations={[]} />,
        );
        const publicEval = String(
          <EvalPage
            view={{
              kind: "empty",
              counts: {
                cases: 111,
                flagged: 19,
                bankChanges: 4,
                invoiceFlags: 7,
                medianSeconds: 48,
                reportedWrong: 1,
                since: "2026-10-27",
              },
              history: [],
            }}
          />,
        );
        const { page, close } = await openStyled(
          `<div>${statsMarkup}<div id="admin-overview">${adminOverview}</div><div id="admin-eval">${adminEval}</div><div id="public-eval">${publicEval}</div></div>`,
          { theme },
        );
        const metrics = await page.evaluate(() => {
          const measureTextWidth = (el: HTMLElement) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return Math.round(range.getBoundingClientRect().width * 100) / 100;
          };
          const stat111 = document.getElementById("g-stat-111") as HTMLElement;
          const stat888 = document.getElementById("g-stat-888") as HTMLElement;
          const figureEls = [...document.querySelectorAll(".type-figure, .tabular-nums")] as HTMLElement[];
          return {
            stat111Variant: getComputedStyle(stat111).fontVariantNumeric,
            stat888Variant: getComputedStyle(stat888).fontVariantNumeric,
            width111: measureTextWidth(stat111),
            width888: measureTextWidth(stat888),
            allTabular: figureEls.every((el) => getComputedStyle(el).fontVariantNumeric.includes("tabular-nums")),
            figureCount: figureEls.length,
          };
        });
        expect(metrics.stat111Variant).toContain("tabular-nums");
        expect(metrics.stat888Variant).toContain("tabular-nums");
        expect(metrics.width111).toBeGreaterThan(0);
        expect(metrics.width111).toBe(metrics.width888);
        expect(metrics.figureCount).toBeGreaterThan(10);
        expect(metrics.allTabular).toBe(true);
        await close();
      });
    }

    it("scrolls wide tables horizontally at 360 px with a sticky first column and keeps every action reachable without page overflow", async () => {
      const sampleReport = {
        run: {
          id: "run-01",
          mode: "full",
          sets: ["synthetic-sa"],
          setVersion: "1234567890abcdef",
          commit: "02931b6a6491d0b8c1771f5d9bea2b2a88c0b9aa",
          startedAt: "2026-11-03T10:00:00Z",
          finishedAt: "2026-11-03T10:05:00Z",
          status: "complete",
          selected: 40,
          stored: 40,
          sampleLimit: null,
        },
        complete: true,
        main: {
          attacks: 20,
          genuine: 20,
          measuredGenuine: 20,
          detection: { n: 20, hits: 20, rate: 1 },
          falsePositives: { n: 20, hits: 0, rate: 0 },
          modelBasis: { n: 40, hits: 40, rate: 1 },
          checksBasis: { n: 40, hits: 40, rate: 1 },
          analysisMs: { n: 40, median: 12000, p95: 25000 },
          costUsd: { n: 40, median: 0.018, total: 0.72 },
          byCategory: {},
        },
        targets: [],
      };
      const sampleAblation = {
        mode: "ablate:no-walkthrough",
        runId: "run-ablate-01",
        comparable: true as const,
        detection: { n: 20, hits: 17, rate: 0.85 },
        falsePositives: { n: 20, hits: 0, rate: 0 },
        medianMs: 4000,
        medianUsd: 0.006,
        detectionDelta: -0.15,
        falsePositiveDelta: 0,
        msDelta: -8000,
        usdDelta: -0.012,
      };
      const wideGallery = String(GalleryState(anchorOf("state", "polish/wide-table")));
      const feedbackPage = String(
        <FeedbackQueuePage
          shell={{ operator: "Thandi", feedbackOpen: 1 }}
          generatedAt="3 Nov 2026"
          tabs={{ new: 1, triaged: 0, closed: 0 }}
          tab="new"
          items={[
            {
              id: "fb-1",
              caseTitle: "INV-2026-0841 bank details changed",
              caseHref: "/r/01CASE",
              orgName: "Karoo Couriers",
              verdict: "Malicious",
              theySay: "Safe",
              decidedBy: "Muse Spark",
              when: "10:15",
            },
          ]}
          page={0}
          pages={1}
          detail={null}
        />,
      );
      const orgDetail = String(
        <OrgDetailPage
          shell={{ operator: "Thandi", feedbackOpen: 1 }}
          orgId="org-1"
          header={{ name: "Karoo Couriers", planPill: "Protect", meta: "Joined 27 Oct" }}
          extendTrial={{
            enabled: false,
            reason: "Active plan",
            min: "2026-11-04",
            value: "",
            notice: null,
            error: null,
          }}
          cap={{ value: "", error: null, notice: null }}
          plan={{ current: "protect", error: null, notice: null }}
          onboarding={{ done: 5, steps: [] }}
          domains={[]}
          members={[]}
          weeks={[{ label: "This week", total: 27, bad: 4 }]}
          threats={[{ name: "Invoice fraud", count: 4, top: 4 }]}
          feedback={[
            {
              caseTitle: "INV-2026-0841 bank details changed",
              caseHref: "/r/01CASE",
              verdict: "Malicious",
              theySay: "Safe",
              status: "New",
            },
          ]}
          feedbackHref="/admin/feedback"
          planLines={["Protect plan"]}
        />,
      );
      const adminEval = String(
        <AdminEvalPage
          shell={{ operator: "Thandi", feedbackOpen: 0 }}
          latest={{ report: sampleReport, publishedAt: "2026-11-03T10:06:00Z" }}
          ablations={[sampleAblation]}
          runs={[
            {
              id: "run-01",
              mode: "full",
              sets: "synthetic-sa",
              setVersion: "1234567890abcdef",
              commit: "02931b6a6491d0b8c1771f5d9bea2b2a88c0b9aa",
              startedAt: "2026-11-03T10:00:00Z",
              finishedAt: "2026-11-03T10:05:00Z",
              status: "complete",
              selected: 40,
              sampleLimit: null,
              capUsd: 13,
              costUsd: 0.72,
              published: { report: sampleReport, publishedAt: "2026-11-03T10:06:00Z" },
            },
          ]}
        />,
      );
      const publicEval = String(
        <EvalPage
          view={{
            kind: "report",
            report: sampleReport,
            publishedAt: "2026-11-03T10:06:00Z",
            ablations: [sampleAblation],
            counts: {
              cases: 111,
              flagged: 19,
              bankChanges: 4,
              invoiceFlags: 7,
              medianSeconds: 48,
              reportedWrong: 1,
              since: "2026-10-27",
            },
            history: [{ report: sampleReport, publishedAt: "2026-11-03T10:06:00Z", comparable: true, reason: null }],
          }}
        />,
      );
      const { page, close } = await openStyled(
        `<div id="wide-gallery">${wideGallery}</div><div id="feedback-queue">${feedbackPage}</div><div id="org-detail">${orgDetail}</div><div id="admin-eval">${adminEval}</div><div id="public-eval">${publicEval}</div>`,
        { width: 360 },
      );
      const tableCheck = await page.evaluate(() => {
        const tables = [...document.querySelectorAll("table[class*='min-w-']")] as HTMLTableElement[];
        return tables.map((table) => {
          const wrap = table.closest(".overflow-x-auto") as HTMLElement;
          const headFirst = table.querySelector("thead th:first-child") as HTMLElement;
          const firstCell = table.querySelector("tbody td, tbody th") as HTMLElement;
          const lastCell = table.querySelector("tbody td:last-child") as HTMLElement;
          const beforeLeft = firstCell.getBoundingClientRect().left;
          wrap.scrollLeft = wrap.scrollWidth;
          const afterLeft = firstCell.getBoundingClientRect().left;
          const lastRect = lastCell.getBoundingClientRect();
          const wrapRect = wrap.getBoundingClientRect();
          return {
            overflowX: getComputedStyle(wrap).overflowX,
            headSticky: getComputedStyle(headFirst).position,
            stickyPosition: getComputedStyle(firstCell).position,
            scrollable: wrap.scrollWidth > wrap.clientWidth,
            pinnedFirstColumn: Math.round(beforeLeft) === Math.round(afterLeft),
            lastCellReachable: lastRect.right <= wrapRect.right + 2,
          };
        });
      });
      expect(tableCheck.length).toBe(7);
      for (const item of tableCheck) {
        expect(item).toEqual({
          overflowX: "auto",
          headSticky: "sticky",
          stickyPosition: "sticky",
          scrollable: true,
          pinnedFirstColumn: true,
          lastCellReachable: true,
        });
      }
      await close();
    });

    for (const theme of ["light", "dark"] as const) {
      for (const [surfaceName, cssText] of [
        ["app.css", () => appCss],
        ["site.css", () => siteCss],
      ] as const) {
        it(`silences transitions and animations under prefers-reduced-motion and shifts no box size on hover or focus in ${surfaceName} (${theme})`, async () => {
          const focusedMarkup = String(GalleryState(anchorOf("state", "field/focused")));
          const buttonMarkup = String(GalleryState(anchorOf("state", "button/primary")));
          const loadingMarkup = String(GalleryState(anchorOf("state", "polish/loading-sequence")));
          const { page, close } = await openStyled(
            `<div class="flex flex-col gap-16">${focusedMarkup}${buttonMarkup}${loadingMarkup}<a id="site-link" href="#x" class="transition-all duration-300">Link</a></div>`,
            { theme, css: cssText(), reducedMotion: "reduce" },
          );
          const motion = await page.evaluate(async () => {
            const input = document.getElementById("g-focused") as HTMLInputElement;
            const button = document.querySelector("button") as HTMLButtonElement;
            const link = document.getElementById("site-link") as HTMLAnchorElement;
            const pulse = document.querySelector("[class*='animate-pulse']") as HTMLElement | null;
            input.blur();
            const beforeInput = input.getBoundingClientRect();
            input.focus();
            const afterInput = input.getBoundingClientRect();
            const beforeBtn = button.getBoundingClientRect();
            button.focus();
            const afterBtn = button.getBoundingClientRect();
            const linkStyle = getComputedStyle(link);
            const pulseStyle = pulse ? getComputedStyle(pulse) : null;
            return {
              inputSizeChanged: beforeInput.width !== afterInput.width || beforeInput.height !== afterInput.height,
              btnSizeChanged: beforeBtn.width !== afterBtn.width || beforeBtn.height !== afterBtn.height,
              linkTransitionMs:
                Number.parseFloat(linkStyle.transitionDuration) *
                (linkStyle.transitionDuration.endsWith("ms") ? 1 : 1000),
              pulseAnimMs: pulseStyle
                ? Number.parseFloat(pulseStyle.animationDuration) *
                  (pulseStyle.animationDuration.endsWith("ms") ? 1 : 1000)
                : 0,
            };
          });
          expect(motion.inputSizeChanged).toBe(false);
          expect(motion.btnSizeChanged).toBe(false);
          expect(motion.linkTransitionMs).toBeLessThanOrEqual(0.05);
          expect(motion.pulseAnimMs).toBeLessThanOrEqual(0.05);
          await close();
        });
      }
    }

    it("truncates long organisation names, case titles and file names at 360 px with zero horizontal overflow and keeps full text reachable via title and link", async () => {
      const longGallery = String(GalleryState(anchorOf("state", "polish/long-names")));
      const { page: gPage, close: closeG } = await openStyled(longGallery, { width: 360 });
      const gCheck = await gPage.evaluate(() => {
        const titleEl = document.getElementById("g-long-title") as HTMLAnchorElement;
        const senderEl = document.getElementById("g-long-sender") as HTMLElement;
        const ts = getComputedStyle(titleEl);
        const ss = getComputedStyle(senderEl);
        return {
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          titleOverflow: ts.textOverflow,
          titleWhiteSpace: ts.whiteSpace,
          titleTruncated: titleEl.scrollWidth > titleEl.clientWidth,
          titleAttr: titleEl.getAttribute("title"),
          href: titleEl.getAttribute("href"),
          senderOverflow: ss.textOverflow,
          senderTruncated: senderEl.scrollWidth > senderEl.clientWidth,
          senderAttr: senderEl.getAttribute("title"),
        };
      });
      expect(gCheck.pageOverflow).toBe(0);
      expect(gCheck.titleOverflow).toBe("ellipsis");
      expect(gCheck.titleWhiteSpace).toBe("nowrap");
      expect(gCheck.titleTruncated).toBe(true);
      expect(gCheck.titleAttr).toContain("Bloemfonteinvervoerdienstverskaffers");
      expect(gCheck.href).toBe("/r/01LONGCASE");
      expect(gCheck.senderOverflow).toBe("ellipsis");
      expect(gCheck.senderTruncated).toBe(true);
      expect(gCheck.senderAttr).toContain("bloemfonteinvervoerdienstverskaffers");
      await closeG();

      // Also verify the live Cases page at 360 px with long org name, long file name, and long sender
      const context = await browser.newContext({ viewport: { width: 360, height: 900 } });
      const page = await context.newPage();
      await page.goto(`${origin}/cases`, { waitUntil: "load" });
      const casesCheck = await page.evaluate(() => {
        const link = document.querySelector("ol a[href^='/r/']") as HTMLAnchorElement;
        const s = getComputedStyle(link);
        return {
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          textOverflow: s.textOverflow,
          titleAttr: link.getAttribute("title"),
          href: link.getAttribute("href"),
        };
      });
      expect(casesCheck.pageOverflow).toBe(0);
      expect(casesCheck.textOverflow).toBe("ellipsis");
      expect(casesCheck.titleAttr).toBe(LONG_CASE.uploadName);
      expect(casesCheck.href).toContain("/r/01LONGCASE0000000000000000");
      await context.close();
    });

    it("shows loading feedback within one frame on delayed Cases HTMX filter and pagination updates without flashing empty first, settles to results or genuine empty, recovers on failure, and polls Report-Running to completion", async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();

      // 1. Full-document navigation to Cases renders populated cases immediately (25 rows on page 1 of 2) without flashing empty state
      serverState.delayMs = 0;
      serverState.fail = false;
      await page.goto(`${origin}/cases`, { waitUntil: "load" });
      expect(await page.locator("table a[href^='/r/']").count()).toBe(25);
      expect(await page.locator("#case-loading").isVisible()).toBe(false);

      // Install a frame-level and DOM-mutation observer for in-flight HTMX requests:
      // - records whether #case-loading is visible on or before the very next animation frame after htmx:beforeRequest
      // - records whether #case-results ever flashes an empty state while the request is in flight (before htmx:beforeSwap)
      await page.evaluate(() => {
        const w = window as unknown as {
          __loadingWithinOneFrame: boolean[];
          __emptyFlashInFlight: boolean[];
        };
        w.__loadingWithinOneFrame = [];
        w.__emptyFlashInFlight = [];
        let inFlight = false;
        let sawEmpty = false;
        const resultsObserver = new MutationObserver(() => {
          if (!inFlight) return;
          const text = document.getElementById("case-results")?.textContent ?? "";
          if (text.includes("No cases match") || text.includes("Check your first suspicious email")) {
            sawEmpty = true;
          }
        });
        const root = document.body;
        resultsObserver.observe(root, { childList: true, subtree: true, characterData: true });
        document.addEventListener("htmx:beforeRequest", () => {
          inFlight = true;
          sawEmpty = false;
          requestAnimationFrame(() => {
            const loading = document.getElementById("case-loading");
            const visible = Boolean(loading && getComputedStyle(loading).display !== "none");
            w.__loadingWithinOneFrame.push(visible);
          });
        });
        document.addEventListener("htmx:beforeSwap", () => {
          w.__emptyFlashInFlight.push(sawEmpty);
          inFlight = false;
        });
      });

      // 2. Delayed in-page HTMX filter update ("Malicious") shows #case-loading within 1 animation frame and never flashes empty while in flight
      serverState.delayMs = 250;
      await page
        .locator("fieldset label")
        .filter({ hasText: /^Malicious$/ })
        .click();
      await expect.poll(async () => page.locator("#case-loading").isVisible(), { timeout: 1000 }).toBe(true);
      await expect.poll(async () => page.locator("#case-loading").isVisible(), { timeout: 5000 }).toBe(false);
      expect(await page.locator("table a[href^='/r/']").count()).toBe(25);

      // 3. Delayed in-page HTMX pagination update (#case-next) shows #case-loading within 1 animation frame, never flashes empty, and settles to page 2 (5 rows)
      await page.locator("#case-next").click();
      await expect.poll(async () => page.locator("#case-loading").isVisible(), { timeout: 1000 }).toBe(true);
      await expect.poll(async () => page.locator("#case-loading").isVisible(), { timeout: 5000 }).toBe(false);
      expect(await page.locator("table a[href^='/r/']").count()).toBe(5);
      expect(await page.locator("#case-results").textContent()).toContain("Showing 26 to 30 of 30");

      // 4. Delayed in-page filter to a genuine empty filter ("Safe") shows #case-loading within 1 animation frame while keeping existing rows in flight, then swaps to the filtered EmptyState
      await page
        .locator("fieldset label")
        .filter({ hasText: /^Safe$/ })
        .click();
      await expect.poll(async () => page.locator("#case-loading").isVisible(), { timeout: 1000 }).toBe(true);
      await expect
        .poll(async () => page.locator("#case-results").textContent(), { timeout: 5000 })
        .toContain("No cases match Safe");
      expect(await page.locator("#case-loading").isVisible()).toBe(false);

      const frameObservations = await page.evaluate(() => {
        const w = window as unknown as {
          __loadingWithinOneFrame: boolean[];
          __emptyFlashInFlight: boolean[];
        };
        return {
          withinOneFrame: w.__loadingWithinOneFrame,
          emptyFlash: w.__emptyFlashInFlight,
        };
      });
      expect(frameObservations.withinOneFrame).toEqual([true, true, true]);
      expect(frameObservations.emptyFlash).toEqual([false, false, false]);

      // 5. Failure recovery on in-page filter outage navigates to the full-page 500 ErrorState preserving the filter query with Try again
      serverState.delayMs = 0;
      serverState.fail = true;
      await page.locator("fieldset label").filter({ hasText: /^All$/ }).click();
      await expect.poll(async () => page.locator("body").textContent(), { timeout: 5000 }).toContain("Try again");
      serverState.fail = false;
      await page.getByRole("link", { name: "Try again" }).click();
      await expect.poll(async () => page.locator("table a[href^='/r/']").count(), { timeout: 5000 }).toBe(25);

      // 6. Running report page renders Report-Running immediately on navigation, then swaps to the completed verdict on poll
      serverState.pollFinished = false;
      await page.goto(`${origin}/r/01RUNNING`, { waitUntil: "load" });
      expect(await page.locator("#report-live").textContent()).toContain("We are investigating this message.");
      serverState.pollFinished = true;
      await expect
        .poll(async () => page.locator("#report-live").textContent(), { timeout: 6000 })
        .toContain("No phishing or invoice fraud indicators were found.");
      await context.close();
    });

    it("records the per-surface polish sweep evidence in todo/07-app/TODO-01-design-system.md §17", () => {
      const todo = readFileSync(join(ROOT, "todo/07-app/TODO-01-design-system.md"), "utf-8");
      const section17 = todo.slice(todo.indexOf("## 17. Premium polish sweep over every surface"));
      for (const required of [
        "src/web/styles/app.css",
        "site/src/styles/site.css",
        "src/web/pages/cases-view.tsx",
        "src/web/pages/admin-view.tsx",
        "src/web/pages/admin-org-view.tsx",
        "src/web/pages/admin-feedback-view.tsx",
        "src/web/pages/admin-eval-view.tsx",
        "src/web/pages/eval-view.tsx",
        "src/web/pages/report-live.tsx",
        "src/web/components/AppShell.tsx",
        "src/web/dev/gallery.tsx",
        "test/node/polish-browser.test.tsx",
      ]) {
        expect(section17, `§17 records evidence for ${required}`).toContain(required);
      }
    });
  },
);
