// The app's self-hosted fonts on the marketing site (D07 T06 §1). The site imports the app's generated
// `src/web/styles/fonts.css`, whose @font-face rules name fingerprinted files under `/static/fonts/`; this integration
// ships exactly those files from `public/static/fonts/` so the two hosts can never serve different fonts. The build
// fails, naming the file, when one is missing; `astro dev` serves them from the same folder.
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

export const FONT_PREFIX = "/static/fonts/";
// The app's rule for its fingerprinted assets (`public/_headers`): a new font gets a new name, so a year is safe.
export const IMMUTABLE = "public, max-age=31536000, immutable";

// Every `/static/fonts/<file>` URL in a stylesheet, once each, in order. A URL that tries to leave the folder is refused.
export function fontUrls(css: string): string[] {
  const urls = new Set<string>();
  for (const match of css.matchAll(/url\(\s*["']?(\/static\/fonts\/[^"')\s]+)["']?\s*\)/g)) {
    const url = match[1];
    if (basename(url) !== url.slice(FONT_PREFIX.length)) throw new Error(`app-fonts: ${url} is not a plain file name`);
    urls.add(url);
  }
  return [...urls];
}

// Copies every font the stylesheet names from `sourceDir` into `<outDir>/static/fonts/`, each through a temporary file
// beside its destination and a rename, and returns the copied names. Throws, naming each, when a source file is missing.
export function copyFonts(cssPath: string, sourceDir: string, outDir: string): string[] {
  const names = fontUrls(readFileSync(cssPath, "utf8")).map((url) => url.slice(FONT_PREFIX.length));
  if (names.length === 0) throw new Error(`app-fonts: ${cssPath} names no font under ${FONT_PREFIX}`);
  const missing = names.filter((name) => !existsSync(join(sourceDir, name)));
  if (missing.length > 0) throw new Error(`app-fonts: missing from ${sourceDir}: ${missing.join(", ")}`);
  const target = join(outDir, FONT_PREFIX);
  mkdirSync(target, { recursive: true });
  for (const name of names) {
    const destination = join(target, name);
    const tmp = `${destination}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, readFileSync(join(sourceDir, name)));
      renameSync(tmp, destination);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return names;
}

type Next = (error?: unknown) => void;

// Development middleware: answers a font the stylesheet names with its bytes; anything else goes to the next handler.
export function fontMiddleware(cssPath: string, sourceDir: string) {
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    const path = (req.url ?? "").split("?")[0];
    if (!path.startsWith(FONT_PREFIX) || !fontUrls(readFileSync(cssPath, "utf8")).includes(path)) return next();
    const file = join(sourceDir, path.slice(FONT_PREFIX.length));
    if (!existsSync(file)) return next();
    res.statusCode = 200;
    res.setHeader("Content-Type", "font/woff2");
    res.setHeader("Content-Length", String(statSync(file).size));
    res.setHeader("Cache-Control", IMMUTABLE);
    createReadStream(file).on("error", next).pipe(res);
  };
}

// The repository root, two levels above `site/src/integrations/`.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export default function appFonts(
  cssPath = join(ROOT, "src/web/styles/fonts.css"),
  sourceDir = join(ROOT, "public/static/fonts"),
): AstroIntegration {
  return {
    name: "isitlegit:app-fonts",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use(fontMiddleware(cssPath, sourceDir));
      },
      "astro:build:done": ({ dir, logger }) => {
        const names = copyFonts(cssPath, sourceDir, fileURLToPath(dir));
        logger.info(`copied ${names.length} fonts: ${names.join(", ")}`);
      },
    },
  };
}
