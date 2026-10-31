// Remotion passes REMOTION_-prefixed environment variables into the bundle (REMOTION_THEME picks the theme); `process`
// is typed by @types/node.

// Narration clips are imported by src/data/voice.ts (tools/voice-index.py); Remotion's bundler serves them as URLs.
declare module "*.mp3" {
  const src: string;
  export default src;
}

// Demo capture clips are imported by src/data/demo-capture.ts (capture/index.ts), served the same way.
declare module "*.webm" {
  const src: string;
  export default src;
}

// The generated shots and plates (capture/index.ts), served the same way.
declare module "*.mp4" {
  const src: string;
  export default src;
}
declare module "*.png" {
  const src: string;
  export default src;
}
