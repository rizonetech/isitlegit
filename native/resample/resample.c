// The voice decoder's polyphase resampler kernel (D01 T03 §9), compiled to WebAssembly with SIMD by
// scripts/build-wasm.py. src/voice/decode.ts computes each output phase's taps (a Kaiser-windowed sinc) and
// writes them here once; the module holds the input still needed, with half a window of silence before the start,
// and computes outputs four taps at a time. Output k sits at input position k x p / q.
#include <stddef.h>
#include <stdint.h>
#include <wasm_simd128.h>

#define EXPORT(name) __attribute__((export_name(name)))

extern unsigned char __heap_base;
static uintptr_t next_free;

static float *taps;      // q phases of `width` taps (a multiple of 4, zero-padded)
static int32_t q, width, half;
static int64_t p;
static float *held;      // input samples from global index `base` on
static int32_t held_len, held_cap;
static int64_t base, consumed, k;
static float *input;     // where JavaScript writes the next block
static int32_t input_cap;
static float *out;       // where outputs are written
static int32_t out_cap;

static void *take(size_t bytes) {
  uintptr_t at = (next_free + 15) & ~(uintptr_t)15;
  uintptr_t end = at + bytes;
  size_t have = __builtin_wasm_memory_size(0) * 65536;
  if (end > have && __builtin_wasm_memory_grow(0, (end - have) / 65536 + 1) < 0) return 0;
  next_free = end;
  return (void *)at;
}

// Lays out the buffers; 0 when memory could not grow. The caller then writes the taps at taps_offset().
EXPORT("init") int init(int32_t phases, int64_t step_p, int32_t tap_width, int32_t half_width, int32_t block) {
  next_free = (uintptr_t)&__heap_base;
  q = phases;
  p = step_p;
  width = tap_width;
  half = half_width;
  input_cap = block;
  held_cap = block + 2 * tap_width + 8;
  out_cap = (int32_t)((int64_t)(block + 2 * tap_width) * q / p) + 8;
  taps = take((size_t)q * width * sizeof(float));
  held = take((size_t)held_cap * sizeof(float));
  input = take((size_t)input_cap * sizeof(float));
  out = take((size_t)out_cap * sizeof(float));
  if (!taps || !held || !input || !out) return 0;
  // Half a window of silence before the first sample, so no output reads outside what is held.
  for (int32_t i = 0; i < half; i++) held[i] = 0;
  held_len = half;
  base = -half;
  consumed = 0;
  k = 0;
  return 1;
}
EXPORT("taps_offset") float *taps_offset(void) { return taps; }
EXPORT("input_offset") float *input_offset(void) { return input; }
EXPORT("out_offset") float *out_offset(void) { return out; }

static float output_at(int64_t index) {
  int64_t at = index * p;
  int64_t whole = at / q;
  const float *t = taps + (size_t)(at % q) * width;
  const float *x = held + (whole - half + 1 - base);
  v128_t sum = wasm_f32x4_splat(0);
  for (int32_t j = 0; j < width; j += 4)
    sum = wasm_f32x4_add(sum, wasm_f32x4_mul(wasm_v128_load(t + j), wasm_v128_load(x + j)));
  return wasm_f32x4_extract_lane(sum, 0) + wasm_f32x4_extract_lane(sum, 1) + wasm_f32x4_extract_lane(sum, 2) +
         wasm_f32x4_extract_lane(sum, 3);
}

// Drops held samples no later output needs, then appends `n` samples (from `src`, or silence when it is 0).
static void hold(const float *src, int32_t n) {
  int64_t keep = (k * p) / q - half + 1;
  if (keep > base) {
    int32_t drop = (int32_t)(keep - base);
    if (drop > held_len) drop = held_len;
    for (int32_t i = drop; i < held_len; i++) held[i - drop] = held[i];
    held_len -= drop;
    base += drop;
  }
  for (int32_t i = 0; i < n; i++) held[held_len + i] = src ? src[i] : 0;
  held_len += n;
}

// Takes `n` samples from input_offset() (at most the block size given to init) and returns how many outputs it wrote
// at out_offset(): every output whose window lies wholly within what has arrived.
EXPORT("push") int32_t push(int32_t n) {
  hold(input, n);
  consumed += n;
  int32_t count = 0;
  while ((k * p) / q + half < consumed && count < out_cap) out[count++] = output_at(k++);
  return count;
}

// The outputs left before the input ends, their windows running into silence; returns how many it wrote.
EXPORT("finish") int32_t finish(void) {
  int32_t count = 0;
  int32_t padded = 0;
  while ((k * p) < consumed * q && count < out_cap) {
    while ((k * p) / q + half >= consumed + padded) {
      hold(0, width);
      padded += width;
    }
    out[count++] = output_at(k++);
  }
  return count;
}
