import { describe, expect, it } from "vite-plus/test";
import { buildLiquidGlassField, readLiquidGlassField } from "./field";
import { LIQUID_GLASS_DEFAULT_TUNING } from "./tuning";

const surface = { width: 200, height: 64, radius: 16 };

describe("buildLiquidGlassField", () => {
  it("leaves the middle of the surface undistorted", () => {
    const field = buildLiquidGlassField(surface, LIQUID_GLASS_DEFAULT_TUNING);
    const sample = readLiquidGlassField(field, 100, 32);

    expect(Math.abs(sample.offsetX)).toBeLessThan(0.01);
    expect(Math.abs(sample.offsetY)).toBeLessThan(0.01);
  });

  it("pushes samples inward, growing towards the edge", () => {
    const field = buildLiquidGlassField(surface, LIQUID_GLASS_DEFAULT_TUNING);
    const near = readLiquidGlassField(field, 12, 32);
    const edge = readLiquidGlassField(field, 1, 32);

    expect(near.offsetX).toBeGreaterThan(0);
    expect(edge.offsetX).toBeGreaterThan(near.offsetX);
    expect(edge.offsetX).toBeLessThanOrEqual(1);
  });

  it("keeps the band inside the surface for a short surface", () => {
    const field = buildLiquidGlassField(
      { width: 200, height: 24, radius: 8 },
      LIQUID_GLASS_DEFAULT_TUNING,
    );

    expect(field.band).toBeLessThan(24 / 2);
    expect(field.maxDisplacement).toBeLessThanOrEqual(24 * 0.08);
  });

  it("lights the rim brighter than the body", () => {
    const field = buildLiquidGlassField(surface, {
      ...LIQUID_GLASS_DEFAULT_TUNING,
      glareFactor: 0,
    });

    expect(readLiquidGlassField(field, 1, 32).specular).toBeGreaterThan(0.02);
    expect(readLiquidGlassField(field, 100, 32).specular).toBe(0);
  });

  it("clears the map outside a rounded corner", () => {
    const field = buildLiquidGlassField(surface, LIQUID_GLASS_DEFAULT_TUNING);
    const corner = readLiquidGlassField(field, 0, 0);

    expect(corner.offsetX).toBeCloseTo(0, 2);
    expect(corner.offsetY).toBeCloseTo(0, 2);
    expect(corner.specular).toBe(0);
  });

  it("survives a radius larger than the surface", () => {
    const field = buildLiquidGlassField(
      { width: 40, height: 20, radius: 500 },
      LIQUID_GLASS_DEFAULT_TUNING,
    );

    expect(field.pixels).toHaveLength(40 * 20 * 4);
    expect(Array.from(field.pixels.slice(0, 4)).every(Number.isFinite)).toBe(true);
  });
});
