// The live signature badge (D05 T02 §7; design/SPEC.md T3, board Badges): `isitlegit.co.za/b/<slug>.png` and `.svg`,
// the image a protected business's staff carry in their email signatures. It is the Protected badge exactly while the
// verify page says Protected (`answerFor`, ./verify.tsx: protection in effect, `identity` in the plan, a verified domain
// left), and the grey Not verified badge otherwise: a lapsed business, an unknown address or a failed read, each with
// status 200, since a broken image in a signature helps nobody (T3's error state). The images are the brand kit's,
// embedded by scripts/hash-asset.ts (src/web/badges.ts), so the URL is the image itself, never a redirect. Each request
// for a known business adds one to its count for the SAST day, written after the answer; nothing about who asked is
// kept.
import { Hono } from "hono";
import { sastDay } from "../../monitor/run";
import { BADGES } from "../badges";
import { answerFor } from "./verify";

export const badgeRoutes = new Hono<{ Bindings: Env }>();

// A lapse reaches a signature within the hour, longer only where a mail client's image proxy keeps its own copy.
export const BADGE_CACHE = "public, max-age=3600";
const SLUG = /^([a-z0-9-]{1,64})\.(png|svg)$/;
const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const IMAGES = {
  protected: { png: decode(BADGES.protected.png), svg: BADGES.protected.svg },
  notVerified: { png: decode(BADGES.notVerified.png), svg: BADGES.notVerified.svg },
};

export async function countRequest(db: D1Database, orgId: string, now = new Date()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO badge_requests (org_id, day, count) VALUES (?, ?, 1)
       ON CONFLICT (org_id, day) DO UPDATE SET count = count + 1`,
    )
    .bind(orgId, sastDay(now))
    .run();
}

badgeRoutes.get("/b/:file", async (c) => {
  const match = SLUG.exec(c.req.param("file"));
  if (!match) return c.notFound();
  const [, slug, type] = match as unknown as [string, string, "png" | "svg"];
  let variant: keyof typeof IMAGES = "notVerified";
  try {
    const answer = await answerFor(c.env.DB, slug);
    if (answer.kind === "view") {
      if (answer.status === 200) variant = "protected";
      const orgId = answer.orgId;
      c.executionCtx.waitUntil(
        countRequest(c.env.DB, orgId).catch((error) =>
          console.log(JSON.stringify({ event: "badge-count", outcome: "failed", error: (error as Error).name })),
        ),
      );
    }
  } catch (error) {
    // A read that failed vouches for no one: the Not verified badge, said in the log.
    console.log(JSON.stringify({ event: "badge", outcome: "unavailable", error: (error as Error).name }));
  }
  const headers = {
    "Content-Type": type === "png" ? "image/png" : "image/svg+xml",
    "Cache-Control": BADGE_CACHE,
    "X-Content-Type-Options": "nosniff",
  };
  return new Response(type === "png" ? IMAGES[variant].png : IMAGES[variant].svg, { status: 200, headers });
});
