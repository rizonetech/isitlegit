import { Config } from "@remotion/cli/config";

// Brand files and fonts are read from design/ unchanged (staticFile("brand/..."), staticFile("fonts/...")).
Config.setPublicDir("../design");

// Use an installed Chrome when one is named, for example the cloud session's pre-installed headless shell.
if (process.env.REMOTION_BROWSER) Config.setBrowserExecutable(process.env.REMOTION_BROWSER);

// Render threads on a shared machine (AGENTS.md, Machine): two by default, which keeps a long render light;
// RENDER_CONCURRENCY=1 makes it lighter still. The render scripts pass no --concurrency, so this setting holds for every
// one of them, and a value that is not a whole number from 1 to 8 stops the render instead of being ignored.
const concurrency = Number(process.env.RENDER_CONCURRENCY ?? "2");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  throw new Error(`RENDER_CONCURRENCY must be a whole number from 1 to 8, not ${process.env.RENDER_CONCURRENCY}`);
}
Config.setConcurrency(concurrency);
