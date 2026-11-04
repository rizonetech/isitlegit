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
  recoveryDelayMs: 0,
  fail: false,
  dropConnection: false,
  dropHtmxOnly: false,
  activeOrgId: "org-long",
  seenOrgHeaders: [] as string[],
  pollFinished: false,
};

async function handleRequest(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/cases") {
    const filters: CaseFilters = filtersFrom(url.searchParams);
    const drawnFor = req.headers["x-cases-org"];
    if (typeof drawnFor === "string") serverState.seenOrgHeaders.push(drawnFor);
    if (serverState.delayMs > 0 && req.headers["hx-request"] === "true") {
      await new Promise((done) => setTimeout(done, serverState.delayMs));
    }
    if (serverState.recoveryDelayMs > 0 && req.headers["hx-request"] !== "true") {
      await new Promise((done) => setTimeout(done, serverState.recoveryDelayMs));
    }
    if (typeof drawnFor === "string" && drawnFor !== serverState.activeOrgId) {
      return new Response(null, { status: 204, headers: { "hx-redirect": `${url.pathname}${url.search}` } });
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
    const singleOrg = url.searchParams.get("singleOrg") === "1";
    const { children: _, ...shell } = member({
      organization: {
        id: serverState.activeOrgId,
        name:
          serverState.activeOrgId === "org-other"
            ? "Bloemfonteinvervoerdienstverskaffers Mountain View Logistics (Pty) Ltd Holdings Incorporated"
            : "Bloemfonteinvervoerdienstverskaffers Mountain View Logistics (Pty) Ltd",
      },
      otherOrganizations: singleOrg
        ? []
        : [
            {
              id: "org-other",
              name: "Bloemfonteinvervoerdienstverskaffers Mountain View Logistics (Pty) Ltd Holdings Incorporated",
            },
          ],
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
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (
      url.pathname === "/cases" &&
      (serverState.dropConnection || (serverState.dropHtmxOnly && req.headers["hx-request"] === "true"))
    ) {
      req.socket.destroy();
      return;
    }
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
      const longCaseTitle = "INV-2026-0841-Bloemfonteinvervoerdienstverskaffers-revised-bank-details-changed.pdf";
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
              caseTitle: longCaseTitle,
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
              caseTitle: longCaseTitle,
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
          const otherCells = [...table.querySelectorAll("tbody tr:first-child > td, tbody tr:first-child > th")].slice(
            1,
          ) as HTMLElement[];
          const lastCell = otherCells[otherCells.length - 1] as HTMLElement;
          const beforeLeft = firstCell.getBoundingClientRect().left;
          lastCell.scrollIntoView({ block: "center" });
          const allOtherCellsUncovered = otherCells.every((cell) => {
            const firstW = firstCell.getBoundingClientRect().width;
            wrap.scrollLeft = Math.max(0, cell.offsetLeft - firstW - 8);
            const cRect = cell.getBoundingClientRect();
            const fRect = firstCell.getBoundingClientRect();
            const wRect = wrap.getBoundingClientRect();
            const visibleX = Math.max(cRect.left, fRect.right + 2) + 8;
            const visibleY = cRect.top + cRect.height / 2;
            const hit = document.elementFromPoint(visibleX, visibleY);
            return cRect.right > fRect.right + 4 && visibleX < wRect.right && Boolean(hit && cell.contains(hit));
          });
          wrap.scrollLeft = wrap.scrollWidth;
          const firstRect = firstCell.getBoundingClientRect();
          const lastRect = lastCell.getBoundingClientRect();
          const wrapRect = wrap.getBoundingClientRect();
          const hit = document.elementFromPoint(lastRect.left + lastRect.width / 2, lastRect.top + lastRect.height / 2);
          const link = firstCell.querySelector("a") as HTMLAnchorElement | null;
          return {
            overflowX: getComputedStyle(wrap).overflowX,
            hasTabIndex: wrap.getAttribute("tabindex") === "0",
            hasAriaLabel: Boolean(wrap.getAttribute("aria-label")?.trim()),
            scrollPaddingLeft: getComputedStyle(wrap).scrollPaddingLeft,
            headSticky: getComputedStyle(headFirst).position,
            stickyPosition: getComputedStyle(firstCell).position,
            scrollable: wrap.scrollWidth > wrap.clientWidth,
            pinnedFirstColumn: Math.round(beforeLeft) === Math.round(firstRect.left),
            stickyBounded: firstRect.width <= 200,
            allOtherCellsUncovered,
            lastCellVisible: lastRect.left >= firstRect.right && lastRect.right <= wrapRect.right + 2,
            lastCellUncovered: Boolean(hit && lastCell.contains(hit)),
            linkTruncated: link
              ? getComputedStyle(link).textOverflow === "ellipsis" && link.scrollWidth > link.clientWidth
              : true,
            linkTitle: link ? link.getAttribute("title") : null,
          };
        });
      });
      expect(tableCheck.length).toBe(7);
      for (const item of tableCheck) {
        expect(item).toMatchObject({
          overflowX: "auto",
          hasTabIndex: true,
          hasAriaLabel: true,
          scrollPaddingLeft: "152px",
          headSticky: "sticky",
          stickyPosition: "sticky",
          scrollable: true,
          pinnedFirstColumn: true,
          stickyBounded: true,
          allOtherCellsUncovered: true,
          lastCellVisible: true,
          lastCellUncovered: true,
          linkTruncated: true,
        });
      }
      expect(tableCheck.slice(0, 3).map((item) => item.linkTitle)).toEqual([
        longCaseTitle,
        longCaseTitle,
        longCaseTitle,
      ]);
      // Real keyboard navigation on production and gallery tables without scripted scrollIntoView
      await page.evaluate(() => {
        for (const el of document.querySelectorAll<HTMLElement>(".overflow-x-auto")) el.scrollLeft = 0;
      });
      await page.locator("#feedback-queue .overflow-x-auto").focus();
      await page.keyboard.press("ArrowRight");
      expect(
        await page.evaluate(
          () => (document.querySelector("#feedback-queue .overflow-x-auto") as HTMLElement).scrollLeft,
        ),
      ).toBeGreaterThan(0);
      await page.keyboard.press("Tab");
      const prodLinkFocus = await page.evaluate(() => {
        const link = document.querySelector("#feedback-queue tbody a") as HTMLAnchorElement;
        const rect = link.getBoundingClientRect();
        return {
          focused: document.activeElement === link,
          visible: rect.width > 0 && rect.left >= 0 && rect.right <= 360,
        };
      });
      expect(prodLinkFocus).toEqual({ focused: true, visible: true });

      await page.locator("#wide-gallery .overflow-x-auto").focus();
      await page.keyboard.press("Tab"); // first-column case link
      await page.keyboard.press("Tab"); // final-column Review action link (browser reveals via focus + scroll-padding-left)
      const actionFocus = await page.evaluate(() => {
        const wrap = document.querySelector("#wide-gallery .overflow-x-auto") as HTMLElement;
        const firstCell = wrap.querySelector("tbody td:first-child") as HTMLElement;
        const action = wrap.querySelector("tbody td:last-child a") as HTMLAnchorElement;
        const fRect = firstCell.getBoundingClientRect();
        const aRect = action.getBoundingClientRect();
        const hit = document.elementFromPoint(aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
        return {
          focused: document.activeElement === action,
          rightOfSticky: aRect.left >= fRect.right,
          uncovered: Boolean(hit && action.contains(hit)),
          href: action.getAttribute("href"),
        };
      });
      expect(actionFocus).toEqual({
        focused: true,
        rightOfSticky: true,
        uncovered: true,
        href: "/admin/feedback?selected=01CASE",
      });
      await page.keyboard.press("Shift+Tab");
      expect(
        await page.evaluate(
          () => document.activeElement === document.querySelector("#wide-gallery tbody td:first-child a"),
        ),
      ).toBe(true);
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
            `<div class="flex flex-col gap-16 items-start">${focusedMarkup}${buttonMarkup}${loadingMarkup}<a id="site-link" href="#x" class="transition-all duration-300 text-orange-text underline">Link</a><a id="site-cta" href="#cta" class="inline-flex items-center justify-center h-control px-20 rounded-control bg-orange-text text-on-band hover:bg-orange-hover">Start free trial</a></div>`,
            { theme, css: cssText(), reducedMotion: "reduce" },
          );
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          const sizeChangedOnHoverOrFocus = async (selector: string) => {
            const loc = page.locator(selector).first();
            const rest = await loc.boundingBox();
            await loc.hover();
            const hovered = await loc.boundingBox();
            await loc.focus();
            const focused = await loc.boundingBox();
            await page.mouse.move(0, 0);
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            return (
              !rest ||
              !hovered ||
              !focused ||
              rest.width !== hovered.width ||
              rest.height !== hovered.height ||
              rest.width !== focused.width ||
              rest.height !== focused.height
            );
          };
          expect(await sizeChangedOnHoverOrFocus("#g-focused")).toBe(false);
          expect(await sizeChangedOnHoverOrFocus("button")).toBe(false);
          expect(await sizeChangedOnHoverOrFocus("#site-link")).toBe(false);
          expect(await sizeChangedOnHoverOrFocus("#site-cta")).toBe(false);

          const motion = await page.evaluate(() => {
            const link = document.getElementById("site-link") as HTMLAnchorElement;
            const pulse = document.querySelector("[class*='animate-pulse']") as HTMLElement | null;
            const linkStyle = getComputedStyle(link);
            const pulseStyle = pulse ? getComputedStyle(pulse) : null;
            return {
              linkTransitionMs:
                Number.parseFloat(linkStyle.transitionDuration) *
                (linkStyle.transitionDuration.endsWith("ms") ? 1 : 1000),
              pulseAnimMs: pulseStyle
                ? Number.parseFloat(pulseStyle.animationDuration) *
                  (pulseStyle.animationDuration.endsWith("ms") ? 1 : 1000)
                : 0,
            };
          });
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

      // Also verify the live Cases page at 360 px with long org name in switcher (current and alternative), long file name, and long sender
      const context = await browser.newContext({ viewport: { width: 360, height: 900 } });
      const page = await context.newPage();
      await page.goto(`${origin}/cases`, { waitUntil: "load" });
      await page.click('button[aria-label="Menu"]');
      await page.click("#nav summary");
      const casesCheck = await page.evaluate(() => {
        const link = document.querySelector("ol a[href^='/r/']") as HTMLAnchorElement;
        const s = getComputedStyle(link);
        const currentOrg = document.querySelector("#nav summary span.truncate") as HTMLElement;
        const otherOrg = document.querySelector("#nav form[action='/orgs/switch'] button span.truncate") as HTMLElement;
        const cs = getComputedStyle(currentOrg);
        const os = getComputedStyle(otherOrg);
        return {
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          textOverflow: s.textOverflow,
          titleAttr: link.getAttribute("title"),
          href: link.getAttribute("href"),
          currentOrgOverflow: cs.textOverflow,
          currentOrgWhiteSpace: cs.whiteSpace,
          currentOrgTruncated: currentOrg.scrollWidth > currentOrg.clientWidth,
          currentOrgTitle: currentOrg.getAttribute("title"),
          otherOrgOverflow: os.textOverflow,
          otherOrgWhiteSpace: os.whiteSpace,
          otherOrgTruncated: otherOrg.scrollWidth > otherOrg.clientWidth,
          otherOrgTitle: otherOrg.getAttribute("title"),
        };
      });
      expect(casesCheck.pageOverflow).toBe(0);
      expect(casesCheck.textOverflow).toBe("ellipsis");
      expect(casesCheck.titleAttr).toBe(LONG_CASE.uploadName);
      expect(casesCheck.href).toContain("/r/01LONGCASE0000000000000000");
      expect(casesCheck.currentOrgOverflow).toBe("ellipsis");
      expect(casesCheck.currentOrgWhiteSpace).toBe("nowrap");
      expect(casesCheck.currentOrgTruncated).toBe(true);
      expect(casesCheck.currentOrgTitle).toBe("Bloemfonteinvervoerdienstverskaffers Mountain View Logistics (Pty) Ltd");
      expect(casesCheck.otherOrgOverflow).toBe("ellipsis");
      expect(casesCheck.otherOrgWhiteSpace).toBe("nowrap");
      expect(casesCheck.otherOrgTruncated).toBe(true);
      expect(casesCheck.otherOrgTitle).toBe(
        "Bloemfonteinvervoerdienstverskaffers Mountain View Logistics (Pty) Ltd Holdings Incorporated",
      );
      const disclosure = await page.evaluate(() => {
        const details = document.querySelector("#nav details") as HTMLDetailsElement;
        const fullOrg = document.querySelector("#nav [data-full-org-name]") as HTMLElement;
        const fullAltOrg = document.querySelector("#nav [data-full-alt-org-name]") as HTMLElement;
        return {
          openAfterClick: details.open,
          fullOrgText: fullOrg.textContent?.trim(),
          fullOrgVisible: fullOrg.getBoundingClientRect().height > 0 && fullOrg.scrollWidth <= fullOrg.clientWidth + 1,
          fullAltOrgText: fullAltOrg.textContent?.trim(),
          fullAltOrgVisible:
            fullAltOrg.getBoundingClientRect().height > 0 && fullAltOrg.scrollWidth <= fullAltOrg.clientWidth + 1,
        };
      });
      expect(disclosure).toEqual({
        openAfterClick: true,
        fullOrgText: "Bloemfonteinvervoerdienstverskaffers Mountain View Logistics (Pty) Ltd",
        fullOrgVisible: true,
        fullAltOrgText: "Bloemfonteinvervoerdienstverskaffers Mountain View Logistics (Pty) Ltd Holdings Incorporated",
        fullAltOrgVisible: true,
      });
      await page.focus("#nav summary");
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (document.querySelector("#nav details") as HTMLDetailsElement).open)).toBe(
        false,
      );
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (document.querySelector("#nav details") as HTMLDetailsElement).open)).toBe(true);

      // Single-organisation member: [data-org-reveal] starts truncated and expands in place on click and keyboard without switching context
      await page.goto(`${origin}/cases?singleOrg=1`, { waitUntil: "load" });
      await page.click('button[aria-label="Menu"]');
      const singleBefore = await page.evaluate(() => {
        const el = document.querySelector("#nav [data-org-reveal]") as HTMLElement;
        const s = getComputedStyle(el);
        return {
          expanded: el.getAttribute("aria-expanded"),
          textOverflow: s.textOverflow,
          truncated: el.scrollWidth > el.clientWidth,
        };
      });
      expect(singleBefore).toEqual({
        expanded: "false",
        textOverflow: "ellipsis",
        truncated: true,
      });
      await page.click("#nav [data-org-reveal]");
      const singleAfterClick = await page.evaluate(() => {
        const el = document.querySelector("#nav [data-org-reveal]") as HTMLElement;
        return {
          expanded: el.getAttribute("aria-expanded"),
          fullText: el.textContent?.trim(),
          untruncated: el.scrollWidth <= el.clientWidth + 1,
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(singleAfterClick).toEqual({
        expanded: "true",
        fullText: "Bloemfonteinvervoerdienstverskaffers Mountain View Logistics (Pty) Ltd",
        untruncated: true,
        pageOverflow: 0,
      });
      await page.focus("#nav [data-org-reveal]");
      await page.keyboard.press("Space");
      expect(
        await page.evaluate(() =>
          (document.querySelector("#nav [data-org-reveal]") as HTMLElement).getAttribute("aria-expanded"),
        ),
      ).toBe("false");
      await page.keyboard.press("Enter");
      expect(
        await page.evaluate(() =>
          (document.querySelector("#nav [data-org-reveal]") as HTMLElement).getAttribute("aria-expanded"),
        ),
      ).toBe("true");
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

      // 5b. Stalled Cases request aborts after its bounded timeout, clears #case-loading, keeps existing rows and filters intact, and exposes #case-filter-error with Try again
      await page.evaluate(() => {
        document.getElementById("case-filters")?.setAttribute("hx-request", '{"timeout":150}');
      });
      serverState.delayMs = 800;
      await page
        .locator("fieldset label")
        .filter({ hasText: /^Suspicious$/ })
        .click();
      await expect.poll(async () => page.locator("#case-filter-error").isVisible(), { timeout: 3000 }).toBe(true);
      expect(await page.locator("#case-loading").isVisible()).toBe(false);
      expect(await page.locator("table a[href^='/r/']").count()).toBe(25);
      expect(await page.locator("#case-filter-retry").getAttribute("href")).toContain("verdict=suspicious");
      serverState.delayMs = 0;

      // 5c. Offline Cases request keeps existing rows and filters intact without navigating to a browser error page, announces failure, and recovers via Try again once online
      await page.evaluate(() => {
        document.getElementById("case-filters")?.setAttribute("hx-request", '{"timeout":10000}');
        document.getElementById("case-filter-error")?.remove();
      });
      await context.setOffline(true);
      await page
        .locator("fieldset label")
        .filter({ hasText: /^Malicious$/ })
        .click();
      await expect.poll(async () => page.locator("#case-filter-error").isVisible(), { timeout: 3000 }).toBe(true);
      expect(await page.locator("table a[href^='/r/']").count()).toBe(25);
      await context.setOffline(false);
      await page.locator("#case-filter-retry").click();
      await expect.poll(async () => page.locator("table a[href^='/r/']").count(), { timeout: 5000 }).toBe(25);
      expect(page.url()).toContain("verdict=malicious");

      // 5d. Online connection drop (navigator.onLine === true, socket destroyed) keeps existing rows and filters intact in place without navigating to a browser error page, announces failure, and recovers via Try again
      await page.evaluate(() => {
        document.getElementById("case-filter-error")?.remove();
      });
      expect(await page.evaluate(() => navigator.onLine)).toBe(true);
      serverState.dropConnection = true;
      await page
        .locator("fieldset label")
        .filter({ hasText: /^Suspicious$/ })
        .click();
      await expect.poll(async () => page.locator("#case-filter-error").isVisible(), { timeout: 3000 }).toBe(true);
      expect(await page.locator("table a[href^='/r/']").count()).toBe(25);
      expect(await page.locator("#case-filter-retry").getAttribute("href")).toContain("verdict=suspicious");
      serverState.dropConnection = false;
      await page.locator("#case-filter-retry").click();
      await expect.poll(async () => page.locator("table a[href^='/r/']").count(), { timeout: 5000 }).toBe(25);
      expect(page.url()).toContain("verdict=suspicious");

      // 5e. Delayed recovery fetch is cancelled when a newer filter request starts, so stale recovery never overwrites newer filter results or URL
      serverState.dropHtmxOnly = true;
      serverState.recoveryDelayMs = 350;
      await page
        .locator("fieldset label")
        .filter({ hasText: /^Malicious$/ })
        .click();
      await expect.poll(async () => page.locator("#case-filter-error").isVisible(), { timeout: 3000 }).toBe(true);
      serverState.dropHtmxOnly = false;
      await page
        .locator("fieldset label")
        .filter({ hasText: /^Safe$/ })
        .click();
      await expect
        .poll(async () => page.locator("#case-results").textContent(), { timeout: 5000 })
        .toContain("No cases match Safe");
      await new Promise((done) => setTimeout(done, 450));
      expect(await page.locator("#case-results").textContent()).toContain("No cases match Safe");
      expect(page.url()).toContain("verdict=safe");
      serverState.recoveryDelayMs = 0;

      // 5f. Recovery fetch sends x-cases-org and honours the organisation-switch guard (reloading the whole page when the active org changed)
      serverState.seenOrgHeaders = [];
      serverState.activeOrgId = "org-other";
      serverState.dropHtmxOnly = true;
      await page.locator("fieldset label").filter({ hasText: /^All$/ }).click();
      await expect
        .poll(async () => page.locator("header p").textContent(), { timeout: 5000 })
        .toContain("Holdings Incorporated");
      expect(serverState.seenOrgHeaders).toContain("org-long");
      serverState.dropHtmxOnly = false;
      serverState.activeOrgId = "org-long";

      // 5g. Automatic recovery initialises HTMX on the swapped #case-results subtree so pagination links (#case-next) stay wired to HTMX and in-place offline handling
      await page.goto(`${origin}/cases`, { waitUntil: "load" });
      serverState.dropHtmxOnly = true;
      await page
        .locator("fieldset label")
        .filter({ hasText: /^Malicious$/ })
        .click();
      await expect.poll(async () => page.url(), { timeout: 5000 }).toContain("verdict=malicious");
      serverState.dropHtmxOnly = false;
      await context.setOffline(true);
      await page.locator("#case-next").click();
      await expect.poll(async () => page.locator("#case-filter-error").isVisible(), { timeout: 3000 }).toBe(true);
      expect(await page.locator("table a[href^='/r/']").count()).toBe(25);
      await context.setOffline(false);

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
