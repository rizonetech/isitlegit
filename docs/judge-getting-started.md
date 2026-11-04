# Try IsItLegit

Use the hosted app. You need an email inbox. Use the demo invitation code provided in our submission. You do not need API keys, a Cloudflare account or a local installation.

1. **Create your account:** open [app.isitlegit.co.za/signup](https://app.isitlegit.co.za/signup). Enter **Invite code**, your work email and organisation name, read the privacy notice and consent if you agree, then choose **Create account**. Already registered? [Sign in](https://app.isitlegit.co.za/signin) with the same email instead.
2. **Open your sign-in email:** look for **Your IsItLegit sign-in link** from `signin@isitlegit.co.za`. Open the link and choose **Sign in to IsItLegit**. If you opened it in a different browser, choose **Sign in in this browser instead**. Links expire after 15 minutes and work once.
3. **Choose an example:** open [Cases](https://app.isitlegit.co.za/cases). If you land on the welcome checklist, go straight to Cases; completing business setup is not required to read the demo examples. The judge invitation provisions five synthetic cases: sign-in phishing, changed bank details, business impersonation, ordinary supplier mail and a director voice note. Start with **Invoice INV-2099-041 and updated banking details**. If processing is still running, wait for the report; if the examples are absent, use the optional upload below or contact the submission team.
4. **Read the investigation:** check the verdict, its cited evidence and the recommended next action. The invoice example asks for payment to changed bank details and is designed to be **suspicious**. Use the actual result shown: a partial report or a check that did not run is not a completed check.
5. **Inspect the models:** open the report's model trace to see the calls and evidence recorded for that case. You can open it directly by adding `?trace=1#model-trace` to a report URL with no existing query string. The trace shows actual execution; not every model runs on every case.

## Try a new check (optional)

Download the fictional [changed-bank-details email](../data/demo/judge/tampered-invoice.eml) using GitHub's **Download raw file** control. In [Cases](https://app.isitlegit.co.za/cases), choose **Upload a file**, then drop the saved `.eml` file or choose it in the file picker. With JavaScript enabled, selecting the file starts the check; without it, choose **Check this file**. Follow the report as it progresses.

The fixture contains fictional companies, addresses and bank details. Its expected suspicious result is a test expectation, not a promised outcome: registered supplier comparisons require the demo baseline to be available, and provider failures can leave checks incomplete. No real invoice or private email is needed for this walkthrough.

## If you cannot sign in

Check junk mail and the email address you entered. Use **Send another link** when the countdown allows, or **Email me a new link** for an expired or used link. If you already created your account, request another sign-in link instead of signing up again. For a missing or refused invitation, use the private submission contact. Never share an invite, sign-in link, email code or session cookie publicly.

## What the demo proves

The examples show the investigation workflow and its evidence. Read any checks-not-run messages. A fresh five-case check on 4 November matched the fixtures' expected verdicts, but reports still disclosed checks that did not run. Version-specific measurements and limits are in the [Loupe model card](glimmer/model-card.md) and [release status](glimmer/release-status.md). This walkthrough is not a claim that every model ran or that detection is perfect.

Developers who want to run the code locally can use the separate [local setup instructions](../README.md#run-the-worker-locally).
