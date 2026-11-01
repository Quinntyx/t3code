import { describe, expect, it } from "vite-plus/test";

import { shimmerPalette, shimmerPhases, WARP_TERMS } from "./field";

const phasesAt = (seconds: number) => Array.from(shimmerPhases(seconds, 7, new Float32Array(13)));
const angularGap = (a: number, b: number) => {
  const gap = Math.abs(a - b) % (Math.PI * 2);
  return Math.min(gap, Math.PI * 2 - gap);
};

describe("shimmerPhases", () => {
  it("stays wrapped and moves smoothly after a month-long session", () => {
    const month = 30 * 24 * 3600;
    const now = phasesAt(month);
    const next = phasesAt(month + 1 / 30);
    expect(now).toHaveLength(WARP_TERMS * 2 + 1);
    for (const [index, phase] of now.entries()) {
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(Math.PI * 2 + 1e-6);
      expect(angularGap(phase, next[index] ?? 0)).toBeLessThan(0.02);
    }
  });

  it("does not return to its start after the reference's 28s loop", () => {
    const start = phasesAt(0);
    const loop = phasesAt((Math.PI * 2) / 0.225);
    const drift = start.reduce((sum, phase, index) => sum + angularGap(phase, loop[index] ?? 0), 0);
    expect(drift).toBeGreaterThan(1);
  });
});

describe("shimmerPalette", () => {
  it("fans in-gamut hues out from the theme's action color, even for neutral themes", () => {
    for (const [primary, background, dark] of [
      ["oklch(0.488 0.217 264)", "#ffffff", false],
      ["#a3a3a3", "#0a0a0a", true],
      ["color(display-p3 1 0 1)", "oklch(0.98 0.005 300)", false],
    ] as const) {
      const palette = shimmerPalette({ primary, background, foreground: "#111" });
      expect(palette?.dark).toBe(dark);
      const channels = palette?.bands.flat() ?? [];
      expect(channels).toHaveLength(9);
      for (const channel of channels) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
      expect(new Set(palette?.bands.map((band) => band.join()))).toHaveProperty("size", 3);
    }
  });

  it("returns null for colors the browser could not resolve", () => {
    expect(shimmerPalette({ primary: "", background: "#fff", foreground: "#000" })).toBeNull();
  });
});
