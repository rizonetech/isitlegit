import { describe, expect, it } from "vitest";
import { openRenderer, RefusedAddress, RenderTimeout } from "../../scripts/glimmer/render.ts";
import { jpegSize } from "../../src/vision/page-screen.ts";
import {
  dripOpen,
  fixture,
  origin,
  renderer,
  secretHits,
  useRenderFixture,
  words,
} from "./helpers/glimmer-render-fixture.ts";

// scripts/glimmer/render.ts (D03 T04 §6): `renderPage` isolates each page, refuses non-public addresses, and stops
// at its limit. Split from glimmer-render.test.ts so the files run on parallel workers.
useRenderFixture();
describe("renderPage", () => {
  it("renders a page with its screenshot, text and form flags", async () => {
    const shot = await renderer.render(`${origin}/page`);
    expect(shot.status).toBe(200);
    expect(shot.text).toContain("Welcome to the example service");
    expect(jpegSize(shot.screenshot)?.width).toBe(1280);
    expect(shot.has_login_form).toBe(true);
    expect(shot.has_payment_form).toBe(false);
  });

  it("reads a page whose elements carry DOM methods of their own that return nothing", async () => {
    const shot = await renderer.render(`${origin}/masked`);
    expect(shot.text).toContain("Welcome to the example service");
    expect(shot.text).not.toContain("unseen");
    expect([shot.has_login_form, shot.consentWall, shot.captcha]).toEqual([true, false, false]);
  });

  it("reads every page through methods the page cannot replace, its prototypes and globals included", async () => {
    // Its text, its form, and the wall drawn over it are all read, whatever the page did to the built-ins.
    const shot = await renderer.render(`${origin}/masked-proto`);
    expect(shot.text).toContain("Welcome to the example service");
    expect(shot.text).not.toContain("unseen");
    expect(shot.has_login_form).toBe(true);
    expect(shot.overlays).toContain("Are you a human?");
  });

  it("reads a page with no root element left as a short page, not a failed capture", async () => {
    const empty = await renderer.render(`${origin}/no-root`);
    expect(empty.text.trim()).toBe("");
  });

  it("sets the form flags from visible fields only", async () => {
    const flags = async (path: string) => {
      const { has_login_form, has_payment_form } = await renderer.render(`${origin}${path}`);
      return [has_login_form, has_payment_form];
    };
    expect(await flags("/username")).toEqual([true, false]);
    expect(await flags("/email")).toEqual([true, false]);
    expect(await flags("/hidden")).toEqual([false, false]);
    expect(await flags("/card")).toEqual([false, true]);
    expect(await flags("/payframe")).toEqual([false, true]);
  });

  it("refuses a redirect to a loopback or private address", async () => {
    fixture.serverHits = [];
    await expect(renderer.render(`${origin}/to-loopback`)).rejects.toThrow();
    expect(secretHits).toBe(0);
    await expect(renderer.render(`${origin}/to-private`)).rejects.toBeInstanceOf(RefusedAddress);
    // The second hop of a chain is checked as the first is.
    await expect(renderer.render(`${origin}/hop-chain`)).rejects.toThrow();
    expect(secretHits).toBe(0);
    expect(renderer.openContexts()).toBe(0);
    // An allowed redirect is still followed, and its target comes back through the guard.
    const followed = await renderer.render(`${origin}/hop`);
    expect([followed.status, new URL(followed.finalUrl).pathname]).toEqual([200, "/page"]);
    expect(fixture.serverHits).toEqual(expect.arrayContaining(["/to-loopback", "/hop", "/page"]));
  });

  it("hands the browser a compressed body decoded", async () => {
    expect((await renderer.render(`${origin}/gzip`)).text).toContain(`Compressed: ${words}`);
  });

  it("reads a sign-in form and its text from a cross-origin frame and the frame inside it", async () => {
    const shot = await renderer.render(`${origin}/xframe-login`);
    expect(shot.has_login_form).toBe(true);
    expect(shot.text).toContain("Nested sign-in text for the example service");
  });

  it("sends no WebRTC traffic outside the proxy", async () => {
    fixture.stunPackets = 0;
    await renderer.render(`${origin}/webrtc`);
    expect(fixture.stunPackets).toBe(0);
  });

  it("denies permissions, refuses WebSockets and keeps nothing between pages", async () => {
    expect((await renderer.render(`${origin}/geo`)).text).toMatch(/GEO-DENIED-1/);
    fixture.upgrades = 0;
    expect((await renderer.render(`${origin}/ws`)).text).toContain("WS-CLOSED");
    expect(fixture.upgrades).toBe(0);
    await renderer.render(`${origin}/storage-set`);
    expect((await renderer.render(`${origin}/storage-get`)).text).toContain("STORED-null-none");
  });

  it("writes no download, closes a pop-up and registers no service worker", async () => {
    expect((await renderer.render(`${origin}/download`)).downloadsWritten).toBe(0);
    expect((await renderer.render(`${origin}/popup`)).popupsClosed).toBeGreaterThanOrEqual(1);
    expect((await renderer.render(`${origin}/worker`)).serviceWorkers).toBe(0);
  });

  it("stops the whole render at its limit and closes the context", async () => {
    const quick = await openRenderer({ allowOrigins: [origin], limitMs: 1_500 });
    // The browser starts first, under its own bound, so the clock below times the render alone.
    await quick.render(`${origin}/page`).catch(() => undefined);
    const started = Date.now();
    await expect(quick.render(`${origin}/slow`)).rejects.toBeInstanceOf(RenderTimeout);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(quick.openContexts()).toBe(0);
    await quick.close();
  }, 20_000);

  it("ends a render's outbound connections with the render", async () => {
    const quick = await openRenderer({ allowOrigins: [origin], limitMs: 2_500 });
    await quick.render(`${origin}/page`);
    await expect(quick.render(`${origin}/drip`)).rejects.toBeInstanceOf(RenderTimeout);
    await new Promise((done) => setTimeout(done, 300));
    expect(dripOpen).toBe(0);
    await quick.close();
  }, 30_000);

  it("reads nothing from a frame no one can see", async () => {
    const shot = await renderer.render(`${origin}/hidden-frame`);
    expect(shot.has_login_form).toBe(false);
    expect(shot.text).not.toContain("Welcome");
    const away = await renderer.render(`${origin}/offscreen-frame`);
    expect(away.has_login_form).toBe(false);
    expect(away.text).not.toContain("Welcome");
    // Past the 1280 by 2000 pixels the screenshot keeps, to the right or below.
    const far = await renderer.render(`${origin}/far-frame`);
    expect(far.has_login_form).toBe(false);
    expect(far.text).not.toContain("Welcome");
  });

  it("judges a page that moves on by the document captured", async () => {
    const shot = await renderer.render(`${origin}/moves-on`);
    expect([shot.status, new URL(shot.finalUrl).pathname]).toEqual([404, "/missing"]);
  });

  it("gives up on a page that stops answering and goes on with the next", async () => {
    const quick = await openRenderer({ allowOrigins: [origin], limitMs: 3_000 });
    // The browser starts first, under its own bound, so the clock below times the render alone.
    await quick.render(`${origin}/page`).catch(() => undefined);
    const started = Date.now();
    await expect(quick.render(`${origin}/hang`)).rejects.toBeInstanceOf(RenderTimeout);
    // The render's 3 seconds and at most 5 more for the context's close.
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(quick.openContexts()).toBe(0);
    expect((await quick.render(`${origin}/page`)).status).toBe(200);
    await quick.close();
  }, 40_000);
});
