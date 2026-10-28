// The upload front door (D01 T03 §1; spec 4.1): a signed-in member sends one file to have it checked. The request is
// read bounded, the file sniffed from its bytes (./sniff.ts), and admitted through ./admit.ts like a forward: claimed
// within the organisation by the file's SHA-256 (the same file again within a day answers the first case), the case
// admitted under the daily cap, the file stored, the Workflow started, each step undone on failure. An upload has no
// forwarder, so no reply is mailed; the member reads the report (D07 T03). The upload page is D01 T03 §6.
import { Hono } from "hono";
import { requireSession } from "../auth/gate";
import { type OrgEnv, requireOrg } from "../auth/org";
import { admitDelivery, sha256Hex } from "./admit";
import { sniff } from "./sniff";
import { putAttachment, putRaw, type Store } from "./store";

// The largest file taken, as the email intake's limit (Email Routing's), and the room a multipart body adds around it.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const BODY_LIMIT = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES;

const problem = (status: 400 | 413 | 415 | 429 | 503, error: string) =>
  Response.json(
    { error },
    { status, headers: { "cache-control": "no-store", ...(status === 503 ? { "retry-after": "5" } : {}) } },
  );

export const uploadRoutes = new Hono<OrgEnv>();
uploadRoutes.use("*", requireSession, requireOrg);

uploadRoutes.post("/", async (c) => {
  // 1. The body, bounded: a declared length past the limit is refused unread, and one with none is read only so far.
  const declared = Number(c.req.header("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > BODY_LIMIT) return tooLarge();
  const body = await readBounded(c.req.raw.body, BODY_LIMIT);
  if (body === "too-large") return tooLarge();

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
  const file = entries[0]?.[1];
  if (entries.length !== 1 || entries[0]?.[0] !== "file" || typeof file === "string" || !file)
    return problem(400, "Send exactly one file, in a field named file, and nothing else.");
  if (file.size > MAX_UPLOAD_BYTES) return tooLarge();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) return problem(400, "The file is empty.");

  // 3. What it is, from its bytes.
  const sniffed = sniff(bytes);
  if ("refused" in sniffed) return problem(415, sniffed.refused);

  // 4. Claimed, admitted under the cap, stored, started.
  const store: Store = { bucket: c.env.ARTEFACTS, db: c.env.DB };
  let admitted: Awaited<ReturnType<typeof admitDelivery>>;
  try {
    admitted = await admitDelivery(c.env, {
      orgId: c.get("org").id,
      key: `upload:${await sha256Hex(bytes)}`,
      channel: "upload",
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
  } catch {
    // A step failed and was undone (RetryDelivery), or the service failed: either way, nothing is left half-made.
    return problem(503, "The file could not be taken just now. Try again in a moment.");
  }
  if (admitted.kind === "capped")
    return problem(429, "Today's checks for your organisation are used up. They reset at midnight.");
  if (admitted.kind === "duplicate") {
    if (!admitted.caseId) return problem(503, "The file could not be taken just now. Try again in a moment.");
    return c.json({ caseId: admitted.caseId, repeat: true }, 200, { "cache-control": "no-store" });
  }
  return c.json({ caseId: admitted.caseId }, 201, { "cache-control": "no-store" });
});

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
