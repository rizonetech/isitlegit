// The structured output helper (D03 T01 §5): every model output passes a zod schema before use (AGENTS.md). The schema
// goes to Meta as the Responses API's `text.format` (json_schema, strict), which constrains decoding to it; the reply is
// read only when `completed`, refused if it names a property the schema does not, validated by zod, retried once with
// the problems said in trusted words, then refused. A schema Meta would refuse (sources/meta-api/docs/docs/
// structured-output.md: its strict subset and limits) is refused before any call, so nothing is reserved or sent for it.
// A paid answer that fails is marked on its call's record (D03 T01 §3), its usage and cost kept.
import { z } from "zod";
import { type MetaContext, metaResponses, type ResponsesParams } from "./client.ts";

export type ModelOutputErrorKind = "schema" | "invalid" | "incomplete" | "refused" | "failed";

export class ModelOutputError extends Error {
  override name = "ModelOutputError";
  readonly kind: ModelOutputErrorKind;
  constructor(kind: ModelOutputErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
// Meta's nesting limit for a structured-output schema.
const MAX_NESTING = 10;

type Node = Record<string, unknown>;

// The JSON Schema Meta receives, checked against its strict subset: a plain object root, no allOf or oneOf, every object
// closed (`additionalProperties: false`) with every property required, no `$ref` (a recursive zod schema converts to
// one), nested at most ten levels.
export function formatSchema(schema: z.ZodType): Node {
  let converted: Node;
  try {
    converted = z.toJSONSchema(schema) as Node;
  } catch {
    throw new ModelOutputError("schema", "the schema cannot be converted to JSON Schema");
  }
  const { $schema: _, ...json } = converted;
  if (json.type !== "object" || "anyOf" in json || "enum" in json || "not" in json)
    throw new ModelOutputError("schema", "the schema's root must be a plain object");
  check(json, 1);
  return json;
}

function check(node: unknown, depth: number): void {
  if (Array.isArray(node)) {
    for (const item of node) check(item, depth);
    return;
  }
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  if ("$ref" in n) throw new ModelOutputError("schema", "a recursive schema (a $ref) is not supported");
  if ("allOf" in n || "oneOf" in n) throw new ModelOutputError("schema", "allOf and oneOf are not supported");
  if (n.type === "object" || "properties" in n) {
    if (depth > MAX_NESTING) throw new ModelOutputError("schema", `the schema nests past ${MAX_NESTING} levels`);
    if (n.additionalProperties !== false)
      throw new ModelOutputError("schema", "every object must set additionalProperties: false");
    const keys = Object.keys((n.properties as Node | undefined) ?? {});
    const required = new Set(Array.isArray(n.required) ? (n.required as string[]) : []);
    if (keys.some((k) => !required.has(k)))
      throw new ModelOutputError(
        "schema",
        "every property must be required (a field that may be absent is .nullable())",
      );
    for (const value of Object.values((n.properties as Node | undefined) ?? {})) check(value, depth + 1);
  }
  for (const [key, value] of Object.entries(n)) if (key !== "properties") check(value, depth);
}

// Every property name the schema declares: the only words of a path that may be repeated back to the model.
function names(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const item of node) names(item, into);
  else if (node && typeof node === "object") {
    const n = node as Node;
    for (const key of Object.keys((n.properties as Node | undefined) ?? {})) into.add(key);
    for (const value of Object.values(n)) names(value, into);
  }
  return into;
}

// A property the schema does not name, at any depth: refused whatever the zod object's mode (a plain `z.object` would
// strip it silently). Follows `properties`, `items` and `anyOf` (a nullable field).
function unknownProperty(value: unknown, node: Node): boolean {
  if (Array.isArray(value)) return node.items ? value.some((v) => unknownProperty(v, node.items as Node)) : false;
  if (value && typeof value === "object") {
    if (Array.isArray(node.anyOf)) return (node.anyOf as Node[]).every((branch) => unknownProperty(value, branch));
    const properties = node.properties as Record<string, Node> | undefined;
    if (!properties) return false;
    return Object.entries(value).some(([k, v]) => {
      const child = properties[k];
      return !child || unknownProperty(v, child);
    });
  }
  return false;
}

// A fixed message for each zod issue code: never zod's own text, which can quote a value or an unknown key.
const SAID: Record<string, string> = {
  invalid_type: "has the wrong type",
  invalid_value: "is not one of the allowed values",
  invalid_format: "is not in the required format",
  too_big: "is too large or too long",
  too_small: "is too small or too short",
  not_multiple_of: "is not an allowed step",
  unrecognized_keys: "has a property the schema does not name",
  invalid_union: "matches none of the allowed shapes",
  invalid_key: "has an invalid key",
  invalid_element: "has an invalid element",
  custom: "fails a check",
};

function said(issues: z.core.$ZodIssue[], known: Set<string>): string {
  const lines = issues.slice(0, 10).map((issue) => {
    const path = issue.path
      .map((segment) => (typeof segment === "number" || known.has(String(segment)) ? String(segment) : "(unknown)"))
      .join(".");
    return `${path || "(root)"} ${SAID[issue.code] ?? "is invalid"}`;
  });
  return lines.join("; ");
}

export type StructuredRequest = Omit<ResponsesParams, "text"> & { name: string };

export async function structured<S extends z.ZodType>(
  schema: S,
  request: StructuredRequest,
  ctx: MetaContext,
): Promise<{ value: z.infer<S>; logId: string | null; callId: string }> {
  const { name, ...params } = request;
  if (!NAME.test(name)) throw new ModelOutputError("schema", "a format's name is 1 to 64 of A-Z a-z 0-9 _ -");
  const json = formatSchema(schema);
  const known = names(json);
  const format = { type: "json_schema" as const, name, schema: json, strict: true };
  let input = params.input;
  let problems = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const answer = await metaResponses({ ...params, input, text: { format } } as ResponsesParams, ctx);
    // A paid answer that fails is marked on its call's record; a record that cannot be marked is logged.
    const fail = async (kind: ModelOutputErrorKind, message: string): Promise<never> => {
      await ctx.budget
        .outputFailed(answer.callId, `output-${kind}`)
        .catch(() => console.error(JSON.stringify({ event: "meta", outcome: "output-failure-unrecorded", kind })));
      throw new ModelOutputError(kind, message);
    };
    const data = answer.data as unknown as {
      status?: string;
      output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    };
    const parts = (data.output ?? []).flatMap((item) => (item.type === "message" ? (item.content ?? []) : []));
    // Only a completed answer is read; the others end the call, never entering the repair retry.
    if (data.status === "failed") return fail("failed", "Meta's answer failed");
    if (data.status === "incomplete") return fail("incomplete", "Meta's answer was cut off before it was whole");
    if (parts.some((part) => part.type === "refusal")) return fail("refused", "Meta refused to answer in the schema");
    if (data.status !== "completed") return fail("failed", "Meta's answer did not complete");
    const text = parts
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join("");
    let value: unknown;
    let parsedJson = true;
    try {
      value = JSON.parse(text);
    } catch {
      parsedJson = false;
    }
    if (!parsedJson) problems = "the answer was not JSON";
    else if (unknownProperty(value, json)) problems = "the answer has a property the schema does not name";
    else {
      const parsed = schema.safeParse(value);
      if (parsed.success) return { value: parsed.data, logId: answer.logId, callId: answer.callId };
      problems = said(parsed.error.issues, known);
    }
    if (attempt === 2) return fail("invalid", `Meta's answer did not match the schema after one retry: ${problems}`);
    await ctx.budget
      .outputFailed(answer.callId, "output-invalid")
      .catch(() =>
        console.error(JSON.stringify({ event: "meta", outcome: "output-failure-unrecorded", kind: "invalid" })),
      );
    input = [
      ...(typeof input === "string" ? [{ role: "user" as const, content: input }] : (input ?? [])),
      {
        role: "developer" as const,
        content: `Your previous answer did not match the required schema: ${problems}. Answer again, matching it exactly.`,
      },
    ] as ResponsesParams["input"];
  }
  throw new ModelOutputError("invalid", `Meta's answer did not match the schema: ${problems}`);
}
