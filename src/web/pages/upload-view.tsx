// The upload page's view (D01 T03 §6; design/SPEC.md M2, boards `Upload` and `Upload-States`): the page, its alert and
// the refusals' words, kept apart from the routes (./upload.tsx) so the browser tests draw it without the Worker's
// storage types.

import { ACCEPTED_FORMATS, OFFICE_NOT_TAKEN } from "../../intake/sniff";
import { MOTION } from "../assets";
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
// A size in megabytes rounded up to a tenth, so a file just over the limit never reads as the limit itself.
export const megabytes = (bytes: number) => `${Math.ceil((bytes / MB) * 10) / 10} MB`;
// What to do with a file too large: a recording is shortened, anything else sent as a smaller copy.
export const TOO_LARGE_AUDIO =
  "Upload a shorter clip, or the part of the recording that matters. Voice notes are checked up to 10 minutes.";
export const TOO_LARGE_FILE =
  "Upload a smaller copy: a PDF exported again or compressed, or a screenshot rather than a full photo. A recording can be shortened to the part that matters.";
const AUDIO = /\.(ogg|opus|wav|mp3)$/i;

// The time left to 00:00 SAST (UTC+2, no daylight saving), in whole minutes rounded up, then hours and minutes.
export function untilMidnight(now: Date): string {
  const sast = now.getTime() + 2 * 60 * 60_000;
  const left = Math.ceil(Math.max(0, 86_400_000 - (sast % 86_400_000)) / 60_000);
  const hours = Math.floor(left / 60);
  const minutes = left % 60;
  const h = hours ? `${hours} ${hours === 1 ? "hour" : "hours"}` : "";
  const m = minutes ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : "";
  return [h, m].filter(Boolean).join(" ") || "under a minute";
}

// A refusal from the upload API, in the board's words: the file named when the sender told us its name and size.
// An organisation an operator paused (a daily cap of 0, D07 T08 §8): said on the page as it opens and on any upload,
// with no reset promised and no Try again.
export function pausedAlert(org: string): UploadAlert {
  return {
    title: `Checks are paused for ${org}.`,
    detail: "Ask IsItLegit to turn them back on. Until then, do not act on anything you were unsure about.",
    link: { href: "/settings/plan", label: "About your plan" },
  };
}

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
      detail: file.name && AUDIO.test(file.name) ? TOO_LARGE_AUDIO : TOO_LARGE_FILE,
    };
  // A cap of 0 is an operator's pause (D07 T08 §8): nothing restarts at midnight, so nothing promises it.
  if (status === 429 && usage?.limit === 0) return pausedAlert(usage.org);
  if (status === 429)
    return {
      title: usage ? `${usage.org} has used all ${usage.limit} checks for today.` : error,
      detail: `Checks start again at 00:00 SAST, in ${untilMidnight(now)}. Until then, do not act on anything you were unsure about.`,
      link: { href: "/settings/plan", label: "About your plan" },
      retry: true,
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
        <>
          {/* Try again sends the kept file, which only the app script holds; without it the form starts empty. */}
          <p class="hidden [[data-script]_&]:block">
            <Button variant="ghost" size="small" data-upload-retry="">
              Try again
            </Button>
          </p>
          <p class="text-14 [[data-script]_&]:hidden">Choose the file again and select Check this file.</p>
        </>
      )}
    </>
  );
}

// The accepted files, from the one definition the refusal also reads (src/intake/sniff.ts, D01 T03 §13).
const KINDS: [string, string, string][] = ACCEPTED_FORMATS.map((f) => [f.kind, f.what, f.detail]);

export function UploadPage(props: {
  shell: Omit<MemberShellProps, "children">;
  org: string;
  usage: { used: number; limit: number };
  alert?: UploadAlert;
  // The status the alert answers, for the page's state (429 is the daily limit's).
  status?: number;
}) {
  const { usage } = props;
  // A paused organisation's page opens paused and says why, before any file is chosen (D07 T08 §8).
  const alert = props.alert ?? (usage.limit === 0 ? pausedAlert(props.org) : undefined);
  const status = props.alert ? props.status : usage.limit === 0 ? 429 : undefined;
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
            {/* The form's state draws the board's states (Upload-States) by the stylesheet: ready, uploading (the zone
                becomes the progress), refused, and paused (the daily limit: the zone dimmed and saying so, Choose a file
                still usable, so a choice after midnight is checked). The app script sets it as it sends. */}
            <form
              method="post"
              action="/upload"
              enctype="multipart/form-data"
              data-upload=""
              data-state={alert ? (status === 429 ? "paused" : "refused") : "ready"}
              aria-label="Upload"
              class="group/upload flex flex-col gap-16"
            >
              <label
                for="upload-file"
                data-upload-zone=""
                class={cx(
                  "flex min-h-[380px] cursor-pointer flex-col items-center justify-center gap-16 rounded-card-large border-2 border-dashed border-control-border bg-subtle p-24 text-center",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-orange-text",
                  "group-data-[state=uploading]/upload:border-solid group-data-[state=uploading]/upload:border-orange group-data-[state=uploading]/upload:bg-orange-wash",
                  "group-data-[state=paused]/upload:border-line",
                )}
              >
                <span class="flex flex-col items-center gap-16 group-data-[state=uploading]/upload:hidden">
                  <span class="inline-flex h-72 w-72 items-center justify-center rounded-card-large border border-line bg-surface">
                    <svg
                      width="32"
                      height="32"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      aria-hidden="true"
                    >
                      <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
                    </svg>
                  </span>
                  <span class="font-heading text-24 weight-heading-strong group-data-[state=paused]/upload:hidden">
                    Drop one file here
                  </span>
                  <span class="hidden font-heading text-24 weight-heading-strong group-data-[state=paused]/upload:inline">
                    {/* A cap of 0 is an operator's pause (D07 T08 §8): nothing restarts at midnight. */}
                    {usage.limit === 0 ? "Uploads paused" : "Uploads paused until midnight"}
                  </span>
                  <span class="text-muted">or</span>
                  <span class="inline-flex min-h-control items-center rounded-control bg-dark px-20 text-on-dark weight-text-strong">
                    Choose a file
                  </span>
                  <span class="type-small text-muted">One file at a time, up to 25 MB</span>
                </span>
                <span
                  data-upload-progress=""
                  class="hidden w-full flex-col items-center gap-12 group-data-[state=uploading]/upload:flex"
                >
                  <img src={MOTION.checking} alt="" width="56" height="56" />
                  <span class="weight-text-strong wrap-anywhere" data-upload-name="" />
                  <span
                    data-upload-bar=""
                    role="progressbar"
                    aria-label="Upload progress"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow="0"
                    class="block h-8 w-full max-w-[360px] rounded-small bg-surface"
                  >
                    <span data-upload-fill="" class="block h-8 w-0 rounded-small bg-orange-text" />
                  </span>
                  <span class="type-small text-muted" data-upload-sent="" />
                  <span class="inline-flex min-h-control-small items-center rounded-control-small bg-dark px-16 text-14 text-on-dark opacity-50">
                    Uploading...
                  </span>
                </span>
                {/* Inside the zone, so its focus shows on the zone; seen by sighted readers only without the script,
                    where it names the chosen file before Check this file. */}
                <input
                  id="upload-file"
                  name="file"
                  type="file"
                  required
                  class="max-w-full text-14 [[data-script]_&]:sr-only"
                />
              </label>
              {/* The board sends a file the moment it is chosen, which only the app script can do: without it, this
                  sends the form (an M2 Deviation). */}
              <span class="[[data-script]_&]:hidden">
                <Button variant="primary" type="submit">
                  Check this file
                </Button>
              </span>
              <div
                id="upload-alert"
                role="alert"
                tabindex={-1}
                class={cx(
                  "flex flex-col gap-8 rounded-card border-l-8 border-mal bg-mal-wash px-16 py-12 text-ink empty:hidden",
                  "group-data-[state=paused]/upload:border-sus group-data-[state=paused]/upload:bg-sus-wash",
                  "[&>p:first-child]:text-mal group-data-[state=paused]/upload:[&>p:first-child]:text-sus",
                  FOCUS,
                )}
              >
                {alert && <UploadAlertBody alert={alert} />}
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
                Not accepted: programs, archives and anything else. {OFFICE_NOT_TAKEN} Forward those by email instead,
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
