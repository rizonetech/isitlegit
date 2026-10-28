// What an uploaded file is, read from its bytes, never its name (D01 T03 §1): a saved message (.eml, .msg), a document
// (PDF), an image (PNG, JPEG, WebP) or a voice note (Ogg Opus, WAV, MP3). A container is looked into, not taken by its
// signature: an OLE compound file is a message only when it is an Outlook message, Ogg only when it carries Opus, RIFF
// only as WAVE or WEBP. Anything else is refused, with words a member can act on.
import { UnsupportedAudio } from "../voice/errors";
import { scanMp3 } from "../voice/mp3";
import { child, readCompoundFile } from "./cfb";

export type Sniffed =
  | { kind: "mail"; format: "eml" | "msg"; mediaType: string; headersAvailable: boolean }
  | { kind: "document" | "image" | "audio"; mediaType: string };
export type Refused = { refused: string };

const startsWith = (bytes: Uint8Array, ...prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

const NOT_TAKEN =
  "This file cannot be checked. Upload a saved email (.eml or .msg), a PDF, an image (PNG, JPEG or WebP), or a voice note (Ogg Opus, WAV or MP3).";

export function sniff(bytes: Uint8Array): Sniffed | Refused {
  if (ascii(bytes, 0, 5) === "%PDF-") return { kind: "document", mediaType: "application/pdf" };
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return { kind: "image", mediaType: "image/png" };
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return { kind: "image", mediaType: "image/jpeg" };
  if (ascii(bytes, 0, 4) === "RIFF") {
    const form = ascii(bytes, 8, 4);
    if (form === "WEBP") return { kind: "image", mediaType: "image/webp" };
    if (form === "WAVE") return { kind: "audio", mediaType: "audio/wav" };
    return { refused: NOT_TAKEN };
  }
  if (ascii(bytes, 0, 4) === "OggS") {
    // RFC 7845 3: the first page carries the OpusHead; any other codec in Ogg (Vorbis, FLAC, video) is not taken.
    const segments = bytes[26] ?? 0;
    const body = 27 + segments;
    return ascii(bytes, body, 8) === "OpusHead"
      ? { kind: "audio", mediaType: "audio/ogg" }
      : { refused: new UnsupportedAudio("audio/ogg; codecs=other").message };
  }
  // MPEG audio is taken only as the decoder takes it (src/voice/mp3.ts): Layer III with a defined bitrate in every frame,
  // the tags set aside, so a Layer II, a free-format or a tag-only file is refused here rather than admitted for a
  // transcription step that cannot read it (D01 T03 §1's final review).
  if (ascii(bytes, 0, 3) === "ID3" || isMpegAudioFrame(bytes)) return mp3(bytes);
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    // An M4A voice memo is refused by type, with the formats taken (D01 T03 §8: AAC waits on §10).
    if (["M4A ", "M4B ", "M4P "].includes(brand)) return { refused: new UnsupportedAudio("audio/mp4").message };
    return { refused: NOT_TAKEN };
  }
  if (startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))
    return isOutlookMessage(bytes)
      ? { kind: "mail", format: "msg", mediaType: "application/vnd.ms-outlook", headersAvailable: false }
      : { refused: NOT_TAKEN };
  const headers = rfc5322Headers(bytes);
  if (headers)
    return {
      kind: "mail",
      format: "eml",
      mediaType: "message/rfc822",
      // A saved message carries the original's headers when it has a delivery trace (D01 T01 §4).
      headersAvailable: headers.has("received") || headers.has("authentication-results"),
    };
  return { refused: NOT_TAKEN };
}

function mp3(bytes: Uint8Array): Sniffed | Refused {
  try {
    scanMp3(bytes);
    return { kind: "audio", mediaType: "audio/mpeg" };
  } catch (error) {
    if (error instanceof UnsupportedAudio) return { refused: error.message };
    return { refused: "This recording is damaged and cannot be checked. Upload it again, or export it as MP3 or WAV." };
  }
}

// An MPEG audio frame header (ISO 11172-3): the 11-bit sync, a valid version and layer, and a bitrate index that is not
// "bad". A file without an ID3 tag starts with one.
function isMpegAudioFrame(bytes: Uint8Array): boolean {
  const [a, b, c] = [bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0];
  if (a !== 0xff || (b & 0xe0) !== 0xe0) return false;
  const version = (b >> 3) & 0x3;
  const layer = (b >> 1) & 0x3;
  const bitrate = c >> 4;
  const rate = (c >> 2) & 0x3;
  return version !== 1 && layer !== 0 && bitrate !== 0xf && rate !== 0x3;
}

// An Outlook message: a readable compound file with a property stream and a message class (D01 T01 §6), not a Word or
// Excel file, which share the container.
function isOutlookMessage(bytes: Uint8Array): boolean {
  try {
    const file = readCompoundFile(bytes);
    return (
      child(file.root, "__properties_version1.0") !== null &&
      (child(file.root, "__substg1.0_001A001F") !== null || child(file.root, "__substg1.0_001A001E") !== null)
    );
  } catch {
    return false;
  }
}

// The header names of an RFC 5322 message, or null when the start of the file is not a header block: header fields
// (a name, a colon) up to a blank line within the first 64 KiB, with the two fields RFC 5322 3.6 requires of every
// message, From and Date, so a text file with a Subject line is not taken for one.
function rfc5322Headers(bytes: Uint8Array): Set<string> | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64 * 1024));
  const end = head.search(/\r?\n\r?\n/);
  if (end <= 0) return null;
  const names = new Set<string>();
  for (const line of head.slice(0, end).split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) continue;
    const field = /^([\x21-\x39\x3b-\x7e]+):/.exec(line);
    if (!field) return null;
    names.add((field[1] as string).toLowerCase());
  }
  return names.has("from") && names.has("date") ? names : null;
}
