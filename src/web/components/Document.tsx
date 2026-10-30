import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { APP_CSS, APP_JS, FONTS, HTMX, LOGO_MARK } from "../assets";

// The HTML document every page renders into (D07 T01 §3): the fingerprinted stylesheet, the two brand fonts preloaded
// so text does not reflow when they arrive, the mark as the icon, and at the end of the body htmx and the app script
// (D07 T01 §9), both deferred until the page is parsed and run in that order, then any scripts of the page's own. The
// app script is a module (deferred by being one), so it can keep to the erasable syntax Node's type stripping builds.
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
          <script src={HTMX} defer />
          <script type="module" src={APP_JS} />
          {scripts}
        </body>
      </html>
    </>
  );
}
