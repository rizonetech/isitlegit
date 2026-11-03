import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// No bare 429 reaches a browser (D07 T08 §10). Every place in the Worker that names a 429 is classified, site by site,
// with why that is safe, and a page that draws its own state names the test that proves the state: an API that answers
// JSON a browser never navigates to, a page that draws its own designed state (and the test that holds it), or an
// outbound read of someone else's 429. A new site, in a new file or an already classified one, changes a count here and
// fails until it is classified: give its page a designed state (or `slowDownPage`, E4), never a bare status.
const ROOT = join(import.meta.dirname, "../..");
type Site = { sites: number; why: string; proof?: string };
const CLASSIFIED: Record<string, Site> = {
  "src/auth/domains.ts": {
    sites: 12,
    why: "JSON API of the claim routes; the Domains page draws its own states from the answer",
  },
  "src/intake/upload.ts": { sites: 2, why: "JSON upload API; the upload page draws the limit alert from the answer" },
  "src/auth/confirm.tsx": {
    sites: 8,
    why: "the sign-in pages answer 429 with their own rate-limited page",
    proof: "test/auth/magic-link-confirm.test.ts",
  },
  "src/web/pages/team.tsx": {
    sites: 3,
    why: "the Team page redraws itself with the refusal under the field (its single-invite 429 branch is defensive: Better Auth's invite handler has no limiter rule here today, and the same refusal page is held by the 400 refusals in the proof); the batch branch reads the outbound 429 and draws that address's Too many outcome on the Team page, never returning a bare status",
    proof: "test/web/team-page.test.ts",
  },
  "src/web/pages/upload.tsx": {
    sites: 1,
    why: "reads the upload API's 429 and draws the upload page's alert",
    proof: "test/web/upload-page.test.ts",
  },
  "src/web/pages/upload-view.tsx": {
    sites: 4,
    why: "the upload page's limit and paused alerts",
    proof: "test/web/upload-page.test.ts",
  },
  "src/web/client/app.ts": { sites: 1, why: "the page script reads a 429 and shows the page's own words" },
  "src/mail/smtp2go.ts": { sites: 3, why: "SMTP2GO's 429 as a provider answer, retried, never shown" },
  "src/meta/client.ts": { sites: 2, why: "the Meta API's 429 as a provider answer, retried, never shown" },
  "src/vision/glimmer-wake.ts": { sites: 1, why: "a provider's 429 as a retry, never shown" },
  "src/checks/webrisk.ts": {
    sites: 1,
    why: "Google Web Risk's 429 as a provider answer: the lookup is stated as not checked (rate limited), never shown as a status",
  },
  "src/checks/cf-block.ts": {
    sites: 1,
    why: "Cloudflare DNS's 429 as a provider answer: the lookup is stated as not checked (rate limited), never shown as a status",
  },
  "src/web/pages/errors.tsx": { sites: 7, why: "slowDownPage, the E4 page itself", proof: "test/web/errors.test.ts" },
  "src/web/components/States.tsx": { sites: 3, why: "the E4 error state's art and colours, drawn by slowDownPage" },
  "src/web/dev/gallery.tsx": { sites: 1, why: "the component gallery, only under pnpm dev" },
  "src/fixtures/collect.ts": {
    sites: 1,
    why: "the walkthrough fixture collector answers its own rate limit with its designed Too many requests page, served to the contained browser only",
  },
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}
// The code with its comments blanked, string-aware: a block or a line comment is removed only where it starts outside a
// string, so `"Please wait // retry", 429` keeps its 429 and a 429 in prose is no site.
function withoutComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
// Every 429 outside a comment is a site, several on one line included.
const sitesIn = (text: string) => (withoutComments(text).match(/\b429\b/g) ?? []).length;
const FIX =
  "give the page a designed state (or use slowDownPage, E4), never a bare status, then classify the site here";

// What does not match the classification, from (path, text) pairs.
function mismatches(sources: readonly (readonly [string, string])[]): string[] {
  const found: string[] = [];
  for (const [path, text] of sources) {
    const n = sitesIn(text);
    const known = CLASSIFIED[path];
    if (n > 0 && !known) found.push(`${path}: ${n} unclassified site(s): ${FIX}`);
    else if (known && n !== known.sites) found.push(`${path}: ${n} sites, classified ${known.sites}: ${FIX}`);
  }
  return found;
}

describe("no bare 429 reaches a browser", () => {
  it("has every 429 site in the Worker classified, and each page's designed state held by a test", () => {
    const sources = files(join(ROOT, "src")).map(
      (path) => [relative(ROOT, path).replaceAll("\\", "/"), readFileSync(path, "utf-8")] as const,
    );
    expect(mismatches(sources)).toEqual([]);
    // Nothing classified is stale: each still names a 429, and each proof test exists and mentions 429.
    for (const [path, site] of Object.entries(CLASSIFIED)) {
      expect(
        sources.some(([found, text]) => found === path && sitesIn(text) > 0),
        `${path} no longer names 429: remove it from the classification`,
      ).toBe(true);
      if (site.proof) {
        expect(existsSync(join(ROOT, site.proof)), `${site.proof} is missing`).toBe(true);
        expect(readFileSync(join(ROOT, site.proof), "utf-8"), `${site.proof} no longer holds a 429 state`).toMatch(
          /\b429\b|limit|rate.?limited|used all/i,
        );
      }
    }
  });

  it("fails for a new bare site in a new file, in an already classified file, and for a dropped one", () => {
    expect(mismatches([["src/web/pages/cases.tsx", "return c.text('slow down', 429);"]])).toEqual([
      `src/web/pages/cases.tsx: 1 unclassified site(s): ${FIX}`,
    ]);
    const team = "if (x) return refuse(draft, 429);\nreturn refuse(draft, 429);\nreturn c.text('bare', 429);\nreturn c.text('bare', 429);";
    expect(mismatches([["src/web/pages/team.tsx", team]])).toEqual([
      `src/web/pages/team.tsx: 4 sites, classified 3: ${FIX}`,
    ]);
    expect(mismatches([["src/web/pages/team.tsx", "return refuse(draft, 429);"]])).toEqual([
      `src/web/pages/team.tsx: 1 sites, classified 3: ${FIX}`,
    ]);
    expect(mismatches([["src/web/pages/cases.tsx", "return c.text('fine', 200);"]])).toEqual([]);
    // A site after a block comment, and two on one line, are both found; a 429 in prose is not.
    expect(mismatches([["src/web/pages/cases.tsx", "/* closed */ return c.text('x', 429);"]])).toHaveLength(1);
    expect(mismatches([["src/web/pages/cases.tsx", "a ? c.text('x', 429) : c.text('y', 429);"]])).toEqual([
      `src/web/pages/cases.tsx: 2 unclassified site(s): ${FIX}`,
    ]);
    // A comment marker inside a string is not a comment.
    expect(
      mismatches([["src/web/pages/cases.tsx", "return c.text('Please wait // retry shortly', 429);"]]),
    ).toHaveLength(1);
    expect(mismatches([["src/web/pages/cases.tsx", "// 429 is the limit\n/* and 429 here\n 429 too */"]])).toEqual([]);
  });
});
