import type { Child } from "hono/jsx";
import { LOGO, LOGO_MARK, LOGO_MARK_ON_DARK, LOGO_ON_DARK } from "../assets";
import { cx, FOCUS, FOCUS_ON_DARK } from "./attrs";
import { Button } from "./Button";
import {
  CasesIcon,
  ChevronIcon,
  CopyIcon,
  MenuIcon,
  MonitorIcon,
  PlusIcon,
  ProtectIcon,
  SuppliersIcon,
  TeamIcon,
} from "./icons";
import { Pill } from "./Pill";

// The one page frame every app page renders inside (D07 T01 §3; AGENTS.md: a second toolbar or panel shape is a
// defect), once per document: it owns the ids `nav` and `content`, the `main` landmark and the Menu's popover target, in three variants as the approved boards draw them: the member app with the P1 navigation (`AppNav`), the
// admin console with the P2 navigation (`AdminNav`), and the public frame of a report opened from a signed link
// (`Report-Counterparty`). Below `md` the member and admin sidebars become a popover behind the phone header's Menu
// button (`Report-Mobile`), which opens and closes with no script. A browser without the Popover API (before Chrome
// 114, Safari 17, Firefox 125) gets no Menu below `md`: the sidebar is a full-width block in the page above the content.

export const CHECK_ADDRESS = "check@isitlegit.co.za";

export type MemberPage = "cases" | "suppliers" | "protect" | "monitor" | "team" | "domains" | "account" | "plan";
export type AdminPage = "overview" | "orgs" | "invites" | "feedback" | "eval";

export type Organization = { id: string; name: string };

export type MemberShellProps = {
  variant: "member";
  // The highlighted link; Check a file and onboarding pages pass "cases" (SPEC P1 States).
  active: MemberPage;
  organization: Organization;
  // The member's other organisations; empty for a member of one, who sees a plain label instead of a switcher.
  otherOrganizations: Organization[];
  // New Monitor findings; the pill disappears at zero.
  monitorNew: number;
  // Trial days left while a trial runs, else the plan's name.
  plan: { trialDaysLeft: number } | { name: string };
  user: { name: string; role: string };
  children: Child;
};

export type AdminShellProps = {
  variant: "admin";
  active: AdminPage;
  // Open feedback; the count pill disappears at zero.
  feedbackOpen: number;
  // The operator Cloudflare Access signed in; Access owns the session, so there is no sign-out here.
  operator: string;
  children: Child;
};

// `note` is the header's line beside the brand: the report's link-expiry wording by default, or the verify page's
// origin line (D05 T02 §6), which is a permanent page and has no expiry.
export type PublicShellProps = { variant: "public"; note?: string; children: Child };

export type AppShellProps = MemberShellProps | AdminShellProps | PublicShellProps;

// "Thandi Nkosi" to "TN", "Karoo Couriers" to "KC": the first letters of the first two words.
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

export function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      // The first character as a reader sees it (an emoji, an accented letter written in two code points), not one
      // UTF-16 unit, which would split a surrogate pair.
      .map((word) => GRAPHEMES.segment(word)[Symbol.iterator]().next().value?.segment.toUpperCase() ?? "")
      .join("")
  );
}

const SKIP =
  // Shown at the top right when focused: an open popover sidebar (top layer, above any z-index) covers the left edge.
  "sr-only focus:not-sr-only focus:fixed focus:top-8 focus:right-8 focus:z-50 focus:px-16 focus:py-12 focus:bg-surface focus:text-ink focus:rounded-control focus:shadow-card " +
  FOCUS;
// The sidebar: fixed to the left edge at every width, a popover below `md` (the browser hides a closed popover; `open:`
// matches `:popover-open`) and always shown from `md`, where the content keeps a sidebar-wide margin. It is placed the
// same way open or closed, so a menu left open while the window widens past `md` (the top layer cannot be put back in
// the page by CSS) still sits beside the content, and its backdrop turns clear.
const SIDEBAR =
  "open:flex md:flex flex-col w-sidebar box-border px-16 py-24 m-0 fixed inset-y-0 left-0 h-full overflow-y-auto border-0 backdrop:bg-ink/40 md:backdrop:bg-transparent " +
  // Without the Popover API (no `:popover-open`), below `md`: a full-width block in the page, as the page flows.
  "max-md:not-supports-[selector(:popover-open)]:flex max-md:not-supports-[selector(:popover-open)]:static max-md:not-supports-[selector(:popover-open)]:w-full max-md:not-supports-[selector(:popover-open)]:h-auto";
const MEMBER_LINK =
  "flex items-center gap-12 h-40 px-12 rounded-control-small text-15 weight-text-strong no-underline text-ink-2 hover:bg-light hover:text-ink aria-[current=page]:bg-light aria-[current=page]:text-ink";
const ADMIN_LINK =
  "flex items-center gap-12 h-40 px-12 rounded-control-small text-15 weight-text-strong no-underline text-on-dark-muted hover:bg-dark-raised hover:text-on-dark aria-[current=page]:bg-dark-active aria-[current=page]:text-on-dark";

// The brand artwork for the theme: the dark logo or mark on a light surface, its on-dark version on a dark one (the
// theme follows the system or `data-theme`, so both are in the page and the `dark:` variant shows one).
function Brand(props: { light: string; dark: string; alt: string; class: string }) {
  return (
    <>
      <img src={props.light} alt={props.alt} class={cx("block dark:hidden", props.class)} />
      <img src={props.dark} alt={props.alt} class={cx("hidden dark:block", props.class)} />
    </>
  );
}

function NavLink(props: { href: string; current: boolean; dark?: boolean; children: Child }) {
  return (
    <a
      href={props.href}
      aria-current={props.current ? "page" : undefined}
      class={cx(props.dark ? ADMIN_LINK : MEMBER_LINK, props.dark ? FOCUS_ON_DARK : FOCUS)}
    >
      {props.children}
    </a>
  );
}

// The phone header (`Report-Mobile`): the mark in the middle and Menu on the right; the left cell is the report page's
// back link (D07 T03 §1).
function PhoneHeader(props: { home: string; homeLabel: string }) {
  return (
    <header class="md:hidden print:hidden grid grid-cols-3 items-center h-56 px-16 border-b border-line bg-surface">
      <a href={props.home} class={cx("col-start-2 justify-self-center rounded-small", FOCUS)}>
        <Brand light={LOGO_MARK} dark={LOGO_MARK_ON_DARK} alt={props.homeLabel} class="w-32 h-32" />
      </a>
      <Button
        size="small-icon"
        popovertarget="nav"
        label="Menu"
        icon={<MenuIcon />}
        class="justify-self-end not-supports-[selector(:popover-open)]:hidden"
      />
    </header>
  );
}

// A name from the data (an organisation, a person) truncates on one line inside the 256 px sidebar, with its full text on title.
const NAME = "min-w-0 truncate";
// An organisation to switch to: a row like the navigation links that keeps one line with its full name on title.
const OPTION =
  "flex items-center gap-12 w-full min-h-40 px-12 py-8 rounded-control-small border-0 bg-transparent text-left text-15 weight-text-strong text-ink-2 cursor-pointer hover:bg-light hover:text-ink";

function OrgBadge(props: { name: string }) {
  return (
    <span class="inline-flex shrink-0 items-center justify-center w-24 h-24 rounded-small bg-dark text-on-dark text-12 weight-heading">
      {initials(props.name)}
    </span>
  );
}

function OrgSwitcher(props: { organization: Organization; others: Organization[] }) {
  const { organization, others } = props;
  if (!others.length)
    return (
      <p class="flex items-center gap-12 min-h-48 px-12 py-8 text-15 weight-text-strong text-ink">
        <OrgBadge name={organization.name} />
        {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: Hono JSX uses lowercase tabindex on inline reveal span inside <p> */}
        <span
          tabindex={0}
          role="button"
          aria-expanded="false"
          data-org-reveal
          class={cx(
            NAME,
            "rounded-small cursor-pointer [&[aria-expanded=true]]:whitespace-normal [&[aria-expanded=true]]:overflow-visible [&[aria-expanded=true]]:text-clip [&[aria-expanded=true]]:wrap-anywhere",
            FOCUS,
          )}
          title={organization.name}
        >
          {organization.name}
        </span>
      </p>
    );
  return (
    <details class="relative">
      <summary
        aria-label={`Switch organisation, current ${organization.name}`}
        class={cx(
          "flex items-center justify-between gap-8 min-h-48 px-12 py-8 list-none rounded-control border border-line-strong bg-surface text-15 weight-text-strong text-ink cursor-pointer hover:border-ink [&::-webkit-details-marker]:hidden",
          FOCUS,
        )}
      >
        <span class="flex items-center gap-12 min-w-0">
          <OrgBadge name={organization.name} />
          <span class={NAME} title={organization.name}>
            {organization.name}
          </span>
        </span>
        <ChevronIcon class="text-muted" />
      </summary>
      <ul class="mt-4 p-4 flex flex-col gap-2 bg-surface border border-line rounded-control shadow-card list-none">
        <li class="px-12 py-8 border-b border-line text-13 text-muted wrap-anywhere" data-full-org-name>
          {organization.name}
        </li>
        {others.map((org) => (
          <li class="flex flex-col gap-2">
            <form method="post" action="/orgs/switch">
              <input type="hidden" name="organizationId" value={org.id} />
              <button type="submit" class={cx(OPTION, FOCUS)}>
                <OrgBadge name={org.name} />
                <span class={NAME} title={org.name}>
                  {org.name}
                </span>
              </button>
            </form>
            <span class="px-12 pb-4 text-12 text-muted wrap-anywhere" data-full-alt-org-name>
              {org.name}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function MemberNav(props: MemberShellProps) {
  const { active, monitorNew, plan, user } = props;
  const planWords =
    "trialDaysLeft" in plan ? `Trial, ${plan.trialDaysLeft} ${plan.trialDaysLeft === 1 ? "day" : "days"}` : plan.name;
  return (
    <nav
      id="nav"
      popover="auto"
      aria-label="Main"
      class={cx(SIDEBAR, "print:hidden! gap-20 bg-subtle md:border-r md:border-line")}
    >
      <a href="/cases" class={cx("block self-start px-8 rounded-small", FOCUS)}>
        <Brand light={LOGO} dark={LOGO_ON_DARK} alt="IsItLegit, cases" class="h-32" />
      </a>
      <OrgSwitcher organization={props.organization} others={props.otherOrganizations} />
      <Button href="/upload" variant="primary" icon={<PlusIcon />} class="w-full">
        Check a file
      </Button>
      <div class="flex flex-col gap-2">
        <NavLink href="/cases" current={active === "cases"}>
          <CasesIcon />
          Cases
        </NavLink>
        <NavLink href="/suppliers" current={active === "suppliers"}>
          <SuppliersIcon />
          Suppliers
        </NavLink>
        <NavLink href="/protect" current={active === "protect"}>
          <ProtectIcon />
          Protect
        </NavLink>
        <NavLink href="/monitor" current={active === "monitor"}>
          <MonitorIcon />
          Monitor
          {monitorNew > 0 && (
            <Pill variant="malicious" size="compact" class="ml-auto">
              {`${monitorNew} new`}
            </Pill>
          )}
        </NavLink>
        <NavLink href="/team" current={active === "team"}>
          <TeamIcon />
          Team
        </NavLink>
      </div>
      <div class="flex flex-col gap-2">
        <p class="px-12 pb-8 type-eyebrow text-muted">Settings</p>
        <NavLink href="/settings/domains" current={active === "domains"}>
          Domains and addresses
        </NavLink>
        <NavLink href="/settings/account" current={active === "account"}>
          Account
        </NavLink>
        <NavLink href="/settings/plan" current={active === "plan"}>
          Plan
          <Pill variant="neutral" size="compact" class="ml-auto">
            {planWords}
          </Pill>
        </NavLink>
      </div>
      {/* The copy group (D07 T01 §9): the app script copies the address, says so on the status line and, when the
          clipboard refuses, selects the address for copying by hand. */}
      <div data-copy-group class="mt-auto flex flex-col gap-12 p-16 bg-surface border border-line rounded-card">
        <p class="text-14 weight-text-strong">Forward suspicious mail as an attachment to</p>
        <div class="flex items-center gap-8">
          <span data-copy-source class="font-mono text-13 weight-text-strong">
            {CHECK_ADDRESS}
          </span>
          <Button
            size="icon"
            label="Copy the check address"
            icon={<CopyIcon />}
            data-copy={CHECK_ADDRESS}
            class="ml-auto"
          />
        </div>
        <p data-copy-status role="status" aria-live="polite" class="text-13 text-muted" />
      </div>
      <div class="flex items-center gap-12 px-8">
        <span class="inline-flex items-center justify-center w-32 h-32 rounded-pill bg-orange-wash text-orange-text text-13 weight-heading">
          {initials(user.name)}
        </span>
        <span class="flex flex-col min-w-0">
          <span class={cx("text-14 weight-text-strong", NAME)} title={user.name}>
            {user.name}
          </span>
          <span class="text-13 text-muted">{user.role}</span>
        </span>
        <form method="post" action="/auth/sign-out" class="ml-auto">
          <Button type="submit" variant="link" class="text-13">
            Sign out
          </Button>
        </form>
      </div>
    </nav>
  );
}

function AdminNav(props: AdminShellProps) {
  const { active, feedbackOpen, operator } = props;
  return (
    <nav id="nav" popover="auto" aria-label="Admin" class={cx(SIDEBAR, "print:hidden! gap-24 bg-dark")}>
      <div class="flex flex-col gap-12 px-8">
        <a href="/admin" class={cx("self-start rounded-small", FOCUS_ON_DARK)}>
          <img src={LOGO_ON_DARK} alt="IsItLegit admin, overview" class="block h-28" />
        </a>
        <Pill variant="brand" class="self-start">
          Rizonetech admin
        </Pill>
      </div>
      <div class="flex flex-col gap-2">
        <NavLink dark href="/admin" current={active === "overview"}>
          Overview
        </NavLink>
        <NavLink dark href="/admin#organisations" current={active === "orgs"}>
          Organisations
        </NavLink>
        <NavLink dark href="/admin/invites" current={active === "invites"}>
          Invite codes
        </NavLink>
        <NavLink dark href="/admin/feedback" current={active === "feedback"}>
          Feedback
          {feedbackOpen > 0 && (
            <>
              <Pill variant="alert" size="compact" class="ml-auto">
                {String(feedbackOpen)}
              </Pill>
              <span class="sr-only">open</span>
            </>
          )}
        </NavLink>
        <NavLink dark href="/admin/eval" current={active === "eval"}>
          Eval runs
        </NavLink>
      </div>
      <div class="mt-auto flex flex-col gap-8 px-12 text-13 text-on-dark-muted">
        <span>Signed in through Cloudflare Access</span>
        <span class={cx("weight-text-strong text-on-dark", NAME)} title={operator}>
          {operator}
        </span>
      </div>
    </nav>
  );
}

function Main(props: { besideSidebar?: boolean; children: Child }) {
  // tabindex -1 lets the skip link move focus here; a heading inside names the page.
  return (
    <main
      id="content"
      tabindex={-1}
      class={cx("min-w-0 focus:outline-none", props.besideSidebar && "md:ml-sidebar print:ml-0")}
    >
      {props.children}
    </main>
  );
}

export function AppShell(props: AppShellProps) {
  if (props.variant === "public")
    return (
      <>
        <a href="#content" class={SKIP}>
          Skip to content
        </a>
        <header class="flex flex-wrap items-center justify-between gap-x-24 gap-y-4 min-h-72 px-16 py-12 md:px-120 box-border border-b border-line bg-surface">
          <a href="https://isitlegit.co.za" class={cx("rounded-small", FOCUS)}>
            <Brand light={LOGO} dark={LOGO_ON_DARK} alt="IsItLegit home" class="h-28" />
          </a>
          <p class="text-14 text-muted">
            {props.note ?? `Report for a check sent to ${CHECK_ADDRESS} · link valid for 7 days`}
          </p>
        </header>
        <Main>{props.children}</Main>
      </>
    );
  const member = props.variant === "member";
  return (
    <>
      <a href="#content" class={SKIP}>
        Skip to content
      </a>
      <PhoneHeader
        home={member ? "/cases" : "/admin"}
        homeLabel={member ? "IsItLegit, cases" : "IsItLegit admin, overview"}
      />
      {member ? <MemberNav {...props} /> : <AdminNav {...props} />}
      <Main besideSidebar>{props.children}</Main>
    </>
  );
}
