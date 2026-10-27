import { describe, expect, it } from "vitest";
import { LOGO, LOGO_MARK, LOGO_ON_DARK } from "../../src/web/assets";
import { type AdminPage, AppShell, initials, type MemberPage } from "../../src/web/components/AppShell";
import { admin, member } from "./shell-fixtures";

// The three frames as markup (D07 T01 §3; design/SPEC.md 1 P1 and P2, boards `AppNav`, `AdminNav`,
// `Report-Counterparty`): landmarks, every label and destination, the states from props, the forms, and the token
// utilities that carry the boards' values. Layout and keyboard are shell-layout and shell-keyboard.
const html = (node: unknown) => String(node);
const opening = (markup: string, pattern: string) => new RegExp(`<${pattern}[^>]*>`).exec(markup)?.[0] ?? "";
const linkTo = (markup: string, href: string) => opening(markup, `a[^>]*href="${href.replace(/[?#]/g, "\\$&")}"`);

const MEMBER_LINKS: [MemberPage, string, string][] = [
  ["cases", "/cases", "Cases"],
  ["suppliers", "/suppliers", "Suppliers"],
  ["protect", "/protect", "Protect"],
  ["monitor", "/monitor", "Monitor"],
  ["team", "/team", "Team"],
  ["domains", "/settings/domains", "Domains and addresses"],
  ["account", "/settings/account", "Account"],
  ["plan", "/settings/plan", "Plan"],
];
const ADMIN_LINKS: [AdminPage, string, string][] = [
  ["overview", "/admin", "Overview"],
  ["orgs", "/admin#organisations", "Organisations"],
  ["invites", "/admin/invites", "Invite codes"],
  ["feedback", "/admin/feedback", "Feedback"],
  ["eval", "/admin/eval", "Eval runs"],
];

describe("member frame (P1)", () => {
  const page = html(<AppShell {...member()} />);

  it("opens with the skip link, then the phone header, the Main navigation and the content", () => {
    expect(page.startsWith('<a href="#content"')).toBe(true);
    expect(page).toContain(">Skip to content</a>");
    const order = ["<header", '<nav id="nav" popover="auto" aria-label="Main"', '<main id="content" tabindex="-1"'];
    const at = order.map((tag) => page.indexOf(tag));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(page).toContain("<h1>Cases</h1>");
  });

  it("names every destination: logo, Check a file, the main and settings links", () => {
    expect(page).toContain(`<a href="/cases" class="`);
    expect(page).toContain(`<img src="${LOGO}" alt="IsItLegit, cases"`);
    expect(page).toContain(`<img src="${LOGO_MARK}" alt="IsItLegit, cases"`);
    expect(linkTo(page, "/upload")).toContain("bg-accent");
    expect(page).toContain("Check a file</a>");
    for (const [, href, label] of MEMBER_LINKS) {
      expect(linkTo(page, href), href).not.toBe("");
      expect(page).toContain(label);
    }
    expect(page).toContain(">Settings</p>");
  });

  it("marks exactly the active link, for every page", () => {
    for (const [active, href] of MEMBER_LINKS) {
      const markup = html(<AppShell {...member({ active })} />);
      expect(markup.match(/aria-current="page"/g)?.length, active).toBe(1);
      expect(/<a href="([^"]+)" aria-current="page"/.exec(markup)?.[1], active).toBe(href);
    }
  });

  it("shows the Monitor count only above zero, and the trial or the plan name", () => {
    expect(page).toContain(">1 new</span>");
    expect(html(<AppShell {...member({ monitorNew: 0 })} />)).not.toContain(" new</span>");
    expect(page).toContain(">Trial, 11 days</span>");
    expect(html(<AppShell {...member({ plan: { trialDaysLeft: 1 } })} />)).toContain(">Trial, 1 day</span>");
    const paid = html(<AppShell {...member({ plan: { name: "Business" } })} />);
    expect(paid).toContain(">Business</span>");
    expect(paid).not.toContain("Trial");
  });

  it("switches organisation through a form per other organisation, or shows a plain label for one", () => {
    expect(page).toContain('<summary aria-label="Switch organisation, current Karoo Couriers"');
    expect(page).toContain('<form method="post" action="/orgs/switch">');
    expect(page).toContain('<input type="hidden" name="organizationId" value="org-swartberg"/>');
    expect(page).toMatch(/<button type="submit"[^>]*>(?:(?!<\/button>).)*>Swartberg Transport<\/span><\/button>/);
    const one = html(<AppShell {...member({ otherOrganizations: [] })} />);
    expect(one).not.toContain("<details");
    expect(one).not.toContain("/orgs/switch");
    expect(one).toContain("Karoo Couriers</span></p>");
  });

  it("copies the check address, signs out through a form, and shows the user", () => {
    const copy = opening(page, 'button[^>]*data-copy="check@isitlegit.co.za"');
    expect(copy).toContain('aria-label="Copy the check address"');
    expect(copy).toContain('type="button"');
    expect(page).toContain("Forward suspicious mail as an attachment to");
    expect(page).toMatch(
      /<form method="post" action="\/auth\/sign-out"[^>]*><button[^>]*type="submit"[^>]*>Sign out<\/button><\/form>/,
    );
    expect(page).toContain(">TN</span>");
    expect(page).toContain("Thandi Nkosi");
    expect(page).toContain(">Owner</span>");
  });

  it("opens the sidebar from the phone header's Menu button, a popover with no script", () => {
    const menu = opening(page, 'button[^>]*popovertarget="nav"');
    expect(menu).toContain('aria-label="Menu"');
    expect(menu).toContain('type="button"');
  });

  it("carries AppNav's values in token utilities", () => {
    const nav = opening(page, 'nav id="nav"');
    for (const name of [
      "w-sidebar",
      "bg-subtle",
      "md:border-r",
      "md:border-line",
      "px-16",
      "py-24",
      "gap-20",
      "open:flex",
      "md:flex",
    ])
      expect(nav, name).toContain(name);
    const link = linkTo(page, "/suppliers");
    for (const name of [
      "h-40",
      "px-12",
      "rounded-control-small",
      "text-15",
      "text-ink-2",
      "hover:bg-light",
      "hover:text-ink",
      "aria-[current=page]:bg-light",
      "focus-visible:outline-orange-text",
    ])
      expect(link, name).toContain(name);
    expect(opening(page, `img src="${LOGO}"`)).toContain("h-32");
    expect(opening(page, "summary")).toContain("h-48");
  });
});

describe("admin frame (P2)", () => {
  const page = html(<AppShell {...admin()} />);

  it("names every destination, marks the active one, and carries the badge", () => {
    expect(page).toContain('<nav id="nav" popover="auto" aria-label="Admin"');
    expect(page).toContain(`<img src="${LOGO_ON_DARK}" alt="IsItLegit admin, overview"`);
    expect(page).toMatch(/bg-orange text-dark[^"]*">Rizonetech admin<\/span>/);
    for (const [active, href, label] of ADMIN_LINKS) {
      expect(page).toContain(label);
      const markup = html(<AppShell {...admin({ active })} />);
      expect(markup.match(/aria-current="page"/g)?.length, active).toBe(1);
      expect(/<a href="([^"]+)" aria-current="page"/.exec(markup)?.[1], active).toBe(href);
    }
  });

  it("shows open feedback as an alert count only above zero", () => {
    expect(page).toMatch(/bg-mal-band text-on-band[^"]*">3<\/span><span class="sr-only">open<\/span>/);
    expect(html(<AppShell {...admin({ feedbackOpen: 0 })} />)).not.toContain("bg-mal-band");
  });

  it("names the operator Access signed in, with no sign-out of its own", () => {
    expect(page).toContain("Signed in through Cloudflare Access");
    expect(page).toContain("Rizonetech operator");
    expect(page).not.toContain("sign-out");
    expect(page).not.toContain("Sign out");
  });

  it("carries AdminNav's values in token utilities, with the on-dark focus ring", () => {
    expect(opening(page, 'nav id="nav"')).toContain("bg-dark");
    const link = linkTo(page, "/admin/invites");
    for (const name of [
      "text-on-dark-muted",
      "hover:bg-dark-raised",
      "hover:text-on-dark",
      "aria-[current=page]:bg-dark-active",
      "focus-visible:outline-orange-on-dark",
    ])
      expect(link, name).toContain(name);
    expect(link).not.toContain("outline-orange-text");
  });
});

describe("public frame (Report-Counterparty)", () => {
  const page = html(
    <AppShell variant="public">
      <h1>Statement request</h1>
    </AppShell>,
  );

  it("shows the logo to the public site and the notice, then the content", () => {
    expect(page).toContain(`<a href="https://isitlegit.co.za"`);
    expect(page).toContain(`<img src="${LOGO}" alt="IsItLegit home"`);
    expect(page).toContain("Report for a check sent to check@isitlegit.co.za · link valid for 7 days");
    expect(page).toContain('<main id="content" tabindex="-1"');
    expect(page).toContain("<h1>Statement request</h1>");
    expect(opening(page, "header")).toContain("min-h-72");
  });

  it("carries none of the member navigation, its names or its forms", () => {
    for (const [, href] of MEMBER_LINKS) expect(linkTo(page, href), href).toBe("");
    for (const text of ["<nav", "<form", "popovertarget", "Karoo Couriers", "Thandi Nkosi", "Sign out", "Check a file"])
      expect(page).not.toContain(text);
  });
});

describe("initials", () => {
  it("takes the first letters of the first two words", () => {
    expect(initials("Thandi Nkosi")).toBe("TN");
    expect(initials("  karoo   couriers ltd ")).toBe("KC");
    expect(initials("Cher")).toBe("C");
    // The first character as a reader sees it, never half of a surrogate pair or a letter without its accent.
    expect(initials("🚚 Fast Movers")).toBe("🚚F");
    expect(initials("\u{1F469}\u200D\u{1F469}\u200D\u{1F467} Family Trust")).toBe(
      "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}F",
    );
    expect(initials("e\u0301mile zola")).toBe("E\u0301Z");
  });
});
