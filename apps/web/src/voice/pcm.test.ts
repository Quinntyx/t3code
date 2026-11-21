import { describe, expect, it } from "vite-plus/test";
import { decodePcm16, encodePcm16 } from "./pcm";

describe("Voice streaming PCM", () => {
  it("clips signed samples and writes little endian without losing negative full scale", () => {
    const frame = encodePcm16(new Float32Array([-2, -0.5, 0.5, 2, Number.NaN]));
    expect([...frame]).toEqual([0, 128, 0, 192, 0, 64, 255, 127, 0, 0]);
    expect([...decodePcm16(frame)]).toEqual([-1, -0.5, 0.5, 32767 / 32768, 0]);
  });

  it("decodes whole-second buffer-length live frames and drops a trailing odd byte", () => {
    // Gemini Live sends one inlineData part per model turn chunk; measured chunks reached 46080
    // bytes (0.96 s of 24 kHz mono PCM16) with several seconds queued ahead of playback.
    const second = new Uint8Array(new Int16Array(24000).fill(16384).buffer);
    expect(decodePcm16(second)).toHaveLength(24000);
    expect(decodePcm16(new Uint8Array(46080))).toHaveLength(23040);
    const odd = decodePcm16(new Uint8Array([0, 64, 0, 192, 7]));
    expect(odd).toHaveLength(2);
    expect([...odd]).toEqual([0.5, -0.5]);
  });

  it("rejects malformed output", () => {
    expect(() => decodePcm16(new Uint8Array(0))).toThrow();
    expect(() => decodePcm16(new Uint8Array(1))).toThrow();
    expect(() => decodePcm16(new Uint8Array(1_000_002))).toThrow();
  });
});
