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
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromiumPath } from "../lib/chromium.ts";
import { type CorpusPage, corpusDir } from "./compare-pipelines.ts";
import { openRenderer, unusable, wallShown } from "./render.ts";
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

if (import.meta.filename === process.argv[1]) {
  const per = Number(process.argv[2] ?? 25);
  const dir = storeDir();
  const store = openStore(dir);
  const stored: { url: string; login: boolean; payment: boolean }[] = [];
  for (const page of store.manifest()) {
    if (!page.id.startsWith("benign-") || !page.url) continue;
    stored.push({
      url: page.url,
      login: page.labels?.has_login_form === true,
      payment: page.labels?.has_payment_form === true,
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
  const strata: Record<string, string[]> = {
    walls: seededSample([...new Set(walls)], per),
    genuine: seededSample(
      stored.filter((p) => !p.login && !p.payment).map((p) => p.url),
      per,
    ),
    login: seededSample(
      [
        ...stored.filter((p) => p.login).map((p) => p.url),
        ...sa.filter((p) => p[0] === "login").map((p) => p[1] as string),
      ],
      per,
    ),
    payment: seededSample(
      sa.filter((p) => p[0] === "checkout").map((p) => p[1] as string),
      per,
    ),
  };
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error("no headless Chromium found; set MOCKUP_CHROMIUM");
  const browser = await chromium.launch({ executablePath, chromiumSandbox: true });
  const renderer = await openRenderer();
  const pages: CorpusPage[] = [];
  const failed: string[] = [];
  for (const [stratum, urls] of Object.entries(strata)) {
    for (const [i, url] of urls.entries()) {
      const id = `${stratum}-${i}`;
      try {
        const harFile = join(corpusDir(dir), `${id}.har.json`);
        mkdirSync(corpusDir(dir), { recursive: true });
        const context = await browser.newContext({ recordHar: { path: harFile, content: "embed" } });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => undefined);
        await context.close();
        const archive = harToArchive(JSON.parse(readFileSync(harFile, "utf-8")));
        const capture = await renderer.render(url);
        const reason = unusable(capture, { url, kind: "home", also: [] });
        pages.push({
          id,
          url,
          archive,
          viewed: {
            status: capture.status,
            text: capture.text,
            has_login_form: capture.has_login_form,
            has_payment_form: capture.has_payment_form,
          },
          label: {
            wall: wallShown(capture) || capture.captcha || capture.challengeCover || capture.consentWall,
            form: capture.has_payment_form ? "payment" : capture.has_login_form ? "login" : "none",
            eligible: reason === null,
            eligibility_reason: reason ?? "valid benign capture",
          },
        });
        console.error(`corpus: ${id} recorded`);
      } catch (error) {
        failed.push(`${id} ${url}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
  }
  await renderer.close();
  await browser.close();
  // Streamed page by page: a whole corpus in one string exceeds the runtime's string limit.
  const file = join(corpusDir(dir), "corpus.json");
  const fd = openSync(`${file}.tmp`, "w");
  writeSync(fd, `{"seed":${CORPUS_SEED},"recorded":${JSON.stringify(new Date().toISOString())},"pages":[`);
  pages.forEach((p, i) => writeSync(fd, `${i ? "," : ""}${JSON.stringify(p)}`));
  writeSync(fd, `],"failed":${JSON.stringify(failed)}}\n`);
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
