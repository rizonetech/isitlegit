// The typed refusals of voice decoding (D01 T03 §2, §7), shared by `./decode` and `./mp3`.
export const MAX_SECONDS = 1_800;

export class UnsupportedAudio extends Error {
  override name = "UnsupportedAudio";
  constructor(readonly type: string) {
    super(`audio of type ${type} cannot be decoded yet; Ogg Opus, WAV and MP3 voice notes can`);
  }
}
export class CorruptAudio extends Error {
  override name = "CorruptAudio";
}
export class AudioTooLong extends Error {
  override name = "AudioTooLong";
  constructor(readonly seconds: number) {
    super(`the recording is ${Math.round(seconds / 60)} minutes long; at most ${MAX_SECONDS / 60} minutes are taken`);
  }
}
