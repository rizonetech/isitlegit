// The domain verification page (D07 T02 §15; design/SPEC.md A5, board `Verify-Domain`): an owner or admin proves the
// organisation's domain by a DNS TXT record or a code mailed to admin@ or postmaster@ it. Every part is drawn from what
// is stored (src/auth/domains.ts `domainClaimView`), so a reload shows the same page as the action that led to it; what
// an action just did comes back in the address (`r`) after its redirect. Each form names the organisation the page was
// drawn for, so a form left open across an organisation switch changes nothing (./domains.tsx).
import type { DomainClaimView } from "../../auth/domain-claim";
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Field } from "../components/Field";
import { CopyIcon } from "../components/icons";
import { Pill } from "../components/Pill";
import { ErrorState, referenceLine } from "../components/States";

const MAX_ATTEMPTS = 3;
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const at = (iso: string) => `${clock.format(Date.parse(iso))} SAST`;

// What an action just did, as the redirect carries it.
export type Result = { r: string; seen?: string; to?: string };
export const RESULTS = [
  "check-verified",
  "check-absent",
  "check-different",
  "check-failing",
  "check-taken",
  "check-unavailable",
  "send-sent",
  "send-unknown",
  "send-failed",
  "send-locked",
  "send-limit",
  "send-busy",
  "send-sending",
  "send-bad-local",
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

// One line of the record to add, with its copy group (D07 T01 §9's copy script).
function RecordRow(props: { label: string; value: string; copyLabel: string }) {
  return (
    <div
      data-copy-group
      class="grid grid-cols-[5rem_1fr] md:grid-cols-[6rem_1fr_auto] items-center gap-12 py-12 border-t border-line"
    >
      <dt class="type-small text-muted">{props.label}</dt>
      <dd data-copy-source class="font-mono text-14 weight-text-strong wrap-anywhere min-w-0">
        {props.value}
      </dd>
      <dd class="col-start-2 md:col-start-auto flex flex-wrap items-center gap-8">
        <Button variant="ghost" size="small" icon={<CopyIcon />} data-copy={props.value} aria-label={props.copyLabel}>
          Copy
        </Button>
        <span data-copy-status role="status" aria-live="polite" class="text-13 text-muted" />
      </dd>
    </div>
  );
}

function lastCheckLine(check: DomainClaimView["lastCheck"]): string | null {
  if (!check) return null;
  const what =
    check.outcome === "dns-not-visible"
      ? "record not found yet. New records can take a few minutes to appear."
      : check.outcome === "dns-different"
        ? "a different record was found in its place."
        : "the DNS lookup could not be made; check again in a moment.";
  return `Last checked ${at(check.at)}: ${what}`;
}

// One provider's steps (D07 T04 §11): where its DNS lives, what its Name field expects for this claim, and its TTL.
function ProviderSteps(props: { name: string; steps: string[] }) {
  return (
    <details class="border-t border-line py-8">
      <summary class="text-14 weight-text-strong cursor-pointer">{props.name}</summary>
      <ol class="flex flex-col gap-4 pl-20 pt-8 type-small text-muted list-decimal">
        {props.steps.map((step) => (
          <li>{step}</li>
        ))}
      </ol>
    </details>
  );
}

// Adding the record at the owner's own provider (D07 T04 §11): first where the DNS lives at all, then the four
// providers South African owners use most, then every other provider. Native disclosures: one action, keyboard
// works, no JavaScript needed. Steps checked against each provider's own help on 2026-11-02.
function ProviderHelp(props: { view: DomainClaimView }) {
  const { view } = props;
  const sub = view.txt.name.split(".")[0] ?? "_isitlegit";
  const value = view.txt.value;
  const trouble =
    "Then come back and press Check now. New records usually show within minutes and can take up to an hour. If we find a different record, the name was most likely doubled (like " +
    `${view.txt.name}.${view.domain}) or an older record is still there: fix the name to exactly ${view.txt.name} and remove the old one.`;
  return (
    <details class="border border-line rounded-card bg-subtle p-16">
      <summary class="text-14 weight-heading cursor-pointer">How do I add this at my provider?</summary>
      <div class="flex flex-col gap-8 pt-12">
        <p class="type-small text-muted">
          Your DNS host is whoever your domain's nameservers point to, which is not always the company that sold you the
          domain. Your registrar's nameservers page shows them: Cloudflare, Hetzner, xneelo or Afrihost nameservers mean
          the steps for that provider below. If your web designer or IT company manages your DNS, send them the Name and
          Value above (both copy) and ask them to add the TXT record; then press Check now.
        </p>
        <ProviderSteps
          name="Cloudflare"
          steps={[
            "Open dash.cloudflare.com, choose your domain, then DNS and Records.",
            "Choose Add record. Type: TXT.",
            `Name: ${sub} (Cloudflare adds your domain to it).`,
            `Content: ${value}`,
            "TTL: leave Auto. Save the record.",
            trouble,
          ]}
        />
        <ProviderSteps
          name="Hetzner"
          steps={[
            "Open the Hetzner DNS Console (dns.hetzner.com) and choose your zone.",
            "Choose Add record. Type: TXT.",
            `Name: ${sub} (the part before your domain; Hetzner adds the rest).`,
            `Value: ${value}`,
            "TTL: leave the default. Save the record.",
            trouble,
          ]}
        />
        <ProviderSteps
          name="xneelo"
          steps={[
            "Open the xneelo Control Panel (konsoleH works the same), then Manage DNS under Domain Tools.",
            "Choose Add Record. Type: TXT.",
            `Host: ${sub} (just that part, not the whole name).`,
            `Destination: "${value}" in quotation marks, as xneelo asks for them.`,
            "Choose Add.",
            trouble,
          ]}
        />
        <ProviderSteps
          name="Afrihost"
          steps={[
            "Open ClientZone, then Hosting, your domain, Hosting Settings and DNS Editor.",
            "Choose Create New Record. Type: TXT.",
            `Record: ${view.txt.name} (the whole name, not just ${sub}).`,
            `Content: ${value}`,
            "TTL: leave the default. Create the record.",
            trouble,
          ]}
        />
        <ProviderSteps
          name="Another provider"
          steps={[
            "Open wherever your DNS records are edited (your registrar, host or DNS service) and add a TXT record.",
            `Name: ${sub} if the form wants only the part before your domain, or ${view.txt.name} if it wants the whole name. If the form shows your domain next to the field, use ${sub}.`,
            `Value: ${value}, without quotation marks (most providers add their own; if the saved record shows two pairs, remove yours).`,
            "TTL: the smallest offered, or the default. Save the record.",
            trouble,
          ]}
        />
      </div>
    </details>
  );
}

// `local` is the recipient last chosen, carried by every form so no answer quietly changes it (D07 T02 §15).
function DnsCard(props: { view: DomainClaimView; org: string; result: Result | null; local: "admin" | "postmaster" }) {
  const { view, result } = props;
  const last = lastCheckLine(view.lastCheck);
  return (
    <section aria-labelledby="dns-heading" class={CARD}>
      <div class="flex flex-wrap items-center gap-12">
        <Pill variant="neutral">Option 1 · recommended</Pill>
        <h2 id="dns-heading" class="type-h3">
          Add a DNS TXT record
        </h2>
      </div>
      <p class="type-small text-muted">
        In your domain's DNS settings (for example at your registrar or Cloudflare), add this record. It changes nothing
        about your website or mail.
      </p>
      <dl class="flex flex-col">
        <div class="grid grid-cols-[5rem_1fr] md:grid-cols-[6rem_1fr_auto] items-center gap-12 py-12">
          <dt class="type-small text-muted">Type</dt>
          <dd class="font-mono text-14 weight-text-strong">TXT</dd>
        </div>
        <RecordRow label="Name" value={view.txt.name} copyLabel="Copy the record name" />
        <RecordRow label="Value" value={view.txt.value} copyLabel="Copy the record value" />
      </dl>
      <ProviderHelp view={view} />
      <form method="post" class="flex flex-wrap items-center gap-16" data-busy>
        <input type="hidden" name="org" value={props.org} />
        <input type="hidden" name="action" value="check" />
        <input type="hidden" name="local" value={props.local} />
        <Button type="submit" variant="dark" data-busy-label="Checking">
          Check now
        </Button>
        {last && <p class="type-small text-muted min-w-0 flex-1">{last}</p>}
      </form>
      {result?.r === "check-absent" && (
        <Notice tone="info">The record is not visible yet. DNS can take up to an hour; check again later.</Notice>
      )}
      {result?.r === "check-failing" && (
        <Notice tone="error">The DNS lookup could not be made just now. Check again in a moment.</Notice>
      )}
      {result?.r === "check-different" && (
        <div class="flex flex-col gap-8 p-16 border border-line rounded-card bg-subtle">
          <Pill variant="malicious">Failed</Pill>
          <p class="text-14 weight-heading">We found a different record</p>
          <p class="type-small text-muted wrap-anywhere">
            {view.txt.name} holds {result.seen ?? "isitlegit-verify="}... which is not your code. Replace it with the
            value above and check again.
          </p>
        </div>
      )}
    </section>
  );
}

function sendNotice(result: Result | null, view: DomainClaimView) {
  if (!result?.r.startsWith("send-")) return null;
  const to = result.to ?? "the address you chose";
  switch (result.r) {
    case "send-sent":
      return <Notice tone="info">We sent a code to {to}. It works for 30 minutes.</Notice>;
    case "send-unknown":
      return (
        <Notice tone="info">
          The code may have gone to {to}. Check that inbox before sending another, because a new code replaces it.
        </Notice>
      );
    case "send-failed":
      return <Notice tone="error">The code could not be sent to {to}. Send another.</Notice>;
    case "send-limit":
      return (
        <Notice tone="error">
          Five codes an hour can go for this domain.
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
    case "send-bad-local":
      return <Notice tone="error">Choose admin@ or postmaster@ to send the code to.</Notice>;
    default:
      return null;
  }
}

function verifyError(result: Result | null, view: DomainClaimView): string | undefined {
  if (!result?.r.startsWith("verify-")) return undefined;
  const left = MAX_ATTEMPTS - view.code.attempts;
  switch (result.r) {
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

// The tries left on the live code after a wrong one, said on every visit, not only after the guess.
function triesLeft(view: DomainClaimView): string {
  if (view.code.attempts === 0) return "";
  const left = MAX_ATTEMPTS - view.code.attempts;
  return ` ${left} ${left === 1 ? "try" : "tries"} left before this is locked for an hour.`;
}

function EmailCard(props: {
  view: DomainClaimView;
  org: string;
  result: Result | null;
  local: "admin" | "postmaster";
  now: Date;
}) {
  const { view, result, now } = props;
  const { lockedUntil, expiresAt, nextCodeAt } = view.code;
  const waiting = nextCodeAt && Date.parse(nextCodeAt) > now.getTime() ? nextCodeAt : null;
  const error = verifyError(result, view);
  return (
    <section aria-labelledby="code-heading" class={CARD}>
      <div class="flex flex-wrap items-center gap-12">
        <Pill variant="neutral">Option 2</Pill>
        <h2 id="code-heading" class="type-h3">
          Get a code by email
        </h2>
      </div>
      <p class="type-small text-muted">
        No access to DNS? We email a code to an address only the domain's owner should read.
      </p>
      {lockedUntil ? (
        <div class="flex flex-col gap-8 p-16 border border-line rounded-card bg-subtle">
          <Pill variant="neutral">Locked</Pill>
          <p class="text-14 weight-heading">Code entry is locked until {at(lockedUntil)}</p>
          <p class="type-small text-muted">
            Three wrong codes in a row. You can still verify with the DNS record at any time. Once the lock ends, send a
            new code: the old one will have expired.
          </p>
        </div>
      ) : (
        <>
          <form method="post" class="flex flex-col gap-12" data-busy>
            <input type="hidden" name="org" value={props.org} />
            <input type="hidden" name="action" value="send" />
            <fieldset class="flex flex-col gap-8">
              <legend class="text-14 weight-text-strong mb-8">Send the code to</legend>
              {(["admin", "postmaster"] as const).map((local) => (
                <label class="inline-flex items-center gap-12 min-h-24 font-mono text-14 wrap-anywhere">
                  <input
                    type="radio"
                    name="local"
                    value={local}
                    checked={local === props.local}
                    class="w-20 h-20 accent-orange"
                  />
                  {local}@{view.domain}
                </label>
              ))}
            </fieldset>
            <Button
              id="send-code"
              type="submit"
              variant="ghost"
              class="self-start"
              data-busy-label="Sending"
              disabled={waiting !== null}
              {...(waiting ? { disabledReason: `The next code can go at ${at(waiting)}.` } : {})}
            >
              Send code
            </Button>
            {sendNotice(result, view)}
          </form>
          {expiresAt ? (
            <form method="post" class="flex flex-col gap-12" data-busy>
              <input type="hidden" name="org" value={props.org} />
              <input type="hidden" name="action" value="verify" />
              <input type="hidden" name="local" value={props.local} />
              <Field
                id="claim-code"
                name="code"
                label="Code from the email"
                hint={`It works until ${at(expiresAt)}.${triesLeft(view)}`}
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
          ) : view.code.expired ? (
            <Notice tone="error">The code we sent has expired. Send a new one.</Notice>
          ) : (
            error && <Notice tone="error">{error}</Notice>
          )}
        </>
      )}
    </section>
  );
}

function VerifiedPanel(props: { view: DomainClaimView }) {
  const { view } = props;
  const how = view.method === "email" ? "Proved by a code to its mailbox" : "Checked by DNS";
  return (
    <section class={cx(CARD, "max-w-2xl")}>
      <Pill variant="safe">Verified</Pill>
      <h2 class="type-h3 wrap-anywhere">{view.domain} is verified</h2>
      <p class="type-small text-muted">
        Mail from this domain is now accepted at check@, and you can add it to your protected identity. {how}
        {view.verifiedAt ? ` at ${at(view.verifiedAt)}` : ""}.
      </p>
      <a href="/settings/domains" class={cx(LINK, "self-start")}>
        Back to Domains and addresses
      </a>
    </section>
  );
}

function generalNotice(result: Result | null, view: DomainClaimView, orgName: string) {
  if (!result) return null;
  if (result.r === "switched")
    return (
      <Notice tone="info">
        Your organisation changed in another tab, so nothing was done. This page is now for {orgName}.
      </Notice>
    );
  if (result.r === "check-taken" || result.r === "verify-taken")
    return (
      <Notice tone="error">{view.domain} is verified by another organisation, so it cannot be verified here.</Notice>
    );
  if (result.r === "unavailable" || result.r === "check-unavailable" || result.r === "verify-unavailable")
    return <Notice tone="error">That could not be done just now. Try again in a moment.</Notice>;
  // Said only of a claim that is verified: the page never contradicts what is stored.
  if ((result.r === "check-verified" || result.r === "verify-verified") && view.state === "verified")
    return <Notice tone="info">Done: {view.domain} is verified.</Notice>;
  return null;
}

type Shell = Omit<MemberShellProps, "children">;

export function DomainPage(props: {
  shell: Shell;
  view: DomainClaimView;
  result: Result | null;
  local?: "admin" | "postmaster";
  connect?: { state: "ready"; providerName: string; href: string } | { state: "unknown"; href: string } | null;
  now: Date;
}) {
  const { shell, view, result, now } = props;
  const org = shell.organization;
  return (
    <Document title={`Verify ${view.domain}`}>
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
                <span aria-hidden="true">/ </span>Verify {view.domain}
              </li>
            </ol>
          </nav>
          <header class="flex flex-wrap items-start justify-between gap-16">
            <div class="flex flex-col gap-8 min-w-0">
              <h1 class="type-h1 wrap-anywhere">Prove you own {view.domain}</h1>
              {view.state === "pending" && (
                <p class="text-muted">
                  Until you do, mail from this domain is not accepted at check@ for {org.name}. Choose one way.
                </p>
              )}
            </div>
            {view.state === "pending" ? (
              <Pill variant="suspicious">Pending</Pill>
            ) : (
              <Pill variant="safe">Verified</Pill>
            )}
          </header>
          {generalNotice(result, view, org.name)}
          {view.state === "pending" && props.connect?.state === "ready" && (
            <section aria-labelledby="connect-heading" class={CARD}>
              <div class="flex flex-wrap items-center gap-12">
                <Pill variant="neutral">Fastest</Pill>
                <h2 id="connect-heading" class="type-h3">
                  Connect with {props.connect.providerName}
                </h2>
              </div>
              <p class="type-small text-muted">
                Your registrar can add the record for you. You approve it there, and we check it when you come back: no
                record to copy.
              </p>
              <div>
                <Button href={props.connect.href} variant="dark">
                  Connect with {props.connect.providerName}
                </Button>
              </div>
            </section>
          )}
          {view.state === "pending" && props.connect?.state === "unknown" && (
            <Notice tone="info">
              We could not reach the registrar just now.{" "}
              <a href={props.connect.href} class={LINK}>
                Try again
              </a>
              , or use one of the ways below.
            </Notice>
          )}
          {view.state === "verified" ? (
            <VerifiedPanel view={view} />
          ) : (
            <div class="grid gap-24 lg:grid-cols-[3fr_2fr] items-start">
              <DnsCard view={view} org={org.id} result={result} local={props.local ?? "admin"} />
              <EmailCard view={view} org={org.id} result={result} local={props.local ?? "admin"} now={now} />
            </div>
          )}
        </div>
      </AppShell>
    </Document>
  );
}

// A domain the organisation has not claimed (or one removed meanwhile).
export function DomainNotFound(props: {
  shell: Shell;
  domain: string;
  switched: boolean;
  reference: string;
  now: Date;
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
            title="That domain is not claimed here."
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
            {props.shell.organization.name} has no claim on {props.domain}, or it was removed. Claim it again from
            Domains and addresses.
          </ErrorState>
        </div>
      </AppShell>
    </Document>
  );
}

// A member who is not an owner or admin (a Deviation in design/SPEC.md E3: the board draws only the not-a-member case).
export function DomainRoleRefusal(props: { orgName: string; reference: string; now: Date }) {
  return (
    <Document title="No access">
      <main id="content" class="min-h-screen p-16 md:px-56 md:py-40 bg-subtle">
        <ErrorState
          code={403}
          title="Only an owner or admin verifies domains."
          actions={[
            <Button variant="dark" href="/cases">
              Go to your cases
            </Button>,
          ]}
          footer={referenceLine(props.reference, props.now)}
        >
          An owner or admin of {props.orgName} verifies its domains. Ask one of them to do it.
        </ErrorState>
      </main>
    </Document>
  );
}
