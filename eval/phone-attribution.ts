// Measured phone attribution (D07 T09 §4): scripted phone readers timed identifying who brought a case in, on
// the shipped report's phone shape and on a benchmark shape (the same drawing without the phone attribution
// line, the submitter named only in Submission details, a reconstruction of the pre-D07 T03 §43 surface,
// stimulus version below). A scripted reader is a deterministic scan, not a person: it reads the visible text
// top to bottom in reading order at 360 px, scrolling by viewport, and opens disclosures only when the
// submitter is nowhere visible. Its times are a proxy for human reading, never human times.
//
//   node eval/phone-attribution.ts   (writes eval/phone-attribution-results.json)
//
// The pure analysis (medians, confusion, observation validation) is exported for
// test/node/phone-attribution.test.ts; running this file as a script runs the measurement.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromiumPath } from "../scripts/lib/chromium.ts";

export const STIMULUS_VERSION = "phone-attribution-v1";

export type Observation = {
  case: string;
  shape: "shipped" | "benchmark";
  run: number;
  scrolls: number;
  openedDetails: boolean;
  firstIdentity: "sender" | "submitter" | null;
  identified: boolean;
  confused: boolean;
  ms: number;
};

const valid = (o: unknown): o is Observation => {
  if (typeof o !== "object" || o === null) return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.case === "string" &&
    (r.shape === "shipped" || r.shape === "benchmark") &&
    typeof r.run === "number" &&
    typeof r.scrolls === "number" &&
    typeof r.openedDetails === "boolean" &&
    (r.firstIdentity === "sender" || r.firstIdentity === "submitter" || r.firstIdentity === null) &&
    typeof r.identified === "boolean" &&
    typeof r.confused === "boolean" &&
    typeof r.ms === "number" &&
    r.ms >= 0
  );
};

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function summarise(observations: Observation[]) {
  for (const o of observations) {
    if (!valid(o)) throw new Error(`invalid observation: ${JSON.stringify(o)}`);
    if (!Number.isFinite(o.scrolls) || !Number.isFinite(o.ms) || o.scrolls < 0)
      throw new Error(`invalid observation: ${JSON.stringify(o)}`);
  }
  // Complete paired trials: every case has the same runs under both shapes.
  const keys = new Map<string, Set<number>>();
  for (const o of observations) {
    const key = `${o.case}|${o.shape}`;
    const runs = keys.get(key) ?? new Set<number>();
    if (runs.has(o.run)) throw new Error(`duplicate observation: ${key} run ${o.run}`);
    runs.add(o.run);
    keys.set(key, runs);
  }
  const cases = new Set(observations.map((o) => o.case));
  for (const c of cases)
    for (const shape of ["shipped", "benchmark"] as const) {
      const a = keys.get(`${c}|${shape}`);
      const b = keys.get(`${c}|${shape === "shipped" ? "benchmark" : "shipped"}`);
      if (!a || !b || a.size !== b.size) throw new Error(`incomplete paired trials for ${c}`);
    }
  const shapes = ["shipped", "benchmark"] as const;
  const out: Record<
    string,
    { cases: number; runs: number; medianScrolls: number; medianMs: number; confused: number }
  > = {};
  for (const shape of shapes) {
    const rows = observations.filter((o) => o.shape === shape);
    if (rows.length === 0) throw new Error(`no observations for ${shape}`);
    const perCaseScrolls = new Map<string, number[]>();
    const perCaseMs = new Map<string, number[]>();
    for (const r of rows) {
      perCaseScrolls.set(r.case, [...(perCaseScrolls.get(r.case) ?? []), r.scrolls]);
      perCaseMs.set(r.case, [...(perCaseMs.get(r.case) ?? []), r.ms]);
    }
    out[shape] = {
      cases: perCaseScrolls.size,
      runs: rows.length,
      medianScrolls: median([...perCaseScrolls.values()].map(median)),
      medianMs: Math.round(median([...perCaseMs.values()].map(median))),
      confused: rows.filter((o) => o.confused).length,
    };
  }
  return out;
}

// The synthetic cases: a distinctive sender and submitter, one per attribution channel variant. The sender is
// the original message's From; the submitter brought the case in.
const CASES = [
  {
    name: "forwarded with the original attached",
    channel: "Forwarded as an attachment",
    sender: "NimbusMail Security <no-reply@nimbusmai1-login.example>",
    subject: "Your NimbusMail password expires today",
  },
  {
    name: "forwarded",
    channel: "Forwarded",
    sender: "Karoo Bank <alerts@karoo-bank.example>",
    subject: "Your account statement is ready",
  },
  {
    name: "uploaded",
    channel: "Uploaded",
    sender: "Vlei Insurance <claims@vlei-insure.example>",
    subject: "Claim documents for policy 4417",
  },
] as const;
const SUBMITTER = "Sipho Dube";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function drawingFor(index: number, shipped: boolean): string {
  return drawing(CASES[index] ?? (CASES[0] as (typeof CASES)[number]), shipped);
}
function drawing(c: (typeof CASES)[number], shipped: boolean): string {
  const arrival = shipped ? ` · ${c.channel} by ${SUBMITTER} · Tue, 27 Oct 2026, 09:14 SAST` : "";
  const sender = esc(c.sender);
  return `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/static.css"><title>Report</title></head>
<body class="bg-canvas text-ink"><main class="mx-auto flex max-w-720 flex-col gap-24 p-16">
<p class="type-small text-muted">Cases</p>
<h1 class="type-h2 wrap-anywhere">${c.subject}</h1>
<p class="type-small text-muted wrap-anywhere">${c.subject} · from ${sender}${arrival}</p>
<section class="flex flex-col gap-12"><p class="type-h3">Verdict: malicious</p>
<p class="text-14">This is a password-phishing email pretending to be the sender. Do not click the link, open its attachments or pay anything it asks for.</p></section>
<section class="flex flex-col gap-12"><p class="type-h3">Why we say so</p>
<p class="text-14">The link goes to a lookalike domain registered 3 days ago. The message asks for a password on a page that is not the sender's. The wording pressures the reader to act at once.</p>
<p class="text-14">Evidence E1: the sending server check did not pass. Evidence E2: the domain is newly registered. Evidence E3: hidden text was found in the message.</p></section>
<details><summary class="type-small">Submission details</summary>
<p class="text-14">Submitted by ${SUBMITTER} (${c.channel.toLowerCase()}) for Karoo Freight. Original sender: ${sender}. Received Tue, 27 Oct 2026, 09:14 SAST.</p></details>
</main></body></html>`;
}

async function main() {
  const exe = chromiumPath();
  if (!exe) throw new Error("no Chromium available for the scripted readers");
  const css = join(import.meta.dirname, "..", "public", "static");
  const { readFileSync, readdirSync } = await import("node:fs");
  const cssFile = readdirSync(css).find((f) => f.startsWith("app.") && f.endsWith(".css"));
  if (!cssFile) throw new Error("the shipped stylesheet is missing: run pnpm build:assets first");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/static.css" && cssFile) {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(readFileSync(join(css, cssFile)));
      return;
    }
    const [shape, index] = (url.pathname.split("/")[1] ?? "").split("-");
    const c = CASES[Number(index ?? 0)] ?? CASES[0];
    res.writeHead(200, { "content-type": "text/html" });
    res.end(drawing(c, shape === "shipped"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const browser = await chromium.launch({ executablePath: exe });
  const observations: Observation[] = [];
  const labelled = new RegExp(`(Forwarded|Uploaded|Submitted)( as an attachment)? by ${SUBMITTER}`);
  try {
    for (const [ci, c] of CASES.entries()) {
      for (let run = 0; run < 5; run++) {
        // Presentation order alternates by run, so neither shape is always first.
        const shapes = run % 2 ? (["benchmark", "shipped"] as const) : (["shipped", "benchmark"] as const);
        for (const shape of shapes) {
          const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
          await page.goto(`http://127.0.0.1:${port}/${shape}-${ci}`, { waitUntil: "load" });
          // The reader's scan starts on the loaded page: page load is the same cost for both shapes.
          const start = performance.now();
          const found = await page.evaluate(
            ({ labelledSrc, submitter, sender }) => {
              const labelledRe = new RegExp(labelledSrc);
              const visibleText = () => {
                const parts: string[] = [];
                const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                let node: Node | null = walk.nextNode();
                while (node) {
                  const el = node.parentElement as HTMLElement | null;
                  // A closed disclosure's summary is visible text; its body is not.
                  const closed = el?.closest("details:not([open])");
                  if (el && !(closed && !el.closest("summary"))) {
                    const rect = el.getBoundingClientRect();
                    if (rect.bottom > 0 && rect.top < innerHeight && rect.width > 0) parts.push(node.textContent ?? "");
                  }
                  node = walk.nextNode();
                }
                return parts.join(" ");
              };
              const domText = document.body.textContent ?? "";
              if (!domText.includes(submitter) || !domText.includes(sender))
                return { missing: true, sample: domText.slice(0, 200) } as const;
              let scrolls = 0;
              let firstIdentity: "sender" | "submitter" | null = null;
              let identified = false;
              let openedDetails = false;
              for (let step = 0; step < 20; step++) {
                const text = visibleText();
                const si = text.indexOf(submitter);
                const fi = text.indexOf(sender.split(" <")[0] as string);
                if (firstIdentity === null && (si >= 0 || fi >= 0))
                  firstIdentity = si >= 0 && (fi < 0 || si < fi) ? "submitter" : "sender";
                if (labelledRe.test(text)) {
                  identified = true;
                  break;
                }
                // Genuine navigation only: a scroll that cannot move the page is not an attempt. When the
                // page can scroll no further and the submitter is still unfound, open the disclosures.
                const before = scrollY;
                scrollBy(0, innerHeight);
                if (scrollY === before) {
                  if (openedDetails) break;
                  for (const d of document.querySelectorAll("details")) (d as HTMLDetailsElement).open = true;
                  openedDetails = true;
                  scrollTo(0, 0);
                  continue;
                }
                scrolls++;
              }
              return { missing: false, scrolls, firstIdentity, identified, openedDetails } as const;
            },
            { labelledSrc: labelled.source, submitter: SUBMITTER, sender: c.sender },
          );
          const ms = performance.now() - start;
          if (found.missing)
            throw new Error(`case "${c.name}" lacks a sender or submitter identity: ${JSON.stringify(found)}`);
          observations.push({
            case: c.name,
            shape,
            run,
            scrolls: found.scrolls,
            openedDetails: found.openedDetails,
            firstIdentity: found.firstIdentity,
            identified: found.identified,
            // Confusion, for a scripted reader, is needing navigation (a disclosure) to tell the submitter
            // from the sender at all, or never finding the labelled submitter. Meeting the sender's name
            // first in the same labelled line is not confusion: the label is what distinguishes them.
            confused: !found.identified || found.openedDetails,
            ms: Math.round(ms),
          });
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  const summary = summarise(observations);
  const revision = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  const out = { stimulusVersion: STIMULUS_VERSION, revision, ranAt: new Date().toISOString(), summary, observations };
  writeFileSync(join(import.meta.dirname, "phone-attribution-results.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
