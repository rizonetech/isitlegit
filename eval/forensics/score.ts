// Offline component measurement. This never calls a model or changes the production verdict policy.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { register } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { rate, TARGETS, type TargetState } from "../metrics.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
export const MANIFEST = "eval/sets/pdf-forensics/manifest.json";
const pathSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/)
  .refine((p) => !p.split("/").includes(".."));
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const documentSchema = z
  .object({
    path: pathSchema,
    type: z.enum(["proof-of-payment", "bank-letter", "invoice"]),
    generator: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,79}$/),
    label: z.enum(["genuine", "doctored"]),
    edit: z.string().min(1).max(200).nullable(),
    sha256,
  })
  .strict()
  .refine((d) => (d.label === "genuine") === (d.edit === null), "edit must describe doctored documents only");
const manifestSchema = z
  .object({
    version: z.literal(1),
    documents: z.array(documentSchema).min(1).max(500),
    unsupported: z
      .array(z.object({ path: pathSchema, sha256, reason: z.literal("Raster image, not a native PDF") }).strict())
      .max(500),
  })
  .strict();
export type Document = z.infer<typeof documentSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type Observation = {
  document: Document;
  flagged: boolean;
  findings: string[];
  complete: boolean;
  reasons: string[];
};
// The Node adapter's input/output contract. Worker implementation imports stay in the Worker TS project.
export type PdfForensics = {
  findings: { kind: string; says: string; detail: Record<string, unknown> }[];
  coverage: Record<string, { status: "ran" | "partial" | "unavailable"; reason: string | null }>;
  unread: string[];
};
export type Analyse = (bytes: Uint8Array) => Promise<PdfForensics>;
export async function loadForensics(): Promise<{
  analysePdf: Analyse;
  forensicsEvidence: (
    report: PdfForensics,
    file: { key: string; filename: string },
  ) => { check: string; severity: string }[];
  FORENSIC_KINDS: string[];
}> {
  register("../../scripts/lib/ts-resolve.mjs", import.meta.url);
  const modulePath = "../../src/invoice/forensics.ts";
  return import(modulePath);
}

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function bytesAt(root: string, path: string, expected: string): Uint8Array {
  try {
    const file = realpathSync(resolve(root, path));
    const rel = relative(realpathSync(root), file);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error("outside corpus root");
    const bytes = readFileSync(file);
    if (hash(bytes) !== expected) throw new Error("sha256 mismatch");
    return bytes;
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : "unreadable"}`);
  }
}

export function loadManifest(root = ROOT, path = MANIFEST): Manifest {
  const raw = JSON.parse(readFileSync(resolve(root, path), "utf8")) as unknown;
  return validateManifest(raw, (file, expected) => bytesAt(root, file, expected), path);
}

export function parseManifest(raw: unknown, path = MANIFEST): Manifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const input = raw as { documents?: { path?: string }[] };
    const reasons = parsed.error.issues.map((issue) => {
      const index = issue.path[1];
      return `${typeof index === "number" ? (input?.documents?.[index]?.path ?? index) : path}: ${issue.message}`;
    });
    throw new Error(`invalid manifest: ${reasons.join("; ")}`);
  }
  const seen = new Set<string>();
  for (const d of [...parsed.data.documents, ...parsed.data.unsupported]) {
    if (seen.has(d.path)) throw new Error(`${d.path}: duplicate document`);
    seen.add(d.path);
  }
  return parsed.data;
}

export function validateManifest(
  raw: unknown,
  read: (path: string, expected: string) => Uint8Array,
  path = MANIFEST,
): Manifest {
  const manifest = parseManifest(raw, path);
  for (const d of [...manifest.documents, ...manifest.unsupported]) {
    const bytes = read(d.path, d.sha256);
    const native = "label" in d;
    if (
      native
        ? !Buffer.from(bytes).subarray(0, 5).equals(Buffer.from("%PDF-"))
        : !(
            Buffer.from(bytes)
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            Buffer.from(bytes)
              .subarray(0, 3)
              .equals(Buffer.from([255, 216, 255])) ||
            (Buffer.from(bytes).subarray(0, 4).toString() === "RIFF" &&
              Buffer.from(bytes).subarray(8, 12).toString() === "WEBP")
          )
    )
      throw new Error(`${d.path}: content does not match declared ${native ? "PDF" : "raster image"} format`);
  }
  return manifest;
}

export async function observe(manifest: Manifest, root = ROOT, analyse?: Analyse): Promise<Observation[]> {
  const { analysePdf, forensicsEvidence } = await loadForensics();
  const observations: Observation[] = [];
  for (const document of manifest.documents) {
    const report = await (analyse ?? analysePdf)(bytesAt(root, document.path, document.sha256));
    const evidence = forensicsEvidence(report, {
      key: document.path,
      filename: document.path.split("/").at(-1) as string,
    });
    const reasons = Object.entries(report.coverage)
      .filter(([, value]) => value.status !== "ran")
      .map(([kind, value]) => `${kind}: ${value.status}: ${value.reason ?? "unspecified"}`);
    reasons.push(...report.unread);
    observations.push({
      document,
      // src/agent/floor.ts: high floors at suspicious, critical at malicious. Medium is evidence only.
      flagged: evidence.some((e) => e.severity === "high" || e.severity === "critical"),
      findings: evidence.map((e) => `${e.check}:${e.severity}`),
      complete: reasons.length === 0,
      reasons,
    });
  }
  return observations;
}

export function group(rows: Observation[]) {
  const attacks = rows.filter((r) => r.document.label === "doctored");
  const genuine = rows.filter((r) => r.document.label === "genuine");
  const detection = rate(attacks.filter((r) => r.flagged).length, attacks.length);
  const falsePositives = rate(genuine.filter((r) => r.flagged).length, genuine.length);
  const complete = rows.every((r) => r.complete);
  const state = (n: number, met: boolean): TargetState =>
    n === 0 ? "not measured" : !complete ? "incomplete" : met ? "met" : "missed";
  return {
    detection,
    falsePositives,
    measured: rows.filter((r) => r.complete).length,
    total: rows.length,
    findingDocuments: rows.filter((r) => r.findings.length > 0).length,
    detectionTarget: state(detection.n, (detection.rate ?? 0) >= TARGETS.detectionAtLeast),
    falsePositiveTarget: state(falsePositives.n, (falsePositives.rate ?? 1) <= TARGETS.falsePositivesAtMost),
  };
}

const cell = (r: ReturnType<typeof rate>) =>
  `${r.hits}/${r.n} (${r.rate === null ? "not measured" : `${(r.rate * 100).toFixed(1)}%`})`;
const text = (s: string) => s.replace(/[|\r\n]/g, " ");
export function render(manifest: Manifest, rows: Observation[]): string {
  const lines = [
    "## PDF forensics (D08 T02 section 6)",
    "",
    `Manifest SHA-256: ${hash(JSON.stringify(manifest))}. ${rows.length} native PDFs; ${manifest.unsupported.length} raster files inventoried separately as unsupported and excluded from PDF denominators.`,
    "",
    "Component only: high or critical forensic evidence counts as verdict-level detection, matching src/agent/floor.ts. Any-finding counts include medium evidence and are reported separately. Partial/unavailable PDFs stay in their labelled denominators and make the affected group's targets incomplete. No model or production accuracy is measured.",
    "",
    `Targets: detection >= ${TARGETS.detectionAtLeast * 100}%; false positives <= ${TARGETS.falsePositivesAtMost * 100}%. This small synthetic engineering set cannot establish a population false-positive rate of 2%.`,
    "",
    "Missed proof-of-payment and Ghostscript targets, plus missing invoice date coverage: filed at D06 T02 section 8 (console plan commit 20f4747f). This filing is not a repair or target-attainment claim.",
    "",
    "| Group | Detection | False positives | Complete coverage | Any finding | Detection target | FP target |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const groups: [string, Observation[]][] = [["all", rows]];
  for (const type of ["proof-of-payment", "bank-letter", "invoice"])
    groups.push([`type: ${type}`, rows.filter((r) => r.document.type === type)]);
  for (const generator of [...new Set(manifest.documents.map((d) => d.generator))].sort())
    groups.push([`generator: ${generator}`, rows.filter((r) => r.document.generator === generator)]);
  for (const [name, selected] of groups) {
    const g = group(selected);
    lines.push(
      `| ${name} | ${cell(g.detection)} | ${cell(g.falsePositives)} | ${g.measured}/${g.total} | ${g.findingDocuments}/${g.total} | ${g.detectionTarget} | ${g.falsePositiveTarget} |`,
    );
  }
  lines.push("", "| Document | Label | Verdict-level flag | Findings | Coverage |", "| --- | --- | --- | --- | --- |");
  for (const r of rows)
    lines.push(
      `| ${r.document.path} | ${r.document.label} | ${r.flagged} | ${r.findings.join(", ") || "none"} | ${r.complete ? "complete" : text(r.reasons.join("; "))} |`,
    );
  return `${lines.join("\n")}\n`;
}

export function checkReport(report: string, expected: string): boolean {
  const start = report.indexOf("## PDF forensics (D08 T02 section 6)\n");
  if (start < 0) return false;
  const next = report.indexOf("\n## ", start + 1);
  return report.slice(start, next < 0 ? undefined : next).trim() === expected.trim();
}

export async function main(args: string[]): Promise<number> {
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--check"))
    throw new Error("usage: node eval/forensics/score.ts [--check report.md]");
  const manifest = loadManifest();
  const output = render(manifest, await observe(manifest));
  if (args[0] === "--check") {
    if (!checkReport(readFileSync(resolve(args[1] as string), "utf8"), output)) {
      console.error("PDF forensic report differs from recomputed corpus results");
      return 1;
    }
    console.log("PDF forensic report verified");
  } else process.stdout.write(output);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "forensic scoring failed");
    process.exitCode = 2;
  }
}
