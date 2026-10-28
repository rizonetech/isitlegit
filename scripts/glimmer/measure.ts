// The local runtime ledger for Loupe's dedicated deployment (D03 T04 §13): the deployment may run at most 30 minutes a
// day, warm-up included, so every local session that calls it is counted here before it starts.
//
//   node scripts/glimmer/measure.ts status            # today's minutes (SAST day) and what is left
//
// `build/glimmer-runtime.json` (written temp-then-rename) holds each burst: from its first request to its last answer,
// plus the 5 minutes the deployment stays up before it scales to zero. A session is refused when today's minutes plus its
// own estimate (its calls, plus warm-up and the 5-minute tail) would pass 30. §14 moves this ledger to D1, so a local
// session and the Worker's bursts add up in one total.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
export const LEDGER = join(ROOT, "build", "glimmer-runtime.json");
export const DAILY_MINUTES = 30;
export const TAIL_MINUTES = 5;

export type Burst = { day: string; start: string; lastAnswer: string | null };

// The SAST calendar day a moment falls on (the limit resets at midnight in South Africa).
export function sastDay(at: Date): string {
  return new Date(at.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
}

export function readBursts(file = LEDGER): Burst[] {
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf-8"));
  if (!Array.isArray(data)) throw new Error(`${file} is not a list of bursts`);
  return data as Burst[];
}

function writeBursts(bursts: Burst[], file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(bursts, null, 1)}\n`);
  renameSync(temporary, file);
}

// A burst's minutes: first request to last answer, plus the 5-minute tail. A burst with no answer yet counts until
// `now` plus the tail, so a session still running is never counted as cheaper than it is.
export function burstMinutes(burst: Burst, now: Date): number {
  const end = burst.lastAnswer ? new Date(burst.lastAnswer) : now;
  return Math.max(0, end.getTime() - new Date(burst.start).getTime()) / 60_000 + TAIL_MINUTES;
}

export function minutesUsed(bursts: Burst[], day: string, now: Date): number {
  return bursts.filter((b) => b.day === day).reduce((sum, b) => sum + burstMinutes(b, now), 0);
}

// Refuses a session whose estimate (its calls' minutes, plus warm-up, plus the tail) would take today past 30 minutes;
// otherwise records its burst as started and returns the functions that record its answers and its end.
export function startSession(
  estimateMinutes: number,
  options: { now?: Date; file?: string } = {},
): { answered: (at?: Date) => void } | { refused: string } {
  const now = options.now ?? new Date();
  const file = options.file ?? LEDGER;
  const bursts = readBursts(file);
  const day = sastDay(now);
  const used = minutesUsed(bursts, day, now);
  if (used + estimateMinutes + TAIL_MINUTES > DAILY_MINUTES)
    return {
      refused: `today has ${used.toFixed(1)} of ${DAILY_MINUTES} minutes used; this session needs ${(estimateMinutes + TAIL_MINUTES).toFixed(1)} more`,
    };
  const burst: Burst = { day, start: now.toISOString(), lastAnswer: null };
  bursts.push(burst);
  writeBursts(bursts, file);
  return {
    answered: (at = new Date()) => {
      const all = readBursts(file);
      const mine = all.find((b) => b.start === burst.start && b.day === day);
      if (mine) mine.lastAnswer = at.toISOString();
      writeBursts(all, file);
    },
  };
}

if (import.meta.filename === process.argv[1]) {
  const now = new Date();
  const used = minutesUsed(readBursts(), sastDay(now), now);
  console.log(`glimmer runtime: ${used.toFixed(1)} of ${DAILY_MINUTES} minutes used on ${sastDay(now)} (SAST)`);
}
