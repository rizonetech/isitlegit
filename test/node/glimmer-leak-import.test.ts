import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sampleReadiness } from "../../scripts/glimmer/build-dataset.ts";
import {
  leakCheck,
  leakCheckProblem,
  opaqueId,
  redactionKey,
  redactionState,
  runImport,
  SOURCES,
  systemOcr,
} from "../../scripts/glimmer/import-samples.ts";
import { ENTITY_CONFIG, hasImages } from "../../scripts/glimmer/redact.ts";
import { openStore } from "../../scripts/glimmer/store.ts";
import {
  dir,
  message,
  misses,
  noText,
  render,
  rendered,
  samplesDir,
  sourceStatus,
  useSamples,
  words,
} from "./helpers/glimmer-samples.ts";

// scripts/glimmer/import-samples.ts (D03 T04 §7), end to end on synthetic mail: every message accounted for, pages
// stored redacted under opaque ids, labels reconciled, a changed redaction remaking every page, an interrupted rebuild
// never standing, and the leak check failing on what the redaction missed. Split from glimmer-leak.test.ts so the
// files run on parallel workers.
useSamples();

describe("the sample import, end to end", () => {
  it("accounts for every message, stores redacted pages under opaque ids, and reconciles labels", async () => {
    const samples = samplesDir();
    const store = openStore(join(dir, "store"));
    rendered.length = 0;
    const first = await runImport({ entities: misses, samples, store, render, maxBytes: 64 * 1024 });
    // The unreadable and the oversized message keep the run incomplete: nothing is published as done.
    expect(first.code).toBe(1);
    expect(first.inventory).toMatchObject({ messages: 16 });
    expect(first.inventory.failed).toEqual(
      expect.arrayContaining([
        { id: opaqueId("client/9_HighConfPhish.eml"), reason: "unreadable (EACCES)" },
        { id: opaqueId("client/14_HighConfPhish.eml"), reason: "over 0.06 MB" },
      ]),
    );
    expect(first.inventory.excluded).toEqual([
      { id: opaqueId("client/4_Spam.eml"), reason: "a Spam verdict: neither a lure nor benign" },
    ]);
    expect(redactionState(store)).toMatchObject({ key: null });
    for (const source of Object.values(SOURCES)) expect(sourceStatus(store, source)).toBe("incomplete");
    expect((await leakCheck({ entities: misses, samples, store, ocr: noText })).problems).toContain(
      "the stored pages were not all made under the current redaction",
    );
    // Nothing rendered held a picture, vector art or generated text.
    expect(rendered.length).toBeGreaterThan(0);
    for (const html of rendered) expect(hasImages(html)).toBe(false);

    const pages = store.manifest().filter((p) => p.origin === "samples");
    for (const page of pages) {
      const { screenshot, text } = store.readPage(page.id);
      expect(screenshot.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/thandi|merwe|vdmerwe|ndlovu|acme|anne/i);
      expect(page.redacted).toBe(true);
      expect(page.item).toMatch(/^m-[0-9a-f]{16}#(attachment|body)\d$/);
    }
    const byText = (needle: string) => pages.filter((p) => store.readPage(p.id).text.includes(needle));
    // The Windows-1252 attachment reads as written, its encoded name redacted; the windows-1251 one by its MIME charset.
    expect(byText("Café invoice")[0]?.labels.has_login_form).toBe(true);
    expect(byText("Привет")).toHaveLength(1);
    // The plain-text body is a page too.
    expect(byText("SARS refund")).toHaveLength(1);
    // Identical pages from a Phish and a HighConfPhish message keep the stronger label, whichever came first.
    expect(byText("act now")[0]?.label_source.lure).toBe("ground-truth");
    // The same page as one message's body and another's attachment: both take the stronger label.
    const shared = byText("Shared page");
    expect(shared).toHaveLength(2);
    for (const page of shared) expect(page.label_source.lure).toBe("ground-truth");
    // Identical pages from a genuine and a phishing message keep no lure label.
    expect(byText("labelled two ways")[0]?.labels.lure).toBeUndefined();
    // A short name is redacted on every page, its own message's and another's.
    expect(byText("Dear [name], Your FNB")).toHaveLength(1);
    expect(byText("[name] from FNB will help")).toHaveLength(1);
    // The page whose phone number only the render joined up was refused, by kind, never by the number.
    const bodies = JSON.parse(readFileSync(join(store.dir, "raw", SOURCES.body, "IMPORT.json"), "utf-8"));
    expect(bodies.excluded).toEqual([
      { item: `${opaqueId("client/6_HighConfPhish.eml")}#body0`, reason: "refused: a phone number survived redaction" },
    ]);
    // A message with only a PDF is accounted for as an unsupported part and no body.
    const pdfOnly = first.inventory.outcomes.find((o) => o.id === opaqueId("client/15_HighConfPhish.eml"));
    expect(pdfOnly?.parts).toEqual([{ unsupported: "application/pdf" }, { none: true }]);

    // With the unreadable and oversized messages gone, the import completes and the leak check passes.
    rmSync(join(samples, "client", "9_HighConfPhish.eml"), { recursive: true });
    rmSync(join(samples, "client", "14_HighConfPhish.eml"));
    // Its refusal is one page in fourteen here, over the 5 percent an import may exclude.
    rmSync(join(samples, "client", "6_HighConfPhish.eml"));
    expect((await runImport({ entities: misses, samples, store, render })).code).toBe(0);
    for (const source of Object.values(SOURCES)) expect(sourceStatus(store, source)).toBe("complete");
    expect(await leakCheck({ entities: misses, samples, store, ocr: noText })).toMatchObject({
      code: 0,
      hits: 0,
      unaccounted: 0,
      problems: [],
    });
  }, 240_000);

  it("resumes a rebuild that failed part-way, keeping its finished pages", async () => {
    const samples = samplesDir(["1_", "4_", "5_", "11_"]);
    rmSync(join(samples, "client", "9_HighConfPhish.eml"), { recursive: true, force: true });
    rmSync(join(samples, "client", "6_HighConfPhish.eml"), { recursive: true, force: true });
    const store = openStore(join(dir, "store"));
    expect((await runImport({ entities: misses, samples, store, render })).code).toBe(0);
    const key = redactionState(store).key;
    // A new client name: the earlier pages go; a rebuild that fails on one page records only that it is building.
    writeFileSync(join(samples, "client-names.txt"), "Acme Holdings\nFNB Online\n");
    const lines: string[] = [];
    let calls = 0;
    const flaky = async (html: string) => {
      calls++;
      if (html.includes("SARS refund")) throw new Error("render failed");
      return render(html);
    };
    expect((await runImport({ entities: misses, samples, store, render: flaky, log: (l) => lines.push(l) })).code).toBe(
      1,
    );
    expect(lines.some((l) => /earlier pages removed/.test(l))).toBe(true);
    const building = redactionState(store);
    expect(building.key).toBeNull();
    expect(building.building).not.toBe(key);
    // The next run resumes it: only what is not yet stored is rendered again, and the key is recorded.
    const before = calls;
    const again: string[] = [];
    const counted = async (html: string) => {
      again.push(html);
      return render(html);
    };
    expect(
      (await runImport({ entities: misses, samples, store, render: counted, log: (l) => lines.push(l) })).code,
    ).toBe(0);
    expect(lines.some((l) => /resuming the rebuild/.test(l))).toBe(true);
    expect(redactionState(store)).toMatchObject({ key: building.building, building: null });
    // The pages stored before the failure are skipped: fewer renders than the first attempt, the failed one among them.
    expect(again.length).toBeLessThan(before);
    expect(again.some((html) => html.includes("SARS refund"))).toBe(true);
  }, 240_000);

  it("makes every page again when a message's bytes change, and stops a parse at its deadline", async () => {
    const samples = samplesDir(["1_", "4_"]);
    for (const name of ["9_HighConfPhish.eml", "14_HighConfPhish.eml", "6_HighConfPhish.eml"])
      rmSync(join(samples, "client", name), { recursive: true, force: true });
    const store = openStore(join(dir, "store"));
    expect((await runImport({ entities: misses, samples, store, render })).code).toBe(0);
    writeFileSync(join(samples, "client", "4_Spam.eml"), message(`<p>${words} Changed.</p>`));
    const lines: string[] = [];
    expect((await runImport({ entities: misses, samples, store, render, log: (l) => lines.push(l) })).code).toBe(0);
    expect(lines.some((l) => /earlier pages removed/.test(l))).toBe(true);
    // A deadline no parse can meet: every message is late, recorded, and the run is incomplete.
    const late = await runImport({ entities: misses, samples, store, render, parseMs: 1 });
    expect(late.code).toBe(1);
    expect(late.inventory.failed.length).toBeGreaterThan(0);
    expect(late.inventory.failed.every((f) => f.reason === "not parsed within 0.001 seconds")).toBe(true);
  }, 240_000);

  it("stops the old pages counting before it removes any", async () => {
    const samples = samplesDir(["4_", "11_"]);
    for (const name of ["9_HighConfPhish.eml", "14_HighConfPhish.eml", "6_HighConfPhish.eml"])
      rmSync(join(samples, "client", name), { recursive: true, force: true });
    const store = openStore(join(dir, "store"));
    expect((await runImport({ entities: misses, samples, store, render })).code).toBe(0);
    writeFileSync(join(samples, "client-names.txt"), "Acme Holdings\nFNB Online\n");
    const dying = {
      ...store,
      removeSource: () => {
        throw new Error("killed during the removal");
      },
    } as typeof store;
    await expect(runImport({ entities: misses, samples, store: dying, render })).rejects.toThrow(/killed/);
    for (const source of Object.values(SOURCES)) expect(sourceStatus(store, source)).toBe("running");
    expect(redactionState(store)).toMatchObject({ key: null, cleaned: false });
    // The retry removes the old pages again before it skips anything, so none made under the old rules survives.
    const lines: string[] = [];
    expect((await runImport({ entities: misses, samples, store, render, log: (l) => lines.push(l) })).code).toBe(0);
    expect(lines.some((l) => /earlier pages removed/.test(l))).toBe(true);
    for (const page of store.manifest().filter((p) => p.origin === "samples"))
      expect(store.readPage(page.id).text).not.toMatch(/FNB Online/);
    expect(redactionState(store)).toMatchObject({ building: null, cleaned: true });
  }, 240_000);

  it("publishes nothing as complete when a step after the import fails", async () => {
    const samples = samplesDir(["7_", "8_"]);
    rmSync(join(samples, "client", "9_HighConfPhish.eml"), { recursive: true, force: true });
    rmSync(join(samples, "client", "14_HighConfPhish.eml"), { recursive: true, force: true });
    rmSync(join(samples, "client", "6_HighConfPhish.eml"), { recursive: true, force: true });
    const store = openStore(join(dir, "store"));
    const broken = {
      ...store,
      setLabels: () => {
        throw new Error("disk full");
      },
    } as typeof store;
    await expect(runImport({ entities: misses, samples, store: broken, render })).rejects.toThrow(/disk full/);
    for (const source of Object.values(SOURCES)) expect(sourceStatus(store, source)).toBe("running");
    expect(redactionState(store).key).toBeNull();
  }, 240_000);

  it("finds a client detail in a page, a screenshot or a record, and refuses to check without consent", async () => {
    const samples = samplesDir(["1_", "4_"]);
    rmSync(join(samples, "client", "9_HighConfPhish.eml"), { recursive: true, force: true });
    rmSync(join(samples, "client", "14_HighConfPhish.eml"), { recursive: true, force: true });
    rmSync(join(samples, "client", "6_HighConfPhish.eml"), { recursive: true, force: true });
    const store = openStore(join(dir, "store"));
    expect((await runImport({ entities: misses, samples, store, render })).code).toBe(0);
    // A screenshot whose picture shows a name the text does not.
    expect(
      await leakCheck({
        entities: misses,
        samples,
        store,
        ocr: async (s) => s.map((_, i) => (i === 0 ? "Dear Thandi" : "")),
      }),
    ).toMatchObject({ code: 1 });
    // A screenshot that shows a phone number.
    expect(
      (
        await leakCheck({
          entities: misses,
          samples,
          store,
          ocr: async (s) => s.map((_, i) => (i === 0 ? "Call 082 555 1234" : "")),
        })
      ).problems,
    ).toContain(
      "1 pages or screenshots show an address, phone, long number, street address, post box, postal code, signed name or town",
    );
    // No OCR engine: the screenshots are unchecked, so the check fails.
    expect(
      (
        await leakCheck({
          entities: misses,
          samples,
          store,
          ocr: async () => Promise.reject(new Error("no OCR engine")),
        })
      ).code,
    ).toBe(1);
    // A record that names a client, and one that names a client folder.
    const record = join(store.dir, "raw", SOURCES.body, "IMPORT.json");
    const saved = readFileSync(record, "utf-8");
    writeFileSync(record, saved.replace('"status"', '"note": "for Thandi", "status"'));
    expect((await leakCheck({ entities: misses, samples, store, ocr: noText })).hits).toBeGreaterThan(0);
    writeFileSync(record, saved.replace('"status"', '"note": "client/1_HighConfPhish.eml", "status"'));
    expect((await leakCheck({ entities: misses, samples, store, ocr: noText })).hits).toBeGreaterThan(0);
    writeFileSync(record, saved);
    // A stored screenshot replaced by another picture, and a page record that no longer reads.
    const page = store.manifest().find((p) => p.origin === "samples") as { id: string };
    const shotFile = join(store.dir, "pages", page.id, "screenshot.jpg");
    const kept = readFileSync(shotFile);
    writeFileSync(
      shotFile,
      await sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } })
        .jpeg()
        .toBuffer(),
    );
    expect((await leakCheck({ entities: misses, samples, store, ocr: noText })).problems).toContain(
      "1 pages' files no longer match their records",
    );
    writeFileSync(shotFile, kept);
    const metaFile = join(store.dir, "pages", page.id, "meta.json");
    const keptMeta = readFileSync(metaFile, "utf-8");
    writeFileSync(metaFile, "{ broken");
    expect((await leakCheck({ entities: misses, samples, store, ocr: noText })).problems).toContain(
      "a page's record does not read",
    );
    writeFileSync(metaFile, keptMeta);
    // A planted page that keeps a name, and a page no part accounts for.
    const jpeg = new Uint8Array(
      await sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } })
        .jpeg()
        .toBuffer(),
    );
    await store.putPage(SOURCES.body, {
      screenshot: jpeg,
      text: "Dear Thandi, your account is on hold.",
      origin: "samples",
      licence: "x",
      host: null,
      template: null,
      south_africa: true,
      labels: { lure: true },
      label_source: { lure: "ground-truth" },
      redacted: true,
    });
    const planted = await leakCheck({ entities: misses, samples, store, ocr: noText });
    expect(planted.code).toBe(1);
    expect(planted.problems).toContain("1 stored pages are no part's");
    rmSync(join(samples, "pilot-consent.md"));
    await expect(leakCheck({ entities: misses, samples, store, ocr: noText })).rejects.toThrow(/refused/);
  }, 240_000);

  // §19, plan review finding 4: what the entity pass finds is covered by admission and the leak check, and so is every
  // screenshot, read whole.
  it("changes the key when either requirements file changes", () => {
    const samples = samplesDir();
    const scripts = join(dir, "scripts");
    mkdirSync(scripts);
    const real = join(import.meta.dirname, "../../scripts/glimmer");
    for (const name of ["requirements-entities.txt", "requirements-ocr.txt", "pins.py"])
      writeFileSync(join(scripts, name), readFileSync(join(real, name)));
    const base = redactionKey(samples, undefined, ENTITY_CONFIG, scripts);
    expect(redactionKey(samples, undefined, ENTITY_CONFIG, scripts)).toBe(base);
    const keys = [base];
    for (const [name, from, to] of [
      ["requirements-entities.txt", "\nspacy==3.8.18\n", "\nspacy==3.9.0\n"],
      ["requirements-ocr.txt", "\nonnxruntime==1.31.1\n", "\nonnxruntime==1.32.0\n"],
    ] as const) {
      const file = join(scripts, name);
      const pinned = readFileSync(file, "utf8");
      expect(pinned).toContain(from);
      writeFileSync(file, pinned.replace(from, to));
      keys.push(redactionKey(samples, undefined, ENTITY_CONFIG, scripts));
    }
    // The brands a line signed for a business may name decide what is kept (§19 round 3).
    writeFileSync(join(scripts, "label-rules.ts"), "export const KNOWN_BRANDS = [];\n");
    keys.push(redactionKey(samples, undefined, ENTITY_CONFIG, scripts));
    expect(new Set(keys).size).toBe(4);
    // The default is this directory's own files.
    expect(redactionKey(samples)).toBe(redactionKey(samples, undefined, ENTITY_CONFIG, real));
  });

  // An OCR venv whose installed versions are not the pins refuses by name, before it reads a screenshot.
  it("refuses an OCR environment that is not the one requirements-ocr.txt pins", async () => {
    const venv = join(dir, "ocr");
    expect(spawnSync("python3", ["-I", "-m", "venv", "--without-pip", venv]).status).toBe(0);
    const site = spawnSync(
      join(venv, "bin", "python"),
      ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
      {
        encoding: "utf8",
      },
    ).stdout.trim();
    // Every pinned package installed at its pin (metadata alone), onnxruntime one release on.
    const pins = readFileSync(join(import.meta.dirname, "../../scripts/glimmer/requirements-ocr.txt"), "utf8")
      .split("\n")
      .filter((line) => /^[A-Za-z0-9]/.test(line))
      .map((line) => line.split("=="));
    const install = (versions: Record<string, string>) => {
      for (const [name, version] of pins) {
        const info = join(site, `${(name as string).replace(/-/g, "_")}-0.dist-info`);
        mkdirSync(info, { recursive: true });
        writeFileSync(
          join(info, "METADATA"),
          `Metadata-Version: 2.1\nName: ${name}\nVersion: ${versions[name as string] ?? version}\n`,
        );
      }
    };
    const was = process.env.GLIMMER_OCR_PYTHON;
    process.env.GLIMMER_OCR_PYTHON = join(venv, "bin", "python");
    try {
      install({ onnxruntime: "1.32.0" });
      await expect(systemOcr([join(dir, "none.png")])).rejects.toThrow(
        /^the OCR engine refused: the environment does not match requirements-ocr\.txt \(onnxruntime is 1\.32\.0, pinned 1\.31\.1\)$/,
      );
      // At every pin it starts, and fails on the missing screenshot instead (it has no engine to read one with).
      install({});
      await expect(systemOcr([join(dir, "none.png")])).rejects.toThrow(/^the OCR engine failed \(exit code 1\)$/);
    } finally {
      if (was === undefined) delete process.env.GLIMMER_OCR_PYTHON;
      else process.env.GLIMMER_OCR_PYTHON = was;
    }
  });

  // §19, plan review finding 7: everything that decides the redaction is in its key.
  it("remakes every page on a model-only or configuration-only change, and an interrupted rebuild never stands", async () => {
    const samples = samplesDir(["1_", "4_", "5_"]);
    for (const name of ["9_HighConfPhish.eml", "14_HighConfPhish.eml", "6_HighConfPhish.eml"])
      rmSync(join(samples, "client", name), { recursive: true, force: true });
    const base = redactionKey(samples);
    const model = { ...ENTITY_CONFIG, model: { ...ENTITY_CONFIG.model, sha256: "0".repeat(64) } };
    const off = { ...ENTITY_CONFIG, on: !ENTITY_CONFIG.on };
    const slower = { ...ENTITY_CONFIG, limits: { ...ENTITY_CONFIG.limits, seconds: ENTITY_CONFIG.limits.seconds + 1 } };
    const keys = [base, ...[model, off, slower].map((config) => redactionKey(samples, undefined, config))];
    expect(new Set(keys).size).toBe(4);
    expect(redactionKey(samples, undefined, { ...ENTITY_CONFIG })).toBe(base);

    const store = openStore(join(dir, "store"));
    let renders = 0;
    const counted = async (html: string) => {
      renders++;
      return render(html);
    };
    expect((await runImport({ entities: misses, samples, store, render: counted })).code).toBe(0);
    const made = renders;
    const pages = store.manifest().filter((p) => p.origin === "samples").length;
    expect(await leakCheck({ entities: misses, samples, store, ocr: noText })).toMatchObject({ code: 0 });
    expect(leakCheckProblem(store, redactionKey(samples))).toBeNull();
    // Before any import, the clean verdict is checked against the redaction the code and configuration give now: a
    // changed model digest makes it stand for nothing, though the stored pages and the verdict still agree (gap 4).
    expect(leakCheckProblem(store, keys[1] as string)).toBe(
      "the sample leak check ran under another redaction than the current one: import, then leak-check again",
    );
    // The model's digest alone changes: every earlier page is removed and every page rendered again.
    const lines: string[] = [];
    renders = 0;
    const remade = await runImport({
      entities: { ...misses, config: model },
      samples,
      store,
      render: counted,
      log: (l) => lines.push(l),
    });
    expect(remade.code).toBe(0);
    expect(lines.some((l) => new RegExp(`${pages} earlier pages removed`).test(l))).toBe(true);
    expect(renders).toBe(made);
    expect(redactionState(store).key).toBe(keys[1]);
    // The earlier clean verdict stands for nothing now, and a check under the old configuration fails.
    expect(leakCheckProblem(store, redactionKey(samples, undefined, model))).toBe(
      "the sample leak check ran under another redaction than the stored pages'",
    );
    expect((await leakCheck({ entities: misses, samples, store, ocr: noText })).problems).toContain(
      "the stored pages were not all made under the current redaction",
    );
    expect(await leakCheck({ entities: { ...misses, config: model }, samples, store, ocr: noText })).toMatchObject({
      code: 0,
    });
    // A configuration-only change whose rebuild fails part-way: the key is not recorded, and nothing stands as current.
    const flaky = async (html: string) => {
      if (html.includes("SARS refund")) throw new Error("render failed");
      return render(html);
    };
    lines.length = 0;
    expect(
      (
        await runImport({
          entities: { ...misses, config: slower },
          samples,
          store,
          render: flaky,
          log: (l) => lines.push(l),
        })
      ).code,
    ).toBe(1);
    expect(lines.some((l) => /earlier pages removed/.test(l))).toBe(true);
    expect(redactionState(store)).toMatchObject({ key: null, building: keys[3] });
    expect(leakCheckProblem(store, redactionKey(samples, undefined, slower))).toBe(
      "the sample leak check ran under another redaction than the stored pages'",
    );
    const interrupted = await leakCheck({ entities: { ...misses, config: slower }, samples, store, ocr: noText });
    expect(interrupted.problems).toContain("the stored pages were not all made under the current redaction");
    expect(leakCheckProblem(store, redactionKey(samples, undefined, slower))).toBe(
      "the sample leak check is not clean",
    );
    // The dataset build reads the same verdict: no sample page enters while the rebuild stands unfinished.
    expect(sampleReadiness(store, { samples, config: slower })).toEqual(
      expect.arrayContaining(["the sample leak check is not clean"]),
    );
  }, 240_000);
});
