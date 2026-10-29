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
import type { Response as MetaResponse, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
// With its extension: scripts/meta-client-live.ts runs this module under Node's type stripping, which resolves no
// extensionless path.
import { type Budget, BudgetExceeded, BudgetUnavailable, type Call, charged, type Owner } from "./guard.ts";
import { ENDPOINTS, type Endpoint, isModelId, type ModelId } from "./models.ts";
import { estimateUsd } from "./pricing.ts";

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
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};
// What came back, with the gateway's id for the call's log (D03 T01 §3 reads it).
export type MetaAnswer<T> = { data: T; logId: string | null };

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

// One attempt that failed, with what traces it: the gateway's log id (cf-aig-log-id) and Meta's (x-request-id).
export type FailedAttempt = { kind: ModelErrorKind; status?: number; logId: string | null; requestId: string | null };
export type ModelErrorDetails = {
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
  const model = standard(params.model, "responses");
  // The output limit bounds what a call can cost (D03 T01 §2): a call without one cannot be reserved for.
  if (!Number.isInteger(params.max_output_tokens) || (params.max_output_tokens as number) < 1)
    throw new ModelError(
      "invalid-request",
      "a Responses call must set max_output_tokens, which the budget reserves for",
    );
  // What the budget cannot bound before the call is refused before it (D03 T01 §2 final review): web search is billed
  // per query with no per-request cap Meta documents (D03 T02 §4 budgets it), and a file the server fetches (a file id,
  // a file URL, an input file such as a PDF) is billed by its content, which the request does not carry.
  if ((params.tools ?? []).some((tool) => String((tool as { type?: unknown }).type).startsWith("web_search")))
    throw new ModelError("invalid-request", "web search is not budgeted yet; a call cannot use it");
  if (/"type":"input_file"|"file_id"|"file_url"/.test(JSON.stringify(params)))
    throw new ModelError(
      "invalid-request",
      "a server-referenced file cannot be bounded before it is sent; send its content",
    );
  const { apiKey, token, base } = settings(ctx.env);
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
  const estimate = estimateUsd(model, {
    inputBytes: new TextEncoder().encode(text).byteLength,
    maxOutputTokens: params.max_output_tokens as number,
    images,
  });
  const call: Call = { callId: crypto.randomUUID(), owner: ctx.owner };
  return withRetries(ctx, seen, (signal, n) => {
    let requestId: string | null = null;
    return charged(
      ctx.budget,
      model,
      estimate,
      n,
      async () => {
        const { data, response } = await client.responses.create(body, { signal, maxRetries: 0 }).withResponse();
        requestId = response.headers.get("x-request-id");
        if (!isResponse(data))
          throw new ModelError("malformed", "Meta's answer is not a response object", {
            status: response.status,
            ...traced(response.headers),
          });
        return { data, logId: response.headers.get("cf-aig-log-id") };
      },
      ({ data, logId }) => ({
        usage: {
          inputTokens: data.usage?.input_tokens,
          cachedTokens: data.usage?.input_tokens_details?.cached_tokens,
          outputTokens: data.usage?.output_tokens,
          // SAM is billed per image sent, one at least.
          images: Math.max(1, images),
        },
        logId,
        requestId,
      }),
      call,
    );
  });
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
  let payload: BodyInit;
  let contentType: Record<string, string> = {};
  let model: ModelId;
  let estimate: number;
  let usage: (data: unknown) => { audioSeconds?: number | undefined; images?: number };
  if (path === "/asr/transcribe") {
    const { request, audio, filename, audioSeconds } = body as TranscribeBody;
    model = standard(request.model, "/asr/transcribe");
    if (!(Number.isFinite(audioSeconds) && audioSeconds > 0))
      throw new ModelError(
        "invalid-request",
        "a transcription must give its audio length, which the budget reserves for",
      );
    // Never less than the recording could hold: a given length is checked against the clip's size at the lowest
    // bitrate speech codecs use (D03 T01 §2 final review), so a short length cannot admit a long recording.
    estimate = estimateUsd(model, { audioSeconds: Math.max(audioSeconds, audio.size / MIN_AUDIO_BYTES_PER_SECOND) });
    // Meta reports the recording's length as `audioDurationMs` (sources/meta-api/docs: the transcribe response).
    // Without it the length billed is unknown: the call settles at its reservation, marked estimated, never at the
    // length the caller gave (round 3).
    usage = (data) => {
      const ms = numberAt(data, "audioDurationMs");
      return { audioSeconds: ms === undefined ? undefined : ms / 1000 };
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
    usage = (data) => {
      const made = (data as { data?: unknown } | null)?.data;
      return { images: Array.isArray(made) ? made.length : count };
    };
    payload = JSON.stringify(body);
    contentType = { "content-type": "application/json" };
  }
  const { apiKey, token, base } = settings(ctx.env);
  const seen = observe(ctx.fetch ?? fetch);
  const call: Call = { callId: crypto.randomUUID(), owner: ctx.owner };
  const headers = { ...gatewayHeaders(token), ...(await metadataHeader(ctx.owner)) };
  return withRetries(ctx, seen, (signal, n) => {
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
      ({ data, logId }) => ({ usage: usage(data), logId, requestId }),
      call,
    );
  });
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
): Promise<MetaAnswer<unknown> & { requestId: string | null }> {
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
  return { data, logId: response.headers.get("cf-aig-log-id"), requestId: response.headers.get("x-request-id") };
}

// The images a Responses request sends: SAM is billed by them (one at least, ./pricing.ts), and a token-priced model
// reserves IMAGE_TOKEN_BOUND for each.
const imagesIn = (json: string) => (json.match(/"type":"input_image"/g) ?? []).length;

// A non-negative number at a field of an answer, or undefined.
const numberAt = (data: unknown, field: string) => {
  const value = (data as Record<string, unknown> | null)?.[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
};

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
async function metadataHeader(owner: Owner): Promise<Record<string, string>> {
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
      try {
        return await Promise.race([attempt(controller.signal, n), expired]);
      } catch (error) {
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
        if (n >= MAX_ATTEMPTS || status === undefined || !RETRIED.has(status)) throw end(failure);
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
const traced = (headers: Headers) => ({
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
