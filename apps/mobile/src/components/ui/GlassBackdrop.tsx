import { BlurView } from "expo-blur";
import { Platform, processColor, StyleSheet, View, type ColorValue } from "react-native";

import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { LIQUID_GLASS_SUPPORTED, LiquidGlassBackdrop } from "../../native/LiquidGlass";

export function GlassBackdrop(props: { readonly fallbackColor?: ColorValue }) {
  const { themeAppearance, themeVariables, liquidGlass } = useAppearancePreferences();
  const supportsBlur = Platform.OS === "ios";
  const color = props.fallbackColor ?? themeVariables["--color-glass-fallback"];
  const liquid = liquidGlass.enabled && LIQUID_GLASS_SUPPORTED && typeof color === "string";
  const colorStyle = {
    backgroundColor:
      supportsBlur || typeof color !== "string"
        ? color
        : themeColorWithAlpha(color, liquid ? liquidGlass.glassOpacity / 100 : 1),
  };

  return (
    <>
      {supportsBlur ? (
        <BlurView
          pointerEvents="none"
          intensity={80}
          tint={themeAppearance === "dark" ? "dark" : "default"}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {liquid ? (
        <LiquidGlassBackdrop
          pointerEvents="none"
          fallbackColor={processColor(themeColorWithAlpha(color, 1)) as number}
          blur={liquidGlass.blur}
          saturation={liquidGlass.saturation}
          refraction={liquidGlass.refraction}
          dispersion={liquidGlass.dispersion}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="none"
        className="absolute inset-0 bg-glass-fallback"
        style={colorStyle}
      />
    </>
  );
}
