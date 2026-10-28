import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeHtml, normaliseScreenshot, openTextReader, PageTimeout } from "../../scripts/glimmer/source-pages.ts";
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

  it("opens a new browser when the one it had is gone", async () => {
    const own = await openTextReader();
    await own.close();
    expect((await own.renderHtml("<p>After a restart the reader still renders</p>")).text).toBe(
      "After a restart the reader still renders",
    );
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
