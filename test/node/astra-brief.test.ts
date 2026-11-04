import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// docs/glimmer/astra-collection-brief.md (D03 T04 §4) is the whole of Astra's instructions for collecting page
// datasets, so each rule it must carry is checked by its substance, not only its heading, and each check is shown to
// fail on a copy of the brief with that rule taken out.
const BRIEF = readFileSync(join(import.meta.dirname, "../../docs/glimmer/astra-collection-brief.md"), "utf-8");

// Each heading with the phrases its section must hold.
const RULES: Record<string, string[]> = {
  Goal: ["fake shops", "lookalike company, supplier or social network pages", "benign pages", "South Africa"],
  "Candidate sources": ["Phishpedia", "PhishIntention", "VisualPhishNet", "PILWD-134K", "fake-shop"],
  "Licence rule": ["commercial product", "research-only", "non-commercial", "unclear", "`REJECTED.md`", "4.9"],
  "Safety rules": [
    "Download only from the dataset's official page",
    "Never open, fetch or render a live phishing URL",
    "Never execute",
    "Never unpack an archive",
    "Do not log in",
    "Write nothing outside the folder you start in",
  ],
  "Output layout": [
    "`URL:`",
    "`Licence:`",
    "`Licence quote:`",
    "`Licence link:`",
    "`Files:`",
    "SHA-256",
    "`Items:`",
    "`Date:`",
  ],
  "Recovery rules": [
    "`<source>/.partial/`",
    "only after its SHA-256 has been computed",
    "`python3 .fetch.py --url <url> --dest <source>/<name> --sha256",
    "its published digest matches",
    "A rerun keeps `.partial/`",
    "resumes an unfinished file",
    "make no retries of your own",
    "`COLLECTED.md` is written last, through a temporary file and a rename",
    "only when every file it lists is in place",
    "skips a source whose `COLLECTED.md` hashes still match",
    "renames it to `COLLECTED.invalid-<UTC stamp>.md`",
    "other sources are left as they are",
  ],
  "Stop conditions": [
    "At most 3 attempts per file",
    "5 GB per source",
    "20 GB in all",
    "30 candidate sources",
    "4 hours",
    "less than 10 GB free",
  ],
  Report: ["every candidate you researched"],
};

// Which rules a brief is missing: a heading absent, or a phrase absent from under its heading.
function missing(brief: string): string[] {
  const sections = new Map<string, string>();
  for (const part of brief.split(/^## /m).slice(1)) {
    const [title = "", ...body] = part.split("\n");
    sections.set(title.trim(), body.join("\n"));
  }
  const gaps: string[] = [];
  for (const [heading, phrases] of Object.entries(RULES)) {
    const body = sections.get(heading);
    if (body === undefined) {
      gaps.push(`## ${heading}`);
      continue;
    }
    for (const phrase of phrases) if (!body.includes(phrase)) gaps.push(`${heading}: ${phrase}`);
  }
  return gaps;
}

describe("Astra's collection brief", () => {
  it("names every path relative to the folder Astra starts in, never under a second raw/", () => {
    // astra-collect.py starts Codex in <store>/raw, so a `raw/` path in the brief would land in <store>/raw/raw.
    expect(BRIEF).toContain("every path in this brief is relative to it");
    // The only `raw/` paths left are the store folder itself and the example of what not to write.
    expect(BRIEF.match(/`raw\/[^`]*`/g) ?? []).toEqual(["`raw/`", "`raw/<source>/`"]);
    expect(BRIEF).toContain("never `raw/<source>/`");
  });

  it("carries every rule under its heading", () => {
    expect(missing(BRIEF)).toEqual([]);
  });

  it("is caught missing any one rule", () => {
    for (const [heading, phrases] of Object.entries(RULES)) {
      expect(missing(BRIEF.replace(`## ${heading}\n`, "## Removed\n"))).toContain(`## ${heading}`);
      for (const phrase of phrases) {
        const copy = BRIEF.split(phrase).join("");
        expect(missing(copy), `${heading}: ${phrase}`).toContain(`${heading}: ${phrase}`);
      }
    }
  });
});

describe("the second brief, for Loupe 1.1 (D03 T04 §27)", () => {
  const brief = readFileSync(join(import.meta.dirname, "../../docs/glimmer/astra-collection-brief-2.md"), "utf-8");
  const sources = readFileSync(join(import.meta.dirname, "../../docs/glimmer/sources.md"), "utf-8");
  const decided = (text: string) => {
    const start = text.indexOf("## Already decided: do not research again");
    return text.slice(start, text.indexOf("\n## ", start + 1));
  };
  it("names every source docs/glimmer/sources.md has decided, so none is researched twice", () => {
    const codes = [...sources.matchAll(/^\| `([a-z0-9-]+)`/gm)].map((m) => m[1] as string);
    expect(codes.length).toBeGreaterThan(50);
    for (const code of codes) expect(decided(brief)).toContain(`\`${code}\``);
    // Caught missing one.
    const first = codes[0] as string;
    expect(decided(brief.replace(`\`${first}\``, ""))).not.toContain(`\`${first}\``);
  });

  it("keeps 1.1 apart from the frozen 1.0, and keeps the commercial licence rule", () => {
    expect(brief).toMatch(/nothing this sweep brings reaches Loupe 1\.0/);
    expect(brief).toMatch(/training a model in a commercial product/);
    expect(brief).toMatch(/research-only, non-commercial/);
  });
});

// docs/glimmer/astra-collection-brief-2.md (D03 T04 §18) downloads the same way (D03 T04 §16): its recovery rules are
// the first brief's, and it resumes only its own sweep's folders.
const BRIEF_2 = readFileSync(join(import.meta.dirname, "../../docs/glimmer/astra-collection-brief-2.md"), "utf-8");

describe("the downloads both briefs make", () => {
  it("download a source of several files in one --manifest run, COLLECTED.md only after exit 0 (D03 T04 §23)", () => {
    for (const [brief, floor] of [
      [BRIEF, "10000000000"],
      [BRIEF_2, "20000000000"],
    ] as const) {
      expect(brief).toContain(`\`python3 .fetch.py --manifest <source>/.manifest.jsonl --min-free ${floor}\``);
      expect(brief).toContain("Write `COLLECTED.md` only after exit 0.");
      expect(brief).toContain("2 that the manifest was refused before anything was fetched");
    }
  });

  it("resume through .fetch.py and never delete a partial download", () => {
    for (const brief of [BRIEF, BRIEF_2]) {
      expect(missing(brief).filter((gap) => gap.startsWith("Recovery rules"))).toEqual([]);
      expect(brief).not.toContain("deletes `.partial/`");
    }
    expect(BRIEF_2).toContain("This sweep resumes only the folders it made itself, those holding `.sweep-2`");
    expect(BRIEF_2).toContain("put an empty `<source>/.sweep-2` in it before its first download");
    expect(BRIEF_2).toContain("except a folder this sweep made itself, which holds `.sweep-2`");
    // A recollection after an invalid manifest keeps the mark, so an interrupted one can still be resumed.
    expect(BRIEF_2).toContain("deletes that source's other files except `.sweep-2`");
    // A missing digest still refuses unless the second brief supplies the immutable-pin contract.
    for (const [brief, floor, rejected] of [
      [BRIEF, "10000000000", "`REJECTED.md`"],
      [BRIEF_2, "20000000000", "`REJECTED-2.md`"],
    ] as const) {
      expect(brief).not.toContain("--unpublished");
      expect(brief).toContain(`record it in ${rejected} with the reason \`no published digest\``);
      expect(brief).toContain(`\`--min-free ${floor}\``);
    }
  });
});

// D03 T04 §42: deleting a trust rule from the brief must fail its contract.
describe("second-sweep immutable downloads", () => {
  const rules = [
    '--pin "github: <owner>/<repo>, <40-hex commit>"',
    '--pin "huggingface: <owner>/<dataset>, <40-hex commit>"',
    "matching immutable artifact URL",
    '"pin": "github: <owner>/<repo>, <40-hex commit>"',
    "Never delete `.download-pins/` during cleanup or recollection",
    "changed bytes must refuse against the original receipt",
    "consumes the download receipt",
    "`.fetch-inputs.py` is the shared validator",
    "a new destination, never a replacement receipt",
  ];
  const missingPins = (text: string) => rules.filter((rule) => !text.includes(rule));
  it("preserves first-download trust through collection and cleanup", () => {
    expect(missingPins(BRIEF_2)).toEqual([]);
    for (const rule of rules) expect(missingPins(BRIEF_2.replace(rule, ""))).toContain(rule);
  });
});
