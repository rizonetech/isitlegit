// The upload page's view (D01 T03 §6; design/SPEC.md M2, boards `Upload` and `Upload-States`): the page, its alert and
// the refusals' words, kept apart from the routes (./upload.tsx) so the browser tests draw it without the Worker's
// storage types.
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { cx, FOCUS } from "../components/attrs";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Pill } from "../components/Pill";
import { SIGNIN_PATH } from "./signin";

// What a refusal says (Upload-States): its title, what to do, and the link or button that does it.
export type UploadAlert = {
  title: string;
  detail?: string;
  link?: { href: string; label: string; after?: string };
  retry?: boolean;
};

const MB = 1024 * 1024;
const quoted = (name: string | null) => (name ? `"${name}"` : "this file");
const megabytes = (bytes: number) => `${Math.round(bytes / MB)} MB`;

// The time left to 00:00 SAST (UTC+2, no daylight saving), in hours and minutes.
export function untilMidnight(now: Date): string {
  const sast = now.getTime() + 2 * 60 * 60_000;
  const left = Math.max(0, 86_400_000 - (sast % 86_400_000));
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.ceil((left % 3_600_000) / 60_000);
  const h = hours ? `${hours} ${hours === 1 ? "hour" : "hours"}` : "";
  const m = minutes ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : "";
  return [h, m].filter(Boolean).join(" ") || "under a minute";
}

// A refusal from the upload API, in the board's words: the file named when the sender told us its name and size.
export function alertFor(
  status: number,
  error: string,
  file: { name: string | null; size: number | null },
  usage: { org: string; limit: number } | null,
  now: Date,
): UploadAlert {
  if (status === 415) return { title: `We cannot check ${quoted(file.name)}.`, detail: error };
  if (status === 413)
    return {
      title:
        file.name && file.size !== null
          ? `${quoted(file.name)} is ${megabytes(file.size)}. The limit is 25 MB.`
          : "The file is larger than 25 MB, the most that can be checked.",
      detail:
        "Upload a shorter clip, or the part of the recording that matters. Voice notes are checked up to 10 minutes.",
    };
  if (status === 429)
    return {
      title: usage ? `${usage.org} has used all ${usage.limit} checks for today.` : error,
      detail: `Checks start again at 00:00 SAST, in ${untilMidnight(now)}. Until then, do not act on anything you were unsure about.`,
      link: { href: "/settings/plan", label: "About your plan" },
    };
  if (status === 401)
    return {
      title: "Your session ended.",
      link: {
        href: `${SIGNIN_PATH}?next=${encodeURIComponent("/upload")}`,
        label: "Sign in again",
        after: " and choose the file once more; nothing was uploaded.",
      },
    };
  return { title: error, ...(status === 503 ? { retry: true } : {}) };
}

// The alert region's contents: one refusal, its title strong, what to do, and its link or Try again.
export function UploadAlertBody(props: { alert: UploadAlert }) {
  const { alert } = props;
  return (
    <>
      <p class="weight-text-strong wrap-anywhere">{alert.title}</p>
      {alert.detail && <p class="text-14 wrap-anywhere">{alert.detail}</p>}
      {alert.link && (
        <p class="text-14">
          <a href={alert.link.href} class={cx("text-orange-text underline underline-offset-4", FOCUS)}>
            {alert.link.label}
          </a>
          {alert.link.after}
        </p>
      )}
      {alert.retry && (
        <p>
          <Button variant="ghost" size="small" data-upload-retry="">
            Try again
          </Button>
        </p>
      )}
    </>
  );
}

const KINDS: [string, string, string][] = [
  ["Email", "A saved email", ".eml or Outlook .msg, with its original headers"],
  ["PDF", "Invoice, proof of payment or bank letter", "Checked for edits and against your supplier ledger"],
  ["Image", "Screenshot or photo", "PNG, JPEG or WebP, for example a proof of payment sent on WhatsApp"],
  ["Audio", "Voice note or voicemail", ".ogg, .opus, .wav, .mp3 or .m4a, up to 10 minutes"],
];

export function UploadPage(props: {
  shell: Omit<MemberShellProps, "children">;
  org: string;
  usage: { used: number; limit: number };
  alert?: UploadAlert;
}) {
  const { usage } = props;
  return (
    <Document title="Check a file">
      <AppShell {...props.shell}>
        <div class="flex flex-col gap-28 px-16 py-24 md:px-56 md:py-32">
          <header class="flex flex-col gap-8">
            <h1 class="type-h2">Check a file</h1>
            <p class="text-muted">
              For anything you did not get by email, or an email you saved. Forwarding to check@isitlegit.co.za still
              works for mail.
            </p>
          </header>
          <div class="grid gap-24 md:grid-cols-[1.5fr_1fr] md:items-start">
            <form
              method="post"
              action="/upload"
              enctype="multipart/form-data"
              data-upload=""
              aria-label="Upload"
              class="flex flex-col gap-16"
            >
              <label
                for="upload-file"
                data-upload-zone=""
                class={cx(
                  "flex min-h-[380px] cursor-pointer flex-col items-center justify-center gap-16 rounded-card-large border-2 border-dashed border-control-border bg-subtle p-24 text-center",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-orange-text",
                )}
              >
                <span class="font-heading text-24 weight-heading-strong">Drop one file here</span>
                <span class="text-muted">or</span>
                <span
                  data-upload-choose=""
                  class="inline-flex min-h-control items-center rounded-control bg-dark px-20 text-on-dark weight-text-strong"
                >
                  Choose a file
                </span>
                <span class="type-small text-muted">One file at a time, up to 25 MB</span>
              </label>
              <input id="upload-file" name="file" type="file" required class="sr-only" />
              {/* The board sends a file the moment it is chosen, which only the app script can do: without it, this
                  sends the form (an M2 Deviation). */}
              <span class="[[data-script]_&]:hidden">
                <Button variant="primary" type="submit">
                  Check this file
                </Button>
              </span>
              <div
                data-upload-progress=""
                hidden
                class="flex flex-col gap-8 rounded-card border border-line bg-surface p-16"
              >
                <p class="weight-text-strong wrap-anywhere" data-upload-name="" />
                <progress data-upload-bar="" max="100" value="0" class="w-full" aria-label="Upload progress" />
                <p class="type-small text-muted" data-upload-sent="" />
              </div>
              <div
                id="upload-alert"
                role="alert"
                tabindex={-1}
                class={cx(
                  "flex flex-col gap-8 rounded-card border border-mal bg-mal-wash p-16 text-ink empty:hidden",
                  FOCUS,
                )}
              >
                {props.alert && <UploadAlertBody alert={props.alert} />}
              </div>
              <p class="type-small text-muted">
                We check what the file really is, not what its name says. Nothing is kept from a file we refuse.
              </p>
            </form>
            <section
              aria-labelledby="kinds-heading"
              class="flex flex-col gap-16 rounded-card border border-line bg-surface p-24"
            >
              <h2 id="kinds-heading" class="type-h3">
                What you can check
              </h2>
              <ul class="flex flex-col gap-16">
                {KINDS.map(([kind, what, formats]) => (
                  <li class="flex gap-12">
                    <span class="w-72 shrink-0">
                      <Pill variant="neutral">{kind}</Pill>
                    </span>
                    <span class="flex min-w-0 flex-col">
                      <span class="type-small weight-text-strong">{what}</span>
                      <span class="type-small text-muted">{formats}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p class="border-t border-line pt-16 type-small text-muted">
                Not accepted: programs, archives, Word or Excel files and anything else. Forward those by email instead,
                so the whole message is checked.
              </p>
            </section>
          </div>
          <section
            aria-label="Today's checks"
            class="flex flex-wrap items-center justify-between gap-12 rounded-card bg-subtle px-20 py-16"
          >
            <p class="type-small">
              {`${props.org} has used `}
              <strong>{`${usage.used} of ${usage.limit}`}</strong>
              {" checks today. The count resets at midnight SAST."}
            </p>
            <a href="/settings/plan" class={cx("type-small text-orange-text underline underline-offset-4", FOCUS)}>
              See your plan
            </a>
          </section>
        </div>
      </AppShell>
    </Document>
  );
}
