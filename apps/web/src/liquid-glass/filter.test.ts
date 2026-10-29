import { describe, expect, it } from "vite-plus/test";

import { buildLiquidGlassFilter, buildLiquidGlassGlare, liquidGlassBackdropFilter } from "./filter";

const mapOf = (markup: string) => {
  const encoded = /data:image\/svg\+xml,([^"]+)"/.exec(markup)?.[1];
  if (!encoded) throw new Error("filter has no displacement map");
  return decodeURIComponent(encoded);
};

describe("buildLiquidGlassFilter", () => {
  it("sizes the reference map to each surface and follows its corner without retuning the rim", () => {
    for (const [surface, outer, inner] of [
      [{ width: 700, height: 96, radius: 37 }, 37, 25],
      [{ width: 140, height: 32, radius: 21 }, 16, 4],
      [{ width: 900, height: 700, radius: 8 }, 8, 0],
    ] as const) {
      const map = mapOf(buildLiquidGlassFilter("glass-1", surface).markup);
      expect(map).toContain(
        `width="${surface.width}" height="${surface.height}" viewBox="0 0 ${surface.width} ${surface.height}"`,
      );
      expect(map).toContain(`width="${surface.width}" height="${surface.height}" rx="${outer}"`);
      expect(map).toContain(
        `x="12" y="12" rx="${inner}" width="${surface.width - 24}" height="${surface.height - 24}"`,
      );
      expect(map).toContain('stdDeviation="4"');
    }
  });

  it("uses the reference RGB scales regardless of surface size", () => {
    for (const surface of [
      { width: 140, height: 32, radius: 8 },
      { width: 900, height: 700, radius: 8 },
    ]) {
      const { markup } = buildLiquidGlassFilter("glass-2", surface, { dispersion: 100 });
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
      // liquid-glass-studio's dispersion 30 splits the channels to 0.4× and 1.6×.
      [100, 1200, [-8, -20, -32]],
    ] as const) {
      const surface = { width: 700, height: 96, radius: 8 };
      const { markup } = buildLiquidGlassFilter("adjusted", surface, { refraction, dispersion });
      expect(
        [...markup.matchAll(/feDisplacementMap[^>]*scale="([^"]+)"/g)].map((match) =>
          Number(match[1]),
        ),
      ).toEqual(expected);
      expect(mapOf(markup)).toBe(mapOf(buildLiquidGlassFilter("adjusted", surface).markup));
    }
  });

  it("blurs the interior past the rim only when center blur exceeds edge blur", () => {
    const surface = { width: 700, height: 96, radius: 37 };
    const blurs = (blur: number, centerBlur: number) =>
      [
        ...buildLiquidGlassFilter("center", surface, { blur, centerBlur }).markup.matchAll(
          /feGaussianBlur in="SourceGraphic" stdDeviation="([^"]+)"/g,
        ),
      ].map((match) => Number(match[1]));
    expect(blurs(1, 1)).toEqual([]);
    expect(blurs(8, 4)).toEqual([]);
    // CSS adds the edge blur on top, and gaussian variances add: sqrt(5² - 3²) = 4.
    expect(blurs(3, 5)).toEqual([4]);
  });

  it("keeps the filter region on the surface box so nothing bleeds past its corners", () => {
    expect(
      buildLiquidGlassFilter("glass-3", { width: 700, height: 96, radius: 8 }).markup,
    ).toContain('x="0" y="0" width="1" height="1"');
  });
});

describe("buildLiquidGlassGlare", () => {
  const surface = { width: 300, height: 120, radius: 21 };
  const glareOf = (glare: number) => {
    const image = buildLiquidGlassGlare(surface, { glare });
    return image === null
      ? null
      : decodeURIComponent(image.slice('url("data:image/svg+xml,'.length, -2));
  };
  const edgeLevels = (glare: number) =>
    [...(glareOf(glare) ?? "").matchAll(/stroke="rgb\((\d+),/g)]
      .slice(0, 4)
      .map((match) => Number(match[1]));

  it("lights each edge by its normal, so straight edges stay even and the lit sides lead", () => {
    // top, right, bottom, left
    expect(edgeLevels(100)).toEqual([38, 168, 49, 215]);
    expect(glareOf(100)).toContain(`rx="${21 - 2}"`);
  });

  it("scales with the setting, saturates when strong, and disappears at zero", () => {
    expect(edgeLevels(50)).toEqual([18, 79, 23, 100]);
    expect(edgeLevels(200)).toEqual([82, 255, 105, 255]);
    expect(glareOf(0)).toBeNull();
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
