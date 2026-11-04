import { expect, test } from "vitest";
import type { CaseView } from "../../src/checks/case-view";
import { htmlAttachmentEvidence, htmlAttachmentsOf, MAX_HTML_BYTES } from "../../src/checks/html-attachment";
import { linksOf } from "../../src/checks/links";

const attachment = (key: string) => ({
  key,
  filename: `${key}.html`,
  mediaType: "text/html",
  contentId: null,
  disposition: "attachment",
  bytes: 0,
});
test("parser memory rejection retains known risk and links, marks partial and continues attachments", async () => {
  const files = new Map([
    [
      "hostile",
      '<form action="https://forms.invalid/post"><input type="password"></form><a href="https://before.invalid/">Before</a><!--' +
        " ".repeat(MAX_HTML_BYTES),
    ],
    ["next", '<a href="https://after.invalid/">After</a>'],
  ]);
  const bucket = {
    get: async (key: string, options?: { range?: { length: number } }) => {
      const full = new TextEncoder().encode(files.get(key));
      const bytes = full.slice(0, options?.range?.length);
      return { size: full.length, arrayBuffer: async () => bytes.buffer };
    },
  } as unknown as R2Bucket;
  const attachments = [attachment("hostile"), attachment("next")];
  const htmlAttachments = await htmlAttachmentsOf(bucket, { attachments, attachmentHeads: null });
  expect(htmlAttachments?.unread).toBe(1);
  expect(htmlAttachments?.items[0]?.features.passwordField).toBe(true);
  expect(htmlAttachments?.items[0]?.links.unread).toContainEqual({ key: "hostile", why: "damaged" });
  const view = {
    source: { kind: "message", path: "rfc822", otherOriginals: 0 },
    text: null,
    html: null,
    truncated: [],
    attachments,
    attachmentHeads: null,
    htmlAttachments,
  } as unknown as CaseView;
  const links = await linksOf(bucket, view);
  expect(links?.items.map((l) => l.href)).toEqual(
    expect.arrayContaining(["https://forms.invalid/post", "https://before.invalid/", "https://after.invalid/"]),
  );
  expect(links?.unread).toContainEqual({ key: "hostile", why: "damaged" });
  expect(htmlAttachmentEvidence(view).find((e) => e.detail.checked === false)?.summary).toBe(
    "1 web-page attachment could not be read completely.",
  );
  expect(htmlAttachmentEvidence(view).some((e) => e.severity === "high" && e.detail.passwordField === true)).toBe(true);
});
test("storage and unrelated errors still propagate", async () => {
  for (const message of ["storage failed", "Parser error: The memory limit has been exceeded."]) {
    const bucket = {
      get: async () => {
        throw new Error(message);
      },
    } as unknown as R2Bucket;
    await expect(htmlAttachmentsOf(bucket, { attachments: [attachment("x")], attachmentHeads: null })).rejects.toThrow(
      message,
    );
  }
});
