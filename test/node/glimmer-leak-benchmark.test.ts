import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderRedacted } from "../../scripts/glimmer/import-samples.ts";
import { type EntityPass, redactWithEntities, skeleton, unreadScript } from "../../scripts/glimmer/redact.ts";
import {
  CHECKPOINT_PAGES,
  CONTROLS,
  checkpoint,
  checkpointPlan,
  DISCOVERY,
  dictionary,
  entityDecision,
  KINDS,
  LATIN_DISCOVERY,
  type Measured,
  type Plan,
  presidioPass,
  renderRedactedBy,
  runBenchmark,
  seedPages,
  speedComparison,
  survives,
  unlistedSurvives,
  WAYS,
  withEntities,
} from "../../scripts/glimmer/redaction-benchmark.ts";
import { dir, render, useSamples } from "./helpers/glimmer-samples.ts";

// scripts/glimmer/redaction-benchmark.ts (D03 T04 §19): seeded details scored by kind and way of writing, the entity
// pass decided by its rule, and the checkpoint never overwritten by a partial run. Split from glimmer-leak.test.ts so
// the files run on parallel workers.
useSamples();

describe("the redaction benchmark", () => {
  it("finds a detail still there however the benchmark wrote it", () => {
    // Its own look-alike way: full-width digits and a Cyrillic letter in the client's domain.
    expect(
      survives(
        { kind: "phone", way: "look-alike letters", value: "082 555 1234" },
        "call \uff10\uff18\uff12 \uff15\uff15\uff15 \uff11\uff12\uff13\uff14",
      ),
    ).toBe(true);
    expect(
      survives(
        { kind: "domain", way: "look-alike letters", value: "kestrel-holdings.co.za" },
        "see k\u0435strel-holdings.co.za",
      ),
    ).toBe(true);
    expect(survives({ kind: "name", way: "plain", value: "Sipho Naidoo" }, "Dear [name]")).toBe(false);
  });

  it("leaves no seeded detail of any kind, written any way, on a page it accepts", async () => {
    // Eight pages of ten: every one of the seven kinds meets each of the eleven ways at least once.
    const result = await runBenchmark({ pages: 8, render });
    expect(result.total.seeded).toBe(80);
    expect(Object.keys(result.byKindAndWay)).toHaveLength(KINDS.length * WAYS.length);
    expect(result.total.survived).toBe(0);
    expect(result.total.removed).toBeGreaterThan(0);
    expect(result.failedPages).toBe(0);
  }, 120_000);

  it("seeds details no detector is given, scores them apart, and keeps the lure's brand (§19)", async () => {
    const { pages, names, terms, domains } = seedPages(4);
    const unlisted = pages.flatMap((page) => page.unlisted);
    expect(new Set(unlisted.map((u) => u.kind))).toEqual(new Set(DISCOVERY));
    // The truth stays in its own record: no detector input names an unlisted person or address.
    const inputs = [...names, ...terms, ...domains].join("\n").toLowerCase();
    for (const u of unlisted)
      for (const word of u.value
        .toLowerCase()
        .split(/[\s,]+/)
        .filter((w) => [...w].length >= 4))
        expect(inputs).not.toContain(word);
    const result = await runBenchmark({ pages: 4, render });
    expect(Object.keys(result.discovery).sort()).toEqual([...DISCOVERY].sort());
    // The dictionary cannot remove what it was never given; that is measured, and the known kinds' bar still holds.
    expect(Object.values(result.discovery).reduce((n, t) => n + t.survived, 0)).toBeGreaterThan(0);
    expect(result.total.survived).toBe(0);
    // Every page the check accepts keeps the brand it impersonates.
    const accepted = result.pages - result.refusedPages - result.failedPages;
    expect(accepted).toBeGreaterThan(0);
    expect(result.controls).toEqual({ kept: accepted * CONTROLS.length, lost: 0 });
    expect(
      unlistedSurvives({ kind: "postal address", value: "14 Jacaranda Street, Parkhurst" }, "Deliver to [address]"),
    ).toBe(false);
  }, 120_000);

  it("seeds a Latin-script set the entity pass can read, with unlisted names and places, and scores it apart (§19)", async () => {
    const latin = seedPages(40, undefined, "latin");
    const mixed = seedPages(40);
    const unlisted = latin.pages.flatMap((page) => page.unlisted);
    expect(new Set(unlisted.map((u) => u.kind))).toEqual(new Set(LATIN_DISCOVERY));
    // No letter in a script the model does not read on any page, as the pass reads it (look-alikes folded), while the
    // mixed set holds them on every page.
    for (const page of latin.pages) expect(unreadScript(skeleton(page.html.replace(/<[^>]*>/g, " ")))).toBeNull();
    for (const page of mixed.pages) expect(unreadScript(skeleton(page.html.replace(/<[^>]*>/g, " ")))).not.toBeNull();
    // The known details are the same kinds and ways, and the truth stays out of every detector input.
    expect(latin.pages[0]?.seeded).toEqual(mixed.pages[0]?.seeded);
    const inputs = [...latin.names, ...latin.terms, ...latin.domains].join("\n").toLowerCase();
    for (const u of unlisted)
      for (const word of u.value
        .toLowerCase()
        .split(/[\s,]+/)
        .filter((w) => [...w].length >= 4))
        expect(inputs).not.toContain(word);
    const result = await runBenchmark({ pages: 3, render, set: "latin" });
    expect(Object.keys(result.discovery).sort()).toEqual([...LATIN_DISCOVERY].sort());
    expect(result.total.survived).toBe(0);
    expect(result.refusedUnreadScript).toBe(0);
    expect(unlistedSurvives({ kind: "unlisted place", value: "Stellenbosch" }, "from our [address] branch")).toBe(
      false,
    );
    expect(unlistedSurvives({ kind: "unlisted place", value: "Stellenbosch" }, "from our Stellenbosch branch")).toBe(
      true,
    );
  }, 120_000);

  it("counts a page the entity pass refused for an unread script apart from the other refusals", async () => {
    const unread = async () =>
      Promise.reject(
        new Error("refused: the entity model does not read arabic script, and the page holds a name in it"),
      );
    const other = async () => Promise.reject(new Error("refused: a client detail survived redaction"));
    expect(await runBenchmark({ pages: 3, render, redactor: unread })).toMatchObject({
      refusedPages: 3,
      refusedUnreadScript: 3,
    });
    expect(await runBenchmark({ pages: 3, render, redactor: other })).toMatchObject({
      refusedPages: 3,
      refusedUnreadScript: 0,
    });
  });

  it("decides the entity pass's switch on the rule: nothing known survives, no more refusals, more removed", () => {
    const run = (refusedPages: number, survived: number, removed: number, failedPages = 0) => ({
      pages: 120,
      refusedPages,
      failedPages,
      total: { seeded: 10, refused: 0, survived, removed: 10 - survived },
      discovery: { "unlisted name": { seeded: 10, refused: 0, survived: 10 - removed, removed } },
    });
    expect(entityDecision(run(4, 0, 0), run(4, 0, 6))).toMatchObject({ keepOn: true, reason: null });
    expect(entityDecision(run(4, 0, 0), run(5, 0, 6)).keepOn).toBe(false);
    expect(entityDecision(run(4, 0, 0), run(4, 1, 6)).keepOn).toBe(false);
    expect(entityDecision(run(4, 0, 3), run(4, 0, 3)).keepOn).toBe(false);
    // A page that failed to execute in either run withholds the decision: 119 of 120 failed is no evidence (gap 5).
    expect(entityDecision(run(0, 0, 0), run(0, 0, 1, 119))).toMatchObject({
      keepOn: false,
      reason: "119 pages failed to execute (0 with the dictionary, 119 with the entity pass)",
    });
    expect(entityDecision(run(0, 0, 0, 1), run(4, 0, 6))).toMatchObject({ keepOn: false });
  });

  // §19 completion review gap 5: the documented command is the checkpoint, every pipeline the decision needs runs, a
  // partial run never replaces the record, and the exit status fails on any pipeline's failed or missing run.
  describe("the checkpoint", () => {
    const tally = (removed: number, survived = 0) => ({ seeded: removed + survived, refused: 0, survived, removed });
    const result = (over: { failedPages?: number; pages?: number; survived?: number; found?: number } = {}) => ({
      pages: over.pages ?? CHECKPOINT_PAGES,
      refusedPages: 0,
      refusedUnreadScript: 0,
      refusedFor: {},
      failedPages: over.failedPages ?? 0,
      screenshotsRead: true,
      total: tally(10, over.survived ?? 0),
      byKindAndWay: {},
      discovery: { "unlisted name": tally(over.found ?? 0) },
      controls: { kept: 1, lost: 0 },
    });
    // A measure that records what it was asked for and gives each pipeline's run as `runs` says.
    const measuring = (
      runs: { presidio?: ReturnType<typeof result> | null; entities?: ReturnType<typeof result> } = {},
    ) => {
      const asked: Plan[] = [];
      const measure = async (_set: string, plan: Plan): Promise<Measured> => {
        asked.push(plan);
        const entities = runs.entities ?? result({ found: 5 });
        const head: Measured["head"] = {};
        if (plan.presidio && runs.presidio !== null) head.presidio = runs.presidio ?? result();
        if (plan.entities) head.entities = entities;
        return { alone: result(), head, both: plan.entities ? entities : null };
      };
      return { asked, measure };
    };
    const record = () => join(mkdtempSync(join(dir, "record-")), "redaction-benchmark.json");

    it("runs every pipeline by default and writes the record; refuses the old flags", async () => {
      expect(checkpointPlan([])).toEqual({ pages: 120, presidio: true, entities: true, partial: false });
      expect(checkpointPlan(["60"])).toMatchObject({ pages: 60, partial: true });
      expect(checkpointPlan(["--without", "presidio"])).toMatchObject({
        presidio: false,
        entities: true,
        partial: true,
      });
      expect(() => checkpointPlan(["--presidio"])).toThrow(/usage/);
      const { asked, measure } = measuring();
      const out = record();
      const lines: string[] = [];
      expect(await checkpoint({ argv: [], measure, out, log: (l) => lines.push(l) })).toBe(0);
      expect(asked).toEqual([checkpointPlan([]), checkpointPlan([])]);
      const written = JSON.parse(readFileSync(out, "utf-8"));
      expect(Object.keys(written)).toEqual(expect.arrayContaining(["presidio", "entities", "latin", "entityDecision"]));
      expect(written.latin).toMatchObject({ presidio: expect.any(Object), entities: expect.any(Object) });
      expect(written.entityDecision).toMatchObject({ keepOn: true, reason: null });
    });

    it("never overwrites the record from a partial run", async () => {
      const out = record();
      writeFileSync(out, "the recorded checkpoint\n");
      const lines: string[] = [];
      for (const argv of [["--without", "presidio"], ["--without", "entities"], ["12"]])
        await checkpoint({ argv, measure: measuring().measure, out, log: (l) => lines.push(l) });
      expect(readFileSync(out, "utf-8")).toBe("the recorded checkpoint\n");
      expect(lines.filter((l) => /a partial run; .* is left as it was/.test(l))).toHaveLength(3);
    });

    it("fails on any pipeline's failed or missing run, a withheld decision, or a switch the decision contradicts", async () => {
      const exit = async (runs: Parameters<typeof measuring>[0], argv: string[] = []) => {
        const lines: string[] = [];
        const code = await checkpoint({
          argv,
          measure: measuring(runs).measure,
          out: record(),
          log: (l) => lines.push(l),
        });
        return { code, failures: lines.filter((l) => l.includes("failed: ")) };
      };
      expect((await exit({})).code).toBe(0);
      expect(await exit({ presidio: result({ failedPages: 3 }) })).toEqual({
        code: 1,
        failures: [
          "redaction benchmark: failed: mixed presidio: 3 of 120 pages failed",
          "redaction benchmark: failed: latin presidio: 3 of 120 pages failed",
        ],
      });
      expect((await exit({ presidio: null })).failures).toContain(
        "redaction benchmark: failed: mixed presidio: did not run",
      );
      expect((await exit({ presidio: result({ pages: 119 }) })).code).toBe(1);
      // 119 of 120 entity pages failed: the decision is withheld and the run fails.
      const withheld = await exit({ entities: result({ failedPages: 119, found: 1 }) });
      expect(withheld.code).toBe(1);
      expect(withheld.failures).toContain(
        "redaction benchmark: failed: entity decision: withheld (119 pages failed to execute (0 with the dictionary, 119 with the entity pass))",
      );
      // A decision to turn the pass off while it ships on fails the checkpoint: the switch follows the measurement.
      expect((await exit({ entities: result({ found: 0 }) })).failures).toContain(
        "redaction benchmark: failed: entity decision: keepOn is false but ENTITY_PASS_ON is true",
      );
      // A partial run is held to the pipelines it ran.
      expect((await exit({ presidio: result({ failedPages: 1 }) }, ["--without", "presidio"])).code).toBe(0);
    });
  });

  it("runs the importer's path with only the redaction step swapped: the dictionary through it equals renderRedacted", async () => {
    const { pages, names, terms, domains } = seedPages(8);
    const outcome = (run: () => Promise<{ text: string }>) =>
      run().then(
        (page) => page.text,
        (error: Error) => error.message,
      );
    for (const page of pages) {
      const viaImporter = await outcome(() =>
        renderRedacted(render, page.html, names, terms, domains, { pass: null, on: false }),
      );
      const viaBenchmark = await outcome(() =>
        renderRedactedBy(dictionary, render, page.html, { names, terms, domains }),
      );
      expect(viaBenchmark).toBe(viaImporter);
    }
    // Another redactor meets the same refusals: one that changes nothing is refused where its page still shows a detail.
    let refused = 0;
    for (const page of pages)
      refused += await renderRedactedBy(async (html) => html, render, page.html, { names, terms, domains }).then(
        () => 0,
        (error: Error) => (/^refused: /.test(error.message) ? 1 : 0),
      );
    expect(refused).toBeGreaterThan(pages.length / 2);
  }, 120_000);

  // WORKAROUND: Presidio's own venv is a local install of a 600 MB model, which no CI host carries.
  it.skipIf(!existsSync(join(homedir(), ".venvs", "presidio", "bin", "python")))(
    "runs Presidio as the entity pass on the same path, its failures counted apart from refusals",
    async () => {
      const presidio = presidioPass();
      try {
        expect(presidio.configuration.versions).toMatchObject({ "presidio-analyzer": expect.any(String) });
        // Through the pass's own path: the text extracted from the HTML, Presidio's span replaced in the HTML.
        const html = await redactWithEntities(
          "<p>Please phone <b>Hendrik</b> Grobbelaar today.</p>",
          [],
          [],
          presidio.pass,
          true,
        );
        expect(html).not.toMatch(/Hendrik|Grobbelaar/);
        expect(html).toContain("[name]");
        const result = await runBenchmark({
          pages: 3,
          render,
          set: "latin",
          redactor: withEntities(presidio.pass),
          pass: presidio.pass,
        });
        expect(result.failedPages).toBe(0);
        expect(result.total.seeded + Object.values(result.discovery).reduce((n, t) => n + t.seeded, 0)).toBe(36);
        // A page the process cannot answer is a failure, never a refusal.
        const broken = await runBenchmark({
          pages: 1,
          render,
          redactor: async () => Promise.reject(new Error("presidio: ValueError")),
        });
        expect(broken).toMatchObject({ failedPages: 1, refusedPages: 0 });
      } finally {
        presidio.pass.close();
      }
    },
    180_000,
  );

  it("times the pass and Presidio in alternating rounds on the same pages, with the privacy each run kept", async () => {
    const order: string[] = [];
    // Stand-in detectors: one finds the unlisted names by their text, the other nothing; each counts its start.
    const detector =
      (name: string, finds: boolean): (() => EntityPass) =>
      () => {
        order.push(name);
        return {
          find: async (text) =>
            finds
              ? [...text.matchAll(/\b(?:Please call|Regards,) (\p{Lu}\p{Ll}+ \p{Lu}\p{Ll}+)/gu)].map((m) => ({
                  start: (m.index ?? 0) + m[0].length - (m[1] as string).length,
                  end: (m.index ?? 0) + m[0].length,
                  label: "person" as const,
                }))
              : [],
          close: () => undefined,
        };
      };
    // Two rounds of a few pages prove the alternation and the accounting (3 rounds of 12 took 12 s in the gate); the
    // real timing is the benchmark's own run, `node scripts/glimmer/redaction-benchmark.ts`.
    const result = await speedComparison({
      runs: 2,
      pages: 4,
      render,
      open: { entities: detector("entities", true), presidio: detector("presidio", false) },
    });
    // The order swaps each round, so neither pipeline always runs first.
    expect(order).toEqual(["entities", "presidio", "presidio", "entities"]);
    expect(result.runs).toHaveLength(4);
    for (const run of result.runs) {
      expect(run.accepted + run.refused + run.failed).toBe(4);
      expect(run.acceptedPerSecond).toBeGreaterThan(0);
      expect(run.startupMs).toBeGreaterThanOrEqual(0);
    }
    expect(result.summary.entities.runs).toBe(2);
    // The privacy each kept is measured beside its speed: the detector that finds nothing leaves running-text names.
    expect(result.summary.presidio.unlistedSurvived.median).toBeGreaterThan(
      result.summary.entities.unlistedSurvived.median,
    );
  }, 120_000);

  it("counts a render that failed as a failure, never as a refusal", async () => {
    const result = await runBenchmark({ pages: 7, render: async () => Promise.reject(new Error("browser closed")) });
    expect(result).toMatchObject({ failedPages: 7, refusedPages: 0 });
    expect(result.total.seeded).toBe(0);
  });
});
