import type { Child } from "hono/jsx";
import type { AdminShellProps, MemberShellProps } from "../../src/web/components/AppShell";

// The shell's props as the boards draw them (`AppNav`, `AdminNav`), with the boards' fictional names.
export const member = (
  overrides: Partial<MemberShellProps> = {},
  children: Child = <h1>Cases</h1>,
): MemberShellProps => ({
  variant: "member",
  active: "cases",
  organization: { id: "org-karoo", name: "Karoo Couriers" },
  otherOrganizations: [{ id: "org-swartberg", name: "Swartberg Transport" }],
  monitorNew: 1,
  plan: { trialDaysLeft: 11 },
  user: { name: "Thandi Nkosi", role: "Owner" },
  children,
  ...overrides,
});

export const admin = (
  overrides: Partial<AdminShellProps> = {},
  children: Child = <h1>Overview</h1>,
): AdminShellProps => ({
  variant: "admin",
  active: "overview",
  feedbackOpen: 3,
  operator: "Rizonetech operator",
  children,
  ...overrides,
});
