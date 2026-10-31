// The verify page (D05 T02 §6; design/SPEC.md T1, boards Verify-Protected, Verify-NotProtected and Verify-Mobile): the
// public page a protected business's badge links to, `isitlegit.co.za/v/<slug>`. It names the business, the domains it
// really sends from, when IsItLegit verified it and that it was checked again as the page opened, and how to forward a
// received email as an attachment, the one check that proves anything. It never shows bank details, addresses beyond
// the domains, or the finance contact. A business not protected now gets the grey Not verified state; an unknown
// address the site's 404, never repeating it; a failed read the site's error page with a retry (corrections 6, 12 and
// 15). The board's foreign-origin state is §9's.
import { MOTION, SEAL } from "../assets";
import { AppShell } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Pill } from "../components/Pill";
import { ErrorState, referenceLine } from "../components/States";

export const CHECK_ADDRESS = "check@isitlegit.co.za";
export const ORIGIN_NOTE = "You are on isitlegit.co.za";
const PROTECT_URL = "https://isitlegit.co.za/protect";
const CARD = "flex flex-col gap-16 p-24 bg-surface border border-line rounded-card-large min-w-0 md:p-32";
const LINK = cx("text-orange-text underline underline-offset-4", FOCUS);
const day = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

export type VerifyView =
  | { kind: "protected"; name: string; domains: string[]; verifiedOn: string | null; checkedAt: string }
  | { kind: "not-verified"; name: string };

// The check address with the app's copy control (the member shell's forward box): Copy, then a status line, and the
// address selected for copying by hand when the clipboard refuses.
function CopyAddress() {
  return (
    <div data-copy-group class="flex flex-col items-start gap-8">
      <div class="flex flex-wrap items-center gap-12">
        <span data-copy-source class="font-mono weight-text-strong wrap-anywhere">
          {CHECK_ADDRESS}
        </span>
        <Button type="button" variant="dark" data-copy={CHECK_ADDRESS}>
          Copy {CHECK_ADDRESS}
        </Button>
      </div>
      <p data-copy-status role="status" aria-live="polite" class="text-13 text-muted" />
    </div>
  );
}

// How to forward as an attachment (correction 12, gap 5 of D05 T02 §1's completion review): from the mailbox that
// received it, never an inline forward (the check needs the original attached) and never an upload (members only).
function Steps(props: { name: string }) {
  return (
    <section aria-labelledby="check-heading" class={CARD}>
      <h2 id="check-heading" class="type-h3 wrap-anywhere">
        Got an email from {props.name}? Check that it is real.
      </h2>
      <ol class="flex flex-col gap-8 list-decimal pl-24">
        <li>
          Forward the email <strong>as an attachment</strong> to{" "}
          <code class="font-mono weight-text-strong">{CHECK_ADDRESS}</code>, from the mailbox that received it.
        </li>
        <li>In about a minute you get a reply: real, or not from {props.name}, with the reasons.</li>
        <li>If it is a fake, {props.name} is told so they can warn others.</li>
      </ol>
      <div class="grid gap-16 md:grid-cols-2">
        <div class="flex flex-col gap-8 p-16 bg-subtle border border-line rounded-card">
          <h3 class="text-14 weight-text-strong">Outlook on a computer</h3>
          <p class="text-14 text-muted">Select the email, then More actions, Forward as attachment.</p>
        </div>
        <div class="flex flex-col gap-8 p-16 bg-subtle border border-line rounded-card">
          <h3 class="text-14 weight-text-strong">Gmail on a computer</h3>
          <p class="text-14 text-muted">Open the email, then More, Forward as attachment.</p>
        </div>
        <div class="flex flex-col gap-8 p-16 bg-subtle border border-line rounded-card">
          <h3 class="text-14 weight-text-strong">Outlook app on a phone</h3>
          <p class="text-14 text-muted">Open the email, tap the three dots, then Forward as attachment.</p>
        </div>
        <div class="flex flex-col gap-8 p-16 bg-subtle border border-line rounded-card">
          <h3 class="text-14 weight-text-strong">Gmail app on a phone</h3>
          <p class="text-14 text-muted">
            The Gmail app cannot forward as an attachment. Forward it from Gmail on a computer instead.
          </p>
        </div>
      </div>
      <CopyAddress />
      <div class="flex flex-col gap-4">
        <h3 class="text-14 weight-text-strong">If no reply comes</h3>
        <ul class="flex flex-col gap-4 list-disc pl-24 text-14 text-muted">
          <li>Forward it again from your own mailbox, as an attachment, with the original sender visible.</li>
          <li>Checks about one business are limited each day, so a reply can wait until tomorrow.</li>
          <li>No reply never means the email is genuine.</li>
        </ul>
      </div>
    </section>
  );
}

function Protected(props: Extract<VerifyView, { kind: "protected" }>) {
  const checked = day.format(Date.parse(props.checkedAt));
  return (
    <>
      <section aria-labelledby="business-heading" class={cx(CARD, "md:flex-row md:items-center md:gap-32")}>
        <img src={SEAL} alt="IsItLegit Protected seal" class="w-120 h-120 shrink-0" />
        <div class="flex flex-col items-start gap-8 min-w-0">
          <Pill variant="safe">Protected by IsItLegit</Pill>
          <h1 id="business-heading" class="type-h1 wrap-anywhere">
            {props.name}
          </h1>
          <p class="text-muted">
            {props.verifiedOn
              ? `Identity verified by IsItLegit on ${day.format(Date.parse(props.verifiedOn))} · checked again as this page opened, ${checked}`
              : `Identity checked by IsItLegit as this page opened, ${checked}`}
          </p>
        </div>
      </section>
      <section aria-labelledby="domains-heading" class={CARD}>
        <h2 id="domains-heading" class="type-h3 wrap-anywhere">
          {props.name} only sends email from
        </h2>
        <ul class="flex flex-wrap gap-12">
          {props.domains.map((d) => (
            <li class="px-16 py-12 rounded-card bg-safe-wash font-mono text-16 weight-text-strong text-ink wrap-anywhere">
              {d}
            </li>
          ))}
        </ul>
        <p class="text-muted">
          Mail from any other address that claims to be {props.name} is not from them, even if the logo and signature
          look right.
        </p>
      </section>
      <Steps name={props.name} />
    </>
  );
}

function NotVerified(props: Extract<VerifyView, { kind: "not-verified" }>) {
  return (
    <>
      <section aria-labelledby="business-heading" class={cx(CARD, "md:flex-row md:items-center md:gap-32")}>
        <div class="flex shrink-0 items-center justify-center w-120 h-120 rounded-full bg-subtle">
          <img src={MOTION.question} alt="" class="w-72 h-72" />
        </div>
        <div class="flex flex-col items-start gap-8 min-w-0">
          <Pill variant="neutral">Not verified</Pill>
          <h1 id="business-heading" class="type-h1 wrap-anywhere">
            {props.name} is not protected right now
          </h1>
          <p class="text-muted">IsItLegit cannot confirm which addresses are really theirs.</p>
        </div>
      </section>
      <section aria-labelledby="badge-heading" class={cx(CARD, "bg-sus-wash border-sus")}>
        <h2 id="badge-heading" class="type-h3 text-ink">
          A badge or seal that points here proves nothing today
        </h2>
        <p>
          If an email signature or website showed you a Protected badge and brought you to this page, treat that email
          or website with the same care as any other. Do not pay or change bank details on the strength of it.
        </p>
      </section>
      <section aria-labelledby="contact-heading" class={CARD}>
        <h2 id="contact-heading" class="type-h3">
          Check with them directly
        </h2>
        <p>
          Contact {props.name} on a phone number from your own records, never one from the email. IsItLegit cannot check
          mail for a business it does not protect.
        </p>
      </section>
      <p class="text-14 text-muted text-center">
        Are you {props.name}?{" "}
        <a href="/sign-in" class={LINK}>
          Sign in to renew your protection
        </a>
      </p>
    </>
  );
}

export function VerifyPage(props: { view: VerifyView }) {
  const { view } = props;
  return (
    <Document title={view.kind === "protected" ? `${view.name} is protected` : `${view.name} is not verified`}>
      <AppShell variant="public" note={ORIGIN_NOTE}>
        <div class="flex flex-col gap-24 w-full max-w-[880px] mx-auto px-16 py-24 md:py-56">
          {view.kind === "protected" ? <Protected {...view} /> : <NotVerified {...view} />}
          <p class="text-14 text-muted text-center">
            This page never shows bank details or contact people.{" "}
            <a href={PROTECT_URL} class={LINK}>
              Protect your own business
            </a>
          </p>
        </div>
      </AppShell>
    </Document>
  );
}

// An address no business holds: the site's 404, never repeating the address as a business name.
export function VerifyUnknown(props: { reference: string; now: Date }) {
  return (
    <Document title="Not protected by IsItLegit">
      <AppShell variant="public" note={ORIGIN_NOTE}>
        <div class="w-full max-w-[880px] mx-auto px-16 py-24 md:py-56">
          <ErrorState
            code={404}
            title="This business is not protected by IsItLegit."
            actions={[
              <Button variant="dark" href={PROTECT_URL}>
                About protected businesses
              </Button>,
            ]}
            footer={referenceLine(props.reference, props.now)}
          >
            A badge or seal that brought you here proves nothing. To check an email, forward it as an attachment to{" "}
            {CHECK_ADDRESS}.
          </ErrorState>
        </div>
      </AppShell>
    </Document>
  );
}

// A read that failed: neither protected nor not verified is said, only that the page could not be checked now.
export function VerifyUnavailable(props: { reference: string; now: Date; retry: string }) {
  return (
    <Document title="Could not check this business">
      <AppShell variant="public" note={ORIGIN_NOTE}>
        <div class="w-full max-w-[880px] mx-auto px-16 py-24 md:py-56">
          <ErrorState
            code={500}
            title="We could not check this business just now."
            actions={[
              <Button variant="dark" href={props.retry}>
                Try again
              </Button>,
            ]}
            footer={referenceLine(props.reference, props.now)}
          >
            Nothing on this page says whether the business is protected. Try again in a minute; meanwhile treat the
            email with the same care as any other.
          </ErrorState>
        </div>
      </AppShell>
    </Document>
  );
}
