import { describe, expect, it } from "vite-plus/test";
import { decodePcm16, encodePcm16 } from "./pcm";

describe("Voice streaming PCM", () => {
  it("clips signed samples and writes little endian without losing negative full scale", () => {
    const frame = encodePcm16(new Float32Array([-2, -0.5, 0.5, 2, Number.NaN]));
    expect([...frame]).toEqual([0, 128, 0, 192, 0, 64, 255, 127, 0, 0]);
    expect([...decodePcm16(frame)]).toEqual([-1, -0.5, 0.5, 32767 / 32768, 0]);
  });

  it("rejects malformed output", () => {
    expect(() => decodePcm16(new Uint8Array(3))).toThrow();
    expect(() => decodePcm16(new Uint8Array(32002))).toThrow();
  });
});
