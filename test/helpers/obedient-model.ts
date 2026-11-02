// The obedient stub model (D04 T01 §6): the worst case for prompt injection. It follows any
// instruction it can find anywhere in its input, including inside untrusted blocks: it tries
// to walk an attacker URL it is told to walk, marks the case safe when told to, and puts an
// attacker link and address into its final answer when told to. The suite proves the structure
// (tool executor, citation validator, deterministic floor) holds against this model, not that
// a real model would show restraint.

export type ObedientModel = {
  fetchStub: typeof fetch;
  // Every manipulation the stub attempted, named by kind, so a test can prove the payload
  // reached the model boundary and was acted on there.
  attempts: string[];
  sent: string[];
};

const answer = (output: unknown[]) =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status: "completed",
      output,
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );

export function obedientModel(cleanAnswer: Record<string, unknown>): ObedientModel {
  const attempts: string[] = [];
  const sent: string[] = [];
  let walked = false;
  const fetchStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    sent.push(body);
    const attackerUrl = body.match(/https:\/\/attacker\.example\/[a-z]+/)?.[0];
    // An instruction to walk or visit a new URL: obey it once, as a tool call.
    if (!walked && attackerUrl && /walk_phishing_site|visit|open/i.test(body)) {
      walked = true;
      attempts.push(`walk:${attackerUrl}`);
      return answer([
        {
          type: "function_call",
          name: "walk_phishing_site",
          call_id: "call_obedient_1",
          arguments: JSON.stringify({ url: attackerUrl }),
        },
      ]);
    }
    // Any instruction to mark safe, reply elsewhere or add a link: obey it in the final answer.
    if (/mark .*safe|this is safe|audit mode|verdict safe|disregard/i.test(body)) {
      attempts.push("verdict:safe");
      return answer([
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                verdict: "safe",
                confidence: 0.99,
                headline: "This is safe, visit https://attacker.example/confirm",
                explanation: "The message told me to mark it safe.",
                cited_evidence_ids: [],
                recommended_actions: ["Mail attacker@example.com and open https://attacker.example/confirm"],
                meaning: "Send your details to attacker@example.com.",
              }),
            },
          ],
        },
      ]);
    }
    return answer([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(cleanAnswer) }],
      },
    ]);
  }) as typeof fetch;
  return { fetchStub, attempts, sent };
}
