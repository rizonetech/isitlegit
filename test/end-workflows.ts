import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach } from "vitest";

// Every Worker test ends the analysis Workflow instances it starts (a CI shard hung 12 minutes after its last file
// ended, trust-lane run 41254406140: instances a test had started through intake kept retrying their steps and held
// the runtime open). An introspector is taken before each test and disposed after it, which ends every instance
// created meanwhile, whether the test waited for it or not; a test that waits for its instance still reads it whole.
// test/workflow-instances.test.ts proves an instance left running is ended.
type Introspector = Awaited<ReturnType<typeof introspectWorkflow>>;
let current: Introspector | null = null;

beforeEach(async () => {
  current = await introspectWorkflow(env.ANALYSIS);
});

afterEach(async () => {
  const introspector = current;
  current = null;
  await introspector?.dispose();
});
