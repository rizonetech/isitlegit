// Reproduction settings are derived from the immutable run source, never the latest checkout.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { type Configuration, ConfigurationSchema, type State } from "./multistep-core.ts";
import { UNKNOWN_DIAGNOSTIC } from "./multistep-observation.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function source(sha: string, path: string) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("configuration requires exact source identity");
  const result = spawnSync("git", ["show", `${sha}:${path}`], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error("configuration source unavailable");
  return result.stdout;
}
// Restricted literal grammar only, with no evaluation of source expressions.
// Unsupported source shapes fail closed instead of guessing their configured value.
function literal(raw: string): unknown {
  const text = raw.trim().replace(/\s+as const$/, "");
  if (/^\d[\d_]*$/.test(text)) return Number(text.replaceAll("_", ""));
  if (text === "false") return false;
  if (text === "true") return true;
  const strings = text.match(/"(?:[^"\\]|\\.)*"/g);
  if (strings && text.replace(/"(?:[^"\\]|\\.)*"/g, "S").match(/^S(?:\s*\+\s*S)*$/))
    return strings.map((value) => JSON.parse(value) as string).join("");
  const object = /^\{\s*steps:\s*(\d[\d_]*),\s*ms:\s*(\d[\d_]*)\s*\}$/.exec(text);
  if (object?.[1] && object[2])
    return { steps: Number(object[1].replaceAll("_", "")), ms: Number(object[2].replaceAll("_", "")) };
  throw new Error("nonliteral configuration");
}
function constant(text: string, name: string): unknown {
  const found = [...text.matchAll(new RegExp(`^export const ${name}\\s*=\\s*([\\s\\S]*?);`, "gm"))];
  if (found.length !== 1) throw new Error("configuration constant ambiguous");
  return literal(z.string().parse(found[0]?.[1]));
}
function properties(text: string, name: string): unknown[] {
  const found = [
    ...text.matchAll(new RegExp(`(?:[,{]\\s*|^\\s*)${name}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)`, "gm")),
  ];
  return found.map((match) => literal(z.string().parse(match[1])));
}
function property(text: string, name: string): unknown {
  const values = properties(text, name);
  if (values.length !== 1) throw new Error("configuration property ambiguous");
  return values[0];
}
export function sourceConfiguration(sha: string): Configuration {
  const wonder = source(sha, "src/walkthrough/wonder.ts"),
    limits = source(sha, "src/walkthrough/limits.ts"),
    driver = source(sha, "src/walkthrough/driver.ts"),
    client = source(sha, "src/meta/client.ts"),
    untrusted = source(sha, "src/meta/untrusted.ts"),
    adapter = source(sha, "test/eval/frontier-multistep-live.test.ts");
  const goal = z.string().parse(constant(wonder, "GOAL")),
    warning = z.string().parse(constant(untrusted, "UNTRUSTED_WARNING"));
  const containment = z.object({ steps: z.number(), ms: z.number() }).parse(constant(driver, "LIMITS"));
  const storage = properties(client, "store");
  if (!storage.length || storage.some((value) => value !== false)) throw new Error("store policy differs");
  if (
    [wonder, client].some((text) => properties(text, "reasoning").length || properties(text, "reasoning_effort").length)
  )
    throw new Error("effort configuration differs");
  if (property(driver, "behavior") !== "deny") throw new Error("download policy differs");
  return ConfigurationSchema.parse({
    model: constant(limits, "MODEL"),
    promptReference: "src/walkthrough/wonder.ts#GOAL",
    promptSha256: hash(goal),
    untrustedReference: "src/meta/untrusted.ts#UNTRUSTED_WARNING",
    untrustedSha256: hash(warning),
    promptTemplateReference: "src/walkthrough/wonder.ts#walk",
    promptTemplateSourceSha256: hash(wonder),
    toolSchemaReference: "src/walkthrough/driver.ts#Action",
    toolSchemaSourceSha256: hash(driver),
    clientReference: "src/meta/client.ts",
    clientSourceSha256: hash(client),
    maxOutputTokens: constant(limits, "MAX_OUTPUT_TOKENS"),
    screenshotsRetained: constant(limits, "IMAGES_KEPT"),
    maxViewText: constant(limits, "MAX_VIEW_TEXT"),
    transportAttempts: property(adapter, "transportAttempts"),
    stepLimit: containment.steps,
    timeLimitMs: containment.ms,
    toolChoice: property(wonder, "tool_choice"),
    parallelToolCalls: property(wonder, "parallel_tool_calls"),
    store: false,
    reasoningEffort: null,
    downloadsAllowed: false,
    credentials: "per-case-canaries-only",
  });
}
export function renderSupplement(state: State) {
  const config = sourceConfiguration(state.sourceSha);
  if (state.configuration && JSON.stringify(state.configuration) !== JSON.stringify(config))
    throw new Error("persisted configuration differs from source");
  const diagnostics = state.slots.map((slot) => ({
    ordinal: slot.ordinal,
    diagnostic: slot.report?.diagnostic ?? UNKNOWN_DIAGNOSTIC,
    followupDiagnostics: slot.report?.followupDiagnostics ?? [],
  }));
  return `## Wonder configuration and diagnostics: ${state.id}\n\nConfigured from immutable source ${state.sourceSha}; configuration is not evidence of an actual model call. Prompt hashes cover the exact UTF-8 GOAL and UNTRUSTED_WARNING strings. Template and tool hashes bind the source that constructs dynamic canary/URL instructions, screenshot observations and tool schemas; private runtime values are excluded. reasoningEffort null means no explicit effort was configured.\n\nConfiguration:\n\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\`\n\nDiagnostics:\n\n\`\`\`json\n${JSON.stringify(diagnostics, null, 2)}\n\`\`\`\n\nMissing historical diagnostic fields remain unknown; later probes do not reconstruct them. Cohorts retain separate identities and denominators.\n`;
}
export function verifyPublished(state: State, core: string, published: string) {
  if (!published.includes(core.trim()) || !published.includes(renderSupplement(state).trim()))
    throw new Error("published measurement, diagnostics or required configuration differs");
}
