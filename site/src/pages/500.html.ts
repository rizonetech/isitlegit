// The marketing site's 500 (design/SPEC.md S11, board Site-500; D07 T08 §9), generated at build time into ONE standalone
// `500.html`: the app's tokens inlined, no script, no stylesheet link, no web font and no request of any kind but its own
// document, so it renders when the Worker or the assets cannot. (A page named 500.astro would emit a directory, not the
// file; an endpoint emits the file.) Serving it during a real failure is production wiring, D07 T06 §20.
import type { APIRoute } from "astro";
import tokens from "../styles/error.css?inline";
import { claims } from "../lib/claims.ts";
import { app, CHECK_ADDRESS, contact, HELLO_ADDRESS, site } from "../lib/links.ts";


// Colours, radii and spacing come from the tokens above, never from literals.
const STYLE = `
*,*::before,*::after{box-sizing:border-box}
html{background:var(--color-subtle);color:var(--color-ink);font-family:var(--font-text);line-height:1.5}
body{margin:0;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--color-orange-text);text-decoration:underline;text-underline-offset:2px;border-radius:var(--radius-small)}
a:focus-visible{outline:2px solid var(--color-orange-text);outline-offset:2px}
header,footer{display:flex;justify-content:space-between;gap:16px;padding:20px 24px;font-size:14px;color:var(--color-muted)}
.brand{font-family:var(--font-heading);font-weight:800;font-size:20px;color:var(--color-ink);text-decoration:none}
main{flex:1;padding:16px 24px 32px;display:flex;justify-content:center}
.card{width:100%;max-width:1000px;background:var(--color-surface);border:1px solid var(--color-line);border-radius:var(--radius-card-large);padding:32px;display:grid;gap:32px;align-items:center}
@media (min-width:48rem){.card{grid-template-columns:auto 1fr;padding:48px}}
.tile{display:none;width:152px;height:152px;align-items:center;justify-content:center;background:var(--color-subtle);border-radius:var(--radius-card-large);font-family:var(--font-heading);font-weight:800;font-size:96px}
@media (min-width:48rem){.tile{display:flex}}
.eyebrow{margin:0;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--color-orange-text)}
h1{margin:0;font-family:var(--font-heading);font-weight:800;font-size:clamp(28px,5vw,40px);line-height:1.15}
.lead{margin:0;font-size:18px;color:var(--color-ink-2);max-width:60ch}
.actions{display:flex;flex-wrap:wrap;gap:12px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:8px 20px;border-radius:var(--radius-control);border:1px solid var(--color-line-strong);background:var(--color-surface);color:var(--color-ink);font-weight:700;text-decoration:none}
.btn.dark{background:var(--color-dark);color:var(--color-on-dark);border-color:transparent}
.panel{border:1px solid var(--color-line);border-radius:var(--radius-card);background:var(--color-subtle);padding:16px;max-width:60ch;display:flex;flex-direction:column;gap:4px;font-size:14px}
.panel p{margin:0}.panel .strong{font-weight:700}.panel .muted{color:var(--color-muted)}
code{font-family:var(--font-mono);font-weight:700}
`;

const html = `<!doctype html>
<html lang="en-ZA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>This page didn't load</title>
<style>${tokens}${STYLE}</style>
</head>
<body>
<header><a class="brand" href="${site.home}">IsItLegit</a><span>isitlegit.co.za</span></header>
<main>
<section class="card" aria-labelledby="error-title" data-region="error">
<span class="tile" aria-hidden="true">?</span>
<div style="display:flex;flex-direction:column;gap:16px">
<p class="eyebrow">Something went wrong</p>
<h1 id="error-title">This page didn't load.</h1>
<p class="lead">That's on us, not you. Try again in a minute. <span data-claim="errors.mail">${claims["errors.mail"].text}</span></p>
<div class="actions"><a class="btn dark" href="" data-retry>Try again</a><a class="btn" href="${site.home}">Home</a></div>
<div class="panel" data-panel>
<p class="strong">Need to check a suspicious email right now?</p>
<p>Forward it as an attachment to <code>${CHECK_ADDRESS}</code>.</p>
<p class="muted" data-membership><a href="${app.signup}">Sign up first</a>: we answer mail from the address or domain you verify.</p>
<p class="muted" data-help>Need a person? Email us at <a href="${contact}">${HELLO_ADDRESS}</a>.</p>
</div>
</div>
</section>
</main>
<footer><span>Reference 500-site</span><span>IsItLegit by Rizonetech</span></footer>
</body>
</html>
`;

export const GET: APIRoute = () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
