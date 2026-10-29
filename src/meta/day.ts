// The budget's day (D03 T01 §2): the date in South Africa (SAST, UTC+2 all year, no daylight saving), shared by the
// Worker and every local script, so a call near midnight counts on the same day wherever it was made.
const SAST_OFFSET_MS = 2 * 60 * 60_000;

export const sastDay = (at: Date = new Date()): string =>
  new Date(at.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
