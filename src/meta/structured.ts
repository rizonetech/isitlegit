// The structured output helper (D03 T01 §5): every model output passes a zod schema before use (AGENTS.md). The schema
// goes to Meta as the Responses API's `text.format` (json_schema, strict), which constrains decoding to it; the reply is
// read only when `completed`, refused if it names a property the schema does not, validated by zod, retried once with
// the problems said in trusted words, then refused. A schema Meta would refuse (sources/meta-api/docs/docs/
// structured-output.md: its strict subset and limits) is refused before any call, so nothing is reserved or sent for it.
// A paid answer that fails is marked on its call's record (D03 T01 §3), its usage and cost kept.
import { z } from "zod";
import { DEFAULT_DEADLINE_MS, type MetaContext, metaResponses, type ResponsesParams } from "./client.ts";
import {
  type DiagnosticCallback,
  DiagnosticSegment,
  deliverValidationDiagnostic,
  type ValidationIssue,
} from "./validation-diagnostics";

export type ModelOutputErrorKind = "schema" | "invalid" | "incomplete" | "refused" | "failed";

// Each paid attempt's call and gateway ids, so a failure is found in the ledger and the gateway's log directly
// (completion review): ids only, never the answer's content.
export type OutputCall = { callId: string; logId: string | null };

export class ModelOutputError extends Error {
  override name = "ModelOutputError";
  readonly kind: ModelOutputErrorKind;
  readonly calls: OutputCall[];
  constructor(kind: ModelOutputErrorKind, message: string, calls: OutputCall[] = []) {
    super(message);
    this.kind = kind;
    this.calls = calls;
  }
}

// How long recording a paid failure may hold the caller; a write past it goes on under `waitUntil` and is logged.
const RECORD_GRACE_MS = 1_000;

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
  // Meta's limits, measured as it measures them (final review): across the whole schema, its definitions included.
  limits(json);
  // A named sub-schema (a zod `id`) is a `$defs` reference: inlined here, so only a reference cycle is refused.
  const defs = { ...((json.$defs as Node | undefined) ?? {}), ...((json.definitions as Node | undefined) ?? {}) };
  const nodes = { n: 0 };
  const inlined = expand(json, defs, [], nodes) as Node;
  if (inlined.type !== "object" || "anyOf" in inlined || "enum" in inlined || "not" in inlined)
    throw new ModelOutputError("schema", "the schema's root must be a plain object");
  check(inlined, 1);
  return inlined;
}

// Meta's documented limits for a structured-output schema (sources/meta-api/docs/docs/structured-output.md, "Stay within
// schema constraints"): beyond any, it answers HTTP 400 before decoding.
export const SCHEMA_LIMITS = {
  properties: 5_000,
  stringLength: 120_000,
  enumValues: 1_000,
  largeEnumValues: 250,
  largeEnumLength: 15_000,
  expandedNodes: 200_000,
} as const;

function limits(json: Node): void {
  let properties = 0;
  let length = 0;
  let enumValues = 0;
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const n = node as Node;
    for (const key of ["properties", "$defs", "definitions"] as const) {
      const named = n[key] as Node | undefined;
      if (named && typeof named === "object") {
        if (key === "properties") properties += Object.keys(named).length;
        for (const name of Object.keys(named)) length += name.length;
      }
    }
    if (Array.isArray(n.enum)) {
      enumValues += n.enum.length;
      const strings = n.enum.filter((v): v is string => typeof v === "string");
      const chars = strings.reduce((sum, v) => sum + v.length, 0);
      length += chars;
      if (strings.length > SCHEMA_LIMITS.largeEnumValues && chars > SCHEMA_LIMITS.largeEnumLength)
        throw new ModelOutputError(
          "schema",
          `a string enum of over ${SCHEMA_LIMITS.largeEnumValues} values is too long`,
        );
    }
    if (typeof n.const === "string") length += n.const.length;
    for (const value of Object.values(n)) walk(value);
  };
  walk(json);
  if (properties > SCHEMA_LIMITS.properties)
    throw new ModelOutputError("schema", `the schema has more than ${SCHEMA_LIMITS.properties} properties`);
  if (length > SCHEMA_LIMITS.stringLength)
    throw new ModelOutputError(
      "schema",
      `the schema's names and values exceed ${SCHEMA_LIMITS.stringLength} characters`,
    );
  if (enumValues > SCHEMA_LIMITS.enumValues)
    throw new ModelOutputError("schema", `the schema has more than ${SCHEMA_LIMITS.enumValues} enum values`);
}

// The schema with every `$ref` replaced by its definition, counting nodes as Meta does once references are inlined; a
// reference to the root (`#`) or to a definition already being expanded is a cycle, which Meta refuses.
function expand(node: unknown, defs: Node, stack: string[], nodes: { n: number }): unknown {
  if (Array.isArray(node)) return node.map((item) => expand(item, defs, stack, nodes));
  if (!node || typeof node !== "object") return node;
  if (++nodes.n > SCHEMA_LIMITS.expandedNodes)
    throw new ModelOutputError("schema", `the schema expands past ${SCHEMA_LIMITS.expandedNodes} nodes`);
  const { $ref, $defs: _defs, definitions: _definitions, ...rest } = node as Node;
  const out: Node = {};
  if ($ref !== undefined) {
    const name = typeof $ref === "string" ? /^#\/(?:\$defs|definitions)\/(.+)$/.exec($ref)?.[1] : undefined;
    if (!name || stack.includes(name) || !Object.hasOwn(defs, name))
      throw new ModelOutputError("schema", "a recursive schema (a $ref cycle) is not supported");
    Object.assign(out, expand(defs[name], defs, [...stack, name], nodes));
  }
  for (const [key, value] of Object.entries(rest)) out[key] = expand(value, defs, stack, nodes);
  return out;
}

// `depth` counts every container, an object or an array alike (completion review): the root is level 1.
function check(node: unknown, depth: number): void {
  if (Array.isArray(node)) {
    for (const item of node) check(item, depth);
    return;
  }
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  if ("allOf" in n || "oneOf" in n) throw new ModelOutputError("schema", "allOf and oneOf are not supported");
  const container =
    n.type === "object" || n.type === "array" || "properties" in n || "items" in n || "prefixItems" in n;
  if (container && depth > MAX_NESTING)
    throw new ModelOutputError("schema", `the schema nests past ${MAX_NESTING} levels`);
  if (n.type === "array" || "items" in n || "prefixItems" in n) {
    for (const [key, value] of Object.entries(n))
      check(value, key === "items" || key === "prefixItems" ? depth + 1 : depth);
    return;
  }
  if (n.type === "object" || "properties" in n) {
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

// Whether zod's parse dropped a property the reply carried, at any depth (round 1): a union's parse can pick a branch
// other than the one the reply matched and strip the rest, so a value is used only if it kept everything the reply said.
function stripped(raw: unknown, parsed: unknown): boolean {
  if (Array.isArray(raw)) return Array.isArray(parsed) && raw.some((item, i) => stripped(item, parsed[i]));
  if (raw && typeof raw === "object") {
    if (!parsed || typeof parsed !== "object") return false;
    return Object.entries(raw).some(
      ([key, value]) => !Object.hasOwn(parsed, key) || stripped(value, (parsed as Record<string, unknown>)[key]),
    );
  }
  return false;
}

// The JSON type of a parsed value, as a schema names it.
const jsonType = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;

// Whether a schema node can describe a value of this JSON type (a node with no type, such as a union, can).
function admits(node: Node, type: string): boolean {
  if (node.type === undefined) return true;
  const types = Array.isArray(node.type) ? (node.type as string[]) : [node.type as string];
  return types.includes(type) || (type === "number" && types.includes("integer"));
}

// A property the schema does not name, at any depth: refused whatever the zod object's mode (a plain `z.object` would
// strip it silently). Follows `properties` (own names only, so an inherited `toString` is no property), `items` and
// `prefixItems` (a tuple), and `anyOf` (a nullable field or a union): there, only the branches of the value's own type
// count, and the value is clean if one of them takes it whole (completion review).
function unknownProperty(value: unknown, node: Node): boolean {
  if (Array.isArray(node.anyOf)) {
    const branches = (node.anyOf as Node[]).filter((branch) => admits(branch, jsonType(value)));
    return branches.length > 0 && branches.every((branch) => unknownProperty(value, branch));
  }
  if (Array.isArray(value)) {
    const prefix = Array.isArray(node.prefixItems) ? (node.prefixItems as Node[]) : [];
    const rest = node.items && typeof node.items === "object" ? (node.items as Node) : undefined;
    return value.some((v, i) => {
      const child = prefix[i] ?? rest;
      return child ? unknownProperty(v, child) : false;
    });
  }
  if (value && typeof value === "object") {
    const properties = (node.properties as Record<string, Node> | undefined) ?? {};
    return Object.entries(value).some(([k, v]) => {
      const child = Object.hasOwn(properties, k) ? properties[k] : undefined;
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

// `waitUntil` is required here (round 1): a paid failure's record that outlives its grace must outlive the invocation.
export type StructuredContext = MetaContext & {
  waitUntil: (promise: Promise<unknown>) => void;
  // A caller sharing a finalisation budget across its own outer retry (the citation validator,
  // D04 T01 §5) caps this so the retries never compose into an extra accepted answer; the default
  // stays the schema repair pair. The returned attempts count says what a call spent.
  maxAttempts?: number;
  onValidationDiagnostic?: DiagnosticCallback;
  validationAttemptOffset?: 0 | 1;
};

export async function structured<S extends z.ZodType>(
  schema: S,
  request: StructuredRequest,
  ctx: StructuredContext,
): Promise<{ value: z.infer<S>; logId: string | null; callId: string; attempts: number }> {
  const { name, ...params } = request;
  if (!NAME.test(name)) throw new ModelOutputError("schema", "a format's name is 1 to 64 of A-Z a-z 0-9 _ -");
  const json = formatSchema(schema);
  const known = names(json);
  const format = { type: "json_schema" as const, name, schema: json, strict: true };
  // One deadline over the first answer and its repair (completion review): the repair gets what is left, and none
  // starts once it is spent.
  const deadline = Date.now() + (ctx.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const calls: OutputCall[] = [];
  // A paid failure marked on its call's record, its wait bounded: a stalled write never holds the repair or the error.
  const mark = async (callId: string, kind: ModelOutputErrorKind) => {
    const written = ctx.budget.outputFailed(callId, `output-${kind}`).then(
      () => true,
      () => {
        console.error(JSON.stringify({ event: "meta", outcome: "output-failure-unrecorded", kind }));
        return true;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), RECORD_GRACE_MS);
    });
    if (!(await Promise.race([written, late]).finally(() => clearTimeout(timer)))) {
      ctx.waitUntil(written);
      console.error(JSON.stringify({ event: "meta", outcome: "output-failure-record-late", kind }));
    }
  };
  let input = params.input;
  let problems = "";
  const maxAttempts = Math.min(2, Math.max(1, ctx.maxAttempts ?? 2));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new ModelOutputError("invalid", `no time was left to repair the answer: ${problems}`, calls);
    const answer = await metaResponses({ ...params, input, text: { format } } as ResponsesParams, {
      ...ctx,
      deadlineMs: left,
    });
    calls.push({ callId: answer.callId, logId: answer.logId });
    const fail = async (kind: ModelOutputErrorKind, message: string): Promise<never> => {
      await mark(answer.callId, kind);
      throw new ModelOutputError(kind, message, calls);
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
    let issues: ValidationIssue[] = [];
    if (!parsedJson) {
      problems = "the answer was not JSON";
      issues = [{ category: "json_invalid", path: [] }];
    } else if (unknownProperty(value, json)) {
      problems = "the answer has a property the schema does not name";
      issues = [{ category: "unknown_property", path: [] }];
    } else {
      const parsed = schema.safeParse(value);
      if (parsed.success && !stripped(value, parsed.data))
        return { value: parsed.data, logId: answer.logId, callId: answer.callId, attempts: calls.length };
      problems = parsed.success
        ? "the answer has a property the schema does not name"
        : said(parsed.error.issues, known);
      issues = parsed.success
        ? [{ category: "unknown_property", path: [] }]
        : parsed.error.issues.slice(0, 4).map((issue) => ({
            category: "schema_invalid",
            path: diagnosticPath(json, issue.path),
          }));
    }
    const totalAttempt = attempt + (ctx.validationAttemptOffset ?? 0);
    await deliverValidationDiagnostic(
      ctx.onValidationDiagnostic,
      {
        phase: "structured",
        callId: answer.callId,
        attempt: totalAttempt,
        remaining: 2 - totalAttempt,
        issues,
      },
      ctx.waitUntil,
    );
    if (attempt === maxAttempts)
      return fail(
        "invalid",
        maxAttempts === 2
          ? `Meta's answer did not match the schema after one retry: ${problems}`
          : `Meta's answer did not match the schema: ${problems}`,
      );
    await mark(answer.callId, "invalid");
    input = [
      ...(typeof input === "string" ? [{ role: "user" as const, content: input }] : (input ?? [])),
      {
        role: "developer" as const,
        content: `Your previous answer did not match the required schema: ${problems}. Answer again, matching it exactly.`,
      },
    ] as ResponsesParams["input"];
  }
  throw new ModelOutputError("invalid", `Meta's answer did not match the schema: ${problems}`, calls);
}

// Follow trusted schema structure, never arbitrary names from a model or a validator message.
function diagnosticPath(schema: Node, path: readonly PropertyKey[]): ValidationIssue["path"] {
  let node = schema;
  const result: ValidationIssue["path"] = [];
  for (const segment of path.slice(0, 6)) {
    if (typeof segment === "number" && node.items && typeof node.items === "object") {
      result.push("*");
      node = node.items as Node;
    } else if (typeof segment === "string" && node.properties && Object.hasOwn(node.properties as object, segment)) {
      const safe = DiagnosticSegment.safeParse(segment);
      if (!safe.success) break;
      result.push(safe.data);
      node = (node.properties as Record<string, Node>)[segment] ?? {};
    } else break;
  }
  return result;
}
