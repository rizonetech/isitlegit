// D02 T07 section 6: strict measurement boundary, independent of the extractor.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadSet } from "./load.ts";

const url = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return u.href === s && /https?:/.test(u.protocol);
  } catch {
    return false;
  }
}, "normalized HTTP URL");
export const Coverage = z.enum(["complete", "partial", "unread", "refused"]);
export const Manifest = z
  .array(
    z.strictObject({
      path: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      mediaType: z.enum(["text/plain", "text/html", "image/svg+xml", "application/pdf"]),
      expected: z.array(url).refine((a) => new Set(a).size === a.length, "duplicate expected URL"),
      coverage: Coverage,
      reason: z.string().min(1),
    }),
  )
  .min(1);
export type Entry = z.infer<typeof Manifest>[number];
export function loadCorpus(dir: string) {
  const loaded = loadSet(dir, "links");
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const byPath = new Map(manifest.map((m) => [m.path, m]));
  if (byPath.size !== manifest.length || manifest.length !== loaded.samples.length)
    throw new Error("manifest population mismatch");
  return loaded.samples.map((sample) => {
    const entry = byPath.get(sample.path);
    if (!entry) throw new Error(`manifest missing ${sample.path}`);
    const bytes = readFileSync(sample.file);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(`hash mismatch ${sample.path}`);
    return { ...entry, base64: bytes.toString("base64") };
  });
}
export const Result = z.strictObject({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  urls: z.array(url),
  more: z.number().int().nonnegative(),
  unread: z.array(
    z.strictObject({
      key: z.string(),
      why: z.enum(["missing", "charset", "encrypted", "damaged", "too-large", "too-many"]),
    }),
  ),
  coverage: Coverage,
  error: z.enum(["parser-memory-limit"]).nullable(),
  ms: z.array(z.number().finite().nonnegative()).min(1),
});
export function summarize(entries: Entry[], raw: unknown, repeats: number) {
  const results = z.array(Result).parse(raw);
  const map = new Map(results.map((r) => [r.path, r]));
  if (map.size !== results.length || results.length !== entries.length) throw new Error("result population mismatch");
  let expected = 0,
    matched = 0,
    falseLinks = 0,
    observed = 0;
  const cases = entries.map((entry) => {
    const r = map.get(entry.path);
    if (!r || r.sha256 !== entry.sha256 || r.ms.length !== repeats)
      throw new Error(`identity/hash/repeats mismatch ${entry.path}`);
    const actualCoverage = r.error
      ? "refused"
      : r.more || r.unread.length
        ? r.urls.length
          ? "partial"
          : "unread"
        : "complete";
    if (r.coverage !== actualCoverage || (r.error && (r.urls.length || r.more || r.unread.length)))
      throw new Error(`coverage mismatch ${entry.path}`);
    if (new Set(r.urls).size !== r.urls.length) throw new Error(`duplicate result URL ${entry.path}`);
    const missing = entry.expected.filter((u) => !r.urls.includes(u));
    const invented = r.urls.filter((u) => !entry.expected.includes(u));
    expected += entry.expected.length;
    matched += entry.expected.length - missing.length;
    falseLinks += invented.length;
    observed += r.urls.length;
    const sorted = [...r.ms].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
    return {
      ...r,
      expected: entry.expected.length,
      expectedCoverage: entry.coverage,
      coverageMatches: r.coverage === entry.coverage,
      missing,
      invented,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
    };
  });
  return {
    cases,
    totals: {
      cases: entries.length,
      expected,
      matched,
      observed,
      falseLinks,
      recall: expected ? matched / expected : null,
      falseLinkRate: observed ? falseLinks / observed : null,
    },
    findings: cases.filter((c) => c.missing.length || c.invented.length || !c.coverageMatches),
  };
}
export function parseHarness(status: number | null, stdout: string) {
  if (status !== 0) throw new Error(`Worker harness failed (${status})`);
  const lines = stdout.split(/\r?\n/).filter((s) => s.startsWith("LINK_RESULTS="));
  if (lines.length !== 1 || !lines[0]) throw new Error("missing or duplicate Worker result");
  return JSON.parse(lines[0].slice("LINK_RESULTS=".length));
}
