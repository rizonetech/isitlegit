// A small form read with a bound, for routes whose forms are a few short fields (D07 T02 §14: the invitation page and
// sign-out): the body is read as a stream with a running count, so one without a Content-Length is bounded too, and
// anything over the bound is refused before it is parsed (null). Only the named fields are kept, each bounded again.
// The sign-in routes keep their own reader (src/auth/confirm.tsx) for their wider set of fields.
export const SMALL_FORM_BYTES = 8 * 1024;

export async function readSmallForm(
  request: Request,
  fields: Record<string, number>,
  maxBytes = SMALL_FORM_BYTES,
): Promise<Record<string, string> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
  const out: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(text)) {
    const limit = fields[name];
    if (limit !== undefined && value.length <= limit) out[name] = value;
  }
  return out;
}
