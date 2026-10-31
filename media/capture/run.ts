// pnpm capture:demo [signup | signin | beats]: the demo capture rig's front door (D09 T02 §3).
//   signup  once: create the demo member and its organisation (CAPTURE_INVITE from the vault, never argv)
//   signin  sign the demo member in again when its session has lapsed
//   beats   (the default) record every live beat to out/capture/<UTC stamp>/ with a manifest.json
// Captures and their manifests stay in media/out/ (git-ignored); nothing here records the invite code.
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signedIn, signIn, signUp } from "./auth.ts";
import { type BeatResult, casesList, uploadAndReport } from "./beats.ts";
import { APP, liveCommit, MAILBOX, open, SIZE } from "./lib.ts";

const OUT = new URL("../out/capture/", import.meta.url).pathname;

async function beats(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(OUT, stamp);
  mkdirSync(dir, { recursive: true });
  const ctx = await open(dir);
  const results: BeatResult[] = [];
  const skipped: { beat: string; reason: string }[] = [];
  try {
    if (!(await signedIn(ctx))) await signIn(ctx);
    for (const [name, run] of [
      ["upload-and-report", uploadAndReport],
      ["cases", casesList],
    ] as const) {
      try {
        results.push(await run(ctx, dir));
        console.log(`captured: ${name}`);
      } catch (e) {
        skipped.push({ beat: name, reason: (e as Error).message.split("\n")[0] });
        console.log(`skipped: ${name}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    await ctx.close();
  }
  // Playwright records every page under a random name; each beat saved its own under the beat's name, so the rest
  // (the sign-in check's page, and the originals of the saved ones) go.
  for (const f of readdirSync(dir)) if (/^[0-9a-f]{32}\.webm$/.test(f)) rmSync(join(dir, f));
  const manifest = { capturedAt: new Date().toISOString(), app: APP, liveCommit: await liveCommit(), member: MAILBOX, size: SIZE, beats: results, skipped };
  const path = join(dir, "manifest.json");
  writeFileSync(`${path}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  console.log(`manifest: ${path}`);
  if (skipped.length) process.exitCode = 1;
}

async function once(step: "signup" | "signin"): Promise<void> {
  const ctx = await open();
  try {
    await (step === "signup" ? signUp(ctx) : signIn(ctx));
    console.log(`${step}: done, signed in as ${MAILBOX}`);
  } finally {
    await ctx.close();
  }
}

const step = process.argv[2] ?? "beats";
if (step === "signup" || step === "signin") await once(step);
else if (step === "beats") await beats();
else {
  console.error("usage: pnpm capture:demo [signup | signin | beats]");
  process.exitCode = 2;
}
