import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Observation } from "../../eval/phone-attribution";
import { progressOf } from "../../src/web/pages/report-progress";
import { type ReportCase, ReportDocument } from "../../src/web/pages/report-view";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// D07 T09 §4's scripted phone readers, on the shipped report itself: this measure renders the real report at
// 360 px (and, for the benchmark shape, removes the phone attribution segment from its line, the pre-D07 T03
// §43 shape) and writes the raw observations eval/phone-attribution.ts analyses. A scripted reader is a
// deterministic viewport scan, not a person: visible text top to bottom in reading order, scrolling by
// viewport, opening disclosures only when the page can scroll no further.
const PUBLIC = join(import.meta.dirname, "../../public");
const OUT = join(import.meta.dirname, "../../eval/phone-attribution-observations.json");
const ID = "01JCASE0000000000000000000";
const SUBMITTER = "Sipho Dube";
const CASES: { name: string; stored: Partial<ReportCase>; senderName: string }[] = [
  {
    name: "forwarded with the original attached",
    stored: {
      originalSubject: "Your NimbusMail password expires today",
      originalFromName: "NimbusMail Security",
      originalFromAddress: "no-reply@nimbusmai1-login.example",
      headersAvailable: true,
    },
    senderName: "NimbusMail Security",
  },
  {
    name: "forwarded",
    stored: {
      originalSubject: "Your account statement is ready",
      originalFromName: "Karoo Bank",
      originalFromAddress: "alerts@karoo-bank.example",
      headersAvailable: false,
    },
    senderName: "Karoo Bank",
  },
  {
    name: "uploaded",
    stored: {
      originalSubject: "Claim documents for policy 4417",
      originalFromName: "Vlei Insurance",
      originalFromAddress: "claims@vlei-insure.example",
      channel: "upload",
    },
    senderName: "Vlei Insurance",
  },
];
const base = (stored: Partial<ReportCase>): ReportCase => ({
  id: ID,
  status: "done",
  verdict: "malicious",
  sourceKind: "mail",
  channel: "email",
  createdAt: "2026-10-27T07:14:00Z",
  headersAvailable: true,
  forwardedBy: "thandi@karoo.example",
  ...stored,
});
function page(stored: Partial<ReportCase>) {
  const { children: _, ...shell } = member();
  return String(
    <ReportDocument
      stored={base(stored)}
      verdict={{
        verdict: "malicious",
        headline: "This is a password-phishing email pretending to be the sender.",
        confidence: 0.93,
        reasons: ["The link goes to a lookalike registered 3 days ago."],
        actions: ["Do not click the link."],
      }}
      evidence={[]}
      shell={shell}
      progress={progressOf([])}
      coverage={null}
      checker={{ kind: "member", name: SUBMITTER }}
      copy={`http://x/r/${ID}`}
    />,
  );
}

let browser: Browser;
let server: Server;
let origin = "";
beforeAll(async () => {
  browser = await launch();
  server = createServer((req, res) => {
    const asked = new URL(req.url ?? "/", "http://127.0.0.1");
    if (asked.pathname === `/r/${ID}`) {
      const c = (CASES[Number(asked.searchParams.get("case") ?? 0)] ?? CASES[0]) as (typeof CASES)[number];
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(page(c.stored));
    }
    const file = join(PUBLIC, asked.pathname);
    if (asked.pathname.startsWith("/static/") && existsSync(file)) {
      res.writeHead(200, {
        "content-type": asked.pathname.endsWith(".css") ? "text/css" : "text/javascript",
      });
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

// The reader, in the page: returns its navigation and what it met, or missing when an identity is absent.
const SCAN = `(function ({ submitter, senderName }) {
  const labelled = new RegExp("(Forwarded|Uploaded|Submitted)( as an attachment)? by\\\\s+" + submitter.replace(/ /g, "\\\\s+"));
  const visibleText = () => {
    const parts = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walk.nextNode();
    while (node) {
      const el = node.parentElement;
      const closed = el && el.closest("details:not([open])");
      if (el && !(closed && !el.closest("summary"))) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < innerHeight && rect.width > 0) parts.push(node.textContent || "");
      }
      node = walk.nextNode();
    }
    return parts.join(" ").replace(/\\s+/g, " ");
  };
  const domText = document.body.textContent || "";
  if (!domText.includes(submitter) || !domText.includes(senderName)) return { missing: true };
  let scrolls = 0;
  let firstIdentity = null;
  let identified = false;
  let openedDetails = false;
  for (let step = 0; step < 30; step++) {
    const text = visibleText();
    const si = text.indexOf(submitter);
    const fi = text.indexOf(senderName);
    if (firstIdentity === null && (si >= 0 || fi >= 0))
      firstIdentity = si >= 0 && (fi < 0 || si < fi) ? "submitter" : "sender";
    if (labelled.test(text)) { identified = true; break; }
    const before = scrollY;
    scrollBy(0, innerHeight);
    if (scrollY === before) {
      if (openedDetails) break;
      for (const d of document.querySelectorAll("details")) d.open = true;
      openedDetails = true;
      scrollTo(0, 0);
      continue;
    }
    scrolls++;
  }
  return { missing: false, scrolls, firstIdentity, identified, openedDetails };
})`;

describe.skipIf(!chromiumPath() && !process.env.CI)("phone attribution measure", { timeout: 180_000 }, () => {
  it("writes the scripted readers' raw observations", async () => {
    const observations: Observation[] = [];
    for (const [ci, c] of CASES.entries()) {
      for (let run = 0; run < 5; run++) {
        const shapes = run % 2 ? (["benchmark", "shipped"] as const) : (["shipped", "benchmark"] as const);
        for (const shape of shapes) {
          const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
          const p: Page = await context.newPage();
          await p.goto(`${origin}/r/${ID}?case=${ci}`, { waitUntil: "load" });
          // No measurement on an unstyled page: the stylesheet must have loaded, the phone line must be
          // shown and the desktop line hidden, as the shipped stylesheet rules them at this width.
          const styled = await p.evaluate((name) => {
            const lines = [...document.querySelectorAll("p")].filter((el) => el.textContent?.includes(name));
            const shown = lines.filter((el) => getComputedStyle(el).display !== "none");
            const sheetLoaded = [...document.styleSheets].some((s) => (s.href ?? "").includes("/static/app."));
            return sheetLoaded && lines.length >= 2 && shown.length === 1;
          }, SUBMITTER);
          if (!styled) throw new Error("the shipped stylesheet did not apply: refusing to measure");
          if (shape === "benchmark")
            // The pre-attribution shape: the same phone line without who brought the case in.
            await p.evaluate((name) => {
              // Only the phone line loses its segment; the desktop header keeps naming the checker, as it did.
              for (const el of document.querySelectorAll("p.md\\:hidden"))
                if (el.textContent?.includes(name))
                  el.textContent = el.textContent.replace(/(?:^| · )(Forwarded|Uploaded)[^·]*(?= ·|$)/, "");
            }, SUBMITTER);
          const start = await p.evaluate(() => performance.now());
          const found = (await p.evaluate(
            `(${SCAN})({ submitter: ${JSON.stringify(SUBMITTER)}, senderName: ${JSON.stringify(c.senderName)} })`,
          )) as {
            missing: boolean;
            scrolls: number;
            firstIdentity: "sender" | "submitter" | null;
            identified: boolean;
            openedDetails: boolean;
          };
          const ms = Math.round((await p.evaluate(() => performance.now())) - (start as number));
          expect(found.missing, `${c.name} lacks an identity`).toBe(false);
          observations.push({
            case: c.name,
            shape,
            run,
            scrolls: found.scrolls,
            openedDetails: found.openedDetails,
            firstIdentity: found.firstIdentity,
            identified: found.identified,
            confused: !found.identified || found.openedDetails,
            ms,
          });
          await context.close();
        }
      }
    }
    // Provenance travels with the observations: the analyser publishes these, never its own HEAD.
    const { execSync } = await import("node:child_process");
    writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          stimulusVersion: "phone-attribution-v1",
          revision: execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(),
          collectedAt: new Date().toISOString(),
          observations,
        },
        null,
        2,
      )}\n`,
    );
    expect(observations).toHaveLength(30);
  });
});
