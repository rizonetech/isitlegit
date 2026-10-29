// Builds the lookalike module's Unicode data (D02 T03 §1): each confusable character's prototype from UTS #39's
// `confusables.txt`, and the code point ranges of Bidi_Class R and AL from the UCD's `DerivedBidiClass.txt`, both
// vendored unchanged in `vendor/unicode/` with their digests in `SHA256SUMS`. A source of another version, or one
// whose digest differs from the recorded one, is refused. `--check` builds afresh and exits non-zero when the committed
// map is missing or differs, writing nothing; `test/node/confusables-map.test.ts` runs it.
//
//   node scripts/build-confusables.ts [--vendor vendor/unicode] [--out src/checks/confusables-map.json] [--check]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const UNICODE_VERSION = "18.0.0";
const SOURCES = { confusables: "confusables.txt", bidi: "DerivedBidiClass.txt" } as const;

export class SourceRefused extends Error {
  override name = "SourceRefused";
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const char = (hex: string) => String.fromCodePoint(Number.parseInt(hex, 16));

function recorded(vendor: string): Map<string, string> {
  const sums = join(vendor, "SHA256SUMS");
  if (!existsSync(sums)) throw new SourceRefused(`${sums} is missing`);
  const digests = new Map<string, string>();
  for (const line of readFileSync(sums, "utf8").split("\n")) {
    const found = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (found) digests.set(found[2] as string, found[1] as string);
  }
  return digests;
}

function source(vendor: string, name: string, digests: Map<string, string>): { text: string; digest: string } {
  const path = join(vendor, name);
  if (!existsSync(path)) throw new SourceRefused(`${path} is missing`);
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  if (digests.get(name) !== digest) throw new SourceRefused(`${name}'s digest is not the one recorded in SHA256SUMS`);
  return { text: bytes.toString("utf8"), digest };
}

export function buildMap(vendor: string): string {
  const digests = recorded(vendor);
  const confusables = source(vendor, SOURCES.confusables, digests);
  const bidi = source(vendor, SOURCES.bidi, digests);
  if (!confusables.text.includes(`# Version: ${UNICODE_VERSION}\n`))
    throw new SourceRefused(`${SOURCES.confusables} is not version ${UNICODE_VERSION}`);
  if (!bidi.text.startsWith(`# DerivedBidiClass-${UNICODE_VERSION}.txt`))
    throw new SourceRefused(`${SOURCES.bidi} is not version ${UNICODE_VERSION}`);

  // `<source> ; <prototype code points> ; MA # comment`, one source character a line.
  const prototypes: Record<string, string> = {};
  for (const line of confusables.text.split("\n")) {
    const found = /^([0-9A-F]{4,6})\s*;\s*([0-9A-F]{4,6}(?: [0-9A-F]{4,6})*)\s*;\s*MA\b/.exec(line);
    if (found) prototypes[char(found[1] as string)] = (found[2] as string).split(" ").map(char).join("");
  }
  // `<first>[..<last>] ; <class> # ...`: the R and AL lines, merged where they touch.
  const ranges: [number, number][] = [];
  for (const line of bidi.text.split("\n")) {
    const found = /^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*(R|AL)\b/.exec(line);
    if (!found) continue;
    const first = Number.parseInt(found[1] as string, 16);
    ranges.push([first, found[2] ? Number.parseInt(found[2], 16) : first]);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const rtl: [number, number][] = [];
  for (const range of ranges) {
    const last = rtl[rtl.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else rtl.push([...range]);
  }
  if (Object.keys(prototypes).length < 1000 || rtl.length === 0)
    throw new SourceRefused("the sources yielded too little data to be the Unicode tables");
  return `${JSON.stringify(
    { version: UNICODE_VERSION, sources: { confusables: confusables.digest, bidi: bidi.digest }, rtl, prototypes },
    null,
    0,
  )}\n`;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      vendor: { type: "string", default: "vendor/unicode" },
      out: { type: "string", default: "src/checks/confusables-map.json" },
      check: { type: "boolean", default: false },
    },
  });
  try {
    const built = buildMap(values.vendor);
    if (values.check) {
      if (!existsSync(values.out)) throw new SourceRefused(`${values.out} is missing: run this without --check`);
      if (readFileSync(values.out, "utf8") !== built)
        throw new SourceRefused(`${values.out} differs from a fresh build: run this without --check and commit it`);
      console.log(`build-confusables: ${values.out} is current (Unicode ${UNICODE_VERSION})`);
    } else {
      writeFileSync(`${values.out}.tmp`, built);
      renameSync(`${values.out}.tmp`, values.out);
      console.log(`build-confusables: wrote ${values.out} (Unicode ${UNICODE_VERSION})`);
    }
  } catch (error) {
    console.error(`build-confusables: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
