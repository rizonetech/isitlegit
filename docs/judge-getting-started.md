# Judge getting started

## Open the live app

**[Enter the live Fynbos Freight demo](https://app.isitlegit.co.za/demo).** The link opens the real shared workspace without a code, email sign-in or API key. If you are already signed in, it preserves your current session.

Open **Cases** to inspect existing reports and model traces. Choose **Upload a file** to run a real investigation. Download a [synthetic changed-bank-details email](../data/demo/judge/tampered-invoice.eml) using GitHub's Download raw file control, then upload the saved `.eml`. Read the actual verdict and any checks-not-run messages; model availability and normal service limits still apply.

**This workspace is public and shared. All visitors can see its cases and changes. Upload synthetic files only, never private or client information.**

## Optional static walkthrough

The [illustrative walkthrough](https://isitlegit.co.za/demo/) needs no login and runs no models. It is separate from the live app above.

1. Choose the changed-bank-details, sign-in phishing or ordinary supplier example.
2. Read the illustrative verdict and recommended action.
3. Follow **Evidence E1** to the quoted message text.
4. Open **Read the original fictional email** to inspect the complete synthetic source. The disclosure works by keyboard and without JavaScript.

## What this demo shows

This is a read-only walkthrough with clearly labelled mock reports. All companies and messages are fictional. Verdicts and explanations are authored illustrations, not recorded model responses. No models run, no uploads are accepted, and no customer reports are exposed. These examples do not measure detection accuracy or prove that a particular model ran.

The submitted three-minute video demonstrates the live application. The [README model map](../README.md#how-it-uses-metas-models) links to the implementation and explains the production models and limits. The [synthetic fixture manifest](../data/demo/judge/fixtures.json) records expected outcomes and prerequisites for running the fixtures through the live pipeline; those expectations are not live results from this walkthrough.

## Run the same demo locally without credentials

Use Node 24.18.0 or newer and the repository's pinned pnpm version. From a clone of this public repository:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter site build
pnpm --filter site exec astro preview --host 127.0.0.1
```

Open `http://127.0.0.1:4321/demo/` (or the local address printed by Astro). This builds and serves the same static mock walkthrough. It needs no Cloudflare account, Meta API key or application sign-in. Installing dependencies needs network access.

Developers who want to run the live application code can use the separate [Worker setup instructions](../README.md#run-the-worker-locally). That path requires the service configuration described there and is not needed to view the demo.
