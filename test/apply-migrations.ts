import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Every worker test file starts from an empty in-memory D1 (D01 T01 §1): apply the schema first. Applied migrations are
// recorded, so a file that runs this twice applies nothing new.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
