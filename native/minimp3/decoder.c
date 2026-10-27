// The Worker's binding to minimp3 (D01 T03 §7), compiled to WebAssembly by scripts/build-wasm.py. It decodes
// one frame per call and reports minimp3's own result for it, so a frame minimp3 refuses (invalid side information,
// a bit reservoir it cannot restore) is seen as 0 samples instead of being hidden behind a count taken from the frame
// headers alone. The caller copies the MP3 into memory at input_offset() after set_input_size(), then calls
// decode_frame() with the byte offset of each frame in turn.
#define MINIMP3_ONLY_MP3
#define MINIMP3_NO_SIMD
#define MINIMP3_NONSTANDARD_BUT_LOGICAL
#define MINIMP3_IMPLEMENTATION
#include "minimp3.h"

#define EXPORT(name) __attribute__((export_name(name)))

// No C library in a freestanding WebAssembly module: the three routines minimp3 needs.
void *memmove(void *dest, const void *src, size_t n) {
  unsigned char *d = dest;
  const unsigned char *s = src;
  if (s < d) {
    while (n--) d[n] = s[n];
  } else {
    while (n--) *d++ = *s++;
  }
  return dest;
}
void *memcpy(void *dest, const void *src, size_t n) { return memmove(dest, src, n); }
void *memset(void *s, int c, size_t n) {
  unsigned char *p = s;
  while (n--) *p++ = (unsigned char)c;
  return s;
}

extern unsigned char __heap_base;
static mp3dec_t decoder;
static mp3dec_frame_info_t info;
static mp3d_sample_t pcm[MINIMP3_MAX_SAMPLES_PER_FRAME];
static size_t input_size;

EXPORT("input_offset") uint8_t *input_offset(void) { return &__heap_base; }

// Grows memory to hold `size` bytes of MP3 and resets the decoder; 0 if memory could not grow.
EXPORT("set_input_size") int set_input_size(size_t size) {
  size_t have = __builtin_wasm_memory_size(0) * 65536 - (size_t)&__heap_base;
  if (have < size && __builtin_wasm_memory_grow(0, (size - have) / 65536 + 1) < 0) return 0;
  input_size = size;
  mp3dec_init(&decoder);
  return 1;
}

// Decodes the frame at `offset`: samples a channel (0 when minimp3 refuses it), with the frame's details below.
EXPORT("decode_frame") int decode_frame(size_t offset) {
  if (offset >= input_size) return 0;
  return mp3dec_decode_frame(&decoder, input_offset() + offset, (int)(input_size - offset), pcm, &info);
}
EXPORT("frame_bytes") int frame_bytes(void) { return info.frame_bytes; }
EXPORT("frame_channels") int frame_channels(void) { return info.channels; }
EXPORT("frame_rate") int frame_rate(void) { return info.hz; }
EXPORT("pcm_offset") mp3d_sample_t *pcm_offset(void) { return pcm; }
