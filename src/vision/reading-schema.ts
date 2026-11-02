// The structured reading of a message's pictures (D03 T02 §3; design spec 4.4): Muse Spark reads the
// rendered email and the PDF pages as images and answers per image, because an email and its invoice can
// claim different identities. Every field is bounded, so a schema-valid answer is small enough to quote
// in evidence; absent values (no brand, no action, no cues) are stated, never invented.
import { z } from "zod";

export const READING_PROMPT_VERSION = "mail-reading-1";
export const READING_SCHEMA_VERSION = "mail-reading-1";
export const READING_MODEL = "muse-spark-1.3";
// The most images one reading covers: the desktop render first, then PDF pages in order.
export const MAX_READING_IMAGES = 6;

export const REQUESTED_ACTIONS = ["log_in", "pay", "open_file", "call", "reply_with_details", "none"] as const;
export type RequestedAction = (typeof REQUESTED_ACTIONS)[number];

// One image's reading, keyed to the identifier the call named it by. The identifiers are the caller's,
// so the schema is built per call: an answer naming an image that was not sent fails validation.
export function mailReadingSchema(imageIds: readonly string[]) {
  const reading = z
    .object({
      image: z.enum(imageIds as [string, ...string[]]),
      claimed_brand: z.string().min(1).max(120).nullable(),
      requested_action: z.enum(REQUESTED_ACTIONS),
      urgency_cues: z.array(z.string().min(1).max(200)).max(8),
      visible_sender: z.string().min(1).max(200).nullable(),
      payment_request: z.boolean(),
      confidence: z.number().min(0).max(1),
    })
    .strict();
  return z.object({ readings: z.array(reading).min(1).max(imageIds.length) }).strict();
}

export type MailReading = z.infer<ReturnType<typeof mailReadingSchema>>;
export type ImageReading = MailReading["readings"][number];
