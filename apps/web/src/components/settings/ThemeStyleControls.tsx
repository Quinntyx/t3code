import type { CSSProperties } from "react";
import { useGT, useMessages } from "gt-react";
import type { ThemeSettingDefinition, ThemeSettingsSchema } from "@t3tools/contracts";

import { useEnvironmentStyleDefinitions } from "../../hooks/useEnvironmentTheme";
import { useTheme } from "../../hooks/useTheme";
import {
  isThemeSettingVisible,
  resolveThemeSettingValues,
  type ThemeSettingValue,
} from "../../themeEffects";
import {
  getThemeDefinition,
  getThemeStyleDefinition,
  getThemeStyleDefinitions,
  resolveThemeHalf,
} from "../../themePalette";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { LiquidGlassPreview } from "./LiquidGlassPreview";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const NONE_STYLE_VALUE = "__none__";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function formatNumberDisplay(value: number, unit: string | undefined): string {
  return unit ? `${value}${unit}` : String(value);
}

interface SettingGroupProps {
  readonly ownerId: string;
  readonly isBuiltIn?: boolean;
  readonly schema: ThemeSettingsSchema;
  readonly overrides: Readonly<Record<string, ThemeSettingValue>> | undefined;
  readonly onChange: (
    ownerId: string,
    key: string,
    value: ThemeSettingValue,
    schema: ThemeSettingsSchema,
  ) => void;
}

function ThemeSettingRows({
  ownerId,
  isBuiltIn = false,
  schema,
  overrides,
  onChange,
}: SettingGroupProps) {
  const gt = useGT();
  const m = useMessages();
  const resolvedValues = resolveThemeSettingValues(schema, overrides);

  return (
    <>
      {Object.entries(schema).map(([key, definition]) => {
        if (!isThemeSettingVisible(definition, resolvedValues)) return null;
        const value = resolvedValues[key] ?? definition.default;
        const isOverridden = value !== definition.default;
        const inputId = `theme-setting-${ownerId}-${key}`;
        const label = isBuiltIn ? m(definition.label) : definition.label;
        const description =
          definition.description !== undefined
            ? isBuiltIn
              ? m(definition.description)
              : definition.description
            : undefined;

        return (
          <SettingsRow
            key={`${ownerId}:${key}`}
            title={label}
            description={description}
            devicePreference
            resetAction={
              isOverridden ? (
                <SettingResetButton
                  ariaLabel={gt("Reset {label} to default", { label })}
                  onClick={() => onChange(ownerId, key, definition.default, schema)}
                />
              ) : null
            }
            control={
              <ThemeSettingControl
                inputId={inputId}
                label={label}
                definition={definition}
                value={value}
                onChange={(nextValue) => onChange(ownerId, key, nextValue, schema)}
              />
            }
          />
        );
      })}
    </>
  );
}

function ThemeSettingControl({
  inputId,
  label,
  definition,
  value,
  onChange,
}: {
  readonly inputId: string;
  readonly label: string;
  readonly definition: ThemeSettingDefinition;
  readonly value: ThemeSettingValue;
  readonly onChange: (value: ThemeSettingValue) => void;
}) {
  switch (definition.type) {
    case "boolean":
      return (
        <Switch
          aria-label={label}
          checked={value === true}
          onCheckedChange={(checked) => onChange(Boolean(checked))}
        />
      );

    case "number": {
      const numericValue = typeof value === "number" ? value : definition.default;
      const span = definition.max - definition.min;
      const ratio = span > 0 ? (numericValue - definition.min) / span : 0;
      const sliderStyle = {
        "--settings-slider-progress": `${ratio * 100}%`,
        "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
      } as CSSProperties;

      return (
        <div className="flex w-full items-center gap-3 sm:w-52">
          <output
            className="min-w-14 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
            htmlFor={inputId}
          >
            {formatNumberDisplay(numericValue, definition.unit)}
          </output>
          <input
            aria-label={label}
            className="settings-slider min-w-0 flex-1"
            id={inputId}
            max={definition.max}
            min={definition.min}
            step={definition.step ?? 1}
            style={sliderStyle}
            type="range"
            value={numericValue}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isFinite(next)) onChange(next);
            }}
          />
        </div>
      );
    }

    case "select": {
      const stringValue = typeof value === "string" ? value : definition.default;
      const selectedOption =
        definition.options.find((option) => option.id === stringValue) ?? definition.options[0];
      return (
        <div className="w-full sm:w-44">
          <Select
            value={stringValue}
            onValueChange={(next) => {
              if (typeof next === "string") onChange(next);
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label={label}>
              <SelectValue>{selectedOption?.label ?? stringValue}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {definition.options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      );
    }

    case "color": {
      const colorValue =
        typeof value === "string" && HEX_COLOR_RE.test(value) ? value : definition.default;
      return (
        <div className="flex items-center gap-2">
          <input
            aria-label={label}
            className="h-7 w-9 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
            id={inputId}
            type="color"
            value={colorValue}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (HEX_COLOR_RE.test(next)) onChange(next);
            }}
          />
          <span className="min-w-16 font-mono text-xs text-muted-foreground uppercase">
            {colorValue}
          </span>
        </div>
      );
    }
  }
}

export function ThemeStyleControls() {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const {
    theme,
    themeHalves,
    resolvedTheme,
    themeStyle,
    setThemeStyle,
    resolvedEffects,
    settingOverrides,
    setThemeSetting,
    resetThemeSettings,
  } = useTheme();
  // Subscribe to published environment styles so newly installed styles appear immediately.
  useEnvironmentStyleDefinitions();
  const availableStyles = getThemeStyleDefinitions();
  const activeStyle = getThemeStyleDefinition(themeStyle);
  const activePaletteId = resolveThemeHalf(theme, themeHalves, resolvedTheme);
  const activePalette = getThemeDefinition(activePaletteId);

  const styleHasOverrides =
    activeStyle !== null && Object.keys(settingOverrides[activeStyle.id] ?? {}).length > 0;
  const paletteHasOverrides =
    activePalette !== null && Object.keys(settingOverrides[activePalette.id] ?? {}).length > 0;
  const hasAnyOverrides = styleHasOverrides || paletteHasOverrides;

  const statusNotes: string[] = [];
  if (resolvedEffects.liquidGlass.requested && !resolvedEffects.liquidGlass.supported) {
    statusNotes.push(gt("Refractive glass requires Chromium."));
  }
  if (resolvedEffects.ambientShimmer.blockedByReducedMotion) {
    statusNotes.push(gt("Ambient shimmer is paused while Reduce Motion is enabled."));
  }

  const handleResetAll = () => {
    if (activeStyle) resetThemeSettings(activeStyle.id);
    if (activePalette) resetThemeSettings(activePalette.id);
  };

  const activeStyleLabel = activeStyle
    ? activeStyle.builtIn
      ? m(activeStyle.label)
      : activeStyle.label
    : gt("None");

  return (
    <SettingsSection
      id="appearance-style"
      title={gt("Style & effects")}
      headerAction={
        hasAnyOverrides ? (
          <Button size="xs" variant="ghost" onClick={handleResetAll}>
            {gt("Reset settings")}
          </Button>
        ) : null
      }
    >
      <SettingsRow
        {...searchableSetting("theme-style")}
        description={gt(
          "Apply an optional visual style and effects on top of your selected color palette.",
        )}
        status={statusNotes.length > 0 ? statusNotes.join(" ") : undefined}
        devicePreference
        resetAction={
          themeStyle !== null ? (
            <SettingResetButton
              ariaLabel={gt("Reset style to None")}
              onClick={() => setThemeStyle(null)}
            />
          ) : null
        }
        control={
          <div className="w-full sm:w-44">
            <Select
              value={themeStyle ?? NONE_STYLE_VALUE}
              onValueChange={(value) => {
                if (value === NONE_STYLE_VALUE) {
                  setThemeStyle(null);
                } else if (typeof value === "string") {
                  setThemeStyle(value);
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full min-w-0" aria-label={gt("Style")}>
                <SelectValue>{activeStyleLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={NONE_STYLE_VALUE}>{gt("None")}</SelectItem>
                {availableStyles.map((style) => (
                  <SelectItem key={style.id} value={style.id}>
                    {style.builtIn ? m(style.label) : style.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        }
      />

      {resolvedEffects.liquidGlass.requested ? (
        <SettingsRow
          title={gt("Glass preview")}
          description={gt("Live preview of refractive glass against high-contrast edges.")}
          control={<LiquidGlassPreview />}
        />
      ) : null}

      {activeStyle?.settings ? (
        <ThemeSettingRows
          ownerId={activeStyle.id}
          isBuiltIn={activeStyle.builtIn === true}
          schema={activeStyle.settings}
          overrides={settingOverrides[activeStyle.id]}
          onChange={setThemeSetting}
        />
      ) : null}

      {activePalette?.settings ? (
        <ThemeSettingRows
          ownerId={activePalette.id}
          schema={activePalette.settings}
          overrides={settingOverrides[activePalette.id]}
          onChange={setThemeSetting}
        />
      ) : null}
    </SettingsSection>
  );
}
