// Remotion passes REMOTION_-prefixed environment variables into the bundle (REMOTION_THEME picks the theme).
declare const process: { env: Record<string, string | undefined> };

// Narration clips are imported by src/data/voice.ts (tools/voice-index.py); Remotion's bundler serves them as URLs.
declare module "*.mp3" {
  const src: string;
  export default src;
}
