// The upload page (D01 T03 §6; design/SPEC.md M2 Check a file, boards `Upload` and `Upload-States`): a member checks a
// file they did not get by email. `GET /upload` draws the drop zone, the accepted kinds and today's usage. The form posts
// to `POST /upload`, which hands the request to the upload API's own routes (src/intake/upload.ts, unchanged: one
// copy of the upload's rules) asking for JSON, and answers in the page's words: a 303 to the report, or the page again
// at the API's status with the refusal in its alert region. The app script sends the same form here by XMLHttpRequest
// for its progress (`x-upload-script`), and is answered the report's address in `x-location`, or the alert alone.

import type { Context } from "hono";
import { Hono } from "hono";
import { createAuth } from "../../auth/auth";
import type { GateEnv, SignedIn } from "../../auth/gate";
import { sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { todayUsage } from "../../db/case-list";
import { uploadRoutes } from "../../intake/upload";
import { AppShell } from "../components/AppShell";
import { Document } from "../components/Document";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import { SIGNIN_PATH } from "./signin";
import { alertFor, type UploadAlert, UploadAlertBody, UploadPage } from "./upload-view";

export const uploadPageRoutes = new Hono<GateEnv>();

// The file's name as the script sent it, percent-encoded; one that does not decode is no name, so a malformed header
// never turns a refusal into a server error.
function decodedName(header: string | undefined): string | null {
  try {
    return decodeURIComponent(header ?? "") || null;
  } catch {
    return null;
  }
}

// The alert alone, for the app script: marked as one (`x-upload-alert`), so anything else it is answered (a gateway's
// own error page) is never drawn inside the form.
const fragment = (alert: UploadAlert, status: number) =>
  new Response(String(<UploadAlertBody alert={alert} />), {
    status,
    headers: { ...HEADERS, "x-upload-alert": "1" },
  });

// The E5 page for a read that fails, its reference the one logged and Try again the page.
function outage(why: string) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "upload-page", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: "/upload" });
}

// The page for a signed-in member, with a refusal in its alert region when there is one.
async function drawn(c: Context<GateEnv>, signedIn: SignedIn, status: number, alert?: UploadAlert) {
  const membership = await activeMembership(c.env, signedIn);
  if (!membership.ok)
    return membership.reason === "unavailable"
      ? outage("membership")
      : errorPage(403, "", { email: signedIn.user.email, closed: membership.reason === "closed" });
  const [usage, shell] = await Promise.all([
    todayUsage(c.env.DB, membership.org.id),
    memberShell(c.env.DB, signedIn.user, membership.org.id, "cases"),
  ]);
  return new Response(
    String(
      <UploadPage shell={shell} org={shell.organization.name} usage={usage} {...(alert ? { alert, status } : {})} />,
    ),
    { status, headers: HEADERS },
  );
}

uploadPageRoutes.get(
  "/upload",
  sessionGate(() => outage("session")),
  async (c) => {
    try {
      return await drawn(c, c.get("signedIn"), 200);
    } catch (error) {
      return outage((error as Error).name);
    }
  },
);

uploadPageRoutes.post("/upload", async (c) => {
  const script = c.req.header("x-upload-script") === "1";
  const now = new Date();
  // The upload API's own routes, asked for JSON (the session gate answers a browser's HTML request with a redirect).
  const headers = new Headers(c.req.raw.headers);
  headers.set("accept", "application/json");
  const asked = new Request(new URL("/", c.req.url), {
    method: "POST",
    headers,
    body: c.req.raw.body,
    duplex: "half",
  } as RequestInit);
  const answer = await uploadRoutes.fetch(asked, c.env, c.executionCtx);
  const passOn = (res: Response) => {
    for (const cookie of answer.headers.getSetCookie()) res.headers.append("set-cookie", cookie);
    const after = answer.headers.get("retry-after");
    if (after) res.headers.set("retry-after", after);
    return res;
  };
  const body = (await answer.json().catch(() => ({}))) as { caseId?: string; error?: string };
  if ((answer.status === 201 || answer.status === 200) && body.caseId) {
    const report = `/r/${body.caseId}`;
    return passOn(
      script
        ? new Response(null, { status: 204, headers: { ...HEADERS, "x-location": report } })
        : new Response(null, { status: 303, headers: { ...HEADERS, location: report } }),
    );
  }
  // The name and size the script sent beside the file, for the board's words; a page without the script has neither.
  const sizeHeader = Number(c.req.header("x-file-size") ?? "NaN");
  const file = {
    name: script ? decodedName(c.req.header("x-file-name")) : null,
    size: script && Number.isFinite(sizeHeader) ? sizeHeader : null,
  };
  const error = body.error ?? "The file could not be taken just now. Try again in a moment.";
  if (answer.status === 401) {
    const alert = alertFor(401, error, file, null, now);
    if (script) return passOn(fragment(alert, 401));
    return passOn(
      new Response(
        String(
          <Document title="Check a file">
            <AppShell variant="public">
              <div id="upload-alert" role="alert" class="flex flex-col gap-8 p-24">
                <UploadAlertBody alert={alert} />
              </div>
            </AppShell>
          </Document>,
        ),
        { status: 401, headers: HEADERS },
      ),
    );
  }
  // Signed in (the API answered past its gate): the page drawn for that session, and for the daily-limit words the
  // organisation's name and limit.
  try {
    const signedIn = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
    const membership = signedIn ? await activeMembership(c.env, signedIn) : null;
    const usage =
      answer.status === 429 && membership?.ok
        ? {
            org:
              (
                await c.env.DB.prepare(`SELECT name FROM "organization" WHERE id = ?`)
                  .bind(membership.org.id)
                  .first<{ name: string }>()
              )?.name ?? "Your organisation",
            limit: (await todayUsage(c.env.DB, membership.org.id)).limit,
          }
        : null;
    const alert = alertFor(answer.status, error, file, usage, now);
    if (script) return passOn(fragment(alert, answer.status));
    if (!signedIn)
      return passOn(new Response(null, { status: 303, headers: { location: `${SIGNIN_PATH}?next=%2Fupload` } }));
    return passOn(await drawn(c, signedIn, answer.status, alert));
  } catch (failure) {
    // The script is answered an alert it can draw, never a whole error page inside its form.
    if (script) {
      const ref = reference(500);
      console.log(
        JSON.stringify({
          event: "upload-page",
          outcome: "unavailable",
          reference: ref,
          error: (failure as Error).name,
        }),
      );
      return fragment(
        {
          title: "The file could not be taken just now. Try again in a moment.",
          detail: `Reference ${ref}`,
          retry: true,
        },
        503,
      );
    }
    return outage((failure as Error).name);
  }
});
