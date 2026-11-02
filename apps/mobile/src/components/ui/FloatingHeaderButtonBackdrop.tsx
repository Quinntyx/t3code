import { View } from "react-native";

import { cn } from "../../lib/cn";
import { GlassBackdrop, useLiquidGlassActive } from "./GlassBackdrop";

export function FloatingHeaderButtonBackdrop() {
  const glass = useLiquidGlassActive();
  return (
    <View
      pointerEvents="none"
      className={cn(
        "absolute inset-0 overflow-hidden rounded-full border border-header-border",
        !glass && "bg-header/90",
      )}
    >
      {glass ? <GlassBackdrop /> : null}
    </View>
  );
}
