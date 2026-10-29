import { requireNativeView } from "expo";
import { Platform, View, type ViewProps } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { LiquidGlassBackdropProps } from "./LiquidGlass.types";

// RuntimeShader, which bends the backdrop, arrived in Android 13.
export const LIQUID_GLASS_SUPPORTED = Number(Platform.Version) >= 33;

const NativeTarget = requireNativeView<ViewProps>("T3LiquidGlass", "T3LiquidGlassTargetView");
const NativeBackdrop = requireNativeView<LiquidGlassBackdropProps>(
  "T3LiquidGlass",
  "T3LiquidGlassView",
);

/** Content that glass drawn after it, in the same screen, refracts. */
export function LiquidGlassTarget(props: ViewProps) {
  const { liquidGlass } = useAppearancePreferences();
  return liquidGlass.enabled && LIQUID_GLASS_SUPPORTED ? (
    <NativeTarget {...props} />
  ) : (
    <View {...props} />
  );
}

export function LiquidGlassBackdrop(props: LiquidGlassBackdropProps) {
  return <NativeBackdrop {...props} />;
}
