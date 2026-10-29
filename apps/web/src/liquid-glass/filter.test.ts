import { describe, expect, it } from "vite-plus/test";

import { buildLiquidGlassFilter, liquidGlassBackdropFilter } from "./filter";

const mapOf = (markup: string) => {
  const encoded = /data:image\/svg\+xml,([^"]+)"/.exec(markup)?.[1];
  if (!encoded) throw new Error("filter has no displacement map");
  return decodeURIComponent(encoded);
};

describe("buildLiquidGlassFilter", () => {
  it("sizes the reference map to each surface without retuning its rim", () => {
    for (const surface of [
      { width: 700, height: 96 },
      { width: 140, height: 32 },
      { width: 900, height: 700 },
    ]) {
      const map = mapOf(buildLiquidGlassFilter("glass-1", surface).markup);
      expect(map).toContain(
        `width="${surface.width}" height="${surface.height}" viewBox="0 0 ${surface.width} ${surface.height}"`,
      );
      expect(map).toContain(`width="${surface.width}" height="${surface.height}" rx="8"`);
      expect(map).toContain(
        `x="12" y="12" rx="0" width="${surface.width - 24}" height="${surface.height - 24}"`,
      );
      expect(map).toContain('stdDeviation="4"');
    }
  });

  it("uses the reference RGB scales regardless of surface size", () => {
    for (const surface of [
      { width: 140, height: 32 },
      { width: 900, height: 700 },
    ]) {
      const { markup } = buildLiquidGlassFilter("glass-2", surface);
      const scales = [...markup.matchAll(/feDisplacementMap[^>]*scale="(-?\d+)"/g)].map((match) =>
        Number(match[1]),
      );
      expect(scales).toEqual([-19, -20, -21]);
      expect(markup).toContain('dx="0.0392156862745" dy="0.0392156862745"');
    }
  });

  it("adjusts refraction and dispersion independently without changing the neutral map", () => {
    for (const [refraction, dispersion, expected] of [
      [0, 100, [0, 0, 0]],
      [50, 100, [-9.5, -10, -10.5]],
      [100, 0, [-20, -20, -20]],
      [100, 200, [-18, -20, -22]],
    ] as const) {
      const surface = { width: 700, height: 96 };
      const { markup } = buildLiquidGlassFilter("adjusted", surface, { refraction, dispersion });
      expect(
        [...markup.matchAll(/feDisplacementMap[^>]*scale="([^"]+)"/g)].map((match) =>
          Number(match[1]),
        ),
      ).toEqual(expected);
      expect(mapOf(markup)).toBe(mapOf(buildLiquidGlassFilter("adjusted", surface).markup));
    }
  });

  it("keeps the filter region on the surface box so nothing bleeds past its corners", () => {
    expect(buildLiquidGlassFilter("glass-3", { width: 700, height: 96 }).markup).toContain(
      'x="0" y="0" width="1" height="1"',
    );
  });
});

describe("liquidGlassBackdropFilter", () => {
  it("uses the reference's zero pre-blur and one-pixel post-blur without saturation", () => {
    expect(liquidGlassBackdropFilter("glass-4")).toBe("blur(0px) url(#glass-4) blur(1px)");
    expect(liquidGlassBackdropFilter("glass-4", { blur: 8, saturation: 140 })).toBe(
      "blur(0px) url(#glass-4) blur(8px) saturate(1.4)",
    );
    expect(liquidGlassBackdropFilter("glass-4", { blur: 0, saturation: 0 })).toBe(
      "blur(0px) url(#glass-4) blur(0px) saturate(0)",
    );
  });
});
