// Settling the pages the links reached (D02 T07 §3), in the `checks` step before the view is built: each screenshot is stored
// as a `render` artefact and only its key stays (the bytes are dropped), and each page's text, hidden text and frames' text
// go to the phrase scanner as texts of their own, so an instruction written for a model on a landing page is found and named.
import { putArtefact, type Store } from "../intake/store";
import type { Expansions } from "./expand";
import { type PhraseLog, PhraseStream } from "./instruction-phrases";

export async function settleLandings(
  store: Store,
  caseId: string,
  expansions: Expansions,
  phrases: PhraseLog,
): Promise<boolean> {
  let changed = false;
  let n = 0;
  for (const e of expansions.items) {
    const landing = e.landing;
    if (!landing) {
      // A link not followed to a page (stalled, failed, refused) has no page text: the scanner's coverage says so.
      if (e.outcome !== "done") {
        phrases.unchecked(
          `landing:${e.final ?? e.link}`,
          `the link was not followed to a page (${e.reason ?? e.outcome})`,
        );
        changed = true;
      }
      continue;
    }
    n += 1;
    if (landing.shot) {
      try {
        landing.shotKey = (
          await putArtefact(store, caseId, "render", `landing-${n}.png`, landing.shot, "image/png")
        ).key;
      } catch {
        // The finding stands without its picture; the coverage says why.
        landing.coverage.shot = "not-stored";
      }
    }
    landing.shot = null;
    // What the scanner could not read is its coverage too: a page that failed, frames that did not load.
    const page = e.final ?? e.link;
    if (landing.coverage.scan === "failed") {
      phrases.unchecked(`landing:${page}`, "the page could not be read", landing.shotKey ?? undefined);
      changed = true;
    }
    if (landing.coverage.framesRead < landing.coverage.framesTotal) {
      phrases.unchecked(
        `landing:${page}`,
        `${landing.coverage.framesTotal - landing.coverage.framesRead} of its frames could not be read`,
        landing.shotKey ?? undefined,
      );
      changed = true;
    }
    for (const scan of landing.scans) {
      for (const [location, text, cut] of [
        [`landing:${scan.url}`, scan.text, scan.textCut],
        [`landing-hidden:${scan.url}`, scan.hidden, scan.hiddenCut],
      ] as const) {
        if (text.trim()) {
          const stream = new PhraseStream(phrases, location, landing.shotKey ?? "", false);
          stream.feed(text);
          stream.end();
          changed = true;
        }
        if (cut)
          phrases.unchecked(
            location,
            "more text than the first 20,000 characters, the rest was not read",
            landing.shotKey ?? undefined,
          );
      }
    }
  }
  // Links the case's bounds left out have no page read either.
  const skipped = expansions.skipped.reduce((n, k) => n + k.count, 0);
  if (skipped > 0) {
    phrases.unchecked("landing-skipped", `${skipped} linked pages were not followed`);
    changed = true;
  }
  return changed;
}
