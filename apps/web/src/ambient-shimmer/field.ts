import "culori/css";
import { clampChroma, converter, parse, type Oklch } from "culori/fn";

export type Rgb = readonly [red: number, green: number, blue: number];

export interface ShimmerPalette {
  base: Rgb;
  bands: readonly [Rgb, Rgb, Rgb];
  /** Pulled in between the bands, so the backdrop varies in lightness as well as hue. */
  shade: Rgb;
  dark: boolean;
}

export const WARP_TERMS = 6;

const TAU = Math.PI * 2;
/** Radians per second, the pace of the Hyperframes reference. */
const PACE = 0.225;
// Mutually irrational rates: the warp never lines up with an earlier state, so the motion has
// no period. The reference drives every term at one rate and loops every 2π / PACE ≈ 28s.
const WARP_X_RATES = [1, 0.66, 1.25, 6 / 7, 8 / 7, 0.75].map(Math.sqrt);
const WARP_Y_RATES = [7 / 8, 1.1, 0.6, 1.3, 0.9, 1.05].map(Math.sqrt);
const BAND_RATE = (Math.sqrt(5) - 1) / 8;

const toOklch = converter("oklch");
const toRgb = converter("rgb");

/**
 * Writes the warp phases for `seconds` into `out`: x terms, then y terms, then the band phase.
 * Wrapped in double precision here, so the float32 shader stays exact in a session of any length.
 */
export function shimmerPhases(seconds: number, seed: number, out: Float32Array): Float32Array {
  const phase = (rate: number, index: number) =>
    (((seconds * PACE * rate + seed * (index + 1) * 2.399963) % TAU) + TAU) % TAU;
  for (let index = 0; index < WARP_TERMS; index++) {
    out[index] = phase(WARP_X_RATES[index] ?? 1, index);
    out[WARP_TERMS + index] = phase(WARP_Y_RATES[index] ?? 1, WARP_TERMS + index);
  }
  out[WARP_TERMS * 2] = phase(BAND_RATE, WARP_TERMS * 2);
  return out;
}

const rgbOf = (color: Oklch): Rgb => {
  const { r, g, b } = toRgb(clampChroma(color, "oklch"));
  const unit = (value: number) => Math.min(1, Math.max(0, value));
  return [unit(r), unit(g), unit(b)];
};

/** Hues fanned out around the theme's action color, like the fringe of a soap film. */
export function shimmerPalette(colors: {
  primary: string;
  background: string;
  foreground: string;
}): ShimmerPalette | null {
  const primary = toOklch(parse(colors.primary));
  const background = toOklch(parse(colors.background));
  const foreground = toOklch(parse(colors.foreground));
  if (!primary || !background || !foreground) return null;
  const dark = background.l < 0.5;
  const hue = primary.h ?? 300;
  // Neutral themes still get a faint iridescence; vivid ones are tamed to stay a backdrop.
  const chroma = Math.min(0.16, Math.max(0.07, primary.c));
  const lightness = dark ? 0.62 : 0.78;
  const band = (offset: number) =>
    rgbOf({ mode: "oklch", l: lightness, c: chroma, h: (hue + offset + 360) % 360 });
  return {
    base: rgbOf(background),
    bands: [band(-55), band(0), band(55)],
    shade: rgbOf(foreground),
    dark,
  };
}
