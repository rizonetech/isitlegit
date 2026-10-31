import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assessCapture,
  evidenceOf,
  HttpStatus,
  openRenderer,
  type Reading,
  readingsAgree,
  readJournal,
  recheckStored,
  renderReceipt,
  runBatch,
  type UrlList,
} from "../../scripts/glimmer/render.ts";
import { openStore, type StoredPage } from "../../scripts/glimmer/store.ts";
import {
  fixture,
  frameOrigin,
  origin,
  renderAll,
  renderer,
  useRenderFixture,
  words,
} from "./helpers/glimmer-render-fixture.ts";

// scripts/glimmer/render.ts (D03 T04 §6): the resumable batch run, which never stores a page twice, never stores a wall,
// and records why each page was left out. Split from glimmer-render.test.ts so the files run on parallel workers.
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

  it("never excludes a page for three failed starts in a row, and stores it once the browser starts", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    for (let i = 0; i < 3; i++) {
      const broken = await openRenderer({
        launch: async () => {
          throw new Error("no browser");
        },
      });
      expect(await runBatch({ list: list(["/page"]), store, journal, render: broken.render })).toMatchObject({
        retry: 1,
        excluded: 0,
      });
      await broken.close();
    }
    expect(await runBatch({ list: list(["/page"]), store, journal, render: renderer.render })).toMatchObject({
      stored: 1,
    });
    expect(readJournal(journal).some((e) => e.event === "excluded")).toBe(false);
  });

  it("retries a page whose browser could not start, never excluding it for the browser's fault", async () => {
    const broken = await openRenderer({
      launch: async () =>
        ({
          newContext: async () => {
            throw new Error("no context");
          },
          close: async () => undefined,
          on: () => undefined,
          isConnected: () => true,
        }) as never,
    });
    try {
      const store = openStore(join(dir, "store"));
      const journal = join(dir, "progress.jsonl");
      const result = await runBatch({ list: list(["/page"]), store, journal, render: broken.render });
      expect(result).toMatchObject({ retry: 1, excluded: 0, stored: 0 });
      expect(readJournal(journal).at(-1)?.reason).toMatch(/browser did not start/);
    } finally {
      await broken.close();
    }
  });

  it("runs as many renders at once as asked, 4 by default, and finishes every URL", async () => {
    const page = await renderer.render(`${origin}/page`);
    for (const width of [undefined, 2]) {
      const store = openStore(join(dir, `store-${width ?? "default"}`));
      const journal = join(dir, `progress-${width ?? "default"}.jsonl`);
      let inFlight = 0;
      let most = 0;
      const paths = Array.from({ length: 10 }, (_, n) => `/n${n}`);
      const result = await runBatch({
        list: list(paths),
        store,
        journal,
        ...(width ? { concurrency: width } : {}),
        render: async (url) => {
          inFlight++;
          most = Math.max(most, inFlight);
          await new Promise((done) => setTimeout(done, 30));
          inFlight--;
          // Each a different page, so none is the same page as another.
          return { ...page, listed: url, text: `${page.text} ${url}` };
        },
      });
      expect(most, String(width)).toBe(width ?? 4);
      expect(result.stored + result.excluded, String(width)).toBe(paths.length);
    }
  });

  it("writes a render receipt: every listed URL's terminal outcome, its runs' concurrency, unfinished ones named", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    // Two runs of this list (a restart), at two widths, and another list's run between them in the same journal.
    await runBatch({ list: list(["/page"]), store, journal, render: renderer.render, concurrency: 2 });
    await runBatch({
      list: { ...list(["/other"]), name: "majestic" },
      store,
      journal,
      render: async () => {
        throw new HttpStatus(404);
      },
    });
    await runBatch({
      list: list(["/missing", "/flaky"]),
      store,
      journal,
      concurrency: 3,
      render: async (url) => {
        throw url.endsWith("/flaky") ? new HttpStatus(503) : new HttpStatus(404);
      },
    });
    const receipt = renderReceipt(list(["/page", "/missing", "/flaky", "/never"]), journal, store);
    expect(receipt).toMatchObject({ urls: 4, stored: 1, excluded: { "HTTP 404": 1 }, concurrency: [2, 3] });
    // A URL at retry, and one no run reached, are unfinished; the other list's URL is not counted.
    expect(receipt.unfinished).toEqual([`${origin}/flaky`, `${origin}/never`]);
    expect(receipt.missing_pages).toEqual([]);
    // Each URL's outcome, the retries it took, and one entry per run of this list (the other list's run between them
    // is no part of either).
    const id = store.manifest()[0]?.id as string;
    expect(receipt.outcomes).toEqual({
      [`${origin}/page`]: { stored: id },
      [`${origin}/missing`]: { excluded: "HTTP 404" },
    });
    expect(receipt.retries).toEqual({ page: 1, browser: 0 });
    expect(receipt.runs.map((run) => run.concurrency)).toEqual([2, 3]);
    expect(receipt.active_seconds).toBe(receipt.runs.reduce((sum, run) => sum + run.seconds, 0));
    // A stored page whose text no longer matches its hash is not whole: missing, not stored.
    writeFileSync(join(dir, "store", "pages", id, "text.txt"), "altered");
    expect(renderReceipt(list(["/page"]), journal, store).missing_pages).toEqual([`${origin}/page`]);
    rmSync(join(dir, "store", "pages", id), { recursive: true });
    // A stored page that has gone from the store is reported.
    expect(renderReceipt(list(["/page"]), journal, store).missing_pages).toEqual([`${origin}/page`]);
  });

  it("judges a stored capture one way for the recheck and the freeze: clear, wall or unassessed", () => {
    const page = (evidence?: Record<string, unknown>) => ({ evidence }) as unknown as StoredPage;
    const full = {
      title: "Bank",
      overlays: "",
      captcha: false,
      consentWall: false,
      challengeCover: false,
      wall: false,
    };
    expect(assessCapture(page(full), "Welcome to the bank")).toBe("clear");
    expect(assessCapture(page({ ...full, consentWall: true }), "Welcome to the bank")).toBe("wall");
    expect(assessCapture(page(), "Are you a human? Press & Hold")).toBe("wall");
    // No site at all is no benign page either, for the recheck and the freeze (§13, 2026-10-31).
    expect(assessCapture(page(full), "Index of / Name Last modified Size Description cgi-bin/")).toBe("wall");
    expect(assessCapture(page(full), "Please wait while your request is being verified...")).toBe("wall");
    // Stored before its structural readings were kept: no words show a CAPTCHA or an image cover.
    expect(assessCapture(page({ title: "Bank", overlays: "" }), "Welcome to the bank")).toBe("unassessed");
  });

  it("writes a receipt summary of any size whole through a pipe before it exits", () => {
    const data = join(dir, "data");
    mkdirSync(join(data, "raw", "majestic"), { recursive: true });
    mkdirSync(join(data, "raw", "benign"), { recursive: true });
    const domains = Array.from({ length: 2500 }, (_, i) => `site${i}.example`);
    writeFileSync(
      join(data, "raw", "majestic", "top.csv"),
      `GlobalRank,Domain\n${domains.map((d, i) => `${i + 1},${d}`).join("\n")}\n`,
    );
    // A distinct exclusion reason for every URL, as the real run's thousands of reasons make the summary large.
    writeFileSync(
      join(data, "raw", "benign", "progress.jsonl"),
      domains
        .map((d, i) =>
          JSON.stringify({
            url: `https://${d}/`,
            event: "excluded",
            reason: `a reason of its own number ${i} for this page`,
            at: "2026-10-30T08:00:00.000Z",
          }),
        )
        .join("\n"),
    );
    // A reader that waits before it reads, as a pipe into another program does: the old exit cut the summary at the
    // pipe's buffer.
    const script = join(import.meta.dirname, "../../scripts/glimmer/render.ts");
    const result = spawnSync("bash", ["-c", `"${process.execPath}" "${script}" receipt majestic | (sleep 1; cat)`], {
      env: { ...process.env, GLIMMER_DATA_DIR: data },
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(result.stdout.length).toBeGreaterThan(65_536);
    const summary = JSON.parse(result.stdout.trim().split("\n").at(-1) as string);
    expect(summary).toMatchObject({ urls: 2500, stored: 0, unfinished: 0 });
  });

  it("ends a run's time at the next run's start, a recheck's included, not at a later event", () => {
    const journal = join(dir, "progress.jsonl");
    const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`;
    writeFileSync(
      journal,
      [
        line({ url: "", event: "run", list: "benign-sa", concurrency: 2, at: "2026-10-29T08:00:00.000Z" }),
        line({ url: `${origin}/page`, event: "started", at: "2026-10-29T08:00:01.000Z" }),
        line({ url: `${origin}/page`, event: "excluded", reason: "HTTP 404", at: "2026-10-29T08:00:10.000Z" }),
        // Two hours idle, then a recheck that records an outcome for the same URL.
        line({ url: "", event: "run", list: "recheck", at: "2026-10-29T10:00:00.000Z" }),
        line({ url: `${origin}/page`, event: "excluded", reason: "HTTP 404", at: "2026-10-29T10:00:01.000Z" }),
      ].join(""),
    );
    const receipt = renderReceipt(list(["/page"]), journal, openStore(join(dir, "store")));
    expect(receipt.runs).toEqual([
      { started: "2026-10-29T08:00:00.000Z", ended: "2026-10-29T08:00:10.000Z", seconds: 10, concurrency: 2 },
    ]);
    expect(receipt.active_seconds).toBe(10);
  });

  it("stores the usable pages, excludes the rest, and a rerun stores nothing twice", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "store/raw/benign/progress.jsonl");
    const urls = list(["/page", "/email", "/shell"]);
    const first = await runBatch({ list: urls, store, journal, render: renderer.render });
    expect(first).toMatchObject({ stored: 2, excluded: 1 });
    const stored = store.manifest();
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      origin: "benign",
      licence: "benign-sa: own",
      south_africa: true,
      kind: "login",
      labels: { lure: false, lure_type: "none", brand: "Example Bank" },
      label_source: { lure: "ground-truth", brand: "ground-truth", has_login_form: "dom" },
    });
    const again = await runBatch({ list: urls, store, journal, render: renderer.render });
    expect(again).toMatchObject({ stored: 0, skipped: 3 });
    expect(store.manifest()).toHaveLength(2);
  });

  it("finishes a stop between storing and recording with one page", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "store/raw/benign/progress.jsonl");
    const urls = list(["/page"]);
    await expect(
      runBatch({
        list: urls,
        store,
        journal,
        render: renderer.render,
        afterStore: () => {
          throw new Error("stopped");
        },
      }),
    ).rejects.toThrow("stopped");
    expect(readJournal(journal).map((e) => e.event)).toEqual(["run", "started"]);
    let rendered = 0;
    const rerun = await runBatch({
      list: urls,
      store,
      journal,
      render: (url) => {
        rendered++;
        return renderer.render(url);
      },
    });
    expect(rerun.recovered).toBe(1);
    expect(rendered).toBe(0);
    expect(store.manifest()).toHaveLength(1);
    expect(readJournal(journal).at(-1)?.event).toBe("stored");
  });

  it("retries a server error however Chromium reports it, and excludes a client error", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    // Some Chromium builds fail the navigation of an empty 5xx (net::ERR_HTTP_RESPONSE_CODE_FAILURE) instead of
    // answering it; the renderer reports that as the status.
    const failing = (status: number) => async () => {
      throw new HttpStatus(status);
    };
    expect(await runBatch({ list: list(["/a"]), store, journal, render: failing(503) })).toMatchObject({ retry: 1 });
    expect(await runBatch({ list: list(["/b"]), store, journal, render: failing(404) })).toMatchObject({ excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toBe("HTTP 404");
  });

  it("takes out a stored page a later challenge check refuses, and records it excluded", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const page = await renderer.render(`${origin}/page`);
    const wall = { ...page, text: `Are you a human? Press & Hold. ${words}` };
    await runBatch({ list: list(["/wall"]), store, journal, render: async () => wall, concurrency: 1 });
    // A run now refuses the wall; one stored before the check knew it is put in directly.
    expect(store.manifest()).toHaveLength(0);
    const id = await store.putPage("benign-test", {
      screenshot: wall.screenshot,
      text: wall.text,
      origin: "benign",
      licence: "test",
      host: null,
      template: null,
      south_africa: false,
      labels: { lure: false, lure_type: "none", has_login_form: false, has_payment_form: false },
      label_source: { lure: "ground-truth", lure_type: "ground-truth", has_login_form: "dom", has_payment_form: "dom" },
      redacted: false,
      url: `${origin}/old-wall`,
      kind: "home",
    });
    await runBatch({ list: list(["/page"]), store, journal, render: renderer.render });
    expect(recheckStored(store, journal)).toMatchObject({ removed: [id], damaged: [], unassessed: [] });
    expect(store.manifest().map((p) => p.url)).toEqual([`${origin}/page`]);
    expect(readJournal(journal).at(-1)).toMatchObject({ url: `${origin}/old-wall`, event: "excluded" });
    expect(recheckStored(store, journal).removed).toEqual([]);
  });

  it("refuses a capture that moved between its readings, never pairing earlier labels with a later picture", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const result = await runBatch({ list: list(["/title-ticker"]), store, journal, render: renderer.render });
    expect(result).toMatchObject({ stored: 0, excluded: 1 });
    expect(readJournal(journal).at(-1)?.reason).toBe("the page kept changing while it was captured");
  });

  it("reads a frame only once it has arrived: held, then released, the capture still reads it and refuses the page", async () => {
    let arrived!: () => void;
    const hasArrived = new Promise<void>((done) => {
      arrived = done;
    });
    let release!: () => void;
    fixture.frameHold = { arrived, release: new Promise<void>((done) => (release = done)) };
    let faults = 0;
    const faulty = await openRenderer({
      allowOrigins: [origin, frameOrigin],
      readFault: (frame) => {
        if (frame.main) return null;
        faults++;
        return new Error("Execution context was destroyed");
      },
    });
    try {
      const store = openStore(join(dir, "store"));
      const journal = join(dir, "progress.jsonl");
      const running = runBatch({ list: list(["/xframe-held"]), store, journal, render: faulty.render });
      // The frame's request is in, and held: nothing of it has been read yet.
      await hasArrived;
      expect(faults).toBe(0);
      release();
      const result = await running;
      expect(faults).toBeGreaterThan(0);
      expect(result).toMatchObject({ stored: 0, excluded: 1 });
      expect(readJournal(journal).at(-1)?.reason).toBe(
        "part of the page (a frame or a closed shadow root) could not be read",
      );
    } finally {
      fixture.frameHold = undefined;
      await faulty.close();
    }
  });

  it("refuses a capture whose shown frame could not be read, never reading it as an empty frame", async () => {
    // The fault must actually run on the frame: a capture that never read the frame would pass a stored-nothing check
    // for the wrong reason (D00 T01 §14's plan review). The one failure, run 40881446236 on b6f4239, was the first
    // version of this capture, reworked by D03 T04 §26's rounds; 40 loaded runs of the current one each read the frame.
    let faults = 0;
    const faulty = await openRenderer({
      allowOrigins: [origin, frameOrigin],
      readFault: (frame) => {
        if (frame.main) return null;
        faults++;
        return new Error("Execution context was destroyed");
      },
    });
    try {
      const store = openStore(join(dir, "store"));
      const journal = join(dir, "progress.jsonl");
      const result = await runBatch({ list: list(["/xframe-login"]), store, journal, render: faulty.render });
      expect(faults).toBeGreaterThan(0);
      expect(result).toMatchObject({ stored: 0, excluded: 1 });
      expect(readJournal(journal).at(-1)?.reason).toBe(
        "part of the page (a frame or a closed shadow root) could not be read",
      );
    } finally {
      await faulty.close();
    }
  });

  it("stores no bot wall, however it is drawn", async () => {
    const store = openStore(join(dir, "store"));
    const journal = join(dir, "progress.jsonl");
    const walls = [
      "/wall-split",
      "/wall-late",
      "/wall-frame",
      "/wall-shadow",
      "/wall-cover",
      "/wall-panel",
      "/consent-frame",
      "/wall-img",
      "/wall-css",
      "/wall-shadow-text",
      "/wall-pseudo",
      "/wall-pseudo-text",
    ];
    // Four at once, the batch's default (one at a time took 31 s in the gate for the same verdicts).
    const result = await runBatch({ list: list(walls), store, journal, render: renderer.render, concurrency: 4 });
    expect(result).toMatchObject({ stored: 0, excluded: walls.length });
    const reasons = readJournal(journal)
      .filter((e) => e.event === "excluded")
      .map((e) => e.reason);
    expect(
      reasons.every((r) => /challenge|CAPTCHA|cookie wall/.test(r ?? "")),
      reasons.join("; "),
    ).toBe(true);
    // The same walls, stored directly with the evidence admission read, are each taken out by the audit.
    const audited = openStore(join(dir, "audited"));
    // Rendered four at a time, stored in the list's order.
    const captures = await renderAll(walls);
    for (const [index, wall] of walls.entries()) {
      const capture = captures[index] as Awaited<ReturnType<typeof renderer.render>>;
      await audited.putPage("benign-test", {
        screenshot: capture.screenshot,
        text: `${capture.text} ${wall}`,
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
        url: `${origin}${wall}`,
        evidence: evidenceOf(capture),
      });
    }
    const audit = recheckStored(audited, join(dir, "audited.jsonl"));
    expect(audit.removed).toHaveLength(walls.length);
  }, 60_000);

  it("pairs no reading with a picture when what admission reads off it changed, digits included", () => {
    const reading = (text: string): Reading => ({
      url: "https://x.example/",
      title: "Shop",
      text,
      has_login_form: false,
      has_payment_form: false,
      walls: { captcha: false, consentWall: false, overlays: "", challengeCover: false, imageCover: false },
      unreadable: 0,
      height: 900,
    });
    // A clock may move; an error page appearing may not.
    expect(readingsAgree(reading(`${words} 10:41`), reading(`${words} 10:42`))).toBe(true);
    expect(readingsAgree(reading(`Error 0 ${words}`), reading(`Error 404 ${words}`))).toBe(false);
    expect(readingsAgree(reading(words), reading("short"))).toBe(false);
  });
});
