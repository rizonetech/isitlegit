// Spark's second look at a page Loupe flagged (D05 T04 §9; spec 4.11). The walkthrough (§4) is the costliest step, so a
// flag is confirmed first by one Spark question on the same screenshot and text: the screener's own request, built in one
// place (`buildScreenRequest`, `sparkRequest`), the text only in its untrusted block. One logical second look is one
// `structured` call, which may repair an invalid answer once and retry a transient failure, every attempt billed to the
// monitor's Meta budget. A second look that cannot answer is `unavailable` and the flag stands: an outage never takes a
// flagged page for benign.
import { type StructuredContext, structured } from "../meta/structured.ts";
import { buildScreenRequest, PageAnswer, screened } from "../vision/page-screen.ts";
import { type Page, sparkReason } from "../vision/screen.ts";
import { sparkRequest } from "../vision/screen-request.ts";

export type SecondLook =
  | { verdict: "confirmed" | "declined"; lureType: string; callId: string; logId: string | null }
  | { verdict: "unavailable"; reason: string };

export type SparkContext = Omit<StructuredContext, "owner">;

export async function secondLook(page: Page, run: string, spark: SparkContext): Promise<SecondLook> {
  try {
    const request = buildScreenRequest({
      ...(page.image ? { image: page.image } : {}),
      host: page.host,
      text: page.text,
      mode: page.mode,
      ...(page.nonce ? { nonce: page.nonce } : {}),
    });
    const answer = await structured(PageAnswer, sparkRequest(request), {
      ...spark,
      owner: { kind: "monitor", run, host: page.host ?? "none", step: "second-look" },
    });
    const screen = screened(answer.value, "spark");
    return {
      verdict: screen.lure ? "confirmed" : "declined",
      lureType: screen.lure_type,
      callId: answer.callId,
      logId: answer.logId,
    };
  } catch (error) {
    if (spark.continuation?.pending(error)) throw error;
    return { verdict: "unavailable", reason: sparkReason(error) };
  }
}
