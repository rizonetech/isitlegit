// The Meta client (D03 T01 §1), at the transport: what reaches the gateway, how often, and what every failure becomes.
import { describe, expect, it } from "vitest";
import { type MetaContext, ModelError, metaRaw, metaResponses } from "../../src/meta/client";

const KEY = "LLM_test_key_0123456789";
const TOKEN = "aig-run-token-0123456789";
// A trailing slash, so the test proves the paths are joined with one `/v1`.
const BASE = "https://gateway.test/v1/acct/isitlegit/custom-meta/v1/";
const env = { META_API_KEY: KEY, CF_AIG_TOKEN: TOKEN, META_GATEWAY_URL: BASE };

const answer = { id: "resp_1", object: "response", output: [], usage: { input_tokens: 3, output_tokens: 1 } };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", ...headers },
  });
const envelope = (type: string, code: string | null = null, message = "something was wrong") => ({
  error: { message, type, param: null, code },
});

// A transport that answers from a script, one response per call, and keeps every request it was sent.
function transport(...script: (() => Response | Promise<Response>)[]) {
  const sent: Request[] = [];
  const waits: number[] = [];
  const ctx: MetaContext = {
    env,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Request(input, init));
      const next = script[Math.min(sent.length, script.length) - 1];
      if (!next) throw new Error("no scripted response");
      return next();
    }) as typeof fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
    random: () => 0.5,
  };
  return { sent, waits, ctx };
}

const audio = () => new Blob([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])], { type: "audio/wav" });
// Every way out: a call with a model that succeeds against `ok`, the same call with any model, and its exact URL.
const entries = {
  responses: {
    call: (ctx: MetaContext) => metaResponses({ model: "muse-spark-1.3", input: "hello" }, ctx),
    with: (ctx: MetaContext, model: string) => metaResponses({ model, input: "hello" }, ctx),
    ok: () => json(200, answer),
    url: "https://gateway.test/v1/acct/isitlegit/custom-meta/v1/responses",
  },
  transcribe: {
    call: (ctx: MetaContext) =>
      metaRaw("/asr/transcribe", { request: { model: "muse-voice-transcribe-1.0" }, audio: audio() }, ctx),
    with: (ctx: MetaContext, model: string) => metaRaw("/asr/transcribe", { request: { model }, audio: audio() }, ctx),
    ok: () => json(200, { transcript: "hello" }),
    url: "https://gateway.test/v1/acct/isitlegit/custom-meta/v1/asr/transcribe",
  },
  "image edit": {
    call: (ctx: MetaContext) => metaRaw("/images/edits", { model: "muse-image-1.0", prompt: "a red square" }, ctx),
    with: (ctx: MetaContext, model: string) => metaRaw("/images/edits", { model, prompt: "a red square" }, ctx),
    ok: () => json(200, { data: [{ b64_json: "AAAA" }] }),
    url: "https://gateway.test/v1/acct/isitlegit/custom-meta/v1/images/edits",
  },
} as const;

async function failure(promise: Promise<unknown>): Promise<ModelError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ModelError);
  return error as ModelError;
}

describe("metaResponses", () => {
  it("sends through the gateway with both tokens, metadata-only logging and store: false over the caller's", async () => {
    const { sent, ctx } = transport(() => json(200, answer));
    const result = await metaResponses({ model: "muse-spark-1.3", input: "hello", store: true }, ctx);
    // The SDK adds its conveniences (output_text) beside Meta's fields.
    expect(result.data).toMatchObject(answer);
    expect(result.logId).toBe("log-1");
    expect(sent).toHaveLength(1);
    const request = sent[0] as Request;
    expect(request.url).toBe("https://gateway.test/v1/acct/isitlegit/custom-meta/v1/responses");
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request.headers.get("cf-aig-authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.get("cf-aig-collect-log")).toBe("true");
    expect(request.headers.get("cf-aig-collect-log-payload")).toBe("false");
    const body = (await request.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "muse-spark-1.3", input: "hello", store: false });
  });

  it("takes a 200 that is not a response object as malformed", async () => {
    const { ctx } = transport(() => json(200, { hello: "world" }));
    expect((await failure(metaResponses({ model: "muse-spark-1.3", input: "x" }, ctx))).kind).toBe("malformed");
    const text = transport(
      () => new Response("<html>oops</html>", { headers: { "content-type": "application/json" } }),
    );
    expect((await failure(metaResponses({ model: "muse-spark-1.3", input: "x" }, text.ctx))).kind).toBe("malformed");
  });
});

describe("metaRaw", () => {
  it("sends a transcription as multipart: the settings as a JSON request part, the clip as the audio part", async () => {
    const { sent, ctx } = transport(() => json(200, { transcript: "hello" }));
    const result = await metaRaw(
      "/asr/transcribe",
      { request: { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" }, audio: audio(), filename: "note.wav" },
      ctx,
    );
    expect(result).toEqual({ data: { transcript: "hello" }, logId: "log-1" });
    const request = sent[0] as Request;
    expect(request.url).toBe("https://gateway.test/v1/acct/isitlegit/custom-meta/v1/asr/transcribe");
    expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request.headers.get("cf-aig-authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.get("cf-aig-collect-log-payload")).toBe("false");
    const form = await request.formData();
    expect([...form.keys()]).toEqual(["request", "audio"]);
    const settings = form.get("request") as File;
    expect(settings.type).toBe("application/json");
    expect(JSON.parse(await settings.text())).toEqual({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" });
    const clip = form.get("audio") as File;
    expect(clip.type).toBe("audio/wav");
    expect(clip.name).toBe("note.wav");
    expect(new Uint8Array(await clip.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]));
  });

  it("sends an image edit as JSON", async () => {
    const { sent, ctx } = transport(() => json(200, { data: [{ b64_json: "AAAA" }] }));
    const edit = {
      model: "muse-image-1.0",
      prompt: "a red square",
      images: [{ image_url: "data:image/png;base64,AA" }],
    };
    const result = await metaRaw("/images/edits", edit, ctx);
    expect(result.data).toEqual({ data: [{ b64_json: "AAAA" }] });
    const request = sent[0] as Request;
    expect(request.url).toBe("https://gateway.test/v1/acct/isitlegit/custom-meta/v1/images/edits");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("cf-aig-collect-log")).toBe("true");
    expect(await request.json()).toEqual(edit);
  });

  it("refuses a path it does not send to, sending nothing", async () => {
    const { sent, ctx } = transport(() => json(200, {}));
    const error = await failure(metaRaw("/files" as "/images/edits", { model: "muse-image-1.0" }, ctx));
    expect(error.kind).toBe("invalid-request");
    expect(sent).toHaveLength(0);
  });

  it("takes a 200 that is not JSON as malformed", async () => {
    const { ctx } = transport(() => new Response("not json"));
    expect((await failure(entries.transcribe.call(ctx))).kind).toBe("malformed");
  });
});

describe.each(Object.entries(entries))("%s: models and settings", (_, entry) => {
  it("sends to its exact URL with both tokens and metadata-only logging", async () => {
    const { sent, ctx } = transport(entry.ok);
    await entry.call(ctx);
    const request = sent[0] as Request;
    expect(request.url).toBe(entry.url);
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request.headers.get("cf-aig-authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.get("cf-aig-collect-log")).toBe("true");
    expect(request.headers.get("cf-aig-collect-log-payload")).toBe("false");
  });

  it("refuses a contributor or unknown model before the network", async () => {
    for (const model of [
      "muse-spark-1.3-contributor",
      "gpt-4o",
      "muse-voice-transcribe-1.0-contributor",
      "muse-image-1.0-contributor",
    ]) {
      const { sent, ctx } = transport(entry.ok);
      expect((await failure(entry.with(ctx, model))).kind).toBe("refused-model");
      expect(sent).toHaveLength(0);
    }
  });

  it("answers a missing key, token or gateway URL as config, sending nothing", async () => {
    for (const name of ["META_API_KEY", "CF_AIG_TOKEN", "META_GATEWAY_URL"] as const) {
      const { sent, ctx } = transport(entry.ok);
      const error = await failure(entry.call({ ...ctx, env: { ...env, [name]: undefined } }));
      expect(error.kind).toBe("config");
      expect(error.message).toContain(name);
      expect(sent).toHaveLength(0);
    }
  });
});

describe.each(Object.entries(entries))("%s: retries", (_, entry) => {
  it("succeeds after one 503, waiting with jitter", async () => {
    const { sent, waits, ctx } = transport(() => json(503, envelope("server_error")), entry.ok);
    await entry.call(ctx);
    expect(sent).toHaveLength(2);
    expect(waits).toEqual([500]);
  });

  it("gives up after three attempts, keeping each attempt's gateway log id and Meta request id", async () => {
    let n = 0;
    const { sent, waits, ctx } = transport(() => {
      n++;
      return json(500, envelope("server_error"), { "cf-aig-log-id": `log-${n}`, "x-request-id": `req_${n}` });
    });
    const error = await failure(entry.call(ctx));
    expect(error.kind).toBe("server");
    expect(error.details.status).toBe(500);
    expect(error.details.logId).toBe("log-3");
    expect(error.details.requestId).toBe("req_3");
    expect(error.details.attempts).toEqual(
      [1, 2, 3].map((i) => ({
        kind: "server",
        status: 500,
        logId: `log-${i}`,
        requestId: `req_${i}`,
      })),
    );
    expect(sent).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("waits a 429's Retry-After, and does not wait one longer than 20 s", async () => {
    const short = transport(() => json(429, envelope("rate_limit_error"), { "retry-after": "2" }), entry.ok);
    await entry.call(short.ctx);
    expect(short.sent).toHaveLength(2);
    expect(short.waits).toEqual([2000]);
    const long = transport(() =>
      json(429, envelope("rate_limit_error", "rate_limit_exceeded"), { "retry-after": "60" }),
    );
    const error = await failure(entry.call(long.ctx));
    expect(error.kind).toBe("rate-limit");
    expect(error.details.retryAfterMs).toBe(60_000);
    expect(long.sent).toHaveLength(1);
  });

  it("sends 400, 408, 409 and 504 once", async () => {
    for (const [status, kind] of [
      [400, "invalid-request"],
      [408, "invalid-request"],
      [409, "invalid-request"],
      [504, "timeout"],
    ] as const) {
      const { sent, ctx } = transport(() => json(status, envelope("invalid_request_error")), entry.ok);
      expect((await failure(entry.call(ctx))).kind).toBe(kind);
      expect(sent).toHaveLength(1);
    }
  });

  it("ends a body that stalls as timeout at the deadline", async () => {
    const stalled = () =>
      new Response(new ReadableStream({ start: () => {} }), { headers: { "content-type": "application/json" } });
    const { ctx } = transport(stalled);
    const started = Date.now();
    const error = await failure(entry.call({ ...ctx, deadlineMs: 300 }));
    expect(error.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("retries a 503 whose body is cut off mid-read", async () => {
    const cut = () =>
      new Response(
        new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode('{"error":{"type":"ser'));
            c.error(new TypeError("connection reset"));
          },
        }),
        { status: 503, headers: { "content-type": "application/json", "cf-aig-log-id": "log-cut" } },
      );
    const { sent, ctx } = transport(cut, entry.ok);
    await entry.call(ctx);
    expect(sent).toHaveLength(2);
  });

  it("keeps the status and trace ids of an answer whose body stalls to the deadline", async () => {
    const stalled = () =>
      new Response(new ReadableStream({ start: () => {} }), {
        headers: { "content-type": "application/json", "cf-aig-log-id": "log-slow", "x-request-id": "req_slow" },
      });
    const { ctx } = transport(stalled);
    const error = await failure(entry.call({ ...ctx, deadlineMs: 300 }));
    expect(error.kind).toBe("timeout");
    expect(error.details).toMatchObject({ status: 200, logId: "log-slow", requestId: "req_slow" });
    expect(error.details.attempts).toEqual([
      { kind: "timeout", status: 200, logId: "log-slow", requestId: "req_slow" },
    ]);
  });

  it("keeps the trace ids of a success whose body is not JSON", async () => {
    const { ctx } = transport(
      () =>
        new Response("<html>gateway page</html>", {
          headers: { "content-type": "application/json", "cf-aig-log-id": "log-html", "x-request-id": "req_html" },
        }),
    );
    const error = await failure(entry.call(ctx));
    expect(error.kind).toBe("malformed");
    expect(error.details).toMatchObject({ status: 200, logId: "log-html", requestId: "req_html" });
  });
});

describe.each(Object.entries(entries))("%s: every failure is a ModelError with a kind", (_, entry) => {
  it.each([
    [401, envelope("authentication_error", "invalid_api_key"), "auth"],
    [403, envelope("permission_error"), "auth"],
    [402, envelope("billing_error", "billing_not_configured"), "billing"],
    [400, envelope("invalid_request_error", "content_policy_violation"), "content-policy"],
    [404, undefined, "invalid-request"],
    [422, envelope("invalid_request_error"), "invalid-request"],
  ] as const)("HTTP %i is %s", async (status, body, kind) => {
    const { ctx } = transport(() => json(status, body));
    const error = await failure(entry.call(ctx));
    expect(error.kind).toBe(kind);
    expect(error.details.status).toBe(status);
    if (body) {
      expect(error.details.type).toBe(body.error.type);
      expect(error.details.code).toBe(body.error.code);
    }
  });

  it("answers a rejected fetch as network", async () => {
    const { ctx } = transport(() => Promise.reject(new TypeError("fetch failed")));
    expect((await failure(entry.call(ctx))).kind).toBe("network");
  });

  it("keeps Meta's identifier fields and never the key, the token or content Meta echoes back", async () => {
    // Meta's messages can name what was sent: an image URL it could not fetch, a rejected value.
    const { ctx } = transport(() =>
      json(400, {
        error: {
          message: "could not fetch https://private.example/scan.png?ref=PRIVATE-MARK: blocked by robots.txt",
          type: "invalid_request_error",
          param: "images[0].image_url",
          code: null,
        },
        echo: "PAYLOAD",
      }),
    );
    const error = await failure(entry.call(ctx));
    expect(error.details).toMatchObject({ type: "invalid_request_error", param: "images[0].image_url", code: null });
    const text = `${error.message} ${JSON.stringify(error.details)}`;
    for (const kept of [KEY, TOKEN, "PAYLOAD", "PRIVATE-MARK", "private.example"]) expect(text).not.toContain(kept);
  });

  it("drops an identifier field that carries content rather than shortening it", async () => {
    const { ctx } = transport(() =>
      json(400, {
        error: {
          message: "x",
          type: "invalid_request_error",
          param: "input: PRIVATE-MARK said hello",
          code: "PRIVATE MARK",
        },
      }),
    );
    const error = await failure(entry.call(ctx));
    expect(error.details.param).toBeNull();
    expect(error.details.code).toBeNull();
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain("PRIVATE");
  });
});
