// The Meta models the service may call: Standard IDs only, never a `-contributor` one, whose input Meta may train on
// (spec 4.8). Each carries its Standard price as Meta lists it (captured in
// sources/meta-api/docs/docs/pricing-rate-limits.md), in US dollars, for the budget guard (D03 T01 §2).
export const PRICING_URL = "https://dev.meta.ai/docs/pricing-rate-limits";

export type ModelPrice =
  // Per million tokens, cached input at its own rate.
  | { unit: "token"; input: number; cached: number; output: number }
  | { unit: "image"; perImage: number }
  | { unit: "audio-second"; perSecond: number };

export const MODELS = {
  "muse-spark-1.3": { unit: "token", input: 1.25, cached: 0.15, output: 4.25 },
  "muse-wonder-1.0": { unit: "token", input: 4, cached: 0.2, output: 20 },
  // Image segmentation; video is priced per frame, and the service sends SAM still images only.
  "sam-3.1": { unit: "image", perImage: 2.5 / 1000 },
  "muse-image-1.0": { unit: "image", perImage: 0.01 },
  // US$0.18 an hour, metered in whole seconds.
  "muse-voice-transcribe-1.0": { unit: "audio-second", perSecond: 0.18 / 3600 },
} as const satisfies Record<string, ModelPrice>;

export type ModelId = keyof typeof MODELS;

export const isModelId = (model: unknown): model is ModelId =>
  typeof model === "string" && Object.hasOwn(MODELS, model);
