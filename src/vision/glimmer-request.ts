// Loupe's requests as the Worker sends them (D03 T04 §1, §15), apart from the Worker's mail and ledger so a local
// script (scripts/glimmer/monitor-pages.ts) can send exactly the same request through the gateway.
import { z } from "zod";
import { DEPLOYED, type Target } from "./glimmer-caps.ts";

export type GatewayEnv = {
  FIREWORKS_API_KEY?: string;
  // The AI Gateway's `custom-fireworks` route, ending in `/v1` (e.g. .../isitlegit/custom-fireworks/v1).
  GLIMMER_GATEWAY_URL?: string;
  CF_AIG_TOKEN?: string;
};

// The request as every call sends it: through the gateway, logging metadata only, never the payload (as
// `metaResponses` does), with the deployment's key.
export function fireworksHeaders(env: GatewayEnv, metadata: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${env.FIREWORKS_API_KEY}`,
    "Content-Type": "application/json",
    "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
    "cf-aig-collect-log": "true",
    "cf-aig-collect-log-payload": "false",
    "cf-aig-metadata": JSON.stringify(metadata),
  };
}

export const completionsUrl = (env: GatewayEnv) => `${env.GLIMMER_GATEWAY_URL}/chat/completions`;

export function oneTokenRequest(env: GatewayEnv, target: Target = DEPLOYED): { url: string; init: RequestInit } {
  return {
    url: completionsUrl(env),
    init: {
      method: "POST",
      headers: fireworksHeaders(env, { caller: "glimmer-wake" }),
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
      }),
    },
  };
}

// A completion as Fireworks' chat completions endpoint answers one: at least one choice whose message is the
// assistant's, with its content as a string (or null for a 1-token answer cut short). Anything else is no answer.
const Completion = z.object({
  choices: z
    .array(z.object({ message: z.object({ role: z.literal("assistant"), content: z.string().nullable() }) }))
    .min(1),
});
export function isCompletion(body: string): boolean {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    // Not JSON: not a completion. This is the answer, not a lost error.
    return false;
  }
  return Completion.safeParse(data).success;
}
