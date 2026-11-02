// The one door to Meta's Model API (D03 T01 §1; spec 4.8, 9). Every call goes through AI Gateway `isitlegit`'s
// `custom-meta` route (META_GATEWAY_URL), with the Meta key as its bearer token and the gateway's Run token as
// `cf-aig-authorization`, the route D00 T01 §7's smoke proved live. The gateway is told to log each call's metadata and
// never its payload; a Responses call always carries `store: false`, whatever the caller set; a model outside the
// Standard IDs (./models.ts) is refused before anything is sent, so no `-contributor` model is ever called.
//
// One owner for retries, this module: the SDK's own are off (it would also retry 408 and 409, and wait up to ten
// minutes). Only the statuses Meta documents as retryable are tried again (429, 500, 502, 503; a 504 is not, as Meta
// advises), at most three attempts, all inside one deadline that also bounds reading the answer. Every failure leaves
// as a ModelError with a kind, keeping Meta's status and its identifier fields (type, code, param) and, for each attempt,
// the gateway's log id and Meta's request id to trace it by; never Meta's free-text message, which can echo what was
// sent (a rejected value, an image URL it could not fetch), a payload or a credential.
import OpenAI from "openai";
import type {
  Response as MetaResponse,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
// With its extension: scripts/meta-client-live.ts runs this module under Node's type stripping, which resolves no
// extensionless path.
import {
  type Budget,
  BudgetExceeded,
  BudgetUnavailable,
  type Call,
  charged,
  type Described,
  type Owner,
} from "./guard.ts";
import { ENDPOINTS, type Endpoint, isModelId, MODELS, type ModelId } from "./models.ts";
import { estimateUsd, SEARCH_CONTEXT_TOKENS } from "./pricing.ts";

export // How long a timed-out call waits for its aborted attempt's record to be written before it throws.
const RECORD_GRACE_MS = 2_000;
export const DEFAULT_DEADLINE_MS = 60_000;
export const MAX_ATTEMPTS = 3;
// A Retry-After longer than this is not waited for: the call ends, carrying it, and the caller's step decides.
export const MAX_RETRY_AFTER_MS = 20_000;
// The largest answer read: an image edit's base64 images fit with room to spare; a larger body is refused as it streams,
// never buffered whole.
export const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
// The lowest bitrate a speech recording is sent at (Opus at 4 kbps is 500 bytes a second): a clip's size divided by this
// bounds its length from above.
export const MIN_AUDIO_BYTES_PER_SECOND = 500;
const BACKOFF_MS = 1_000;
const RETRIED = new Set([429, 500, 502, 503]);
// What an identifier field (Meta's type, code and param; the gateway's and Meta's ids) may hold to be kept: a name,
// a field path such as images[0].image_url, or an id. Anything else is dropped, never shortened.
const IDENTIFIER = /^[A-Za-z0-9_.:[\]-]{1,80}$/;

export type MetaEnv = { META_API_KEY?: string; CF_AIG_TOKEN?: string; META_GATEWAY_URL?: string };
export type MetaContext = {
  env: MetaEnv;
  // The caps (D03 T01 §2): every attempt is reserved here before it is sent and settled after. Required, so no call
  // can be made outside the budget.
  budget: Budget;
  // Who the call is for (D03 T01 §3): every attempt's record and the gateway's metadata carry it. Required, so every
  // cost is attributed.
  owner: Owner;
  // The whole call, every attempt and every wait between them included.
  deadlineMs?: number;
  // The caller's own absolute deadline, when it has one: re-read at every send, so work that expired
  // while the request was being prepared (serialised, reserved) starts no transport attempt.
  expired?: () => boolean;
  // Search grounding, opened only for the grounded brand call (D03 T02 §4): its presence is what
  // lets a `web_search*` tool past the refusal below, and `maxSearches` is the cap the reservation
  // prices and the caller accepts against (Meta documents no per-request search-count parameter).
  search?: { maxSearches: number };
  // Keeps an attempt's record write alive past the call's deadline (a Workflow step's or a request's own waitUntil).
  waitUntil?: (promise: Promise<unknown>) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  // A caller that bounds its paid attempts across layers (D03 T04 §45's two-call ceiling) caps this call's transport
  // attempts; absent, the client's own three attempts stand.
  transportAttempts?: number;
};
// What came back, with the gateway's id for the call's log (D03 T01 §3 reads it).
// An answer, with the call it belongs to (D03 T01 §5: the structured-output helper marks a paid answer that failed its
// schema on that call's record).
export type MetaAnswer<T> = { data: T; logId: string | null; callId: string };
type Sent<T> = { data: T; logId: string | null };

export type ModelErrorKind =
  | "refused-model"
  | "config"
  | "auth"
  | "billing"
  | "content-policy"
  | "invalid-request"
  | "rate-limit"
  | "server"
  | "timeout"
  | "network"
  | "malformed";

// A file the server must fetch (a file id or a file URL, or an `input_file` carrying neither) is billed by
// content the request does not carry, so it cannot be bounded before it is sent and is refused. An inline
// `file_data` is content the request does carry: its bytes are counted by the same estimate as any text, so
// it is bounded and sent (D06 T01 §1; coordinator decision 2026-11-02, narrowing the D03 T01 §2 refusal,
// which had refused every `input_file` including the inline form).
function hasUnboundedFile(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnboundedFile);
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("file_id" in o || "file_url" in o) return true;
    if (o.type === "input_file" && typeof o.file_data !== "string") return true;
    return Object.values(o).some(hasUnboundedFile);
  }
  return false;
}

// One attempt that failed, with what traces it: the gateway's log id (cf-aig-log-id) and Meta's (x-request-id).
export type FailedAttempt = { kind: ModelErrorKind; status?: number; logId: string | null; requestId: string | null };
export type ModelErrorDetails = {
  // The call this failure ends, so a caller can name every paid call it made (D03 T04 §45).
  callId?: string;
  status?: number;
  type?: string | null;
  code?: string | null;
  param?: string | null;
  retryAfterMs?: number;
  logId?: string | null;
  requestId?: string | null;
  // Every failed attempt of the call, in order, on the error that ends it.
  attempts?: FailedAttempt[];
};

// Plain fields rather than parameter properties: Node's type stripping (the live script) refuses syntax that emits code.
export class ModelError extends Error {
  override name = "ModelError";
  readonly kind: ModelErrorKind;
  readonly details: ModelErrorDetails;
  constructor(kind: ModelErrorKind, message: string, details: ModelErrorDetails = {}) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

export type ResponsesParams = Omit<ResponseCreateParamsNonStreaming, "model" | "stream" | "store"> & {
  model: string;
  store?: boolean | null;
};

export async function metaResponses(params: ResponsesParams, ctx: MetaContext): Promise<MetaAnswer<MetaResponse>> {
  const call: Call = { callId: crypto.randomUUID(), owner: ctx.owner };
  const { model, apiKey, token, base } = await preflight(ctx, call, params.model, () => {
    const model = standard(params.model, "responses");
    // The output limit bounds what a call can cost (D03 T01 §2): a call without one cannot be reserved for.
    if (!Number.isInteger(params.max_output_tokens) || (params.max_output_tokens as number) < 1)
      throw new ModelError(
        "invalid-request",
        "a Responses call must set max_output_tokens, which the budget reserves for",
      );
    // What the budget cannot bound before the call is refused before it (D03 T01 §2 final review): web search is billed
    // per query with no per-request cap Meta documents (D03 T02 §4 budgets it), and a file the server fetches (a file id,
    // a file URL, an input file such as a PDF) is billed by its content, which the request does not carry. Grounding is
    // open only on a context carrying its search cap (D03 T02 §4): every other caller still refuses.
    if ((params.tools ?? []).some((tool) => String((tool as { type?: unknown }).type).startsWith("web_search"))) {
      const cap = ctx.search?.maxSearches;
      if (!Number.isInteger(cap) || (cap as number) < 1)
        throw new ModelError("invalid-request", "web search is not budgeted yet; a call cannot use it");
    }
    if (hasUnboundedFile(params))
      throw new ModelError(
        "invalid-request",
        "a server-referenced file cannot be bounded before it is sent; send its content inline",
      );
    return { model, ...settings(ctx.env) };
  });
  const seen = observe(ctx.fetch ?? fetch);
  const client = new OpenAI({
    apiKey,
    baseURL: base,
    defaultHeaders: { ...gatewayHeaders(token), ...(await metadataHeader(ctx.owner)) },
    fetch: seen.fetch,
    maxRetries: 0,
    timeout: ctx.deadlineMs ?? DEFAULT_DEADLINE_MS,
  });
  // Forced last, so no caller's `store` reaches Meta.
  const body: ResponseCreateParamsNonStreaming = { ...params, model, stream: false, store: false };
  const json = JSON.stringify(body);
  const images = imagesIn(json);
  // An image's data is priced as an image (IMAGE_TOKEN_BOUND), not as the characters that carry it: only an
  // `image_url` value is left out, never text that happens to start "data:" (round 1).
  const text = JSON.stringify(body, (key, value) =>
    key === "image_url" && typeof value === "string" && value.startsWith("data:") ? "" : value,
  );
  const groundedCall = (params.tools ?? []).some((tool) =>
    String((tool as { type?: unknown }).type).startsWith("web_search"),
  );
  const estimate = estimateUsd(model, {
    // A grounded call also reserves the retrieved context its searches may bring back, which the
    // request's own bytes cannot bound (D03 T02 §4): the day and total caps in the budget refuse
    // the reservation before anything is sent when they cannot pay for it.
    inputBytes:
      new TextEncoder().encode(text).byteLength +
      (groundedCall ? (ctx.search?.maxSearches ?? 0) : 0) * SEARCH_CONTEXT_TOKENS,
    maxOutputTokens: params.max_output_tokens as number,
    images,
    // A grounded call reserves its whole search cap; its answer settles at the searches it reports.
    searches: groundedCall ? (ctx.search?.maxSearches ?? 0) : 0,
  });
  let answer: { data: MetaResponse; logId: string | null };
  try {
    answer = await withRetries(ctx, seen, (signal, n) => {
      let requestId: string | null = null;
      return charged(
        ctx.budget,
        model,
        estimate,
        n,
        async () => {
          if (ctx.expired?.())
            throw new ModelError("timeout", "the caller's deadline passed before the request was sent");
          const { data, response } = await client.responses.create(body, { signal, maxRetries: 0 }).withResponse();
          requestId = traced(response.headers).requestId;
          if (!isResponse(data))
            throw new ModelError("malformed", "Meta's answer is not a response object", {
              status: response.status,
              ...traced(response.headers),
            });
          return { data, logId: traced(response.headers).logId };
        },
        ({ data, logId }) => ({
          usage: {
            inputTokens: data.usage?.input_tokens,
            cachedTokens: data.usage?.input_tokens_details?.cached_tokens,
            outputTokens: data.usage?.output_tokens,
            // SAM is billed per image sent, one at least.
            images: Math.max(1, images),
            // The searches this answer itself ran, counted from its own output (D03 T02 §4).
            searches: (data.output ?? []).filter((item) => item.type === "web_search_call").length,
          },
          logId,
          requestId,
          // A token model's usage is Meta's when the answer carries it; SAM's images are counted from the request.
          reported: MODELS[model].unit === "token" && data.usage !== undefined,
        }),
        call,
        undefined,
        (error) => describeFailure(error, seen.last),
      );
    });
  } catch (error) {
    if (error instanceof ModelError && !error.details.callId) error.details.callId = call.callId;
    throw error;
  }
  return { ...answer, callId: call.callId };
}

// The streaming sibling of `metaResponses` (D03 T03 §1): same gateway, ledger, retry and `store: false`
// rules, but the answer is read as events to its end, because SAM's segmentation only completes on
// `response.completed`. Settlement happens after the stream is consumed, at the usage the completed
// response carries; a stream that ends without one settles as unreported and the caller reads the
// absence as an incomplete answer, never as an empty success. The deadline covers consumption: the
// retry loop's own deadline aborts the transport, and the caller's expiry is re-read at the send.
export type StreamedResponse = { events: ResponseStreamEvent[]; response: MetaResponse | null };
const MAX_STREAM_EVENTS = 10_000;

export async function metaResponsesStream(
  params: ResponseCreateParamsStreaming,
  ctx: MetaContext,
): Promise<MetaAnswer<StreamedResponse>> {
  const call: Call = { callId: crypto.randomUUID(), owner: ctx.owner };
  const { model, apiKey, token, base } = await preflight(ctx, call, params.model, () => {
    const model = standard(params.model, "responses");
    if ((params.tools ?? []).some((tool) => String((tool as { type?: unknown }).type).startsWith("web_search")))
      throw new ModelError("invalid-request", "web search is not budgeted yet; a call cannot use it");
    if (hasUnboundedFile(params))
      throw new ModelError(
        "invalid-request",
        "a server-referenced file cannot be bounded before it is sent; send its content inline",
      );
    // A token-priced stream reserves against its output limit like any Responses call; an
    // image-priced one (SAM) is reserved per image and needs none.
    if (
      MODELS[model].unit === "token" &&
      (!Number.isInteger(params.max_output_tokens) || (params.max_output_tokens as number) < 1)
    )
      throw new ModelError(
        "invalid-request",
        "a streamed Responses call to a token model must set max_output_tokens, which the budget reserves for",
      );
    return { model, ...settings(ctx.env) };
  });
  const seen = observe(ctx.fetch ?? fetch);
  const client = new OpenAI({
    apiKey,
    baseURL: base,
    defaultHeaders: { ...gatewayHeaders(token), ...(await metadataHeader(ctx.owner)) },
    fetch: seen.fetch,
    maxRetries: 0,
    timeout: ctx.deadlineMs ?? DEFAULT_DEADLINE_MS,
  });
  const body: ResponseCreateParamsStreaming = { ...params, model, stream: true, store: false };
  const json = JSON.stringify(body);
  const images = imagesIn(json);
  const text = JSON.stringify(body, (key, value) =>
    key === "image_url" && typeof value === "string" && value.startsWith("data:") ? "" : value,
  );
  const estimate = estimateUsd(model, {
    inputBytes: new TextEncoder().encode(text).byteLength,
    maxOutputTokens: typeof params.max_output_tokens === "number" ? params.max_output_tokens : 0,
    images,
  });
  const answer = await withRetries(ctx, seen, (signal, n) => {
    let requestId: string | null = null;
    return charged(
      ctx.budget,
      model,
      estimate,
      n,
      async () => {
        if (ctx.expired?.())
          throw new ModelError("timeout", "the caller's deadline passed before the request was sent");
        const { data: stream, response: raw } = await client.responses
          .create(body, { signal, maxRetries: 0 })
          .withResponse();
        requestId = traced(raw.headers).requestId;
        const events: ResponseStreamEvent[] = [];
        let completed: MetaResponse | null = null;
        for await (const event of stream) {
          events.push(event);
          if (events.length > MAX_STREAM_EVENTS)
            throw new ModelError("malformed", "Meta's stream carried more events than a call may hold");
          if (event.type === "response.completed") completed = event.response;
        }
        return { data: { events, response: completed }, logId: traced(raw.headers).logId };
      },
      ({ data, logId }) => ({
        usage: {
          inputTokens: data.response?.usage?.input_tokens,
          cachedTokens: data.response?.usage?.input_tokens_details?.cached_tokens,
          outputTokens: data.response?.usage?.output_tokens,
          images: Math.max(1, images),
        },
        logId,
        requestId,
        reported: MODELS[model].unit === "token" && data.response?.usage !== undefined,
      }),
      call,
      undefined,
      (error) => describeFailure(error, seen.last),
    );
  });
  return { ...answer, callId: call.callId };
}

// The endpoints the SDK route does not cover, each with its own wire contract: transcription is multipart, a `request`
// part (the settings as JSON) and an `audio` part (sources/meta-api/docs/docs/api-reference/voice/transcribe.md); an
// image edit is JSON (.../images/edit-image.md). Any other path is refused before the network.
// `audioSeconds` is the recording's length, which the budget reserves for (D03 T01 §2).
export type TranscribeBody = {
  request: { model: string } & Record<string, unknown>;
  audio: Blob;
  filename?: string;
  audioSeconds: number;
};
export type ImageEditBody = { model: string } & Record<string, unknown>;
export const RAW_PATHS = ["/asr/transcribe", "/images/edits"] as const;
export type RawPath = (typeof RAW_PATHS)[number];

export function metaRaw(path: "/asr/transcribe", body: TranscribeBody, ctx: MetaContext): Promise<MetaAnswer<unknown>>;
export function metaRaw(path: "/images/edits", body: ImageEditBody, ctx: MetaContext): Promise<MetaAnswer<unknown>>;
export async function metaRaw(
  path: RawPath,
  body: TranscribeBody | ImageEditBody,
  ctx: MetaContext,
): Promise<MetaAnswer<unknown>> {
  if (!(RAW_PATHS as readonly string[]).includes(path))
    throw new ModelError("invalid-request", `${String(path).slice(0, 80)} is not an endpoint this client sends to`);
  const call: Call = { callId: crypto.randomUUID(), owner: ctx.owner };
  const asked = path === "/asr/transcribe" ? (body as TranscribeBody).request.model : (body as ImageEditBody).model;
  // A PCM WAV's own length, read from its header before the reservation (D01 T03 §3); null for anything else.
  const pcmSeconds = path === "/asr/transcribe" ? await wavSeconds((body as TranscribeBody).audio) : null;
  const { payload, contentType, model, estimate, usage, apiKey, token, base } = await preflight(
    ctx,
    call,
    asked,
    () => {
      let payload: BodyInit;
      let contentType: Record<string, string> = {};
      let model: ModelId;
      let estimate: number;
      let usage: Units;
      if (path === "/asr/transcribe") {
        const { request, audio, filename, audioSeconds } = body as TranscribeBody;
        model = standard(request.model, "/asr/transcribe");
        if (!(Number.isFinite(audioSeconds) && audioSeconds > 0))
          throw new ModelError(
            "invalid-request",
            "a transcription must give its audio length, which the budget reserves for",
          );
        // Never less than the recording could hold: a given length is checked against the clip's size at the lowest
        // bitrate speech codecs use (D03 T01 §2 final review), so a short length cannot admit a long recording. A
        // well-formed PCM WAV, the format this endpoint takes, holds exactly its bytes at its byte rate: at the floor's
        // 500 bytes a second its 32,000 would reserve 64 times its cost and refuse it while credit remains (D01 T03 §3).
        estimate = estimateUsd(model, {
          audioSeconds: Math.max(audioSeconds, pcmSeconds ?? audio.size / MIN_AUDIO_BYTES_PER_SECOND),
        });
        // Meta reports the recording's length as `audioDurationMs` (sources/meta-api/docs: the transcribe response).
        // Without it the length billed is unknown: the call settles at its reservation, marked estimated, never at the
        // length the caller gave (round 3).
        usage = (data) => {
          const ms = numberAt(data, "audioDurationMs");
          return { audioSeconds: ms === undefined ? undefined : ms / 1000, reported: ms !== undefined };
        };
        const form = new FormData();
        form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
        form.append("audio", audio, filename ?? "audio");
        payload = form;
      } else {
        model = standard((body as ImageEditBody).model, "/images/edits");
        const asked = (body as ImageEditBody).n;
        const count = typeof asked === "number" && asked >= 1 ? asked : 1;
        estimate = estimateUsd(model, { images: count });
        // The images returned are Meta's count; without them, the count asked for is used and labelled estimated.
        usage = (data) => {
          const made = (data as { data?: unknown } | null)?.data;
          return Array.isArray(made) ? { images: made.length, reported: true } : { images: count, reported: false };
        };
        payload = JSON.stringify(body);
        contentType = { "content-type": "application/json" };
      }
      return { payload, contentType, model, estimate, usage, ...settings(ctx.env) };
    },
  );
  const seen = observe(ctx.fetch ?? fetch);
  const headers = { ...gatewayHeaders(token), ...(await metadataHeader(ctx.owner)) };
  const answer = await withRetries(ctx, seen, (signal, n) => {
    let requestId: string | null = null;
    return charged(
      ctx.budget,
      model,
      estimate,
      n,
      async () => {
        const { requestId: id, ...answer } = await rawAttempt(
          seen,
          base,
          path,
          apiKey,
          headers,
          contentType,
          payload,
          signal,
        );
        requestId = id;
        return answer;
      },
      ({ data, logId }) => {
        const { reported, ...units } = usage(data);
        return { usage: units, logId, requestId, reported };
      },
      call,
      undefined,
      (error) => describeFailure(error, seen.last),
    );
  });
  return { ...answer, callId: call.callId };
}

async function rawAttempt(
  seen: Observed,
  base: string,
  path: RawPath,
  apiKey: string,
  gateway: Record<string, string>,
  contentType: Record<string, string>,
  payload: BodyInit,
  signal: AbortSignal,
): Promise<Sent<unknown> & { requestId: string | null }> {
  const response = await seen.fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      ...contentType,
      ...gateway,
    },
    body: payload,
    signal,
  });
  const text = await response.text();
  let data: unknown;
  let parsed = true;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = false;
  }
  if (!response.ok) throw statusError(response.status, response.headers, parsed ? data : undefined);
  if (!parsed || typeof data !== "object" || data === null)
    throw new ModelError("malformed", `Meta's answer from ${path} is not a JSON object`, {
      status: response.status,
      ...traced(response.headers),
    });
  return { data, ...traced(response.headers) };
}

// The images a Responses request sends: SAM is billed by them (one at least, ./pricing.ts), and a token-priced model
// reserves IMAGE_TOKEN_BOUND for each.
const imagesIn = (json: string) => (json.match(/"type":"input_image"/g) ?? []).length;

// A non-negative number at a field of an answer, or undefined.
const numberAt = (data: unknown, field: string) => {
  const value = (data as Record<string, unknown> | null)?.[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
};

type Units = (data: unknown) => { audioSeconds?: number | undefined; images?: number; reported: boolean };

// A request refused before it is sent (a model this service may not call, a request the budget cannot bound, missing
// settings): its record, costing nothing, is written before the refusal is thrown, so the trace and the case's cost see
// it (D03 T01 §3 final review). A record that cannot be written is logged; the refusal stands either way.
async function preflight<T>(ctx: MetaContext, call: Call, model: unknown, check: () => T): Promise<T> {
  try {
    return check();
  } catch (error) {
    if (error instanceof ModelError)
      await ctx.budget
        .refused(String(model).slice(0, 80), call, error.kind)
        .catch(() => console.error(JSON.stringify({ event: "meta", outcome: "refusal-unrecorded", kind: error.kind })));
    throw error;
  }
}

function standard(model: unknown, endpoint: Endpoint): ModelId {
  if (!isModelId(model))
    throw new ModelError(
      "refused-model",
      `${String(model).slice(0, 80)} is not a Standard model this service may call (spec 4.8)`,
    );
  if (ENDPOINTS[model] !== endpoint)
    throw new ModelError("refused-model", `${model} is not called through ${endpoint}, but ${ENDPOINTS[model]}`);
  return model;
}

function settings(env: MetaEnv) {
  const missing = (["META_API_KEY", "CF_AIG_TOKEN", "META_GATEWAY_URL"] as const).filter((name) => !env[name]);
  if (missing.length) throw new ModelError("config", `${missing.join(", ")} not set`);
  return {
    apiKey: env.META_API_KEY as string,
    token: env.CF_AIG_TOKEN as string,
    base: (env.META_GATEWAY_URL as string).replace(/\/+$/, ""),
  };
}

// The gateway logs each call's metadata (it logs nothing by default, D00 T01 §6) and never its body.
// The call's owner as the gateway's opaque metadata (D03 T01 §3), so its log filters by case or monitor run: ids and
// the step only, the host as a hash, never a name, an address or content.
// How many seconds a PCM WAV holds, from its own header and the bytes actually present (D01 T03 §3), or null when it
// is not a fully well-formed one: RIFF/WAVE, a `fmt ` chunk of PCM (format 1) at 16 bits, one to two channels, a rate
// from 8 to 48 kHz, a block align and a byte rate that agree with them, then a `data` chunk inside the blob. The length
// counts every byte from the data chunk to the end of the blob, never the size the header declares, so neither a
// shrunk declared size nor trailing chunks can make it less than what is sent; anything else falls back to the floor.
const WAV_HEADER_BYTES = 4096;
export async function wavSeconds(audio: Blob): Promise<number | null> {
  if (audio.size < 44) return null;
  const head = new Uint8Array(await audio.slice(0, WAV_HEADER_BYTES).arrayBuffer());
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (at: number) => String.fromCharCode(...head.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let byteRate: number | null = null;
  for (let at = 12; at + 8 <= head.length; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > head.length) return null;
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const rate = view.getUint32(body + 4, true);
      const rateBytes = view.getUint32(body + 8, true);
      const align = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      if (format !== 1 || bits !== 16 || channels < 1 || channels > 2 || rate < 8_000 || rate > 48_000) return null;
      if (align !== channels * 2 || rateBytes !== rate * align) return null;
      byteRate = rateBytes;
    } else if (id === "data") {
      return byteRate ? (audio.size - body) / byteRate : null;
    }
    at = body + size + (size % 2);
  }
  return null;
}

export async function metadataHeader(owner: Owner): Promise<Record<string, string>> {
  const fields: Record<string, string> =
    owner.kind === "case"
      ? { case: owner.caseId, step: owner.step }
      : owner.kind === "monitor"
        ? { run: owner.run, host: await hostHash(owner.host), step: owner.step }
        : { script: owner.name };
  return { "cf-aig-metadata": JSON.stringify(fields) };
}

const hostHash = async (host: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(host.toLowerCase())))]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const gatewayHeaders = (token: string) => ({
  "cf-aig-authorization": `Bearer ${token}`,
  "cf-aig-collect-log": "true",
  "cf-aig-collect-log-payload": "false",
});

const isResponse = (data: unknown): data is MetaResponse =>
  typeof data === "object" && data !== null && Array.isArray((data as { output?: unknown }).output);

// The transport, noting each response's status and headers the moment they arrive, before its body is read: an attempt
// whose body then fails (cut off, stalled to the deadline, unparsable) still has its status and trace ids.
type Seen = { status: number; headers: Headers };
type Observed = { fetch: typeof fetch; last: Seen | null };
function observe(send: typeof fetch): Observed {
  const observed: Observed = {
    last: null,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await send(input, init);
      observed.last = { status: response.status, headers: response.headers };
      if (!response.body) return response;
      let read = 0;
      const bounded = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            read += chunk.byteLength;
            if (read > MAX_ANSWER_BYTES)
              controller.error(new ModelError("malformed", `Meta's answer is larger than ${MAX_ANSWER_BYTES} bytes`));
            else controller.enqueue(chunk);
          },
        }),
      );
      return new Response(bounded, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }) as typeof fetch,
  };
  return observed;
}

// A failure, completed from what its attempt's response showed before the body failed: an error status whose body
// could not be read is still that status (so a cut-off 503 is retried), and the trace ids are kept either way.
// A failed attempt as its record keeps it (D03 T01 §3, completion review C1): the client's own kind for it, its status
// and the gateway's and Meta's ids, read before the attempt's record is written.
// The same, for a caller with its own transport (scripts/meta-smoke.ts): what the error itself carries.
export const describeError = (error: unknown): Described => describeFailure(error, null);

function describeFailure(error: unknown, last: Seen | null): Described {
  const failure = completed(classify(error), last);
  return {
    errorClass: failure.kind,
    status: failure.details.status,
    logId: failure.details.logId ?? null,
    requestId: failure.details.requestId ?? null,
  };
}

function completed(failure: ModelError, seen: Seen | null): ModelError {
  if (!seen) return failure;
  if (failure.details.status === undefined && seen.status >= 400 && failure.kind !== "timeout")
    return statusError(seen.status, seen.headers, undefined);
  const ids = traced(seen.headers);
  failure.details.status ??= seen.status;
  failure.details.logId ??= ids.logId;
  failure.details.requestId ??= ids.requestId;
  return failure;
}

async function withRetries<T>(
  ctx: MetaContext,
  seen: Observed,
  attempt: (signal: AbortSignal, n: number) => Promise<T>,
): Promise<T> {
  const deadlineMs = ctx.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = ctx.random ?? Math.random;
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One deadline over every attempt and wait: a body that stalls ends the call here even if the read never would.
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelError("timeout", `no answer from Meta within ${deadlineMs} ms`));
    }, deadlineMs);
  });
  expired.catch(() => {});
  const attempts: FailedAttempt[] = [];
  // The call's end carries every attempt that failed, so each can be found in the gateway's log.
  const end = (failure: ModelError) => {
    failure.details.attempts = attempts;
    return failure;
  };
  try {
    for (let n = 1; ; n++) {
      seen.last = null;
      // The caller's deadline, re-read before every attempt: a retry or repair that starts after it
      // sends nothing.
      if (ctx.expired?.())
        throw end(new ModelError("timeout", "the caller's deadline passed before the request was sent"));
      const inflight = attempt(controller.signal, n);
      try {
        return await Promise.race([inflight, expired]);
      } catch (error) {
        // At the deadline the transport is aborted, so the attempt ends and writes its record (D03 T01 §3 final review):
        // that write is kept alive past this call, and awaited briefly, so a timed-out attempt is not left reserved.
        if (controller.signal.aborted) {
          const recorded = inflight.then(
            () => {},
            () => {},
          );
          ctx.waitUntil?.(recorded);
          await Promise.race([recorded, new Promise((resolve) => setTimeout(resolve, RECORD_GRACE_MS))]);
        }
        // A cap's refusal, or a budget that could not be reached: nothing was sent, and trying again cannot help.
        if (error instanceof BudgetExceeded || error instanceof BudgetUnavailable) throw error;
        const failure = completed(classify(error), seen.last);
        const { status, retryAfterMs } = failure.details;
        attempts.push({
          kind: failure.kind,
          ...(status !== undefined ? { status } : {}),
          logId: failure.details.logId ?? null,
          requestId: failure.details.requestId ?? null,
        });
        const limit = Math.min(MAX_ATTEMPTS, Math.max(1, ctx.transportAttempts ?? MAX_ATTEMPTS));
        if (n >= limit || status === undefined || !RETRIED.has(status)) throw end(failure);
        // A wait longer than this call may take ends it as rate-limit, carrying the wait, whatever the status: Meta
        // sends a 503 `service_overloaded` with Retry-After: 60 (sources/meta-api/docs/docs/error-handling.md), and a
        // caller that retried a plain `server` failure at once would ignore it.
        if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS)
          throw end(
            failure.kind === "rate-limit"
              ? failure
              : new ModelError(
                  "rate-limit",
                  `${failure.message}, asking to wait ${Math.ceil(retryAfterMs / 1000)} s`,
                  failure.details,
                ),
          );
        // Meta's Retry-After when it gave one, else 1 s then 2 s with full jitter.
        const wait = retryAfterMs ?? random() * BACKOFF_MS * 2 ** (n - 1);
        if (Date.now() - started + wait >= deadlineMs) throw end(failure);
        try {
          await Promise.race([sleep(wait), expired]);
        } catch (timeout) {
          throw end(classify(timeout));
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function classify(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof OpenAI.APIUserAbortError)
    return new ModelError("timeout", "the call to Meta was cut off at its deadline");
  if (error instanceof OpenAI.APIConnectionError) return new ModelError("network", "Meta could not be reached");
  if (error instanceof OpenAI.APIError && error.status !== undefined && error.headers)
    return statusError(error.status, error.headers, { error: error.error });
  if (error instanceof Error && error.name === "AbortError")
    return new ModelError("timeout", "the call to Meta was cut off at its deadline");
  if (error instanceof TypeError) return new ModelError("network", "Meta could not be reached");
  return new ModelError("malformed", "Meta's answer could not be read");
}

// An error status decides the kind; Meta's envelope, when the body is one, adds its type, code and param. A body that is
// not the envelope (404's is empty, an edge's 502 may be HTML) keeps its status's kind.
function statusError(status: number, headers: Headers, body: unknown): ModelError {
  const envelope = (body as { error?: unknown } | undefined)?.error;
  const e = typeof envelope === "object" && envelope !== null ? (envelope as Record<string, unknown>) : {};
  const details: ModelErrorDetails = {
    status,
    type: identifier(e.type),
    code: identifier(e.code),
    param: identifier(e.param),
    ...traced(headers),
  };
  const retryAfterMs = retryAfter(headers.get("retry-after"));
  if (retryAfterMs !== undefined) details.retryAfterMs = retryAfterMs;
  const kind: ModelErrorKind =
    status === 401 || status === 403
      ? "auth"
      : status === 402
        ? "billing"
        : status === 400 && details.code === "content_policy_violation"
          ? "content-policy"
          : status === 429
            ? "rate-limit"
            : status === 504
              ? "timeout"
              : status >= 500
                ? "server"
                : status >= 400
                  ? "invalid-request"
                  : "malformed";
  const named = [details.type, details.code, details.param].filter(Boolean).join(", ");
  return new ModelError(kind, `Meta answered HTTP ${status}${named ? ` (${named})` : ""}`, details);
}

const identifier = (value: unknown) => (typeof value === "string" && IDENTIFIER.test(value) ? value : null);
export const traced = (headers: Headers) => ({
  logId: identifier(headers.get("cf-aig-log-id")),
  requestId: identifier(headers.get("x-request-id")),
});

// Retry-After as seconds or an HTTP date (RFC 9110 10.2.3); unreadable is absent.
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
