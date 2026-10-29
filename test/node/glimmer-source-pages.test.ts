import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bounded,
  decodeHtml,
  normaliseScreenshot,
  openTextReader,
  PageTimeout,
  passingRenderFault,
} from "../../scripts/glimmer/source-pages.ts";
import { jpegSize } from "../../src/vision/page-screen.ts";

// scripts/glimmer/source-pages.ts (D03 T04 §5): a dataset's image becomes a JPEG the store accepts, and its HTML gives
// the text a viewer would see.

describe("decodeHtml", () => {
  it("reads a page in the encoding it declares, else UTF-8", () => {
    // 「お問合せ」 in Shift_JIS, and Привет in windows-1251.
    const sjis = Uint8Array.from([0x82, 0xa8, 0x96, 0xe2, 0x8d, 0x87, 0x82, 0xb9]);
    const meta = new TextEncoder().encode('<meta charset="Shift_JIS"><p>');
    expect(decodeHtml(Uint8Array.from([...meta, ...sjis]))).toBe('<meta charset="Shift_JIS"><p>お問合せ');
    const cyr = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const equiv = new TextEncoder().encode(
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">',
    );
    expect(decodeHtml(Uint8Array.from([...equiv, ...cyr]))).toContain("Привет");
    expect(decodeHtml(new TextEncoder().encode("<p>café</p>"))).toBe("<p>café</p>");
    expect(decodeHtml(new TextEncoder().encode('<meta charset="no-such"><p>é'))).toBe('<meta charset="no-such"><p>é');
  });
});

describe("bounded", () => {
  it("gives up on a browser call that never answers, and reports one that finishes or fails", async () => {
    const started = Date.now();
    expect(await bounded(new Promise(() => undefined), 200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await bounded(Promise.resolve(1))).toBe(true);
    expect(await bounded(Promise.reject(new Error("closed")))).toBe(false);
  });
});

describe("normaliseScreenshot", () => {
  it("turns a full-page PNG into a 1280 by 2000 JPEG that decodes", async () => {
    const png = await sharp({ create: { width: 2560, height: 6000, channels: 4, background: "#3366cc80" } })
      .png()
      .toBuffer();
    const out = await normaliseScreenshot(new Uint8Array(png));
    expect(jpegSize(out)).toEqual({ width: 1280, height: 2000 });
    const decoded = await sharp(out, { failOn: "warning" }).raw().toBuffer({ resolveWithObject: true });
    expect([decoded.info.width, decoded.info.height]).toEqual([1280, 2000]);
  });

  it("keeps a small image's size and refuses one that does not decode", async () => {
    const small = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#fff" } })
      .jpeg()
      .toBuffer();
    expect(jpegSize(await normaliseScreenshot(new Uint8Array(small)))).toEqual({ width: 400, height: 300 });
    await expect(normaliseScreenshot(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))).rejects.toThrow(
      /does not decode/,
    );
  });
});

describe("visibleText", () => {
  let reader: Awaited<ReturnType<typeof openTextReader>>;
  beforeAll(async () => {
    reader = await openTextReader();
    // The browser starts lazily on the first page; it starts here, inside the hook's 60 seconds, so no test pays
    // Chromium's start-up on a slow CI runner (three runs on 2026-10-28 timed out at 15 seconds that way).
    await reader.renderHtml("<p>start the browser before the tests</p>");
  }, 60_000);
  afterAll(async () => {
    await reader?.close();
  });

  it("keeps what a viewer sees and drops everything else", async () => {
    const html = `<!doctype html><html><head><style>.x{color:red}</style><title>t</title></head><body>
      <h1>Sign in to   Standard &amp; Bank</h1>
      <!-- a comment -->
      <script>document.write("injected")</script>
      <form><label>Username</label><input name="u"><label>Password</label><input type="password"></form>
      <p hidden>hidden attribute</p>
      <div style="display:none">display none</div>
      <div style="visibility:hidden">visibility hidden</div>
      <p>It&#x27;s   safe</p>
    </body></html>`;
    const text = await reader.visibleText(html);
    for (const kept of ["Sign in to Standard & Bank", "Username", "Password", "It's safe"])
      expect(text).toContain(kept);
    for (const dropped of [
      "injected",
      "a comment",
      "color:red",
      "hidden attribute",
      "display none",
      "visibility hidden",
    ])
      expect(text).not.toContain(dropped);
    expect(text).not.toMatch(/ {2}/);
  });

  it("renders HTML to a screenshot the store accepts, with its text", async () => {
    const out = await reader.renderHtml("<body><h1>Account sign in</h1><p>Welcome back</p></body>");
    expect(jpegSize(out.screenshot)?.width).toBe(1280);
    expect(out.text).toBe("Account sign in\nWelcome back");
  });

  it("sets the form flags as the screener's prompt defines them", async () => {
    const flags = async (body: string) => {
      const { has_login_form, has_payment_form } = await reader.renderHtml(`<body>${body}</body>`);
      return [has_login_form, has_payment_form];
    };
    expect(await flags('<label for="u">Username</label><input id="u">')).toEqual([true, false]);
    expect(await flags('<input type="email" placeholder="you@example.com">')).toEqual([true, false]);
    expect(await flags('<input type="password">')).toEqual([true, false]);
    expect(await flags('<input name="q" placeholder="Search">')).toEqual([false, false]);
    expect(await flags('<input type="hidden" name="username"><input type="password" style="display:none">')).toEqual([
      false,
      false,
    ]);
    expect(await flags('<input autocomplete="cc-number"><input autocomplete="cc-csc">')).toEqual([false, true]);
    expect(await flags('<iframe src="https://js.stripe.com/v3/elements" width="300" height="80"></iframe>')).toEqual([
      false,
      true,
    ]);
    expect(await flags("<p>Just text</p>")).toEqual([false, false]);
  });

  it("fails a page that never finishes within its deadline, and renders the next page on a fresh browser", async () => {
    const quick = await openTextReader({ pageMs: 1_500 });
    // Ten million layout boxes: the renderer is still laying them out when the deadline passes.
    const huge = `<div>${"<span>word </span>".repeat(2_000_000)}</div>`;
    const started = Date.now();
    await expect(quick.renderHtml(huge)).rejects.toBeInstanceOf(PageTimeout);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await quick.renderHtml("<p>The next page renders on a new browser</p>")).text).toBe(
      "The next page renders on a new browser",
    );
    await quick.close();
  }, 60_000);

  it("replaces a browser that died under several pages once, not once a page", async () => {
    const quick = await openTextReader({ pageMs: 1_500 });
    const huge = `<div>${"<span>word </span>".repeat(2_000_000)}</div>`;
    const results = await Promise.allSettled([quick.renderHtml(huge), quick.renderHtml(huge), quick.renderHtml(huge)]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect((await quick.renderHtml("<p>After the timeouts one new browser renders</p>")).text).toBe(
      "After the timeouts one new browser renders",
    );
    expect(quick.launches()).toBe(2);
    await quick.close();
  }, 90_000);

  it("ends a browser that will not close, so the importer behind it can exit", async () => {
    // The marked browsers alive now; other readers on the host may start their own, so only these are followed.
    const marked = () => {
      try {
        return new Set(
          execFileSync("pgrep", ["-f", "--", "--glimmer-reader="]).toString().trim().split("\n").filter(Boolean),
        );
      } catch {
        return new Set<string>(); // pgrep exits 1 when nothing matched
      }
    };
    const before = marked();
    const own = await openTextReader({ closeBrowser: () => new Promise(() => undefined) });
    await own.renderHtml("<p>start this reader's browser</p>");
    const mine = [...marked()].filter((pid) => !before.has(pid));
    expect(mine.length).toBeGreaterThan(0);
    const started = Date.now();
    await own.close();
    expect(Date.now() - started).toBeLessThan(8_000);
    await new Promise((done) => setTimeout(done, 500));
    const after = marked();
    expect(mine.filter((pid) => after.has(pid))).toEqual([]);
  }, 30_000);

  it("retries pages caught in a browser crash on one replacement browser", async () => {
    // A long page deadline: on a loaded machine the three slow pages could pass the default 30 seconds, and a page
    // past its deadline replaces the browser too, which is another path than the crash this test is about.
    const own = await openTextReader({ pageMs: 120_000 });
    await own.renderHtml("<p>warm the first browser up</p>");
    const slow = (n: number) => `<p>page ${n}</p><div>${"<span>word </span>".repeat(150_000)}</div>`;
    const pages = [1, 2, 3].map((n) => own.renderHtml(slow(n)));
    await new Promise((done) => setTimeout(done, 300));
    await own.dropBrowser();
    const results = await Promise.all(pages);
    expect(results.map((r) => r.text.split("\n")[0])).toEqual(["page 1", "page 2", "page 3"]);
    expect(own.launches()).toBe(2);
    await own.close();
  }, 90_000);

  it("shows no text for a page whose body or root is hidden", async () => {
    expect(
      (await reader.renderHtml('<body style="display:none"><p>Hidden phishing content long enough</p></body>')).text,
    ).toBe("");
    expect(
      (await reader.renderHtml('<html style="visibility:hidden"><body><p>Also hidden text here</p></body></html>'))
        .text,
    ).toBe("");
  });

  it("leaves out text and fields an ancestor hides with opacity 0 or puts off the page", async () => {
    const out = await reader.renderHtml(
      "<p>The page a viewer actually sees here</p>" +
        '<div style="opacity:0"><p>hidden credential text over twenty characters</p><input type="password"></div>' +
        '<div style="position:absolute;left:-9999px;top:-9999px"><p>off the page entirely, never seen</p><input name="card_number"></div>',
    );
    expect(out.text).toBe("The page a viewer actually sees here");
    expect(out.has_login_form).toBe(false);
    expect(out.has_payment_form).toBe(false);
  });

  it("counts a card field named as one, without an autocomplete hint", async () => {
    const flags = async (html: string) => (await reader.renderHtml(html)).has_payment_form;
    expect(await flags('<label>Card number <input name="card_number"></label>')).toBe(true);
    expect(await flags('<input name="cvv" placeholder="CVV">')).toBe(true);
    expect(await flags('<input placeholder="MM / YY">')).toBe(true);
    expect(await flags('<input name="username"><input type="hidden" name="card_number">')).toBe(false);
  });

  it("stays on a page whose meta refresh points elsewhere", async () => {
    const out = await reader.renderHtml(
      '<meta http-equiv="refresh" content="0;url=https://elsewhere.example/"><p>Your parcel is waiting for collection</p>',
    );
    expect(out.text).toBe("Your parcel is waiting for collection");
  });

  it("captures only the kept 1280 by 2000 pixels of a very tall page", async () => {
    const out = await reader.renderHtml('<body><h1>Top</h1><div style="height:60000px"></div><p>Bottom</p></body>');
    expect(jpegSize(out.screenshot)).toEqual({ width: 1280, height: 2000 });
    expect(out.text).toContain("Top");
  });

  it("tries a page once more when the capture failed, and only that fault", () => {
    expect(
      passingRenderFault(
        new Error("page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot"),
      ),
    ).toBe(true);
    expect(passingRenderFault(new Error("page.setContent: Timeout 10000ms exceeded"))).toBe(false);
    expect(passingRenderFault(undefined)).toBe(false);
  });

  it("opens a new browser when the one it had is gone", async () => {
    const own = await openTextReader();
    // The browser starts lazily, so a page is rendered first: the close then has a browser to close.
    expect((await own.renderHtml("<p>Before the restart the reader renders</p>")).text).toBe(
      "Before the restart the reader renders",
    );
    await own.close();
    expect((await own.renderHtml("<p>After a restart the reader still renders</p>")).text).toBe(
      "After a restart the reader still renders",
    );
    expect(own.launches()).toBe(2);
    await own.close();
  });

  it("sends no request for anything a page names, even to a server that would answer", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end("x");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const out = await reader.renderHtml(
        `<link rel=stylesheet href="${origin}/a.css"><img src="${origin}/b.png"><iframe src="${origin}/c"></iframe>` +
          `<video src="${origin}/d.mp4"></video><p style="background:url(${origin}/e.png)">Inert page text here</p>`,
      );
      expect(out.text).toContain("Inert page text here");
      expect(requests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });

  it("fetches nothing a page names", async () => {
    const text = await reader.visibleText(
      `<body><img src="http://example.invalid/x.png" alt="logo"><iframe src="http://example.invalid/"></iframe>ok</body>`,
    );
    expect(text).toBe("ok");
  });
});
