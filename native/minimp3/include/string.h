/* The three routines minimp3.h uses from <string.h>, defined in decoder.c: the WebAssembly build links no C library. */
#pragma once
#include <stddef.h>
void *memcpy(void *dest, const void *src, size_t n);
void *memset(void *s, int c, size_t n);
void *memmove(void *dest, const void *src, size_t n);
