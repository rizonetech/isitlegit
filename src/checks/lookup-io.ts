// The plumbing the reputation lookups share (D02 T06 §1 and §2): a KV cache that never holds an answer back, a hash for
// identities, a request deadline that ends the lookup whether or not the fetch honours it, and a body read to a size
// limit under that deadline. One tested copy, so a fix reaches every lookup.

// KV is a cache: a read or write that takes longer than this, or fails, is given up, never holding a lookup's answer back.
export const CACHE_MS = 500;
// KV refuses a lifetime under a minute.
export const KV_MIN_TTL_S = 60;

export const bounded = <T>(work: Promise<T>, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), CACHE_MS);
    }),
  ]).finally(() => clearTimeout(timer));
};

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// One lookup's deadline: `signal` aborts when it passes, `expired` rejects then (so a fetch or a read that ignores the
// signal is still ended), and `finish` ends whatever is still open when the lookup does.
export function deadline(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
  });
  expired.catch(() => undefined);
  return {
    signal: controller.signal,
    expired,
    get passed() {
      return controller.signal.aborted;
    },
    finish() {
      clearTimeout(timer);
      controller.abort();
    },
  };
}

// An error answer's body is never read: let go of it, so a stalled one cannot hold the connection open.
export const letGo = (response: Response): void => {
  void response.body?.cancel().catch(() => undefined);
};

// At most `limit` bytes of a response as text: null when it is larger or cut off, "timeout" when the deadline passes
// first. The read is cancelled in both cases.
export async function boundedText(
  response: Response,
  limit: number,
  expired: Promise<never>,
): Promise<string | null | "timeout"> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.length;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    return (error as Error).message === "timeout" ? "timeout" : null;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}
