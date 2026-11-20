import { describe, expect, it } from "vite-plus/test";

import { buildGlassGeometry, type LiquidGlassShape, shapeDistance } from "./shape";

// A composer card with a drawer standing on it, reaching down to the card's middle.
const composerWithDrawer: LiquidGlassShape = {
  width: 736,
  height: 412,
  parts: [
    { x: 0, y: 288, width: 736, height: 124, radius: 37, fillet: 0 },
    { x: 28, y: 0, width: 680, height: 350, radius: 16, fillet: 12 },
  ],
};

const pixelAt = ({ map }: ReturnType<typeof buildGlassGeometry>, x: number, y: number) => {
  const scale = map.width / composerWithDrawer.width;
  const offset = (Math.floor(y * scale) * map.width + Math.floor(x * scale)) * 4;
  const [rim, green, blue] = map.pixels.slice(offset, offset + 3);
  return { rim, green, blue };
};

describe("buildGlassGeometry", () => {
  it("treats the joint between merged parts as glass interior, not two rims", () => {
    const geometry = buildGlassGeometry(composerWithDrawer);
    // Where the drawer meets the card top: no rim, no displacement.
    expect(pixelAt(geometry, 368, 290)).toEqual({ rim: 0, green: 128, blue: 128 });
    // The drawer's own sides still refract outward.
    const side = pixelAt(geometry, 29, 150);
    expect(side.rim).toBeGreaterThan(250);
    expect(side.blue).toBeLessThan(10);
  });

  it("blends the joint with a concave fillet instead of a sharp corner", () => {
    // Just outside both rectangles, in the corner between the drawer side and the card top.
    expect(shapeDistance(composerWithDrawer, 26, 286)).toBeLessThan(0);
    expect(shapeDistance(composerWithDrawer, 10, 270)).toBeGreaterThan(0);
  });

  it("traces one closed outline around the union", () => {
    const { path, edges } = buildGlassGeometry(composerWithDrawer);
    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    expect(edges.length).toBeGreaterThan(8);
    // The drawer's top edge faces up.
    const top = edges.find(({ normalX, normalY }) => normalY < -0.99 && Math.abs(normalX) < 0.01);
    expect(top?.d).toMatch(/^M[\d.]+ 0\.?\d*L/);
  });
});
