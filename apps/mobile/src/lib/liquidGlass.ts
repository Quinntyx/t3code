import {
  DEFAULT_CLIENT_SETTINGS,
  MAX_GLASS_OPACITY,
  MAX_LIQUID_GLASS_BLUR,
  MAX_LIQUID_GLASS_PERCENT,
  MIN_GLASS_OPACITY,
} from "@t3tools/contracts/settings";

/** Mirrors the desktop liquid glass settings so both clients can be tuned to the same look. */
export interface LiquidGlassPreferences {
  readonly enabled: boolean;
  readonly glassOpacity: number;
  readonly blur: number;
  readonly saturation: number;
  readonly refraction: number;
  readonly dispersion: number;
}

export const LIQUID_GLASS_LIMITS = {
  glassOpacity: { min: MIN_GLASS_OPACITY, max: MAX_GLASS_OPACITY },
  blur: { min: 0, max: MAX_LIQUID_GLASS_BLUR },
  saturation: { min: 0, max: MAX_LIQUID_GLASS_PERCENT },
  refraction: { min: 0, max: MAX_LIQUID_GLASS_PERCENT },
  dispersion: { min: 0, max: MAX_LIQUID_GLASS_PERCENT },
} as const satisfies Record<
  Exclude<keyof LiquidGlassPreferences, "enabled">,
  { min: number; max: number }
>;

export const DEFAULT_LIQUID_GLASS_PREFERENCES: LiquidGlassPreferences = {
  enabled: false,
  glassOpacity: DEFAULT_CLIENT_SETTINGS.glassOpacity,
  blur: DEFAULT_CLIENT_SETTINGS.liquidGlassBlur,
  saturation: DEFAULT_CLIENT_SETTINGS.liquidGlassSaturation,
  refraction: DEFAULT_CLIENT_SETTINGS.liquidGlassRefraction,
  dispersion: DEFAULT_CLIENT_SETTINGS.liquidGlassDispersion,
};

export function isLiquidGlassValue(
  key: keyof typeof LIQUID_GLASS_LIMITS,
  value: unknown,
): value is number {
  const { min, max } = LIQUID_GLASS_LIMITS[key];
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}
