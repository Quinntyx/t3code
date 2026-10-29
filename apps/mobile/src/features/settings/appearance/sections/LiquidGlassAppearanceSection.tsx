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
    label: "Glass opacity",
    icon: "circle.lefthalf.filled",
    step: 5,
    unit: "%",
  },
  { key: "blur", label: "Blur", icon: "aqi.medium", step: 1, unit: " pt" },
  { key: "saturation", label: "Saturation", icon: "drop.halffull", step: 5, unit: "%" },
  { key: "refraction", label: "Refraction", icon: "sparkles", step: 5, unit: "%" },
  { key: "dispersion", label: "Dispersion", icon: "rainbow", step: 5, unit: "%" },
] as const satisfies ReadonlyArray<{
  readonly key: Exclude<keyof LiquidGlassPreferences, "enabled">;
  readonly label: string;
  readonly icon: string;
  readonly step: number;
  readonly unit: string;
}>;

export function LiquidGlassAppearanceSection() {
  const { isReady, liquidGlass, setLiquidGlass } = useAppearancePreferences();
  const active = liquidGlass.enabled && LIQUID_GLASS_SUPPORTED;
  return (
    <SettingsSection
      title="Liquid glass"
      trailing={
        <Text textRole="footnote" className="px-4 font-t3-medium text-warning-foreground">
          Experimental
        </Text>
      }
      footer={
        LIQUID_GLASS_SUPPORTED
          ? "Refracts the conversation and lists behind the composer, toolbar, and menus. Performance warning: may increase GPU usage, reduce frame rates, and use more battery."
          : "Requires Android 13 or later."
      }
    >
      <SettingsSwitchRow
        disabled={!isReady || !LIQUID_GLASS_SUPPORTED}
        icon="sparkles"
        label="Liquid glass"
        value={active}
        onValueChange={(enabled) => setLiquidGlass({ enabled })}
      />
      {active
        ? SLIDERS.map(({ key, label, icon, step, unit }) => (
            <SliderRow
              key={key}
              disabled={!isReady}
              icon={icon}
              label={label}
              min={LIQUID_GLASS_LIMITS[key].min}
              max={LIQUID_GLASS_LIMITS[key].max}
              step={step}
              value={liquidGlass[key]}
              valueLabel={`${liquidGlass[key]}${unit}`}
              onChange={(value) => setLiquidGlass({ [key]: value })}
            />
          ))
        : null}
    </SettingsSection>
  );
}
