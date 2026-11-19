/**
 * TIFF LZW decoder (compression 5): MSB-first codes of 9–12 bits, with the
 * "early change" code width switch used by every TIFF writer since 1992.
 *
 * geotiff.js' decoder builds each string in a JS array and the output one byte
 * at a time, which makes it the bottleneck when opening LZW GeoTIFFs. Here
 * every dictionary entry is a run of bytes already written to the output: the
 * entry added after code c is the string of the previous code followed by the
 * first byte of c's string, and that is exactly what precedes it in the output.
 * Decoding is then a matter of copying runs within one preallocated buffer.
 */

const CLEAR = 256;
const EOI = 257;
const MAX_CODES = 4096;

/** Decodes `input`; `expectedLength` (the decoded size, if known) avoids regrowing the output. */
export function lzwDecode(input: Uint8Array, expectedLength = 0): Uint8Array {
  let out = new Uint8Array(Math.max(expectedLength, input.length * 3, 1024));
  let pos = 0;

  // Where each code's string starts in the output, and its length.
  const start = new Uint32Array(MAX_CODES);
  const length = new Uint16Array(MAX_CODES);
  let next = 258;
  let width = 9;

  let bits = 0;
  let bitCount = 0;
  let ip = 0;
  const n = input.length;

  let prev = -1; // previous code, -1 right after a clear code or when the table is full

  const ensure = (extra: number) => {
    if (pos + extra > out.length) {
      const grown = new Uint8Array(Math.max(out.length * 2, pos + extra));
      grown.set(out.subarray(0, pos));
      out = grown;
    }
  };

  for (;;) {
    while (bitCount < width) {
      if (ip >= n) {
        // Ran out of data without an end-of-information code; keep what was decoded.
        return out.subarray(0, pos);
      }
      bits = ((bits << 8) | input[ip++]) & 0xffffff;
      bitCount += 8;
    }
    bitCount -= width;
    const code = (bits >>> bitCount) & ((1 << width) - 1);

    if (code === EOI) {
      break;
    }
    if (code === CLEAR) {
      next = 258;
      width = 9;
      prev = -1;
      continue;
    }

    const at = pos;
    if (code < 256) {
      ensure(1);
      out[pos++] = code;
    } else if (code < next) {
      const len = length[code];
      ensure(len);
      const from = start[code];
      if (len < 32) {
        // Most strings are short; a loop beats copyWithin's call overhead.
        for (let k = 0; k < len; k++) out[pos + k] = out[from + k];
      } else {
        out.copyWithin(pos, from, from + len);
      }
      pos += len;
    } else if (code === next && prev >= 0) {
      // The string of `prev` followed by its own first byte.
      const len = prev < 256 ? 1 : length[prev];
      const from = prev < 256 ? -1 : start[prev];
      ensure(len + 1);
      if (from < 0) out[pos] = prev;
      else out.copyWithin(pos, from, from + len);
      out[pos + len] = out[pos];
      pos += len + 1;
    } else {
      throw new Error(`Corrupt LZW data: code ${code} with ${next} table entries.`);
    }

    if (prev >= 0 && next < MAX_CODES) {
      // prev's string, written just before `at`, plus the first byte of this code's string.
      const prevLength = prev < 256 ? 1 : length[prev];
      start[next] = at - prevLength;
      length[next] = prevLength + 1;
      next++;
    }
    prev = code;

    if (next + 1 >= 1 << width) {
      if (width < 12) {
        width++;
      } else {
        // Table full: no more entries until the next clear code.
        prev = -1;
      }
    }
  }
  return out.subarray(0, pos);
}
