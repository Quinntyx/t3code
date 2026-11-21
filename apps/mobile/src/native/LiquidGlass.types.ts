import type { ViewProps } from "react-native";

export interface LiquidGlassBackdropProps extends ViewProps {
  /** Opaque paint used until a target is found; a processed color. */
  readonly fallbackColor: number;
  readonly blur: number;
  readonly saturation: number;
  readonly refraction: number;
  readonly dispersion: number;
}
