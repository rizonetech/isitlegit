// Passkey responses vetted before the plugin reads them (D07 T02 §2). The plugin consumes a ceremony's challenge first
// and verifies after, so anything its verifier refuses (a malformed or forged response, one without user verification)
// would cost the member the challenge, and some shapes surface as 500s. Here @simplewebauthn's own verifier, the one
// the plugin uses, runs first against the stored challenge without consuming it, with user verification required: a
// refusal is a 400 (401 for an unknown credential or a signature that does not match) and the member's real response
// can still finish. The
// plugin then verifies again and does the rest. A credential ID already registered to anyone is refused here too
// (WebAuthn Level 3 §7.1; migration 0009 holds it in the database).
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { APIError, type createAuthMiddleware } from "better-auth/api";

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];
export type RelyingParty = { id: string; origin: string };

// The plugin's challenge cookie (its default `advanced.webAuthnChallengeCookie`) and the stored value it points to.
const CHALLENGE_COOKIE = "better-auth-passkey";

async function storedChallenge(ctx: HookContext, ceremony: "registration" | "authentication") {
  const cookie = ctx.context.createAuthCookie(CHALLENGE_COOKIE).name;
  const token = await ctx.getSignedCookie(cookie, ctx.context.secret);
  const record = token ? await ctx.context.internalAdapter.findVerificationValue(token) : null;
  try {
    const value = JSON.parse(record?.value ?? "null") as { type?: unknown; expectedChallenge?: unknown } | null;
    return value?.type === ceremony && typeof value.expectedChallenge === "string" ? value.expectedChallenge : null;
  } catch {
    return null;
  }
}

const unverifiable = () => new APIError("BAD_REQUEST", { message: "the passkey response could not be verified" });
const responseOf = (ctx: HookContext) => (ctx.body as { response?: unknown } | undefined)?.response as never;

// The one field the verifier passes through unchecked and the plugin then reads: `transports`, which it joins into a
// column, so anything but a short list of strings would fail there after the challenge is gone.
function transportsOk(response: unknown) {
  const transports = (response as { response?: { transports?: unknown } } | undefined)?.response?.transports;
  return (
    transports === undefined ||
    (Array.isArray(transports) &&
      transports.length <= 8 &&
      transports.every((t) => typeof t === "string" && t.length <= 32))
  );
}

export async function vetRegistration(ctx: HookContext, rp: RelyingParty) {
  const expectedChallenge = await storedChallenge(ctx, "registration");
  // No stored challenge: the plugin answers it (CHALLENGE_NOT_FOUND), as it would without this check.
  if (!expectedChallenge) return;
  if (!transportsOk(responseOf(ctx))) throw unverifiable();
  const result = await verifyRegistrationResponse({
    response: responseOf(ctx),
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: true,
  }).catch(() => null);
  if (!result?.verified || !result.registrationInfo) throw unverifiable();
  const id = result.registrationInfo.credential.id;
  const taken = await ctx.context.adapter.findOne({ model: "passkey", where: [{ field: "credentialID", value: id }] });
  if (taken) throw new APIError("BAD_REQUEST", { message: "this passkey is already registered" });
}

export async function vetAuthentication(ctx: HookContext, rp: RelyingParty) {
  const expectedChallenge = await storedChallenge(ctx, "authentication");
  if (!expectedChallenge) return;
  const id = (responseOf(ctx) as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string") throw unverifiable();
  const passkey = await ctx.context.adapter.findOne<{ publicKey: string; counter: number; transports?: string }>({
    model: "passkey",
    where: [{ field: "credentialID", value: id }],
  });
  // An unknown credential is refused here too, so naming one does not cost the member the challenge.
  if (!passkey) throw new APIError("UNAUTHORIZED", { message: "this passkey is not registered" });
  const result = await verifyAuthenticationResponse({
    response: responseOf(ctx),
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    credential: {
      id,
      publicKey: Uint8Array.from(atob(passkey.publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
      counter: passkey.counter,
      ...(passkey.transports ? { transports: passkey.transports.split(",") as never } : {}),
    },
    requireUserVerification: true,
  }).catch(() => null);
  if (!result) throw unverifiable();
  if (!result.verified) throw new APIError("UNAUTHORIZED", { message: "the passkey could not be verified" });
}
