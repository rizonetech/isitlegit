// What a Meta call may cost and what it did cost (D03 T01 §2), at the Standard prices in ./models.ts. Its own module,
// with extensions on its imports, so the client (run by scripts under Node's type stripping) and the Worker's guard
// share one copy.
import { MODELS, type ModelId } from "./models.ts";

// What a call may cost at most, from what the request carries and the output it is allowed: input tokens counted from
// its size (a token is at least one byte of UTF-8 text in Meta's tokenisers, so bytes bound tokens from above), the
// output limit the request sets, each image, each audio second.
export type Bound = { inputBytes?: number; maxOutputTokens?: number; images?: number; audioSeconds?: number };

export function estimateUsd(model: ModelId, bound: Bound): number {
  const price = MODELS[model];
  switch (price.unit) {
    case "token":
      if (bound.maxOutputTokens === undefined) throw new Error(`budget: a call to ${model} must set its output limit`);
      return ((bound.inputBytes ?? 0) * price.input + bound.maxOutputTokens * price.output) / 1_000_000;
    case "image":
      return Math.max(1, bound.images ?? 1) * price.perImage;
    case "audio-second":
      if (bound.audioSeconds === undefined) throw new Error(`budget: a call to ${model} must give its audio length`);
      return Math.ceil(bound.audioSeconds) * price.perSecond;
  }
}

// What a call cost, from the usage Meta reported (validated: a field that is missing or not a non-negative number is
// read as unknown, and the caller settles at the estimate instead).
// As reported, so any field may be absent: `costUsd` validates each one.
export type Usage = {
  inputTokens?: number | undefined;
  cachedTokens?: number | undefined;
  outputTokens?: number | undefined;
  images?: number | undefined;
  audioSeconds?: number | undefined;
};

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function costUsd(model: ModelId, usage: Usage): number | null {
  const price = MODELS[model];
  switch (price.unit) {
    case "token": {
      const input = count(usage.inputTokens);
      const output = count(usage.outputTokens);
      if (input === undefined || output === undefined) return null;
      const cached = Math.min(count(usage.cachedTokens) ?? 0, input);
      return ((input - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000;
    }
    case "image": {
      const images = count(usage.images);
      return images === undefined ? null : images * price.perImage;
    }
    case "audio-second": {
      const seconds = count(usage.audioSeconds);
      return seconds === undefined ? null : Math.ceil(seconds) * price.perSecond;
    }
  }
}
