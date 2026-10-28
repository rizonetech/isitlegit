// The Better Auth options that shape its tables (D07 T02 §1, §2), shared by src/auth/auth.ts and scripts/auth-schema.ts
// so the migrations Better Auth compiles are the schema the Worker uses. It imports nothing of the Worker's, so the
// script runs in plain Node.
import { passkey } from "@better-auth/passkey";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";

export const MAGIC_LINK_SECONDS = 15 * 60;
// A link's token is stored only as its hash, so a copy of the verification table opens no account.

type SendMagicLink = Parameters<typeof magicLink>[0]["sendMagicLink"];

// Passkeys belong to the host the app is served from: the relying party ID is APP_URL's hostname and the only origin
// accepted is APP_URL's (the plugin would otherwise trust the request's Origin header). Sign-in asks anonymously, with
// no credential list, so only a discoverable credential can answer it: registration requires one. User verification is
// required too (the device's owner unlocked it, not only that the device was present): the plugin verifies with it off,
// so both ceremonies check @simplewebauthn's verified result in the plugin's own afterVerification hooks, before a
// passkey is saved or a session made (WebAuthn Level 3 §7.1 step 16, §7.2 step 17).
const unverified = (status: "BAD_REQUEST" | "UNAUTHORIZED") =>
  new APIError(status, { message: "the passkey must be unlocked on the device (user verification)" });

export function schemaOptions(sendMagicLink: SendMagicLink, appURL: string) {
  const app = new URL(appURL);
  return {
    emailAndPassword: { enabled: false },
    plugins: [
      magicLink({ expiresIn: MAGIC_LINK_SECONDS, storeToken: "hashed", sendMagicLink }),
      passkey({
        rpID: app.hostname,
        rpName: "IsItLegit",
        origin: app.origin,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        registration: {
          afterVerification: async ({ verification }) => {
            if (!verification.registrationInfo?.userVerified) throw unverified("BAD_REQUEST");
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            if (!verification.authenticationInfo.userVerified) throw unverified("UNAUTHORIZED");
          },
        },
      }),
    ],
  };
}
