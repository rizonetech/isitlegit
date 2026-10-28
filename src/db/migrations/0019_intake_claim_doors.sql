-- A delivery's claim key carries its door from D01 T03 §1 on (src/intake/admit.ts, claimKey): `email:<Message-ID or
-- sha256:...>` or `upload:sha256:<hex>`. Every claim made before this migration was a forward's (the upload door ships
-- with it), so each takes the `email:` prefix, and a forward redelivered across the deploy still finds its claim.
UPDATE intake_messages SET message_key = 'email:' || message_key;
