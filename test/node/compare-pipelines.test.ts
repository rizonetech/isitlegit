// D03 T04 §31: the comparison core counts, divides and detects leaks the way its figures claim.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { shingles } from "../../scripts/glimmer/build-dataset.ts";
import {
  type Annotation,
  annotationSample,
  BALANCE_TOLERANCE,
  balanceOf,
  benignCoverage,
  builtMembership,
  checkResult,
  compareBenign,
  compareLabels,
  compareSplit,
  conventionalReplayMismatches,
  describeInput,
  groupShuffleSplit,
  incompleteIfMissing,
  type LabelFigures,
  type Labels,
  leakWitnesses,
  measurementLine,
  type Page,
  parseArgs,
  readCorpus,
  recordMeasurement,
  replayMismatches,
  report,
  resultFile,
  STRATIFIED_SEEDS,
  scoreBenign,
  scoreLabels,
  seeded,
  splitFigures,
  stratifiedGroupSplit,
  validateAnnotations,
  wilson,
  writeResult,
} from "../../scripts/glimmer/compare-pipelines.ts";

describe("the benign comparison (§38)", () => {
  const label = (wall: boolean, form: "login" | "payment" | "none", eligible: boolean) => ({ wall, form, eligible });
  it("counts admitted walls, retained benign and mislabelled forms, with replay failures apart", () => {
    const figures = scoreBenign([
      {
        id: "wall",
        label: label(true, "none", false),
        replay_failure: false,
        production: { admitted: true, form: "none" },
        conventional: { admitted: false, form: "none" },
      },
      {
        id: "good",
        label: label(false, "login", true),
        replay_failure: false,
        production: { admitted: true, form: "login" },
        conventional: { admitted: true, form: "none" },
      },
      {
        id: "lost",
        label: label(false, "none", true),
        replay_failure: false,
        production: { admitted: false, form: "none" },
        conventional: { admitted: true, form: "none" },
      },
      {
        id: "broken",
        label: label(false, "payment", true),
        replay_failure: true,
        production: null,
        conventional: null,
      },
    ]);
    expect(figures.replay_failures).toBe(1);
    expect(figures.production.retained).toMatchObject({ k: 1, n: 2 });
    expect(figures.production.admitted_walls).toMatchObject({ k: 1, n: 1 });
    expect(figures.production.contaminated).toMatchObject({ k: 1, n: 2 });
    expect(figures.conventional.mislabelled_forms).toMatchObject({ k: 1, n: 3 });
    // Rejecting an ineligible page never counts as losing a valid benign page: denominators are eligible only.
    expect(figures.conventional.retained.n).toBe(2);
  });

  it("refuses a corpus whose strata are too thin, and runs a covered corpus end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loupe-benign-"));
    try {
      const corpusPage = (id: string, wall: boolean, form: "login" | "payment" | "none", eligible: boolean) => ({
        id,
        url: `https://example.com/${id}`,
        archive: {},
        viewed: {
          status: 200,
          text: "a real page with enough visible text for a person to read and use today",
          has_login_form: form === "login",
          has_payment_form: form === "payment",
        },
        label: { wall, form, eligible, eligibility_reason: eligible ? "valid" : "wall" },
      });
      const pages = [
        ...Array.from({ length: 20 }, (_, i) => corpusPage(`w${i}`, true, "none" as const, false)),
        ...Array.from({ length: 20 }, (_, i) => corpusPage(`g${i}`, false, "none" as const, true)),
        ...Array.from({ length: 20 }, (_, i) => corpusPage(`l${i}`, false, "login" as const, true)),
        ...Array.from({ length: 20 }, (_, i) => corpusPage(`p${i}`, false, "payment" as const, true)),
      ];
      expect(benignCoverage(pages.slice(0, 10)).insufficient.length).toBeGreaterThan(0);
      mkdirSync(join(dir, "runs", "compare", "corpus"), { recursive: true });
      writeFileSync(join(dir, "runs", "compare", "corpus", "corpus.json"), JSON.stringify({ seed: 7, pages }));
      const result = await compareBenign(dir, async (p) => ({ ...p.viewed, admitted: !p.label.wall }));
      expect(result.status).toBe("complete");
      if (result.status === "complete") {
        expect(result.figures.production.retained.k).toBe(60);
        expect(result.figures.replay_failures).toBe(0);
        const line = measurementLine(result, "2026-11-02", "f".repeat(64));
        expect(line).toContain("the benign render against a conventional crawl-and-filter pipeline");
        expect(line).toContain("Production renderer: retained 60 of 60 eligible");
        // Per-page decisions and the pinned baseline configuration are persisted, and the saved result reads
        // back current until an input changes.
        expect(result.figures.decisions).toHaveLength(80);
        expect(result.figures.config.blocklist).toContain("just a moment");
        writeResult(resultFile(dir, "benign"), result);
        expect(checkResult(dir, "benign").status).toBe("current");
        writeFileSync(join(dir, "runs", "compare", "corpus", "corpus.json"), JSON.stringify({ seed: 8, pages }));
        expect(checkResult(dir, "benign").status).toBe("stale");
      }
      // A replayed capture that differs from the viewed one is a replay failure, never scored.
      const broken = await compareBenign(dir, async (p) => ({
        ...p.viewed,
        text: "something else entirely",
        admitted: true,
      }));
      expect(broken.status).toBe("incomplete");
      if (broken.status === "incomplete") expect(broken.missing[0]).toContain("after replay");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the benign comparison's evidence (§38, round 1)", () => {
  const scored = (id: string, label: BenignLabelLike, admitted: boolean) => ({
    id,
    label,
    replay_failure: false,
    production: { admitted, form: "none" as const },
    conventional: { admitted, form: "none" as const },
  });
  type BenignLabelLike = Parameters<typeof scoreBenign>[0][number]["label"];
  it("keeps unresolved labels out of every rate and counts them apart", () => {
    const clean = { wall: false, form: "none", eligible: true } as const;
    const base = [scored("wall", { wall: true, form: "none", eligible: false }, true), scored("ok", clean, true)];
    const before = scoreBenign(base);
    // Round 1 finding 5: an admitted page with unknown wall and eligibility used to enter the denominator only.
    const after = scoreBenign([
      ...base,
      scored("u1", { wall: "unknown", form: "unknown", eligible: "unknown" }, true),
      scored("u2", { wall: "disputed", form: "none", eligible: true }, true),
    ]);
    expect(before.production.contaminated).toMatchObject({ k: 1, n: 2 });
    expect(after.production.contaminated).toMatchObject({ k: 1, n: 2 });
    expect(after.unresolved).toEqual({ wall: 2, eligible: 1, form: 1 });
  });

  it("calls a replay unfaithful when anything admission or a label reads has moved", () => {
    const viewed = {
      status: 200,
      text: "a real page with enough visible text for a person to read and use today",
      title: "Example",
      finalUrl: "https://example.com/",
      has_login_form: false,
      has_payment_form: false,
      walls: { captcha: false, consentWall: false, challengeCover: false, imageCover: true },
      screenshot: { file: "shots/x.jpg", sha256: "a".repeat(64), dhash: "00000000000000ff" },
    };
    const { screenshot: _shot, ...rest } = viewed;
    const same = { ...rest, admitted: true, dhash: "00000000000000fe" };
    expect(replayMismatches(viewed, same)).toEqual([]);
    expect(replayMismatches(viewed, { ...same, finalUrl: "https://example.com/elsewhere" })[0]).toContain("landed on");
    expect(replayMismatches(viewed, { ...same, title: "Other" })).toEqual(["title differs from the viewed capture"]);
    expect(replayMismatches({ ...viewed, overlays: "Accept cookies" }, { ...same, overlays: "" })).toEqual([
      "overlays differ from the viewed capture",
    ]);
    // An image-based challenge that replay lost: text and forms hold, the wall evidence and the picture do not.
    const lost = replayMismatches(viewed, {
      ...same,
      walls: { ...viewed.walls, imageCover: false },
      dhash: "ffffffffffffff00",
    });
    expect(lost).toEqual([
      "wall evidence differs from the viewed capture (imageCover)",
      "the picture differs from the viewed screenshot (64 bits)",
    ]);
    expect(replayMismatches(viewed, { ...rest, admitted: true })).toContain(
      "the picture differs from the viewed screenshot (no bits)",
    );
    expect(conventionalReplayMismatches(viewed, { ...rest, dhash: "00000000000000fe" })).toEqual([]);
    expect(conventionalReplayMismatches(viewed, { ...rest, status: 0, dhash: "00000000000000fe" })).toEqual([
      "conventional status 0 against viewed 200",
    ]);
  });

  // A file-backed corpus as the recorder writes it: a manifest of page files with their sha256.
  const writeCorpus = (dir: string, pages: Record<string, unknown>[], ids = pages.map((p) => p.id as string)) => {
    const root = join(dir, "runs", "compare", "corpus");
    mkdirSync(join(root, "pages"), { recursive: true });
    const digest = new Map<string, string>();
    for (const page of pages) {
      const data = JSON.stringify(page);
      writeFileSync(join(root, "pages", `${page.id}.json`), data);
      digest.set(page.id as string, createHash("sha256").update(data).digest("hex"));
    }
    writeFileSync(
      join(root, "corpus.json"),
      JSON.stringify({ seed: 3, page_files: ids.map((id) => ({ id, sha256: digest.get(id) })), failed: [] }),
    );
    return root;
  };
  const filePage = (id: string, form: "login" | "none", eligible: boolean) => ({
    id,
    url: `https://example.com/${id}`,
    archive: {},
    viewed: {
      status: 200,
      text: "a real page with enough visible text for a person to read and use today",
      has_login_form: form === "login",
      has_payment_form: false,
    },
    label: { wall: false, form, eligible, eligibility_reason: eligible ? "valid" : "brand missing", source: "test" },
  });
  const covered = () => [
    ...Array.from({ length: 20 }, (_, i) => filePage(`g${i}`, "none", true)),
    ...Array.from({ length: 20 }, (_, i) => filePage(`l${i}`, "login", true)),
  ];

  it("excludes a conventional replay failure from both pipelines instead of scoring it as a decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loupe-benign-conv-fail-"));
    try {
      writeCorpus(dir, covered());
      const result = await compareBenign(
        dir,
        async (p) => ({ ...p.viewed, admitted: true }),
        async (p) => (p.id === "g0" ? { ...p.viewed, status: 0 } : p.viewed),
      );
      expect(result.status).toBe("complete");
      if (result.status === "complete") {
        expect(result.figures.replay_failures).toBe(1);
        expect(result.figures.production.retained).toMatchObject({ k: 39, n: 39 });
        expect(result.figures.conventional.retained).toMatchObject({ k: 39, n: 39 });
        expect(result.figures.decisions[0]).toMatchObject({
          id: "g0",
          replay_failure: true,
          replay_reason: "conventional status 0 against viewed 200",
          production: null,
          conventional: null,
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a manifest that names a page twice, a page whose file changed and a missing page file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loupe-benign-files-"));
    try {
      const pages = covered();
      const root = writeCorpus(dir, pages, [...pages.map((p) => p.id), "g3"]);
      // Round 1 finding 1: 227 manifest entries held 218 ids, and the repeats were scored as observations.
      expect(() => readCorpus(dir)).toThrow(/names g3 more than once/);
      expect(await compareBenign(dir, async (p) => ({ ...p.viewed, admitted: true }))).toMatchObject({
        status: "incomplete",
        missing: [expect.stringContaining("more than once")],
      });
      writeCorpus(dir, pages);
      writeFileSync(join(root, "pages", "l4.json"), JSON.stringify({ ...pages[24], url: "https://changed.example/" }));
      expect(await compareBenign(dir, async (p) => ({ ...p.viewed, admitted: true }))).toMatchObject({
        status: "incomplete",
        missing: [expect.stringContaining("l4 does not match the manifest's sha256")],
      });
      writeCorpus(dir, pages);
      rmSync(join(root, "pages", "g7.json"));
      expect(await compareBenign(dir, async (p) => ({ ...p.viewed, admitted: true }))).toMatchObject({
        status: "incomplete",
        missing: [expect.stringContaining("the benign corpus cannot be read")],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks a saved benign result against the page files and reads it back through report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loupe-benign-report-"));
    try {
      const pages = covered();
      const root = writeCorpus(dir, pages);
      const result = await compareBenign(dir, async (p) => ({ ...p.viewed, admitted: p.id !== "g0" }));
      expect(result.status).toBe("complete");
      writeResult(resultFile(dir, "benign"), result);
      expect(checkResult(dir, "benign").status).toBe("current");
      // The other reported comparisons recorded as incomplete: report still writes the benign line.
      for (const name of ["labels", "split-1.0"])
        writeResult(resultFile(dir, name), { status: "incomplete", name, inputs: [], missing: ["not run"] });
      const { text } = report(dir, "## Measurements\n", "2026-11-03");
      expect(text).toContain("the benign render against a conventional crawl-and-filter pipeline");
      expect(text).toContain("Production renderer: retained 39 of 40 eligible");
      // A changed label in one page file makes the saved result stale; a missing page file too.
      writeFileSync(
        join(root, "pages", "g1.json"),
        JSON.stringify({ ...pages[1], label: { ...pages[1]?.label, eligible: false } }),
      );
      expect(checkResult(dir, "benign")).toMatchObject({ status: "stale" });
      writeCorpus(dir, pages);
      expect(checkResult(dir, "benign").status).toBe("current");
      rmSync(join(root, "pages", "g2.json"));
      expect(checkResult(dir, "benign")).toMatchObject({
        status: "stale",
        changed: [expect.stringContaining("benign corpus")],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recording the benign corpus (§38)", () => {
  it("keeps images and every answer a URL got, in order, and drops only video, audio and oversized bodies", async () => {
    const { harToArchive, seededSample } = await import("../../scripts/glimmer/record-corpus.ts");
    const { replayResponder } = await import("../../scripts/glimmer/render.ts");
    const response = (status: number, text: string, mimeType: string, encoding?: string) => ({
      status,
      headers: [{ name: "Content-Type", value: mimeType }],
      content: { text, mimeType, ...(encoding ? { encoding } : {}) },
    });
    const archive = harToArchive({
      log: {
        entries: [
          { request: { url: "https://example.com/" }, response: response(200, "<p>hi</p>", "text/html") },
          { request: { url: "https://example.com/a.png" }, response: response(200, "aGk=", "image/png", "base64") },
          { request: { url: "https://example.com/clip" }, response: response(200, "AAAA", "video/mp4", "base64") },
          { request: { url: "https://example.com/poll" }, response: response(200, "first", "text/plain") },
          { request: { url: "https://example.com/poll" }, response: response(503, "second", "text/plain") },
          {
            request: { url: "https://example.com/step", method: "POST", postData: { text: "step=1" } },
            response: response(200, "step-one", "text/plain"),
          },
          {
            request: { url: "https://example.com/step", method: "POST", postData: { text: "step=2" } },
            response: response(200, "step-two", "text/plain"),
          },
        ],
      },
    });
    expect(Buffer.from(archive["https://example.com/"]?.bodyBase64 ?? "", "base64").toString()).toBe("<p>hi</p>");
    // An image is admission evidence (an image-based challenge): kept.
    expect(archive["https://example.com/a.png"]?.bodyBase64).toBe("aGk=");
    expect(archive["https://example.com/clip"]?.bodyBase64).toBe("");
    // A URL answered twice keeps both answers; replay serves them in order and then repeats the last.
    const respond = replayResponder(archive);
    const body = (r: ReturnType<typeof respond>) => Buffer.from(r?.bodyBase64 ?? "", "base64").toString();
    expect(body(respond("https://example.com/poll"))).toBe("first");
    expect(respond("https://example.com/poll")?.status).toBe(503);
    expect(body(respond("https://example.com/poll"))).toBe("second");
    expect(body(respond("https://example.com/step", "POST", "step=2"))).toBe("step-two");
    expect(body(respond("https://example.com/step", "POST", "step=1"))).toBe("step-one");
    // Round 2 finding 2: an unrecorded POST body or method is refused, never answered with another body's response.
    expect(respond("https://example.com/step", "POST", "step=not-recorded")).toBeNull();
    expect(respond("https://example.com/step", "POST", "")).toBeNull();
    expect(respond("https://example.com/step", "GET")).toBeNull();
    expect(respond("https://example.com/never")).toBeNull();
    // A fresh visit starts the sequence again.
    expect(body(replayResponder(archive)("https://example.com/poll"))).toBe("first");
    expect(seededSample([1, 2, 3, 4, 5], 3)).toEqual(seededSample([1, 2, 3, 4, 5], 3));
    expect(seededSample([1, 2, 3, 4, 5], 3)).toHaveLength(3);
  });

  it("numbers a top-up past the stratum's largest id, gaps and other strata aside", async () => {
    const { nextTopupOffset } = await import("../../scripts/glimmer/record-corpus.ts");
    // Round 1 finding 1: recording failures left gaps, and a count of pages reused walls-topup-87.
    expect(nextTopupOffset(["walls-0", "walls-3", "walls-topup-87", "walls-topup-2"], "walls")).toBe(88);
    // Another stratum's numbers never count: login-topup-* is not walls-*, and walls-30 is not login-*.
    expect(nextTopupOffset(["walls-30", "login-2", "login-topup-5"], "login")).toBe(6);
    expect(nextTopupOffset(["genuine-0"], "payment")).toBe(0);
  });

  it("applies a viewed label only to the screenshot that was viewed, and refuses a malformed one", async () => {
    const { applyAnnotation, parseAnnotations, PENDING_LABEL } = await import("../../scripts/glimmer/record-corpus.ts");
    const shot = "a".repeat(64);
    const page = {
      id: "login-1",
      url: "https://example.com/login",
      archive: {},
      viewed: {
        status: 200,
        text: "sign in",
        has_login_form: true,
        has_payment_form: false,
        screenshot: { file: "shots/login-1.jpg", sha256: shot, dhash: "0".repeat(16) },
      },
      label: PENDING_LABEL,
    };
    const good = {
      id: "login-1",
      screenshot_sha256: shot,
      wall: false,
      form: "login",
      eligible: false,
      reason: "the listed brand is not on the page",
      annotator: "claude-viewed",
    };
    const { annotations, problems } = parseAnnotations(`${JSON.stringify(good)}\n`);
    expect(problems).toEqual([]);
    expect(applyAnnotation(page, annotations[0] as (typeof annotations)[number]).label).toEqual({
      wall: false,
      form: "login",
      eligible: false,
      eligibility_reason: "the listed brand is not on the page",
      source: "claude-viewed",
    });
    expect(() =>
      applyAnnotation(page, { ...(annotations[0] as (typeof annotations)[number]), screenshot_sha256: "b".repeat(64) }),
    ).toThrow(/different screenshot/);
    const bad = parseAnnotations(
      [
        JSON.stringify(good),
        JSON.stringify(good),
        JSON.stringify({ ...good, id: "x", form: "maybe", reason: "" }),
        "not json",
        "null",
        "[]",
      ].join("\n"),
    ).problems;
    expect(bad).toEqual([
      "line 2 (login-1) repeats an id",
      "line 3 (x) has no form",
      "line 3 (x) has no reason",
      "line 4 is not JSON",
      "line 5 is not a JSON object",
      "line 6 is not a JSON object",
    ]);
    // A pending label resolves nothing: it enters no rate.
    expect(PENDING_LABEL).toMatchObject({ wall: "unknown", form: "unknown", eligible: "unknown" });
  });

  it("judges viewed eligibility across HTTP-200 error pages, suspended hosts, missing brands and allowed redirects", async () => {
    const { viewedEligibility } = await import("../../scripts/glimmer/record-corpus.ts");
    const base = {
      status: 200,
      title: "Acme Portal",
      text: "Welcome to the Acme customer portal with enough visible text for a person to read and use today.",
      finalUrl: "https://www.acme.co.za/",
      url: "https://acme.co.za/",
      brand: "Acme",
      also: ["auth.acme-group.com"],
      wall: false,
    };
    expect(viewedEligibility(base)).toEqual({ eligible: true, reason: "valid benign capture" });
    // Legitimate subdomain and `also` destinations stay eligible (Round 1 finding 3).
    expect(viewedEligibility({ ...base, finalUrl: "https://login.acme.co.za/start" }).eligible).toBe(true);
    expect(viewedEligibility({ ...base, finalUrl: "https://sso.auth.acme-group.com/login" }).eligible).toBe(true);
    // Unlisted cross-site redirects, HTTP-200 error/suspended/parked pages, missing brand, non-2xx and walls are ineligible.
    expect(viewedEligibility({ ...base, finalUrl: "https://other.example/" })).toEqual({
      eligible: false,
      reason: "cross-site redirect to other.example",
    });
    expect(viewedEligibility({ ...base, title: "404 Not Found" }).eligible).toBe(false);
    expect(viewedEligibility({ ...base, text: `${base.text} Account has been suspended.` }).eligible).toBe(false);
    expect(viewedEligibility({ ...base, text: `${base.text} This domain is parked.` }).eligible).toBe(false);
    expect(
      viewedEligibility({ ...base, title: "Generic", text: "Enough visible words on the page to pass fifty chars." }),
    ).toEqual({
      eligible: false,
      reason: "the listed brand (Acme) is not on the page",
    });
  });
});

describe("the Wilson interval", () => {
  it("matches known values and the empty case", () => {
    const { low, high } = wilson(5, 50);
    expect(low).toBeCloseTo(0.0435, 3);
    expect(high).toBeCloseTo(0.2133, 3);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    expect(wilson(0, 20).low).toBe(0);
    expect(wilson(20, 20).high).toBe(1);
  });
});

describe("scoring labels against annotations", () => {
  const annotations: Annotation[] = [
    { id: "a", brand: "FNB", lure_type: "none", lure: false },
    { id: "b", brand: "Standard Bank", lure_type: "credential", lure: true },
    { id: "c", brand: null, lure_type: "payment", lure: true },
    { id: "d", brand: "unknown", lure_type: "disputed", lure: true },
    { id: "e", brand: "Capitec" },
  ];
  const rule = new Map<string, Labels>([
    ["a", { brand: "First National Bank", lure_type: "none", lure: false }], // brand spelled differently, same identity
    ["b", { brand: "Nedbank", lure_type: "credential", lure: true }], // wrong brand
    ["c", { brand: null, lure_type: "credential", lure: true }], // wrong lure type; null brand right
    ["d", { brand: "X", lure_type: "none", lure: true }],
    // "e" has no label at all
  ]);

  it("counts denominators, exclusions, coverage and errors per field", () => {
    const figures = scoreLabels(annotations, { rule }).rule as LabelFigures[string];
    // Brand: a, b, c, e judged (d unknown); e is not retained; b is wrong.
    expect(figures.brand).toMatchObject({ annotated: 4, unknown: 1, disputed: 0, retained: 3, wrong: 1 });
    expect(figures.brand.error).toBeCloseTo(1 / 3);
    expect(figures.brand.coverage).toBeCloseTo(3 / 4);
    // Lure type: a, b, c judged (d disputed, e not annotated); c wrong.
    expect(figures.lure_type).toMatchObject({ annotated: 3, disputed: 1, retained: 3, wrong: 1 });
    // Lure: a, b, c, d judged; all right.
    expect(figures.lure).toMatchObject({ annotated: 4, retained: 4, wrong: 0, error: 0 });
    expect(figures.lure.interval.low).toBe(0);
  });

  it("scores each set apart, and a set with no labels retains nothing", () => {
    const figures = scoreLabels(annotations, { rule, empty: new Map() });
    expect(figures.empty?.brand).toMatchObject({ retained: 0, wrong: 0, error: null, coverage: 0 });
    expect(figures.rule?.brand.retained).toBe(3);
  });
});

describe("split figures and the conventional split", () => {
  const word = (n: number) => shingles(Array.from({ length: 40 }, (_, i) => `w${n}x${i}`).join(" "));
  const page = (
    id: string,
    brand: string | null,
    site: string | null,
    lure: boolean,
    hash: bigint,
    n: number,
  ): Page => ({
    id,
    brand,
    site,
    lure,
    hash,
    words: word(n),
  });

  it("counts brand, site and near-duplicate leaks across the sides, and none on a clean split", () => {
    const pages = [
      page("t1", "FNB", "fnb.co.za", true, 0n, 1),
      page("t2", "Capitec", "capitec.co.za", false, 1n << 40n, 2),
      page("e1", "FNB", "other.com", true, 1n << 20n, 3), // brand leak
      page("e2", "Nedbank", "capitec.co.za", false, 1n << 50n, 4), // site leak
      page("e3", "Absa", "absa.co.za", true, 0n, 1), // near-duplicate of t1 (same hash, same text)
      page("e4", "Discovery", "discovery.co.za", false, (1n << 63n) - 1n, 5), // clean
    ];
    const sides = new Map<string, "train" | "eval">([
      ["t1", "train"],
      ["t2", "train"],
      ["e1", "eval"],
      ["e2", "eval"],
      ["e3", "eval"],
      ["e4", "eval"],
    ]);
    const figures = splitFigures(pages, sides);
    expect(figures).toMatchObject({
      train: 2,
      eval: 4,
      dropped: 0,
      cross_brand: 1,
      cross_site: 1,
      near_duplicate_eval_pages: 1,
    });
    expect(figures.lure_share_eval).toBeCloseTo(0.5);
    // Without the three planted leaks nothing is counted.
    const clean = splitFigures(
      pages.filter((p) => ["t2", "e4"].includes(p.id)),
      sides,
    );
    expect(clean).toMatchObject({ cross_brand: 0, cross_site: 0, near_duplicate_eval_pages: 0 });
  });

  it("a hash one bit away with different text is not a near-duplicate", () => {
    const a = page("a", "A", null, true, 0n, 1);
    const b = page("b", "B", null, true, 1n, 2);
    const figures = splitFigures(
      [a, b],
      new Map([
        ["a", "train"],
        ["b", "eval"],
      ]),
    );
    expect(figures.near_duplicate_eval_pages).toBe(0);
  });

  it("the stratified baseline matches the evaluation lure share where plain group-shuffle drifts, and keeps groups whole", () => {
    const pages: Page[] = [];
    // 30 brands: ten entirely lures, twenty entirely benign, so a plain shuffle's lure share depends on the draw.
    for (let b = 0; b < 30; b++)
      for (let k = 0; k < 3; k++)
        pages.push(page(`p${b}-${k}`, `Brand${b}`, `site${b}.com`, b < 10, BigInt(b * 7 + k) << 6n, b * 10 + k));
    const target = 0.5;
    const drift = (sides: Map<string, "train" | "eval">) =>
      Math.abs((splitFigures(pages, sides).lure_share_eval ?? 0) - target);
    let plain = 0;
    for (const seed of STRATIFIED_SEEDS) {
      const stratified = stratifiedGroupSplit(pages, seeded(seed), 0.3, target);
      const figures = splitFigures(pages, stratified);
      expect(figures.cross_brand).toBe(0);
      expect(figures.eval).toBeGreaterThan(0);
      expect(drift(stratified)).toBeLessThan(0.15);
      plain = Math.max(plain, drift(groupShuffleSplit(pages, seeded(seed), 0.3)));
    }
    // The imbalance is real: the plain baseline strays further on some seed than the stratified one ever does.
    expect(plain).toBeGreaterThan(0.15);
  });

  it("reports each lure type's share against the build's, and calls a seed unmet when whole groups prevent the match", () => {
    const typed = (id: string, brand: string, lure: boolean, type: string | null, n: number): Page => ({
      ...page(id, brand, `${brand}.com`, lure, BigInt(n) << 9n, n),
      lureType: type,
    });
    // One huge all-lure group and many small benign ones: no whole-group draw gets near a 10 percent lure share.
    const pages: Page[] = [];
    for (let k = 0; k < 40; k++) pages.push(typed(`big${k}`, "BigLureBrand", true, "credential", k));
    for (let b = 0; b < 20; b++) pages.push(typed(`ok${b}`, `Benign${b}`, false, null, 100 + b));
    const builtSides = new Map<string, "train" | "eval">(pages.map((p) => [p.id, p.lure ? "train" : "eval"]));
    const built = splitFigures(pages, builtSides);
    expect(built.lure_types).toEqual({ train: { credential: 40 }, eval: {} });
    const target = 0.1;
    const sides = stratifiedGroupSplit(pages, seeded(1), 0.5, target);
    const figures = splitFigures(pages, sides);
    const balance = balanceOf(
      { ...built, lure_share_eval: target, lure_types: { train: {}, eval: { credential: 1, fake_shop: 1 } } },
      figures,
    );
    expect(balance.tolerance).toBe(BALANCE_TOLERANCE);
    // The type shares are compared too: fake_shop was wanted at half the lures and has none.
    expect(balance.type_share_gap.fake_shop).toBeGreaterThan(0.4);
    expect(balance.within_tolerance).toBe(false);
    expect(balanceOf(built, built)).toMatchObject({ share_gap: 0, within_tolerance: true });
  });

  it("calls a seed unmet on a type-only gap and on a training-only gap, independently", () => {
    const base = {
      train: 100,
      eval: 100,
      dropped: 0,
      lure_share_eval: 0.5,
      lure_share_train: 0.5,
      cross_brand: 0,
      cross_site: 0,
      near_duplicate_eval_pages: 0,
      lure_types: { train: { credential: 50, fake_shop: 50 }, eval: { credential: 50, fake_shop: 50 } },
    };
    const typeOnly = { ...base, lure_types: { train: { credential: 50, fake_shop: 50 }, eval: { credential: 100 } } };
    expect(balanceOf(base, typeOnly).within_tolerance).toBe(false);
    expect(balanceOf(base, typeOnly).share_gap).toBe(0);
    const trainOnly = { ...base, lure_share_train: 0.7 };
    expect(balanceOf(base, trainOnly).within_tolerance).toBe(false);
    expect(balanceOf(base, trainOnly).train_share_gap).toBeCloseTo(0.2);
    const trainTypeOnly = {
      ...base,
      lure_types: { train: { credential: 100 }, eval: { credential: 50, fake_shop: 50 } },
    };
    expect(balanceOf(base, trainTypeOnly).within_tolerance).toBe(false);
    expect(balanceOf(base, base).within_tolerance).toBe(true);
  });

  it("the stratified baseline matches lure-type shares, not only the lure share", () => {
    const typed = (id: string, brand: string, lure: boolean, type: string | null, n: number): Page => ({
      ...page(id, brand, `${brand}.com`, lure, BigInt(n) << 9n, n),
      lureType: type,
    });
    const pages: Page[] = [];
    let n = 0;
    for (let b = 0; b < 20; b++)
      for (let k = 0; k < 2; k++) pages.push(typed(`cred${b}-${k}`, `Cred${b}`, true, "credential", n++));
    for (let b = 0; b < 20; b++)
      for (let k = 0; k < 2; k++) pages.push(typed(`shop${b}-${k}`, `Shop${b}`, true, "fake_shop", n++));
    for (let b = 0; b < 20; b++) pages.push(typed(`ok${b}`, `Benign${b}`, false, null, n++));
    const sides = stratifiedGroupSplit(pages, seeded(3), 0.3, 0.5, { credential: 0.5, fake_shop: 0.5 });
    const figures = splitFigures(pages, sides);
    const evalTypes = figures.lure_types?.eval ?? {};
    const evalLures = Object.values(evalTypes).reduce((a, b) => a + b, 0);
    expect(Math.abs((evalTypes.credential ?? 0) / evalLures - 0.5)).toBeLessThan(0.15);
    expect(Math.abs((evalTypes.fake_shop ?? 0) / evalLures - 0.5)).toBeLessThan(0.15);
  });

  it("the stratified baseline is deterministic per seed, differs between seeds, and removes a planted twin from training", () => {
    const pages: Page[] = [];
    for (let i = 0; i < 40; i++)
      pages.push(page(`p${i}`, `Brand${i}`, `site${i}.com`, i % 2 === 0, BigInt(i) << 8n, i));
    pages.push({ ...(pages[0] as Page), id: "twin", brand: "TwinBrand", site: "twin.com" });
    const runs = STRATIFIED_SEEDS.map((seed) => stratifiedGroupSplit(pages, seeded(seed), 0.3, 0.5));
    expect([...stratifiedGroupSplit(pages, seeded(STRATIFIED_SEEDS[0]), 0.3, 0.5)]).toEqual([
      ...(runs[0] as Map<string, string>),
    ]);
    expect(new Set(runs.map((r) => JSON.stringify([...r]))).size).toBeGreaterThan(1);
    for (const sides of runs) {
      expect(splitFigures(pages, sides).near_duplicate_eval_pages).toBe(0);
      // p0 and its twin are never split across the sides.
      const sideOf = (id: string) => sides.get(id);
      expect(sideOf("p0") === "eval" && sideOf("twin") === "train").toBe(false);
    }
  });

  it("the group-shuffle split leaves no brand or site across the sides and removes near-duplicate twins", () => {
    const pages: Page[] = [];
    for (let i = 0; i < 60; i++)
      pages.push(page(`p${i}`, `Brand${i % 20}`, `site${i % 15}.com`, i % 2 === 0, BigInt(i) << 8n, i));
    // A twin of p0 under another brand and site: it must not stay in training beside p0 if p0 is held out, or the reverse.
    pages.push({ ...(pages[0] as Page), id: "twin", brand: "TwinBrand", site: "twin.com" });
    const sides = groupShuffleSplit(pages, seeded(7), 0.3);
    const figures = splitFigures(pages, sides);
    // Brands and sites are grouped by brand only, so a site shared across brands can still cross: the figures count it.
    expect(figures.cross_brand).toBe(0);
    expect(figures.near_duplicate_eval_pages).toBe(0);
    expect(figures.eval).toBeGreaterThan(0);
    expect(figures.train).toBeGreaterThan(0);
    // Deterministic for a seed.
    expect([...groupShuffleSplit(pages, seeded(7), 0.3)]).toEqual([...sides]);
  });
});

describe("results and missing inputs", () => {
  it("names a missing input and never reports a completed comparison for it", () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-"));
    try {
      const present = join(dir, "annotations.jsonl");
      writeFileSync(present, "{}\n");
      const inputs = [describeInput("annotations", present), describeInput("labels", join(dir, "labels.jsonl"))];
      expect(inputs[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      const result = incompleteIfMissing("labels", inputs);
      expect(result).toMatchObject({ status: "incomplete", missing: [expect.stringContaining("labels")] });
      writeResult(resultFile(dir, "labels"), result as NonNullable<typeof result>);
      expect(JSON.parse(readFileSync(resultFile(dir, "labels"), "utf-8")).status).toBe("incomplete");
      expect(incompleteIfMissing("labels", [inputs[0] as (typeof inputs)[number]])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the split comparison over a store", () => {
  const build = async (
    dir: string,
    ids: { id: string; side: "train" | "eval"; brand: string; host: string; lure: boolean; shade: number }[],
  ) => {
    mkdirSync(join(dir, "dataset", "1.0"), { recursive: true });
    const meta = (side: string) =>
      ids
        .filter((p) => p.side === side)
        .map((p) => JSON.stringify({ id: p.id }))
        .join("\n");
    writeFileSync(join(dir, "dataset", "1.0", "train.meta.jsonl"), `${meta("train")}\n`);
    writeFileSync(join(dir, "dataset", "1.0", "eval.meta.jsonl"), `${meta("eval")}\n`);
    writeFileSync(
      join(dir, "dataset", "1.0", "summary.json"),
      JSON.stringify({ dropped: { near: 2 }, freeze: { pages: 10 } }),
    );
    for (const p of ids) {
      const folder = join(dir, "pages", p.id);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "meta.json"),
        JSON.stringify({ host: p.host, labels: { brand: p.brand, lure: p.lure } }),
      );
      // A distinct picture per shade: left half dark, right half bright by a different split point.
      const raw = Buffer.alloc(64 * 64, 0);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) raw[y * 64 + x] = x < p.shade ? 20 : 230;
      writeFileSync(
        join(folder, "screenshot.jpg"),
        await sharp(raw, { raw: { width: 64, height: 64, channels: 1 } })
          .jpeg()
          .toBuffer(),
      );
      writeFileSync(join(folder, "text.txt"), Array.from({ length: 30 }, (_, i) => `${p.id}word${i}`).join(" "));
    }
  };

  it("measures a built split against the conventional one over the same pages, and is incomplete when a page is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-split-"));
    try {
      await build(dir, [
        { id: "a", side: "train", brand: "FNB", host: "fnb.co.za", lure: true, shade: 8 },
        { id: "b", side: "train", brand: "Capitec", host: "capitec.co.za", lure: false, shade: 24 },
        { id: "c", side: "eval", brand: "FNB", host: "other.com", lure: true, shade: 40 },
        { id: "d", side: "eval", brand: "Absa", host: "absa.co.za", lure: false, shade: 56 },
      ]);
      const result = await compareSplit(dir);
      expect(result.status).toBe("complete");
      if (result.status !== "complete") return;
      // The planted brand leak (FNB on both sides) is counted in the built split.
      expect(result.figures.built).toMatchObject({ train: 2, eval: 2, cross_brand: 1 });
      expect(result.figures.pages).toBe(4);
      expect(result.figures.eval_share).toBe(0.5);
      expect(result.figures.conventional.cross_brand).toBe(0);
      // The stratified grouped baseline is run at every predefined seed, with its leak witnesses (§39).
      expect(result.figures.stratified.map((x) => x.seed)).toEqual([...STRATIFIED_SEEDS]);
      for (const x of result.figures.stratified) expect(x.figures.cross_brand).toBe(0);
      // Each seed's reported counts are rebuilt from its persisted assignment, dropped pages included.
      for (const x of result.figures.stratified) {
        expect(x.assignment.train).toHaveLength(x.figures.train);
        expect(x.assignment.eval).toHaveLength(x.figures.eval);
        expect([...x.assignment.train, ...x.assignment.eval, ...x.assignment.dropped].sort()).toEqual([
          "a",
          "b",
          "c",
          "d",
        ]);
        expect(x.balance.tolerance).toBe(BALANCE_TOLERANCE);
      }
      expect(result.figures.config.stratified_seeds).toEqual([...STRATIFIED_SEEDS]);
      // The artifact holds every page's side under each split: nothing is recovered by subtraction.
      const a = result.figures.assignments;
      expect([...a.built.train, ...a.built.eval].sort()).toEqual(["a", "b", "c", "d"]);
      expect([...a.conventional.train, ...a.conventional.eval, ...a.conventional.dropped].sort()).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
      expect(result.inputs.every((input) => input.sha256 !== null)).toBe(true);
      // A page the dataset names but the store lacks: incomplete, naming it.
      rmSync(join(dir, "pages", "b"), { recursive: true });
      const partial = await compareSplit(dir);
      expect(partial).toMatchObject({ status: "incomplete", missing: [expect.stringContaining("1 pages unreadable")] });
      // The dataset's own files missing: incomplete too.
      rmSync(join(dir, "dataset"), { recursive: true });
      expect(await compareSplit(dir)).toMatchObject({
        status: "incomplete",
        missing: [
          expect.stringContaining("train.meta.jsonl"),
          expect.stringContaining("eval.meta.jsonl"),
          expect.stringContaining("summary.json"),
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("recording a result", () => {
  const split = {
    status: "complete" as const,
    name: "split-1.0",
    inputs: [{ name: "train.meta.jsonl", path: "p", sha256: "a".repeat(64), bytes: 1 }],
    figures: {
      pages: 100,
      eval_share: 0.1,
      config: {},
      population: { frozen: 120, kept: 100, dropped_before_split: { near: 15 }, unaccounted: 5 },
      witnesses: { built: { brands: [], sites: [], near: [] }, conventional: { brands: [], sites: [], near: [] } },
      assignments: { built: { train: [], eval: [] }, conventional: { train: [], eval: [], dropped: [] } },
      built: {
        train: 90,
        eval: 10,
        dropped: 0,
        lure_share_eval: 0.5,
        cross_brand: 0,
        cross_site: 0,
        near_duplicate_eval_pages: 0,
      },
      stratified: [20261101, 20261102].map((seed, i) => ({
        seed,
        witnesses: { brands: [], sites: [], near: [] },
        balance: {
          share_gap: i * 0.1,
          train_share_gap: 0,
          within_tolerance: i === 0,
          tolerance: 0.05,
          type_share_gap: { credential: 0.01 },
          train_type_share_gap: { credential: 0.02 },
        },
        assignment: { train: [], eval: [], dropped: [] },
        figures: {
          lure_types: { train: { credential: 30 }, eval: { credential: 4 + i, fake_shop: 1 } },
          train: 86 + i,
          eval: 10,
          dropped: 4 - i,
          lure_share_eval: 0.5,
          cross_brand: 0,
          cross_site: 0,
          near_duplicate_eval_pages: i,
        },
      })),
      conventional: {
        train: 85,
        eval: 10,
        dropped: 5,
        lure_share_eval: 0.4,
        cross_brand: 0,
        cross_site: 3,
        near_duplicate_eval_pages: 0,
      },
    },
  };
  it("writes the figures of the result and nothing typed, once per input digest", () => {
    const line = measurementLine(split, "2026-11-01", "f".repeat(64));
    expect(line).toContain("the same 100 pages");
    expect(line).toContain(
      "train 85, eval 10, 5 dropped, eval lure share 40.0%, train lure share n/a, 0 brands, 3 sites",
    );
    expect(line).toContain("train.meta.jsonl aaaaaaaaaaaa");
    // The stratified baseline, every seed, beside §10's (§39).
    expect(line).toContain("Stratified grouped baseline");
    expect(line).toContain("seed 20261101: train 86, eval 10, 4 dropped, eval lure share 50.0%");
    // The balance claim names its tolerance and calls a seed outside it unmet, with the lure types on the eval side.
    expect(line).toContain("within 5 share points");
    expect(line).toContain(
      "share gap 0.0 points, train share gap 0.0 points, eval type gaps credential 1.0, train type gaps credential 2.0 (met)",
    );
    expect(line).toContain("share gap 10.0 points");
    expect(line).toContain("(UNMET)");
    expect(line).toContain("eval lure types credential 4 fake_shop 1");
    expect(line).toContain("train lure types credential 30");
    expect(line).toContain("seed 20261102: train 87, eval 10, 3 dropped");
    const doc = "# T\n\n## Measurements\n\n- old\n\n## Decisions\n";
    const once = recordMeasurement(doc, line) as string;
    expect(once).toContain(line);
    expect(once.indexOf(line)).toBeLessThan(once.indexOf("- old"));
    // The same inputs write nothing more; a changed input writes a new line.
    expect(recordMeasurement(once, line)).toBeNull();
    const changed = { ...split, inputs: [{ name: "train.meta.jsonl", path: "p", sha256: "b".repeat(64), bytes: 1 }] };
    expect(recordMeasurement(once, measurementLine(changed, "2026-11-02", "e".repeat(64)))).not.toBeNull();
  });
  it("records an incomplete result as incomplete, with what is missing", () => {
    const line = measurementLine(
      {
        status: "incomplete",
        name: "labels",
        inputs: [{ name: "annotations", path: "x", sha256: null, bytes: null }],
        missing: ["annotations (x)"],
      },
      "2026-11-01",
      "d".repeat(64),
    );
    expect(line).toContain("INCOMPLETE");
    expect(line).toContain("annotations (x)");
    expect(line).toContain("annotations missing");
  });
});

describe("the command line", () => {
  it("takes one command, and --check only on a comparison", () => {
    expect(parseArgs(["labels"])).toEqual({ command: "labels", check: false });
    expect(parseArgs(["split", "--check"])).toEqual({ command: "split", check: true });
    expect(parseArgs(["sample", "--check"])).toBeNull();
    expect(parseArgs(["report", "--check"])).toBeNull();
    expect(parseArgs(["labels", "--force"])).toBeNull();
    expect(parseArgs(["labels", "--check", "x"])).toBeNull();
    expect(parseArgs([])).toBeNull();
  });
});

describe("annotations and membership are validated", () => {
  const sample = ["a", "b"];
  const full = (id: string): Annotation => ({ id, brand: "X", lure_type: "none", lure: false });
  it("wants exactly one complete annotation per sampled page", () => {
    expect(validateAnnotations(sample, [full("a"), full("b")])).toEqual([]);
    expect(validateAnnotations(sample, [full("a")])).toEqual([expect.stringContaining("no annotation")]);
    expect(validateAnnotations(sample, [full("a"), full("a"), full("b")])).toEqual([
      expect.stringContaining("more than once"),
    ]);
    // A typo in a lure type is not a judgement: only the store's types, `unknown` and `disputed` are.
    expect(validateAnnotations(sample, [full("a"), { ...full("b"), lure_type: "credentail" }])).toEqual([
      expect.stringContaining("do not judge every field"),
    ]);
    expect(validateAnnotations(sample, [full("a"), { id: "b" }])).toEqual([
      expect.stringContaining("do not judge every field"),
    ]);
    expect(validateAnnotations(sample, [full("a"), { ...full("b"), lure: "maybe" as unknown as boolean }])).toEqual([
      expect.stringContaining("do not judge every field"),
    ]);
  });
  it("rejects an empty side, an id on both sides, and malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-membership-"));
    try {
      mkdirSync(join(dir, "dataset", "1.0"), { recursive: true });
      const write = (train: string, evaluation: string) => {
        writeFileSync(join(dir, "dataset", "1.0", "train.meta.jsonl"), train);
        writeFileSync(join(dir, "dataset", "1.0", "eval.meta.jsonl"), evaluation);
      };
      write('{"id":"a"}\n', "");
      expect(builtMembership(dir, "1.0").problems).toEqual([expect.stringContaining("eval.meta.jsonl holds no pages")]);
      write('{"id":"a"}\n{"id":"b"}\n', '{"id":"b"}\n');
      expect(builtMembership(dir, "1.0").problems).toEqual([
        expect.stringContaining("1 ids are on both sides, first b"),
      ]);
      write("not json\n", '{"id":"b"}\n');
      expect(builtMembership(dir, "1.0").problems[0]).toContain("malformed");
      write('{"id":"a"}\n', '{"id":"b"}\n');
      expect(builtMembership(dir, "1.0").problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("witnesses name the pages behind a figure", () => {
  it("names the brand, site and near-duplicate pages across the sides", () => {
    const w = (n: number) => shingles(Array.from({ length: 40 }, (_, i) => `w${n}x${i}`).join(" "));
    const pages: Page[] = [
      { id: "t1", brand: "FNB", site: "a.com", lure: true, hash: 0n, words: w(1) },
      { id: "e1", brand: "FNB", site: "b.com", lure: true, hash: 1n << 30n, words: w(2) },
      { id: "e2", brand: "Z", site: "a.com", lure: false, hash: 1n << 50n, words: w(3) },
      { id: "e3", brand: "Y", site: "c.com", lure: false, hash: 0n, words: w(1) },
    ];
    const sides = new Map<string, "train" | "eval">([
      ["t1", "train"],
      ["e1", "eval"],
      ["e2", "eval"],
      ["e3", "eval"],
    ]);
    const witnesses = leakWitnesses(pages, sides);
    expect(witnesses.brands).toEqual([{ brand: "fnb", eval: ["e1"], train: ["t1"] }]);
    expect(witnesses.sites).toEqual([{ site: "a.com", eval: ["e2"], train: ["t1"] }]);
    expect(witnesses.near).toEqual([{ eval: "e3", train: "t1" }]);
  });
});

describe("the labels comparison over a store, and checking a saved result", () => {
  const store = async (dir: string) => {
    mkdirSync(join(dir, "raw", "dataset"), { recursive: true });
    mkdirSync(join(dir, "runs", "compare"), { recursive: true });
    const ids = Array.from({ length: 60 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    writeFileSync(
      join(dir, "raw", "dataset", "reference.json"),
      JSON.stringify({ seed: 1, size: 60, drawn_from: "x", pages: ids }),
    );
    for (const id of ids) {
      const folder = join(dir, "pages", id);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "meta.json"),
        JSON.stringify({
          labels: { brand: "Brand", lure: false, lure_type: "none" },
          label_source: { brand: "rule", lure: "ground-truth", lure_type: "ground-truth" },
        }),
      );
      writeFileSync(join(folder, "screenshot.jpg"), "jpg");
      writeFileSync(join(folder, "text.txt"), "text");
    }
    return annotationSample(dir);
  };
  const annotate = (dir: string, ids: string[], brand: string) =>
    writeFileSync(
      join(dir, "runs", "compare", "annotations.jsonl"),
      `${ids.map((id) => JSON.stringify({ id, brand, lure_type: "none", lure: false })).join("\n")}\n`,
    );

  it("scores per page, pins the pages, and goes stale when a page changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-labels-"));
    try {
      const ids = await store(dir);
      expect(compareLabels(dir)).toMatchObject({
        status: "incomplete",
        missing: [expect.stringContaining("annotations")],
      });
      annotate(dir, ids.slice(1), "Brand");
      expect(compareLabels(dir)).toMatchObject({
        status: "incomplete",
        missing: [expect.stringContaining("1 sampled pages have no annotation")],
      });
      annotate(dir, ids, "Other");
      const result = compareLabels(dir);
      expect(result.status).toBe("complete");
      if (result.status !== "complete") return;
      // Every page is wrong on brand, right on lure type and lure; the per-page outcomes say so.
      expect(result.figures.sets.finished?.brand).toMatchObject({ wrong: 40, retained: 40 });
      expect(result.figures.pages).toHaveLength(40);
      // An input that cannot be read is incomplete, naming why, never an error (a directory where a file belongs).
      rmSync(join(dir, "runs", "compare", "annotations.jsonl"));
      mkdirSync(join(dir, "runs", "compare", "annotations.jsonl"));
      expect(compareLabels(dir)).toMatchObject({
        status: "incomplete",
        missing: [expect.stringContaining("unreadable")],
      });
      rmSync(join(dir, "runs", "compare", "annotations.jsonl"), { recursive: true });
      annotate(dir, ids, "Other");
      expect(result.figures.pages[0]?.outcomes.finished).toEqual({ brand: "wrong", lure_type: "right", lure: "right" });
      expect(result.figures.pages[0]?.outcomes.source).toEqual({
        brand: "unretained",
        lure_type: "right",
        lure: "right",
      });
      expect(result.inputs.some((i) => i.name.startsWith("page files"))).toBe(true);
      writeResult(resultFile(dir, "labels"), result);
      expect(checkResult(dir, "labels")).toEqual({ name: "labels", status: "current", changed: [] });
      // A repaired page, a changed annotation: stale, naming what changed.
      writeFileSync(join(dir, "pages", ids[0] as string, "text.txt"), "changed");
      expect(checkResult(dir, "labels")).toMatchObject({
        status: "stale",
        changed: [expect.stringContaining("page files")],
      });
      expect(checkResult(dir, "split-1.0").status).toBe("missing");
      // A saved incomplete comparison is never current, though its inputs are unchanged (round 2).
      const incomplete = { ...result, status: "incomplete", missing: ["a sampled page is missing"] };
      writeResult(resultFile(dir, "labels"), incomplete as never);
      expect(checkResult(dir, "labels")).toMatchObject({
        status: "stale",
        changed: [expect.stringContaining("the saved result is incomplete: a sampled page is missing")],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is incomplete for a sampled page that is missing, and report refuses while a result is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-report-"));
    try {
      const ids = await store(dir);
      annotate(dir, ids, "Brand");
      rmSync(join(dir, "pages", ids[3] as string), { recursive: true });
      expect(compareLabels(dir)).toMatchObject({
        status: "incomplete",
        missing: [expect.stringContaining("1 sampled pages cannot be read")],
      });
      expect(() => report(dir, "## Measurements\n", "2026-11-01")).toThrow(/no result for labels, split-1.0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
