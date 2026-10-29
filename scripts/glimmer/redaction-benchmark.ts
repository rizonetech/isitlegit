// How well the sample redaction holds (D03 T04 §7), measured on synthetic mail only: seeded personal details of every
// kind the importer promises to remove, written in every way the reviews found one slipping through, are put into
// lure-like pages and run through the real path (`renderRedacted`: images stripped, details redacted, an inert
// render, the post-render check). A page the check refuses counts as refused; on a page it accepts, each seeded detail
// still in the rendered text, or in the screenshot as an OCR engine reads it, counts as survived. The bar is none.
//
//   node scripts/glimmer/redaction-benchmark.ts [pages]   # default 120 pages of 10 details: 1,200 details
//
// Writes `docs/glimmer/redaction-benchmark.json` (every value synthetic) temp-then-rename, and prints the totals.
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clientDomains, leaks, personalDetail, protectedTerms } from "./import-samples.ts";
import { hasImages, namePieces, redact, skeleton, stripImages } from "./redact.ts";
import { openTextReader } from "./source-pages.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const KINDS = ["name", "email", "phone", "id", "card", "account", "domain"] as const;
export const WAYS = [
  "plain",
  "references",
  "soft hyphen",
  "zero width",
  "split by a tag",
  "non-breaking spaces",
  "input value",
  "generated text",
  "vector text",
  "image alt",
  "look-alike letters",
] as const;
type Kind = (typeof KINDS)[number];
type Way = (typeof WAYS)[number];

// A small deterministic generator, so a run is the same run.
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T,
    digits: (n: number) => Array.from({ length: n }, () => Math.floor(next() * 10)).join(""),
  };
}

const FIRST = [
  "Thandiwe",
  "Sipho",
  "Anne-Marie",
  "Pieter",
  "Lerato",
  "Johan",
  "Naledi",
  "Ayesha",
  "Bongani",
  "Elmarie",
];
const LAST = [
  "Mokoena",
  "van der Merwe",
  "Naidoo",
  "Botha",
  "Dlamini",
  "Pillay",
  "Nkosi",
  "Steyn",
  "Khumalo",
  "Fourie",
];
const CLIENT_DOMAIN = "kestrel-holdings.co.za";
const FILLER = "Your account is on hold. Verify your details with FNB online banking today to avoid suspension.";

export type Seeded = { kind: Kind; way: Way; value: string };

// Details no detector is given (D03 T04 §19, plan review finding 5): people the run's client list and recipient headers
// never name, in Afrikaans, isiZulu, Cyrillic and Arabic script, and postal addresses. They measure discovery, so
// they are scored apart from the known kinds, whose bar (nothing survives) the dictionary must meet; their truth stays
// in this record and never reaches `names`, `terms` or `domains`.
export const DISCOVERY = [
  "unlisted name",
  "unlisted name, Cyrillic",
  "unlisted name, Arabic",
  "postal address",
] as const;
type Discovery = (typeof DISCOVERY)[number];
export type Unlisted = { kind: Discovery; value: string };
const UNLISTED: Record<Discovery, readonly string[]> = {
  "unlisted name": ["Hendrik Grobbelaar", "Marlize Swanepoel", "Nomvula Zungu", "Sibusiso Mthembu"],
  "unlisted name, Cyrillic": ["Олена Коваленко", "Дмитрий Соколов"],
  "unlisted name, Arabic": ["فاطمة الزهراء", "يوسف المنصوري"],
  "postal address": [
    "14 Jacaranda Street, Parkhurst, Johannesburg, 2193",
    "7 Kloof Nek Road, Tamboerskloof, Cape Town, 8001",
    "221 Florida Road, Morningside, Durban, 4001",
  ],
};
// What a lure page must keep: the brand it impersonates. A redaction that removes it destroys the lure's cue.
export const CONTROLS = ["FNB", "Standard Bank"] as const;

// One seeded detail's value and the HTML that writes it the given way.
function written(value: string, way: Way): string {
  const mid = Math.max(1, Math.floor(value.length / 2));
  switch (way) {
    case "plain":
      return value;
    case "references":
      return [...value].map((c) => (/[A-Za-z0-9]/.test(c) ? `&#${c.codePointAt(0)};` : c)).join("");
    case "soft hyphen":
      return `${value.slice(0, mid)}&shy;${value.slice(mid)}`.replace("&shy;", "­");
    case "zero width":
      return `${value.slice(0, mid)}​${value.slice(mid)}`;
    case "split by a tag":
      return `${value.slice(0, mid)}<b>${value.slice(mid)}</b>`;
    case "non-breaking spaces":
      return value.replace(/ /g, "&nbsp;");
    case "input value":
      return `<input value="${value}" size=40>`;
    case "generated text":
      return `<span class=g data-x="1"></span><style>.g::after{content:"${value}"}</style>`;
    case "vector text":
      return `<svg width=300 height=30><text x=0 y=20>${value}</text></svg>`;
    case "image alt":
      return `<img alt="${value}" width=200 height=30>`;
    case "look-alike letters":
      // Cyrillic а, е, о and full-width digits, as a lure writes a name to slip past a filter.
      return value
        .replace(/a/g, "\u0430")
        .replace(/e/g, "\u0435")
        .replace(/o/g, "\u043e")
        .replace(/[0-9]/g, (d) => String.fromCodePoint(0xff10 + Number(d)));
  }
}

export function seedPages(pages: number, seed = 20261029) {
  const g = generator(seed);
  const people = FIRST.map((first, i) => ({
    name: `${first} ${LAST[i]}`,
    address: `${first.toLowerCase().replace(/-/g, "")}.${(LAST[i] as string).split(" ").at(-1)?.toLowerCase()}@${CLIENT_DOMAIN}`,
  }));
  const value = (kind: Kind): string => {
    const person = g.pick(people);
    switch (kind) {
      case "name":
        return person.name;
      case "email":
        return person.address;
      case "phone":
        return g.pick([
          `082 ${g.digits(3)} ${g.digits(4)}`,
          `(011) ${g.digits(3)} ${g.digits(4)}`,
          `+27 11 ${g.digits(3)} ${g.digits(4)}`,
          `083-${g.digits(3)}-${g.digits(4)}`,
        ]);
      case "id":
        return `${g.digits(6)} ${g.digits(4)} ${g.digits(3)}`;
      case "card":
        return `4${g.digits(3)} ${g.digits(4)} ${g.digits(4)} ${g.digits(4)}`;
      case "account":
        return `62${g.digits(9)}`;
      case "domain":
        return CLIENT_DOMAIN;
    }
  };
  const out: { html: string; seeded: Seeded[]; unlisted: Unlisted[] }[] = [];
  let n = 0;
  for (let p = 0; p < pages; p++) {
    const seeded: Seeded[] = [];
    let html = `<h1>FNB</h1><p>${FILLER}</p>`;
    for (let i = 0; i < 10; i++, n++) {
      // Every kind meets every way in turn, so each pairing is measured.
      const kind = KINDS[n % KINDS.length] as Kind;
      const way = WAYS[Math.floor(n / KINDS.length) % WAYS.length] as Way;
      const v = value(kind);
      seeded.push({ kind, way, value: v });
      html += `<p>Reference: ${written(v, way)}</p>`;
    }
    // Two details no detector is given, written plainly where a signature or a delivery note would put them.
    const unlisted: Unlisted[] = [0, 1].map((k) => {
      const kind = DISCOVERY[(2 * p + k) % DISCOVERY.length] as Discovery;
      return { kind, value: g.pick(UNLISTED[kind]) };
    });
    for (const u of unlisted) html += `<p>${u.kind === "postal address" ? "Deliver to" : "Regards,"} ${u.value}</p>`;
    out.push({ html: `${html}<p>${FILLER} Standard Bank customers are not affected.</p>`, seeded, unlisted });
  }
  return {
    pages: out,
    names: ["Kestrel Holdings", ...people.flatMap((p) => namePieces(p.name, p.address))],
    terms: protectedTerms(
      ["Kestrel Holdings"],
      people.map((p) => p.address),
      people.flatMap((p) => namePieces(p.name, p.address)),
    ),
    domains: clientDomains(people.map((p) => p.address)),
  };
}

// Whether a seeded detail is still there: a name or address by the protected-term rule, a number by its digits with
// every separator gone.
export function survives(detail: Seeded, text: string): boolean {
  // Both sides read as the screen shows them: look-alike letters and full-width forms folded first, so a detail the
  // benchmark wrote that way is still found if it is still there.
  const seen = skeleton(text);
  const value = skeleton(detail.value);
  if (detail.kind === "name")
    return namePieces(value, undefined).some((piece) => leaks([{ id: "t", text: seen }], [piece]).length > 0);
  if (detail.kind === "email" || detail.kind === "domain")
    return seen
      .toLowerCase()
      .replace(/[\s\u00AD\u200B]/g, "")
      .includes(value.toLowerCase());
  return seen.replace(/\D/g, "").includes(value.replace(/\D/g, ""));
}

// Whether a detail no detector was given is still there: a name by any of its words of three letters or more, an
// address by its street line (number and street).
export function unlistedSurvives(detail: Unlisted, text: string): boolean {
  const seen = skeleton(text).toLowerCase().replace(/\s+/g, " ");
  if (detail.kind === "postal address")
    return seen.includes(
      skeleton(detail.value.split(",")[0] as string)
        .toLowerCase()
        .replace(/\s+/g, " "),
    );
  return skeleton(detail.value)
    .toLowerCase()
    .split(" ")
    .filter((word) => [...word].length >= 3)
    .some((word) => seen.includes(word));
}

export type Tally = { seeded: number; refused: number; survived: number; removed: number };

// The redaction step a pipeline uses, given the same lists the importer has: the dictionary (`redact`), or another
// tool in its place (§19's head-to-head).
export type Redactor = (
  html: string,
  lists: { names: string[]; terms: string[]; domains: string[] },
) => Promise<string>;
export const dictionary: Redactor = async (html, lists) => redact(html, lists.names, lists.domains);

// `renderRedacted()`'s path with only the redaction step swapped: the same image rule before and after, the same inert
// render, the same post-render refusals. With `dictionary` it gives what `renderRedacted()` gives (a test holds the
// two equal on every seeded page), so a pipeline compared here differs from the importer's in its redaction step alone.
export async function renderRedactedBy<T extends { text: string; drawn?: string }>(
  redactor: Redactor,
  render: (html: string) => Promise<T>,
  html: string,
  lists: { names: string[]; terms: string[]; domains: string[] },
): Promise<T> {
  const clean = await redactor(stripImages(html), lists);
  if (hasImages(clean)) throw new Error("refused: an image survived the image rule");
  const page = await render(clean);
  const shown = page.drawn ? `${page.text}\n${page.drawn}` : page.text;
  if (leaks([{ id: "page", text: shown }], lists.terms).length)
    throw new Error("refused: a client detail survived redaction");
  const kind = personalDetail(shown);
  if (kind) throw new Error(`refused: ${kind} survived redaction`);
  return page;
}

export async function runBenchmark(options: {
  pages: number;
  render: (html: string) => Promise<{ screenshot: Uint8Array; text: string }>;
  ocr?: (screenshots: Uint8Array[]) => Promise<string[]>;
  // The redaction step under test; the dictionary when left out.
  redactor?: Redactor;
}) {
  const { pages, names, terms, domains } = seedPages(options.pages);
  const by = new Map<string, Tally>();
  const tally = (key: string) => {
    const t = by.get(key) ?? { seeded: 0, refused: 0, survived: 0, removed: 0 };
    by.set(key, t);
    return t;
  };
  const accepted: { shot: Uint8Array; text: string; seeded: Seeded[]; unlisted: Unlisted[] }[] = [];
  const discovery = new Map<string, Tally>();
  const found = (key: string) => {
    const t = discovery.get(key) ?? { seeded: 0, refused: 0, survived: 0, removed: 0 };
    discovery.set(key, t);
    return t;
  };
  const controls = { kept: 0, lost: 0 };
  let refusedPages = 0;
  let failedPages = 0;
  for (const page of pages) {
    try {
      const shot = await renderRedactedBy(options.redactor ?? dictionary, options.render, page.html, {
        names,
        terms,
        domains,
      });
      accepted.push({ shot: shot.screenshot, text: shot.text, seeded: page.seeded, unlisted: page.unlisted });
    } catch (error) {
      // Only the privacy check's own refusals count as refused; a render that failed measured nothing.
      if (!/^refused: /.test((error as Error).message)) {
        failedPages++;
        continue;
      }
      refusedPages++;
      for (const d of page.seeded) {
        tally(`${d.kind} / ${d.way}`).seeded++;
        tally(`${d.kind} / ${d.way}`).refused++;
      }
      for (const u of page.unlisted) {
        found(u.kind).seeded++;
        found(u.kind).refused++;
      }
    }
  }
  const read = options.ocr ? await options.ocr(accepted.map((a) => a.shot)) : accepted.map(() => "");
  if (read.length !== accepted.length) throw new Error("the OCR engine did not read every screenshot");
  accepted.forEach((page, index) => {
    for (const d of page.seeded) {
      const t = tally(`${d.kind} / ${d.way}`);
      t.seeded++;
      if (survives(d, page.text) || survives(d, read[index] ?? "")) t.survived++;
      else t.removed++;
    }
    for (const u of page.unlisted) {
      const t = found(u.kind);
      t.seeded++;
      if (unlistedSurvives(u, page.text) || unlistedSurvives(u, read[index] ?? "")) t.survived++;
      else t.removed++;
    }
    for (const control of CONTROLS) controls[page.text.includes(control) ? "kept" : "lost"]++;
  });
  const total = [...by.values()].reduce(
    (sum, t) => ({
      seeded: sum.seeded + t.seeded,
      refused: sum.refused + t.refused,
      survived: sum.survived + t.survived,
      removed: sum.removed + t.removed,
    }),
    { seeded: 0, refused: 0, survived: 0, removed: 0 },
  );
  return {
    pages: pages.length,
    refusedPages,
    failedPages,
    screenshotsRead: Boolean(options.ocr),
    total,
    byKindAndWay: Object.fromEntries([...by].sort()),
    // Measured, not barred: what the dictionary was never given (§19). Recall is removed over seeded, per kind.
    discovery: Object.fromEntries([...discovery].sort()),
    controls,
  };
}

if (import.meta.filename === process.argv[1]) {
  const pages = Number(process.argv[2] ?? 120);
  const { systemOcr } = await import("./import-samples.ts");
  const reader = await openTextReader();
  const scratch = mkdtempSync(join(tmpdir(), "redaction-benchmark-"));
  try {
    const result = await runBenchmark({
      pages,
      render: (html) => reader.renderHtml(html, { pictures: false }),
      ocr: async (shots) => {
        const files = shots.map((shot, i) => {
          const file = join(scratch, `${i}.jpg`);
          writeFileSync(file, shot);
          return file;
        });
        return systemOcr(files);
      },
    });
    const out = join(ROOT, "docs", "glimmer", "redaction-benchmark.json");
    writeFileSync(`${out}.tmp`, `${JSON.stringify({ measured: new Date().toISOString(), ...result }, null, 1)}\n`);
    renameSync(`${out}.tmp`, out);
    console.log(
      `redaction benchmark: ${JSON.stringify({ pages: result.pages, refusedPages: result.refusedPages, ...result.total })}`,
    );
    // The bar: nothing survived, every page was measured, and some were accepted (an all-refused run proves nothing).
    process.exitCode = result.total.survived === 0 && result.failedPages === 0 && result.total.removed > 0 ? 0 : 1;
  } finally {
    await reader.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
