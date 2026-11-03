import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { checkNewSourceCoverage, importNewSource, MIN_FREE_BYTES, newItem } from "../../scripts/glimmer/import-new.ts";
import type { PhreshIndex } from "../../scripts/glimmer/import-phreshphish.ts";
import { reconcile } from "../../scripts/glimmer/sources.ts";
import { PageMeta } from "../../scripts/glimmer/store.ts";

// The 1.1 sources' importer (D03 T04 §44): a row's brand is grouping only, never a trusted label (§45).
const row = (over: Partial<PhreshIndex> = {}): PhreshIndex =>
  ({
    sha256: "a".repeat(64),
    url: "https://acme.example/",
    label: "phish",
    target: "Acme Bank",
    offset: 0,
    length: 0,
    shot: false,
    ...over,
  }) as PhreshIndex;

const reader = {
  renderHtml: async () => ({
    screenshot: new Uint8Array([1]),
    text: "Sign in to Acme",
    has_login_form: true,
    has_payment_form: false,
  }),
} as never;

async function validJpeg(seed: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: (seed * 47) % 255, g: (seed * 97) % 255, b: (seed * 137) % 255 },
      },
    })
      .jpeg()
      .toBuffer(),
  );
}

function writeTwoRowFixture(dir: string, source: string) {
  const folder = join(dir, "raw", source);
  mkdirSync(folder, { recursive: true });
  const r1 = JSON.stringify({
    sha256: "1".repeat(64),
    url: "https://lure-one.example/",
    html: "<p>Please sign in to verify your account immediately</p>",
    label: "phish",
    target: "Acme",
  });
  const r2 = JSON.stringify({
    sha256: "2".repeat(64),
    url: "https://benign-two.example/",
    html: "<p>Welcome to Acme official documentation and resources</p>",
    label: "benign",
    target: "Acme",
  });
  const rowsContent = `${r1}\n${r2}\n`;
  const rowsPath = join(folder, "rows.jsonl");
  writeFileSync(rowsPath, rowsContent, "utf-8");
  const rowsSha = createHash("sha256").update(rowsContent, "utf-8").digest("hex");
  const inputsDigest = "f".repeat(64);
  writeFileSync(
    join(folder, "EXPORT.json"),
    JSON.stringify({
      met: 2,
      exported: 2,
      sampled_out: 0,
      rejected: {},
      rows_sha256: rowsSha,
      converter_sha256: "c".repeat(64),
      inputs: inputsDigest,
    }),
    "utf-8",
  );
  return {
    folder,
    rowsSha,
    inputsDigest,
    r1Sha: createHash("sha256").update(r1, "utf-8").digest("hex"),
    r2Sha: createHash("sha256").update(r2, "utf-8").digest("hex"),
  };
}

describe("import-new", () => {
  it("stores a lure row's brand as grouping-only, never ground truth", () => {
    const item = newItem(row(), () => "<p>Sign in</p>", reader);
    expect(item.labels).toMatchObject({ lure: true, brand: "Acme Bank" });
    expect(item.label_source.brand).toBe("grouping-only");
    expect(item.label_source.lure).toBe("ground-truth");
  });

  it("stores a benign row's brand the same way, with its lure type trusted", () => {
    const item = newItem(row({ label: "benign" }), () => "<p>Sign in</p>", reader);
    expect(item.labels).toMatchObject({ lure: false, lure_type: "none", brand: "Acme Bank" });
    expect(item.label_source.brand).toBe("grouping-only");
    expect(item.label_source.lure_type).toBe("ground-truth");
  });

  it("stores a grouping-only brand in the page record (the import's regression)", () => {
    // Before `grouping-only` joined LABEL_SOURCES, every branded page of these sources failed the record's
    // validation and was excluded with a zod error.
    const meta = PageMeta.parse({
      source: "ows",
      origin: "public",
      licence: "CC BY 4.0",
      host: "acme.example",
      template: null,
      south_africa: false,
      labels: { lure: true, brand: "Acme Bank" },
      label_source: { lure: "ground-truth", brand: "grouping-only" },
      sha256: { screenshot: "a".repeat(64), text: "b".repeat(64) },
      redacted: false,
    });
    expect(meta.label_source.brand).toBe("grouping-only");
  });

  it("refuses a row whose label is neither phish nor benign, and an oversized row", () => {
    expect(newItem(row({ label: "spam" }), () => "", reader).labels).toEqual({});
    expect(newItem(row({ oversized: true }), () => "", reader).labels).toEqual({});
  });

  it("rejects an unexpectedly truncated import despite internally consistent receipts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glimmer-import-new-trunc-"));
    try {
      const { folder, rowsSha, inputsDigest, r1Sha, r2Sha } = writeTwoRowFixture(dir, "putra");
      const shot1 = await validJpeg(1);
      const shot2 = await validJpeg(2);
      let call = 0;
      const realReader = {
        renderHtml: async (html: string) => ({
          screenshot: ++call === 1 ? shot1 : shot2,
          text: html.replace(/<[^>]+>/g, ""),
          has_login_form: true,
          has_payment_form: false,
          evidence: { title: "Acme", overlays: "", wall: false },
        }),
      } as never;

      const result = await importNewSource({
        source: "putra",
        dir,
        reader: realReader,
        concurrency: 1,
        freeBytes: () => MIN_FREE_BYTES + 50_000_000_000,
      });
      expect(result.status).toBe("incomplete");
      expect(result.reason).toMatch(/below the .* floor/);
      const importJsonText = readFileSync(join(folder, "IMPORT.json"), "utf-8");
      const importHeader = JSON.parse(readFileSync(join(folder, "ITEMS.import.jsonl"), "utf-8").split("\n")[0] ?? "{}") as {
        import?: string;
      };
      expect(importHeader.import).toBe(createHash("sha256").update(importJsonText, "utf-8").digest("hex"));

      // Even if a caller checks reconcile() against internally consistent receipts, checkNewSourceCoverage rejects it.
      const problems = reconcile({
        sources: [
          "| Source | Dataset | Licence | Licence link | Decision | Reason | Label errors |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| `putra` | https://zenodo.org/records/8041387 | CC BY 4.0 | https://zenodo.org/api/records/8041387 | accepted | 500-site zips | - |",
        ].join("\n"),
        imports: {
          putra: {
            status: "complete",
            expected: 2,
            imported: 2,
            duplicates: 0,
            skipped: 0,
            filtered: [],
            excluded: [],
            stored: 2,
            inputs: inputsDigest,
            rows: rowsSha,
          },
        },
        pages: [
          {
            id: `putra-${"1".repeat(16)}`,
            source: "putra",
            origin: "public",
            licence: "CC BY 4.0",
            host: "lure-one.example",
            template: null,
            south_africa: false,
            labels: { lure: true },
            label_source: { lure: "ground-truth" },
            sha256: { screenshot: "a".repeat(64), text: "b".repeat(64) },
            redacted: false,
            item: "1".repeat(64),
            input: r1Sha,
            evidence: { title: "Acme", overlays: "", wall: false },
          },
          {
            id: `putra-${"2".repeat(16)}`,
            source: "putra",
            origin: "public",
            licence: "CC BY 4.0",
            host: "benign-two.example",
            template: null,
            south_africa: false,
            labels: { lure: false, lure_type: "none" },
            label_source: { lure: "ground-truth", lure_type: "ground-truth" },
            sha256: { screenshot: "c".repeat(64), text: "d".repeat(64) },
            redacted: false,
            item: "2".repeat(64),
            input: r2Sha,
            evidence: { title: "Acme", overlays: "", wall: false },
          },
        ],
        notice: "| `putra` | CC BY 4.0 |",
        bindings: {
          putra: {
            manifest: inputsDigest,
            export: {
              met: 2,
              exported: 2,
              sampled_out: 0,
              rejected: {},
              rows_sha256: rowsSha,
              converter_sha256: "c".repeat(64),
              inputs: inputsDigest,
            },
            rowItems: [
              { item: "1".repeat(64), input: r1Sha, lure: true },
              { item: "2".repeat(64), input: r2Sha, lure: false },
            ],
          },
        },
      });
      expect(problems.some((p) => p.includes("EXPORT.json exported 2 rows, below the 2494 floor"))).toBe(true);
      expect(
        problems.some((p) => p.includes("exported rows by label (1 lure, 1 benign) are below the (1994 lure, 500 benign) floor")),
      ).toBe(true);
      expect(
        problems.some((p) =>
          p.includes("stored usable pages by label (2 total, 1 lure, 1 benign) are below the (1623 total, 1128 lure, 495 benign) floor"),
        ),
      ).toBe(true);
      expect(
        checkNewSourceCoverage("van-dooremaal-ares-2021", {
          exportReceipt: {
            met: 124_714,
            exported: 100,
            sampled_out: 124_614,
            rejected: {},
            rows_sha256: rowsSha,
            converter_sha256: "c".repeat(64),
            inputs: inputsDigest,
          },
          stored: [],
        })[0],
      ).toMatch(/over the 95938 sampling cap/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces the 300 GB free-space reserve during import, preserves previous outputs on refusal, and resumes when freed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glimmer-import-new-space-"));
    try {
      const { folder } = writeTwoRowFixture(dir, "putra");
      const shot1 = await validJpeg(10);
      const shot2 = await validJpeg(20);
      let renders = 0;
      const realReader = {
        renderHtml: async (html: string) => ({
          screenshot: ++renders === 1 ? shot1 : shot2,
          text: html.replace(/<[^>]+>/g, ""),
          has_login_form: true,
          has_payment_form: false,
          evidence: { title: "Acme", overlays: "", wall: false },
        }),
      } as never;

      // 1. Mid-import drop below 300 GB after storing the first page stops the run and preserves the first page.
      let checks = 0;
      const midDrop = await importNewSource({
        source: "putra",
        dir,
        reader: realReader,
        concurrency: 1,
        enforceCoverage: false,
        freeBytes: () => {
          checks++;
          return checks <= 4 ? MIN_FREE_BYTES + 10_000_000_000 : MIN_FREE_BYTES - 1;
        },
      });
      expect(midDrop.status).toBe("incomplete");
      expect(midDrop.imported).toBe(1);
      expect(midDrop.stored).toBe(1);
      expect(midDrop.reason).toMatch(/must stay free/);
      const importAfterMidDrop = readFileSync(join(folder, "IMPORT.json"), "utf-8");
      // Because free space stayed below the reserve during failure publication, the already-published `running` receipt is preserved.
      expect((JSON.parse(importAfterMidDrop) as { status: string }).status).toBe("running");

      // 2. Starting at the exact 300 GB boundary (or with insufficient margin for pending writes) refuses immediately and leaves IMPORT.json untouched.
      await expect(
        importNewSource({
          source: "putra",
          dir,
          reader: realReader,
          concurrency: 1,
          enforceCoverage: false,
          freeBytes: () => MIN_FREE_BYTES,
        }),
      ).rejects.toThrow(/would breach/);
      expect(readFileSync(join(folder, "IMPORT.json"), "utf-8")).toBe(importAfterMidDrop);

      // 3. Above 300 GB by 20 KB (enough for initial check, but less than pending page write + publication reserve) stops before storing the second page.
      const tightPending = await importNewSource({
        source: "putra",
        dir,
        reader: realReader,
        concurrency: 2,
        enforceCoverage: false,
        freeBytes: () => MIN_FREE_BYTES + 17_000,
      });
      expect(tightPending.status).toBe("incomplete");
      expect(tightPending.stored).toBe(1);
      expect(tightPending.reason).toMatch(/would breach/);

      // 4. Once free space recovers above 300 GB + pending writes, the rerun skips the stored page and finishes the rest.
      const resumed = await importNewSource({
        source: "putra",
        dir,
        reader: realReader,
        concurrency: 1,
        enforceCoverage: false,
        freeBytes: () => MIN_FREE_BYTES + 80_000_000_000,
      });
      expect(resumed.status).toBe("complete");
      expect(resumed.skipped).toBe(1);
      expect(resumed.imported).toBe(1);
      expect(resumed.stored).toBe(2);

      // 5. Round 3 regression: concurrent captures with large ~30 KB CJK evidence metadata reserve full serialized meta.json bytes before breaching the 300 GB reserve.
      const cjkDir = mkdtempSync(join(tmpdir(), "glimmer-import-new-cjk-"));
      try {
        writeTwoRowFixture(cjkDir, "phishdecloaker");
        const cjkTitle = "登".repeat(2000);
        const cjkOverlays = "请".repeat(8000);
        let cjkCalls = 0;
        const cjkReader = {
          renderHtml: async (html: string) => ({
            screenshot: ++cjkCalls === 1 ? shot1 : shot2,
            text: html.replace(/<[^>]+>/g, ""),
            has_login_form: true,
            has_payment_form: false,
            evidence: { title: cjkTitle, overlays: cjkOverlays, wall: false },
          }),
        } as never;
        // 45 KB of headroom is larger than 2 * 4096 + publicationReserveBytes (~25 KB), but smaller than 2 * ~30,864 bytes of serialized CJK metadata + publicationReserveBytes (~79 KB).
        const cjkResult = await importNewSource({
          source: "phishdecloaker",
          dir: cjkDir,
          reader: cjkReader,
          concurrency: 4,
          enforceCoverage: false,
          freeBytes: () => MIN_FREE_BYTES + 55_000,
        });
        expect(cjkResult.status).toBe("incomplete");
        expect(cjkResult.stored).toBeLessThan(2);
        expect(cjkResult.reason).toMatch(/would breach/);
      } finally {
        rmSync(cjkDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
