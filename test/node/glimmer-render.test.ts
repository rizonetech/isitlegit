import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  assertListLicence,
  benignCoverage,
  brandShown,
  type Capture,
  capturedKind,
  isPublicAddress,
  type ListEntry,
  majesticList,
  openRenderer,
  publicLookup,
  RefusedAddress,
  saList,
  unusable,
} from "../../scripts/glimmer/render.ts";
import { openStore } from "../../scripts/glimmer/store.ts";
import { fixture, origin, renderAll, renderer, useRenderFixture, words } from "./helpers/glimmer-render-fixture.ts";

// scripts/glimmer/render.ts (D03 T04 §6): benign pages rendered by our own browser, isolated per page, kept only when
// usable, and a resumable batch that never stores a page twice.
useRenderFixture();

describe("start-up", () => {
  it("starts a slow browser outside the page's deadline and warms the browser that replaces it", async () => {
    // A start longer than the page's whole deadline: the page still meets its own.
    const slow = await openRenderer({
      allowOrigins: [origin],
      limitMs: 3_000,
      launch: async (launchOptions) => {
        await new Promise((done) => setTimeout(done, 3_500));
        return chromium.launch(launchOptions);
      },
    });
    try {
      expect((await slow.render(`${origin}/page`)).status).toBe(200);
      await slow.close();
      expect((await slow.render(`${origin}/page`)).status).toBe(200);
      expect([slow.launches(), slow.warmups()]).toEqual([2, 2]);
    } finally {
      await slow.close();
    }
  }, 40_000);

  it("pays a fresh browser's first context at launch, outside every render's deadline", () => {
    // beforeAll's first render started the browser: its first context was made and closed while it started.
    expect(renderer.launches()).toBe(1);
    expect(renderer.warmups()).toBe(1);
    expect(renderer.openContexts()).toBe(0);
  });
});

describe("replay (§38)", () => {
  it("renders a page offline from a recorded archive as the live renderer does, and refuses what is not recorded", async () => {
    const html = `<h1>Example</h1><p>${words}</p><form><input type=password></form><script src="/not-recorded.js"></script>`;
    const replaying = await openRenderer({
      replay: {
        [`${origin}/page`]: {
          status: 200,
          headers: { "content-type": "text/html" },
          bodyBase64: Buffer.from(html).toString("base64"),
        },
      },
    });
    try {
      const live = await renderer.render(`${origin}/page`);
      const replayed = await replaying.render(`${origin}/page`);
      expect(replayed.status).toBe(live.status);
      expect(replayed.text).toBe(live.text);
      expect(replayed.has_login_form).toBe(live.has_login_form);
      expect(replaying.replayRefusals()).toContain(`${origin}/not-recorded.js`);
    } finally {
      await replaying.close();
    }
  }, 40_000);
});

describe("recording and replaying one visit (§38, round 1)", () => {
  it("replays a recorded visit faithfully (a framed form, a script-built form, a picture, a repeated URL), and a lost picture is a mismatch", async () => {
    const { harToArchive } = await import("../../scripts/glimmer/record-corpus.ts");
    const { replayMismatches } = await import("../../scripts/glimmer/compare-pipelines.ts");
    const { dhash } = await import("../../scripts/glimmer/build-dataset.ts");
    const scratch = mkdtempSync(join(tmpdir(), "loupe-record-"));
    const hex = async (shot: Uint8Array) => (await dhash(shot)).toString(16).padStart(16, "0");
    const seen = (c: Capture) => ({
      status: c.status,
      text: c.text,
      title: c.title,
      finalUrl: c.finalUrl,
      has_login_form: c.has_login_form,
      has_payment_form: c.has_payment_form,
      walls: {
        captcha: c.captcha,
        consentWall: c.consentWall,
        challengeCover: c.challengeCover,
        imageCover: c.imageCover,
      },
    });
    try {
      const har = join(scratch, "visit.har.json");
      const live = await renderer.render(`${origin}/replay-mix`, { recordHar: har });
      // The framed sign-in form and the script-built payment form are both shown on the recorded visit.
      expect(live.has_login_form).toBe(true);
      expect(live.has_payment_form).toBe(true);
      expect(live.text).toContain("first answer then second answer");
      const archive = harToArchive(JSON.parse(readFileSync(har, "utf-8")));
      expect(archive[`${origin}/poll`]?.later).toHaveLength(1);
      const viewed = {
        ...seen(live),
        screenshot: { file: "x.jpg", sha256: "0".repeat(64), dhash: await hex(live.screenshot) },
      };
      const replay = async (recorded: typeof archive) => {
        const replaying = await openRenderer({ replay: recorded });
        try {
          const c = await replaying.render(`${origin}/replay-mix`);
          return { ...seen(c), admitted: true, dhash: await hex(c.screenshot) };
        } finally {
          await replaying.close();
        }
      };
      expect(replayMismatches(viewed, await replay(archive))).toEqual([]);
      // The picture's body lost from the archive: text and forms still hold, the picture does not.
      const lost = { ...archive, [`${origin}/wall.svg`]: { status: 404, headers: {}, bodyBase64: "" } };
      expect(replayMismatches(viewed, await replay(lost)).join("; ")).toContain("the picture differs");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("addresses", () => {
  it("checks a name's addresses at every connection, so a name that turns private is refused", async () => {
    const answers = [[{ address: "93.184.216.34", family: 4 }], [{ address: "127.0.0.1", family: 4 }]];
    const lookup = publicLookup(async () => answers.shift() ?? []);
    const connect = () =>
      new Promise<string>((done) =>
        lookup("rebind.example", {}, (error, address) =>
          done(error ? ((error as { code?: string }).code ?? "") : String(address)),
        ),
      );
    expect(await connect()).toBe("93.184.216.34");
    expect(await connect()).toBe("EPRIVATE");
  });

  it("refuses a page whose name resolves to a private address when the browser connects", async () => {
    const rebinding = await openRenderer({
      limitMs: 5_000,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    fixture.serverHits = [];
    const port = new URL(origin).port;
    await expect(rebinding.render(`http://rebind.example:${port}/page`)).rejects.toBeInstanceOf(RefusedAddress);
    // An https page goes through the proxy's CONNECT tunnel, which checks the same way.
    await expect(rebinding.render(`https://rebind.example:${port}/page`)).rejects.toBeInstanceOf(RefusedAddress);
    expect(fixture.serverHits).toEqual([]);
    await rebinding.close();
  }, 30_000);

  it("allows only public addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.4.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "ff02::1"])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "196.25.1.1", "2606:4700::1111", "::ffff:8.8.8.8"])
      expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe("lists", () => {
  it("refuses a list under a non-commercial licence or none", () => {
    expect(() => assertListLicence({ name: "tranco", licence: "CC BY-NC 4.0" })).toThrow(/allowlist/);
    expect(() => assertListLicence({ name: "unknown", licence: "" })).toThrow(/none/);
    expect(() => assertListLicence({ name: "majestic", licence: "CC BY 3.0" })).not.toThrow();
  });

  it("reads Majestic's domains as homepages and the South African list's tagged lines", () => {
    const majestic = majesticList("rank,domain,tld\n1,google.com,com\n2,fnb.co.za,za\n3,not a domain,x\n");
    expect(majestic.entries.map((e) => e.url)).toEqual(["https://google.com/", "https://fnb.co.za/"]);
    const sa = saList(
      "# kind url brand also\nlogin\thttps://www.fnb.co.za/\tFNB\tfirstrand.co.za\nshop\thttps://www.takealot.com/\tTakealot\n",
    );
    expect(sa.entries).toEqual([
      { url: "https://www.fnb.co.za/", kind: "login", brand: "FNB", also: ["firstrand.co.za"] },
      { url: "https://www.takealot.com/", kind: "shop", brand: "Takealot", also: [] },
    ]);
    expect(() => saList("blog\thttps://x.co.za/\tX\n")).toThrow(/kind/);
    expect(saList("home\thttps://x.co.za/\tX\n").entries[0]?.kind).toBe("home");
    expect(() => saList("login\thttp://x.co.za/\tX\n")).toThrow(/https/);
  });
});

describe("usable", () => {
  const entry: ListEntry = { url: "https://www.example.co.za/", kind: "home", also: [] };
  const capture = (over: Partial<Capture>): Capture => ({
    listed: entry.url,
    finalUrl: "https://login.example.co.za/",
    status: 200,
    title: "Example",
    text: words,
    screenshot: new Uint8Array(),
    captcha: false,
    consentWall: false,
    overlays: "",
    challengeCover: false,
    imageCover: false,
    imageText: "",
    downloadsWritten: 0,
    popupsClosed: 0,
    serviceWorkers: 0,
    has_login_form: false,
    has_payment_form: false,
    ...over,
  });

  it("keeps a real page on the listed site", () => {
    expect(unusable(capture({}), entry)).toBeNull();
    expect(
      unusable(capture({ finalUrl: "https://bank.example.com/" }), { ...entry, also: ["example.com"] }),
    ).toBeNull();
  });

  it("excludes an error, a cross-site redirect, a loading shell, a challenge and a consent wall", async () => {
    expect(unusable(capture({ status: 404 }), entry)).toBe("HTTP 404");
    expect(unusable(capture({ finalUrl: "https://parking.example.net/" }), entry)).toMatch(/cross-site/);
    const local = { url: `${origin}/`, kind: "home" as const, also: [] };
    // Every live page rendered four at a time (one at a time took 8 s in the gate), then each judged as before.
    const paths = [
      "/missing",
      "/shell",
      "/challenge",
      "/consent",
      "/page",
      "/framed-login",
      "/backdrop-consent",
      "/cmp-frame",
      "/shadow-consent",
      "/captcha-challenge",
      "/captcha-badge",
      "/opacity-body",
    ] as const;
    // Four at a time, the batch's default: all at once can pass the renderer's limit on a loaded runner.
    const captures = await renderAll(paths);
    const judged = new Map(
      paths.map((path, index) => [path, unusable(captures[index] as (typeof captures)[number], local)] as const),
    );
    const live = async (path: (typeof paths)[number]) => judged.get(path);
    expect(await live("/missing")).toBe("HTTP 404");
    expect(await live("/shell")).toMatch(/under 50 characters/);
    expect(await live("/challenge")).toBe("a challenge page");
    // HUMAN's and Imperva's walls, as South African retailers and journals served them.
    for (const wall of [
      "Are you a human? Press and hold the button below to confirm.",
      "Additional security check is required. Just click the checkbox above to pass the security check.",
    ])
      expect(unusable(capture({ text: `${wall} ${words}` }), entry)).toBe("a challenge page");
    expect(await live("/consent")).toBe("a cookie wall covering the page");
    expect(await live("/page")).toBeNull();
    // A sign-in page drawn in a full-screen frame that links its cookie policy is a page, not a wall.
    expect(await live("/framed-login")).toBeNull();
    expect(await live("/backdrop-consent")).toBe("a cookie wall covering the page");
    expect(await live("/cmp-frame")).toBe("a cookie wall covering the page");
    expect(await live("/shadow-consent")).toBe("a cookie wall covering the page");
    expect(await live("/captcha-challenge")).toBe("a CAPTCHA frame");
    // A protection badge in a corner is not a challenge the viewer must solve.
    expect(await live("/captcha-badge")).toBeNull();
    // Text under a body that opacity 0 hides is not shown.
    expect(await live("/opacity-body")).toMatch(/under 50 characters/);
  });

  it("excludes a site's not-found page answered with 200", () => {
    const cart = { url: "https://www.checkers.co.za/cart", kind: "checkout" as const, brand: "Checkers", also: [] };
    const fallback = capture({ finalUrl: cart.url, title: "Checkers | Page not found", text: `Sorry. ${words}` });
    expect(unusable(fallback, cart)).toBe("an error page answered with 200");
    // Its message after a long header of navigation and a cart subtotal.
    const header = `Checkers Home Shop Specials Recipes Stores Sixty60 Cart Subtotal R 0.00 ${"Departments ".repeat(40)}`;
    const late = capture({
      finalUrl: cart.url,
      title: "Checkers",
      text: `${header}Sorry, this page could not be found.`,
    });
    expect(unusable(late, cart)).toBe("an error page answered with 200");
  });

  it("excludes a listed page that lands on a sign-in page or does not show its brand", () => {
    const profile = { url: "https://www.facebook.com/FNBSA", kind: "social" as const, brand: "FNB", also: [] };
    const generic = capture({ finalUrl: "https://www.facebook.com/login/?next=x", title: "Log in to Facebook" });
    expect(unusable(generic, profile)).toBe("redirected to a sign-in page, not the social page listed");
    const other = capture({ finalUrl: "https://www.facebook.com/somebody", title: "Somebody" });
    expect(unusable(other, profile)).toBe("the listed brand (FNB) is not on the page");
    expect(
      unusable(capture({ finalUrl: "https://www.facebook.com/FNBSA", title: "FNB | Facebook" }), profile),
    ).toBeNull();
    // A word every bank shares does not show a brand.
    expect(brandShown("Standard Bank", { title: "Bank", text: words, finalUrl: "https://example.com/" })).toBe(false);
  });

  it("keeps a listed kind only when the page shows it", () => {
    const said = (text: string) => ({ text });
    const at = (path: string, over: Partial<Capture> = {}) =>
      capture({ finalUrl: `https://www.example.co.za${path}`, ...over });
    expect(capturedKind({ kind: "login" }, at("/login", { has_login_form: true }))).toBe("login");
    expect(capturedKind({ kind: "login" }, at("/"))).toBe("home");
    expect(capturedKind({ kind: "checkout" }, at("/cart", said("Your cart is empty. Subtotal R 0.00")))).toBe(
      "checkout",
    );
    // A path is not enough: the page must say what it is.
    expect(capturedKind({ kind: "checkout" }, at("/cart"))).toBe("home");
    expect(capturedKind({ kind: "shop" }, at("/products/kettle-2l", said("Kettle 2 l. R 499.00. Add to cart")))).toBe(
      "shop",
    );
    expect(capturedKind({ kind: "shop" }, at("/products/kettle-2l"))).toBe("home");
    expect(capturedKind({ kind: "shop" }, at("/en-za/", said("Add to cart")))).toBe("home");
    expect(capturedKind({ kind: "company" }, at("/about-us/", said("About us: our story since 1910")))).toBe("company");
    expect(capturedKind({ kind: "company" }, at("/"))).toBe("home");
    expect(capturedKind({ kind: "social" }, at("/FNBSA"))).toBe("social");
  });
});

describe("benignCoverage", () => {
  it("counts benign renders only, each read back whole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glimmer-coverage-"));
    try {
      const store = openStore(dir);
      const jpeg = new Uint8Array(
        await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123" } })
          .jpeg()
          .toBuffer(),
      );
      const base = {
        screenshot: jpeg,
        licence: "x",
        host: null,
        template: null,
        redacted: false,
        labels: { lure: false, lure_type: "none" as const, has_login_form: false, has_payment_form: false },
        label_source: {
          lure: "ground-truth" as const,
          lure_type: "ground-truth" as const,
          has_login_form: "dom" as const,
          has_payment_form: "dom" as const,
        },
        url: "https://www.example.co.za/",
      };
      await store.putPage("benign-majestic", {
        ...base,
        text: "home page",
        origin: "benign",
        south_africa: false,
        kind: "home",
      });
      await store.putPage("benign-sa", {
        ...base,
        text: "bank sign-in",
        origin: "benign",
        south_africa: true,
        kind: "login",
        labels: { ...base.labels, brand: "Bank" },
        label_source: { ...base.label_source, brand: "ground-truth" },
      });
      await store.putPage("phreshphish", {
        ...base,
        text: "benign public page",
        origin: "public",
        south_africa: true,
        kind: "shop",
      });
      // A benign render read back without its DOM form flags or its listed URL is a problem, not a page.
      const { has_login_form: _flag, ...noFlags } = base.labels;
      const { has_login_form: _source, ...noFlagSources } = base.label_source;
      await store.putPage("benign-sa", {
        ...base,
        text: "a page without its flags",
        origin: "benign",
        south_africa: true,
        kind: "home",
        labels: noFlags,
        label_source: noFlagSources,
      });
      await store.putPage("benign-sa", {
        ...base,
        text: "a page without its URL",
        origin: "benign",
        south_africa: true,
        kind: "home",
        url: undefined,
      });
      // A page whose text went missing, and one whose record does not read, are problems; the count goes on.
      const lost = await store.putPage("benign-sa", {
        ...base,
        text: "a page whose text goes",
        origin: "benign",
        south_africa: true,
        kind: "home",
      });
      rmSync(join(dir, "pages", lost, "text.txt"));
      const broken = await store.putPage("benign-sa", {
        ...base,
        text: "a page whose record breaks",
        origin: "benign",
        south_africa: true,
        kind: "home",
      });
      writeFileSync(join(dir, "pages", broken, "meta.json"), "{ not json");
      const coverage = benignCoverage(store);
      expect(coverage.problems).toEqual(
        expect.arrayContaining([`${lost}: its files do not read`, `${broken}: damaged`]),
      );
      expect(coverage).toMatchObject({ total: 2, southAfrica: 1, signIn: 1, shop: 0, met: false });
      expect(coverage.short).toContain("total 2 of 3000");
      expect(coverage.problems.map((line) => line.split(": ")[1])).toEqual(
        expect.arrayContaining(["no DOM-read has_login_form", "no listed URL"]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
