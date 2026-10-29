import { describe, expect, it } from "vite-plus/test";
import { buildLiquidGlassField } from "./field";
import { buildLiquidGlassFilterMarkup, liquidGlassBackdropFilter } from "./filter";
import { LIQUID_GLASS_DEFAULT_TUNING } from "./tuning";

const field = buildLiquidGlassField(
  { width: 120, height: 48, radius: 12 },
  LIQUID_GLASS_DEFAULT_TUNING,
);
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

describe("buildLiquidGlassFilterMarkup", () => {
  it("splits displacement per channel to disperse colour", () => {
    const markup = buildLiquidGlassFilterMarkup(
      "liquid-glass-1",
      field,
      LIQUID_GLASS_DEFAULT_TUNING,
      "blob:test",
    );

    expect(count(markup, "<feDisplacementMap")).toBe(3);
    expect(count(markup, `mode="screen"`)).toBe(2);
    expect(markup).toContain(`scale="${(field.scale * 1.3).toFixed(3)}"`);
    expect(markup).toContain(`scale="${(field.scale * 0.7).toFixed(3)}"`);
  });

  it("displaces once when dispersion is off", () => {
    const markup = buildLiquidGlassFilterMarkup(
      "liquid-glass-2",
      field,
      { ...LIQUID_GLASS_DEFAULT_TUNING, dispersion: 0 },
      "blob:test",
    );

    expect(count(markup, "<feDisplacementMap")).toBe(1);
    expect(count(markup, "<feBlend")).toBe(0);
  });

  it("draws the specular pass over the displaced backdrop", () => {
    const markup = buildLiquidGlassFilterMarkup(
      "liquid-glass-3",
      field,
      LIQUID_GLASS_DEFAULT_TUNING,
      "blob:test",
    );

    expect(markup).toContain('<feImage href="blob:test"');
    expect(markup).toContain('in="specular" in2="displaced" operator="over"');
    expect(markup).toContain('color-interpolation-filters="sRGB"');
  });

  it("escapes the map url", () => {
    const markup = buildLiquidGlassFilterMarkup(
      "liquid-glass-4",
      field,
      LIQUID_GLASS_DEFAULT_TUNING,
      'blob:test?a=1&b="2"',
    );

    expect(markup).toContain("&amp;b=&quot;2&quot;");
  });

  it("keeps the frost in the backdrop value", () => {
    expect(liquidGlassBackdropFilter("liquid-glass-5")).toBe(
      "url(#liquid-glass-5) blur(var(--glass-blur)) saturate(var(--glass-saturation))",
    );
  });
});
