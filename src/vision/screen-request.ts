// The screener's requests (D03 T04 §1), apart from the Worker's transport so a local run (scripts/glimmer/monitor-pages.ts)
// sends exactly what the Worker sends: Loupe's body with the `PageAnswer` JSON schema format, the answer read strictly,
// and Spark's Responses request carrying the same screenshot, host and untrusted text.
import { formatSchema } from "../meta/structured.ts";
import { DEPLOYED_MODEL } from "./glimmer-caps.ts";
import { PageAnswer, type ScreenRequest } from "./page-screen.ts";

export const SPARK_MODEL = "muse-spark-1.3";
// The answer's output limit, as the held-out evaluation ran it (scripts/glimmer/evaluate.ts).
export const MAX_ANSWER_TOKENS = 500;

// The request Loupe gets: exactly the training request (`buildScreenRequest`), the deployment's model, and the answer
// constrained to `PageAnswer`'s JSON schema.
export function glimmerBody(request: ScreenRequest) {
  return {
    model: DEPLOYED_MODEL,
    messages: request.messages,
    temperature: 0,
    max_tokens: MAX_ANSWER_TOKENS,
    response_format: { type: "json_schema", json_schema: { name: "page_screen", schema: formatSchema(PageAnswer) } },
  };
}

// The answer text as a PageAnswer, strictly: JSON (a fenced block allowed, as the model was trained), then the schema.
export function readAnswer(text: string): PageAnswer | null {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    // Not JSON: no answer. This is the outcome, not a lost error.
    return null;
  }
  const parsed = PageAnswer.safeParse(data);
  return parsed.success ? parsed.data : null;
}

// Spark's request: the same screenshot, host and untrusted text block, the screener's prompt as instructions, through
// `structured()`, so the answer is validated as a PageAnswer too.
export function sparkRequest(request: ScreenRequest) {
  const [system, user] = request.messages;
  const parts = user && Array.isArray(user.content) ? user.content : [];
  return {
    name: "page_screen",
    model: SPARK_MODEL,
    instructions: String(system?.content ?? ""),
    max_output_tokens: MAX_ANSWER_TOKENS,
    input: [
      {
        role: "user" as const,
        content: parts.map((part) =>
          part.type === "text"
            ? { type: "input_text" as const, text: part.text }
            : { type: "input_image" as const, image_url: part.image_url.url, detail: "auto" as const },
        ),
      },
    ],
  };
}
