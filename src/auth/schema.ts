// The Better Auth options that shape its tables (D07 T02 §1, §2), shared by src/auth/auth.ts and scripts/auth-schema.ts
// so the migrations Better Auth compiles are the schema the Worker uses. It imports nothing of the Worker's, so the
// script runs in plain Node.
import { passkey } from "@better-auth/passkey";
import { magicLink } from "better-auth/plugins/magic-link";

export const MAGIC_LINK_SECONDS = 15 * 60;
// A link's token is stored only as its hash, so a copy of the verification table opens no account.

type SendMagicLink = Parameters<typeof magicLink>[0]["sendMagicLink"];

// Passkeys belong to the host the app is served from: the relying party ID is APP_URL's hostname and the only origin
// accepted is APP_URL's (the plugin would otherwise trust the request's Origin header). Sign-in asks anonymously, with
// no credential list, so only a discoverable credential can answer it: registration requires one. User verification is
// required too (the device's owner unlocked it, not only that the device was present): asked for here at registration,
// and in the sign-in options and both checks by src/auth/passkey.ts, since the plugin asks "preferred" at sign-in and
// verifies with it off (WebAuthn Level 3 §7.1 step 16, §7.2 step 17).
// The relying party for an app URL: its host is the ID, its origin the only one accepted.
export const relyingParty = (appURL: string) => {
  const app = new URL(appURL);
  return { id: app.hostname, origin: app.origin };
};

export function schemaOptions(sendMagicLink: SendMagicLink, appURL: string) {
  const rp = relyingParty(appURL);
  return {
    emailAndPassword: { enabled: false },
    plugins: [
      magicLink({ expiresIn: MAGIC_LINK_SECONDS, storeToken: "hashed", sendMagicLink }),
      passkey({
        rpID: rp.id,
        rpName: "IsItLegit",
        origin: rp.origin,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      }),
    ],
  };
}
