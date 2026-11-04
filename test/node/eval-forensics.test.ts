import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, SET } from "../../eval/forensics/build.ts";
import {
  checkReport,
  type Document,
  group,
  loadForensics,
  loadManifest,
  type Observation,
  observe,
  type PdfForensics,
  ROOT,
  render,
} from "../../eval/forensics/score.ts";
import { rate } from "../../eval/metrics.ts";

const { analysePdf, FORENSIC_KINDS } = await loadForensics();

const dirs: string[] = [];
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), "forensic-eval-"));
  dirs.push(path);
  return path;
};
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
const doc: Document = {
  path: "a.pdf",
  type: "invoice",
  generator: "test",
  label: "genuine",
  edit: null,
  sha256: "a".repeat(64),
};
const row = (label: Document["label"], flagged: boolean, complete = true): Observation => ({
  document: { ...doc, label },
  flagged,
  complete,
  findings: flagged ? ["document.forensics.fonts:high"] : [],
  reasons: complete ? [] : ["unreadable"],
});

describe("PDF forensic measurement", () => {
  it("preserves a verified corpus on failed generation and recovers an interrupted publication", async () => {
    const root = temp();
    for (const path of [SET, "test/fixtures/pdf-forensics", "test/fixtures/payment-docs"])
      cpSync(join(ROOT, path), join(root, path), { recursive: true });
    const prior = readFileSync(join(root, SET, "manifest.json"));
    let writes = 0;
    await expect(
      build(root, {
        write: (path, bytes) => {
          if (++writes === 2) throw new Error("disk full");
          writeFileSync(path, bytes);
        },
      }),
    ).rejects.toThrow("disk full");
    expect(readFileSync(join(root, SET, "manifest.json"))).toEqual(prior);
    expect(loadManifest(root).documents).toHaveLength(14);
    await expect(
      build(root, {
        rename: (from, to) => {
          if (from.includes(".pdf-forensics-stage-")) throw new Error("publication interrupted");
          renameSync(from, to);
        },
      }),
    ).rejects.toThrow("publication interrupted");
    expect(readFileSync(join(root, SET, "manifest.json"))).toEqual(prior);
    expect(loadManifest(root).documents).toHaveLength(14);
    // A process killed after saving the old corpus leaves the backup to the next invocation.
    renameSync(join(root, SET), join(root, "eval/sets/.pdf-forensics-previous"));
    await build(root);
    expect(loadManifest(root).documents).toHaveLength(14);
    expect(readFileSync(join(root, SET, "manifest.json"))).toEqual(prior);
    expect(existsSync(join(root, "eval/sets/.pdf-forensics-previous/manifest.json"))).toBe(true);
  });

  it.each(["truncated-pdf", "invalid-manifest", "truncated-manifest"])(
    "rejects staged %s without changing prior bytes",
    async (fault) => {
      const root = temp();
      for (const path of [SET, "test/fixtures/pdf-forensics", "test/fixtures/payment-docs"])
        cpSync(join(ROOT, path), join(root, path), { recursive: true });
      const before = readdirSync(join(root, SET)).map((name) => [name, readFileSync(join(root, SET, name))] as const);
      await expect(
        build(root, {
          write: (path, bytes) => {
            if (fault === "truncated-pdf" && path.endsWith(".pdf")) writeFileSync(path, "%PDF-");
            else if (fault === "invalid-manifest" && path.endsWith("manifest.json"))
              writeFileSync(path, '{"version":2}');
            else if (fault === "truncated-manifest" && path.endsWith("manifest.json")) writeFileSync(path, "{");
            else writeFileSync(path, bytes);
          },
        }),
      ).rejects.toThrow();
      for (const [name, bytes] of before) expect(readFileSync(join(root, SET, name))).toEqual(bytes);
      expect(readdirSync(join(root, "eval/sets")).filter((name) => name.includes("stage-"))).toEqual([]);
    },
  );

  it.each(["write", "saved", "promoted"])("recovers after actual process termination at %s", async (boundary) => {
    const root = temp();
    for (const path of [SET, "test/fixtures/pdf-forensics", "test/fixtures/payment-docs"])
      cpSync(join(ROOT, path), join(root, path), { recursive: true });
    const prior = readFileSync(join(root, SET, "manifest.json"));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {build} from ${JSON.stringify(join(ROOT, "eval/forensics/build.ts"))};
      import {writeFileSync,renameSync} from 'node:fs';
      await build(${JSON.stringify(root)}, {
        write(path,bytes) { writeFileSync(path,bytes); if (${JSON.stringify(boundary)} === 'write') process.kill(process.pid, 'SIGKILL'); },
        rename(from,to) { renameSync(from,to); if ((${JSON.stringify(boundary)} === 'saved' && to.endsWith('.pdf-forensics-previous')) || (${JSON.stringify(boundary)} === 'promoted' && from.includes('.pdf-forensics-stage-'))) process.kill(process.pid, 'SIGKILL'); }
      });
    `,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(result.signal, result.stderr).toBe("SIGKILL");
    await build(root);
    expect(loadManifest(root).documents).toHaveLength(14);
    expect(readFileSync(join(root, SET, "manifest.json"))).toEqual(prior);
    await build(root);
    expect(readFileSync(join(root, SET, "manifest.json"))).toEqual(prior);
  });

  it("refuses a second writer while an actual builder owns publication", async () => {
    const root = temp();
    for (const path of [SET, "test/fixtures/pdf-forensics", "test/fixtures/payment-docs"])
      cpSync(join(ROOT, path), join(root, path), { recursive: true });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {build} from ${JSON.stringify(join(ROOT, "eval/forensics/build.ts"))};
      await build(${JSON.stringify(root)}, {write() { process.stdout.write('held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); }});
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error("builder exited before holding lock")));
        child.stdout.once("data", () => resolve());
      });
      await expect(build(root)).rejects.toThrow("already running");
      expect(loadManifest(root).documents).toHaveLength(14);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
    await build(root);
    expect(loadManifest(root).documents).toHaveLength(14);
  });

  it("regenerates pins when legitimate external fixture bytes change", async () => {
    const root = temp();
    for (const path of [SET, "test/fixtures/pdf-forensics", "test/fixtures/payment-docs"])
      cpSync(join(ROOT, path), join(root, path), { recursive: true });
    const external = loadManifest(root).unsupported[0];
    if (!external) throw new Error("missing raster fixture");
    writeFileSync(
      join(root, external.path),
      Buffer.concat([readFileSync(join(root, external.path)), Buffer.from("changed")]),
    );
    expect(() => loadManifest(root)).toThrow("sha256 mismatch");
    await build(root);
    expect(loadManifest(root).unsupported[0]?.sha256).not.toBe(external.sha256);
  });

  it("counts genuine findings as false positives and reuses main metric arithmetic", () => {
    const g = group([row("genuine", true), row("genuine", false), row("doctored", true), row("doctored", false)]);
    expect(g.falsePositives).toEqual(rate(1, 2));
    expect(g.detection).toEqual(rate(1, 2));
    expect(g.falsePositiveTarget).toBe("missed");
    expect(g.detectionTarget).toBe("missed");
  });

  it("keeps unavailable documents in denominators without certifying clean targets", () => {
    const g = group([row("genuine", false, false), row("doctored", false, false)]);
    expect(g).toMatchObject({
      measured: 0,
      total: 2,
      falsePositiveTarget: "incomplete",
      detectionTarget: "incomplete",
    });
    expect(g.falsePositives).toEqual(rate(0, 1));
    expect(group([])).toMatchObject({
      detection: rate(0, 0),
      falsePositives: rate(0, 0),
      detectionTarget: "not measured",
      falsePositiveTarget: "not measured",
    });
  });

  it("measures real PDF bytes with independently expected findings and coverage", async () => {
    const manifest = loadManifest();
    expect(manifest.documents).toHaveLength(14);
    expect(manifest.unsupported).toHaveLength(40);
    const rows = await observe(manifest);
    expect(group(rows)).toMatchObject({
      detection: rate(3, 7),
      falsePositives: rate(0, 7),
      measured: 13,
      findingDocuments: 8,
    });
    for (const type of ["bank-letter", "invoice", "proof-of-payment"]) {
      const r = rows.find((r) => r.document.path.endsWith(`${type}-doctored.pdf`));
      expect(r).toMatchObject({
        flagged: true,
        complete: true,
        findings: ["document.forensics.revisions:high", "document.forensics.fonts:high"],
      });
    }
    expect(rows.find((r) => r.document.path.endsWith("gs-edited-pop.pdf"))).toMatchObject({
      flagged: false,
      findings: ["document.forensics.revisions:medium"],
    });
    expect(rows.find((r) => r.document.path.endsWith("chromium-invoice.pdf"))?.reasons).toContain(
      "dates: unavailable: the document states no payment date",
    );
    const empty = await observe(manifest, ROOT, async (bytes) => ({ ...(await analysePdf(bytes)), findings: [] }));
    expect(group(empty).detection.hits).toBe(0);
    expect(group(empty).detection).not.toEqual(group(rows).detection);
  });

  it("scores fixed analyses at the real severity threshold and preserves partial reasons", async () => {
    const manifest = loadManifest();
    const fixture = manifest.documents[0] as Document;
    const baseline = await analysePdf(new Uint8Array(readFileSync(join(ROOT, fixture.path))));
    const report = (kinds: ("revisions" | "dates" | "fonts")[]): PdfForensics => ({
      ...baseline,
      findings: kinds.map((kind) => ({ kind, says: "synthetic finding", detail: {} })),
    });
    const one = { ...manifest, documents: [fixture], unsupported: [] };
    expect((await observe(one, ROOT, async () => report(["revisions", "dates"])))[0]?.flagged).toBe(false);
    expect((await observe(one, ROOT, async () => report(["revisions", "fonts"])))[0]?.flagged).toBe(true);
    for (const status of ["partial", "unavailable"] as const) {
      const partial = {
        ...baseline,
        coverage: Object.fromEntries(
          FORENSIC_KINDS.map((k) => [k, { status, reason: "test coverage gap" }]),
        ) as PdfForensics["coverage"],
      };
      const rows = await observe(one, ROOT, async () => partial);
      expect(rows[0]?.reasons).toHaveLength(5);
      expect(group(rows).falsePositiveTarget).toBe("incomplete");
    }
  });

  it.each(["hash", "type", "generator", "missing", "duplicate", "not-pdf"])(
    "refuses %s with document identity",
    (kind) => {
      const root = temp();
      const bytes = Buffer.from(kind === "not-pdf" ? "not a PDF" : "%PDF-1.7\nfixture");
      const entry: Record<string, unknown> = { ...doc, sha256: createHash("sha256").update(bytes).digest("hex") };
      writeFileSync(join(root, "a.pdf"), bytes);
      if (kind === "hash") entry.sha256 = "0".repeat(64);
      if (kind === "type" || kind === "generator") delete entry[kind];
      if (kind === "missing") rmSync(join(root, "a.pdf"));
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({ version: 1, documents: kind === "duplicate" ? [entry, entry] : [entry], unsupported: [] }),
      );
      expect(() => loadManifest(root, "manifest.json")).toThrow(/a\.pdf/);
    },
  );

  it("runs the CLI, reads the report back and refuses changed counts", async () => {
    const manifest = loadManifest();
    const expected = render(manifest, await observe(manifest));
    const cli = execFileSync(process.execPath, ["eval/forensics/score.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(cli).toBe(expected);
    expect(cli).toContain("| all | 3/7 (42.9%) | 0/7 (0.0%) | 13/14 | 8/14 | incomplete | incomplete |");
    const path = join(temp(), "report.md");
    writeFileSync(path, `# Results\n\n${cli}\n## Other measurement\n\nUnrelated evidence.\n`);
    expect(spawnSync(process.execPath, ["eval/forensics/score.ts", "--check", path], { cwd: ROOT }).status).toBe(0);
    writeFileSync(path, cli.replace("3/7 (42.9%)", "4/7 (57.1%)"));
    expect(spawnSync(process.execPath, ["eval/forensics/score.ts", "--check", path], { cwd: ROOT }).status).toBe(1);
    expect(checkReport("# no result", expected)).toBe(false);
  });
});
