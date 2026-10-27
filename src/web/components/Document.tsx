import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { APP_CSS, FONTS, LOGO_MARK } from "../assets";

// The HTML document every page renders into (D07 T01 §3): the fingerprinted stylesheet, the two brand fonts preloaded
// so text does not reflow when they arrive, the mark as the icon, and a `scripts` slot §9 fills (htmx and the app
// script) at the end of the body.
export type DocumentProps = {
  // The page's own name; the document title is "<title> · IsItLegit".
  title: string;
  scripts?: Child;
  children: Child;
};

export function Document({ title, scripts, children }: DocumentProps) {
  if (!title.trim()) throw new Error("Document: a page needs a title");
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{`${title} · IsItLegit`}</title>
          <link rel="icon" href={LOGO_MARK} type="image/svg+xml" />
          {Object.values(FONTS).map((href) => (
            <link rel="preload" href={href} as="font" type="font/woff2" crossorigin="anonymous" />
          ))}
          <link rel="stylesheet" href={APP_CSS} />
        </head>
        <body class="bg-surface text-ink font-text text-16 antialiased">
          {children}
          {scripts}
        </body>
      </html>
    </>
  );
}
