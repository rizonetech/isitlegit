import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normaliseScreenshot, openTextReader } from "../../scripts/glimmer/source-pages.ts";
import { jpegSize } from "../../src/vision/page-screen.ts";

// scripts/glimmer/source-pages.ts (D03 T04 §5): a dataset's image becomes a JPEG the store accepts, and its HTML gives
// the text a viewer would see.

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

  it("fetches nothing a page names", async () => {
    const text = await reader.visibleText(
      `<body><img src="http://example.invalid/x.png" alt="logo"><iframe src="http://example.invalid/"></iframe>ok</body>`,
    );
    expect(text).toBe("ok");
  });
});
