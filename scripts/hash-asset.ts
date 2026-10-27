// Fingerprints the compiled stylesheet and the brand logos for long-lived caching (D07 T01 §5, §3): copies
// build/css/app.css to public/static/app.<first 12 hex of its SHA-256>.css and the logos to public/static/brand/, writes
// src/web/assets.ts naming the stylesheet, the fonts (as src/web/styles/fonts.css names them) and the logos, and only
// then removes fingerprinted files the new set no longer names.
//
//   node scripts/hash-asset.ts [--css <compiled css>] [--public <dir>] [--fonts-css <css>] [--module <ts>]
//                              [--brand <logo folder>]
//
// Every write goes to a temporary file and is renamed into place; unchanged output is left byte-identical.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { option } from "./build-tokens.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function writeIfChanged(path: string, data: string | Buffer): void {
  if (existsSync(path) && statSync(path).isFile() && readFileSync(path).equals(Buffer.from(data))) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true }); // a full disk or a failed rename leaves nothing behind for the retry to trip on
    throw error;
  }
}

// The brand families the tokens name (typography.json families without a comma, which are system stacks).
function brandFamilies(): string[] {
  const type = JSON.parse(readFileSync(join(ROOT, "design/tokens/typography.json"), "utf-8"));
  return Object.values<string>(type.families).filter((name) => !name.includes(","));
}

// The web-font faces in fonts.css as {family: url}: every @font-face block with a url() source, quoted either way and
// with declarations in any order; the local() fallback faces are not served files and are left out. It refuses unless
// every brand family has exactly one face and every file exists, before anything is written or pruned, since an empty
// or partial set would otherwise prune the fonts pages still name.
export function parseFonts(css: string, pub: string, families: string[]): Record<string, string> {
  const faces: Record<string, string> = {};
  for (const [, body = ""] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = /font-family\s*:\s*(["']?)([^;"']+)\1\s*(?:;|$)/.exec(body)?.[2]?.trim();
    const url = /src\s*:[^;]*?url\(\s*(["']?)([^)"']+)\1\s*\)/.exec(body)?.[2];
    if (!family || !url) continue;
    if (faces[family]) throw new Error(`fonts.css names ${family} twice`);
    faces[family] = url;
  }
  const missing = families.filter((family) => !faces[family]);
  if (missing.length) throw new Error(`fonts.css has no web-font face for ${missing.join(", ")}; nothing was written`);
  for (const [family, url] of Object.entries(faces))
    if (!url.startsWith("/static/fonts/") || !existsSync(join(pub, url)))
      throw new Error(`fonts.css names ${url} for ${family}, which is not under public/; nothing was written`);
  return faces;
}

// The logos pages show, as {export name: [source file in the brand folder, served name]}.
const LOGOS = {
  LOGO: ["isitlegit-logo.svg", "logo"],
  LOGO_ON_DARK: ["isitlegit-logo-on-dark.svg", "logo-on-dark"],
  LOGO_MARK: ["isitlegit-mark.svg", "mark"],
  LOGO_MARK_ON_DARK: ["isitlegit-mark-on-dark.svg", "mark-on-dark"],
} as const;

const fingerprint = (data: Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 12);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

export function hashAssets(argv: string[]): {
  css: string;
  fonts: Record<string, string>;
  logos: Record<keyof typeof LOGOS, string>;
} {
  const compiled = readFileSync(option(argv, "--css", "build/css/app.css"));
  const pub = option(argv, "--public", "public");
  const fontsPath = option(argv, "--fonts-css", "src/web/styles/fonts.css");
  const modulePath = option(argv, "--module", "src/web/assets.ts");
  // Checked first: a bad fonts.css stops the build before it writes or prunes anything.
  const fonts = parseFonts(readFileSync(fontsPath, "utf-8"), pub, brandFamilies());
  // Every logo is read before anything is written, so a missing one stops the build with the old set in place.
  const brand = option(argv, "--brand", "design/brand/logo-svg");
  const logos = Object.entries(LOGOS).map(([key, [source, served]]) => {
    const data = readFileSync(join(brand, source));
    return { key, data, url: `/static/brand/${served}.${fingerprint(data)}.svg` };
  });
  const name = `app.${fingerprint(compiled)}.css`;
  const dir = join(pub, "static");
  writeIfChanged(join(dir, name), compiled);
  for (const logo of logos) writeIfChanged(join(pub, logo.url), logo.data);
  const module = [
    "// Generated by scripts/hash-asset.ts (pnpm build:assets). Do not edit.",
    `export const APP_CSS = "/static/${name}";`,
    `export const FONTS: Readonly<Record<string, string>> = ${JSON.stringify(fonts)};`,
    ...logos.map((logo) => `export const ${logo.key} = "${logo.url}";`),
    "",
  ].join("\n");
  writeIfChanged(modulePath, module);
  // Only now, with assets.ts naming the new set, are files the set no longer names removed: a build that failed before
  // this point left the previous stylesheet, fonts and assets.ts in place together. Every fingerprinted file a page
  // names must be in `keep`, or this deletes it: a new asset (D07 T01 §9's scripts) joins the set built here.
  const keep = new Set([`/static/${name}`, ...Object.values(fonts), ...logos.map((logo) => logo.url)]);
  for (const path of files(dir)) {
    const url = `/${relative(pub, path).replaceAll("\\", "/")}`;
    // Any fingerprinted type, and temporary files a killed earlier build left: nothing unnamed stays under /static/.
    if ((/\.[0-9a-f]{12}\.[a-z0-9]+$/.test(url) && !keep.has(url)) || url.endsWith(".tmp")) rmSync(path);
  }
  // Temporary files a killed build left beside the other generated files (a SIGKILL runs no cleanup).
  for (const folder of new Set([dirname(modulePath), dirname(fontsPath)]))
    for (const entry of readdirSync(folder)) if (/\.\d+\.tmp$/.test(entry)) rmSync(join(folder, entry));
  const exported = Object.fromEntries(logos.map((logo) => [logo.key, logo.url])) as Record<keyof typeof LOGOS, string>;
  return { css: `/static/${name}`, fonts, logos: exported };
}

if (import.meta.filename === process.argv[1]) {
  try {
    hashAssets(process.argv);
  } catch (error) {
    console.error(`hash-asset: ${(error as Error).message}`);
    process.exit(1);
  }
}
