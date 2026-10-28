// The Better Auth options that shape its tables (D07 T02 §1), shared by src/auth/auth.ts and scripts/auth-schema.ts so
// the migration Better Auth compiles is the schema the Worker uses. It imports nothing of the Worker's, so the script
// runs in plain Node.
import { magicLink } from "better-auth/plugins/magic-link";

export const MAGIC_LINK_SECONDS = 15 * 60;
// A link's token is stored only as its hash, so a copy of the verification table opens no account.

type SendMagicLink = Parameters<typeof magicLink>[0]["sendMagicLink"];

export function schemaOptions(sendMagicLink: SendMagicLink) {
  return {
    emailAndPassword: { enabled: false },
    plugins: [magicLink({ expiresIn: MAGIC_LINK_SECONDS, storeToken: "hashed", sendMagicLink })],
  };
}
