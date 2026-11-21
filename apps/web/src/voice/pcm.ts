/** Gemini Live takes 16-bit little-endian PCM; the shared capture worklet yields 16 kHz floats. */
export function encodePcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (const [index, raw] of samples.entries()) {
    const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

/** Gemini Live streams 24 kHz mono PCM16 frames that can run up to a second or more of audio. */
const MAX_OUTPUT_FRAME_BYTES = 1_000_000;

export function decodePcm16(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  // Live chunks normally arrive byte-aligned; a stray trailing byte is dropped rather than
  // failing the whole reply, but a frame without one whole sample is malformed.
  const length = bytes.length & ~1;
  if (!length || bytes.length > MAX_OUTPUT_FRAME_BYTES)
    throw new Error("Invalid PCM16LE output frame.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  return Float32Array.from(
    { length: length / 2 },
    (_, index) => view.getInt16(index * 2, true) / 32768,
  );
}
