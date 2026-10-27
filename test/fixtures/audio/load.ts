// The audio fixtures as bytes inside workerd, which has no file system: Vite inlines each file as a data URL.

import mp3Url from "./tone.mp3?inline";
import oggUrl from "./tone.ogg?inline";
import wavUrl from "./tone.wav?inline";
import mp3_8kUrl from "./tone-8k.mp3?inline";
import mp3_16kUrl from "./tone-16k.mp3?inline";
import mp3_128kUrl from "./tone-128k.mp3?inline";
import mp3StereoUrl from "./tone-stereo.mp3?inline";
import stereoUrl from "./tone-stereo.ogg?inline";

const bytes = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));
export const toneOgg = bytes(oggUrl);
export const toneStereoOgg = bytes(stereoUrl);
export const toneWav = bytes(wavUrl);
export const toneMp3 = bytes(mp3Url);
export const tone128kMp3 = bytes(mp3_128kUrl);
export const toneStereoMp3 = bytes(mp3StereoUrl);
export const tone16kMp3 = bytes(mp3_16kUrl);
export const tone8kMp3 = bytes(mp3_8kUrl);
