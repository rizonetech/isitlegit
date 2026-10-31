// The protected identity page (D05 T01 §3; design/SPEC.md M5, board `Protect`): an owner or admin tells IsItLegit who
// the business really is (names, domains, logo, finance contact, bank accounts, the Protected switch) and a member
// reads it. Every part is drawn from what is stored, so a reload shows what an action did, and what an action just did
// comes back in a signed address (./identity.tsx). The board's signature badge, website seal, alerts table and public
// verify link belong to D05 T02 and are not drawn (design/SPEC.md M5 deviations).
import { normaliseName } from "../../trust/names";
import { MOTION } from "../assets";
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Checkbox } from "../components/Checkbox";
import { Document } from "../components/Document";
import { Field } from "../components/Field";
import { Pill } from "../components/Pill";
import { ErrorState, referenceLine } from "../components/States";

type Shell = Omit<MemberShellProps, "children">;

// What an action just did, as the redirect carries it.
export const RESULTS = [
  "saved",
  "logo-saved",
  "logo-removed",
  "account-added",
  "account-removed",
  "account-gone",
  "unavailable",
  "switched",
] as const;
export type Result = (typeof RESULTS)[number];

// What the page reads of the stored identity, bank accounts and domains: the trust store's own types satisfy these.
export type Identity = {
  // The revision the page was drawn from: each form that changes the identity or logo carries it back.
  version: number;
  displayNames: string[];
  financeContact: string | null;
  logo: { key: string } | null;
  protected: boolean;
  effective: { on: true } | { on: false; reason: string };
};
export type MaskedAccount = { id: string; bankName: string; branchCode: string; holder: string; masked: string };
export type OrgDomain = { domain: string; state: "verified" | "pending" };

export type AccountFormValues = { bankName: string; branchCode: string; holder: string };
// What a refused save sent back, drawn again. `version` is the revision its form was drawn from, kept through a refusal
// that is not a conflict, so correcting a typo cannot carry an old form past another tab's change (round 1).
export type Typed = { tradingNames: string; contact: string; protected: boolean; version?: string };
// Each refusal sits on the field it is about; `general` is for a refusal about the whole save.
export type Errors = {
  names?: string;
  contact?: string;
  protection?: string;
  general?: string;
  logo?: string;
  account?: { bankName?: string; branchCode?: string; number?: string; holder?: string; general?: string };
};

export type IdentityView = {
  shell: Shell;
  canEdit: boolean;
  identity: Identity | null;
  domains: OrgDomain[];
  addresses: string[];
  since: string | null;
  accounts: MaskedAccount[];
  bankAvailable: boolean;
  typed?: Typed;
  account?: AccountFormValues;
  errors?: Errors;
  result?: Result | null;
  confirm?: MaskedAccount | null;
};

// The words for a change refused because the identity moved on since the page was drawn, and for a failure whose
// outcome is not known (the write may have committed before it).
export const STALE_WORDS =
  "This page changed in another tab or by someone else. Here is what is stored now; your typed values are kept.";
export const UNCERTAIN_WORDS =
  "We could not confirm that your change was saved. Reload the page to see what is stored, then try again if needed.";

const LINK = cx("text-orange-text underline underline-offset-4", FOCUS);
const CARD = "flex flex-col gap-16 p-24 bg-surface border border-line rounded-card-large min-w-0";
const day = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  day: "numeric",
  month: "short",
  year: "numeric",
});

// A notice takes focus when the page opens (the app script, `data-announce`), so what happened is read out after a
// redirect or a refusal drawn in place.
function Notice(props: { tone: "info" | "error"; id?: string; announce?: boolean; children: unknown }) {
  const announce = props.announce ?? props.tone === "error";
  return (
    <p
      id={props.id}
      role={props.tone === "error" ? "alert" : "status"}
      {...(announce ? { tabindex: -1, "data-announce": "" } : {})}
      class={cx("type-small wrap-anywhere", props.tone === "error" ? "text-mal weight-text-strong" : "text-ink")}
    >
      {props.children as never}
    </p>
  );
}

const RESULT_WORDS: Record<Result, { tone: "info" | "error"; words: string }> = {
  saved: { tone: "info", words: "Your identity is saved." },
  "logo-saved": { tone: "info", words: "Your logo is saved." },
  "logo-removed": { tone: "info", words: "Your logo is removed." },
  "account-added": { tone: "info", words: "The account is added." },
  "account-removed": { tone: "info", words: "The account is removed, and the removal is logged." },
  "account-gone": { tone: "info", words: "That account was already removed. Nothing else changed." },
  unavailable: { tone: "error", words: UNCERTAIN_WORDS },
  switched: { tone: "info", words: "" },
};

// The registered name is the organisation's own; the trading names are the other stored names.
export function tradingNamesOf(identity: Identity | null, registered: string): string[] {
  const own = normaliseName(registered);
  return (identity?.displayNames ?? []).filter((n) => normaliseName(n) !== own);
}

// Why protection is paused while the switch is on, with where to put it right.
function pausedBecause(view: IdentityView): { words: string; fix: { href: string; text: string } } {
  const { identity, domains, addresses } = view;
  const pending = domains.find((d) => d.state === "pending");
  if (!domains.some((d) => d.state === "verified"))
    return {
      words: "none of your domains is verified.",
      fix: pending
        ? { href: `/settings/domains/${encodeURIComponent(pending.domain)}`, text: `Verify ${pending.domain}` }
        : { href: "/settings/domains", text: "Add and verify a domain" },
    };
  if (!identity?.financeContact)
    return {
      words: "no finance contact is chosen.",
      fix: { href: "#finance-contact", text: "Choose a finance contact" },
    };
  if (!addresses.includes(identity.financeContact))
    return {
      words: `${identity.financeContact} is no longer a verified address.`,
      fix: { href: "/settings/domains", text: "Verify a sending address" },
    };
  return { words: "a requirement is no longer met.", fix: { href: "/settings/domains", text: "Check your domains" } };
}

function Header(props: { view: IdentityView; typedProtected: boolean }) {
  const { view } = props;
  const { identity, canEdit, since } = view;
  const org = view.shell.organization.name;
  const on = identity?.effective.on === true;
  const paused = identity?.protected === true && !on;
  const tone = on ? "bg-safe-band text-on-band" : paused ? "bg-sus-band text-on-band" : "bg-subtle text-ink";
  const fix = paused ? pausedBecause(view) : null;
  // The board's band: the identity-status mark on the white tile (the art is made for white, as the verdict band's),
  // the eyebrow, the headline and the switch, on the band colour of the state.
  const mark = on ? MOTION.safe : paused ? MOTION.suspicious : null;
  return (
    <>
      <header class="flex flex-col gap-8">
        <h1 class="type-h1 wrap-anywhere">Protect {org}</h1>
        <p class="text-muted">Tell us who you really are, so mail pretending to be you gets caught.</p>
      </header>
      <section
        aria-label="Protection status"
        class={cx(
          "flex flex-wrap items-center justify-between gap-16 p-24 rounded-card-large",
          tone,
          // The orange ring is unreadable on the band colours (about 1.2:1 on the safe band), so a control on a band
          // takes a white one (about 5:1 or more on both).
          mark ? "[&_input:focus-visible]:outline-on-band" : "border border-line",
        )}
      >
        {mark && (
          <div class="flex shrink-0 items-center justify-center w-56 h-56 rounded-card-large bg-on-band md:w-88 md:h-88">
            <img src={mark} alt="" class="w-40 h-40 md:w-72 md:h-72" />
          </div>
        )}
        <div class="flex flex-col gap-4 min-w-0 flex-1">
          {on ? (
            <>
              <p class="type-eyebrow">Protected{since ? ` since ${day.format(Date.parse(since))}` : ""}</p>
              <h2 class="font-heading weight-heading text-24 wrap-anywhere">
                Anyone can now check mail that claims to be {org}.
              </h2>
            </>
          ) : paused && fix ? (
            <>
              <p class="type-eyebrow">Protection is paused</p>
              <h2 class="font-heading weight-heading text-24 wrap-anywhere">
                Mail that claims to be {org} is not being checked, because {fix.words}
              </h2>
              <a
                href={fix.fix.href}
                class="self-start type-small underline underline-offset-4 text-on-band focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-band"
              >
                {fix.fix.text}
              </a>
            </>
          ) : (
            <>
              <p class="type-eyebrow text-muted">Not protected</p>
              <h2 class="type-h3 wrap-anywhere">
                {identity
                  ? `Mail that claims to be ${org} is not being checked.`
                  : "Register your identity below to start protecting your name."}
              </h2>
            </>
          )}
        </div>
        {canEdit && (
          <Checkbox
            name="protected"
            form="identity-form"
            checked={props.typedProtected}
            {...(view.errors?.protection ? { "aria-describedby": "protected-error" } : {})}
          >
            Protected
          </Checkbox>
        )}
      </section>
      {view.errors?.protection && (
        <Notice tone="error" id="protected-error">
          {view.errors.protection}
        </Notice>
      )}
    </>
  );
}

function NamesCard(props: { view: IdentityView; typed: Typed }) {
  const { view } = props;
  const registered = view.shell.organization.name;
  const trading = tradingNamesOf(view.identity, registered);
  return (
    <section aria-labelledby="names-heading" class={CARD}>
      <h2 id="names-heading" class="type-h3">
        Names
      </h2>
      <dl class="flex flex-col gap-4">
        <dt class="text-14 weight-text-strong">Registered name</dt>
        <dd class="wrap-anywhere">{registered}</dd>
        <dd class="text-13 text-muted">
          This is your organisation's name.{" "}
          {view.identity?.effective.on ? "It is protected." : "It will be protected once protection is on."}
        </dd>
      </dl>
      {view.canEdit ? (
        <Field
          id="trading-names"
          name="tradingNames"
          label="Trading names"
          form="identity-form"
          value={props.typed.tradingNames}
          hint="Every name a scammer might use for you. One name per line."
          rows={4}
          maxlength={2000}
          autocomplete="off"
          {...(view.errors?.names ? { error: view.errors.names } : {})}
        />
      ) : (
        <div class="flex flex-col gap-4">
          <p class="text-14 weight-text-strong">Trading names</p>
          {trading.length ? (
            <ul class="flex flex-col gap-4">
              {trading.map((n) => (
                <li class="wrap-anywhere">{n}</li>
              ))}
            </ul>
          ) : (
            <p>None</p>
          )}
        </div>
      )}
    </section>
  );
}

function DomainsCard(props: { view: IdentityView }) {
  const { view } = props;
  return (
    <section aria-labelledby="domains-heading" class={CARD}>
      <div class="flex flex-wrap items-center justify-between gap-12">
        <h2 id="domains-heading" class="type-h3">
          Domains
        </h2>
        {view.canEdit && (
          <a href="/settings/domains" class={cx(LINK, "type-small")}>
            Manage domains
          </a>
        )}
      </div>
      {view.domains.length === 0 ? (
        <p class="text-muted">
          No domains yet. {view.canEdit ? "Add and verify one under Manage domains." : "An owner or admin adds them."}
        </p>
      ) : (
        <ul class="flex flex-col gap-8">
          {view.domains.map((d) => (
            <li
              class={cx(
                "flex flex-wrap items-center justify-between gap-12 px-16 py-12 rounded-card",
                d.state === "verified" ? "bg-safe-wash" : "bg-subtle",
              )}
            >
              {d.state === "pending" && view.canEdit ? (
                <a
                  href={`/settings/domains/${encodeURIComponent(d.domain)}`}
                  class={cx("font-mono text-14 weight-text-strong wrap-anywhere text-orange-text underline", FOCUS)}
                >
                  {d.domain}
                </a>
              ) : (
                <span class="font-mono text-14 weight-text-strong wrap-anywhere">{d.domain}</span>
              )}
              <Pill variant={d.state === "verified" ? "safe" : "suspicious"}>
                {d.state === "verified" ? "Verified" : "Pending"}
              </Pill>
            </li>
          ))}
        </ul>
      )}
      <p class="text-13 text-muted">
        Only verified domains count as you. Mail from anywhere else that claims your name is flagged.
      </p>
    </section>
  );
}

function LogoCard(props: { view: IdentityView }) {
  const { view } = props;
  const { identity, canEdit } = view;
  const logo = identity?.logo ?? null;
  return (
    <section aria-labelledby="logo-heading" class={CARD}>
      <h2 id="logo-heading" class="type-h3">
        Logo
      </h2>
      <div class="flex flex-wrap items-center gap-16">
        <div class="flex items-center justify-center w-120 h-88 border border-line rounded-card bg-surface overflow-hidden">
          {logo ? (
            <img
              src={`/protect/logo?v=${encodeURIComponent(logo.key.split("/").pop() ?? "")}`}
              alt={`The ${view.shell.organization.name} logo`}
              class="max-w-full max-h-full"
              data-fallback="logo-failed"
            />
          ) : (
            <span class="text-13 text-muted">No logo yet</span>
          )}
        </div>
        <p class="text-13 text-muted min-w-0 flex-1">
          PNG or SVG, up to 2 MiB. SAM 3.1 compares logos in mail with this one.
        </p>
      </div>
      {logo && (
        <p id="logo-failed" role="alert" hidden class="type-small text-mal weight-text-strong">
          Your logo could not be shown just now.{" "}
          <a href="/protect" class={LINK}>
            Reload
          </a>
        </p>
      )}
      {canEdit && (
        <>
          <form
            method="post"
            enctype="multipart/form-data"
            class="flex flex-col gap-12"
            data-busy
            data-unsaved-guard="the logo form"
          >
            <input type="hidden" name="org" value={view.shell.organization.id} />
            <input type="hidden" name="action" value="logo" />
            <input type="hidden" name="version" value={String(identity?.version ?? 0)} />
            <div class="flex flex-col gap-8">
              <label for="logo-file" class="text-14 weight-text-strong">
                Logo file
              </label>
              <input
                id="logo-file"
                type="file"
                name="logo"
                accept="image/png,image/svg+xml"
                disabled={!identity}
                {...(!identity ? { "aria-describedby": "logo-upload-reason" } : {})}
                {...(view.errors?.logo ? { "aria-invalid": "true", "aria-describedby": "logo-error" } : {})}
                class={cx("text-14 max-w-full", FOCUS)}
              />
            </div>
            {view.errors?.logo && (
              <Notice tone="error" id="logo-error">
                {view.errors.logo}
              </Notice>
            )}
            {identity ? (
              <Button type="submit" variant="ghost" size="small" class="self-start" data-busy-label="Uploading">
                {logo ? "Replace logo" : "Add logo"}
              </Button>
            ) : (
              <Button
                id="logo-upload"
                type="submit"
                variant="ghost"
                size="small"
                class="self-start"
                disabled
                disabledReason="Save your identity first, then add your logo"
              >
                Add logo
              </Button>
            )}
          </form>
          {logo && (
            <form method="post" data-busy>
              <input type="hidden" name="org" value={view.shell.organization.id} />
              <input type="hidden" name="action" value="remove-logo" />
              <input type="hidden" name="version" value={String(identity?.version ?? 0)} />
              <Button type="submit" variant="danger" size="small" data-busy-label="Removing">
                Remove logo
              </Button>
            </form>
          )}
        </>
      )}
    </section>
  );
}

function ContactCard(props: { view: IdentityView; typed: Typed }) {
  const { view, typed } = props;
  const stored = view.identity?.financeContact ?? null;
  // The saved contact stays a choice even when its verification has lapsed, so saving something else never clears it.
  const options = [...new Set([...view.addresses, ...(stored ? [stored] : [])])];
  return (
    <section aria-labelledby="contact-heading" id="finance-contact" class={CARD}>
      <h2 id="contact-heading" class="type-h3">
        Finance contact
      </h2>
      {view.canEdit ? (
        <form
          id="identity-form"
          method="post"
          class="flex flex-col gap-16"
          data-busy
          data-unsaved-guard="the identity details"
          {...(view.typed ? { "data-unsaved-retained": "" } : {})}
        >
          <input type="hidden" name="org" value={view.shell.organization.id} />
          <input type="hidden" name="action" value="save" />
          <input type="hidden" name="version" value={view.typed?.version ?? String(view.identity?.version ?? 0)} />
          {options.length === 0 ? (
            <p class="text-muted">
              No verified sending address yet. Verify a sending address first, then choose it here.{" "}
              <a href="/settings/domains" class={LINK}>
                Manage domains
              </a>
            </p>
          ) : (
            <fieldset
              class="flex flex-col gap-8"
              {...(view.errors?.contact ? { "aria-describedby": "contact-error" } : {})}
            >
              <legend class="text-14 weight-text-strong mb-8">Email</legend>
              <label class="inline-flex items-center gap-12 min-h-24 text-14">
                <input
                  type="radio"
                  name="contact"
                  id="contact-none"
                  value=""
                  checked={typed.contact === ""}
                  class={cx("w-20 h-20 accent-orange", FOCUS)}
                />
                No finance contact
              </label>
              {options.map((address, i) => (
                <label class="inline-flex items-center gap-12 min-h-24 font-mono text-14 wrap-anywhere">
                  <input
                    type="radio"
                    name="contact"
                    id={`contact-${i}`}
                    value={address}
                    checked={address === typed.contact}
                    class={cx("w-20 h-20 accent-orange", FOCUS)}
                  />
                  {address}
                  {view.addresses.includes(address) ? "" : " (not verified)"}
                </label>
              ))}
            </fieldset>
          )}
          {view.errors?.contact && (
            <Notice tone="error" id="contact-error">
              {view.errors.contact}
            </Notice>
          )}
          <p class="text-13 text-muted">
            When a customer's invoice check finds different bank details, we ask this address to confirm.
          </p>
          {view.errors?.general && <Notice tone="error">{view.errors.general}</Notice>}
          <Button type="submit" variant="primary" class="self-start" data-busy-label="Saving">
            Save identity
          </Button>
        </form>
      ) : (
        <p class="font-mono text-14 wrap-anywhere">{stored ?? "No finance contact yet"}</p>
      )}
      {!view.canEdit && (
        <p class="text-13 text-muted">
          When a customer's invoice check finds different bank details, we ask this address to confirm.
        </p>
      )}
    </section>
  );
}

function RemoveAccount(props: { view: IdentityView; account: MaskedAccount }) {
  const { view, account } = props;
  return (
    <form method="post" data-busy>
      <input type="hidden" name="org" value={view.shell.organization.id} />
      <input type="hidden" name="action" value="remove-account" />
      <input type="hidden" name="accountId" value={account.id} />
      <Button
        type="submit"
        variant="danger"
        size="small"
        aria-label={`Remove the ${account.bankName} account ending ${account.masked.slice(-3)}`}
        data-busy-label="Opening"
      >
        Remove
      </Button>
    </form>
  );
}

function AccountsCard(props: { view: IdentityView }) {
  const { view } = props;
  const form = view.errors?.account ?? {};
  const values = view.account ?? { bankName: "", branchCode: "", holder: "" };
  return (
    <section aria-labelledby="bank-heading" class={CARD}>
      <h2 id="bank-heading" class="type-h3">
        Bank accounts
      </h2>
      <div class="grid gap-24 lg:grid-cols-[1.7fr_1fr] items-start">
        <div class="flex flex-col gap-16 min-w-0">
          {view.accounts.length === 0 ? (
            <p class="text-muted">No bank accounts yet. Add the accounts your customers pay into.</p>
          ) : (
            <>
              <ul class="flex flex-col gap-12 md:hidden">
                {view.accounts.map((a) => (
                  <li class="flex flex-col gap-8 p-16 border border-line rounded-card">
                    <p class="type-small wrap-anywhere">
                      {a.bankName} · {a.branchCode}
                    </p>
                    <p class="font-mono wrap-anywhere">•••• {a.masked.slice(-3)}</p>
                    <p class="type-small text-muted wrap-anywhere">{a.holder}</p>
                    {view.canEdit && <RemoveAccount view={view} account={a} />}
                  </li>
                ))}
              </ul>
              <table class="hidden md:table w-full text-left border-collapse border border-line">
                <caption class="sr-only">Registered bank accounts</caption>
                <thead>
                  <tr class="bg-subtle">
                    <th scope="col" class="px-16 py-12 weight-text-strong">
                      Bank
                    </th>
                    <th scope="col" class="px-16 py-12 weight-text-strong">
                      Account
                    </th>
                    <th scope="col" class="px-16 py-12 weight-text-strong">
                      Use
                    </th>
                    <th scope="col" class="px-16 py-12">
                      <span class="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.accounts.map((a) => (
                    <tr class="border-t border-line align-top">
                      <td class="px-16 py-12 type-small wrap-anywhere">
                        {a.bankName} · {a.branchCode}
                      </td>
                      <td class="px-16 py-12 font-mono wrap-anywhere">•••• {a.masked.slice(-3)}</td>
                      <td class="px-16 py-12 type-small wrap-anywhere">{a.holder}</td>
                      <td class="px-16 py-12">{view.canEdit && <RemoveAccount view={view} account={a} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {view.canEdit &&
            (view.bankAvailable ? (
              <form
                method="post"
                class="flex flex-col gap-16"
                data-busy
                data-unsaved-guard="the new bank account"
                {...(view.account ? { "data-unsaved-retained": "" } : {})}
                aria-label="Add a bank account"
              >
                <input type="hidden" name="org" value={view.shell.organization.id} />
                <input type="hidden" name="action" value="add-account" />
                <div class="grid gap-16 md:grid-cols-2">
                  <Field
                    id="account-bank"
                    name="bankName"
                    label="Bank"
                    value={values.bankName}
                    maxlength={120}
                    required
                    {...(form.bankName ? { error: form.bankName } : {})}
                  />
                  <Field
                    id="account-branch"
                    name="branchCode"
                    label="Branch code"
                    value={values.branchCode}
                    inputmode="numeric"
                    autocomplete="off"
                    maxlength={12}
                    required
                    {...(form.branchCode ? { error: form.branchCode } : {})}
                  />
                  <Field
                    id="account-number"
                    name="accountNumber"
                    label="Account number"
                    hint="7 to 11 digits. Only its last three digits are ever shown."
                    inputmode="numeric"
                    autocomplete="off"
                    maxlength={24}
                    required
                    {...(form.number ? { error: form.number } : {})}
                  />
                  <Field
                    id="account-holder"
                    name="holder"
                    label="Account holder"
                    value={values.holder}
                    maxlength={120}
                    required
                    {...(form.holder ? { error: form.holder } : {})}
                  />
                </div>
                {form.general && <Notice tone="error">{form.general}</Notice>}
                <Button type="submit" variant="ghost" size="small" class="self-start" data-busy-label="Adding">
                  Add account
                </Button>
              </form>
            ) : (
              <Notice tone="info">
                Bank accounts are unavailable just now, so none can be added. The rest of this page still works.
              </Notice>
            ))}
        </div>
        <div class="flex flex-col gap-8 p-16 bg-subtle border border-line rounded-card">
          <p class="type-small">
            <strong>
              We never show your account number to anyone checking a payment. They only see whether it matches.
            </strong>{" "}
            Removing an account asks you to confirm and is logged.
          </p>
        </div>
      </div>
    </section>
  );
}

function ConfirmRemoval(props: { view: IdentityView; account: MaskedAccount }) {
  const { account, view } = props;
  const last = account.masked.slice(-3);
  return (
    <section aria-labelledby="confirm-heading" class={cx(CARD, "border-mal")}>
      <h2 id="confirm-heading" class="type-h3" tabindex={-1} data-announce="">
        Remove the account ending {last}?
      </h2>
      <p class="text-muted wrap-anywhere">
        {account.bankName} · {account.branchCode}, held by {account.holder}. Once it is removed, a payment to it no
        longer matches your identity. The removal is logged.
      </p>
      <div class="flex flex-wrap items-center gap-12">
        <form method="post" data-busy>
          <input type="hidden" name="org" value={view.shell.organization.id} />
          <input type="hidden" name="action" value="confirm-remove-account" />
          <input type="hidden" name="accountId" value={account.id} />
          <Button type="submit" variant="danger" data-busy-label="Removing">
            Confirm removal
          </Button>
        </form>
        <Button variant="ghost" href="/protect">
          Cancel
        </Button>
      </div>
    </section>
  );
}

export function IdentityPage(props: IdentityView) {
  const view = props;
  const registered = view.shell.organization.name;
  const typed: Typed = view.typed ?? {
    tradingNames: tradingNamesOf(view.identity, registered).join("\n"),
    contact: view.identity?.financeContact ?? "",
    protected: view.identity?.protected ?? false,
  };
  const result = view.result ? RESULT_WORDS[view.result] : null;
  return (
    <Document title={`Protect ${registered}`}>
      <AppShell {...view.shell}>
        <div class="flex flex-col gap-24 px-16 py-24 md:px-56 md:py-40" data-announce-scope>
          {view.result === "switched" ? (
            <Notice tone="info" announce>
              Your organisation changed in another tab, so nothing was done. This page is now for {registered}.
            </Notice>
          ) : (
            result && (
              <Notice tone={result.tone} announce>
                {result.words}
              </Notice>
            )
          )}
          <Header view={view} typedProtected={typed.protected} />
          {view.confirm && view.canEdit && <ConfirmRemoval view={view} account={view.confirm} />}
          <div class="grid gap-24 md:grid-cols-2 items-start">
            <NamesCard view={view} typed={typed} />
            <DomainsCard view={view} />
            <LogoCard view={view} />
            <ContactCard view={view} typed={typed} />
          </div>
          <AccountsCard view={view} />
          <p class="type-tiny text-muted">Members can view this page; owners and admins can change it.</p>
        </div>
      </AppShell>
    </Document>
  );
}

// The organisation's plan does not include a protected identity (free or lapsed trial).
export function IdentityPlanRefusal(props: { shell: Shell; reference: string; now: Date }) {
  return (
    <Document title="Protected identity">
      <AppShell {...props.shell}>
        <div class="px-16 py-24 md:px-56 md:py-40">
          <ErrorState
            code={403}
            title="A protected identity is part of the Protect plan."
            actions={[
              <Button variant="dark" href="/settings/plan?from=/protect">
                See plans
              </Button>,
              <Button variant="ghost" href="/cases">
                Go to your cases
              </Button>,
            ]}
            footer={referenceLine(props.reference, props.now)}
          >
            {props.shell.organization.name} is on a plan without it, so nothing here can be seen or changed. Your checks
            and cases are not affected.
          </ErrorState>
        </div>
      </AppShell>
    </Document>
  );
}

// A member who is not an owner or admin tries to change the identity.
export function IdentityRoleRefusal(props: { shell: Shell; reference: string; now: Date }) {
  return (
    <Document title="No access">
      <AppShell {...props.shell}>
        <div class="px-16 py-24 md:px-56 md:py-40">
          <ErrorState
            code={403}
            title="Only an owner or admin changes your identity."
            actions={[
              <Button variant="dark" href="/protect">
                View the page
              </Button>,
            ]}
            footer={referenceLine(props.reference, props.now)}
          >
            Members can view this page. Ask an owner or admin of {props.shell.organization.name} to make the change.
          </ErrorState>
        </div>
      </AppShell>
    </Document>
  );
}
