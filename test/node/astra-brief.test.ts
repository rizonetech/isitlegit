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

// docs/glimmer/astra-collection-brief-2.md (D03 T04 §18) downloads the same way (D03 T04 §16): its recovery rules are
// the first brief's, and it resumes only its own sweep's folders.
const BRIEF_2 = readFileSync(join(import.meta.dirname, "../../docs/glimmer/astra-collection-brief-2.md"), "utf-8");

describe("the downloads both briefs make", () => {
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
    // No file is accepted unverified: a dataset with no published digest is recorded, never fetched.
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
