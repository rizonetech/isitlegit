import { Button } from "../../src/web/components/Button";
import { type ErrorStateProps, referenceLine } from "../../src/web/components/States";

// Each error board's composition, as D07 T08 §1 will wire it.
const AT = new Date("2026-10-27T08:12:00Z");
const FORWARD = (
  <>
    Forwarding still works: send suspicious mail to <strong class="font-mono text-ink">check@isitlegit.co.za</strong> as
    usual.
  </>
);
export const ERRORS: Record<string, ErrorStateProps> = {
  404: {
    code: 404,
    title: "We can't show you that page.",
    children:
      "It may not exist, the address may be mistyped, or it may belong to an organisation you are not part of. We don't say which, so case links never reveal anything.",
    actions: [
      <Button variant="dark" href="/cases">
        Go to your cases
      </Button>,
      <Button variant="ghost" href="/upload">
        Check a file
      </Button>,
    ],
    note: FORWARD,
    footer: referenceLine("404-7F3K2Q", AT),
  },
  403: {
    code: 403,
    title: "You're not a member of this organisation.",
    children: (
      <>
        You are signed in as <strong class="text-ink">ayesha@outeniquapaper.example</strong>, which has no access here.
        Ask an owner of the organisation to invite this address, or sign in with another one.
      </>
    ),
    actions: [
      <Button variant="dark" href="/cases">
        Go to your own cases
      </Button>,
      <Button variant="ghost" type="submit" form="sign-out">
        Sign out
      </Button>,
    ],
    footer: referenceLine("403-4H7N1C", AT),
  },
  410: {
    code: 410,
    title: "This report link has expired.",
    children:
      "Links in our reply emails work for 7 days, so an old email can't be used to read a report. The case itself stays in your organisation's account: sign in to open it.",
    actions: [
      <Button variant="dark" href="/sign-in">
        Sign in to see the case
      </Button>,
    ],
    note: (
      <>
        No account? Forward the email again to <strong class="font-mono text-ink">check@isitlegit.co.za</strong> for a
        fresh report.
      </>
    ),
    footer: referenceLine("410-9M2T8D", AT),
  },
  429: {
    code: 429,
    title: "You've reached today's limit of 50 checks.",
    children:
      "Karoo Couriers can check 50 emails or files a day during the launch. The limit resets at 00:00 SAST, in 5 h 12 min. Mail forwarded before then is not checked: you get one email saying so, and can forward it again after the reset.",
    actions: [
      <Button variant="dark" href="/plan">
        See your plan
      </Button>,
      <Button variant="ghost" href="/cases">
        Back to cases
      </Button>,
    ],
    panel: {
      lead: "Too many requests at once?",
      sentence:
        'The same page also covers a short burst limit: then it says "try again in 30 seconds" and counts down.',
    },
    footer: referenceLine("429-2B6W5R", AT),
  },
  500: {
    code: 500,
    title: "Sorry, something broke on our side.",
    children:
      "This was our fault, not yours, and we have been told about it. Try again in a minute. If it keeps happening, send us the reference below.",
    actions: [
      <Button variant="dark" href="/cases">
        Try again
      </Button>,
      <Button variant="ghost" href="mailto:support@isitlegit.co.za">
        Email support
      </Button>,
    ],
    note: FORWARD,
    footer: referenceLine("500-8K1V3P", AT),
  },
  maintenance: {
    code: "maintenance",
    title: "We're upgrading IsItLegit. Back by 02:30 SAST.",
    children:
      "The dashboard is offline from 02:00 to 02:30 SAST on Tue 28 Oct 2026. Your cases and settings are safe. Replies to email forwarded to check@ during this window may be late; if one has not arrived an hour after we are back, forward the email again.",
    actions: [
      <Button variant="ghost" href="/cases">
        Reload
      </Button>,
    ],
    footer: "Started 02:00 SAST · expected back 02:30 SAST",
  },
};
