// The Meta client (D03 T01 §1), at the transport: what reaches the gateway, how often, and what every failure becomes.
import { describe, expect, it } from "vitest";
import {
  type MetaContext,
  ModelError,
  metaRaw,
  metaResponses,
  metaResponsesStream,
  wavSeconds,
} from "../../src/meta/client";
import { type Budget, BudgetExceeded, BudgetUnavailable, NotSent } from "../../src/meta/guard";

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

// A budget that admits every attempt and keeps what happened to each (D03 T01 §2).
type Charge = {
  id: string;
  model: string;
  estimate: number;
  attempt: number;
  state: string;
  actual?: number;
  searches?: number;
};
function ledger(refuse?: () => Error) {
  const charges: Charge[] = [];
  const find = (id: string) => charges.find((c) => c.id === id) as Charge;
  const budget: Budget = {
    async reserve(model, estimate, attempt) {
      if (refuse) throw refuse();
      const id = `r${charges.length + 1}`;
      charges.push({ id, model, estimate, attempt, state: "reserved" });
      return id;
    },
    async settle(id, actual, record) {
      Object.assign(find(id), { state: "settled", actual, searches: record?.searches });
    },
    async uncertain(id) {
      find(id).state = "uncertain";
    },
    async refused() {},
    async cached() {},
    async outputFailed() {},
  };
  return { budget, charges };
}

// A transport that answers from a script, one response per call, and keeps every request it was sent.
function transport(...script: (() => Response | Promise<Response>)[]) {
  const sent: Request[] = [];
  const waits: number[] = [];
  const spend = ledger();
  const ctx: MetaContext = {
    env,
    budget: spend.budget,
    owner: { kind: "case", caseId: "01HZTESTCASE0000000000000A", step: "checks" },
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
  return { sent, waits, ctx, charges: spend.charges };
}

const audio = () => new Blob([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])], { type: "audio/wav" });
// Every way out: a call with a model that succeeds against `ok`, the same call with any model, and its exact URL.
const entries = {
  responses: {
    call: (ctx: MetaContext) => metaResponses({ model: "muse-spark-1.3", input: "hello", max_output_tokens: 16 }, ctx),
    with: (ctx: MetaContext, model: string) => metaResponses({ model, input: "hello", max_output_tokens: 16 }, ctx),
    ok: () => json(200, answer),
    url: "https://gateway.test/v1/acct/isitlegit/custom-meta/v1/responses",
  },
  transcribe: {
    call: (ctx: MetaContext) =>
      metaRaw(
        "/asr/transcribe",
        { request: { model: "muse-voice-transcribe-1.0" }, audio: audio(), audioSeconds: 1 },
        ctx,
      ),
    with: (ctx: MetaContext, model: string) =>
      metaRaw("/asr/transcribe", { request: { model }, audio: audio(), audioSeconds: 1 }, ctx),
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
    const result = await metaResponses(
      { model: "muse-spark-1.3", input: "hello", store: true, max_output_tokens: 16 },
      ctx,
    );
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

  it("sends nothing once the caller's own deadline has passed", async () => {
    // The caller's absolute deadline is re-read at the send, after serialisation and reservation:
    // an expired caller starts no transport attempt, on the first try or a retry.
    const { sent, ctx } = transport(() => json(200, answer));
    const error = await failure(
      metaResponses(
        { model: "muse-spark-1.3", input: "hello", max_output_tokens: 16 },
        { ...ctx, expired: () => true },
      ),
    );
    expect(error.kind).toBe("timeout");
    expect(sent).toHaveLength(0);
  });

  it("sends nothing when the caller expires while an attempt is being reserved, or before a retry", async () => {
    // Expiry landing during budget reservation is caught at the send itself, after reservation.
    const reserving = transport(() => json(200, answer));
    const spend = ledger();
    const slowBudget: Budget = {
      ...spend.budget,
      reserve: async (...args: Parameters<Budget["reserve"]>) => {
        await new Promise((r) => setTimeout(r, 60));
        return spend.budget.reserve(...args);
      },
    };
    let expired = false;
    setTimeout(() => {
      expired = true;
    }, 20);
    const reserved = await failure(
      metaResponses(
        { model: "muse-spark-1.3", input: "hello", max_output_tokens: 16 },
        { ...reserving.ctx, budget: slowBudget, expired: () => expired },
      ),
    );
    expect(reserved.kind).toBe("timeout");
    expect(reserving.sent).toHaveLength(0);

    // Expiry after a failed attempt stops the retry before it sends.
    const retrying = transport(
      () => json(500, envelope("api_error", "overloaded")),
      () => json(200, answer),
    );
    const retried = await failure(
      metaResponses(
        { model: "muse-spark-1.3", input: "hello", max_output_tokens: 16 },
        { ...retrying.ctx, expired: () => retrying.sent.length > 0 },
      ),
    );
    expect(retried.kind).toBe("timeout");
    expect(retrying.sent).toHaveLength(1);
  });

  it("takes a 200 that is not a response object as malformed", async () => {
    const { ctx } = transport(() => json(200, { hello: "world" }));
    expect(
      (await failure(metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, ctx))).kind,
    ).toBe("malformed");
    const text = transport(
      () => new Response("<html>oops</html>", { headers: { "content-type": "application/json" } }),
    );
    expect(
      (await failure(metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, text.ctx))).kind,
    ).toBe("malformed");
  });
});

describe("metaResponsesStream", () => {
  const sse = (events: unknown[], done = true) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), {
      headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1", "x-request-id": "req-1" },
    });
  const deltaEvent = { type: "response.output_text.delta", delta: "<0f>" };
  const completedEvent = {
    type: "response.completed",
    response: { id: "r", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
  };
  const call = (ctx: MetaContext) =>
    metaResponsesStream(
      { model: "sam-3.1", input: "logo", stream: true } as Parameters<typeof metaResponsesStream>[0],
      ctx,
    );

  it("reads fragmented events to completion and settles after consumption at the reported usage", async () => {
    const { sent, ctx, charges } = transport(() => sse([deltaEvent, deltaEvent, completedEvent]));
    const answer = await call(ctx);
    expect(sent).toHaveLength(1);
    expect(answer.data.events.map((e) => e.type)).toEqual([
      "response.output_text.delta",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(answer.data.response?.status).toBe("completed");
    expect(charges).toHaveLength(1);
    expect(charges[0]?.state).toBe("settled");
  });

  it("settles only after the stream is consumed, not when its headers arrive", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encode = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encode.encode(`data: ${JSON.stringify(deltaEvent)}\n\n`));
        await gate;
        controller.enqueue(encode.encode(`data: ${JSON.stringify(completedEvent)}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    });
    const { ctx, charges } = transport(
      () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1", "x-request-id": "req-1" },
        }),
    );
    const pending = call(ctx);
    await new Promise((r) => setTimeout(r, 75));
    // The delta has arrived and the stream is still open: nothing may be settled yet.
    expect(charges).toHaveLength(1);
    expect(charges[0]?.state).toBe("reserved");
    release();
    const answer = await pending;
    expect(answer.data.response?.status).toBe("completed");
    expect(charges[0]?.state).toBe("settled");
  });

  it("retries a retryable HTTP failure and accounts for the failed attempt", async () => {
    const { sent, ctx, charges } = transport(
      () => json(500, envelope("api_error", "overloaded")),
      () => sse([completedEvent]),
    );
    const answer = await call(ctx);
    expect(sent).toHaveLength(2);
    expect(answer.data.response?.status).toBe("completed");
    expect(charges).toHaveLength(2);
    expect(charges[0]?.state).not.toBe("reserved");
    expect(charges[1]?.state).toBe("settled");
  });

  it("sends nothing when the budget refuses the reservation", async () => {
    const { sent, ctx } = transport(() => sse([completedEvent]));
    const budget: Budget = {
      ...ctx.budget,
      reserve: async () => {
        throw new BudgetExceeded("day", "sam-3.1");
      },
    };
    const error = await call({ ...ctx, budget }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceeded);
    expect(sent).toHaveLength(0);
  });

  it("returns an incomplete stream as no completed response, never as an empty success", async () => {
    const { ctx, charges } = transport(() => sse([deltaEvent], false));
    const answer = await call(ctx);
    expect(answer.data.response).toBeNull();
    expect(answer.data.events).toHaveLength(1);
    expect(charges[0]?.state).toBe("settled");
  });

  it("ends a stalled stream at the call deadline", async () => {
    const hanging = new ReadableStream<Uint8Array>({ start: () => {} });
    const { ctx } = transport(
      () =>
        new Response(hanging, {
          headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1" },
        }),
    );
    const error = await failure(call({ ...ctx, deadlineMs: 100 }));
    expect(error.kind).toBe("timeout");
  });
});

describe("metaRaw", () => {
  it("sends a transcription as multipart: the settings as a JSON request part, the clip as the audio part", async () => {
    const { sent, ctx } = transport(() => json(200, { transcript: "hello" }));
    const result = await metaRaw(
      "/asr/transcribe",
      {
        request: { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" },
        audio: audio(),
        filename: "note.wav",
        audioSeconds: 1,
      },
      ctx,
    );
    expect(result).toEqual({ data: { transcript: "hello" }, logId: "log-1", callId: expect.any(String) });
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

  it("refuses a Standard model this endpoint does not serve before the network", async () => {
    const wrong = {
      responses: "muse-voice-transcribe-1.0",
      transcribe: "muse-image-1.0",
      "image edit": "muse-spark-1.3",
    }[_];
    const { sent, ctx } = transport(entry.ok);
    const error = await failure(entry.with(ctx, wrong as string));
    expect(error.kind).toBe("refused-model");
    expect(error.message).toContain("is not called through");
    expect(sent).toHaveLength(0);
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

  it("ends a long Retry-After on a 503 as rate-limit, carrying the wait", async () => {
    const { sent, ctx } = transport(
      () => json(503, envelope("server_error", "service_overloaded"), { "retry-after": "60" }),
      entry.ok,
    );
    const error = await failure(entry.call(ctx));
    expect(error.kind).toBe("rate-limit");
    expect(error.details).toMatchObject({ status: 503, code: "service_overloaded", retryAfterMs: 60_000 });
    expect(sent).toHaveLength(1);
  });

  it("refuses an answer larger than the limit as it streams", async () => {
    let pulled = 0;
    const huge = () =>
      new Response(
        new ReadableStream({
          pull: (c) => {
            pulled++;
            c.enqueue(new Uint8Array(1024 * 1024).fill(32));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const { ctx } = transport(huge);
    const error = await failure(entry.call(ctx));
    expect(error.kind).toBe("malformed");
    expect(pulled).toBeLessThan(40);
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

describe("the budget on every attempt (D03 T01 §2)", () => {
  const ok = () => json(200, { ...answer, usage: { input_tokens: 1000, output_tokens: 100 } });

  it("reserves before the send and settles at the reported cost", async () => {
    const { sent, ctx, charges } = transport(ok);
    await metaResponses({ model: "muse-spark-1.3", input: "hello", max_output_tokens: 16 }, ctx);
    expect(sent).toHaveLength(1);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ model: "muse-spark-1.3", attempt: 1, state: "settled" });
    expect(charges[0]?.actual).toBeCloseTo((1000 * 1.25 + 100 * 4.25) / 1_000_000);
    expect(charges[0]?.estimate).toBeGreaterThan(0);
  });

  it("reserves each retried attempt, keeping a 5xx counted, since a gateway can answer one after Meta ran it", async () => {
    const busy = () => json(503, envelope("server_error"));
    const { sent, ctx, charges } = transport(busy, busy, busy);
    await failure(metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, ctx));
    expect(sent).toHaveLength(3);
    expect(charges.map((c) => [c.attempt, c.state])).toEqual([
      [1, "uncertain"],
      [2, "uncertain"],
      [3, "uncertain"],
    ]);
    const timeout = transport(() => json(504, envelope("server_error")));
    await failure(metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, timeout.ctx));
    expect(timeout.charges[0]?.state).toBe("uncertain");
  });

  it("settles a request Meta refused itself (a 4xx) at nothing", async () => {
    const { ctx, charges } = transport(() => json(400, envelope("invalid_request_error")));
    await failure(metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, ctx));
    expect(charges.map((c) => [c.state, c.actual])).toEqual([["settled", 0]]);
  });

  it("reserves an image at its stated bound, never for the characters that carry it", async () => {
    const { ctx, charges } = transport(ok);
    const image = { type: "input_image", image_url: `data:image/png;base64,${"A".repeat(200_000)}`, detail: "auto" };
    await metaResponses(
      { model: "muse-spark-1.3", input: [{ role: "user", content: [image] }] as never, max_output_tokens: 16 },
      ctx,
    );
    const perToken = 1.25 / 1_000_000;
    // At least the image's bound; far less than 200,000 characters priced as text.
    expect(charges[0]?.estimate).toBeGreaterThanOrEqual(6_000 * perToken);
    expect(charges[0]?.estimate).toBeLessThan(20_000 * perToken);
  });

  it("keeps an attempt whose answer was lost counted at its estimate", async () => {
    const { ctx, charges } = transport(() => {
      throw new TypeError("network connection lost");
    });
    await failure(metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, ctx));
    expect(charges[0]?.state).toBe("uncertain");
  });

  it("sends nothing when a cap refuses, and never retries the refusal", async () => {
    const { sent, ctx } = transport(ok);
    const capped = ledger(() => new BudgetExceeded("day", "muse-spark-1.3"));
    const error = await metaResponses(
      { model: "muse-spark-1.3", input: "x", max_output_tokens: 16 },
      { ...ctx, budget: capped.budget },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceeded);
    expect((error as BudgetExceeded).cap).toBe("day");
    expect(sent).toEqual([]);
  });

  it("sends nothing when the budget cannot be reached", async () => {
    const { sent, ctx } = transport(ok);
    const down = ledger(() => new Error("D1_ERROR: Network connection lost."));
    const error = await metaRaw(
      "/asr/transcribe",
      { request: { model: "muse-voice-transcribe-1.0" }, audio: audio(), audioSeconds: 12 },
      { ...ctx, budget: down.budget },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetUnavailable);
    expect(sent).toEqual([]);
  });

  it("returns the answer when its settlement cannot be written, the reservation left counted", async () => {
    const { ctx, charges } = transport(ok);
    const budget: Budget = { ...ctx.budget, settle: async () => Promise.reject(new Error("write failed")) };
    const result = await metaResponses(
      { model: "muse-spark-1.3", input: "x", max_output_tokens: 16 },
      { ...ctx, budget },
    );
    expect(result.data.id).toBe("resp_1");
    expect(charges[0]?.state).toBe("reserved");
  });

  it("refuses a Responses call with no output limit, and a transcription with no length, before anything", async () => {
    const { sent, ctx, charges } = transport(ok);
    expect((await failure(metaResponses({ model: "muse-spark-1.3", input: "x" }, ctx))).kind).toBe("invalid-request");
    const noLength = { request: { model: "muse-voice-transcribe-1.0" }, audio: audio() } as unknown as Parameters<
      typeof metaRaw
    >[1];
    expect((await failure(metaRaw("/asr/transcribe", noLength as never, ctx))).kind).toBe("invalid-request");
    expect([sent, charges]).toEqual([[], []]);
  });
});

describe("round 1 (2026-10-29)", () => {
  const ok = () => json(200, { ...answer, usage: { input_tokens: 10, output_tokens: 1 } });

  it("prices text that starts with data: as text, leaving out only an image's data URL", async () => {
    const { ctx, charges } = transport(ok);
    const text = `data:${"1 2 3 4 ".repeat(10_000)}`;
    await metaResponses(
      {
        model: "muse-spark-1.3",
        input: [{ role: "user", content: [{ type: "input_text", text }] }] as never,
        max_output_tokens: 16,
      },
      ctx,
    );
    expect(charges[0]?.estimate).toBeGreaterThanOrEqual((80_000 * 1.25) / 1_000_000);
  });

  it("releases an attempt the transport stopped before sending, never keeping it as a charge", async () => {
    const { ctx, charges } = transport(() => {
      throw new NotSent("the local record could not be written");
    });
    await metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 16 }, ctx).catch(() => null);
    expect(charges.map((c) => [c.state, c.actual])).toEqual([["settled", 0]]);
  });

  it("settles a transcription at Meta's reported length, whole seconds rounded down", async () => {
    const { ctx, charges } = transport(() => json(200, { transcript: "hi", audioDurationMs: 12_040 }));
    await metaRaw(
      "/asr/transcribe",
      { request: { model: "muse-voice-transcribe-1.0" }, audio: audio(), audioSeconds: 13 },
      ctx,
    );
    expect(charges[0]?.actual).toBeCloseTo((12 * 0.18) / 3600);
  });
});

describe("final review (2026-10-29)", () => {
  it("refuses before anything what the budget cannot bound: web search, a server-referenced file, a bad limit", async () => {
    const { sent, ctx, charges } = transport(() => json(200, answer));
    const refusals = [
      { model: "muse-spark-1.3", input: "x", max_output_tokens: 16, tools: [{ type: "web_search" }] },
      {
        model: "muse-spark-1.3",
        input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }],
        max_output_tokens: 16,
      },
      { model: "muse-spark-1.3", input: "x", max_output_tokens: Number.NaN },
      { model: "muse-spark-1.3", input: "x", max_output_tokens: 1.5 },
    ];
    for (const params of refusals)
      expect((await failure(metaResponses(params as never, ctx))).kind, JSON.stringify(params)).toBe("invalid-request");
    expect([sent, charges]).toEqual([[], []]);
  });

  it("sends an inline file_data bounded by its own bytes, and still refuses a server-referenced file", async () => {
    const { sent, ctx, charges } = transport(() => json(200, answer));
    const inline = {
      model: "muse-spark-1.3",
      input: [
        {
          role: "user",
          content: [{ type: "input_file", filename: "invoice.pdf", file_data: "data:application/pdf;base64,JVBERi0=" }],
        },
      ],
      max_output_tokens: 16,
    };
    await metaResponses(inline as never, ctx);
    expect(sent).toHaveLength(1);
    // The inline bytes were reserved for, like any other content the request carries.
    expect(charges[0]?.estimate).toBeGreaterThan(0);
    const referenced = [
      {
        model: "muse-spark-1.3",
        input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }],
        max_output_tokens: 16,
      },
      {
        model: "muse-spark-1.3",
        input: [{ role: "user", content: [{ type: "input_file", file_url: "https://x.test/a.pdf" }] }],
        max_output_tokens: 16,
      },
      {
        model: "muse-spark-1.3",
        input: [{ role: "user", content: [{ type: "input_file", filename: "a.pdf" }] }],
        max_output_tokens: 16,
      },
    ];
    for (const params of referenced)
      expect((await failure(metaResponses(params as never, ctx))).kind).toBe("invalid-request");
    expect(sent).toHaveLength(1);
  });

  it("opens web search only on a context carrying its cap, reserves the cap and settles the searches the answer ran (D03 T02 §4)", async () => {
    const groundedAnswer = {
      id: "resp_1",
      object: "response",
      output: [{ type: "web_search_call" }, { type: "web_search_call" }],
      usage: { input_tokens: 10, output_tokens: 1 },
    };
    const { sent, ctx, charges } = transport(() => json(200, groundedAnswer));
    await metaResponses(
      { model: "muse-spark-1.3", input: "x", max_output_tokens: 16, tools: [{ type: "web_search" }] },
      { ...ctx, search: { maxSearches: 3 } },
    );
    expect(sent).toHaveLength(1);
    // Reserved for the whole cap of 3 searches on top of the token bound, settled at the 2 the
    // answer itself reported on top of its tokens (10 in, 1 out).
    expect(charges[0]?.estimate).toBeGreaterThan(3 * 0.0025);
    expect(charges[0]?.searches).toBe(2);
    expect(charges[0]?.actual).toBeCloseTo((10 * 1.25 + 1 * 4.25) / 1_000_000 + 2 * 0.0025, 8);
    // The streamed door stays shut to search: no caller there carries a cap.
    expect(
      (
        await failure(
          metaResponsesStream(
            { model: "muse-spark-1.3", input: "x", max_output_tokens: 16, tools: [{ type: "web_search" }] } as never,
            { ...ctx, search: { maxSearches: 3 } },
          ),
        )
      ).kind,
    ).toBe("invalid-request");
  });

  it("reserves a transcription for at least what its clip could hold, whatever length it is given", async () => {
    const { ctx, charges } = transport(() => json(200, { transcript: "x" }));
    const clip = new Blob([new Uint8Array(300_000)], { type: "audio/ogg" });
    await metaRaw(
      "/asr/transcribe",
      { request: { model: "muse-voice-transcribe-1.0" }, audio: clip, audioSeconds: 1 },
      ctx,
    );
    // 300,000 bytes at 500 a second is 600 seconds.
    expect(charges[0]?.estimate).toBeCloseTo((600 * 0.18) / 3600);
  });
});

// D01 T03 §3: a PCM WAV is reserved by its own length, the format the endpoint takes; anything else at the floor.
describe("a WAV's reservation (D01 T03 §3)", () => {
  // A ten-minute chunk as the voice decoder writes it: 16 kHz mono 16-bit, 32,000 bytes a second.
  const SAMPLES = 600 * 16_000;
  const header = (over: (view: DataView) => void = () => {}) => {
    const bytes = new Uint8Array(44);
    const view = new DataView(bytes.buffer);
    const ascii = (at: number, text: string) => {
      for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + SAMPLES * 2, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16_000, true);
    view.setUint32(28, 32_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, SAMPLES * 2, true);
    over(view);
    return bytes;
  };
  const wav = (head = header()) => new Blob([head, new Uint8Array(SAMPLES * 2)], { type: "audio/wav" });
  const reserved = async (audio: Blob) => {
    const { ctx, charges } = transport(() => json(200, { transcript: "x", audioDurationMs: 600_000 }));
    await metaRaw("/asr/transcribe", { request: { model: "muse-voice-transcribe-1.0" }, audio, audioSeconds: 1 }, ctx);
    return charges[0]?.estimate as number;
  };
  const tenMinutes = (600 * 0.18) / 3600;

  it("reserves a ten-minute chunk at its ten minutes, not the floor's sixty-four times that", async () => {
    expect(await wavSeconds(wav())).toBe(600);
    expect(await reserved(wav())).toBeCloseTo(tenMinutes);
  });

  it("is admitted by a budget that holds its cost but not the floor's", async () => {
    // A budget with $0.10 left: the WAV's $0.03 fits; at the floor (19,200,044 bytes at 500 a second) it would be $1.92.
    const left = 0.1;
    const { ctx } = transport(() => json(200, { transcript: "x", audioDurationMs: 600_000 }));
    const guarded: MetaContext = {
      ...ctx,
      budget: {
        ...ctx.budget,
        async reserve(model, estimate, attempt, id, call) {
          if (estimate > left) throw new BudgetExceeded("day", model);
          return ctx.budget.reserve(model, estimate, attempt, id, call);
        },
      },
    };
    const call = metaRaw(
      "/asr/transcribe",
      { request: { model: "muse-voice-transcribe-1.0" }, audio: wav(), audioSeconds: 600 },
      guarded,
    );
    await expect(call).resolves.toBeDefined();
    const ogg = new Blob([new Uint8Array(SAMPLES * 2 + 44)], { type: "audio/ogg" });
    await expect(
      metaRaw(
        "/asr/transcribe",
        { request: { model: "muse-voice-transcribe-1.0" }, audio: ogg, audioSeconds: 600 },
        guarded,
      ),
    ).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it("keeps the floor for anything not a well-formed PCM WAV, and never takes the length the header declares", async () => {
    const floor = ((SAMPLES * 2 + 44) / 500) * (0.18 / 3600);
    const forged: [string, (view: DataView) => void][] = [
      ["a byte rate of zero", (v) => v.setUint32(28, 0, true)],
      ["a byte rate that disagrees with the rate", (v) => v.setUint32(28, 32_000_000, true)],
      ["a block align that disagrees", (v) => v.setUint16(32, 4, true)],
      ["8-bit samples", (v) => v.setUint16(34, 8, true)],
      ["a format other than PCM", (v) => v.setUint16(20, 3, true)],
      [
        "a rate past 48 kHz",
        (v) => {
          v.setUint32(24, 96_000, true);
          v.setUint32(28, 192_000, true);
        },
      ],
    ];
    for (const [name, change] of forged) {
      expect(await wavSeconds(wav(header(change))), name).toBeNull();
      expect(await reserved(wav(header(change))), name).toBeCloseTo(floor);
    }
    // A data chunk declared one second long holds ten minutes: the bytes sent count, not the declared size.
    const shrunk = header((v) => v.setUint32(40, 32_000, true));
    expect(await wavSeconds(wav(shrunk))).toBe(600);
    expect(await wavSeconds(new Blob([new Uint8Array(SAMPLES * 2 + 44)]))).toBeNull();
  });
});

describe("round 3 (2026-10-29)", () => {
  it("settles a transcription with no reported length at its reservation, estimated, never at the length it was given", async () => {
    const { ctx, charges } = transport(() => json(200, { transcript: "x" }));
    const clip = new Blob([new Uint8Array(300_000)], { type: "audio/ogg" });
    await metaRaw(
      "/asr/transcribe",
      { request: { model: "muse-voice-transcribe-1.0" }, audio: clip, audioSeconds: 1 },
      ctx,
    );
    expect(charges[0]?.actual).toBeCloseTo(charges[0]?.estimate as number);
    expect(charges[0]?.actual).toBeCloseTo((600 * 0.18) / 3600);
  });
});

describe("the gateway's metadata (D03 T01 §3)", () => {
  it("tags each request with its owner's opaque ids and step, the host hashed, and no personal data", async () => {
    const ok = () => json(200, answer);
    const a = transport(ok);
    await metaResponses({ model: "muse-spark-1.3", input: "boss@member.co.za", max_output_tokens: 16 }, a.ctx);
    expect(JSON.parse(a.sent[0]?.headers.get("cf-aig-metadata") ?? "{}")).toEqual({
      case: "01HZTESTCASE0000000000000A",
      step: "checks",
    });
    const b = transport(() => json(200, { data: [{ b64_json: "AA" }] }));
    const monitor = { kind: "monitor" as const, run: "run-7", host: "pay-portal.example", step: "screen" };
    await metaRaw("/images/edits", { model: "muse-image-1.0", prompt: "x" }, { ...b.ctx, owner: monitor });
    const meta = b.sent[0]?.headers.get("cf-aig-metadata") ?? "";
    expect(JSON.parse(meta)).toMatchObject({ run: "run-7", step: "screen" });
    expect(meta).not.toContain("pay-portal");
    expect(a.sent[0]?.headers.get("cf-aig-metadata")).not.toContain("boss@");
  });
});
