-- A passkey's credential ID belongs to one registration (D07 T02 §2; WebAuthn Level 3 §7.1, "verify that the
-- credentialId is not yet registered"). Better Auth's passkey schema indexes it but cannot declare it unique, so the
-- database holds the rule, also against two registrations racing; src/auth/auth.ts refuses a known ID first, with a 400.
CREATE UNIQUE INDEX passkey_credential_id_unique ON passkey ("credentialID");
