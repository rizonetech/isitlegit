import type { Child } from "hono/jsx";
import { LOGO, LOGO_MARK, LOGO_ON_DARK } from "../assets";
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
// defect), in three variants as the approved boards draw them: the member app with the P1 navigation (`AppNav`), the
// admin console with the P2 navigation (`AdminNav`), and the public frame of a report opened from a signed link
// (`Report-Counterparty`). Below `md` the member and admin sidebars become a popover behind the phone header's Menu
// button (`Report-Mobile`), which opens and closes with no script.

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

export type PublicShellProps = { variant: "public"; children: Child };

export type AppShellProps = MemberShellProps | AdminShellProps | PublicShellProps;

// "Thandi Nkosi" to "TN", "Karoo Couriers" to "KC": the first letters of the first two words.
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

const SKIP =
  "sr-only focus:not-sr-only focus:fixed focus:top-8 focus:left-8 focus:z-50 focus:px-16 focus:py-12 focus:bg-surface focus:text-ink focus:rounded-control focus:shadow-card " +
  FOCUS;
// The sidebar: in the page from `md`, a popover below it (the browser hides a closed popover; `open:` matches
// `:popover-open`, and `md:flex` shows it in the page whatever its state).
const SIDEBAR =
  "open:flex md:flex flex-col w-sidebar shrink-0 box-border px-16 py-24 m-0 h-full md:h-auto md:min-h-screen fixed md:static inset-y-0 left-0 overflow-y-auto border-0 backdrop:bg-ink/40";
const MEMBER_LINK =
  "flex items-center gap-12 h-40 px-12 rounded-control-small text-15 weight-text-strong no-underline text-ink-2 hover:bg-light hover:text-ink aria-[current=page]:bg-light aria-[current=page]:text-ink";
const ADMIN_LINK =
  "flex items-center gap-12 h-40 px-12 rounded-control-small text-15 weight-text-strong no-underline text-on-dark-muted hover:bg-dark-raised hover:text-on-dark aria-[current=page]:bg-dark-active aria-[current=page]:text-on-dark";

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
    <header class="md:hidden grid grid-cols-3 items-center h-56 px-16 border-b border-line bg-surface">
      <a href={props.home} class={cx("col-start-2 justify-self-center rounded-small", FOCUS)}>
        <img src={LOGO_MARK} alt={props.homeLabel} class="block w-32 h-32" />
      </a>
      <Button size="small-icon" popovertarget="nav" label="Menu" icon={<MenuIcon />} class="justify-self-end" />
    </header>
  );
}

function OrgBadge(props: { name: string }) {
  return (
    <span class="inline-flex items-center justify-center w-24 h-24 rounded-small bg-dark text-on-dark text-12 weight-heading">
      {initials(props.name)}
    </span>
  );
}

function OrgSwitcher(props: { organization: Organization; others: Organization[] }) {
  const { organization, others } = props;
  if (!others.length)
    return (
      <p class="flex items-center gap-12 h-48 px-12 text-15 weight-text-strong text-ink">
        <OrgBadge name={organization.name} />
        {organization.name}
      </p>
    );
  return (
    <details class="relative">
      <summary
        aria-label={`Switch organisation, current ${organization.name}`}
        class={cx(
          "flex items-center justify-between h-48 px-12 list-none rounded-control border border-line-strong bg-surface text-15 weight-text-strong text-ink cursor-pointer hover:border-ink [&::-webkit-details-marker]:hidden",
          FOCUS,
        )}
      >
        <span class="flex items-center gap-12">
          <OrgBadge name={organization.name} />
          {organization.name}
        </span>
        <ChevronIcon class="text-muted" />
      </summary>
      <ul class="mt-4 p-4 flex flex-col gap-2 bg-surface border border-line rounded-control shadow-card list-none">
        {others.map((org) => (
          <li>
            <form method="post" action="/orgs/switch">
              <input type="hidden" name="organizationId" value={org.id} />
              <Button type="submit" class="w-full justify-start border-0">
                <OrgBadge name={org.name} />
                {org.name}
              </Button>
            </form>
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
    <nav id="nav" popover="auto" aria-label="Main" class={cx(SIDEBAR, "gap-20 bg-subtle md:border-r md:border-line")}>
      <a href="/cases" class={cx("block self-start px-8 rounded-small", FOCUS)}>
        <img src={LOGO} alt="IsItLegit, cases" class="block h-32" />
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
      <div class="mt-auto flex flex-col gap-12 p-16 bg-surface border border-line rounded-card">
        <p class="text-14 weight-text-strong">Forward suspicious mail as an attachment to</p>
        <div class="flex items-center gap-8">
          <span class="font-mono text-13 weight-text-strong">{CHECK_ADDRESS}</span>
          <Button
            size="icon"
            label="Copy the check address"
            icon={<CopyIcon />}
            data-copy={CHECK_ADDRESS}
            class="ml-auto"
          />
        </div>
      </div>
      <div class="flex items-center gap-12 px-8">
        <span class="inline-flex items-center justify-center w-32 h-32 rounded-pill bg-orange-wash text-orange-text text-13 weight-heading">
          {initials(user.name)}
        </span>
        <span class="flex flex-col">
          <span class="text-14 weight-text-strong">{user.name}</span>
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
    <nav id="nav" popover="auto" aria-label="Admin" class={cx(SIDEBAR, "gap-24 bg-dark")}>
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
        <span class="weight-text-strong text-on-dark">{operator}</span>
      </div>
    </nav>
  );
}

function Main(props: { children: Child }) {
  // tabindex -1 lets the skip link move focus here; a heading inside names the page.
  return (
    <main id="content" tabindex={-1} class="flex-1 min-w-0 focus:outline-none">
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
            <img src={LOGO} alt="IsItLegit home" class="block h-28" />
          </a>
          <p class="text-14 text-muted">Report for a check sent to {CHECK_ADDRESS} · link valid for 7 days</p>
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
      <div class="md:flex md:min-h-screen">
        {member ? <MemberNav {...props} /> : <AdminNav {...props} />}
        <Main>{props.children}</Main>
      </div>
    </>
  );
}
