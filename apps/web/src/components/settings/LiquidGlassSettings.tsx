import type { CSSProperties } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_LIQUID_GLASS_BLUR,
  MAX_LIQUID_GLASS_PERCENT,
} from "@t3tools/contracts/settings";

import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const controls = [
  {
    key: "liquidGlassBlur",
    searchId: "setting-liquid-glass-blur",
    description:
      "Blur radius after refraction. The reference uses 1px; higher values soften the backdrop. Only affects liquid glass.",
    max: MAX_LIQUID_GLASS_BLUR,
    step: 1,
    unit: "px",
  },
  {
    key: "liquidGlassSaturation",
    searchId: "setting-liquid-glass-saturation",
    description:
      "Backdrop color intensity in liquid glass. 100% preserves the reference colors; 0% removes color.",
    max: MAX_LIQUID_GLASS_PERCENT,
    step: 5,
    unit: "%",
  },
  {
    key: "liquidGlassRefraction",
    searchId: "setting-liquid-glass-refraction",
    description:
      "How strongly liquid glass bends the backdrop. 100% uses the reference displacement scales; 0% disables bending.",
    max: MAX_LIQUID_GLASS_PERCENT,
    step: 5,
    unit: "%",
  },
  {
    key: "liquidGlassDispersion",
    searchId: "setting-liquid-glass-dispersion",
    description:
      "Color separation in the refracted edges. 100% matches the reference; 0% keeps all color channels aligned.",
    max: MAX_LIQUID_GLASS_PERCENT,
    step: 5,
    unit: "%",
  },
] as const;

export function LiquidGlassSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return controls.map(({ key, searchId, description, max, step, unit }) => {
    const { id, title } = searchableSetting(searchId);
    const value = settings[key];
    const ratio = value / max;
    const controlId = `${id}-slider`;
    const sliderStyle = {
      "--settings-slider-progress": `${ratio * 100}%`,
      "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
    } as CSSProperties;

    return (
      <SettingsRow
        key={key}
        id={id}
        title={title}
        description={description}
        resetAction={
          value !== DEFAULT_UNIFIED_SETTINGS[key] ? (
            <SettingResetButton
              label={title.toLowerCase()}
              onClick={() => updateSettings({ [key]: DEFAULT_UNIFIED_SETTINGS[key] })}
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-3 sm:w-52">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor={controlId}
            >
              {value}
              {unit}
            </output>
            <input
              aria-label={title}
              className="settings-slider min-w-0 flex-1"
              id={controlId}
              max={max}
              min={0}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                if (Number.isInteger(next) && next >= 0 && next <= max) {
                  updateSettings({ [key]: next });
                }
              }}
              step={step}
              style={sliderStyle}
              type="range"
              value={value}
            />
          </div>
        }
      />
    );
  });
}
