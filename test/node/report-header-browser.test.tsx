import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { headerKey, MetaLine, ReportHeader } from "../../src/web/pages/report-header";
import { ReportLive } from "../../src/web/pages/report-live";
import { progressOf, type StepEvent } from "../../src/web/pages/report-progress";
import type { ReportVerdict } from "../../src/web/pages/report-verdict";
import { headerFacts, type ReportCase, ReportDocument } from "../../src/web/pages/report-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// The report's header in Chromium (D07 T03 §9), served with the shipped stylesheet, htmx and app script: the member and
// signed-link views at a phone's and a desktop's width in both themes (no sideways scroll, the accessibility gate's
// rules), the phone's one line under the band for each sender the case may have, Copy link and Download PDF from the
// keyboard, a refused clipboard recovered by hand, no Download PDF without the script, the subject and sender kept in
// print, and a report opened before parsing catching up through its poll.
const PUBLIC = join(import.meta.dirname, "../../public");
const ID = "01JCASE0000000000000000000";
const LINK = "?o=org&e=1793664000&s=sig";
const ev = (step: string, status: StepEvent["status"]): StepEvent => ({
  step,
  status,
  startedAt: new Date(Date.now() - 20_000).toISOString(),
  ms: status === "started" ? null : 400,
  error: null,
});
const VERDICT: ReportVerdict = {
  verdict: "malicious",
  headline: "This is a password-phishing email pretending to be NimbusMail.",
  confidence: 0.93,
  reasons: ["The link goes to a lookalike registered 3 days ago."],
  actions: ["Do not click the link."],
};
const FULL = {
  originalSubject: "Your NimbusMail password expires today",
  originalFromName: "NimbusMail Security",
  originalFromAddress: "no-reply@nimbusmai1-login.example",
};
type Fixture = {
  stored: Partial<ReportCase>;
  view: "member" | "public";
  running?: boolean;
  checker?: { kind: "member"; name: string } | { kind: "former" } | null;
};
const base = (f: Fixture): ReportCase => ({
  id: ID,
  status: f.running ? "running" : "done",
  verdict: f.running ? null : "malicious",
  sourceKind: "mail",
  channel: "email",
  createdAt: "2026-10-27T07:14:00Z",
  headersAvailable: true,
  forwardedBy: "thandi@karoo.example",
  ...f.stored,
});
const progress = (running?: boolean) => progressOf(running ? [ev("admit", "started")] : [ev("admit", "done")]);
const copyOf = (view: Fixture["view"]) => `${state.origin}/r/${ID}${view === "public" ? LINK : ""}`;

function page(f: Fixture) {
  const { children: _, ...shell } = member();
  return String(
    <ReportDocument
      stored={base(f)}
      verdict={f.running ? null : VERDICT}
      evidence={[]}
      shell={f.view === "member" ? shell : null}
      {...(f.view === "public" ? { link: LINK, linkExpires: 1793664000 } : {})}
      progress={progress(f.running)}
      coverage={null}
      checker={
        f.view === "member" ? (f.checker === undefined ? { kind: "member", name: "Sipho Dube" } : f.checker) : null
      }
      copy={copyOf(f.view)}
    />,
  );
}
// The status poll's answer, as src/web/pages/report.tsx sends it: the live region, then the header out of band only
// when it differs from the one the poll says the page holds (`h`).
function status(f: Fixture, held: string | null) {
  const stored = base(f);
  const facts = headerFacts(
    stored,
    f.view === "member" ? (f.checker === undefined ? { kind: "member", name: "Sipho Dube" } : f.checker) : null,
  );
  return (
    String(
      <ReportLive
        caseId={ID}
        status={stored.status}
        verdict={f.running ? null : VERDICT}
        sourceKind="mail"
        channel="email"
        delivery={null}
        evidence={[]}
        progress={progress(f.running)}
        coverage={null}
        view={f.view}
        {...(f.view === "public" ? { link: LINK } : {})}
        meta={<MetaLine facts={facts} view={f.view} />}
        headerKey={headerKey(facts, f.view)}
      />,
    ) +
    (held === headerKey(facts, f.view)
      ? ""
      : String(<ReportHeader facts={facts} view={f.view} copy={copyOf(f.view)} oob />))
  );
}

const state = {
  origin: "",
  first: { stored: FULL, view: "member" } as Fixture,
  next: null as Fixture | null,
  polls: 0,
};
let browser: Browser;
let server: Server;
beforeAll(async () => {
  browser = await launch();
  server = createServer((req, res) => {
    const asked = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = asked.pathname;
    if (path === `/r/${ID}/status`) {
      state.polls++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(status(state.next ?? state.first, asked.searchParams.get("h")));
    }
    if (path === `/r/${ID}`) {
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
            : path.endsWith(".png")
              ? "image/png"
              : "font/woff2";
      res.writeHead(200, { "content-type": type });
      return res.end(readFileSync(file));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

async function open(
  first: Fixture,
  options: { width?: number; theme?: "light" | "dark"; script?: boolean; clipboard?: "grant" | "refuse" } = {},
) {
  Object.assign(state, { first, next: null, polls: 0 });
  const context = await browser.newContext({ viewport: { width: options.width ?? 1280, height: 900 } });
  if (options.clipboard === "grant") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const p: Page = await context.newPage();
  await p.addInitScript((refuse) => {
    const w = window as unknown as { printed: number };
    w.printed = 0;
    window.print = () => {
      w.printed++;
    };
    if (refuse)
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
      });
  }, options.clipboard === "refuse");
  if (options.script === false) await p.route("**/static/app.*.js", (route) => route.abort());
  await p.goto(`${state.origin}/r/${ID}${first.view === "public" ? LINK : ""}`, { waitUntil: "load" });
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), options.theme ?? "light");
  return { p, context };
}
const metaLine = (p: Page) => p.locator("#report-live p.md\\:hidden").first();

describe.skipIf(!chromiumPath() && !process.env.CI)("the report header in Chromium", { timeout: 120_000 }, () => {
  for (const view of ["member", "public"] as const)
    for (const width of [360, 1280])
      for (const theme of ["light", "dark"] as const)
        it(`fits and passes the accessibility gate's rules: ${view}, ${width} px, ${theme}`, async () => {
          const long = { ...FULL, originalSubject: `<b>${"W".repeat(296)}` };
          const { p, context } = await open({ stored: long, view }, { width, theme });
          expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          const title = p.getByRole("heading", { level: 1 });
          expect(await title.textContent()).toBe(long.originalSubject);
          // The title is the page's heading at every width; on a phone it is kept for screen readers and the one
          // line under the band says it instead.
          const box = await title.boundingBox();
          expect((box?.width ?? 0) > 1, "the title drawn").toBe(width > 360);
          expect(await metaLine(p).isVisible()).toBe(width === 360);
          expect(await p.getByRole("button", { name: "Copy link" }).isVisible()).toBe(true);
          expect(await p.getByRole("button", { name: "Download PDF" }).isVisible()).toBe(true);
          expect(
            await p
              .getByText("Sipho Dube")
              .evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).length),
          ).toBe(view === "member" ? 1 : 0);
          await p.addScriptTag({ path: AXE });
          expect(problems(await scan(p))).toEqual([]);
          await context.close();
        });

  it("joins only the parts a sender has on the phone's line, in both views", async () => {
    for (const view of ["member", "public"] as const)
      for (const [stored, words] of [
        [FULL, "Your NimbusMail password expires today · from no-reply@nimbusmai1-login.example · "],
        [{ originalSubject: "Hi", originalFromName: "Bob" }, "Hi · from Bob · "],
        [{ originalSubject: null }, "No subject · Tue, 27 Oct 2026, 09:14 SAST"],
        [{ originalSubject: "scan.pdf", channel: "upload" as const, forwardedBy: null }, "scan.pdf · Tue"],
      ] as const) {
        const { p, context } = await open({ stored, view }, { width: 360 });
        const line = (await metaLine(p).textContent()) ?? "";
        expect(line, `${view} ${words}`).toContain(words);
        expect(line).not.toMatch(/· ·|from ·|^ ·|· $/);
        await context.close();
      }
  });

  const MATRIX = (["member", "public"] as const).flatMap((view) =>
    [360, 1280].flatMap((width) => (["light", "dark"] as const).map((theme) => ({ view, width, theme }))),
  );

  // D07 T03 §43 (option A): who brought the case in, under the subject on a phone, for a member only.
  it("shows who brought the case in under the subject on a phone, before the band, member only", async () => {
    const cases: [string, Fixture, string][] = [
      ["forwarded", { stored: FULL, view: "member" }, "Forwarded as an attachment by Sipho Dube"],
      [
        "uploaded",
        { stored: { ...FULL, channel: "upload" } as Partial<ReportCase>, view: "member" },
        "Uploaded by Sipho Dube",
      ],
      ["ordinary forward", { stored: { ...FULL, headersAvailable: false }, view: "member" }, "Forwarded by Sipho Dube"],
      [
        "blank name, the email",
        {
          stored: { ...FULL, headersAvailable: false },
          view: "member",
          checker: { kind: "member", name: "sipho@karoo.example" },
        },
        "Forwarded by sipho@karoo.example",
      ],
      [
        "former member",
        { stored: { ...FULL, channel: "upload" } as Partial<ReportCase>, view: "member", checker: { kind: "former" } },
        "Uploaded by a former member",
      ],
      [
        "no uploader",
        { stored: { ...FULL, channel: "upload" } as Partial<ReportCase>, view: "member", checker: null },
        "Uploaded",
      ],
    ];
    for (const [name, fixture, words] of cases) {
      const { p, context } = await open(fixture, { width: 360 });
      const line = p.locator("p.md\\:hidden", { hasText: words }).last();
      await expect.poll(() => line.isVisible()).toBe(true);
      const boxes = await p.evaluate(() => {
        const all = [...document.querySelectorAll("p")];
        const attr = all.find(
          (el) => /^(Forwarded|Uploaded)/.test(el.textContent?.trim() ?? "") && el.className.includes("md:hidden"),
        ) as HTMLElement | undefined;
        const band = document.querySelector("section");
        return { attr: attr?.getBoundingClientRect().top ?? -1, band: band?.getBoundingClientRect().top ?? -1 };
      });
      expect(boxes.attr, name).toBeGreaterThanOrEqual(0);
      expect(boxes.attr, name).toBeLessThan(boxes.band);
      // And it is still there after a status poll has answered.
      await p.waitForTimeout(2_600);
      await expect.poll(() => line.isVisible()).toBe(true);
      await context.close();
    }
    // A link holder at the same width sees no attribution, on the first page or a poll.
    const { p, context } = await open({ stored: FULL, view: "public" }, { width: 360 });
    expect(await p.getByText("by Sipho Dube", { exact: false }).count()).toBe(0);
    await context.close();
    // At desktop width the phone line is hidden and the header's own line names the checker once.
    const wide = await open({ stored: FULL, view: "member" }, { width: 1280 });
    const wideLines = await wide.p
      .getByText("Forwarded as an attachment by Sipho Dube", { exact: false })
      .evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).length);
    expect(wideLines).toBe(1);
    await wide.context.close();
  });

  it("copies the report's own link from the keyboard in each view, width and theme", async () => {
    for (const { view, width, theme } of MATRIX) {
      const { p, context } = await open({ stored: FULL, view }, { width, theme, clipboard: "grant" });
      await p.getByRole("button", { name: "Copy link" }).focus();
      await p.keyboard.press("Enter");
      await expect.poll(() => p.locator("#report-header [data-copy-status]").textContent()).toBe("Copied");
      expect(await p.evaluate(() => navigator.clipboard.readText()), `${view} ${width} ${theme}`).toBe(copyOf(view));
      await context.close();
    }
  });

  it("recovers from a refused clipboard in each view, width and theme: says so and shows the link selected", async () => {
    for (const { view, width, theme } of MATRIX) {
      const { p, context } = await open({ stored: FULL, view }, { width, theme, clipboard: "refuse" });
      await p.getByRole("button", { name: "Copy link" }).focus();
      await p.keyboard.press("Enter");
      await expect
        .poll(() => p.locator("#report-header [data-copy-status]").textContent())
        .toBe("Copy failed: select the address to copy it");
      expect(await p.locator("#report-header [data-copy-source]").isVisible()).toBe(true);
      expect(await p.evaluate(() => window.getSelection()?.toString()), `${view} ${width} ${theme}`).toBe(copyOf(view));
      await context.close();
    }
  });

  it("opens the browser's print from the keyboard in each view, width and theme", async () => {
    for (const { view, width, theme } of MATRIX) {
      const { p, context } = await open({ stored: FULL, view }, { width, theme });
      await p.getByRole("button", { name: "Download PDF" }).focus();
      await p.keyboard.press("Enter");
      expect(
        await p.evaluate(() => (window as unknown as { printed: number }).printed),
        `${view} ${width} ${theme}`,
      ).toBe(1);
      await context.close();
    }
  });

  it("shows neither action without the script, and the address to select by hand instead", async () => {
    for (const view of ["member", "public"] as const) {
      const { p, context } = await open({ stored: FULL, view }, { script: false });
      expect(await p.getByRole("button", { name: "Download PDF", includeHidden: true }).isVisible()).toBe(false);
      expect(await p.getByRole("button", { name: "Copy link", includeHidden: true }).isVisible()).toBe(false);
      const source = p.locator("#report-header [data-copy-source]");
      expect(await source.isVisible()).toBe(true);
      expect(await source.textContent()).toBe(copyOf(view));
      await context.close();
    }
  });

  it("keeps the subject and sender in print, without the buttons, in each view, width and theme", async () => {
    for (const { view, width, theme } of MATRIX) {
      const { p, context } = await open({ stored: FULL, view }, { width, theme });
      await p.emulateMedia({ media: "print" });
      const where = `${view} ${width} ${theme}`;
      // Drawn, not only kept for screen readers (a 1 px box counts as visible to Playwright).
      expect((await p.getByRole("heading", { level: 1 }).boundingBox())?.width ?? 0, where).toBeGreaterThan(1);
      expect(await p.getByText("NimbusMail Security <no-reply@nimbusmai1-login.example>").isVisible(), where).toBe(
        true,
      );
      expect(await p.getByRole("button", { name: "Copy link" }).isVisible(), where).toBe(false);
      expect(await p.locator("#report-header [data-copy-reveal]").isVisible(), where).toBe(false);
      await context.close();
    }
  });

  it("keeps focus, copy feedback and a hand selection in the header through polls that change nothing", async () => {
    const { p, context } = await open({ stored: FULL, view: "public", running: true }, { clipboard: "refuse" });
    await p.getByRole("button", { name: "Copy link" }).focus();
    await p.keyboard.press("Enter");
    await expect
      .poll(() => p.locator("#report-header [data-copy-status]").textContent())
      .toBe("Copy failed: select the address to copy it");
    const polls = state.polls;
    await expect.poll(() => state.polls, { timeout: 10_000 }).toBeGreaterThanOrEqual(polls + 3);
    expect(await p.evaluate(() => document.activeElement?.textContent)).toBe("Copy link");
    expect(await p.locator("#report-header [data-copy-status]").textContent()).toBe(
      "Copy failed: select the address to copy it",
    );
    expect(await p.evaluate(() => window.getSelection()?.toString())).toBe(copyOf("public"));
    await context.close();
  });

  it("catches up with parsing: a report opened before its subject was stored shows it once a poll does", async () => {
    for (const width of [360, 1280]) {
      const { p, context } = await open(
        {
          stored: { originalSubject: null, originalFromName: null, originalFromAddress: null },
          view: "member",
          running: true,
        },
        { width },
      );
      expect(await p.getByRole("heading", { level: 1 }).textContent()).toBe("No subject");
      state.next = { stored: FULL, view: "member", running: true };
      await expect
        .poll(() => p.getByRole("heading", { level: 1 }).textContent(), { timeout: 8000 })
        .toBe(FULL.originalSubject);
      if (width === 360) await expect.poll(() => metaLine(p).textContent()).toContain(FULL.originalSubject);
      else expect(await p.getByText("NimbusMail Security <no-reply@nimbusmai1-login.example>").isVisible()).toBe(true);
      // The header swapped in by the poll still shows its Download PDF.
      expect(await p.getByRole("button", { name: "Download PDF" }).isVisible()).toBe(true);
      await context.close();
    }
  });

  it("titles an upload by its file's name in each view and width, labelled, wrapped, and kept in print", async () => {
    const NAME = `${"invoice-from-karoo-couriers-".repeat(9)}final.pdf`.slice(0, 255);
    for (const view of ["member", "public"] as const)
      for (const width of [360, 1280]) {
        const { p, context } = await open(
          { stored: { channel: "upload", forwardedBy: null, uploadName: NAME, originalSubject: null }, view },
          { width },
        );
        const title = p.getByRole("heading", { level: 1 });
        expect(await title.textContent(), `${view} ${width}`).toBe(`Uploaded file: ${NAME}`);
        expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        if (width === 360) expect(await metaLine(p).textContent()).toContain(NAME);
        else expect((await title.boundingBox())?.width ?? 0).toBeGreaterThan(1);
        if (view === "member" && width === 1280)
          expect(await p.getByRole("navigation", { name: "Breadcrumb" }).textContent()).toContain(NAME);
        await p.emulateMedia({ media: "print" });
        expect((await title.boundingBox())?.width ?? 0, `print ${view} ${width}`).toBeGreaterThan(1);
        await context.close();
      }
  });

  it("tells two uploaded emails with one subject apart on a phone, with no action, in each view", async () => {
    for (const view of ["member", "public"] as const) {
      const lines: string[] = [];
      for (const name of ["first.eml", "second.eml"]) {
        const { p, context } = await open(
          {
            stored: {
              channel: "upload",
              forwardedBy: null,
              uploadName: name,
              originalSubject: "Your account is locked",
            },
            view,
          },
          { width: 360 },
        );
        const line = metaLine(p);
        expect(await line.isVisible(), `${view} ${name}`).toBe(true);
        lines.push((await line.textContent()) ?? "");
        expect(lines.at(-1)).toContain(`Your account is locked · Uploaded file ${name}`);
        await context.close();
      }
      expect(lines[0]).not.toBe(lines[1]);
    }
  });
});
