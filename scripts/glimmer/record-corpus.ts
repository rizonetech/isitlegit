// Record the §38 replay corpus: for each sampled benign-list URL, a HAR with bodies (the replay archive), the
// production renderer's viewed capture at record time, and a label assigned from that viewed capture (wall shown,
// form shown, eligibility with its reason), never from either pipeline's admission decision.
//
//     node scripts/glimmer/record-corpus.ts [per-stratum]
//
// Strata: walls (journal exclusions for a challenge, CAPTCHA, cookie wall or suspended host), genuine (stored benign
// pages with no form), login (stored benign pages and benign-sa sign-in pages showing a login form), payment
// (benign-sa checkout pages). The corpus lands in `<store>/runs/compare/corpus/corpus.json` with its seed; a page
// whose recording fails is counted and named, never silently dropped.
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromiumPath } from "../lib/chromium.ts";
import { type CorpusPage, corpusDir, readCorpus } from "./compare-pipelines.ts";
import { openRenderer } from "./render.ts";
import { openStore, storeDir } from "./store.ts";

export const CORPUS_SEED = 20261102;
export function seededSample<T>(items: T[], n: number, seed = CORPUS_SEED): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as string, out[i] as string];
  }
  return out.slice(0, n);
}
type HarEntry = {
  request: { url: string };
  response: {
    status: number;
    headers: { name: string; value: string }[];
    content: { text?: string; encoding?: string; mimeType?: string };
  };
};
export function harToArchive(har: { log: { entries: HarEntry[] } }): CorpusPage["archive"] {
  const archive: CorpusPage["archive"] = {};
  for (const entry of har.log.entries) {
    if (archive[entry.request.url]) continue;
    const text = entry.response.content.text ?? "";
    const mime = entry.response.content.mimeType ?? "";
    // Media, fonts and oversized bodies carry no text, form or wall evidence: replay answers them empty, so the
    // corpus stays small enough to hold and parse.
    const heavy = /^(image|font|video|audio)\//.test(mime) || text.length > 2_000_000;
    archive[entry.request.url] = {
      status: entry.response.status,
      headers: Object.fromEntries(entry.response.headers.map((h) => [h.name.toLowerCase(), h.value])),
      bodyBase64: heavy
        ? ""
        : entry.response.content.encoding === "base64"
          ? text
          : Buffer.from(text).toString("base64"),
    };
  }
  return archive;
}

// The label a viewed capture earns, from the viewed evidence alone (its title, visible text, overlays, status,
// final URL and the forms it shows), never from either pipeline's admission decision (§38).
export const WALL_VIEWED =
  /just a moment|verify you are human|checking your browser|are you a robot|are you a human|press (&|and) hold|captcha|access denied|additional security check/i;
const ERROR_VIEWED =
  /page (could not|can't|cannot) be found|404 not found|not found|suspended|account (has been )?suspended|domain (is )?(parked|for sale)|coming soon|under construction/i;
export function annotateViewed(viewed: {
  status: number;
  title: string;
  text: string;
  overlays?: string;
  finalUrl: string;
  url: string;
  brand?: string;
  also?: string[];
  has_login_form: boolean;
  has_payment_form: boolean;
}): CorpusPage["label"] {
  const wall = WALL_VIEWED.test(`${viewed.title}\n${viewed.text}\n${viewed.overlays ?? ""}`);
  const form = viewed.has_payment_form ? "payment" : viewed.has_login_form ? "login" : "none";
  const domain = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const landed = domain(viewed.finalUrl);
  const listed = domain(viewed.url);
  // Same site, a subdomain of it (or it of the landed host), or a destination the listing allows.
  const sameSite =
    !landed ||
    !listed ||
    landed === listed ||
    landed.endsWith(`.${listed}`) ||
    listed.endsWith(`.${landed}`) ||
    (viewed.also ?? []).some((a) => landed === domain(a) || landed.endsWith(`.${domain(a)}`));
  let reason: string | null = null;
  if (viewed.status < 200 || viewed.status > 299) reason = `HTTP ${viewed.status}`;
  else if (wall) reason = "a challenge page is shown";
  else if (!sameSite) reason = `cross-site redirect to ${landed}`;
  else if (ERROR_VIEWED.test(`${viewed.title}\n${viewed.text.slice(0, 2000)}`))
    reason = "an error page, suspended host or parked domain answered with 200";
  else if (
    viewed.brand &&
    !`${viewed.title}\n${viewed.text}`.toLowerCase().includes(
      viewed.brand
        .toLowerCase()
        .replace(/[^a-z0-9]/g, " ")
        .split(" ")[0] ?? "",
    )
  )
    reason = `the listed brand (${viewed.brand}) is not on the page`;
  else if (viewed.text.trim().length < 50) reason = "under 50 characters of visible text";
  return { wall, form, eligible: reason === null, eligibility_reason: reason ?? "valid benign capture" };
}

if (import.meta.filename === process.argv[1]) {
  const per = Number(process.argv[2] ?? 25);
  const mode = process.argv[3];
  const topupStratum = process.argv[4] ?? "payment";
  if (!Number.isInteger(per) || per < 1 || per > 100 || (mode !== undefined && mode !== "topup")) {
    console.error(
      "usage: node scripts/glimmer/record-corpus.ts [per-stratum 1..100] [topup [walls|genuine|login|payment]]",
    );
    process.exit(2);
  }
  const dir = storeDir();
  const store = openStore(dir);
  const stored: { url: string; login: boolean; payment: boolean; kind: string; brand?: string }[] = [];
  for (const page of store.manifest()) {
    if (!page.id.startsWith("benign-") || !page.url) continue;
    stored.push({
      url: page.url,
      login: page.labels?.has_login_form === true,
      payment: page.labels?.has_payment_form === true,
      kind: page.kind ?? "home",
      brand: page.labels?.brand ?? undefined,
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
  const topup = mode === "topup";
  if (topup && !["walls", "genuine", "login", "payment"].includes(topupStratum)) {
    console.error(
      "usage: node scripts/glimmer/record-corpus.ts [per-stratum 1..100] [topup [walls|genuine|login|payment]]",
    );
    process.exit(2);
  }
  type Candidate = { url: string; entry: { kind: string; brand?: string; also: string[] } };
  const fromStored = (p: (typeof stored)[number]): Candidate => ({
    url: p.url,
    entry: { kind: p.kind, brand: p.brand, also: [] },
  });
  const fromSa = (p: string[]): Candidate => ({
    url: p[1] as string,
    entry: {
      kind: p[0] as string,
      brand: p[2],
      also: (p[3] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
  });
  const allStrata: Record<string, Candidate[]> = {
    walls: [...new Set(walls)].map((url) => ({ url, entry: { kind: "home", also: [] } })),
    genuine: stored.filter((p) => !p.login && !p.payment).map(fromStored),
    login: [...stored.filter((p) => p.login).map(fromStored), ...sa.filter((p) => p[0] === "login").map(fromSa)],
    payment: [
      ...stored.filter((p) => p.payment).map(fromStored),
      ...sa.filter((p) => p[0] === "checkout" || p[0] === "shop").map(fromSa),
    ],
  };
  const strata: Record<string, Candidate[]> = topup
    ? { [topupStratum]: seededSample(allStrata[topupStratum] ?? [], per, CORPUS_SEED + 1) }
    : Object.fromEntries(Object.entries(allStrata).map(([k, v]) => [k, seededSample(v, per)]));
  // A top-up's ids continue the stratum's numbering, so a second top-up never overwrites a page file, and it
  // samples only URLs the corpus does not already hold.
  let idOffset = 0;
  if (topup) {
    try {
      const held = readCorpus(dir).pages;
      // Beyond the largest assigned number in the stratum, not the count of pages: recording failures leave
      // gaps, and a count-based offset reuses an existing id and overwrites its page file.
      idOffset = held.reduce((max, p) => {
        const n = Number(
          p.id
            .slice(topupStratum.length + 1)
            .split("-")
            .pop(),
        );
        return Number.isInteger(n) && n >= max ? n + 1 : max;
      }, 0);
      const heldUrls = new Set(held.map((p) => p.url));
      strata[topupStratum] = seededSample(
        (allStrata[topupStratum] ?? []).filter((c) => !heldUrls.has(c.url)),
        per,
        CORPUS_SEED + 2,
      );
    } catch {
      idOffset = 0;
    }
  }
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  const browser = await chromium.launch({ executablePath, chromiumSandbox: true });
  const renderer = await openRenderer();
  const pages: CorpusPage[] = [];
  const failed: string[] = [];
  for (const [stratum, candidates] of Object.entries(strata)) {
    for (const [i, candidate] of candidates.entries()) {
      const url = candidate.url;
      const id = topup ? `${stratum}-topup-${idOffset + i}` : `${stratum}-${i}`;
      try {
        const harFile = join(corpusDir(dir), `${id}.har.json`);
        mkdirSync(corpusDir(dir), { recursive: true });
        const context = await browser.newContext({ recordHar: { path: harFile, content: "embed" } });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => undefined);
        // The form label comes from this main-world read (the page and every frame), never from the production
        // renderer's form flags, so form accuracy is measured against an independent read.
        const frameForms = { has_login_form: false, has_payment_form: false };
        for (const frame of page.frames()) {
          const forms = await frame
            .evaluate(() => {
              const inputs = [...document.querySelectorAll("input")];
              return {
                has_login_form: inputs.some((i) => ["password", "email"].includes(i.type)),
                has_payment_form: inputs.some(
                  (i) => i.autocomplete === "cc-number" || i.name.toLowerCase().includes("card"),
                ),
              };
            })
            .catch(() => ({ has_login_form: false, has_payment_form: false }));
          frameForms.has_login_form = frameForms.has_login_form || forms.has_login_form;
          frameForms.has_payment_form = frameForms.has_payment_form || forms.has_payment_form;
        }
        await context.close();
        const archive = harToArchive(JSON.parse(readFileSync(harFile, "utf-8")));
        const capture = await renderer.render(url);
        pages.push({
          id,
          url,
          entry: candidate.entry,
          archive,
          viewed: {
            status: capture.status,
            text: capture.text,
            title: capture.title,
            finalUrl: capture.finalUrl,
            has_login_form: capture.has_login_form,
            has_payment_form: capture.has_payment_form,
          },
          label: annotateViewed({
            status: capture.status,
            title: capture.title,
            text: capture.text,
            overlays: capture.overlays,
            finalUrl: capture.finalUrl,
            url,
            brand: candidate.entry.brand,
            also: candidate.entry.also,
            has_login_form: frameForms.has_login_form,
            has_payment_form: frameForms.has_payment_form,
          }),
        });
        console.error(`corpus: ${id} recorded`);
      } catch (error) {
        failed.push(`${id} ${url}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
  }
  await renderer.close();
  await browser.close();
  // Streamed page by page: a whole corpus in one string exceeds the runtime's string limit. A top-up run merges
  // with the corpus already on disk, skipping URLs it already holds.
  const file = join(corpusDir(dir), "corpus.json");
  let existing: CorpusPage[] = [];
  if (topup) {
    existing = readCorpus(dir).pages;
    failed.push(...((JSON.parse(readFileSync(file, "utf-8")) as { failed?: string[] }).failed ?? []));
    const held = new Set(existing.map((p) => p.url));
    for (let i = pages.length - 1; i >= 0; i--) if (held.has(pages[i]?.url ?? "")) pages.splice(i, 1);
  }
  const all = [...existing, ...pages];
  // One file a page plus a manifest naming each: a single corpus file exceeds the runtime's string limit.
  mkdirSync(join(corpusDir(dir), "pages"), { recursive: true });
  const pageFiles = all.map((p) => {
    const pageFile = join(corpusDir(dir), "pages", `${p.id}.json`);
    const data = JSON.stringify(p);
    writeFileSync(`${pageFile}.tmp`, data);
    renameSync(`${pageFile}.tmp`, pageFile);
    return { id: p.id, sha256: createHash("sha256").update(data).digest("hex") };
  });
  const fd = openSync(`${file}.tmp`, "w");
  writeSync(
    fd,
    `${JSON.stringify({ seed: CORPUS_SEED, recorded: new Date().toISOString(), page_files: pageFiles, failed })}\n`,
  );
  closeSync(fd);
  renameSync(`${file}.tmp`, file);
  console.log(
    JSON.stringify(
      {
        corpus: file,
        pages: pages.length,
        failed,
        sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
      },
      null,
      2,
    ),
  );
}
