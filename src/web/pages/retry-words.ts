// The words a member's refused retry is said in (D07 T03 §20), in a module of its own so the report's live region draws
// them without loading the retry route (and the auth it reads). The refusals with no words show the case as it now
// stands: a verdict (`has_verdict`) or a check running (`not_failed`). Each key is a `RetryRefusal` code
// (src/pipeline/retry.ts); the route checks they agree. `start_unknown` is not among them: it is a state, below.
export const RETRY_WORDS = {
  not_finished: "The check that failed is still finishing. Try again in a minute.",
  not_started: "The check could not be started again just now. Nothing changed: try again in a moment.",
  database: "The check could not be started again just now. Nothing changed: try again in a moment.",
} as const;
export type RetryNote = keyof typeof RETRY_WORDS;
// Said on the running view while a retry's start is unconfirmed (D07 T03 §20), from the case's persisted state, not from
// an address: the case is `received` under a retry's run id and that run has recorded no step yet. It clears the moment
// the run records one, and never expires while it is unresolved (`sweepRetries` settles it either way).
export const CONFIRMING = "We are confirming whether the check started again. This page updates by itself.";
