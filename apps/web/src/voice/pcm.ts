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

export function decodePcm16(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  if (!bytes.length || bytes.length > 32000 || bytes.length % 2 !== 0)
    throw new Error("Invalid PCM16LE output frame.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from(
    { length: bytes.length / 2 },
    (_, index) => view.getInt16(index * 2, true) / 32768,
  );
}
