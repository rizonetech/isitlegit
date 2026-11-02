// What a Meta call may cost and what it did cost (D03 T01 §2), at the Standard prices in ./models.ts. Its own module,
// with extensions on its imports, so the client (run by scripts under Node's type stripping) and the Worker's guard
// share one copy.
import { MODELS, type ModelId } from "./models.ts";

// What a call may cost at most, from what the request carries and the output it is allowed: input tokens counted from
// its size (a token is at least one byte of UTF-8 text in Meta's tokenisers, so bytes bound tokens from above), the
// output limit the request sets, each image, each audio second.
export type Bound = {
  inputBytes?: number;
  maxOutputTokens?: number;
  images?: number;
  audioSeconds?: number;
  // Web searches reserved for (D03 T02 §4): Meta documents no per-request search-count parameter,
  // so a grounded call reserves its cap and settles at the searches its answer reports.
  searches?: number;
};

// One web search (search grounding, pricing-rate-limits.md: US$2.50 per 1,000 search queries, plus tokens).
export const SEARCH_USD = 2.5 / 1000;

// An image's input tokens scale with its resolution, about 1,300 to 1,500 for a ~1280px image, with no fixed figure
// (sources/meta-api/docs/docs/image-understanding.md, "Image cost scales with resolution"); a token-priced call
// reserves this many for each image it sends, four times that figure, and the request's own formatting overhead
// (~110 tokens) on top, so an admitted call cannot cost more than it reserved (D03 T01 §2 completion review).
export const IMAGE_TOKEN_BOUND = 6_000;
export const REQUEST_OVERHEAD_TOKENS = 110;

export function estimateUsd(model: ModelId, bound: Bound): number {
  const price = MODELS[model];
  switch (price.unit) {
    case "token": {
      if (bound.maxOutputTokens === undefined) throw new Error(`budget: a call to ${model} must set its output limit`);
      const input = (bound.inputBytes ?? 0) + (bound.images ?? 0) * IMAGE_TOKEN_BOUND + REQUEST_OVERHEAD_TOKENS;
      return (
        (input * price.input + bound.maxOutputTokens * price.output) / 1_000_000 + (bound.searches ?? 0) * SEARCH_USD
      );
    }
    case "image":
      // Billed per image sent, one at least.
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
  // The searches a grounded answer itself reported (its `web_search_call` count, D03 T02 §4).
  searches?: number | undefined;
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
      return (
        ((input - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000 +
        (count(usage.searches) ?? 0) * SEARCH_USD
      );
    }
    case "image": {
      const images = count(usage.images);
      return images === undefined ? null : images * price.perImage;
    }
    case "audio-second": {
      // Billed in whole seconds, rounded down (https://dev.meta.ai/docs/pricing-rate-limits); the estimate rounds up.
      const seconds = count(usage.audioSeconds);
      return seconds === undefined ? null : Math.floor(seconds) * price.perSecond;
    }
  }
}
