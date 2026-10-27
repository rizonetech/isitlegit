// The typed refusals of voice decoding (D01 T03 §2, §7), shared by `./decode` and `./mp3`.
export const MAX_SECONDS = 1_800;

// AAC in an MP4 container: what an iPhone voice memo is (D01 T03 §8 refuses it until §10).
const M4A_TYPES = new Set(["audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac"]);

// A refusal the upload page shows as it is (D01 T03 §1, §6): it names the recording in the member's terms and says
// what to do instead, with the formats that are taken (Ogg Opus, WAV and MP3).
export class UnsupportedAudio extends Error {
  override name = "UnsupportedAudio";
  constructor(readonly type: string) {
    super(
      M4A_TYPES.has(type)
        ? "This recording is M4A (AAC, as iPhone voice memos are), which cannot be checked yet. Export it as MP3 or " +
            "WAV, or send it as a WhatsApp voice note (Ogg Opus), and upload that file."
        : `Audio of type ${type} cannot be checked. Upload it as Ogg Opus, WAV or MP3.`,
    );
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
