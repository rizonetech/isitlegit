// The upload front door (D01 T03 §1; spec 4.1): a signed-in member sends one file to have it checked. The request is
// read bounded, the file sniffed from its bytes (./sniff.ts), and admitted through ./admit.ts like a forward: claimed
// within the organisation by the file's SHA-256 (as upload:sha256:<hex>, ./admit.ts) (the same file again within a day answers the first case), the case
// admitted under the daily cap, the file stored, the Workflow started; a case once made is never deleted (D01 T03 §12). An upload has no
// forwarder, so no reply is mailed; the member reads the report (D07 T03). The upload page is D01 T03 §6.
import { Hono } from "hono";
import { requireSession } from "../auth/gate";
import { type OrgEnv, requireOrg } from "../auth/org";
import { requireFeature } from "../auth/plans";
import type { CaseExperiment } from "../pipeline/ablate";
import {
  ExperimentRefused,
  experimentCapabilities,
  readCaseExperiment,
  requireEval,
  sameExperiment,
  validateExperiment,
} from "../pipeline/case-experiments";
import { admitDelivery, RetryDelivery, sha256Hex } from "./admit";
import { sniff } from "./sniff";
import { putAttachment, putRaw, type Store } from "./store";

// The largest file taken, as the email intake's limit (Email Routing's), and the room a multipart body adds around it.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const BODY_LIMIT = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES;

// Hands the admission to the request's `waitUntil`, settled or not (its outcome is the route's to answer); a context
// without one (a direct call in a script) keeps the plain await.
type Waiter = { waitUntil(promise: Promise<unknown>): void };
function keepAlive(c: { readonly executionCtx: Waiter }, work: Promise<unknown>) {
  let ctx: Waiter | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = null;
  }
  ctx?.waitUntil(work.catch(() => {}));
}

const problem = (status: 400 | 403 | 409 | 413 | 415 | 429 | 503, error: string, retryAfterMs = 5_000) =>
  Response.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(status === 503 ? { "retry-after": String(Math.ceil(retryAfterMs / 1000)) } : {}),
      },
    },
  );

export const uploadRoutes = new Hono<OrgEnv>();
uploadRoutes.use("*", requireSession, requireOrg);

uploadRoutes.get("/ablation-capabilities", async (c) => {
  try {
    return c.json(await experimentCapabilities(c.env, c.get("org").id), 200, { "cache-control": "no-store" });
  } catch (error) {
    return error instanceof ExperimentRefused
      ? problem(error.status, error.message)
      : problem(503, "Experiment capabilities are unavailable.");
  }
});

uploadRoutes.post("/", async (c) => {
  // 1. The body, bounded: a declared length past the limit is refused unread, and one with none is read only so far.
  const declared = Number(c.req.header("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > BODY_LIMIT) return tooLarge();
  // A connection that drops mid-upload is the member's to try again, answered like every other refusal.
  const body = await readBounded(c.req.raw.body, BODY_LIMIT).catch(() => "interrupted" as const);
  if (body === "too-large") return tooLarge();
  if (body === "interrupted")
    return problem(400, "The upload was interrupted before the whole file arrived. Try again.");

  // 2. One file, in the field `file`, and nothing else.
  let form: FormData;
  try {
    form = await new Request("https://upload.invalid/", {
      method: "POST",
      headers: { "content-type": c.req.header("content-type") ?? "" },
      body,
    }).formData();
  } catch {
    return problem(400, "Send the file as multipart/form-data in a field named file.");
  }
  const entries = [...form.entries()];
  const files = entries.filter(([name]) => name === "file");
  const replays = entries.filter(([name]) => name === "replayRunId");
  const experiments = entries.filter(([name]) => name === "ablate");
  const file = files[0]?.[1];
  if (
    files.length !== 1 ||
    replays.length > 1 ||
    experiments.length > 1 ||
    entries.length !== files.length + replays.length + experiments.length ||
    typeof file === "string" ||
    !file
  )
    return problem(
      400,
      "Send exactly one file in a field named file, and at most one replayRunId and ablate field, and nothing else.",
    );
  // A replay run id (D01 T01 §22): at most one textual field, a bounded identifier; anything else is refused
  // before anything is admitted, so an invalid request creates no claim, case, object or Workflow.
  const replayValue = replays[0]?.[1];
  if (replays.length === 1 && (typeof replayValue !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(replayValue)))
    return problem(400, "The replay run id is not valid: use 1 to 64 characters of letters, digits, - and _.");
  const replayRunId = typeof replayValue === "string" ? replayValue : null;
  let experiment: CaseExperiment | undefined;
  if (experiments.length) {
    try {
      requireEval(c.env, c.get("org").id);
      const value = experiments[0]?.[1];
      if (typeof value !== "string") return problem(400, "The ablate field must contain JSON text.");
      experiment = validateExperiment(c.env, c.get("org").id, JSON.parse(value), replayRunId);
    } catch (error) {
      return error instanceof ExperimentRefused
        ? problem(error.status, error.message)
        : problem(400, "The ablate field must contain valid experiment JSON.");
    }
  }
  if (file.size > MAX_UPLOAD_BYTES) return tooLarge();
  // What the file claims to be is kept for the type-mismatch check (D02 T04 §4), whole: a name cut short could lose the
  // extension being checked, so one past the limit is refused here, before anything is admitted (plan review).
  if (file.name.length > MAX_CLAIM_CHARS)
    return problem(400, `The file's name is longer than ${MAX_CLAIM_CHARS} characters. Rename it and try again.`);
  if (file.type.length > MAX_CLAIM_CHARS)
    return problem(
      400,
      `The file's media type is longer than ${MAX_CLAIM_CHARS} characters, which is not a media type.`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) return problem(400, "The file is empty.");

  // 3. What it is, from its bytes.
  const sniffed = sniff(bytes);
  if ("refused" in sniffed) return problem(415, sniffed.refused);
  if (sniffed.kind === "document" || sniffed.kind === "image") {
    const gated = await requireFeature("payment-document")(c, async () => {});
    if (gated) return gated;
  }

  // 4. Claimed, admitted under the cap, stored, started.
  const store: Store = { bucket: c.env.ARTEFACTS, db: c.env.DB };
  let admitted: Awaited<ReturnType<typeof admitDelivery>>;
  try {
    const admission = admitDelivery(c.env, {
      orgId: c.get("org").id,
      // The same file sent again under the same name and type is the same upload; a different name or type is a new
      // one, since what it claims is checked (plan review: a renamed re-upload kept the first case's claims).
      key: await uploadKey(bytes, file.name, file.type),
      channel: "upload",
      uploadedBy: c.get("signedIn").user.id,
      replayRunId,
      ...(experiment ? { experiment } : {}),
      // What the file claimed to be, kept apart from what its bytes are (D02 T04 §4), for the type-mismatch check.
      uploadName: file.name || null,
      uploadMediaType: file.type || null,
      sourceKind: sniffed.kind,
      headersAvailable: sniffed.kind === "mail" && sniffed.headersAvailable,
      store: async (caseId) => {
        if (sniffed.kind === "mail") await putRaw(store, caseId, bytes, sniffed.mediaType);
        else
          await putAttachment(
            store,
            caseId,
            file.name || `upload.${sniffed.mediaType.split("/")[1]}`,
            bytes,
            sniffed.mediaType,
          );
      },
    });
    // The admission finishes whatever the browser does (D01 T03 §12): Cloudflare may cancel a request's work when its
    // client disconnects, unless the work is handed to `waitUntil` (up to 30 seconds after; the sweep starts a stored
    // case whose admission stopped for good). It is still awaited for the answer.
    keepAlive(c, admission);
    admitted = await admission;
  } catch (error) {
    if (error instanceof ExperimentRefused) return problem(error.status, error.message);
    // A step failed (a case already made stays, ended partial, or is started by the sweep), or the service failed. The same file still
    // being taken by an earlier request is answered with the time until that one's lease runs out.
    if (error instanceof RetryDelivery && error.retryAfterMs > 5_000)
      return problem(
        503,
        "This file is still being taken from an earlier upload. Try again shortly.",
        error.retryAfterMs,
      );
    return problem(503, "The file could not be taken just now. Try again in a moment.");
  }
  if (admitted.kind === "capped")
    return problem(429, "Today's checks for your organisation are used up. They reset at midnight.");
  let attribution: { experiment?: CaseExperiment } = {};
  if (experiment) {
    try {
      const persisted = admitted.caseId ? await readCaseExperiment(c.env.DB, admitted.caseId, c.get("org").id) : null;
      if (!persisted || !sameExperiment(persisted, experiment))
        return problem(409, "The case attribution does not match this experiment.");
      attribution = { experiment: persisted };
    } catch {
      return problem(503, "The case attribution could not be read.");
    }
  }
  if (admitted.kind === "duplicate") {
    if (!admitted.caseId) return problem(503, "The file could not be taken just now. Try again in a moment.");
    return c.json({ caseId: admitted.caseId, repeat: true, ...attribution }, 200, { "cache-control": "no-store" });
  }
  return c.json({ caseId: admitted.caseId, ...attribution }, 201, { "cache-control": "no-store" });
});

// An upload's identity: its bytes with the name and media type it was sent with, in the shape an email's key has
// (`sha256:` and 64 hex digits). The same file sent again under the same name and type is a repeat; under another,
// a new case, since what it claims is checked (D02 T04 §4's plan review).
export async function uploadKey(bytes: Uint8Array, name: string, type: string): Promise<string> {
  return `sha256:${await sha256Hex(new TextEncoder().encode(`${await sha256Hex(bytes)}\u0000${name}\u0000${type}`))}`;
}

// The longest name or media type kept as the file's claim (migration 0043's columns).
export const MAX_CLAIM_CHARS = 255;

const tooLarge = () => problem(413, "The file is larger than 25 MB, which is the most that can be checked.");

// The body read until it ends or passes `limit`, when reading stops and the rest is abandoned.
async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | "too-large"> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
