import { View, type ViewProps } from "react-native";

import type { LiquidGlassBackdropProps } from "./LiquidGlass.types";

// iOS uses the system material; see GlassSurface.
export const LIQUID_GLASS_SUPPORTED = false;

export function LiquidGlassTarget(props: ViewProps) {
  return <View {...props} />;
}

export function LiquidGlassBackdrop(_props: LiquidGlassBackdropProps) {
  return null;
}
