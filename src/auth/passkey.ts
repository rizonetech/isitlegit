// Passkey responses vetted before the plugin reads them (D07 T02 §2). The plugin consumes a ceremony's challenge first
// and verifies after, so anything its verifier refuses (a malformed or forged response, one without user verification)
// would cost the member the challenge, and some shapes surface as 500s. Here @simplewebauthn's own verifier, the one
// the plugin uses, runs first against the stored challenge without consuming it, and user verification is required: a
// refusal is a 400 (401 for an unknown credential or a signature that does not match; a device not unlocked is 400 at
// registration, 401 at sign-in, both with the code USER_VERIFICATION_REQUIRED) and the member's real response can still
// finish. A challenge stored for the other ceremony is refused before the plugin would consume it. The
// plugin then verifies again and does the rest. A credential ID already registered to anyone is refused here too
// (WebAuthn Level 3 §7.1; migration 0009 holds it in the database).
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { APIError, type createAuthMiddleware } from "better-auth/api";

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];
export type RelyingParty = { id: string; origin: string };

// The plugin's challenge cookie (its default `advanced.webAuthnChallengeCookie`) and the stored value it points to.
const CHALLENGE_COOKIE = "better-auth-passkey";

// The challenge stored for this ceremony, or null when there is none (the plugin answers that, CHALLENGE_NOT_FOUND). A
// challenge stored for the other ceremony is refused here, before the plugin would consume it and then refuse.
async function storedChallenge(ctx: HookContext, ceremony: "registration" | "authentication") {
  const cookie = ctx.context.createAuthCookie(CHALLENGE_COOKIE).name;
  const token = await ctx.getSignedCookie(cookie, ctx.context.secret);
  const record = token ? await ctx.context.internalAdapter.findVerificationValue(token) : null;
  if (!record) return null;
  let value: { type?: unknown; expectedChallenge?: unknown } | null = null;
  try {
    value = JSON.parse(record.value);
  } catch {}
  if (value?.type !== ceremony || typeof value.expectedChallenge !== "string") throw unverifiable();
  return value.expectedChallenge;
}

const unverifiable = () => new APIError("BAD_REQUEST", { message: "the passkey response could not be verified" });
// A passkey answered by a device that was present but not unlocked (a security key with no PIN): its own code, so the
// sign-in page can say to unlock the device or use the email link (§7).
export const USER_VERIFICATION_REQUIRED = "USER_VERIFICATION_REQUIRED";
const notUnlocked = (status: "BAD_REQUEST" | "UNAUTHORIZED") =>
  new APIError(status, {
    code: USER_VERIFICATION_REQUIRED,
    message: "the passkey must be unlocked on the device (a PIN, fingerprint or face), or use the email link",
  });
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
    // Checked below from the result, so a device that was not unlocked gets its own answer, not a generic one.
    requireUserVerification: false,
  }).catch(() => null);
  if (!result?.verified || !result.registrationInfo) throw unverifiable();
  if (!result.registrationInfo.userVerified) throw notUnlocked("BAD_REQUEST");
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
  // An unknown credential is refused here too, so naming one does not cost the member the challenge. Each sign-in refusal
  // of a credential carries the plugin's own code for it, so the sign-in page can tell a passkey removed from the account
  // from a signature that failed (D07 T02 §16).
  if (!passkey)
    throw new APIError("UNAUTHORIZED", { code: "PASSKEY_NOT_FOUND", message: "this passkey is not registered" });
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
    requireUserVerification: false,
  }).catch(() => null);
  if (!result) throw unverifiable();
  if (!result.verified)
    throw new APIError("UNAUTHORIZED", { code: "AUTHENTICATION_FAILED", message: "the passkey could not be verified" });
  if (!result.authenticationInfo.userVerified) throw notUnlocked("UNAUTHORIZED");
}

// The sign-in options as served: the plugin hard-codes `userVerification: "preferred"` there and lists the caller's own
// passkeys when a session cookie is present. Sign-in requires verification (above) and asks anonymously for any
// discoverable passkey, so the options say exactly that.
// WORKAROUND: @better-auth/passkey 1.7.13 has no option for the authentication options' userVerification or
// allowCredentials; this after hook rewrites only those two fields of its JSON answer.
export function authenticationOptions(returned: unknown) {
  if (!returned || typeof returned !== "object" || returned instanceof Response) return null;
  return { ...(returned as Record<string, unknown>), userVerification: "required", allowCredentials: [] };
}
