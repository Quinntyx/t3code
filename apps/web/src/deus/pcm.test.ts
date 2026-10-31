import { describe, expect, it } from "vite-plus/test";
import { Pcm16Capture, decodePcm16 } from "./pcm";

function capture(rate: number, blocks: readonly Float32Array[]) {
  const resampler = new Pcm16Capture(rate, 16);
  return blocks.flatMap((block) => resampler.push(block));
}

describe("Deus streaming PCM", () => {
  it.each([44100, 48000, 96000, 16000])(
    "retains interpolation and incomplete frames at %iHz",
    (rate) => {
      const input = Float32Array.from({ length: 2000 }, (_, index) => Math.sin(index / 17));
      const whole = capture(rate, [input]);
      const split = capture(rate, [
        input.slice(0, 1),
        input.slice(1, 128),
        input.slice(128, 731),
        input.slice(731),
      ]);
      expect(split).toEqual(whole);
      expect(whole.length).toBe(
        Math.floor((Math.floor(((input.length - 1) * 16000) / rate) + 1) / 16),
      );
      expect(whole.every((frame) => frame.byteLength === 32)).toBe(true);
    },
  );

  it("clips signed samples and writes little endian without losing negative full scale", () => {
    const frames = new Pcm16Capture(16000, 4).push(new Float32Array([-2, -0.5, 0.5, 2]));
    expect([...frames[0]!]).toEqual([0, 128, 0, 192, 0, 64, 255, 127]);
    expect([...decodePcm16(frames[0]!)]).toEqual([-1, -0.5, 0.5, 32767 / 32768]);
  });

  it("rejects non-finite rates, oversized blocks and malformed output", () => {
    expect(() => new Pcm16Capture(Number.NaN)).toThrow();
    expect(() => new Pcm16Capture(48000).push(new Float32Array(4097))).toThrow();
    expect(() => decodePcm16(new Uint8Array(3))).toThrow();
    expect(() => decodePcm16(new Uint8Array(32002))).toThrow();
  });
});
