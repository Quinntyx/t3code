import type { LiquidGlassTuning } from "@t3tools/contracts/settings";

export { LIQUID_GLASS_DEFAULT_TUNING, type LiquidGlassTuning } from "@t3tools/contracts/settings";

/** Surfaces are generated at this height and the shader's pixel distances scale from it. */
export const REFERENCE_HEIGHT = 90;

export interface LiquidGlassKnob {
  key: keyof LiquidGlassTuning;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Number of decimals in the readout; pixel knobs read better at one. */
  precision: number;
}

const knob = (
  key: LiquidGlassKnob["key"],
  label: string,
  min: number,
  max: number,
  step: number,
  precision = 0,
): LiquidGlassKnob => ({ key, label, min, max, step, precision });

export const LIQUID_GLASS_KNOBS: readonly LiquidGlassKnob[] = [
  knob("refractionThickness", "Refraction thickness", 0, 60, 0.1, 1),
  knob("refractionDistance", "Refraction distance", 0, 0.2, 0.005, 3),
  knob("refractionFactor", "Refraction factor", 1, 8, 0.1, 1),
  knob("dispersion", "Dispersion", 0, 60, 1),
  knob("fresnelRange", "Fresnel range", 1, 100, 0.25, 2),
  knob("fresnelHardness", "Fresnel hardness", 0, 100, 0.5, 2),
  knob("fresnelFactor", "Fresnel strength", 0, 100, 1),
  knob("glareRange", "Glare range", 1, 100, 1),
  knob("glareHardness", "Glare hardness", 0, 100, 0.25, 2),
  knob("glareFactor", "Glare strength", 0, 150, 1),
  knob("glareConvergence", "Glare convergence", 0, 100, 1),
  knob("glareAngle", "Glare angle", -180, 180, 1),
];
