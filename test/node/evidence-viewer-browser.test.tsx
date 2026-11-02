import { existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReportVerdict } from "../../src/web/pages/report-verdict";
import { ReportDocument, type ReportEvidence } from "../../src/web/pages/report-view";
import { AXE, problems, scan } from "./axe";
import { chromiumPath, launch } from "./browser";
import { member } from "./shell-fixtures";

// The full-size evidence viewer in Chromium (D07 T03 §8, boards `Report-EvidenceViewer` and its Mobile): a preview's link
// opens a native modal dialog with the capture at its natural size in a scrollable, focusable region, closed by Close or
// Escape with focus returning to the link that opened it; without script the link opens the capture; a capture that is gone,
// a report link that has expired and a failed read each say so (the dialog's own too) with Try again only where it can help;
// at 360 px the capture scrolls both ways, Close stays in view and the page behind does not scroll; names, alt text, Space
// and arrow keys, and the axe rules (contrast included) hold in both themes.
const APP = "http://localhost";
const PUBLIC = join(import.meta.dirname, "../../public");
const WIDE = 1400;
const TALL = 900;

// A solid PNG of the given size (the test's own bytes, so the natural size the dialog reports is known).
function png(w: number, h: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0xe6)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const BIG = png(WIDE, TALL);

// A worker that answers one capture with headers now and a body that never arrives, so a test can hold the transfer
// past the headers (a route stub can only hold or answer whole).
const SW_STALL = [
  'self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));',
  'self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));',
  'self.addEventListener("fetch", (event) => {',
  "  const url = new URL(event.request.url);",
  '  if (url.pathname.startsWith("/a/") && url.searchParams.has("stallbody")) {',
  "    event.respondWith(",
  '      new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "image/png" } }),',
  "    );",
  "  }",
  "});",
].join("\n");

const SHOT = `art/01JCASE0000000000000000000/render/${"a".repeat(64)}-landing-1.png`;
const WALK = `art/01JCASE0000000000000000000/render/${"d".repeat(64)}-walk-2.png`;
const LONG = "accountverificationnimbusmai1securelogin.portal.example";
const cards: ReportEvidence[] = [
  {
    id: "E1",
    check: "link.credential_form",
    severity: "high",
    summary: `The page the link to ${LONG} reaches asks for a password.`,
    detail: {
      link: `https://${LONG}/x`,
      page: `https://${LONG}/in`,
      frame: false,
      passwordFields: 1,
      sends: [],
      shotKey: SHOT,
    },
    artefacts: [SHOT],
  },
  {
    id: "E2",
    check: "walkthrough.credential_target",
    severity: "critical",
    summary: "The test credentials would go to a site that is not NimbusMail's.",
    detail: {
      url: `https://${LONG}/post`,
      domain: LONG,
      method: "POST",
      fields: ["username", "password"],
      state: "delivered",
      outcome: "accepted",
      brand: "NimbusMail",
      brandEvidence: "E4",
    },
    artefacts: [WALK],
  },
];
const VERDICT: ReportVerdict = {
  verdict: "malicious",
  headline: "This is a password-phishing email pretending to be NimbusMail.",
  confidence: 0.93,
  reasons: [{ text: "A lookalike domain.", evidenceIds: ["E1"] }],
  actions: ["Do not click the link."],
};
function html() {
  const { children: _, ...shell } = member();
  return String(
    <ReportDocument
      stored={{
        id: "01JCASE0000000000000000000",
        status: "done",
        verdict: "malicious",
        sourceKind: "mail",
        channel: "email",
        createdAt: "2026-10-27T08:12:00Z",
      }}
      verdict={VERDICT}
      evidence={cards}
      shell={shell}
    />,
  );
}

// What the capture route answers: the image, or a marked failure the way `src/web/pages/artefacts.tsx` marks them.
type Mode = "png" | "gone" | "link-expired" | "unavailable" | "network" | "signed-out";
let mode: Mode = "png";
let hold: Promise<void> | null = null;
let delayMs = 0;
let holdImages = true;
let withScript = true;
const requests: { url: string; kind: string }[] = [];

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});
async function open(width: number, theme: "light" | "dark" = "light") {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const p: Page = await context.newPage();
  const body = html();
  await p.route(`${APP}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/r/case") return route.fulfill({ status: 200, contentType: "text/html", body });
    if (url.pathname === "/signin")
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Sign in</title><h1>Sign in</h1>",
      });
    if (url.pathname === "/sw-test.js")
      return route.fulfill({ status: 200, contentType: "text/javascript", body: SW_STALL });
    if (url.pathname.startsWith("/a/")) {
      requests.push({ url: url.pathname + url.search, kind: request.resourceType() });
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (hold && (holdImages || request.resourceType() !== "image")) await hold;
      if (mode === "network") return route.abort("failed");
      if (mode === "signed-out")
        return route.fulfill({
          status: 303,
          headers: { location: `/signin?next=${encodeURIComponent("/r/01JCASE0000000000000000000")}` },
          body: "",
        });
      if (mode === "gone")
        return route.fulfill({
          status: 410,
          headers: { "x-artefact-state": "gone" },
          contentType: "text/html",
          body: "<p>gone</p>",
        });
      if (mode === "link-expired")
        return route.fulfill({
          status: 410,
          headers: { "x-artefact-state": "link-expired" },
          contentType: "text/html",
          body: "<p>expired</p>",
        });
      if (mode === "unavailable")
        return route.fulfill({
          status: 503,
          headers: { "x-artefact-state": "unavailable" },
          contentType: "text/html",
          body: "<p>down</p>",
        });
      if (!url.searchParams.has("inline"))
        return route.fulfill({
          status: 200,
          headers: { "content-disposition": 'attachment; filename="capture.png"' },
          contentType: "application/octet-stream",
          body: BIG,
        });
      return route.fulfill({
        status: 200,
        headers: { "cache-control": "private, no-store" },
        contentType: "image/png",
        body: BIG,
      });
    }
    const file = join(PUBLIC, url.pathname);
    if (url.pathname.startsWith("/static/") && url.pathname.endsWith(".js") && !withScript) return route.abort();
    if (url.pathname.startsWith("/static/") && existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404 });
  });
  await p.goto(`${APP}/r/case`);
  await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  // A phone keeps the uncited cards in a closed disclosure, where a lazy image is never requested; open it and reach each.
  await p.evaluate(async () => {
    for (const more of document.querySelectorAll("details[data-more-findings]"))
      (more as HTMLDetailsElement).open = true;
    for (const img of document.querySelectorAll("img[data-evidence-image]")) {
      (img.parentElement ?? img).scrollIntoView();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    window.scrollTo(0, 0);
  });
  return { p, context };
}
const opener = (p: Page, id = "e1") => p.locator(`#${id} a[data-evidence-open]`);
const viewer = (p: Page) => p.locator("dialog[data-evidence-viewer]");
const gate = () => {
  let go!: () => void;
  const g = new Promise<void>((resolve) => {
    go = resolve;
  });
  return { g, go };
};
async function reset() {
  mode = "png";
  hold = null;
  delayMs = 0;
  holdImages = true;
  withScript = true;
  requests.length = 0;
}

describe.skipIf(!chromiumPath() && !process.env.CI)(
  "the full-size evidence viewer in Chromium",
  { timeout: 120_000 },
  () => {
    for (const theme of ["light", "dark"] as const)
      it(`opens with Enter at the capture's natural size, scrolls, closes with Close and Escape and returns focus (${theme})`, async () => {
        await reset();
        const { p, context } = await open(1280, theme);
        try {
          const link = opener(p);
          await expect.poll(() => link.count()).toBe(1);
          expect(await link.getAttribute("role")).toBe("button");
          expect(await link.getAttribute("aria-label")).toBe(
            "Open at full size: The page as the contained browser saw it",
          );
          await link.focus();
          await p.keyboard.press("Enter");
          const dialog = viewer(p);
          await expect.poll(() => dialog.isVisible()).toBe(true);
          // The heading repeats the card's id and the caption; the size comes from the loaded image itself.
          expect(await dialog.getByRole("heading").textContent()).toBe("E1 · The page as the contained browser saw it");
          await expect
            .poll(() => dialog.locator("#evidence-viewer-meta").textContent())
            .toContain(`${WIDE} × ${TALL} px`);
          const image = dialog.locator("img");
          expect(await image.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(WIDE);
          expect(await image.evaluate((i) => (i as HTMLImageElement).width)).toBe(WIDE);
          expect(await image.getAttribute("alt")).toBe("The page as the contained browser saw it");
          // The scroll region holds the whole capture, scrolls and is named.
          const region = dialog.getByRole("region");
          expect(await region.getAttribute("aria-label")).toBe(
            "Screenshot at full size: The page as the contained browser saw it",
          );
          expect(await region.evaluate((r) => r.scrollWidth > r.clientWidth || r.scrollHeight > r.clientHeight)).toBe(
            true,
          );
          // The dialog is named by its heading, and the page behind is inert and does not scroll.
          expect(
            await dialog.evaluate((d) => document.getElementById(d.getAttribute("aria-labelledby") ?? "")?.textContent),
          ).toContain("E1");
          expect(await p.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");
          expect(
            await p.evaluate(
              () => (document.querySelector("main") as HTMLElement | null)?.matches(":modal ~ *, :not(:modal)") ?? true,
            ),
          ).toBe(true);
          // Close closes, and focus is back on the link.
          await dialog.getByRole("button", { name: "Close" }).click();
          await expect.poll(() => dialog.count()).toBe(0);
          expect(await link.evaluate((el) => el === document.activeElement)).toBe(true);
          // Escape does the same, from the dialog's own focus.
          await p.keyboard.press("Enter");
          await expect.poll(() => dialog.isVisible()).toBe(true);
          await p.keyboard.press("Escape");
          await expect.poll(() => dialog.count()).toBe(0);
          expect(await link.evaluate((el) => el === document.activeElement)).toBe(true);
          expect(await p.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
        } finally {
          await context.close();
        }
      });

    it("opens with Space, and arrow keys move the capture's scroll position", async () => {
      await reset();
      const { p, context } = await open(1280);
      try {
        const link = opener(p);
        await link.focus();
        await p.keyboard.press("Space");
        const dialog = viewer(p);
        await expect.poll(() => dialog.isVisible()).toBe(true);
        await expect.poll(() => dialog.locator("img").isVisible()).toBe(true);
        const region = dialog.getByRole("region");
        await region.focus();
        const before = await region.evaluate((r) => [r.scrollLeft, r.scrollTop]);
        await p.keyboard.press("ArrowDown");
        await p.keyboard.press("ArrowRight");
        await expect.poll(() => region.evaluate((r) => [r.scrollLeft, r.scrollTop])).not.toEqual(before);
        // Tab order stays inside the dialog: Close, the scroll region, the download link, and round again.
        const names: string[] = [];
        await dialog.getByRole("button", { name: "Close" }).focus();
        for (let i = 0; i < 3; i++) {
          await p.keyboard.press("Tab");
          names.push(
            await p.evaluate(
              () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "",
            ),
          );
        }
        expect(names[0]).toContain("Screenshot at full size");
        expect(names[1]).toBe("Download the screenshot (PNG)");
        // The page behind is inert, so the next Tab never lands on it: it wraps to the dialog or leaves the document.
        expect(
          await p.evaluate(() => {
            const active = document.activeElement;
            return active === document.body || active?.closest("dialog") !== null;
          }),
        ).toBe(true);
      } finally {
        await context.close();
      }
    });

    it("downloads the capture as an attachment from the dialog's link, with the report link's own parameters kept", async () => {
      await reset();
      const { p, context } = await open(1280);
      try {
        await opener(p).focus();
        await p.keyboard.press("Enter");
        const dialog = viewer(p);
        await expect.poll(() => dialog.isVisible()).toBe(true);
        const link = dialog.getByRole("link", { name: "Download the screenshot (PNG)" });
        const href = (await link.getAttribute("href")) ?? "";
        expect(href).toContain(`/a/01JCASE0000000000000000000/`);
        expect(href).not.toContain("inline=1");
        const answer = await p.evaluate(async (address) => {
          const r = await fetch(address);
          return {
            status: r.status,
            disposition: r.headers.get("content-disposition"),
            length: (await r.arrayBuffer()).byteLength,
          };
        }, href);
        expect(answer.status).toBe(200);
        expect(answer.disposition).toMatch(/^attachment;/);
        expect(answer.length).toBe(BIG.length);
      } finally {
        await context.close();
      }
    });

    it("opens the capture itself when the app script never runs", async () => {
      await reset();
      withScript = false;
      const { p, context } = await open(1280);
      try {
        const link = opener(p);
        await expect.poll(() => link.count()).toBe(1);
        expect(await link.getAttribute("role")).toBeNull();
        await link.click();
        await expect.poll(() => p.url()).toContain("/a/01JCASE0000000000000000000/");
        expect(p.url()).toContain("inline=1");
        expect(await viewer(p).count()).toBe(0);
      } finally {
        await context.close();
      }
    });

    for (const [state, words, second] of [
      ["gone", "This screenshot is no longer stored.", "Kept for 30 days. The finding above still stands."],
      ["link-expired", "This report link has expired.", "Ask for a new one."],
    ] as const)
      it(`says a ${state} capture on the card and offers nothing to open or retry`, async () => {
        await reset();
        mode = state;
        const { p, context } = await open(1280);
        try {
          const note = p.locator("#e1 [data-evidence-failed]");
          await expect.poll(() => note.count()).toBe(1);
          expect(await note.getAttribute("data-evidence-failed")).toBe(state);
          expect(await note.getByText(words).isVisible()).toBe(true);
          expect(await note.getByText(second).isVisible()).toBe(true);
          expect(await p.locator("#e1").getByRole("button", { name: "Try again" }).count()).toBe(0);
          expect(await opener(p).isVisible()).toBe(false);
          expect(
            await p
              .locator("#e1")
              .getByRole("link", { name: /Open at full size/ })
              .count(),
          ).toBe(0);
        } finally {
          await context.close();
        }
      });

    it("keeps Try again beside the opener, never opening the dialog, and shows the preview and its link once the read succeeds", async () => {
      await reset();
      mode = "unavailable";
      const { p, context } = await open(1280);
      try {
        const retry = p.locator("#e1").getByRole("button", { name: "Try again" });
        await expect.poll(() => retry.count()).toBe(1);
        // The control is a sibling of the opener link, not inside it.
        expect(await retry.evaluate((b) => b.closest("a[data-evidence-open]") === null)).toBe(true);
        await retry.focus();
        mode = "unavailable";
        await p.keyboard.press("Enter");
        await expect
          .poll(() => p.locator("#e1 [data-evidence-status]").textContent())
          .toBe("The screenshot still could not be loaded.");
        expect(await viewer(p).count()).toBe(0);
        expect(await p.evaluate(() => document.activeElement?.textContent)).toBe("Try again");
        mode = "png";
        await p.keyboard.press("Enter");
        await expect.poll(() => opener(p).isVisible()).toBe(true);
        await expect.poll(() => p.locator("#e1 [data-evidence-status]").textContent()).toBe("The screenshot loaded.");
        expect(await viewer(p).count()).toBe(0);
      } finally {
        await context.close();
      }
    });

    it("leaves a reader who tabbed away where they are when a retry fails after the move", async () => {
      await reset();
      mode = "unavailable";
      const { p, context } = await open(1280);
      const slow = gate();
      try {
        const retry = p.locator("#e1").getByRole("button", { name: "Try again" });
        await expect.poll(() => retry.count()).toBe(1);
        await retry.focus();
        hold = slow.g;
        await p.keyboard.press("Enter");
        await expect
          .poll(() => p.locator("#e1 [data-evidence-status]").textContent())
          .toBe("Loading the screenshot again.");
        await p.keyboard.press("Tab");
        await p.evaluate(() => document.activeElement?.setAttribute("data-moved-to", "true"));
        hold = null;
        slow.go();
        await expect
          .poll(() => p.locator("#e1 [data-evidence-status]").textContent())
          .toBe("The screenshot still could not be loaded.");
        expect(await p.evaluate(() => document.activeElement?.getAttribute("data-moved-to"))).toBe("true");
      } finally {
        hold = null;
        slow.go();
        await context.close();
      }
    });

    for (const [state, words] of [
      ["gone", "This screenshot is no longer stored."],
      ["link-expired", "This report link has expired."],
      ["unavailable", "This screenshot could not be loaded."],
      ["network", "This screenshot could not be loaded."],
    ] as const)
      it(`gives the dialog its own ${state} state with Close always usable${state === "unavailable" || state === "network" ? ", and a retry that succeeds" : ""}`, async () => {
        await reset();
        const { p, context } = await open(1280);
        try {
          // The preview loaded; the viewer's own request then answers as the state says.
          const link = opener(p);
          await expect.poll(() => link.isVisible()).toBe(true);
          await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
          mode = state;
          await link.focus();
          await p.keyboard.press("Enter");
          const dialog = viewer(p);
          await expect.poll(() => dialog.isVisible()).toBe(true);
          await expect.poll(() => dialog.getByRole("region").getByText(words).isVisible()).toBe(true);
          const retry = dialog.getByRole("button", { name: "Try again" });
          if (state === "unavailable" || state === "network") {
            mode = "png";
            await retry.click();
            await expect.poll(() => dialog.locator("img").isVisible()).toBe(true);
            expect(await dialog.getByText(words).count()).toBe(0);
          } else {
            expect(await retry.count()).toBe(0);
          }
          // Close works in every state, and focus returns to the link.
          await dialog.getByRole("button", { name: "Close" }).click();
          await expect.poll(() => dialog.count()).toBe(0);
          expect(await link.evaluate((el) => el === document.activeElement)).toBe(true);
        } finally {
          await context.close();
        }
      });

    it("says the viewer is loading while its answer is held, keeps Close usable, then shows the capture", async () => {
      await reset();
      const { p, context } = await open(1280);
      const slow = gate();
      try {
        const link = opener(p);
        await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
        hold = slow.g;
        await link.focus();
        await p.keyboard.press("Enter");
        const dialog = viewer(p);
        await expect.poll(() => dialog.isVisible()).toBe(true);
        const status = dialog.getByRole("status");
        await expect.poll(() => status.textContent()).toBe("Loading the screenshot at full size.");
        expect(await dialog.locator("img").isVisible()).toBe(false);
        await dialog.getByRole("button", { name: "Close" }).focus();
        await p.keyboard.press("Escape");
        await expect.poll(() => dialog.count()).toBe(0);
        await p.keyboard.press("Enter");
        await expect.poll(() => dialog.isVisible()).toBe(true);
        hold = null;
        slow.go();
        await expect.poll(() => dialog.locator("img").isVisible()).toBe(true);
      } finally {
        hold = null;
        slow.go();
        await context.close();
      }
    });

    for (const state of ["gone", "link-expired"] as const)
      it(`offers no download from a ${state} dialog, and announces the outcome once`, async () => {
        await reset();
        const { p, context } = await open(1280);
        try {
          await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
          mode = state;
          await opener(p).focus();
          await p.keyboard.press("Enter");
          const dialog = viewer(p);
          await expect
            .poll(() => dialog.getByRole("status").textContent())
            .toContain(state === "gone" ? "This screenshot is no longer stored." : "This report link has expired.");
          expect(await dialog.getByRole("link", { name: "Download the screenshot (PNG)" }).isVisible()).toBe(false);
          expect(await dialog.getByRole("button", { name: "Try again" }).count()).toBe(0);
          expect(await dialog.getByRole("button", { name: "Close" }).isVisible()).toBe(true);
        } finally {
          await context.close();
        }
      });

    it("keeps the keyboard in the dialog through a retry, announces each outcome, and leaves a reader who moved on alone", async () => {
      await reset();
      const { p, context } = await open(1280);
      const slow = gate();
      try {
        await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
        mode = "unavailable";
        await opener(p).focus();
        await p.keyboard.press("Enter");
        const dialog = viewer(p);
        const live = dialog.getByRole("status");
        await expect.poll(() => live.textContent()).toContain("This screenshot could not be loaded.");
        const retry = dialog.getByRole("button", { name: "Try again" });
        await retry.focus();
        // Repeated failure: the pressed button is replaced, and focus lands on the new one.
        await p.keyboard.press("Enter");
        await expect.poll(() => retry.evaluate((b) => b === document.activeElement)).toBe(true);
        // A held retry, then the reader moves on: a later failure does not take focus back.
        hold = slow.g;
        await p.keyboard.press("Enter");
        await expect.poll(() => live.textContent()).toBe("Loading the screenshot again.");
        await dialog.getByRole("button", { name: "Close" }).focus();
        hold = null;
        slow.go();
        await expect.poll(() => live.textContent()).toContain("could not be loaded");
        expect(await dialog.getByRole("button", { name: "Close" }).evaluate((b) => b === document.activeElement)).toBe(
          true,
        );
        // A retry that succeeds is announced, with the capture's size, and focus stays in the viewer's scroll region.
        mode = "png";
        await retry.focus();
        await p.keyboard.press("Enter");
        await expect.poll(() => live.textContent()).toBe(`The screenshot loaded. ${WIDE} \u00d7 ${TALL} px.`);
        expect(await p.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
      } finally {
        hold = null;
        slow.go();
        await context.close();
      }
    });

    it("says a session that ended, in the dialog and on the card, with one Sign in that returns to the same card", async () => {
      await reset();
      const { p, context } = await open(1280);
      try {
        await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
        mode = "signed-out";
        await opener(p).focus();
        await p.keyboard.press("Enter");
        const dialog = viewer(p);
        await expect
          .poll(() => dialog.getByRole("region").getByText("You have been signed out.").isVisible())
          .toBe(true);
        const signIn = dialog.getByRole("link", { name: "Sign in" });
        expect(await signIn.getAttribute("href")).toBe(
          `/signin?next=${encodeURIComponent("/r/01JCASE0000000000000000000#e1")}`,
        );
        expect(await dialog.getByRole("button", { name: "Try again" }).count()).toBe(0);
        await dialog.getByRole("button", { name: "Close" }).click();
        // The second card's preview, asked for while signed out, says the same and offers the same way back.
        const note = p.locator("#e2 [data-evidence-failed]");
        await p.evaluate(() => {
          const img = document.querySelector("#e2 img[data-evidence-image]") as HTMLImageElement;
          img.setAttribute("src", `${img.getAttribute("src")}&again=1`);
        });
        await expect.poll(() => note.getAttribute("data-evidence-failed")).toBe("signed-out");
        expect(await note.getByRole("link", { name: "Sign in" }).getAttribute("href")).toContain(
          encodeURIComponent("/r/01JCASE0000000000000000000#e2"),
        );
      } finally {
        await context.close();
      }
    });

    it("returns focus to the card's Try again when the preview failed while the viewer was open", async () => {
      await reset();
      const { p, context } = await open(1280);
      try {
        await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
        await opener(p).focus();
        await p.keyboard.press("Enter");
        const dialog = viewer(p);
        await expect.poll(() => dialog.locator("img").isVisible()).toBe(true);
        // The preview's own request now fails behind the dialog, which hides the opener and shows Try again.
        mode = "unavailable";
        await p.evaluate(() => {
          const img = document.querySelector("#e1 img[data-evidence-image]") as HTMLImageElement;
          img.setAttribute("src", `${img.getAttribute("src")}&again=1`);
        });
        await expect.poll(() => p.locator("#e1 [data-evidence-failed]").count()).toBe(1);
        await p.keyboard.press("Escape");
        await expect.poll(() => dialog.count()).toBe(0);
        expect(await p.evaluate(() => document.activeElement?.textContent)).toBe("Try again");
        expect(await p.evaluate(() => document.activeElement?.closest("#e1") !== null)).toBe(true);
      } finally {
        await context.close();
      }
    });

    it("aborts the viewer's request when it closes, and a reopened viewer has one request out, not two", async () => {
      await reset();
      const { p, context } = await open(1280);
      const slow = gate();
      try {
        await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
        const failed: string[] = [];
        p.on("requestfailed", (r) => {
          if (r.url().includes("/a/") && r.failure()?.errorText.includes("ABORTED")) failed.push(r.url());
        });
        const before = requests.length;
        hold = slow.g;
        await opener(p).focus();
        await p.keyboard.press("Enter");
        await expect.poll(() => requests.length).toBe(before + 1);
        await p.keyboard.press("Escape");
        await expect.poll(() => failed.length).toBe(1);
        await p.keyboard.press("Enter");
        await expect.poll(() => requests.length).toBe(before + 2);
        hold = null;
        slow.go();
        await expect.poll(() => viewer(p).locator("img").isVisible()).toBe(true);
        // Nothing else was left running: one abort, one completed request.
        expect(failed.length).toBe(1);
      } finally {
        hold = null;
        slow.go();
        await context.close();
      }
    });

    it("gives up a stalled viewer request after its deadline, and Try again loads once the answer comes", async () => {
      await reset();
      const { p, context } = await open(1280);
      try {
        await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
        await p.evaluate(() => {
          document.querySelector("#e1 a[data-evidence-open]")?.setAttribute("data-deadline-ms", "300");
        });
        delayMs = 600;
        await opener(p).focus();
        await p.keyboard.press("Enter");
        const dialog = viewer(p);
        // The answer arrives past the deadline: the failed-read state with Try again, announced once.
        await expect.poll(() => dialog.getByRole("status").textContent()).toContain("could not be loaded");
        expect(await dialog.getByRole("button", { name: "Try again" }).count()).toBe(1);
        expect(await dialog.locator("img").isVisible()).toBe(false);
        // Try again loads once the route answers promptly.
        delayMs = 0;
        await dialog.getByRole("button", { name: "Try again" }).click();
        await expect.poll(() => dialog.locator("img").isVisible()).toBe(true);
        expect(await dialog.getByText("This screenshot could not be loaded.").count()).toBe(0);
      } finally {
        delayMs = 0;
        await context.close();
      }
    });

    it("gives up when the headers arrive but the capture body stalls", async () => {
      await reset();
      const { p, context } = await open(1280);
      try {
        await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
        await p.evaluate(async () => {
          await navigator.serviceWorker.register("/sw-test.js", { scope: "/" });
          await navigator.serviceWorker.ready;
        });
        await p.reload();
        await p.evaluate(() => {
          const link = document.querySelector("#e1 a[data-evidence-open]");
          link?.setAttribute("data-deadline-ms", "300");
          const href = link?.getAttribute("href") ?? "";
          link?.setAttribute("href", `${href}${href.includes("?") ? "&" : "?"}stallbody=1`);
        });
        await opener(p).scrollIntoViewIfNeeded();
        await opener(p).focus();
        await p.keyboard.press("Enter");
        // Headers resolve at once and the body never comes: the deadline still gives up the request.
        const dialog = viewer(p);
        await expect.poll(() => dialog.getByRole("status").textContent()).toContain("could not be loaded");
        expect(await dialog.getByRole("button", { name: "Try again" }).count()).toBe(1);
      } finally {
        await context.close();
      }
    });

    it("bounds a stalled preview classification, and its Try again reloads the preview", async () => {
      await reset();
      const { p, context } = await open(1280);
      const slow = gate();
      try {
        await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
        await p.evaluate(() => {
          document.querySelector("#e1 a[data-evidence-open]")?.setAttribute("data-deadline-ms", "300");
        });
        hold = slow.g;
        holdImages = false;
        mode = "unavailable";
        await p.evaluate(() => {
          const img = document.querySelector("#e1 img[data-evidence-image]") as HTMLImageElement;
          img.setAttribute("src", `${img.getAttribute("src")}&again=1`);
        });
        // The preview fails fast but its classification stalls: the card still reaches its failed state on a bound.
        const note = p.locator("#e1 [data-evidence-failed]");
        await expect.poll(() => note.getAttribute("data-evidence-failed")).toBe("temporary");
        expect(await note.getByRole("button", { name: "Try again" }).count()).toBe(1);
        hold = null;
        holdImages = true;
        slow.go();
        mode = "png";
        await note.getByRole("button", { name: "Try again" }).click();
        await expect.poll(() => note.count()).toBe(0);
        await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
      } finally {
        hold = null;
        holdImages = true;
        slow.go();
        await context.close();
      }
    });

    it("lets a closed viewer's late answer change nothing after reopen", async () => {
      await reset();
      const { p, context } = await open(1280);
      try {
        await expect.poll(() => p.locator("#e1 img").evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
        const failed: string[] = [];
        p.on("requestfailed", (r) => {
          if (r.url().includes("/a/") && r.failure()?.errorText.includes("ABORTED")) failed.push(r.url());
        });
        delayMs = 2000;
        const before = requests.length;
        const link = opener(p);
        await link.focus();
        await p.keyboard.press("Enter");
        await expect.poll(() => requests.length).toBe(before + 1);
        // Close before anything answers, then reopen while the first answer is still late.
        await p.keyboard.press("Escape");
        await expect.poll(() => failed.length).toBe(1);
        mode = "gone";
        await p.keyboard.press("Enter");
        await expect.poll(() => requests.length).toBe(before + 2);
        // The late first answer changes nothing: the reopened viewer shows its own state's outcome.
        const dialog = viewer(p);
        await expect
          .poll(() => dialog.getByRole("region").getByText("This screenshot is no longer stored.").isVisible())
          .toBe(true);
        expect(await dialog.locator("img").isVisible()).toBe(false);
        expect(failed.length).toBe(1);
      } finally {
        delayMs = 0;
        mode = "png";
        await context.close();
      }
    });

    it("at 360 px scrolls the capture both ways inside the frame, keeps Close in view and does not scroll the page behind", async () => {
      await reset();
      const { p, context } = await open(360);
      try {
        const link = opener(p);
        await link.scrollIntoViewIfNeeded();
        await link.focus();
        await p.keyboard.press("Enter");
        const dialog = viewer(p);
        await expect.poll(() => dialog.locator("img").isVisible()).toBe(true);
        const region = dialog.getByRole("region");
        const sizes = await region.evaluate((r) => ({
          sw: r.scrollWidth,
          cw: r.clientWidth,
          sh: r.scrollHeight,
          ch: r.clientHeight,
        }));
        expect(sizes.sw).toBeGreaterThan(sizes.cw);
        expect(sizes.sh).toBeGreaterThan(sizes.ch);
        await region.focus();
        await p.keyboard.press("ArrowRight");
        await p.keyboard.press("ArrowDown");
        await expect.poll(() => region.evaluate((r) => r.scrollLeft > 0 && r.scrollTop > 0)).toBe(true);
        const box = await dialog.getByRole("button", { name: "Close" }).boundingBox();
        expect(box).not.toBeNull();
        expect(
          (box?.y ?? -1) >= 0 && (box?.y ?? 0) + (box?.height ?? 0) <= 800 && (box?.x ?? 0) + (box?.width ?? 0) <= 360,
        ).toBe(true);
        expect(await dialog.getByText("scrolls both ways").isVisible()).toBe(true);
        // The page behind stays where it was while the capture scrolls.
        const y = await p.evaluate(() => window.scrollY);
        await p.mouse.move(180, 400);
        await p.mouse.wheel(0, 600);
        await expect.poll(() => region.evaluate((r) => r.scrollTop)).toBeGreaterThan(0);
        expect(await p.evaluate(() => window.scrollY)).toBe(y);
        expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      } finally {
        await context.close();
      }
    });

    for (const theme of ["light", "dark"] as const)
      for (const width of [360, 1280])
        it(`passes the accessibility rules, contrast included, with the viewer open (${theme}, ${width} px)`, async () => {
          await reset();
          const { p, context } = await open(width, theme);
          try {
            await opener(p).focus();
            await p.keyboard.press("Enter");
            const dialog = viewer(p);
            await expect.poll(() => dialog.locator("img").isVisible()).toBe(true);
            console.log(
              "GEO",
              JSON.stringify(
                await p.evaluate(() => {
                  const f = document.querySelector("dialog [class*=border-t] p") as HTMLElement;
                  const r = f.getBoundingClientRect();
                  const d = (document.querySelector("dialog") as HTMLElement).getBoundingClientRect();
                  const at = document.elementFromPoint(r.x + 5, r.y + r.height / 2) as HTMLElement | null;
                  return {
                    f: [r.x, r.y, r.width, r.height],
                    d: [d.x, d.y, d.width, d.height],
                    vh: innerHeight,
                    vw: innerWidth,
                    at: at?.outerHTML.slice(0, 80),
                  };
                }),
              ),
            );
            await p.addScriptTag({ path: AXE });
            expect(problems(await scan(p))).toEqual([]);
            // The words a reader needs are all there and named.
            expect(await dialog.getByRole("button", { name: "Close" }).isVisible()).toBe(true);
            expect(await dialog.getByRole("link", { name: "Download the screenshot (PNG)" }).isVisible()).toBe(true);
          } finally {
            await context.close();
          }
        });

    it("opens the second card's capture with that card's id in the heading", async () => {
      await reset();
      const { p, context } = await open(1280);
      try {
        const link = opener(p, "e2");
        await expect.poll(() => link.count()).toBe(1);
        await link.focus();
        await p.keyboard.press("Enter");
        const dialog = viewer(p);
        await expect.poll(() => dialog.isVisible()).toBe(true);
        expect(await dialog.getByRole("heading").textContent()).toContain("E2 · ");
        expect(requests.some((r) => r.url.includes("walk-2") || r.url.includes("dddd"))).toBe(true);
      } finally {
        await context.close();
      }
    });
  },
);
