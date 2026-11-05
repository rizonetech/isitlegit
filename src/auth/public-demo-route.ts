import { Hono } from "hono";
import { createAuth } from "./auth";

export const publicDemoRoutes = new Hono<{ Bindings: Env }>();
publicDemoRoutes.get("/demo", async (c) => {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  const auth = createAuth(c.env);
  // Do not overwrite an existing member's session when they follow a public link.
  if (await auth.api.getSession({ headers: c.req.raw.headers })) return c.redirect("/cases", 303);
  const headers = new Headers(c.req.raw.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", new URL(c.env.APP_URL).origin);
  const answer = await auth.handler(
    new Request(new URL("/api/auth/sign-in/public-demo", c.env.APP_URL), {
      method: "POST",
      headers,
      body: JSON.stringify({ consent: true }),
    }),
  );
  const responseHeaders = new Headers(answer.headers);
  responseHeaders.set("cache-control", "private, no-store");
  responseHeaders.set("referrer-policy", "no-referrer");
  responseHeaders.set("x-robots-tag", "noindex, nofollow");
  responseHeaders.set("content-type", "text/plain; charset=utf-8");
  if (!answer.ok)
    return new Response("The demo could not open just now. Please reload to try again.", {
      status: answer.status,
      headers: responseHeaders,
    });
  responseHeaders.set("location", "/cases");
  return new Response(null, { status: 303, headers: responseHeaders });
});
