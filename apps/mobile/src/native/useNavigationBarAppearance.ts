import { requireOptionalNativeModule } from "expo";
import { useEffect } from "react";
import { Platform } from "react-native";

import type { MobileThemeAppearance } from "../lib/mobileTheme";

const nativeControls =
  Platform.OS === "android"
    ? requireOptionalNativeModule<{
        setNavigationBarAppearance(appearance: MobileThemeAppearance): void;
      }>("T3NativeControls")
    : null;

/** Android's navigation bar is transparent over the theme, so its buttons follow the theme too. */
export function useNavigationBarAppearance(appearance: MobileThemeAppearance): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- syncs the native window's navigation bar button color with the active theme
  useEffect(() => {
    nativeControls?.setNavigationBarAppearance?.(appearance);
  }, [appearance]);
}
