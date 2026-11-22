import { msg, T, useGT, useMessages } from "gt-react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { SliderRow } from "../../../../components/ui/SliderRow";
import { LIQUID_GLASS_LIMITS, type LiquidGlassPreferences } from "../../../../lib/liquidGlass";
import { LIQUID_GLASS_SUPPORTED } from "../../../../native/LiquidGlass";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

const SLIDERS = [
  {
    key: "glassOpacity",
    label: msg("Glass opacity"),
    icon: "circle.lefthalf.filled",
    step: 5,
    unit: "percent",
  },
  { key: "blur", label: msg("Blur"), icon: "aqi.medium", step: 1, unit: "pt" },
  { key: "saturation", label: msg("Saturation"), icon: "drop.halffull", step: 5, unit: "percent" },
  { key: "refraction", label: msg("Refraction"), icon: "eye", step: 5, unit: "percent" },
  { key: "dispersion", label: msg("Dispersion"), icon: "rainbow", step: 5, unit: "percent" },
] as const satisfies ReadonlyArray<{
  readonly key: Exclude<keyof LiquidGlassPreferences, "enabled">;
  readonly label: string;
  readonly icon: string;
  readonly step: number;
  readonly unit: "percent" | "pt";
}>;

export function LiquidGlassAppearanceSection() {
  const gt = useGT();
  const m = useMessages();
  const { isReady, liquidGlass, setLiquidGlass } = useAppearancePreferences();
  const active = liquidGlass.enabled && LIQUID_GLASS_SUPPORTED;
  return (
    <SettingsSection
      title={gt("Liquid glass")}
      trailing={
        <Text textRole="footnote" className="px-4 font-t3-medium text-warning-foreground">
          <T>Experimental</T>
        </Text>
      }
      footer={
        LIQUID_GLASS_SUPPORTED
          ? gt(
              "Refracts the conversation and lists behind the composer, toolbar, and menus. Performance warning: may increase GPU usage, reduce frame rates, and use more battery.",
            )
          : gt("Requires {platform} or later.", { platform: "Android 13" })
      }
    >
      <SettingsSwitchRow
        disabled={!isReady || !LIQUID_GLASS_SUPPORTED}
        icon="drop.halffull"
        label={gt("Liquid glass")}
        value={active}
        onValueChange={(enabled) => setLiquidGlass({ enabled })}
      />
      {active
        ? SLIDERS.map(({ key, label, icon, step, unit }) => (
            <SliderRow
              key={key}
              disabled={!isReady}
              icon={icon}
              label={m(label)}
              min={LIQUID_GLASS_LIMITS[key].min}
              max={LIQUID_GLASS_LIMITS[key].max}
              step={step}
              value={liquidGlass[key]}
              valueLabel={
                unit === "pt"
                  ? gt("{value} pt", { value: liquidGlass[key] })
                  : gt("{value}%", { value: liquidGlass[key] })
              }
              onChange={(value) => setLiquidGlass({ [key]: value })}
            />
          ))
        : null}
    </SettingsSection>
  );
}
