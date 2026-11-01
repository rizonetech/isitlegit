import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// No bare 429 reaches a browser (D07 T08 §10). Every file in the Worker that answers a 429 is classified, with why that is
// safe: an API that answers JSON a browser never navigates to, a page that draws its own designed state, or an outbound
// read of someone else's 429. A new file that answers 429 fails here until it is classified: give its page a designed
// state (or `slowDownPage`, E4), never a bare status.
const ROOT = join(import.meta.dirname, "../..");
const CLASSIFIED: Record<string, string> = {
  "src/auth/domains.ts": "JSON API of the claim routes; the Domains page draws its own states from the answer",
  "src/intake/upload.ts": "JSON upload API; the upload page draws the limit alert from the answer",
  "src/auth/confirm.tsx": "the sign-in pages answer 429 with their own rate-limited page",
  "src/web/pages/team.tsx": "the Team page redraws itself with the refusal under the field",
  "src/web/pages/upload.tsx": "reads the upload API's 429 and draws the upload page's alert",
  "src/web/pages/upload-view.tsx": "the upload page's limit and paused alerts",
  "src/web/client/app.ts": "the page script reads a 429 and shows the page's own words",
  "src/mail/smtp2go.ts": "SMTP2GO's 429 as a provider answer, retried, never shown",
  "src/meta/client.ts": "the Meta API's 429 as a provider answer, retried, never shown",
  "src/vision/glimmer-wake.ts": "a provider's 429 as a retry, never shown",
  "src/web/pages/errors.tsx": "slowDownPage, the E4 page itself",
  "src/web/components/States.tsx": "the E4 error state's art and colours, drawn by slowDownPage",
  "src/web/dev/gallery.tsx": "the component gallery, only under pnpm dev",
  "src/db/cases.ts": "the admission refusal's status for its callers, which draw their own states or answer JSON",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}
const answers429 = (text: string) => /\b429\b/.test(text);

// The files that answer 429 and are not classified, from (path, text) pairs.
function unclassified(sources: readonly (readonly [string, string])[]): string[] {
  return sources.filter(([path, text]) => answers429(text) && !(path in CLASSIFIED)).map(([path]) => path);
}

describe("no bare 429 reaches a browser", () => {
  it("has every Worker file that answers 429 classified", () => {
    const sources = files(join(ROOT, "src")).map(
      (path) => [relative(ROOT, path).replaceAll("\\", "/"), readFileSync(path, "utf-8")] as const,
    );
    expect(unclassified(sources)).toEqual([]);
    // The scan sees the classified files at all, so an empty result is not an empty scan, and nothing classified is stale.
    for (const path of Object.keys(CLASSIFIED))
      expect(
        sources.some(([found, text]) => found === path && answers429(text)),
        `${path} no longer answers 429: remove it from the classification`,
      ).toBe(true);
  });

  it("fails for a planted page route that answers 429 without being classified", () => {
    expect(unclassified([["src/web/pages/cases.tsx", "return c.text('slow down', 429);"]])).toEqual([
      "src/web/pages/cases.tsx",
    ]);
    expect(unclassified([["src/web/pages/cases.tsx", "return c.text('fine', 200);"]])).toEqual([]);
  });
});
