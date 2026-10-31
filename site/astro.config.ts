// The marketing site at isitlegit.co.za (D07 T06): static pages in the app's tokens and fonts.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import appFonts from "./src/integrations/app-fonts.ts";

export default defineConfig({
  site: "https://isitlegit.co.za",
  output: "static",
  integrations: [appFonts()],
  vite: { plugins: [tailwindcss()] },
});
