// The internal-link gate (D07 T06 §6; §2's and §4's promise): every internal href of the built site resolves to a built
// page, a file or a redirect, or begins with a prefix the app Worker serves (/v/, /s/ and /b/, D05 T02; their live
// read-back is §20's). Nothing else is exempt.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const WORKER_PREFIXES = ["/v/", "/s/", "/b/"] as const;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

export function redirectSources(dist: string): string[] {
  const path = join(dist, "_redirects");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => (line.split(/\s+/)[0] ?? "").replace(/\/$/, ""));
}

export function brokenLinks(dist: string): string[] {
  const redirects = new Set(redirectSources(dist));
  const broken: string[] = [];
  for (const page of files(dist).filter((f) => f.endsWith(".html"))) {
    const html = readFileSync(page, "utf8");
    for (const match of html.matchAll(/\shref="([^"]*)"/g)) {
      const raw = match[1] as string;
      if (!raw.startsWith("/") || raw.startsWith("//")) continue;
      const path = (raw.split("#")[0] ?? "").split("?")[0] ?? "";
      if (path === "" || path === "/") continue;
      const clean = path.replace(/\/$/, "");
      const resolves =
        existsSync(join(dist, clean)) && statSync(join(dist, clean)).isFile()
          ? true
          : existsSync(join(dist, clean, "index.html")) ||
            existsSync(join(dist, `${clean}.html`)) ||
            redirects.has(clean) ||
            WORKER_PREFIXES.some((prefix) => path.startsWith(prefix));
      if (!resolves) broken.push(`${relative(dist, page)}: ${raw}`);
    }
  }
  return broken;
}

if (import.meta.filename === process.argv[1]) {
  const dist = process.argv[2] ?? join(import.meta.dirname, "../dist");
  const broken = brokenLinks(dist);
  if (broken.length) {
    console.error(`check-links: refusing, ${broken.length} internal link(s) resolve to nothing:\n${broken.join("\n")}`);
    process.exit(1);
  }
  console.log("check-links: every internal link resolves");
}
