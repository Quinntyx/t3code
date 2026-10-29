import { describe, expect, it } from "vite-plus/test";

import { buildLiquidGlassFilter, liquidGlassBackdropFilter, liquidGlassBand } from "./filter";

const mapOf = (markup: string) => {
  const encoded = /data:image\/svg\+xml,([^"]+)"/.exec(markup)?.[1];
  if (!encoded) throw new Error("filter has no displacement map");
  return decodeURIComponent(encoded);
};

describe("liquidGlassBand", () => {
  it("keeps the rim a readable width across surface sizes", () => {
    expect(liquidGlassBand({ width: 700, height: 96, radius: 26 })).toBe(13);
    expect(liquidGlassBand({ width: 140, height: 32, radius: 16 })).toBe(9);
    expect(liquidGlassBand({ width: 900, height: 700, radius: 16 })).toBe(18);
  });
});

describe("buildLiquidGlassFilter", () => {
  const surface = { width: 700, height: 96, radius: 26 };

  it("builds the map at the surface's own pixel size", () => {
    const map = mapOf(buildLiquidGlassFilter("glass-1", surface).markup);
    expect(map).toContain('width="700" height="96" viewBox="0 0 700 96"');
    expect(map).toContain('<rect width="700" height="96" rx="26"/>');
    // Neutral core inset by the band, so the middle of the surface does not bend.
    expect(map).toContain('x="13" y="13" width="674" height="70"');
  });

  it("samples red, green and blue one pixel apart for the dispersion fringe", () => {
    const { markup } = buildLiquidGlassFilter("glass-2", surface);
    const scales = [...markup.matchAll(/feDisplacementMap[^>]*scale="(-?\d+)"/g)].map((match) =>
      Number(match[1]),
    );
    expect(scales).toEqual([43, 44, 45]);
    expect(markup).toContain('in2="channel-2" mode="screen"');
  });

  it("keeps the filter region on the surface box so nothing bleeds past its corners", () => {
    expect(buildLiquidGlassFilter("glass-3", surface).markup).toContain(
      'x="0" y="0" width="1" height="1"',
    );
  });
});

describe("liquidGlassBackdropFilter", () => {
  it("keeps the app frost in front of the refraction", () => {
    expect(liquidGlassBackdropFilter("glass-4")).toBe(
      "blur(var(--glass-blur)) saturate(var(--glass-saturation)) url(#glass-4) blur(1px)",
    );
  });
});
