import * as fs from "node:fs";
// The doctored pairs generator (D06 T02 §4): 20 genuine synthetic documents, one labelled edit
// each, a model refusal replaced in code, and a restart that reuses completed pairs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  DOCS,
  editInstruction,
  ImageResponse,
  makePair,
  normalizeExistingFixtures,
  pngOf,
  publishFixtureFile,
  runAll,
  svgOf,
} from "../../scripts/fixtures/make-doctored.ts";

describe("make-doctored", () => {
  it("names 20 genuine sources with one edit each", () => {
    expect(DOCS).toHaveLength(20);
    expect(new Set(DOCS.map((d) => d.pair)).size).toBe(20);
    for (const d of DOCS) {
      expect(svgOf(d)).toContain("SYNTHETIC TEST DOCUMENT");
      expect(editInstruction(d)).toContain("SYNTHETIC");
    }
    expect(() => ImageResponse.parse({ data: [{ b64_json: "" }] })).toThrow();
    expect(ImageResponse.parse({ data: [{ b64_json: "QQ==" }] }).data).toHaveLength(1);
  });

  it("makes a pair in code when the model edit fails, and reuses it on a restart", async () => {
    const spec = DOCS[0] as (typeof DOCS)[number];
    const tmp = join(import.meta.dirname, "../fixtures/payment-docs-tmp");
    rmSync(tmp, { recursive: true, force: true });
    const failing = async (): Promise<Buffer> => {
      throw Object.assign(new Error("refused"), { kind: "content-policy" });
    };
    const labels = await makePair(spec, failing, tmp);
    expect(labels.map((l) => [l.role, l.made_by])).toEqual([
      ["genuine", null],
      ["doctored", "code"],
    ]);
    expect(existsSync(join(tmp, `${spec.pair}-doctored.png`))).toBe(true);
    const before = readFileSync(join(tmp, `${spec.pair}-doctored.png`));
    const again = await makePair(
      spec,
      async () => {
        throw new Error("must not be called for a completed pair");
      },
      tmp,
    );
    expect(again[1]?.made_by).toBe("code");
    expect(readFileSync(join(tmp, `${spec.pair}-doctored.png`))).toEqual(before);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("makes an unchanged model output in code, never as a model edit", async () => {
    const spec = DOCS[1] as (typeof DOCS)[number];
    const tmp = join(import.meta.dirname, "../fixtures/payment-docs-tmp2");
    rmSync(tmp, { recursive: true, force: true });
    const labels = await makePair(spec, async (_s, genuine) => genuine, tmp);
    expect(labels[1]?.made_by).toBe("code");
    expect(labels[1]?.note).toContain("unchanged");
    rmSync(tmp, { recursive: true, force: true });
  });
});

it("recovers provenance from sidecars on a restart without a manifest", async () => {
  const tmp = join(import.meta.dirname, "../fixtures/payment-docs-tmp3");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const spec = DOCS[0] as (typeof DOCS)[number];
  await makePair(
    spec,
    async () => {
      throw Object.assign(new Error("refused"), { kind: "content-policy" });
    },
    tmp,
  );
  rmSync(join(tmp, "labels.json"), { force: true });
  writeFileSync(join(tmp, `${spec.pair}.json`), JSON.stringify({ pair: spec.pair, made_by: "model", note: "kept" }));
  const labels = await runAll(null, tmp);
  const doctored = labels.find((l) => l.pair === spec.pair && l.role === "doctored");
  expect(doctored?.made_by).toBe("model");
  expect(doctored?.note).toBe("kept");
  rmSync(tmp, { recursive: true, force: true });
});

describe("provider image encoding", () => {
  it("publishes lossless WebP edits as real PNG with identical decoded pixels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctored-encoding-"));
    try {
      const spec = DOCS[0] as (typeof DOCS)[number];
      const source = await sharp(await pngOf(spec, true))
        .webp({ lossless: true })
        .toBuffer();
      const labels = await makePair(spec, async () => source, dir);
      const output = readFileSync(join(dir, `${spec.pair}-doctored.png`));
      expect((await sharp(output).metadata()).format).toBe("png");
      const outputPixels = await sharp(output).ensureAlpha().raw().toBuffer();
      const sourcePixels = await sharp(source).ensureAlpha().raw().toBuffer();
      expect(outputPixels.equals(sourcePixels)).toBe(true);
      expect(labels[1]?.made_by).toBe("model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not attribute a differently encoded unchanged image to a model edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctored-unchanged-"));
    try {
      const spec = DOCS[0] as (typeof DOCS)[number];
      const labels = await makePair(
        spec,
        async (_spec, genuine) => sharp(genuine).webp({ lossless: true }).toBuffer(),
        dir,
      );
      expect(labels[1]?.made_by).toBe("code");
      expect(labels[1]?.note).toContain("unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("offline fixture normalization", () => {
  for (const interruption of ["before-image", "after-image"] as const) {
    it(`preserves original hashes and backup through a failure ${interruption}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "doctored-recovery-"));
      const out = join(root, "fixtures");
      const backup = join(root, "originals");
      mkdirSync(out);
      try {
        const spec = DOCS[0] as (typeof DOCS)[number];
        const filename = `${spec.pair}-doctored.png`;
        const source = await sharp(await pngOf(spec, true))
          .webp({ lossless: true })
          .toBuffer();
        writeFileSync(join(out, filename), source);
        const provenance = '{"made_by":"model","note":"original provider output"}';
        writeFileSync(join(out, `${spec.pair}.json`), provenance);
        const publish = (name: string, bytes: Buffer | string, dir: string) => {
          if (name === filename && interruption === "before-image") throw new Error("injected write failure");
          writeFileSync(join(dir, `${name}.tmp`), bytes);
          renameSync(join(dir, `${name}.tmp`), join(dir, name));
          if (name === filename) throw new Error("injected interruption after image replacement");
        };
        await expect(normalizeExistingFixtures(out, backup, publish)).rejects.toThrow("injected");
        const receiptBefore = readFileSync(join(out, "normalization.json"));
        expect(readFileSync(join(backup, `${filename}.original`))).toEqual(source);
        if (interruption === "before-image") expect(readFileSync(join(out, filename))).toEqual(source);
        const receipt = await normalizeExistingFixtures(out, backup);
        expect(receipt.records).toHaveLength(1);
        expect(receipt.records[0]?.pixelsEqual).toBe(true);
        expect((await sharp(readFileSync(join(out, filename))).metadata()).format).toBe("png");
        expect(readFileSync(join(out, "normalization.json"))).toEqual(receiptBefore);
        expect(readFileSync(join(out, `${spec.pair}.json`), "utf8")).toBe(provenance);
        expect(await normalizeExistingFixtures(out, backup)).toEqual(receipt);
        writeFileSync(join(backup, `${filename}.original`), "corrupted");
        await expect(normalizeExistingFixtures(out, backup)).rejects.toThrow("backup hash mismatch");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("refuses an in-corpus backup and leaves corrupt existing files unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "doctored-invalid-"));
    const out = join(root, "fixtures");
    mkdirSync(out);
    try {
      const filename = join(out, "pair-01-doctored.png");
      writeFileSync(filename, "not an image");
      await expect(normalizeExistingFixtures(out, out)).rejects.toThrow("outside");
      await expect(normalizeExistingFixtures(out, join(root, "originals"))).rejects.toThrow();
      expect(readFileSync(filename, "utf8")).toBe("not an image");
      expect(existsSync(join(out, "normalization.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it("fully decodes provider images before publication and records code fallback on truncated output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctored-truncated-"));
  try {
    const spec = DOCS[0] as (typeof DOCS)[number];
    const source = await sharp(await pngOf(spec, true))
      .webp({ lossless: true })
      .toBuffer();
    const labels = await makePair(spec, async () => source.subarray(0, Math.floor(source.length / 2)), dir);
    expect(labels[1]?.made_by).toBe("code");
    expect(labels[1]?.note).toContain("undecodable");
    expect((await sharp(readFileSync(join(dir, `${spec.pair}-doctored.png`))).metadata()).format).toBe("png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("retries a partial backup write without leaving a corrupt published backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctored-backup-write-"));
  const out = join(root, "fixtures");
  const backup = join(root, "originals");
  mkdirSync(out);
  try {
    const spec = DOCS[0] as (typeof DOCS)[number];
    const filename = `${spec.pair}-doctored.png`;
    const source = await sharp(await pngOf(spec, true))
      .webp({ lossless: true })
      .toBuffer();
    writeFileSync(join(out, filename), source);
    const publish = (name: string, bytes: Buffer | string, dir: string) => {
      if (!name.endsWith(".original")) return publishFixtureFile(name, bytes, dir);
      publishFixtureFile(name, bytes, dir, {
        ...fs,
        writeFileSync: (path, data) => {
          fs.writeFileSync(path, Buffer.from(data as Buffer).subarray(0, 20));
          throw new Error("injected disk exhaustion");
        },
      });
    };
    await expect(normalizeExistingFixtures(out, backup, publish)).rejects.toThrow("disk exhaustion");
    expect(existsSync(join(backup, `${filename}.original`))).toBe(false);
    expect(existsSync(join(out, "normalization.json"))).toBe(false);
    expect(readFileSync(join(out, filename)).equals(source)).toBe(true);
    const receipt = await normalizeExistingFixtures(out, backup);
    expect(receipt.records).toHaveLength(1);
    expect(readFileSync(join(backup, `${filename}.original`)).equals(source)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("flushes file data before rename and synchronizes its directory before returning", () => {
  const root = mkdtempSync(join(tmpdir(), "doctored-durability-"));
  const events: string[] = [];
  try {
    publishFixtureFile("receipt.json", "{}", root, {
      ...fs,
      writeFileSync: (path, data, options) => {
        expect(options).toMatchObject({ flush: true });
        events.push("write-flushed");
        fs.writeFileSync(path, data, options);
      },
      renameSync: (from, to) => {
        expect(events).toEqual(["write-flushed"]);
        events.push("rename");
        fs.renameSync(from, to);
      },
      fsyncSync: (fd) => {
        expect(events).toContain("rename");
        events.push("directory-flushed");
        fs.fsyncSync(fd);
      },
    });
    expect(events.slice(0, 3)).toEqual(["write-flushed", "rename", "directory-flushed"]);
    expect(readFileSync(join(root, "receipt.json"), "utf8")).toBe("{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
