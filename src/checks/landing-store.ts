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
  let fed = false;
  let n = 0;
  for (const e of expansions.items) {
    const landing = e.landing;
    if (!landing) continue;
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
    for (const scan of landing.scans) {
      for (const [location, text, cut] of [
        [`landing:${scan.url}`, scan.text, scan.textCut],
        [`landing-hidden:${scan.url}`, scan.hidden, scan.hiddenCut],
      ] as const) {
        if (text.trim()) {
          const stream = new PhraseStream(phrases, location, landing.shotKey ?? "", false);
          stream.feed(text);
          stream.end();
          fed = true;
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
  return fed;
}
