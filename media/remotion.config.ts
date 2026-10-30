import { Config } from "@remotion/cli/config";

// Brand files and fonts are read from design/ unchanged (staticFile("brand/..."), staticFile("fonts/...")).
Config.setPublicDir("../design");

// Use an installed Chrome when one is named, for example the cloud session's pre-installed headless shell.
if (process.env.REMOTION_BROWSER) Config.setBrowserExecutable(process.env.REMOTION_BROWSER);
