// The daily caps on lookups to a provider that charges beyond a free tier (D02 T06 §1; spec 4.3a). Google Web Risk's
// Lookup API is free to 100,000 calls a month, then US$0.50 per 1,000: 3,000 a day is 90,000 in a 30-day month, inside
// the free tier, and 500 a day an organisation keeps one organisation from spending the rest.
export const WEB_RISK_ORG_DAILY = 500;
export const WEB_RISK_GLOBAL_DAILY = 3_000;

// The UTC day a cap counts in.
export const dayOf = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

export type CapScope = "organisation" | "global";

// Takes one place of a scope's cap for a UTC day, atomically: true when it was free and is now taken, false at the cap.
// Throws when D1 fails, so a caller never takes a place it has not confirmed.
export async function reserve(db: D1Database, day: string, scope: string, cap: number): Promise<boolean> {
  const done = await db
    .prepare(
      "INSERT INTO reputation_calls (day, scope, calls) VALUES (?1, ?2, 1) ON CONFLICT (day, scope) DO UPDATE SET calls = calls + 1 WHERE calls < ?3",
    )
    .bind(day, scope, cap)
    .run();
  return (done.meta.changes ?? 0) > 0;
}

// Gives back a place taken and not used. A failure is left as it is: the count stays high, never lower than the truth.
export async function release(db: D1Database, day: string, scope: string): Promise<void> {
  try {
    await db
      .prepare("UPDATE reputation_calls SET calls = calls - 1 WHERE day = ?1 AND scope = ?2 AND calls > 0")
      .bind(day, scope)
      .run();
  } catch {
    // Left counted.
  }
}
