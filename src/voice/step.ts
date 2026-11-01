// The `voice` Workflow step (D01 T03 §4): the transcript the `transcribe` step stored, read once for what the speaker asks
// and who they say they are, the result stored as the case's `voice-claim.json` so a retry or a replay reads it and
// does not ask the model again. A failure a retry may cure (the database, a rate limit, a timeout) is thrown, so the
// step is retried; a final one (a spent budget, an answer refused or outside the schema) is stored as not checked, so the
// case still completes.

import { artefactsOf, putArtefact, readArtefact, type Store } from "../intake/store";
import { d1Budget } from "../meta/budget";
import type { MetaEnv } from "../meta/client";
import { extractVoiceClaim } from "./extract";
import { StoredVoice, type VoiceRead } from "./schema";

// The step's own budget: the call's deadline (60 seconds, retries and repair included), the reads and the write.
export const VOICE_STEP_TIMEOUT_MS = 120_000;
export const VOICE_CLAIM_NAME = "voice-claim.json";
const TRANSCRIPT_SUFFIX = "-transcript.json";

async function find(store: Store, caseId: string, suffix: string): Promise<Uint8Array | null> {
  const found = (await artefactsOf(store, caseId, "audio")).find((a) => a.key.endsWith(suffix));
  if (!found) return null;
  const read = await readArtefact(store, caseId, found.key);
  return read && "body" in read ? read.body : null;
}

// The stored result, or null when none was stored or what is there is not one.
export async function readVoice(store: Store, caseId: string): Promise<VoiceRead | null> {
  const body = await find(store, caseId, `-${VOICE_CLAIM_NAME}`);
  if (!body) return null;
  try {
    const parsed = StoredVoice.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const storeVoice = (store: Store, caseId: string, read: VoiceRead) =>
  putArtefact(
    store,
    caseId,
    "audio",
    VOICE_CLAIM_NAME,
    new TextEncoder().encode(JSON.stringify(read)),
    "application/json",
  );

export async function voice(
  env: MetaEnv & { DB: D1Database },
  store: Store,
  caseId: string,
  hooks: { waitUntil?: (promise: Promise<unknown>) => void; fetch?: typeof fetch } = {},
): Promise<VoiceRead> {
  const stored = await readVoice(store, caseId);
  if (stored) return stored;
  const body = await find(store, caseId, TRANSCRIPT_SUFFIX);
  let result: VoiceRead;
  if (!body) result = { state: "not_checked", reason: "the transcript is not stored" };
  else {
    const transcript = JSON.parse(new TextDecoder().decode(body)) as { text?: unknown; complete?: unknown };
    const text = typeof transcript.text === "string" ? transcript.text : "";
    if (!text.trim()) result = { state: "silent" };
    else {
      const got = await extractVoiceClaim(text, {
        env,
        budget: d1Budget(env.DB, { caller: "voice-extract", caseId }),
        owner: { kind: "case", caseId, step: "voice" },
        waitUntil: hooks.waitUntil ?? ((promise) => void promise.catch(() => {})),
        ...(hooks.fetch ? { fetch: hooks.fetch } : {}),
      });
      if (!got.ok) {
        // A failure a retry may cure is thrown, with only its reason, so no content reaches the step's error.
        if (got.infra) throw new Error(`voice: ${got.reason}`);
        result = { state: "not_checked", reason: got.reason };
      } else result = { state: "read", claim: got.claim, dropped: got.dropped, complete: transcript.complete === true };
    }
  }
  await storeVoice(store, caseId, result);
  return result;
}
