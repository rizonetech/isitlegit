// The results page's route (D08 T02 §4): `GET /eval`, public, no session. It shows the latest published full eval report, the
// published ablation runs comparable with it, and the real-use counts (src/eval/production.ts). A failed read is the
// error page with a retry and 503, never a figure. The page is ./eval-view.tsx.
import { Hono } from "hono";
import { productionCounts } from "../../eval/production";
import { ablations, latestFull, publishedHistory } from "../../eval/results";
import { reference } from "./errors";
import { EvalPage, EvalUnavailable, type EvalView } from "./eval-view";

export const evalRoutes = new Hono<{ Bindings: Env }>();

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  // Public, indexable, and fresh within a minute.
  "cache-control": "public, max-age=60",
  "referrer-policy": "same-origin",
};
const html = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  new Response(String(body), { status, headers: { ...HEADERS, ...extra } });

export async function evalView(db: D1Database): Promise<EvalView> {
  const [latest, counts] = await Promise.all([latestFull(db), productionCounts(db)]);
  if (!latest) return { kind: "empty", counts, history: [], ablations: await ablations(db, null) };
  return {
    kind: "report",
    report: latest.report,
    publishedAt: latest.publishedAt,
    ablations: await ablations(db, latest.report),
    counts,
    history: await publishedHistory(db, latest.report),
  };
}

evalRoutes.get("/eval", async (c) => {
  try {
    return html(<EvalPage view={await evalView(c.env.DB)} />, 200);
  } catch (error) {
    const ref = reference(500);
    console.log(
      JSON.stringify({ event: "eval-page", outcome: "unavailable", reference: ref, error: (error as Error).name }),
    );
    return html(<EvalUnavailable reference={ref} now={new Date()} retry="/eval" />, 503, {
      "cache-control": "no-store",
    });
  }
});
