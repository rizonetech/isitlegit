# Judge getting started

Open the [public IsItLegit demo](https://isitlegit.co.za/demo/). No login, access code, email inbox, API key or local setup is required.

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
