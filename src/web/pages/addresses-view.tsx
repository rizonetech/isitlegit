// The single-address verification page (D07 T04 §27; design/SPEC.md M8a): an owner or admin proves one address, not a
// whole domain, by a code mailed to it. It follows the domain claim page (./domains-view.tsx, board `Verify-Domain`):
// every part is drawn from what is stored (src/auth/domains.ts `addressClaimView`), so a reload shows what the action
// that led here did, and what an action just did comes back in the address (`r`). Each form names the organisation the
// page was drawn for, so a form left open across an organisation switch changes nothing (./addresses.tsx).
import type { AddressClaimView } from "../../auth/domain-claim";
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Field } from "../components/Field";
import { Pill } from "../components/Pill";
import { ErrorState, referenceLine } from "../components/States";

const MAX_ATTEMPTS = 3;
const CODE_MINUTES = 30;
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const at = (iso: string) => `${clock.format(Date.parse(iso))} SAST`;

// What an action just did, as the redirect carries it.
export type Result = { r: string };
export const RESULTS = [
  "add-sent",
  "add-unknown",
  "add-failed",
  "already",
  "send-sent",
  "send-unknown",
  "send-failed",
  "send-locked",
  "send-limit",
  "send-busy",
  "send-sending",
  "verify-verified",
  "verify-wrong",
  "verify-malformed",
  "verify-locked",
  "verify-expired",
  "verify-none",
  "verify-taken",
  "verify-unavailable",
  "switched",
  "unavailable",
] as const;

const LINK = cx("text-orange-text underline underline-offset-4", FOCUS);
const CARD = "flex flex-col gap-16 p-24 bg-surface border border-line rounded-card-large min-w-0";

function Notice(props: { tone: "info" | "error"; id?: string; children: unknown }) {
  return (
    <p
      id={props.id}
      role={props.tone === "error" ? "alert" : "status"}
      class={cx("type-small wrap-anywhere", props.tone === "error" ? "text-mal" : "text-muted")}
    >
      {props.children as never}
    </p>
  );
}

// The words of what the last action did, never claiming more than the stored claim shows.
function notice(result: Result | null, view: AddressClaimView, orgName: string) {
  if (!result) return null;
  const to = view.address;
  switch (result.r) {
    // The mail's outcomes (sent, uncertain, failed) are told from the stored send, not from the address, so an address kept
    // open across a later send never contradicts what is stored (see CodeCard).
    case "add-sent":
    case "send-sent":
    case "add-unknown":
    case "send-unknown":
    case "add-failed":
    case "send-failed":
      return null;
    case "already":
      return view.state === "verified" ? <Notice tone="info">{to} is already verified.</Notice> : null;
    case "send-locked":
      return (
        <Notice tone="error">
          Code entry is locked after too many wrong codes
          {view.code.lockedUntil ? `, until ${at(view.code.lockedUntil)}` : ""}. A new code can be sent when the lock
          ends.
        </Notice>
      );
    case "send-limit":
      return (
        <Notice tone="error">
          Five codes an hour can go to one address.
          {view.code.nextCodeAt ? ` The next can go at ${at(view.code.nextCodeAt)}.` : ""}
        </Notice>
      );
    case "send-busy":
      return (
        <Notice tone="error">
          Your organisation has sent as many codes as it can for now.
          {view.code.nextCodeAt ? ` The next can go at ${at(view.code.nextCodeAt)}.` : ""}
        </Notice>
      );
    case "send-sending":
      return (
        <Notice tone="info">
          The last code is still on its way. Check the inbox before asking for another: a new code replaces it.
        </Notice>
      );
    case "verify-taken":
      return (
        <Notice tone="error">
          {to} was verified by another organisation, so this claim cannot be verified. Remove it from Domains and
          addresses.
        </Notice>
      );
    case "verify-unavailable":
    case "unavailable":
      return <Notice tone="error">That could not be done just now. Try again in a moment.</Notice>;
    case "switched":
      return (
        <Notice tone="info">
          Your organisation changed in another tab, so nothing was done. This page is now for {orgName}.
        </Notice>
      );
    // Said only of a claim that is verified: the page never contradicts what is stored.
    case "verify-verified":
      return view.state === "verified" ? <Notice tone="info">Done: {to} is verified.</Notice> : null;
    default:
      return null;
  }
}

// The code field's own error, kept with the field.
function codeError(result: Result | null, view: AddressClaimView): string | undefined {
  const left = MAX_ATTEMPTS - view.code.attempts;
  switch (result?.r) {
    case "verify-wrong":
      return `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left before this is locked for an hour.`;
    case "verify-malformed":
      return "Type the 6 digits from the email.";
    case "verify-expired":
      return "That code has expired. Send a new one.";
    case "verify-none":
      return "No code is waiting. Send one first.";
    default:
      return undefined;
  }
}
const triesLeft = (view: AddressClaimView): string => {
  if (view.code.attempts === 0) return "";
  const left = MAX_ATTEMPTS - view.code.attempts;
  return ` ${left} ${left === 1 ? "try" : "tries"} left before this is locked for an hour.`;
};

type Shell = Omit<MemberShellProps, "children">;

const SENT_RESULTS = ["add-sent", "send-sent", "send-unknown", "add-unknown"];
const CODE_LIFETIME_MS = CODE_MINUTES * 60_000;

function CodeCard(props: { view: AddressClaimView; org: string; path: string; result: Result | null; now: Date }) {
  const { view, result, now, path } = props;
  const { lockedUntil, expiresAt, nextCodeAt } = view.code;
  const waiting = nextCodeAt && Date.parse(nextCodeAt) > now.getTime() ? nextCodeAt : null;
  const error = codeError(result, view);
  // A code just mailed is the next thing to do: the field is ready for it, with no tabbing past the navigation.
  const ready = Boolean(expiresAt && result && SENT_RESULTS.includes(result.r));
  // The moment it went is the expiry less its life, which is how the expiry was set when it was sent.
  const sentAt = expiresAt ? new Date(Date.parse(expiresAt) - CODE_LIFETIME_MS).toISOString() : null;
  // What became of the live code's mail, said on every visit, not only after the action: a code that could not be sent is
  // not a code to enter, and one that may not have gone says so.
  const delivery = view.code.delivery;
  // Just mailed: the action's own confirmation, said only while the stored send agrees with it.
  const justSent = Boolean(result && /^(add|send)-/.test(result.r));
  const deliveryNote = !expiresAt ? null : delivery === "failed" ? (
    <Notice tone="error">The code could not be sent to {view.address}. Send a new code.</Notice>
  ) : delivery === "uncertain" ? (
    <Notice tone="info">
      The code may not have gone to {view.address}. Check that inbox before sending another, because a new code replaces
      it.
    </Notice>
  ) : delivery === "sending" ? (
    <Notice tone="info">
      The code is still on its way to {view.address}. Check the inbox before asking for another.
    </Notice>
  ) : delivery === "sent" && justSent ? (
    <Notice tone="info">
      A code was mailed to {view.address}. It works for {CODE_MINUTES} minutes.
    </Notice>
  ) : null;
  const enterable = Boolean(expiresAt) && delivery !== "failed";
  return (
    <section aria-labelledby="code-heading" class={cx(CARD, "max-w-2xl")}>
      <h2 id="code-heading" class="type-h3">
        Get a code by email
      </h2>
      <p class="type-small text-muted wrap-anywhere">
        We email a six-digit code to {view.address}. Only someone who can read that inbox can enter it.
      </p>
      {lockedUntil ? (
        <div
          class="flex flex-col gap-8 p-16 border border-line rounded-card bg-subtle"
          data-reload-at={String(Math.ceil(Date.parse(lockedUntil) / 1000))}
        >
          <Pill variant="neutral">Locked</Pill>
          <p class="text-14 weight-heading">Code entry is locked until {at(lockedUntil)}</p>
          <p class="type-small text-muted">
            Three wrong codes in a row. Once the lock ends, send a new code: the old one will have expired.
          </p>
          <a href={path} class={cx(LINK, "self-start")}>
            Check again
          </a>
        </div>
      ) : (
        <>
          <form method="post" class="flex flex-col gap-12" data-busy data-busy-check={path}>
            <input type="hidden" name="org" value={props.org} />
            <input type="hidden" name="action" value="send" />
            <Button
              id="send-code"
              type="submit"
              variant="ghost"
              class="self-start"
              data-busy-label="Sending"
              disabled={waiting !== null}
              {...(waiting
                ? {
                    disabledReason: `The next code can go at ${at(waiting)}.`,
                    "data-retry-at": String(Math.ceil(Date.parse(waiting) / 1000)),
                    "data-ready-label": "Send a new code",
                    "data-ready-clear": "send-code-reason",
                  }
                : {})}
            >
              Send a new code
            </Button>
            {waiting && (
              <a href={path} class={cx(LINK, "self-start type-small")}>
                Check again
              </a>
            )}
          </form>
          {deliveryNote}
          {expiresAt && enterable ? (
            <form method="post" class="flex flex-col gap-12" data-busy data-busy-check={path} data-announce-scope>
              <input type="hidden" name="org" value={props.org} />
              <input type="hidden" name="action" value="verify" />
              <Field
                id="address-code"
                name="code"
                label="Code from the email"
                hint={`${delivery === "sent" ? "Sent to" : "Issued for"} ${view.address}${sentAt ? ` at ${at(sentAt)}` : ""}. It works until ${at(expiresAt)}.${triesLeft(view)}`}
                {...(ready ? { autofocus: true } : {})}
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength={32}
                required
                {...(error ? { error } : {})}
              />
              <Button type="submit" variant="primary" data-busy-label="Verifying" class="self-start">
                Verify
              </Button>
            </form>
          ) : delivery === "failed" && expiresAt ? null : view.code.expired ? (
            <Notice tone="error">The code we sent has expired. Send a new one.</Notice>
          ) : (
            <Notice tone={error ? "error" : "info"}>{error ?? "No code is waiting. Send one."}</Notice>
          )}
        </>
      )}
    </section>
  );
}

function VerifiedPanel(props: { view: AddressClaimView }) {
  const { view } = props;
  return (
    <section class={cx(CARD, "max-w-2xl")}>
      <Pill variant="safe">Verified</Pill>
      <h2 class="type-h3 wrap-anywhere">{view.address} is verified</h2>
      <p class="type-small text-muted">
        Mail from this address is now accepted at check@, and you can use it as your protected identity's finance
        contact. Proved by a code to its inbox{view.verifiedAt ? ` at ${at(view.verifiedAt)}` : ""}.
      </p>
      <a href="/settings/domains" class={cx(LINK, "self-start")}>
        Back to Domains and addresses
      </a>
    </section>
  );
}

export function AddressPage(props: { shell: Shell; view: AddressClaimView; result: Result | null; now: Date }) {
  const { shell, view, result, now } = props;
  const org = shell.organization;
  const said = notice(result, view, org.name);
  return (
    <Document title={`Verify ${view.address}`}>
      <AppShell {...shell}>
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40">
          <nav aria-label="Breadcrumb" class="type-small text-muted">
            <ol class="flex flex-wrap gap-8">
              <li>
                <a href="/settings/domains" class={LINK}>
                  Domains and addresses
                </a>
              </li>
              <li aria-current="page" class="wrap-anywhere">
                <span aria-hidden="true">/ </span>Verify {view.address}
              </li>
            </ol>
          </nav>
          <header class="flex flex-wrap items-start justify-between gap-16">
            <div class="flex flex-col gap-8 min-w-0">
              <h1 class="type-h1 wrap-anywhere">Prove you own {view.address}</h1>
              {view.state === "pending" && (
                <p class="text-muted">Until you do, mail from this address is not accepted at check@ for {org.name}.</p>
              )}
            </div>
            {view.state === "pending" ? (
              <Pill variant="suspicious">Pending</Pill>
            ) : (
              <Pill variant="safe">Verified</Pill>
            )}
          </header>
          {said}
          {view.state === "verified" ? (
            <VerifiedPanel view={view} />
          ) : (
            <CodeCard
              view={view}
              org={org.id}
              path={`/settings/addresses/${encodeURIComponent(view.address)}`}
              result={result}
              now={now}
            />
          )}
        </div>
      </AppShell>
    </Document>
  );
}

// An address the organisation has not claimed (or one removed meanwhile): the same page whoever's address it is.
export function AddressNotFound(props: {
  shell: Shell;
  address: string;
  reference: string;
  now: Date;
  switched: boolean;
}) {
  return (
    <Document title="Not found">
      <AppShell {...props.shell}>
        <div class="px-16 py-24 md:px-56 md:py-40 flex flex-col gap-16">
          {props.switched && (
            <Notice tone="info">
              Your organisation changed in another tab, so nothing was done. This page is now for{" "}
              {props.shell.organization.name}.
            </Notice>
          )}
          <ErrorState
            code={404}
            title="That address is not claimed here."
            actions={[
              <Button variant="dark" href="/settings/domains">
                Go to Domains and addresses
              </Button>,
              <Button variant="ghost" href="/cases">
                Go to your cases
              </Button>,
            ]}
            footer={referenceLine(props.reference, props.now)}
          >
            {props.shell.organization.name} has no claim on {props.address}, or it was removed. Add it again from
            Domains and addresses.
          </ErrorState>
        </div>
      </AppShell>
    </Document>
  );
}

// A member who is not an owner or admin (a Deviation in design/SPEC.md E3, as the domain page's).
export function AddressRoleRefusal(props: { orgName: string; reference: string; now: Date }) {
  return (
    <Document title="No access">
      <main id="content" class="min-h-screen p-16 md:px-56 md:py-40 bg-subtle">
        <ErrorState
          code={403}
          title="Only an owner or admin verifies addresses."
          actions={[
            <Button variant="dark" href="/cases">
              Go to your cases
            </Button>,
          ]}
          footer={referenceLine(props.reference, props.now)}
        >
          An owner or admin of {props.orgName} verifies its addresses. Ask one of them to do it.
        </ErrorState>
      </main>
    </Document>
  );
}
