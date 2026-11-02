import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPORT_COMMAND,
  LEAK_CHECK_COMMAND,
  leakCheck,
  leakCheckFile,
  leakCheckProblem,
  leakReport,
  readClientNames,
  recordText,
  redactionKey,
  runImport,
} from "../../scripts/glimmer/import-samples.ts";
import { applyRules, readExcluded } from "../../scripts/glimmer/label-rules.ts";
import type { EntityPass } from "../../scripts/glimmer/redact.ts";
import { openStore } from "../../scripts/glimmer/store.ts";
import {
  dir,
  finding,
  message,
  misses,
  noText,
  render,
  samplesDir,
  useSamples,
  words,
} from "./helpers/glimmer-samples.ts";

// scripts/glimmer/import-samples.ts (D03 T04 §7): the leak check fails on a name the redaction pass missed, on a
// refusing pass and on an OCR failure, and its report names the page without its personal content. Split from
// glimmer-leak-import.test.ts so the files run on parallel workers.
useSamples();

describe("the record text the entity pass reads", () => {
  // Neighbouring fields are not one text: fragments of two ("dom", "dom") read as a name on a bare join,
  // which flagged every eligible sample record (measured 2026-11-02). Each value stands as its own sentence.
  it("closes each record value as its own sentence", () => {
    expect(recordText('{"a":"dom","b":"dom","c":"ground-truth"}')).toBe("dom\n.\ndom\n.\nground-truth");
    expect(recordText('{"a":"Hendrik Grobbelaar"}')).toBe("Hendrik Grobbelaar");
    // A content digest is not record content: the pass read stored hashes as a person or a place.
    expect(recordText(`{"sha256":{"screenshot":"${"a".repeat(64)}"},"b":"dom"}`)).toBe("dom");
  });
});

describe("the sample import, end to end", () => {
  it("fails the leak check on an unknown name the redaction pass missed, on a refusing pass, and on an OCR failure", async () => {
    const samples = samplesDir(["1_", "4_"]);
    for (const name of ["9_HighConfPhish.eml", "14_HighConfPhish.eml", "6_HighConfPhish.eml"])
      rmSync(join(samples, "client", name), { recursive: true, force: true });
    // A name no header or list gives, which the redaction's pass is made to miss.
    writeFileSync(
      join(samples, "client", "17_HighConfPhish.eml"),
      message(`<p>${words}</p><p>Please phone Hendrik Grobbelaar in Accounts today.</p>`),
    );
    const store = openStore(join(dir, "store"));
    expect((await runImport({ entities: misses, samples, store, render })).code).toBe(0);
    const missed = store
      .manifest()
      .filter((p) => p.origin === "samples" && store.readPage(p.id).text.includes("Grobbelaar"));
    expect(missed).toHaveLength(1);
    // A pass that misses it too passes the check, and the clean verdict stands for these pages.
    expect(await leakCheck({ entities: misses, samples, store, ocr: noText })).toMatchObject({ code: 0, problems: [] });
    expect(leakCheckProblem(store, redactionKey(samples))).toBeNull();
    // The check's own pass finds it: the check fails, and the clean verdict is withdrawn.
    const found = await leakCheck({ entities: { pass: finding(["Hendrik Grobbelaar"]) }, samples, store, ocr: noText });
    expect(found.code).toBe(1);
    expect(found.problems).toEqual(["1 pages, records or screenshots name a person or place the entity pass found"]);
    // The failure names the page by its opaque id and the representation that failed, says what kind of detail, and
    // gives the commands to run again; the report holds none of the page's personal content (§19 review gap 9).
    const id = missed[0]?.id as string;
    expect(found.failures).toEqual([
      { id, representation: "text", reason: "the entity pass found a person's name that is not a placeholder" },
    ]);
    expect(found.retry).toBe(`${IMPORT_COMMAND} && ${LEAK_CHECK_COMMAND}`);
    const planted = [
      "Hendrik",
      "Grobbelaar",
      "Nomvula",
      "Parkhurst",
      "Wagtail",
      "Lindiwe",
      "Mbombela",
      "4471",
      ...readClientNames(samples),
    ];
    const safe = (report: string) => {
      for (const detail of planted) expect(report).not.toContain(detail);
      return report;
    };
    expect(safe(leakReport(found))).toContain(
      `  ${id} text: the entity pass found a person's name that is not a placeholder\nretry: ${IMPORT_COMMAND} && ${LEAK_CHECK_COMMAND}`,
    );
    expect(JSON.parse(readFileSync(leakCheckFile(store.dir), "utf-8")).failures).toEqual(found.failures);
    expect(leakCheckProblem(store, redactionKey(samples))).toBe("the sample leak check is not clean");
    // A name only the screenshot shows, as OCR reads it; a place too; a placeholder is no name.
    const shown = (text: string) => async (shots: string[]) => shots.map((_, i) => (i === 0 ? text : ""));
    const onScreen = await leakCheck({
      entities: { pass: finding(["Nomvula"]) },
      samples,
      store,
      ocr: shown("Dear Nomvula"),
    });
    expect(onScreen.problems).toEqual(["1 pages, records or screenshots name a person or place the entity pass found"]);
    const first = store.manifest().filter((p) => p.origin === "samples")[0]?.id as string;
    expect(onScreen.failures).toEqual([
      { id: first, representation: "OCR", reason: "the entity pass found a person's name that is not a placeholder" },
    ]);
    expect(safe(leakReport(onScreen))).toContain(`  ${first} OCR: the entity pass found a person's name`);
    expect(
      (
        await leakCheck({
          entities: { pass: finding(["Parkhurst"], "place") },
          samples,
          store,
          ocr: shown("Deliver to Parkhurst"),
        })
      ).code,
    ).toBe(1);
    expect(
      (await leakCheck({ entities: { pass: finding(["[name]"]) }, samples, store, ocr: shown("Dear [name]") })).code,
    ).toBe(0);
    // A street line, a post box, a signed name or a town on screen fails the check with a pass that finds nothing: the
    // rules beside the pass read no model, so the model's own misses are caught (§19 completion review gap 3).
    for (const [text, kind] of [
      ["Deliver to 41 Wagtail Crescent, Bryanston", "a street address"],
      ["Write to PO Box 4471, Rivonia", "a post box"],
      ["Kind regards, Lindiwe Maseko", "a signed name"],
      ["Collect it in Mbombela", "a town"],
      // In any case, and a name of ordinary words (§19 round 2).
      ["Please deliver to 7 kloof nek road.", "a street address"],
      ["write to po box 4471", "a post box"],
      ["Kind regards,\nMay Long", "a signed name"],
      ["Thanks,\nRose Hill", "a signed name"],
      ["Regards,\nWill Grant", "a signed name"],
      // A surname that is also a business's or a direction's word (§19 round 3).
      ["Kind regards,\nMay West", "a signed name"],
      ["Regards,\nWill West", "a signed name"],
      ["Thanks,\nRose North", "a signed name"],
      ["Regards,\nGrace East", "a signed name"],
      ["Kind regards,\nJune Bank", "a signed name"],
      ["Regards,\nMark Price", "a signed name"],
      ["Kind Regards,\nLINDIWE MASEKO", "a signed name"],
      ["Regards,\nDr Thandeka Mokoena", "a signed name"],
    ]) {
      const ruled = await leakCheck({ entities: misses, samples, store, ocr: shown(text as string) });
      expect(ruled.code).toBe(1);
      expect(ruled.failures).toEqual([{ id: first, representation: "OCR", reason: `it shows ${kind}` }]);
      expect(ruled.retry).toBe(`${IMPORT_COMMAND} && ${LEAK_CHECK_COMMAND}`);
      expect(safe(leakReport(ruled))).toContain(`  ${first} OCR: it shows ${kind}`);
    }
    // A pass that refuses (a changed model, a crash, a timeout, a script it cannot read) fails the check, never passes it.
    const refusing: EntityPass = {
      find: async () => Promise.reject(new Error("refused: the entity model is not the pinned one")),
      close: () => {},
    };
    const refused = await leakCheck({ entities: { pass: refusing }, samples, store, ocr: noText });
    expect(refused.code).toBe(1);
    expect(refused.problems).toEqual([
      expect.stringMatching(
        /^the entity pass refused \d+ pages, records or screenshots \(the entity model is not the pinned one\)$/,
      ),
    ]);
    // Every page's text, record and screenshot is named, and only the check needs running again.
    const pageCount = store.manifest().filter((p) => p.origin === "samples").length;
    expect(refused.failures).toHaveLength(pageCount * 3);
    expect(new Set(refused.failures.map((f) => f.representation))).toEqual(new Set(["text", "record", "OCR"]));
    expect(refused.failures[1]).toEqual({
      id: first,
      representation: "record",
      reason: "the entity pass refused it (the entity model is not the pinned one)",
    });
    expect(refused.retry).toBe(LEAK_CHECK_COMMAND);
    const refusedReport = safe(leakReport(refused));
    expect(refusedReport).toContain(
      `  ${first} record: the entity pass refused it (the entity model is not the pinned one)`,
    );
    expect(refusedReport.endsWith(`retry: ${LEAK_CHECK_COMMAND}`)).toBe(true);
    // With the switch on and no pass at all, nothing is believed.
    expect((await leakCheck({ entities: { pass: null }, samples, store, ocr: noText })).code).toBe(1);
    // OCR that skips a screenshot, or cannot read one, fails the check.
    const short = await leakCheck({ entities: misses, samples, store, ocr: async (s) => s.slice(1).map(() => "") });
    expect(short.code).toBe(1);
    expect(short.problems).toEqual([expect.stringMatching(/^the screenshots were not all read: \d+ texts for \d+$/)]);
    const failing = await leakCheck({
      entities: misses,
      samples,
      store,
      ocr: async () => Promise.reject(new Error("the OCR engine crashed")),
    });
    expect(failing.problems).toEqual(["the screenshots were not read: the OCR engine crashed"]);
    // A screenshot that is gone is named by its page before the OCR run fails whole.
    const shotFile = join(store.dir, "pages", first, "screenshot.jpg");
    renameSync(shotFile, `${shotFile}.aside`);
    const gone = await leakCheck({ entities: misses, samples, store, ocr: noText });
    renameSync(`${shotFile}.aside`, shotFile);
    expect(gone.failures).toEqual([{ id: first, representation: "OCR", reason: "the screenshot is missing" }]);
    expect(safe(leakReport(gone))).toContain(`  ${first} OCR: the screenshot is missing`);
    expect(leakCheckProblem(store, redactionKey(samples))).toBe("the sample leak check is not clean");
    // `ocr_text.py` fails a screenshot that is not there, never reads it as an empty text (an engine that would answer
    // nothing for it stands in for RapidOCR).
    const ocrScript = join(import.meta.dirname, "../../scripts/glimmer");
    const readMissing = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        `import sys; sys.path.insert(0, ${JSON.stringify(ocrScript)}); from ocr_text import read_all; print(read_all(sys.argv[1:], engine=lambda path: (None, 0.0)))`,
        join(dir, "no-such-screenshot.jpg"),
      ],
      { encoding: "utf-8" },
    );
    expect(readMissing.status).not.toBe(0);
    expect(readMissing.stderr).toMatch(/FileNotFoundError: 1 screenshots are missing/);
    // Clean again once nothing is found and every screenshot is read.
    expect((await leakCheck({ entities: misses, samples, store, ocr: noText })).code).toBe(0);
    expect(leakCheckProblem(store, redactionKey(samples))).toBeNull();
    // A check that stops part-way withdraws the clean verdict before it reads anything.
    const names = readFileSync(join(samples, "client-names.txt"), "utf-8");
    rmSync(join(samples, "client-names.txt"));
    await expect(leakCheck({ entities: misses, samples, store, ocr: noText })).rejects.toThrow(/client-names/);
    expect(leakCheckProblem(store, redactionKey(samples))).toBe("the sample leak check is not clean");
    writeFileSync(join(samples, "client-names.txt"), names);
  }, 240_000);

  // Coordinator decision, 2026-11-02: a flagged page is excluded through the label rules and barred, and the
  // check then runs over the dataset-eligible remainder only, where it must pass clean.
  it("excludes a flagged page through the label rules and passes over the eligible remainder", async () => {
    const samples = samplesDir(["1_", "4_"]);
    for (const name of ["9_HighConfPhish.eml", "14_HighConfPhish.eml", "6_HighConfPhish.eml"])
      rmSync(join(samples, "client", name), { recursive: true, force: true });
    writeFileSync(
      join(samples, "client", "17_HighConfPhish.eml"),
      message(`<p>${words}</p><p>Please phone Hendrik Grobbelaar in Accounts today.</p>`),
    );
    const store = openStore(join(dir, "store"));
    expect((await runImport({ entities: misses, samples, store, render })).code).toBe(0);
    const missed = store
      .manifest()
      .filter((p) => p.origin === "samples" && store.readPage(p.id).text.includes("Grobbelaar"));
    expect(missed).toHaveLength(1);
    const id = missed[0]?.id as string;
    const found = await leakCheck({
      entities: { pass: finding(["Hendrik Grobbelaar"]) },
      samples,
      store,
      ocr: noText,
    });
    expect(found.code).toBe(1);
    applyRules(store);
    expect(readExcluded(store.dir).get(id)).toMatch(/flagged by the sample leak check/);
    // The flagged page is not scanned again, so the finding pass passes over the eligible remainder.
    expect(
      await leakCheck({ entities: { pass: finding(["Hendrik Grobbelaar"]) }, samples, store, ocr: noText }),
    ).toMatchObject({ code: 0, problems: [] });
    expect(leakCheckProblem(store, redactionKey(samples))).toBeNull();
    // Barring is sticky: a later rules run, after the clean check, does not re-admit the flagged page.
    applyRules(store);
    expect(readExcluded(store.dir).get(id)).toMatch(/flagged by the sample leak check/);
  }, 240_000);

  // §19 round 1 finding 2: the requirements files the entity pass's and OCR's environments are pinned to are in the
  // key, so a changed pin remakes every page.
});
