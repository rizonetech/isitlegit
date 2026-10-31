import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertFor, type UploadAlert, UploadAlertBody, UploadPage } from "../../src/web/pages/upload-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// The upload page in Chromium (D01 T03 §6; design/SPEC.md M2), served over HTTP by this process with the shipped
// stylesheet and app script, `POST /upload` answering as src/web/pages/upload.tsx does from a script of answers: a
// chosen or dropped file sent at once with its progress and the report opened; each refusal said with focus on it and
// the file kept to send again; a stalled or lost request bounded and said truthfully, Try again reaching the report;
// what is known before sending refused with nothing sent; the form working without the script through Check this
// file; and the page passing the accessibility gate's rules at both widths and themes, every control reached by keyboard.
const PUBLIC = join(import.meta.dirname, "../../public");
const CASE = "01JCASE0000000000000000000";
const NOW = new Date("2026-10-31T12:48:00Z");
const PDF = Buffer.from("%PDF-1.4\n% an invoice\n%%EOF\n");

type Answer =
  | { kind: "report"; delay?: number }
  | { kind: "refuse"; status: number; error: string }
  | { kind: "stall" }
  | { kind: "drop" };
const state = { answers: [] as Answer[], posts: [] as { script: boolean; name: string | null }[] };

function page(alert?: UploadAlert, status?: number) {
  const { children: _, ...shell } = member();
  return String(
    <UploadPage
      shell={shell}
      org="Karoo Couriers"
      usage={{ used: 27, limit: 50 }}
      {...(alert ? { alert, status: status ?? 400 } : {})}
    />,
  );
}

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/upload" && req.method === "POST") {
      const script = req.headers["x-upload-script"] === "1";
      const name =
        typeof req.headers["x-file-name"] === "string" ? decodeURIComponent(req.headers["x-file-name"]) : null;
      const answer = state.answers.length > 1 ? (state.answers.shift() as Answer) : (state.answers[0] as Answer);
      // The connection drops before anything is read: the file never arrived.
      if (answer.kind === "drop") return req.socket.destroy();
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        state.posts.push({ script, name });
        if (answer.kind === "stall") return; // The whole file read, and no answer ever.
        if (answer.kind === "refuse") {
          const alert = alertFor(
            answer.status,
            answer.error,
            { name, size: null },
            { org: "Karoo Couriers", limit: 50 },
            NOW,
          );
          // The script is answered the alert alone, marked; a page without it the page again, as the route does.
          if (script) {
            res.writeHead(answer.status, { "content-type": "text/html; charset=utf-8", "x-upload-alert": "1" });
            return res.end(String(<UploadAlertBody alert={alert} />));
          }
          res.writeHead(answer.status, { "content-type": "text/html; charset=utf-8" });
          return res.end(page(alert, answer.status));
        }
        const send = () => {
          if (script) {
            res.writeHead(204, { "x-location": `/r/${CASE}` });
            return res.end();
          }
          res.writeHead(303, { location: `/r/${CASE}` });
          res.end();
        };
        if (answer.delay) setTimeout(send, answer.delay);
        else send();
      });
      return;
    }
    if (path === "/upload") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page());
    }
    if (path === `/r/${CASE}`) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<!doctype html><title>Report</title><h1>The report</h1>");
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

async function open(
  answers: Answer[],
  options: { width?: number; theme?: "light" | "dark"; script?: boolean; clock?: boolean } = {},
) {
  Object.assign(state, { answers, posts: [] });
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: 900 },
    javaScriptEnabled: options.script !== false,
  });
  const p: Page = await context.newPage();
  if (options.clock) await p.clock.install();
  await p.goto(`${origin}/upload`, { waitUntil: "load" });
  await p
    .evaluate((t) => document.documentElement.setAttribute("data-theme", t), options.theme ?? "light")
    .catch(() => {});
  return { p, context };
}
const alert = (p: Page) => p.locator("#upload-alert");
const choose = (p: Page, name = "invoice.pdf", buffer: Buffer = PDF) =>
  p.locator("#upload-file").setInputFiles({ name, mimeType: "application/pdf", buffer });
const focused = (p: Page) => p.evaluate(() => document.activeElement?.id ?? "");

describe.skipIf(!chromiumPath() && !process.env.CI)("the upload page in Chromium", { timeout: 120_000 }, () => {
  for (const width of [360, 1280])
    for (const theme of ["light", "dark"] as const)
      it(`fits and passes the accessibility gate's rules, every control by keyboard (${width} px, ${theme})`, async () => {
        const { p, context } = await open([{ kind: "report" }], { width, theme });
        expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await p.addScriptTag({ path: AXE });
        expect(problems(await scan(p))).toEqual([]);
        // The file input is reached by Tab (the drop zone shows its focus), and so is See your plan.
        const reached = new Set<string>();
        for (let i = 0; i < 40; i++) {
          await p.keyboard.press("Tab");
          reached.add(
            await p.evaluate(() => {
              const el = document.activeElement as HTMLElement | null;
              return el?.id || el?.textContent?.trim() || "";
            }),
          );
        }
        expect(reached.has("upload-file")).toBe(true);
        expect(reached.has("See your plan")).toBe(true);
        // With the script there is no submit: a chosen file is sent at once, as the board draws.
        expect(await p.getByRole("button", { name: "Check this file" }).isVisible()).toBe(false);
        await context.close();
      });

  it("sends a chosen file at once, shows its progress and the busy button, then opens the report", async () => {
    const { p, context } = await open([{ kind: "report", delay: 1500 }]);
    // Every value the progress takes, as a screen reader would read it: never past 100 (the request's multipart framing
    // is not the file's).
    await p.evaluate(() => {
      const w = window as unknown as { seen: number[]; lines: string[] };
      w.seen = [];
      w.lines = [];
      const sent = document.querySelector("[data-upload-sent]");
      if (sent)
        new MutationObserver(() => w.lines.push(sent.textContent ?? "")).observe(sent, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      const bar = document.querySelector("[data-upload-bar]");
      if (bar)
        new MutationObserver(() => w.seen.push(Number(bar.getAttribute("aria-valuenow")))).observe(bar, {
          attributes: true,
          attributeFilter: ["aria-valuenow"],
        });
    });
    await choose(p);
    await expect.poll(() => p.locator("form[data-upload]").getAttribute("aria-busy")).toBe("true");
    await expect.poll(() => p.evaluate(() => (window as unknown as { seen: number[] }).seen.length)).toBeGreaterThan(0);
    expect(Math.max(...(await p.evaluate(() => (window as unknown as { seen: number[] }).seen)))).toBeLessThanOrEqual(
      100,
    );
    // The words never say more was sent than the file holds.
    for (const line of await p.evaluate(() => (window as unknown as { lines: string[] }).lines)) {
      const [done, size] = [...line.matchAll(/([\d.]+) MB/g)].map((m) => Number(m[1]));
      expect(done ?? 0, line).toBeLessThanOrEqual(size ?? 0);
    }
    expect(await p.locator("form[data-upload]").getAttribute("data-state")).toBe("uploading");
    expect(await p.getByText("Uploading...", { exact: true }).isVisible()).toBe(true);
    expect(await p.getByText("Drop one file here").isVisible()).toBe(false);
    expect(await p.locator("#upload-file").isDisabled()).toBe(true);
    expect(await p.locator("[data-upload-progress]").isVisible()).toBe(true);
    // The uploading state passes the accessibility gate's rules too.
    await p.addScriptTag({ path: AXE });
    expect(problems(await scan(p))).toEqual([]);
    expect(await p.locator("[data-upload-name]").textContent()).toBe("Uploading invoice.pdf");
    await expect
      .poll(() => p.locator("[data-upload-sent]").textContent())
      .toMatch(/ MB of 0\.1 MB · then the report opens$/);
    await p.waitForURL(`${origin}/r/${CASE}`);
    expect(state.posts).toEqual([{ script: true, name: "invoice.pdf" }]);
    await context.close();
  });

  it("says a refusal with focus on it, keeps the file, and sends it again", async () => {
    const { p, context } = await open([
      { kind: "refuse", status: 503, error: "The file could not be taken just now. Try again in a moment." },
      { kind: "report" },
    ]);
    await choose(p);
    await expect.poll(() => alert(p).textContent()).toContain("The file could not be taken just now.");
    expect(await focused(p)).toBe("upload-alert");
    expect(await p.locator("#upload-file").isDisabled()).toBe(false);
    await p.getByRole("button", { name: "Try again" }).click();
    await p.waitForURL(`${origin}/r/${CASE}`);
    expect(state.posts).toHaveLength(2);
    await context.close();
  });

  it("names a refused file with the API's reason", async () => {
    const { p, context } = await open([{ kind: "refuse", status: 415, error: "It is a program, not a document." }]);
    await choose(p, "invoice.pdf.exe");
    await expect.poll(() => alert(p).textContent()).toContain('We cannot check "invoice.pdf.exe".');
    expect(await alert(p).textContent()).toContain("It is a program, not a document.");
    expect(await p.locator("form[data-upload]").getAttribute("data-state")).toBe("refused");
    await p.addScriptTag({ path: AXE });
    expect(problems(await scan(p))).toEqual([]);
    await context.close();
  });

  it("keeps Choose a file usable through the daily limit, so a choice after midnight is checked", async () => {
    const { p, context } = await open([
      { kind: "refuse", status: 429, error: "Today's checks for your organisation are used up." },
      { kind: "report" },
    ]);
    await choose(p);
    await expect.poll(() => alert(p).textContent()).toContain("Karoo Couriers has used all 50 checks for today.");
    expect(await alert(p).textContent()).toContain("Checks start again at 00:00 SAST, in 9 hours 12 minutes.");
    expect(await alert(p).getByRole("link", { name: "About your plan" }).getAttribute("href")).toBe("/settings/plan");
    expect(await p.locator("#upload-file").isDisabled()).toBe(false);
    expect(await p.locator("form[data-upload]").getAttribute("data-state")).toBe("paused");
    expect(await p.getByText("Uploads paused until midnight").isVisible()).toBe(true);
    await p.addScriptTag({ path: AXE });
    expect(problems(await scan(p))).toEqual([]);
    // The same file, chosen again after midnight, is sent: the input was emptied once its file was taken, since a
    // browser hears no change when the same file is chosen into an input that still holds it.
    expect(await p.locator("#upload-file").inputValue()).toBe("");
    await choose(p);
    await p.waitForURL(`${origin}/r/${CASE}`);
    await context.close();
  });

  it("says a signed-out refusal with Sign in again back to the page", async () => {
    const { p, context } = await open([{ kind: "refuse", status: 401, error: "sign in first" }]);
    await choose(p);
    await expect.poll(() => alert(p).textContent()).toContain("Your session ended.");
    expect(await alert(p).getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe(
      "/signin?next=%2Fupload",
    );
    expect(await alert(p).textContent()).toContain("nothing was uploaded");
    await context.close();
  });

  it("ends a request after 30 seconds with no answer, says the outcome is unknown, and Try again opens the report", async () => {
    const { p, context } = await open([{ kind: "stall" }, { kind: "report" }], { clock: true });
    await choose(p);
    await expect.poll(() => state.posts.length).toBe(1);
    await p.clock.runFor(31_000);
    await expect
      .poll(() => alert(p).textContent())
      .toContain("We could not tell whether the file arrived. Try again: the same file opens its first report.");
    expect(await p.locator("#upload-file").isDisabled()).toBe(false);
    await p.getByRole("button", { name: "Try again" }).click();
    await p.waitForURL(`${origin}/r/${CASE}`);
    await context.close();
  });

  it("says a file that never reached us did not arrive", async () => {
    const { p, context } = await open([{ kind: "drop" }]);
    await choose(p);
    await expect.poll(() => alert(p).textContent()).toMatch(/did not reach us|could not tell whether the file arrived/);
    await context.close();
  });

  it("refuses an oversized file and an overlong name before sending anything", async () => {
    const { p, context } = await open([{ kind: "report" }]);
    await choose(p, "site-meeting.mp3", Buffer.alloc(25 * 1024 * 1024 + 1));
    await expect.poll(() => alert(p).textContent()).toContain('"site-meeting.mp3" is 25.1 MB. The limit is 25 MB.');
    expect(await alert(p).textContent()).toContain("Upload a shorter clip");
    await choose(p, "scan.pdf", Buffer.alloc(26 * 1024 * 1024));
    await expect.poll(() => alert(p).textContent()).toContain("Upload a smaller copy");
    await choose(p, `${"n".repeat(256)}.pdf`);
    await expect.poll(() => alert(p).textContent()).toContain("The file's name is longer than 255 characters.");
    expect(state.posts).toHaveLength(0);
    await context.close();
  });

  it("sends one dropped file, refuses two with nothing sent, then sends one chosen", async () => {
    const { p, context } = await open([{ kind: "refuse", status: 503, error: "Busy." }]);
    const drop = (count: number) =>
      p.evaluate((n) => {
        const data = new DataTransfer();
        for (let i = 0; i < n; i++)
          data.items.add(new File(["%PDF-1.4\n%%EOF\n"], `drop-${i}.pdf`, { type: "application/pdf" }));
        document
          .querySelector("[data-upload-zone]")
          ?.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      }, count);
    await drop(2);
    await expect.poll(() => alert(p).textContent()).toBe("Drop one file at a time.");
    expect(state.posts).toHaveLength(0);
    await drop(1);
    await expect.poll(() => state.posts.length).toBe(1);
    expect(state.posts[0]?.name).toBe("drop-0.pdf");
    state.answers = [{ kind: "report" }];
    await choose(p);
    await p.waitForURL(`${origin}/r/${CASE}`);
    await context.close();
  });

  it("shows the zone's focus when the file input has keyboard focus", async () => {
    const { p, context } = await open([{ kind: "report" }]);
    for (let i = 0; i < 40 && (await focused(p)) !== "upload-file"; i++) await p.keyboard.press("Tab");
    expect(await focused(p)).toBe("upload-file");
    expect(await p.locator("[data-upload-zone]").evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
    await context.close();
  });

  it("keeps the page responsive while a large file is sent: no task over 50 ms", async () => {
    const { p, context } = await open([{ kind: "report", delay: 500 }]);
    // The file is made in the page first, so what is measured is the page's own handling of it, not its delivery.
    await p.evaluate(() => {
      const w = window as unknown as { long: number[]; big: File };
      w.big = new File([new Uint8Array(8 * 1024 * 1024).fill(1)], "big.pdf", { type: "application/pdf" });
    });
    await p.evaluate(
      () =>
        new Promise<void>((settled) => {
          const w = window as unknown as { long: number[]; big: File };
          w.long = [];
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) w.long.push(entry.duration);
          }).observe({ type: "longtask", buffered: false });
          setTimeout(() => {
            const data = new DataTransfer();
            data.items.add(w.big);
            document
              .querySelector("[data-upload-zone]")
              ?.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
            settled();
          }, 100);
        }),
    );
    // Read once the whole file has reached the server, while its answer is held back.
    await expect.poll(() => state.posts.length, { timeout: 30_000 }).toBe(1);
    const long = await p.evaluate(() => (window as unknown as { long: number[] }).long);
    expect(long.filter((ms) => ms > 50)).toEqual([]);
    await p.waitForURL(`${origin}/r/${CASE}`, { timeout: 30_000 });
    await context.close();
  });

  it("says a refusal without the script with how to try again, and shows the chosen file's input", async () => {
    const { p, context } = await open(
      [{ kind: "refuse", status: 503, error: "The file could not be taken just now." }],
      { script: false },
    );
    expect(await p.locator("#upload-file").isVisible()).toBe(true);
    await choose(p);
    await p.getByRole("button", { name: "Check this file" }).click();
    await p.waitForLoadState("load");
    expect(await alert(p).textContent()).toContain("The file could not be taken just now.");
    expect(await alert(p).textContent()).toContain("Choose the file again and select Check this file.");
    expect(await p.getByRole("button", { name: "Try again" }).isVisible()).toBe(false);
    await context.close();
  });

  it("works without the script: choose, Check this file, and the report", async () => {
    const { p, context } = await open([{ kind: "report" }], { script: false });
    await choose(p);
    await p.getByRole("button", { name: "Check this file" }).click();
    await p.waitForURL(`${origin}/r/${CASE}`);
    expect(state.posts).toEqual([{ script: false, name: null }]);
    await context.close();
  });
});
