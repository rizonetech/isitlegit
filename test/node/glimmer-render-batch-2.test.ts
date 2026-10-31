import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserFault,
  HttpStatus,
  openRenderer,
  RenderTimeout,
  readJournal,
  recheckStored,
  reopenExcluded,
  runBatch,
  type UrlList,
} from "../../scripts/glimmer/render.ts";
import { openStore, type StoredPage } from "../../scripts/glimmer/store.ts";
import { fixture, origin, renderer, useRenderFixture, words } from "./helpers/glimmer-render-fixture.ts";

// scripts/glimmer/render.ts (D03 T04 §6): the resumable batch run, which never stores a page twice, never stores a wall,
// and records why each page was left out. Its second half, split from glimmer-render-batch.test.ts so the files run on parallel workers.
useRenderFixture();

describe("the batch run", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glimmer-render-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const list = (paths: string[]): UrlList => ({
    name: "benign-sa",
    licence: "own",
    southAfrica: true,
    entries: paths.map((path) => ({ url: `${origin}${path}`, kind: "login", brand: "Example Bank", also: [] })),
  });

  it("reads no wall into a page from a hidden element's pseudo-element", async () => {
    const shot = await renderer.render(`${origin}/wall-pseudo-hidden`);
    expect(shot.overlays).not.toContain("Press & Hold");
  });

  it("reads a picture covering the page by OCR: a wall's words refuse it, an unreadable one leaves it unstored", async () => {
    const walled = await openRenderer({ allowOrigins: [origin], ocr: async () => "Press & Hold to confirm" });
    const blind = await openRenderer({
      allowOrigins: [origin],
      ocr: async () => {
        throw new Error("no OCR engine");
      },
    });
    const hero = await openRenderer({ allowOrigins: [origin], ocr: async () => "Summer collection" });
    try {
      const run = async (render: typeof renderer.render, name: string) => {
        const store = openStore(join(dir, name));
        const journal = join(dir, `${name}.jsonl`);
        const result = await runBatch({ list: list(["/wall-flow-image"]), store, journal, render });
        return { result, reason: readJournal(journal).at(-1)?.reason };
      };
      expect(await run(walled.render, "walled")).toMatchObject({ result: { stored: 0 }, reason: "a challenge page" });
      expect((await run(blind.render, "blind")).reason).toMatch(/picture covering the page could not be read/);
      expect((await run(hero.render, "hero")).result.stored).toBe(1);
    } finally {
      await Promise.all([walled.close(), blind.close(), hero.close()]);
    }
  }, 60_000);

  it("leaves text clipped away out, sees a CAPTCHA checkbox, and passes a hidden closed widget", async () => {
    expect((await renderer.render(`${origin}/clipped-text`)).text).not.toContain("Welcome to the example service");
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    await runBatch({
      list: list(["/captcha-widget", "/closed-hidden"]),
      store,
      journal,
      render: renderer.render,
      concurrency: 1,
    });
    const outcome = (path: string) =>
      readJournal(journal)
        .filter((e) => e.url === `${origin}${path}`)
        .at(-1);
    expect(outcome("/captcha-widget")?.reason).toBe("a CAPTCHA frame");
    expect(outcome("/closed-hidden")?.event).toBe("stored");
  });

  it("calls a browser that died under a page the browser's fault, never the page's", async () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const dying = await openRenderer({
      allowOrigins: [origin],
      launch: async (launchOptions) => {
        browser = await chromium.launch(launchOptions);
        return browser;
      },
    });
    try {
      const rendering = dying.render(`${origin}/slow`);
      setTimeout(() => void browser?.close(), 1_000);
      await expect(rendering).rejects.toBeInstanceOf(BrowserFault);
    } finally {
      await dying.close();
    }
  }, 40_000);

  it("refuses a page with a closed shadow root, whose contents no reader can see", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const result = await runBatch({ list: list(["/wall-closed"]), store, journal, render: renderer.render });
    expect(result).toMatchObject({ stored: 0, excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toMatch(/closed shadow root/);
  });

  it("refuses a capture whose text changed between its readings though its title held", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const result = await runBatch({ list: list(["/text-swap"]), store, journal, render: renderer.render });
    expect(result).toMatchObject({ stored: 0, excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toBe("the page kept changing while it was captured");
  });

  it("counts a frame's fields only where the screenshot shows them, and reads shadow roots", async () => {
    for (const path of ["/frame-clipped", "/frame-overflow", "/form-below", "/shadow-clipped", "/form-covered"])
      expect((await renderer.render(`${origin}${path}`)).has_login_form, path).toBe(false);
    // A frame drawn at half size still shows the field its own coordinates place below the scaled-down box's end.
    expect((await renderer.render(`${origin}/frame-scaled`)).has_login_form).toBe(true);
    const shadow = await renderer.render(`${origin}/shadow-form`);
    expect(shadow.has_login_form).toBe(true);
    expect(shadow.text).toContain("Shadow sign-in words");
  });

  it("finishes a removal whose intent was written before the page went", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    await runBatch({ list: list(["/page"]), store, journal, render: renderer.render });
    const page = store.manifest()[0] as StoredPage;
    writeFileSync(
      `${journal}.removing.json`,
      JSON.stringify({ id: page.id, url: page.url, reason: "a challenge page (found on a recheck)" }),
    );
    recheckStored(store, journal);
    expect(store.manifest()).toHaveLength(0);
    expect(readJournal(journal).filter((e) => e.event === "excluded")).toHaveLength(1);
  });

  it("leaves a legacy page unassessed, and renders it again when asked", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const shot = await renderer.render(`${origin}/page`);
    const legacy = await store.putPage("benign-test", {
      screenshot: shot.screenshot,
      text: shot.text,
      origin: "benign",
      licence: "test",
      host: null,
      template: null,
      south_africa: false,
      labels: { lure: false, lure_type: "none", has_login_form: true, has_payment_form: false },
      label_source: { lure: "ground-truth", lure_type: "ground-truth", has_login_form: "dom", has_payment_form: "dom" },
      redacted: false,
      url: `${origin}/page`,
    });
    expect(recheckStored(store, journal).unassessed).toEqual([legacy]);
    const again = recheckStored(store, journal, { rerenderLegacy: true });
    expect(again.rerendered).toEqual([legacy]);
    // Each recheck is a run of its own in the journal, so its events never extend a render run's time.
    expect(readJournal(journal).map((e) => e.event)).toEqual(["run", "run", "excluded", "reopened"]);
    // The next run renders it again, now with its evidence.
    const result = await runBatch({ list: list(["/page"]), store, journal, render: renderer.render });
    expect(result.stored).toBe(1);
    expect(store.manifest()[0]?.evidence).toBeDefined();
  });

  it("audits a stored page by its complete evidence, and leaves a legacy or partial record unassessed", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const shot = await renderer.render(`${origin}/page`);
    const full = { captcha: false, consentWall: false, challengeCover: false, wall: false };
    const put = (text: string, evidence?: Record<string, unknown>) =>
      store.putPage("benign-test", {
        screenshot: shot.screenshot,
        text,
        origin: "benign",
        licence: "test",
        host: null,
        template: null,
        south_africa: false,
        labels: { lure: false, lure_type: "none", has_login_form: false, has_payment_form: false },
        label_source: {
          lure: "ground-truth",
          lure_type: "ground-truth",
          has_login_form: "dom",
          has_payment_form: "dom",
        },
        redacted: false,
        url: `${origin}/${text.length}`,
        ...(evidence ? { evidence: evidence as never } : {}),
      });
    const overlaid = await put(`${words} one`, { title: "Shop", overlays: "Access denied", ...full });
    const consent = await put(`${words} two`, { title: "Shop", overlays: "", ...full, consentWall: true });
    const clean = await put(`${words} three`, { title: "Shop", overlays: "", ...full });
    const legacyWall = await put(`${words} Press & Hold`);
    const legacy = await put(`${words} four`);
    const partial = await put(`${words} five`, { title: "Shop", overlays: "" });
    const audit = recheckStored(store, journal);
    expect(audit.removed.sort()).toEqual([overlaid, consent, legacyWall].sort());
    expect(audit.unassessed.sort()).toEqual([legacy, partial].sort());
    expect(store.manifest().map((p) => p.id)).toContain(clean);
  });

  it("lists a damaged page instead of passing it, and finishes a removal a stop interrupted", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    await runBatch({ list: list(["/page", "/frame-login"]), store, journal, render: renderer.render, concurrency: 1 });
    const [first, second] = store.manifest().map((p) => p.id) as [string, string];
    const shot = await renderer.render(`${origin}/page`);
    const third = await store.putPage("benign-test", {
      screenshot: shot.screenshot,
      text: "a third benign page",
      origin: "benign",
      licence: "test",
      host: null,
      template: null,
      south_africa: false,
      labels: { lure: false, lure_type: "none", has_login_form: false, has_payment_form: false },
      label_source: { lure: "ground-truth", lure_type: "ground-truth", has_login_form: "dom", has_payment_form: "dom" },
      redacted: false,
    });
    writeFileSync(join(dir, "store", "pages", first, "text.txt"), "altered");
    writeFileSync(join(dir, "store", "pages", third, "meta.json"), "{ not json");
    const audit = recheckStored(store, journal);
    expect(audit.damaged.sort()).toEqual([first, third].sort());
    expect(audit.checked).toBe(1);
    // A stop after the page went but before its exclusion was written: the next recheck writes it, once.
    const url = store.manifest({ tolerant: true }).find((p) => p.id === second)?.url as string;
    writeFileSync(
      `${journal}.removing.json`,
      JSON.stringify({ id: second, url, reason: "a challenge page (found on a recheck)" }),
    );
    store.removePage(second);
    recheckStored(store, journal);
    recheckStored(store, journal);
    const lines = readJournal(journal).filter((e) => e.url === url && e.event === "excluded");
    expect(lines).toHaveLength(1);
    expect(existsSync(`${journal}.removing.json`)).toBe(false);
  });

  it("renders an exclusion a renderer fault made again once it is reopened, and nothing else", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const fault = async () => {
      throw new Error("page.evaluate: TypeError: Cannot read properties of undefined (reading 'width')");
    };
    await runBatch({ list: list(["/page"]), store, journal, render: fault });
    await runBatch({
      list: list(["/b"]),
      store,
      journal,
      render: async () => {
        throw new HttpStatus(404);
      },
    });
    // Skipped while excluded; the fault's exclusion alone is reopened, its record kept.
    expect(await runBatch({ list: list(["/page"]), store, journal, render: renderer.render })).toMatchObject({
      skipped: 1,
    });
    expect(reopenExcluded(journal, /page\.evaluate: TypeError/)).toEqual([`${origin}/page`]);
    expect(readJournal(journal).filter((e) => e.event === "excluded")).toHaveLength(2);
    expect(await runBatch({ list: list(["/page", "/b"]), store, journal, render: renderer.render })).toMatchObject({
      stored: 1,
      skipped: 1,
    });
    // A stored page is never reopened.
    expect(reopenExcluded(journal, /./)).toEqual([`${origin}/b`]);
  });

  it("records a second URL that renders the same page as excluded, not stored twice", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const same = await renderer.render(`${origin}/page`);
    const result = await runBatch({
      list: list(["/one", "/two"]),
      store,
      journal,
      render: async () => same,
      concurrency: 1,
    });
    expect(result).toMatchObject({ stored: 1, excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toBe(`the same page as ${origin}/one`);
    expect(store.manifest()).toHaveLength(1);
  });

  it("retries a connection the server dropped, through the real renderer", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    expect(await runBatch({ list: list(["/reset"]), store, journal, render: renderer.render })).toMatchObject({
      retry: 1,
    });
  });

  it("retries a passing network failure and a 429, and excludes a page after its third try", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const throwing = (error: Error) => async () => {
      throw error;
    };
    const reset = throwing(new Error("page.goto: net::ERR_CONNECTION_RESET at https://x/"));
    expect(await runBatch({ list: list(["/r"]), store, journal, render: reset })).toMatchObject({ retry: 1 });
    expect(await runBatch({ list: list(["/q"]), store, journal, render: throwing(new HttpStatus(429)) })).toMatchObject(
      {
        retry: 1,
      },
    );
    const timeout = throwing(new RenderTimeout("the render passed 20 seconds"));
    const urls = list(["/t"]);
    expect(await runBatch({ list: urls, store, journal, render: timeout })).toMatchObject({ retry: 1 });
    expect(await runBatch({ list: urls, store, journal, render: timeout })).toMatchObject({ retry: 1 });
    expect(await runBatch({ list: urls, store, journal, render: timeout })).toMatchObject({ excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toBe("the render passed 20 seconds (3 tries)");
    expect(await runBatch({ list: urls, store, journal, render: timeout })).toMatchObject({ skipped: 1 });
  });

  it("repairs a truncated journal and retries a 503 once", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    writeFileSync(
      journal,
      `${JSON.stringify({ url: "https://a.example/", event: "excluded", at: "x" })}\n{"url":"https://b.exa`,
    );
    expect(readJournal(journal)).toHaveLength(1);
    expect(readFileSync(journal, "utf-8").endsWith("}\n")).toBe(true);
    fixture.failing503 = 1;
    const urls = list(["/flaky"]);
    const first = await runBatch({ list: urls, store, journal, render: renderer.render });
    expect(first, JSON.stringify(readJournal(journal).at(-1))).toMatchObject({ retry: 1 });
    expect(await runBatch({ list: urls, store, journal, render: renderer.render })).toMatchObject({ stored: 1 });
  });
});
