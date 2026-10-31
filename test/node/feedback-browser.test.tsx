import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FeedbackControl } from "../../src/web/pages/feedback-control";
import type { ReportVerdict } from "../../src/web/pages/report-verdict";
import { ReportDocument } from "../../src/web/pages/report-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// "This verdict is wrong" in Chromium (D07 T03 §6), served over HTTP by this process with the shipped stylesheet,
// htmx and app script; its post answered here with the shapes the Worker's route gives (test/web/feedback.test.ts
// holds the route's own answers): opened and sent by keyboard, busy and sent once for two presses, the saved state
// said, an outage keeping the note, and the accessibility gate's rules at both widths and themes.
const PUBLIC = join(import.meta.dirname, "../../public");
const ID = "01JCASE0000000000000000000";
const VERDICT: ReportVerdict = {
  verdict: "malicious",
  headline: "A password-phishing email.",
  confidence: 0.9,
  reasons: ["A reason."],
  actions: ["Do not click."],
};
type Saved = { kind: "false_alarm" | "missed"; note: string | null } | null;
const state = {
  answer: "saved" as "saved" | 503 | "network",
  delayMs: 0,
  posts: [] as Record<string, string>[],
  saved: null as Saved,
};
afterEach(() => Object.assign(state, { answer: "saved", delayMs: 0, posts: [], saved: null }));

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
}
function page() {
  const { children: _, ...shell } = member();
  return String(
    <ReportDocument
      stored={{
        id: ID,
        status: "done",
        verdict: "malicious",
        sourceKind: "mail",
        channel: "email",
        createdAt: new Date().toISOString(),
      }}
      verdict={VERDICT}
      evidence={[]}
      shell={shell}
      coverage={[]}
      delivery="sent"
      feedback={state.saved}
    />,
  );
}

let browser: Browser;
let server: Server;
let origin: string;
beforeAll(async () => {
  browser = await launch();
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && path === `/r/${ID}/feedback`) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const saved = state.saved;
      return res.end(
        String(
          <FeedbackControl
            caseId={ID}
            verdict="malicious"
            saved={saved}
            open
            {...(saved ? { form: { kind: saved.kind, note: saved.note ?? "", errors: {} } } : {})}
          />,
        ),
      );
    }
    if (req.method === "POST" && path === `/r/${ID}/feedback`) {
      const sent = await body(req);
      state.posts.push(sent);
      await new Promise((done) => setTimeout(done, state.delayMs));
      if (state.answer === "network") return req.socket.destroy();
      if (state.answer === "saved")
        state.saved = { kind: sent.kind === "missed" ? "missed" : "false_alarm", note: sent.note || null };
      res.writeHead(state.answer === 503 ? 503 : 200, { "content-type": "text/html; charset=utf-8" });
      return res.end(
        String(
          state.answer === 503 ? (
            <FeedbackControl
              caseId={ID}
              verdict="malicious"
              saved={null}
              form={{
                kind: sent.kind ?? "",
                note: sent.note ?? "",
                errors: { note: "That did not go through just now. Nothing was saved: send it again in a moment." },
              }}
            />
          ) : (
            <FeedbackControl
              caseId={ID}
              verdict="malicious"
              saved={{ kind: sent.kind === "missed" ? "missed" : "false_alarm", note: sent.note || null }}
            />
          ),
        ),
      );
    }
    if (path === `/r/${ID}`) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(page());
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

async function open(width = 1280, theme: "light" | "dark" = "light") {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p: Page = await context.newPage();
  await p.goto(`${origin}/r/${ID}`, { waitUntil: "load" });
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  return { p, context };
}
async function tabTo(p: Page, match: (el: Element) => boolean) {
  for (let i = 0; i < 60; i++) {
    await p.keyboard.press("Tab");
    if (await p.evaluate((src) => new Function("el", `return (${src})(el)`)(document.activeElement), match.toString()))
      return;
  }
  throw new Error(`never reached ${match.toString()}`);
}

describe.skipIf(!chromiumPath() && !process.env.CI)("this verdict is wrong in Chromium", { timeout: 120_000 }, () => {
  it("opens and sends by keyboard alone, the saved state said", async () => {
    const { p, context } = await open(360);
    await tabTo(p, (el) => el.tagName === "SUMMARY");
    await p.keyboard.press("Enter");
    await tabTo(p, (el) => (el as HTMLInputElement).value === "false_alarm");
    await p.keyboard.press("Space");
    // From the choice, the next stop is the note.
    await p.keyboard.press("Tab");
    await p.keyboard.type("Our own supplier.");
    await tabTo(p, (el) => el.textContent?.trim() === "Send");
    await p.keyboard.press("Enter");
    const saved = p.locator("[data-saved]", { hasText: "You said this verdict is wrong: It is safe." });
    await expect.poll(() => saved.isVisible()).toBe(true);
    expect(state.posts).toEqual([{ kind: "false_alarm", note: "Our own supplier." }]);
    await context.close();
  });

  it("lands focus on Change after sending, says the saved answer once, and changes it after a reload", async () => {
    const { p, context } = await open();
    await p.getByText("This verdict is wrong").click();
    await p.getByLabel("It is safe").check();
    await p.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => p.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Change");
    expect(await p.locator("#report-announce").textContent()).toContain("You said this verdict is wrong: It is safe.");
    await p.reload({ waitUntil: "load" });
    expect(
      await p.locator("[data-saved]", { hasText: "You said this verdict is wrong: It is safe." }).isVisible(),
    ).toBe(true);
    await p.getByRole("button", { name: "Change" }).click();
    await expect
      .poll(() => p.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value))
      .toBe("false_alarm");
    await p.getByLabel("It is a scam").check();
    await p.getByLabel("A note for us (optional)").fill("On second thought.");
    await p.getByRole("button", { name: "Send" }).click();
    await expect
      .poll(() => p.locator("[data-saved]", { hasText: "You said this verdict is wrong: It is a scam." }).isVisible())
      .toBe(true);
    expect(state.saved).toEqual({ kind: "missed", note: "On second thought." });
    await context.close();
  });

  it("keeps the page and the note when the connection fails, and gives Send back", async () => {
    state.answer = "network";
    const { p, context } = await open();
    await p.getByText("This verdict is wrong").click();
    await p.getByLabel("It is a scam").check();
    await p.getByLabel("A note for us (optional)").fill("Kept through a dropped connection.");
    await p.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => p.getByRole("alert").filter({ hasText: "did not reach us" }).isVisible()).toBe(true);
    expect(new URL(p.url()).pathname).toBe(`/r/${ID}`);
    expect(await p.getByLabel("A note for us (optional)").inputValue()).toBe("Kept through a dropped connection.");
    await expect.poll(() => p.getByRole("button", { name: "Send" }).isEnabled()).toBe(true);
    await context.close();
  });

  it("shows Send busy and sends once for two presses", async () => {
    state.delayMs = 1200;
    const { p, context } = await open();
    await p.getByText("This verdict is wrong").click();
    await p.getByLabel("It is safe").check();
    const send = p.getByRole("button", { name: "Send" });
    await send.click();
    await expect.poll(() => p.getByRole("button", { name: "Sending…" }).isDisabled()).toBe(true);
    await p
      .getByRole("button", { name: "Sending…" })
      .click({ force: true, noWaitAfter: true })
      .catch(() => {});
    await expect
      .poll(() => p.locator("[data-saved]", { hasText: "You said this verdict is wrong" }).isVisible(), {
        timeout: 5000,
      })
      .toBe(true);
    expect(state.posts).toHaveLength(1);
    await context.close();
  });

  it("keeps the note through an outage and says so on the field", async () => {
    state.answer = 503;
    const { p, context } = await open();
    await p.getByText("This verdict is wrong").click();
    await p.getByLabel("It is a scam").check();
    await p.getByLabel("A note for us (optional)").fill("Kept through the outage.");
    await p.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => p.getByRole("alert").filter({ hasText: "Nothing was saved" }).isVisible()).toBe(true);
    expect(await p.getByLabel("A note for us (optional)").inputValue()).toBe("Kept through the outage.");
    // Focus is on the field in error, ready to try again.
    expect(await p.evaluate(() => (document.activeElement as HTMLTextAreaElement | null)?.name)).toBe("note");
    await context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280])
      it(`passes the accessibility gate's rules closed, open and saved (${theme}, ${width} px)`, async () => {
        const { p, context } = await open(width, theme);
        await p.addScriptTag({ path: AXE });
        expect(problems(await scan(p)), "closed").toEqual([]);
        await p.getByText("This verdict is wrong").click();
        expect(problems(await scan(p)), "open").toEqual([]);
        await p.getByLabel("It is safe").check();
        await p.getByRole("button", { name: "Send" }).click();
        await expect
          .poll(() => p.locator("[data-saved]", { hasText: "You said this verdict is wrong" }).isVisible())
          .toBe(true);
        expect(problems(await scan(p)), "saved").toEqual([]);
        expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await context.close();
      });
});
