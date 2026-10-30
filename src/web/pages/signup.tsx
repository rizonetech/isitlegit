// The signup page (D07 T02 §13; design/SPEC.md A2, board `Signup`): an invite code, the owner's work email, the
// organisation's name and the POPIA consent, on A1's frame with A2's own panel words. Every refusal is drawn on its
// field with the form kept; an interrupted signup says to try again, the same fields resuming it. The routes are
// src/auth/confirm.tsx (`/signup`), which call the invite-code endpoint (D07 T02 §4) and draw its answers.
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Checkbox } from "../components/Checkbox";
import { Field } from "../components/Field";
import { LinkForm, type PanelWords, SigninFrame, SigninState } from "./signin";

export const SIGNUP_PATH = "/signup";
// The privacy notice is the public site's (S6, D07 T06 §5); the signup page is on the app's host.
export const PRIVACY_URL = "https://isitlegit.co.za/privacy";
const LINK = cx("text-orange-text underline underline-offset-4", FOCUS);

export const SIGNUP_PANEL: PanelWords = {
  headline: "Protect your business from fake invoices and phishing.",
  sentence: "Create your organisation. During the launch you need an invite code; checks are free.",
};

export type SignupValues = { invite?: string; email?: string; organizationName?: string; consent?: boolean };
export type SignupErrors = Partial<Record<"invite" | "email" | "organizationName" | "consent", string>>;
// A refusal of the whole form (a rate limit, the service failing), said above it; `retryAt` holds Create account.
export type SignupProblem = { text: string; retry?: { at: number; words: string } };

export function SignupPage(props: { values?: SignupValues; errors?: SignupErrors; problem?: SignupProblem }) {
  const values = props.values ?? {};
  const errors = props.errors ?? {};
  const { problem } = props;
  return (
    <SigninFrame title="Create an account" panel={SIGNUP_PANEL}>
      <SigninState
        heading="Create an account"
        text={
          <>
            Already have one?{" "}
            <a href="/signin" class={LINK}>
              Sign in
            </a>
          </>
        }
      >
        {problem && (
          <p role="alert" class="text-14 text-mal weight-text-strong">
            {problem.text}
          </p>
        )}
        <form method="post" action={SIGNUP_PATH} class="flex flex-col gap-20" data-busy>
          <Field
            id="signup-invite"
            label="Invite code"
            name="invite"
            autocomplete="off"
            required
            {...(values.invite ? { value: values.invite } : {})}
            {...(errors.invite ? { error: errors.invite } : {})}
          />
          <div class="flex flex-col gap-8">
            <Field
              id="signup-email"
              label="Work email"
              name="email"
              type="email"
              autocomplete="email"
              inputmode="email"
              required
              {...(values.email ? { value: values.email } : {})}
              {...(errors.email ? { error: errors.email } : {})}
            />
            {errors.email?.startsWith("This address already has an account") && (
              <a href="/signin" class={cx(LINK, "self-start text-14")}>
                Sign in instead
              </a>
            )}
          </div>
          <Field
            id="signup-organisation"
            label="Organisation name"
            name="organizationName"
            autocomplete="organization"
            required
            {...(values.organizationName ? { value: values.organizationName } : {})}
            {...(errors.organizationName ? { error: errors.organizationName } : {})}
          />
          <div class="flex flex-col gap-12 p-16 bg-subtle border border-line rounded-card">
            <p id="signup-notice" class="text-14 text-muted">
              We process the email you forward to check it, delete the original message and attachments after 30 days,
              and keep a short case summary. Meta's models and our other processors handle it under POPIA.{" "}
              <a href={PRIVACY_URL} class={LINK}>
                Read the privacy notice
              </a>
            </p>
            <Checkbox
              id="signup-consent"
              name="consent"
              value="yes"
              required
              {...(values.consent ? { checked: true } : {})}
              aria-describedby={errors.consent ? "signup-notice signup-consent-error" : "signup-notice"}
              {...(errors.consent ? { "aria-invalid": "true" } : {})}
            >
              I agree to IsItLegit processing mail I forward, as the privacy notice describes.
            </Checkbox>
            {errors.consent && (
              <p id="signup-consent-error" role="alert" class="text-13 text-mal weight-text-strong">
                {errors.consent}
              </p>
            )}
          </div>
          <Button
            type="submit"
            variant="primary"
            data-busy-label="Creating your account…"
            data-needs-consent="signup-consent"
            {...(problem?.retry
              ? { "data-retry-at": String(problem.retry.at), "data-ready-label": "Create account" }
              : {})}
          >
            {problem?.retry ? `Create account at ${problem.retry.words}` : "Create account"}
          </Button>
        </form>
      </SigninState>
    </SigninFrame>
  );
}

// The account was made but its first link could not be confirmed as sent: the form for a new one, the address kept.
export function SignupNotConfirmedPage(props: { email: string }) {
  return (
    <SigninFrame title="Your account is ready" panel={SIGNUP_PANEL}>
      <SigninState
        tile="clock"
        heading="Your account is ready"
        text="We could not confirm that your sign-in link was sent. Ask for a new one below."
      >
        <LinkForm next="/cases" email={props.email} button="Email me a new link" />
      </SigninState>
    </SigninFrame>
  );
}
