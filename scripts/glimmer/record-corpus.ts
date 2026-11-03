// Record the §38 replay corpus: for each sampled benign-list URL, one visit by the production renderer that yields
// the replay archive (a HAR with bodies), the viewed capture replay is checked against, and the screenshot an
// annotator views. Labels are never derived here from either pipeline's readers: a recorded page carries pending
// (`unknown`) labels until `annotate` applies a label assigned by viewing its screenshot.
//
//     node scripts/glimmer/record-corpus.ts <per-stratum 1..100>                       # a new corpus
//     node scripts/glimmer/record-corpus.ts <per-stratum 1..100> topup <stratum>       # more pages for one stratum
//     node scripts/glimmer/record-corpus.ts annotate <annotations.jsonl>               # apply viewed labels
//
// Strata: walls (journal exclusions for a challenge, CAPTCHA, cookie wall or suspended host), genuine (stored benign
// pages with no form), login (stored benign pages and benign-sa sign-in pages showing a login form), payment
// (benign-sa checkout pages). The corpus lands in `<store>/runs/compare/corpus/`: `corpus.json` (seed and each page
// file's sha256), `pages/<id>.json`, `shots/<id>.jpg` and `har/<id>.har.json`. A page whose recording fails is
// counted and named, never silently dropped.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDomain } from "tldts";
import { dhash } from "./build-dataset.ts";
import { type BenignLabel, type CorpusPage, corpusDir, corpusPageFile } from "./compare-pipelines.ts";
import { openRenderer, type ReplayArchive, type ReplayResponse } from "./render.ts";
import { openStore, storeDir } from "./store.ts";

export const CORPUS_SEED = 20261102;
export const STRATA = ["walls", "genuine", "login", "payment"] as const;
export function seededSample<T>(items: T[], n: number, seed = CORPUS_SEED): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out.slice(0, n);
}

type HarEntry = {
  request: { url: string; method?: string; postData?: { text?: string } };
  response: {
    status: number;
    headers: { name: string; value: string }[];
    content: { text?: string; encoding?: string; mimeType?: string };
  };
};
// Video and audio carry no text, form or wall evidence a still capture shows, and a body past this size is a
// download rather than a page part: replay answers those empty. Images and fonts are kept, since an image-based
// challenge or a wall drawn in a web font is evidence the screenshot and the admission check see.
export const ARCHIVE_BODY_LIMIT = 5_000_000;
export function harToArchive(har: { log: { entries: HarEntry[] } }): ReplayArchive {
  const archive: ReplayArchive = {};
  const append = (key: string, response: ReplayResponse) => {
    const held = archive[key];
    // A request answered more than once keeps every answer in order: replay serves them in the same order.
    if (held) held.later = [...(held.later ?? []), response];
    else archive[key] = { ...response };
  };
  for (const entry of har.log.entries) {
    const text = entry.response.content.text ?? "";
    const mime = entry.response.content.mimeType ?? "";
    const dropped = /^(video|audio)\//.test(mime) || text.length > ARCHIVE_BODY_LIMIT;
    const response: ReplayResponse = {
      status: entry.response.status,
      headers: Object.fromEntries(entry.response.headers.map((h) => [h.name.toLowerCase(), h.value])),
      bodyBase64: dropped
        ? ""
        : entry.response.content.encoding === "base64"
          ? text
          : Buffer.from(text).toString("base64"),
    };
    const verb = (entry.request.method ?? "GET").toUpperCase();
    const post = entry.request.postData?.text ?? "";
    if (verb !== "GET") {
      if (post) append(`${verb} ${entry.request.url} ${post}`, response);
      append(`${verb} ${entry.request.url}`, response);
    } else {
      append(entry.request.url, response);
    }
  }
  return archive;
}

const ERROR_VIEWED =
  /(page|file) (that )?(you('re| are| were) looking for )?(could not|can['’]t|cannot|doesn['’]t|does not) be found|page not found|404 not found|error 404|account (has been |is )?suspended|hosting account.{0,40}suspended|domain (is )?(parked|for sale)|website (is )?(coming soon|under construction)/i;
// Whether a viewed capture is a valid benign page or an invalid capture (non-2xx status, a wall, a cross-site
// redirect outside its allowed destinations, an HTTP-200 error/suspended/parked page, a missing listed brand, or
// under 50 characters of visible text). Legitimate subdomain and `also` redirects stay eligible.
export function viewedEligibility(viewed: {
  status: number;
  title?: string;
  text: string;
  finalUrl?: string;
  url: string;
  brand?: string;
  also?: string[];
  wall: boolean;
}): { eligible: boolean; reason: string } {
  const domain = (u: string) => {
    if (!u) return "";
    try {
      return new URL(u.includes("://") ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  };
  const landed = domain(viewed.finalUrl ?? "");
  const listed = domain(viewed.url);
  const landedSite = landed ? (getDomain(landed) ?? landed) : "";
  const listedSite = listed ? (getDomain(listed) ?? listed) : "";
  const sameSite =
    !landed ||
    !listed ||
    landed === listed ||
    landedSite === listedSite ||
    landed.endsWith(`.${listed}`) ||
    listed.endsWith(`.${landed}`) ||
    (viewed.also ?? []).some((a) => {
      const allowed = domain(a);
      const allowedSite = allowed ? (getDomain(allowed) ?? allowed) : "";
      return Boolean(allowed) && (landed === allowed || landedSite === allowedSite || landed.endsWith(`.${allowed}`));
    });
  const brandToken = viewed.brand
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .trim()
    .split(/\s+/)[0];
  const combined = `${viewed.title ?? ""}\n${viewed.text}`;
  if (viewed.status < 200 || viewed.status > 299) return { eligible: false, reason: `HTTP ${viewed.status}` };
  if (viewed.wall) return { eligible: false, reason: "a challenge or wall page is shown" };
  if (!sameSite) return { eligible: false, reason: `cross-site redirect to ${landed}` };
  if (ERROR_VIEWED.test(`${viewed.title ?? ""}\n${viewed.text.slice(0, 2000)}`))
    return { eligible: false, reason: "an error page, suspended host or parked domain answered with 200" };
  if (brandToken && !combined.toLowerCase().includes(brandToken))
    return { eligible: false, reason: `the listed brand (${viewed.brand}) is not on the page` };
  if (viewed.text.trim().length < 50) return { eligible: false, reason: "under 50 characters of visible text" };
  return { eligible: true, reason: "valid benign capture" };
}

// The next free number for a top-up of `stratum`: one past the largest number any of that stratum's ids carries
// (`<stratum>-<n>` or `<stratum>-topup-<n>`). Recording failures leave gaps, so a count of pages would reuse an id
// and overwrite its page file; another stratum's ids never count.
export function nextTopupOffset(ids: string[], stratum: string): number {
  const own = new RegExp(`^${stratum}-(?:topup-)?(\\d+)$`);
  return ids.reduce((next, id) => {
    const n = own.exec(id)?.[1];
    return n === undefined ? next : Math.max(next, Number(n) + 1);
  }, 0);
}

// One page's labels before anyone has viewed it: every field unresolved, so it enters no rate.
export const PENDING_LABEL: BenignLabel = {
  wall: "unknown",
  form: "unknown",
  eligible: "unknown",
  eligibility_reason: "awaiting a viewed annotation",
};

// A label assigned by viewing a recorded page's screenshot, one JSON line each. `screenshot_sha256` names the
// picture that was viewed, so a label never lands on a page re-recorded since. `wall`, `form` and `eligible` may be
// "unknown" or "disputed" when the viewer cannot tell; `reason` says why the page is or is not a valid benign
// capture (HTTP error page, suspended host or parked domain, wrong-site redirect, missing brand, a challenge).
export type ViewedAnnotation = {
  id: string;
  screenshot_sha256: string;
  wall: boolean | "unknown" | "disputed";
  form: "login" | "payment" | "none" | "unknown" | "disputed";
  eligible: boolean | "unknown" | "disputed";
  reason: string;
  annotator: string;
};
const UNRESOLVED = ["unknown", "disputed"];
export function parseAnnotations(text: string): { annotations: ViewedAnnotation[]; problems: string[] } {
  const annotations: ViewedAnnotation[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let a: Partial<ViewedAnnotation>;
    try {
      a = JSON.parse(line) as Partial<ViewedAnnotation>;
    } catch {
      problems.push(`line ${i + 1} is not JSON`);
      return;
    }
    const where = `line ${i + 1}${typeof a.id === "string" ? ` (${a.id})` : ""}`;
    if (typeof a.id !== "string" || !a.id) problems.push(`${where} has no id`);
    else if (seen.has(a.id)) problems.push(`${where} repeats an id`);
    if (typeof a.screenshot_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.screenshot_sha256))
      problems.push(`${where} names no screenshot sha256`);
    if (!(typeof a.wall === "boolean" || UNRESOLVED.includes(a.wall as string))) problems.push(`${where} has no wall`);
    if (!["login", "payment", "none", ...UNRESOLVED].includes(a.form as string)) problems.push(`${where} has no form`);
    if (!(typeof a.eligible === "boolean" || UNRESOLVED.includes(a.eligible as string)))
      problems.push(`${where} has no eligibility`);
    if (typeof a.reason !== "string" || !a.reason.trim()) problems.push(`${where} has no reason`);
    if (typeof a.annotator !== "string" || !a.annotator.trim()) problems.push(`${where} names no annotator`);
    if (typeof a.id === "string") seen.add(a.id);
    annotations.push(a as ViewedAnnotation);
  });
  return { annotations, problems };
}

// Applies a viewed annotation to a recorded page: refused when the annotation viewed another picture.
export function applyAnnotation(page: CorpusPage, a: ViewedAnnotation): CorpusPage {
  if (page.viewed.screenshot?.sha256 !== a.screenshot_sha256)
    throw new Error(`${page.id}: the annotation viewed a different screenshot than the one recorded`);
  return {
    ...page,
    label: { wall: a.wall, form: a.form, eligible: a.eligible, eligibility_reason: a.reason, source: a.annotator },
  };
}

type Manifest = { seed: number; recorded: string; page_files: { id: string; sha256: string }[]; failed: string[] };
const manifestFile = (dir: string) => join(corpusDir(dir), "corpus.json");
function writeAtomic(file: string, data: string | Uint8Array): void {
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}
function writePage(dir: string, page: CorpusPage): { id: string; sha256: string } {
  const data = JSON.stringify(page);
  writeAtomic(corpusPageFile(dir, page.id), data);
  return { id: page.id, sha256: createHash("sha256").update(data).digest("hex") };
}
function writeManifest(dir: string, manifest: Manifest): void {
  writeAtomic(manifestFile(dir), `${JSON.stringify(manifest)}\n`);
}

if (import.meta.filename === process.argv[1]) {
  const usage =
    "usage: node scripts/glimmer/record-corpus.ts <per-stratum 1..100> [--replace | topup <walls|genuine|login|payment>] | annotate <annotations.jsonl>";
  const dir = storeDir();
  if (process.argv[2] === "annotate") {
    const source = process.argv[3];
    if (!source || process.argv.length > 4 || !existsSync(source)) {
      console.error(usage);
      process.exit(2);
    }
    const { annotations, problems } = parseAnnotations(readFileSync(source, "utf-8"));
    const manifest = JSON.parse(readFileSync(manifestFile(dir), "utf-8")) as Manifest;
    const held = new Set(manifest.page_files.map((p) => p.id));
    for (const a of annotations) if (!held.has(a.id)) problems.push(`${a.id} is not a corpus page`);
    if (problems.length) {
      console.error(`record-corpus annotate: refused, nothing written (${problems.join("; ")})`);
      process.exit(1);
    }
    const byId = new Map(annotations.map((a) => [a.id, a]));
    // Every page is checked before any is written, so a refused annotation leaves the corpus as it was.
    const updated: CorpusPage[] = [];
    for (const { id } of manifest.page_files) {
      const a = byId.get(id);
      if (!a) continue;
      updated.push(applyAnnotation(JSON.parse(readFileSync(corpusPageFile(dir, id), "utf-8")) as CorpusPage, a));
    }
    const digests = new Map(updated.map((page) => [page.id, writePage(dir, page).sha256]));
    writeManifest(dir, {
      ...manifest,
      page_files: manifest.page_files.map((p) => ({ id: p.id, sha256: digests.get(p.id) ?? p.sha256 })),
    });
    console.log(
      JSON.stringify({ annotated: updated.length, pending: manifest.page_files.length - updated.length, source }),
    );
    process.exit(0);
  }
  const per = Number(process.argv[2]);
  const mode = process.argv[3];
  const topupStratum = process.argv[4];
  const topup = mode === "topup";
  const replace = mode === "--replace";
  if (
    !Number.isInteger(per) ||
    per < 1 ||
    per > 100 ||
    (mode !== undefined && !topup && !replace) ||
    (topup && !(STRATA as readonly string[]).includes(topupStratum ?? "")) ||
    process.argv.length > (topup ? 5 : replace ? 4 : 3)
  ) {
    console.error(usage);
    process.exit(2);
  }
  const existing: Manifest | null =
    !replace && existsSync(manifestFile(dir))
      ? (JSON.parse(readFileSync(manifestFile(dir), "utf-8")) as Manifest)
      : null;
  // A new corpus never lands over one on disk without --replace: its pages, labels and digests are another run's evidence.
  if (!topup && !replace && existing) {
    console.error(`record-corpus: ${manifestFile(dir)} already holds a corpus; top it up or record into a new store`);
    process.exit(1);
  }
  if (topup && !existing) {
    console.error("record-corpus: there is no corpus to top up");
    process.exit(1);
  }
  const store = openStore(dir);
  const stored: { url: string; login: boolean; payment: boolean; kind: string; brand?: string }[] = [];
  for (const page of store.manifest()) {
    if (!page.id.startsWith("benign-") || !page.url) continue;
    stored.push({
      url: page.url,
      login: page.labels?.has_login_form === true,
      payment: page.labels?.has_payment_form === true,
      kind: page.kind ?? "home",
      ...(page.labels?.brand ? { brand: page.labels.brand } : {}),
    });
  }
  const journal = readFileSync(join(dir, "raw", "benign", "progress.jsonl"), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { url: string; event: string; reason?: string });
  const walls = journal
    .filter((e) => e.event === "excluded" && /challenge|captcha|cookie wall|suspended/i.test(e.reason ?? ""))
    .map((e) => e.url);
  const sa = readFileSync(join(process.cwd(), "eval", "glimmer", "benign-sa-urls.txt"), "utf-8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 2);
  type Candidate = { url: string; entry: { kind: string; brand?: string; also: string[] } };
  const fromSa = (p: string[]): Candidate => ({
    url: p[1] as string,
    entry: {
      kind: p[0] as string,
      ...(p[2] ? { brand: p[2] } : {}),
      also: (p[3] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
  });
  const saByUrl = new Map(sa.map((p) => [p[1] as string, fromSa(p).entry]));
  const fromStored = (p: (typeof stored)[number]): Candidate => ({
    url: p.url,
    entry: saByUrl.get(p.url) ?? { kind: p.kind, also: [] },
  });
  const allStrata: Record<string, Candidate[]> = {
    walls: [...new Set(walls)].map((url) => ({ url, entry: { kind: "home", also: [] } })),
    genuine: stored.filter((p) => !p.login && !p.payment).map(fromStored),
    login: [
      ...stored.filter((p) => p.login && (p.kind === "login" || p.kind === "account")).map(fromStored),
      ...sa.filter((p) => p[0] === "login").map(fromSa),
    ],
    payment: [
      ...stored.filter((p) => p.payment).map(fromStored),
      ...sa.filter((p) => p[0] === "checkout" || p[0] === "shop").map(fromSa),
    ],
  };
  const manifest: Manifest = existing ?? {
    seed: CORPUS_SEED,
    recorded: new Date().toISOString(),
    page_files: [],
    failed: [],
  };
  const heldIds = manifest.page_files.map((p) => p.id);
  const heldUrls = new Set(
    heldIds.map((id) => (JSON.parse(readFileSync(corpusPageFile(dir, id), "utf-8")) as CorpusPage).url),
  );
  // A top-up samples only URLs the corpus does not hold, and its ids continue the stratum's numbering.
  const offset = topup ? nextTopupOffset(heldIds, topupStratum as string) : 0;
  const plan: { id: string; candidate: Candidate }[] = topup
    ? seededSample(
        (allStrata[topupStratum as string] ?? []).filter((c) => !heldUrls.has(c.url)),
        per,
        CORPUS_SEED + 2,
      ).map((candidate, i) => ({ id: `${topupStratum}-topup-${offset + i}`, candidate }))
    : STRATA.flatMap((stratum) =>
        seededSample(allStrata[stratum] ?? [], per).map((candidate, i) => ({ id: `${stratum}-${i}`, candidate })),
      );
  for (const sub of ["pages", "shots", "har"]) mkdirSync(join(corpusDir(dir), sub), { recursive: true });
  const renderer = await openRenderer();
  let recorded = 0;
  try {
    let next = 0;
    const worker = async () => {
      while (next < plan.length) {
        const { id, candidate } = plan[next++] as (typeof plan)[number];
        const url = candidate.url;
        const harFile = join(corpusDir(dir), "har", `${id}.har.json`);
        const startedAt = Date.now();
        try {
          // One visit: the HAR is written when the render's context closes, so the archive, the viewed capture and
          // the screenshot are the same page load.
          const capture = await renderer.render(url, { recordHar: harFile });
          if (!existsSync(harFile) || statSync(harFile).mtimeMs < startedAt - 50)
            throw new Error("the visit's HAR was not written");
          const archive = harToArchive(JSON.parse(readFileSync(harFile, "utf-8")));
          if (!archive[url] && !archive[`${url}/`]) throw new Error("the HAR holds no response for the listed URL");
          writeAtomic(join(corpusDir(dir), "shots", `${id}.jpg`), capture.screenshot);
          const page: CorpusPage = {
            id,
            url,
            entry: candidate.entry,
            archive,
            viewed: {
              status: capture.status,
              text: capture.text,
              title: capture.title,
              finalUrl: capture.finalUrl,
              overlays: capture.overlays,
              has_login_form: capture.has_login_form,
              has_payment_form: capture.has_payment_form,
              walls: {
                captcha: capture.captcha,
                consentWall: capture.consentWall,
                challengeCover: capture.challengeCover,
                imageCover: capture.imageCover,
              },
              screenshot: {
                file: `shots/${id}.jpg`,
                sha256: createHash("sha256").update(capture.screenshot).digest("hex"),
                dhash: (await dhash(capture.screenshot)).toString(16).padStart(16, "0"),
              },
            },
            label: PENDING_LABEL,
          };
          manifest.page_files.push(writePage(dir, page));
          recorded++;
          console.error(`corpus: ${id} recorded`);
        } catch (error) {
          manifest.failed.push(
            `${id} ${url}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
          );
          console.error(`corpus: ${id} failed`);
        }
        // The manifest after every page, so a stopped run leaves a readable corpus naming what it holds.
        writeManifest(dir, manifest);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, Math.max(1, plan.length)) }, worker));
  } finally {
    await renderer.close();
  }
  console.log(
    JSON.stringify(
      {
        corpus: manifestFile(dir),
        recorded,
        failed: manifest.failed.length,
        sha256: createHash("sha256")
          .update(readFileSync(manifestFile(dir)))
          .digest("hex"),
      },
      null,
      2,
    ),
  );
}
