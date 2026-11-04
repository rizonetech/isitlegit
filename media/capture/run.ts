// pnpm capture:demo [signup | signin | beats]: the demo capture rig's front door (D09 T02 §3).
//   signup  once: create the demo member and its organisation (CAPTURE_INVITE from the vault, never argv)
//   signin  sign the demo member in again when its session has lapsed
//   protect  register Fynbos Freight's protected identity on /protect from data/demo/fynbos-freight/brand.json
//   signin-mailbox  sign the profile in to Outlook again (CAPTURE_MAILBOX_PASSWORD from the vault, never argv)
//   beats   (the default) record every live beat to out/capture/<UTC stamp>/ with a manifest.json
// Captures and their manifests stay in media/out/ (git-ignored); nothing here records the invite code. The demo member,
// its organisation, its cases and its mailbox are protected (operator, 2026-10-31): nothing in the rig deletes, resets or
// moves their data.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signedIn, signIn, signUp } from "./auth.ts";
import { type BeatResult, casesList, domainsList, evalPage, mailSend, monitorPage, protectIdentity, seedLures, suppliersLedger, uploadAndReport, verifyPage } from "./beats.ts";
import { APP, liveCommit, MAILBOX, open, SIZE } from "./lib.ts";
import { signInMailbox } from "./mail.ts";
import { registerIdentity } from "./register.ts";

const OUT = new URL("../out/capture/", import.meta.url).pathname;

async function beats(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(OUT, stamp);
  mkdirSync(dir, { recursive: true });
  const ctx = await open(dir);
  const results: BeatResult[] = [];
  const skipped: { beat: string; reason: string }[] = [];
  const optional: { beat: string; reason: string }[] = [];
  try {
    if (!(await signedIn(ctx))) await signIn(ctx);
    for (const [name, run] of [
      ["mail-send", mailSend],
      ["upload-and-report", uploadAndReport],
      ["domains", domainsList],
      ["protect", protectIdentity],
      ["suppliers", suppliersLedger],
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
    // Pages that join the demo as they deploy: one that is not live yet is listed under `optional`, so it never makes the
    // whole capture unusable (capture/index.ts picks the newest capture with nothing skipped).
    for (const [name, run] of [
      ["verify", verifyPage],
      ["eval", evalPage],
      ["monitor", monitorPage],
    ] as const) {
      try {
        results.push(await run(ctx, dir));
        console.log(`captured: ${name}`);
      } catch (e) {
        optional.push({ beat: name, reason: (e as Error).message.split("\n")[0] });
        console.log(`not captured (optional): ${name}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    await ctx.close();
  }
  // Playwright records every page under a random name; each beat saved its own under the beat's name, so the rest
  // (the sign-in check's page, and the originals of the saved ones) go.
  for (const f of readdirSync(dir)) if (/^[0-9a-f]{32}\.webm$/.test(f)) rmSync(join(dir, f));
  const manifest = { capturedAt: new Date().toISOString(), app: APP, liveCommit: await liveCommit(), member: MAILBOX, size: SIZE, beats: results, skipped, optional };
  const path = join(dir, "manifest.json");
  writeFileSync(`${path}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  console.log(`manifest: ${path}`);
  if (skipped.length) process.exitCode = 1;
}

async function protect(): Promise<void> {
  const dir = join(OUT, `protect-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  const ctx = await open(dir);
  try {
    if (!(await signedIn(ctx))) await signIn(ctx);
    const registered = await registerIdentity(ctx, dir);
    const domainsBeat = await domainsList(ctx, dir);
    const protectBeat = await protectIdentity(ctx, dir);
    console.log(JSON.stringify({ registered, beats: [domainsBeat, protectBeat] }, null, 2));
  } finally {
    await ctx.close();
  }
  for (const f of readdirSync(dir)) if (/^[0-9a-f]{32}\.webm$/.test(f)) rmSync(join(dir, f));
}

async function once(step: "signup" | "signin" | "signin-mailbox"): Promise<void> {
  const ctx = await open();
  try {
    await (step === "signup" ? signUp(ctx) : step === "signin" ? signIn(ctx) : signInMailbox(ctx, MAILBOX));
    console.log(`${step}: done, signed in as ${MAILBOX}`);
  } finally {
    await ctx.close();
  }
}

async function seed(): Promise<void> {
  const dir = join(OUT, `seed-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  mkdirSync(dir, { recursive: true });
  const ctx = await open(dir);
  try {
    console.log(JSON.stringify(await seedLures(ctx, dir), null, 2));
  } finally {
    await ctx.close();
  }
  for (const f of readdirSync(dir)) if (/^[0-9a-f]{32}\.webm$/.test(f)) rmSync(join(dir, f));
}

// Record one beat again into the newest capture and replace it in that manifest: a beat that failed for a reason fixed
// since (a changed selector) is redone without sending the mail and uploading the lure a second time.
async function redo(name: string): Promise<void> {
  const runs = { cases: casesList, domains: domainsList, protect: protectIdentity, suppliers: suppliersLedger, verify: verifyPage, eval: evalPage, monitor: monitorPage } as const;
  const run = runs[name as keyof typeof runs];
  if (!run) throw new Error(`no beat named ${name} to redo`);
  const dir = join(OUT, readdirSync(OUT).filter((d) => /^\d{4}-/.test(d)).sort().reverse()[0]);
  const ctx = await open(dir);
  let result: BeatResult;
  try {
    if (!(await signedIn(ctx))) await signIn(ctx);
    result = await run(ctx, dir);
  } finally {
    await ctx.close();
  }
  for (const f of readdirSync(dir)) if (/^[0-9a-f]{32}\.webm$/.test(f)) rmSync(join(dir, f));
  const path = join(dir, "manifest.json");
  const m = JSON.parse(readFileSync(path, "utf8"));
  m.beats = [...m.beats.filter((b: BeatResult) => b.beat !== name), result];
  m.skipped = m.skipped.filter((s: { beat: string }) => s.beat !== name);
  if (m.optional) m.optional = m.optional.filter((s: { beat: string }) => s.beat !== name);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(m, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  console.log(`redone: ${name} in ${path}`);
}

const step = process.argv[2] ?? "beats";
if (step === "signup" || step === "signin" || step === "signin-mailbox") await once(step);
else if (step === "beats") await beats();
else if (step === "protect") await protect();
else if (step === "seed") await seed();
else if (step === "redo") await redo(process.argv[3] ?? "");
else {
  console.error("usage: pnpm capture:demo [signup | signin | signin-mailbox | protect | seed | beats]");
  process.exitCode = 2;
}
