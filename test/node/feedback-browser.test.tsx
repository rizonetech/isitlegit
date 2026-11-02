import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
  answer: "saved" as "saved" | 503 | "network" | "gateway" | "stall" | "committed-lost",
  delayMs: 0,
  posts: [] as Record<string, string>[],
  saved: null as Saved,
  // "Withdraw" (D07 T03 §21): the answer the route gives, and how many presses reached it.
  withdrawAnswer: "ok" as "ok" | 503 | "network" | "gateway" | "stall" | "committed-lost" | "signed-out",
  withdraws: 0,
  held: [] as ServerResponse[],
  dispute: false,
};
afterEach(() =>
  Object.assign(state, {
    answer: "saved",
    delayMs: 0,
    posts: [],
    saved: null,
    withdrawAnswer: "ok",
    withdraws: 0,
    held: [],
    dispute: false,
  }),
);

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
      dispute={state.dispute}
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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-feedback": "1" });
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
    if (req.method === "POST" && path === `/r/${ID}/feedback/withdraw`) {
      state.withdraws++;
      await new Promise((done) => setTimeout(done, state.delayMs));
      // A stalled request never answers (the page must time it out itself); a lost answer after the delete committed.
      if (state.withdrawAnswer === "stall") return void state.held.push(res);
      if (state.withdrawAnswer === "committed-lost") {
        state.saved = null;
        return req.socket.destroy();
      }
      if (state.withdrawAnswer === "signed-out") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return res.end("Not found");
      }
      if (state.withdrawAnswer === "network") return req.socket.destroy();
      if (state.withdrawAnswer === "gateway") {
        res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
        return res.end("<!doctype html><title>502 Bad gateway</title><h1>Bad gateway</h1>");
      }
      const failed = state.withdrawAnswer === 503;
      if (!failed) state.saved = null;
      res.writeHead(failed ? 503 : 200, { "content-type": "text/html; charset=utf-8", "x-feedback": "1" });
      return res.end(
        String(
          failed ? (
            <FeedbackControl
              caseId={ID}
              verdict="malicious"
              saved={state.saved}
              failed="That did not go through. Your feedback is still there: try again in a moment."
            />
          ) : (
            <FeedbackControl caseId={ID} verdict="malicious" saved={null} withdrawn />
          ),
        ),
      );
    }
    if (req.method === "POST" && path === `/r/${ID}/feedback`) {
      const sent = await body(req);
      state.posts.push(sent);
      await new Promise((done) => setTimeout(done, state.delayMs));
      if (state.answer === "network") return req.socket.destroy();
      if (state.answer === "stall") return void state.held.push(res);
      if (state.answer === "committed-lost") {
        state.saved = { kind: sent.kind === "missed" ? "missed" : "false_alarm", note: sent.note || null };
        return req.socket.destroy();
      }
      if (state.answer === "saved")
        state.saved = { kind: sent.kind === "missed" ? "missed" : "false_alarm", note: sent.note || null };
      if (state.answer === "gateway") {
        res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
        return res.end("<!doctype html><title>502 Bad gateway</title><h1>Bad gateway</h1>");
      }
      res.writeHead(state.answer === 503 ? 503 : 200, {
        "content-type": "text/html; charset=utf-8",
        "x-feedback": "1",
      });
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
  // A stalled withdrawal's connection is still open: closed first, or the server waits on it.
  server?.closeAllConnections();
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
    // One press by keyboard (D07 T03 §22): Tab to the button, Enter sends the dispute with no note.
    await tabTo(p, (el) => el.textContent?.trim() === "I think this is safe");
    await p.keyboard.press("Enter");
    const saved = p.locator("[data-saved]", { hasText: "Sent: you said this looks safe." });
    await expect.poll(() => saved.isVisible()).toBe(true);
    expect(state.posts).toEqual([{ kind: "false_alarm" }]);
    // The note is offered after: fill it and send it, replacing the dispute.
    await p.getByLabel("Add a note (optional)").fill("Our own supplier.");
    await p.getByRole("button", { name: "Send the note" }).click();
    await expect.poll(() => saved.isVisible()).toBe(true);
    expect(state.posts).toEqual([{ kind: "false_alarm" }, { kind: "false_alarm", note: "Our own supplier." }]);
    expect(state.saved).toEqual({ kind: "false_alarm", note: "Our own supplier." });
    await context.close();
  });

  it("lands focus on Change after sending, says the saved answer once, and changes it after a reload", async () => {
    const { p, context } = await open();
    await p.getByRole("button", { name: "I think this is safe" }).click();
    await expect.poll(() => p.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Change");
    expect(await p.locator("#report-announce").textContent()).toContain("Sent: you said this looks safe.");
    await p.reload({ waitUntil: "load" });
    expect(await p.locator("[data-saved]", { hasText: "Sent: you said this looks safe." }).isVisible()).toBe(true);
    await p.getByRole("button", { name: "Change" }).click();
    await expect
      .poll(() => p.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value))
      .toBe("false_alarm");
    await p.getByLabel("It is a scam").check();
    await p.getByLabel("A note for us (optional)").fill("On second thought.");
    await p.getByRole("button", { name: "Send" }).click();
    await expect
      .poll(() => p.locator("[data-saved]", { hasText: "Sent: you said this looks like a scam." }).isVisible())
      .toBe(true);
    expect(state.saved).toEqual({ kind: "missed", note: "On second thought." });
    await context.close();
  });

  // D07 T03 §21: Withdraw is one press, busy and sent once, lands focus on the closed control, says it once, holds across a
  // reload, and keeps the saved feedback visible through each kind of failure until a retry works.
  it("withdraws by keyboard, busy and once for two presses, focus on the closed control, held across a reload", async () => {
    state.saved = { kind: "false_alarm", note: null };
    state.delayMs = 600;
    const { p, context } = await open(360);
    await tabTo(p, (el) => el.textContent?.trim() === "Withdraw");
    await p.keyboard.press("Enter");
    const busy = p.getByRole("button", { name: "Withdrawing…" });
    await expect.poll(() => busy.isDisabled()).toBe(true);
    await p.keyboard.press("Enter");
    const said = p.locator("[data-withdrawn]", { hasText: "You took your feedback back." });
    await expect.poll(() => said.isVisible()).toBe(true);
    expect(state.withdraws).toBe(1);
    // Focus is on the closed control where the button was, so a keyboard member carries on from there.
    await expect.poll(() => p.evaluate(() => document.activeElement?.textContent?.trim())).toBe("I think this is safe");
    expect(await p.locator("#report-announce").textContent()).toBe("");
    expect(state.saved).toBeNull();
    await p.reload({ waitUntil: "load" });
    expect(await p.locator("[data-saved]").count()).toBe(0);
    expect(await p.getByText("Was this verdict wrong?").isVisible()).toBe(true);
    await context.close();
  });

  for (const answer of [503, "network", "gateway"] as const)
    it(`keeps the saved feedback and says so when Withdraw fails (${answer}), then withdraws on retry`, async () => {
      state.saved = { kind: "missed", note: "A note." };
      state.withdrawAnswer = answer;
      const { p, context } = await open();
      await p.getByRole("button", { name: "Withdraw" }).click();
      const words = p
        .getByRole("alert")
        .filter({ hasText: /may or may not be withdrawn|Your feedback is still there: try again in a moment\./ });
      await expect.poll(() => words.isVisible()).toBe(true);
      expect(new URL(p.url()).pathname).toBe(`/r/${ID}`);
      expect(await p.getByText("Bad gateway").count()).toBe(0);
      expect(await p.locator("[data-saved]", { hasText: "Sent: you said this looks like a scam." }).isVisible()).toBe(
        true,
      );
      expect(state.saved).toEqual({ kind: "missed", note: "A note." });
      // The button is given back and the retry works.
      await expect.poll(() => p.getByRole("button", { name: "Withdraw" }).isEnabled()).toBe(true);
      state.withdrawAnswer = "ok";
      await p.getByRole("button", { name: "Withdraw" }).click();
      await expect
        .poll(() => p.locator("[data-withdrawn]", { hasText: "You took your feedback back." }).isVisible())
        .toBe(true);
      expect(state.saved).toBeNull();
      await context.close();
    });

  // Completion review: a lost answer after a committed delete, a request that never answers, and an expired session.
  it("does not claim the feedback remains when the answer is lost after the delete committed", async () => {
    state.saved = { kind: "false_alarm", note: null };
    state.withdrawAnswer = "committed-lost";
    const { p, context } = await open();
    await p.getByRole("button", { name: "Withdraw" }).click();
    const words = p.getByRole("alert").filter({ hasText: "may or may not be withdrawn" });
    await expect.poll(() => words.isVisible()).toBe(true);
    expect(await p.getByText("Your feedback is still there").count()).toBe(0);
    // Reloading shows where it stands: withdrawn.
    await p.reload({ waitUntil: "load" });
    expect(await p.locator("[data-saved]").count()).toBe(0);
    expect(await p.getByText("Was this verdict wrong?").isVisible()).toBe(true);
    await context.close();
  });

  it("times a withdrawal that never answers out, saying what to do, and gives the button back", async () => {
    state.saved = { kind: "false_alarm", note: null };
    state.withdrawAnswer = "stall";
    const { p, context } = await open();
    const started = Date.now();
    await p.getByRole("button", { name: "Withdraw" }).click();
    const words = p.getByRole("alert").filter({ hasText: "Reload this page" });
    await expect.poll(() => words.isVisible(), { timeout: 20_000 }).toBe(true);
    expect(Date.now() - started).toBeLessThan(25_000);
    await expect.poll(() => p.getByRole("button", { name: "Withdraw" }).isEnabled()).toBe(true);
    expect(await p.locator("[data-saved]").isVisible()).toBe(true);
    await context.close();
  });

  it("tells a member whose session ended to reload and sign in, rather than to press again", async () => {
    state.saved = { kind: "false_alarm", note: null };
    state.withdrawAnswer = "signed-out";
    const { p, context } = await open();
    await p.getByRole("button", { name: "Withdraw" }).click();
    const words = p.getByRole("alert").filter({ hasText: "it asks you to sign in if your session ended" });
    await expect.poll(() => words.isVisible()).toBe(true);
    expect(await p.getByText("Not found").count()).toBe(0);
    await expect.poll(() => p.getByRole("button", { name: "Withdraw" }).isEnabled()).toBe(true);
    await context.close();
  });

  // The busy words are drawn in a later task (src/web/client/app.ts): a failure answer that arrives before that
  // task runs gives the button back first, and the later task must not take it away again (CI runs 41300494905
  // and 41301997745: the Withdraw button stayed disabled after a gateway and a signed-out answer).
  it("does not take a busy form's button away again when its failure arrives before the busy words", async () => {
    const { p, context } = await open();
    await p.evaluate(() => {
      const form = document.createElement("form");
      form.dataset.busy = "";
      const button = document.createElement("button");
      button.type = "submit";
      button.dataset.busyLabel = "Withdrawing…";
      button.textContent = "Withdraw";
      form.append(button);
      document.body.append(form);
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("busy:release"));
    });
    await p.waitForTimeout(100);
    const button = p.getByRole("button", { name: "Withdraw" });
    expect(await button.isEnabled()).toBe(true);
    expect(await button.textContent()).toBe("Withdraw");
    await context.close();
  });

  it("keeps the page and the note when the connection fails, and gives Send back", async () => {
    state.answer = "network";
    state.saved = { kind: "missed", note: null };
    const { p, context } = await open();
    await p.getByRole("button", { name: "Change" }).click();
    await p.getByLabel("It is a scam").check();
    await p.getByLabel("A note for us (optional)").fill("Kept through a dropped connection.");
    await p.getByRole("button", { name: "Send" }).click();
    await expect
      .poll(() => p.getByRole("alert").filter({ hasText: "may or may not have gone through" }).isVisible())
      .toBe(true);
    expect(new URL(p.url()).pathname).toBe(`/r/${ID}`);
    expect(await p.getByLabel("A note for us (optional)").inputValue()).toBe("Kept through a dropped connection.");
    await expect.poll(() => p.getByRole("button", { name: "Send" }).isEnabled()).toBe(true);
    await context.close();
  });

  it("keeps the form and the note when a gateway answers with its own error page", async () => {
    state.answer = "gateway";
    state.saved = { kind: "missed", note: null };
    const { p, context } = await open();
    await p.getByRole("button", { name: "Change" }).click();
    await p.getByLabel("It is a scam").check();
    await p.getByLabel("A note for us (optional)").fill("Kept through a gateway error.");
    await p.getByRole("button", { name: "Send" }).click();
    await expect
      .poll(() => p.getByRole("alert").filter({ hasText: "may or may not have gone through" }).isVisible())
      .toBe(true);
    expect(await p.getByText("Bad gateway").count()).toBe(0);
    expect(await p.getByLabel("A note for us (optional)").inputValue()).toBe("Kept through a gateway error.");
    await context.close();
  });

  it("shows Send busy and sends once for two presses", async () => {
    state.delayMs = 1200;
    const { p, context } = await open();
    const send = p.getByRole("button", { name: "I think this is safe" });
    await send.click();
    await expect.poll(() => p.getByRole("button", { name: "Sending…" }).isDisabled()).toBe(true);
    await p
      .getByRole("button", { name: "Sending…" })
      .click({ force: true, noWaitAfter: true })
      .catch(() => {});
    await expect
      .poll(() => p.locator("[data-saved]", { hasText: "Sent: you said this looks" }).isVisible(), {
        timeout: 5000,
      })
      .toBe(true);
    expect(state.posts).toHaveLength(1);
    await context.close();
  });

  it("keeps the note through an outage and says so on the field", async () => {
    state.answer = 503;
    state.saved = { kind: "missed", note: null };
    const { p, context } = await open();
    await p.getByRole("button", { name: "Change" }).click();
    await p.getByLabel("It is a scam").check();
    await p.getByLabel("A note for us (optional)").fill("Kept through the outage.");
    await p.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => p.getByRole("alert").filter({ hasText: "Nothing was saved" }).isVisible()).toBe(true);
    expect(await p.getByLabel("A note for us (optional)").inputValue()).toBe("Kept through the outage.");
    // Focus is on the field in error, ready to try again.
    expect(await p.evaluate(() => (document.activeElement as HTMLTextAreaElement | null)?.name)).toBe("note");
    await context.close();
  });

  // D07 T03 §22: the member who came from the email lands on the focused one-press button, and a stalled send is
  // given up with truthful words and the button back.
  it("lands on the focused dispute button from the email, and gives up a stalled send truthfully", async () => {
    state.dispute = true;
    const { p, context } = await open(360);
    expect(await p.getByText("You came here from the email to say this verdict is wrong.").isVisible()).toBe(true);
    await expect.poll(() => p.evaluate(() => document.activeElement?.textContent?.trim())).toBe("I think this is safe");
    state.answer = "stall";
    await p.getByRole("button", { name: "I think this is safe" }).click();
    const words = p.getByRole("alert").filter({ hasText: "may or may not have gone through" });
    await expect.poll(() => words.isVisible(), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => p.getByRole("button", { name: "I think this is safe" }).isEnabled()).toBe(true);
    expect(state.saved).toBeNull();
    await context.close();
  });

  // D07 T09 §3: the mailbox journey in two activations, at phone width, read back after a reload.
  it("disputes from the mailbox in two activations at 360 px and reads it back after a reload", async () => {
    state.dispute = true;
    const { p, context } = await open(360);
    // Activation one was opening the mail's link: the report is here, the button focused, nothing sent.
    expect(await p.getByText("You came here from the email to say this verdict is wrong.").isVisible()).toBe(true);
    await expect.poll(() => p.evaluate(() => document.activeElement?.textContent?.trim())).toBe("I think this is safe");
    expect(state.posts).toHaveLength(0);
    // Activation two is the one press, by keyboard.
    await p.keyboard.press("Enter");
    await expect
      .poll(() => p.locator("[data-saved]", { hasText: "Sent: you said this looks safe." }).isVisible())
      .toBe(true);
    expect(state.posts).toHaveLength(1);
    // The note, Change and Withdraw are all still offered, and a reload reads the saved dispute back, sending nothing again.
    expect(await p.getByLabel("Add a note (optional)").isVisible()).toBe(true);
    expect(await p.getByRole("button", { name: "Change" }).isVisible()).toBe(true);
    expect(await p.getByRole("button", { name: "Withdraw" }).isVisible()).toBe(true);
    await p.reload({ waitUntil: "load" });
    expect(await p.locator("[data-saved]", { hasText: "Sent: you said this looks safe." }).isVisible()).toBe(true);
    expect(state.posts).toHaveLength(1);
    await context.close();
  });

  // D07 T03 §22 completion: an unsent note survives Change, the actions cannot race, and a send stored before its
  // answer was lost reads back as saved.
  it("keeps an unsent note through Change, coordinates the actions, and reads back a committed send", async () => {
    state.saved = { kind: "false_alarm", note: null };
    const { p, context } = await open();
    await p.getByLabel("Add a note (optional)").fill("Draft kept through Change.");
    await p.getByRole("button", { name: "Change" }).click();
    await expect.poll(() => p.getByLabel("A note for us (optional)").inputValue()).toBe("Draft kept through Change.");
    await context.close();
    // While the note send is delayed, Withdraw cannot be pressed.
    state.saved = { kind: "false_alarm", note: null };
    state.delayMs = 800;
    const again = await open();
    await again.p.getByLabel("Add a note (optional)").fill("A delayed note.");
    await again.p.getByRole("button", { name: "Send the note" }).click();
    await expect.poll(() => again.p.getByRole("button", { name: "Withdraw" }).isDisabled()).toBe(true);
    await expect
      .poll(() => again.p.locator("[data-saved]", { hasText: "Sent: you said this looks" }).isVisible())
      .toBe(true);
    await again.context.close();
    // Stored, then the answer lost: the words are uncertain, and a reload shows the saved dispute.
    state.saved = null;
    state.delayMs = 0;
    state.answer = "committed-lost";
    const third = await open();
    await third.p.getByRole("button", { name: "I think this is safe" }).click();
    const words = third.p.getByRole("alert").filter({ hasText: "may or may not have gone through" });
    await expect.poll(() => words.isVisible()).toBe(true);
    await third.p.reload({ waitUntil: "load" });
    expect(await third.p.locator("[data-saved]", { hasText: "Sent: you said this looks safe." }).isVisible()).toBe(
      true,
    );
    await third.context.close();
  });

  // D07 T03 §22 round 1: the note and Change sends are bounded too, their words kept and the siblings released.
  it("gives up a stalled note and a stalled Change send, keeping the words and releasing the actions", async () => {
    state.saved = { kind: "false_alarm", note: null };
    state.answer = "stall";
    const { p, context } = await open();
    await p.getByLabel("Add a note (optional)").fill("A stalled note.");
    await p.getByRole("button", { name: "Send the note" }).click();
    const words = p.getByRole("alert").filter({ hasText: "may or may not have gone through" });
    await expect.poll(() => words.isVisible(), { timeout: 20_000 }).toBe(true);
    expect(await p.getByLabel("Add a note (optional)").inputValue()).toBe("A stalled note.");
    await expect.poll(() => p.getByRole("button", { name: "Withdraw" }).isEnabled()).toBe(true);
    await expect.poll(() => p.getByRole("button", { name: "Send the note" }).isEnabled()).toBe(true);
    // Change's own send stalls the same way.
    state.answer = "saved";
    await p.getByRole("button", { name: "Change" }).click();
    await p.getByLabel("A note for us (optional)").fill("A stalled change.");
    state.answer = "stall";
    await p.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => words.isVisible(), { timeout: 20_000 }).toBe(true);
    expect(await p.getByLabel("A note for us (optional)").inputValue()).toBe("A stalled change.");
    await expect.poll(() => p.getByRole("button", { name: "Send" }).isEnabled()).toBe(true);
    await context.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [360, 1280])
      it(`passes the accessibility gate's rules closed, open, saved and withdrawn (${theme}, ${width} px)`, async () => {
        const { p, context } = await open(width, theme);
        await p.addScriptTag({ path: AXE });
        expect(problems(await scan(p)), "closed").toEqual([]);
        await p.getByRole("button", { name: "I think this is safe" }).click();
        await expect
          .poll(() => p.locator("[data-saved]", { hasText: "Sent: you said this looks" }).isVisible())
          .toBe(true);
        expect(problems(await scan(p)), "saved").toEqual([]);
        await p.getByRole("button", { name: "Change" }).click();
        expect(problems(await scan(p)), "open").toEqual([]);
        await p.getByLabel("It is safe").check();
        await p.getByRole("button", { name: "Send" }).click();
        await expect
          .poll(() => p.locator("[data-saved]", { hasText: "Sent: you said this looks" }).isVisible())
          .toBe(true);
        expect(problems(await scan(p)), "saved").toEqual([]);
        expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        // Taken back (D07 T03 §21): the sentence and the closed control again.
        await p.getByRole("button", { name: "Withdraw" }).click();
        await expect.poll(() => p.locator("[data-withdrawn]").isVisible()).toBe(true);
        expect(problems(await scan(p)), "withdrawn").toEqual([]);
        expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await context.close();
      });
});
