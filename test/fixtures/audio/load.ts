// The audio fixtures as bytes inside workerd, which has no file system: Vite inlines each file as a data URL.
import oggUrl from "./tone.ogg?inline";
import wavUrl from "./tone.wav?inline";
import stereoUrl from "./tone-stereo.ogg?inline";

const bytes = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));
export const toneOgg = bytes(oggUrl);
export const toneStereoOgg = bytes(stereoUrl);
export const toneWav = bytes(wavUrl);
