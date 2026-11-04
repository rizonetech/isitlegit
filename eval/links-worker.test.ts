import { env } from "cloudflare:test";
import { test } from "vitest";
import type { CaseView } from "../src/checks/case-view";
import { htmlAttachmentsOf } from "../src/checks/html-attachment";
import { linksOf } from "../src/checks/links";

test("measure the loaded bytes with production extraction and HTML/SVG preparation", async ({ task }) => {
  const bindings = env as unknown as { LINK_CORPUS: string; LINK_REPEATS: number };
  const entries = JSON.parse(bindings.LINK_CORPUS) as {
    path: string;
    sha256: string;
    mediaType: string;
    base64: string;
  }[];
  const results = [];
  for (const entry of entries) {
    const bytes = Uint8Array.from(atob(entry.base64), (c) => c.charCodeAt(0));
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== entry.sha256) throw new Error("Worker payload hash mismatch");
    // Exact bytes and R2 range/full-size semantics; each call gets a fresh stream.
    const bucket = {
      get: async (key: string, options?: { range?: { offset: number; length: number } }) => {
        if (key !== entry.path) return null;
        const range = options?.range;
        const part = range ? bytes.slice(range.offset, range.offset + range.length) : bytes.slice();
        return { size: bytes.length, body: new Blob([part]).stream(), arrayBuffer: async () => part.buffer };
      },
    } as unknown as R2Bucket;
    const attachment = {
      key: entry.path,
      filename: entry.path,
      mediaType: entry.mediaType,
      bytes: bytes.length,
      contentId: null,
      disposition: "attachment",
    };
    const view: Parameters<typeof linksOf>[1] = {
      source: { kind: "message", path: "rfc822", otherOriginals: 0 },
      text: null,
      html: null,
      truncated:
        entry.mediaType === "text/plain"
          ? [{ key: entry.path, mediaType: entry.mediaType, charset: "utf-8", fullBytes: bytes.length, keptBytes: 0 }]
          : [],
      attachments: entry.mediaType === "text/plain" ? [] : [attachment],
      attachmentHeads: null,
      htmlAttachments: null,
    };
    let stable = "";
    const ms: number[] = [];
    let result: Awaited<ReturnType<typeof linksOf>> = null;
    let error: "parser-memory-limit" | null = null;
    for (let repeat = 0; repeat < bindings.LINK_REPEATS; repeat++) {
      const start = performance.now();
      try {
        view.htmlAttachments = await htmlAttachmentsOf(
          bucket,
          view as Pick<CaseView, "attachments" | "attachmentHeads">,
        );
        result = await linksOf(bucket, view);
      } catch (cause) {
        if (!(cause instanceof Error) || cause.message !== "Parser error: The memory limit has been exceeded.")
          throw cause;
        error = "parser-memory-limit";
        result = null;
      }
      ms.push(performance.now() - start);
      const serialized = JSON.stringify({ result, error });
      if (repeat && stable !== serialized) throw new Error(`nondeterministic extraction ${entry.path}`);
      stable = serialized;
    }
    if (!result && !error) throw new Error("unexpected refused extraction");
    const urls = [...new Set((result?.items ?? []).map((l) => l.href))];
    const coverage = error
      ? "refused"
      : result?.more || result?.unread.length
        ? urls.length
          ? "partial"
          : "unread"
        : "complete";
    results.push({
      path: entry.path,
      sha256: hash,
      urls,
      more: result?.more ?? 0,
      unread: result?.unread ?? [],
      coverage,
      error,
      ms,
    });
  }
  (task.meta as { linkResults?: unknown }).linkResults = results;
});
