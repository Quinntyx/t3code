import { msg } from "gt-react";
import {
  MAX_LIQUID_GLASS_BLUR,
  MAX_LIQUID_GLASS_DISPERSION,
  MAX_LIQUID_GLASS_PERCENT,
  type ThemeEffects,
  type ThemeLiquidGlassEffect,
  type ThemeSettingDefinition,
  type ThemeSettingRef,
  type ThemeSettingsSchema,
  type ThemeToggleEffect,
} from "@t3tools/contracts";
import type { ThemeDefinition } from "@t3tools/shared/themePalettes";

import {
  startLiquidGlass,
  supportsLiquidGlass,
  type LiquidGlassController,
} from "./liquid-glass/engine";
import { DEFAULT_LIQUID_GLASS_OPTIONS, type LiquidGlassOptions } from "./liquid-glass/filter";

export const THEME_STYLE_STORAGE_KEY = "t3code:theme-style:v1";
export const THEME_SETTING_OVERRIDES_STORAGE_KEY = "t3code:theme-setting-overrides:v1";
export const ENVIRONMENT_STYLES_STORAGE_KEY = "t3code:environment-styles:v1";
const LEGACY_VISUAL_MIGRATED_KEY = "t3code:legacy-visual-settings-migrated:v1";
const LEGACY_CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

export type ThemeSettingValue = boolean | number | string;
export type ThemeSettingOverridesMap = Readonly<
  Record<string, Readonly<Record<string, ThemeSettingValue>>>
>;

export interface ThemeStyleDefinition {
  readonly id: string;
  readonly label: string;
  readonly builtIn?: boolean;
  readonly css?: string;
  readonly settings?: ThemeSettingsSchema;
  readonly effects?: ThemeEffects;
}

export interface ResolvedLiquidGlassEffect {
  readonly enabled: boolean;
  readonly requested: boolean;
  readonly supported: boolean;
  readonly options: LiquidGlassOptions;
}

export interface ResolvedAmbientShimmerEffect {
  readonly enabled: boolean;
  readonly requested: boolean;
  readonly blockedByReducedMotion: boolean;
}

export interface ResolvedFloatingPanelsEffect {
  readonly enabled: boolean;
}

export interface ResolvedThemeEffects {
  readonly liquidGlass: ResolvedLiquidGlassEffect;
  readonly ambientShimmer: ResolvedAmbientShimmerEffect;
  readonly floatingPanels: ResolvedFloatingPanelsEffect;
}

export interface ResolvedThemeStyleState {
  readonly effects: ResolvedThemeEffects;
  readonly cssVariables: Readonly<Record<string, string>>;
  readonly rootAttributes: Readonly<Record<string, string>>;
  readonly paletteValues: Readonly<Record<string, ThemeSettingValue>>;
  readonly styleValues: Readonly<Record<string, ThemeSettingValue>>;
}

export interface ThemeEffectCapabilities {
  readonly liquidGlassSupported: boolean;
  readonly reducedMotion: boolean;
}

export const DEFAULT_RESOLVED_THEME_EFFECTS: ResolvedThemeEffects = {
  liquidGlass: {
    enabled: false,
    requested: false,
    supported: false,
    options: DEFAULT_LIQUID_GLASS_OPTIONS,
  },
  ambientShimmer: {
    enabled: false,
    requested: false,
    blockedByReducedMotion: false,
  },
  floatingPanels: {
    enabled: false,
  },
};

const LIQUID_GLASS_STYLE_CSS = `:root {
  --radius: 0.625rem;
  --control-radius: var(--radius);
  --sidebar-row-radius: calc(var(--radius) + 4px);
}
`;

export const BUILT_IN_LIQUID_GLASS_STYLE: ThemeStyleDefinition = {
  id: "liquid-glass",
  label: msg("Liquid Glass"),
  builtIn: true,
  settings: {
    liquidGlass: {
      type: "boolean",
      label: msg("Refractive glass"),
      description: msg("Bends the backdrop through frosted surfaces."),
      default: true,
    },
    floatingPanels: {
      type: "boolean",
      label: msg("Floating panels"),
      description: msg(
        "Detaches the sidebar, details, and preview panels into floating glass cards.",
      ),
      default: true,
    },
    ambientShimmer: {
      type: "boolean",
      label: msg("Ambient shimmer"),
      description: msg("Adds a subtle WebGL shimmer behind the workspace."),
      default: false,
    },
    blur: {
      type: "number",
      label: msg("Edge blur"),
      min: 0,
      max: MAX_LIQUID_GLASS_BLUR,
      step: 1,
      unit: "px",
      default: DEFAULT_LIQUID_GLASS_OPTIONS.blur,
      when: { setting: "liquidGlass", equals: true },
    },
    centerBlur: {
      type: "number",
      label: msg("Center blur"),
      min: 0,
      max: MAX_LIQUID_GLASS_BLUR,
      step: 1,
      unit: "px",
      default: DEFAULT_LIQUID_GLASS_OPTIONS.centerBlur,
      when: { setting: "liquidGlass", equals: true },
    },
    saturation: {
      type: "number",
      label: msg("Saturation"),
      min: 0,
      max: MAX_LIQUID_GLASS_PERCENT,
      step: 5,
      unit: "%",
      default: DEFAULT_LIQUID_GLASS_OPTIONS.saturation,
      when: { setting: "liquidGlass", equals: true },
    },
    refraction: {
      type: "number",
      label: msg("Refraction"),
      min: 0,
      max: MAX_LIQUID_GLASS_PERCENT,
      step: 5,
      unit: "%",
      default: DEFAULT_LIQUID_GLASS_OPTIONS.refraction,
      when: { setting: "liquidGlass", equals: true },
    },
    dispersion: {
      type: "number",
      label: msg("Dispersion"),
      min: 0,
      max: MAX_LIQUID_GLASS_DISPERSION,
      step: 25,
      unit: "%",
      default: DEFAULT_LIQUID_GLASS_OPTIONS.dispersion,
      when: { setting: "liquidGlass", equals: true },
    },
    glare: {
      type: "number",
      label: msg("Glare"),
      min: 0,
      max: MAX_LIQUID_GLASS_PERCENT,
      step: 5,
      unit: "%",
      default: DEFAULT_LIQUID_GLASS_OPTIONS.glare,
      when: { setting: "liquidGlass", equals: true },
    },
  },
  effects: {
    liquidGlass: {
      enabled: { setting: "liquidGlass" },
      blur: { setting: "blur" },
      centerBlur: { setting: "centerBlur" },
      saturation: { setting: "saturation" },
      refraction: { setting: "refraction" },
      dispersion: { setting: "dispersion" },
      glare: { setting: "glare" },
    },
    floatingPanels: {
      enabled: { setting: "floatingPanels" },
    },
    ambientShimmer: {
      enabled: { setting: "ambientShimmer" },
    },
  },
  css: LIQUID_GLASS_STYLE_CSS,
};

export const BUILT_IN_STYLE_DEFINITIONS: ReadonlyArray<ThemeStyleDefinition> = [
  BUILT_IN_LIQUID_GLASS_STYLE,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSettingRef(value: unknown): value is ThemeSettingRef {
  return isRecord(value) && typeof value.setting === "string";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snapNumber(value: number, min: number, max: number, step: number | undefined): number {
  const clamped = clamp(value, min, max);
  if (step === undefined || step <= 0 || !Number.isFinite(step)) return clamped;
  const snapped = min + Math.round((clamped - min) / step) * step;
  return clamp(Math.round(snapped * 1000) / 1000, min, max);
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function coerceThemeSettingValue(
  definition: ThemeSettingDefinition,
  candidate: unknown,
): ThemeSettingValue {
  switch (definition.type) {
    case "boolean":
      return typeof candidate === "boolean" ? candidate : definition.default;
    case "number":
      return typeof candidate === "number" && Number.isFinite(candidate)
        ? snapNumber(candidate, definition.min, definition.max, definition.step)
        : definition.default;
    case "select":
      return typeof candidate === "string" &&
        definition.options.some((option) => option.id === candidate)
        ? candidate
        : definition.default;
    case "color":
      return typeof candidate === "string" && HEX_COLOR_RE.test(candidate)
        ? candidate
        : definition.default;
  }
}

export function resolveThemeSettingValues(
  schema: ThemeSettingsSchema | undefined,
  overrides: Readonly<Record<string, ThemeSettingValue>> | undefined,
): Readonly<Record<string, ThemeSettingValue>> {
  if (!schema) return {};
  const resolved: Record<string, ThemeSettingValue> = {};
  for (const [key, definition] of Object.entries(schema)) {
    resolved[key] = coerceThemeSettingValue(definition, overrides?.[key]);
  }
  return resolved;
}

export function isThemeSettingVisible(
  definition: ThemeSettingDefinition,
  values: Readonly<Record<string, ThemeSettingValue>>,
): boolean {
  if (!definition.when) return true;
  return values[definition.when.setting] === definition.when.equals;
}

function resolveBooleanBinding(
  binding: boolean | ThemeSettingRef | undefined,
  values: Readonly<Record<string, ThemeSettingValue>>,
  fallback: boolean,
): boolean {
  if (binding === undefined) return fallback;
  if (typeof binding === "boolean") return binding;
  if (isSettingRef(binding)) {
    const resolved = values[binding.setting];
    return typeof resolved === "boolean" ? resolved : fallback;
  }
  return fallback;
}

function resolveNumberBinding(
  binding: number | ThemeSettingRef | undefined,
  values: Readonly<Record<string, ThemeSettingValue>>,
  fallback: number,
  min: number,
  max: number,
): number {
  let raw = fallback;
  if (typeof binding === "number" && Number.isFinite(binding)) {
    raw = binding;
  } else if (isSettingRef(binding)) {
    const resolved = values[binding.setting];
    if (typeof resolved === "number" && Number.isFinite(resolved)) {
      raw = resolved;
    }
  }
  return clamp(raw, min, max);
}

function resolveLiquidGlassEffect(
  effect: ThemeLiquidGlassEffect | undefined,
  values: Readonly<Record<string, ThemeSettingValue>>,
  capabilities: ThemeEffectCapabilities,
): ResolvedLiquidGlassEffect {
  if (!effect) {
    return {
      enabled: false,
      requested: false,
      supported: capabilities.liquidGlassSupported,
      options: DEFAULT_LIQUID_GLASS_OPTIONS,
    };
  }
  const requested = resolveBooleanBinding(effect.enabled, values, false);
  const options: LiquidGlassOptions = {
    blur: resolveNumberBinding(
      effect.blur,
      values,
      DEFAULT_LIQUID_GLASS_OPTIONS.blur,
      0,
      MAX_LIQUID_GLASS_BLUR,
    ),
    centerBlur: resolveNumberBinding(
      effect.centerBlur,
      values,
      DEFAULT_LIQUID_GLASS_OPTIONS.centerBlur,
      0,
      MAX_LIQUID_GLASS_BLUR,
    ),
    saturation: resolveNumberBinding(
      effect.saturation,
      values,
      DEFAULT_LIQUID_GLASS_OPTIONS.saturation,
      0,
      MAX_LIQUID_GLASS_PERCENT,
    ),
    refraction: resolveNumberBinding(
      effect.refraction,
      values,
      DEFAULT_LIQUID_GLASS_OPTIONS.refraction,
      0,
      MAX_LIQUID_GLASS_PERCENT,
    ),
    dispersion: resolveNumberBinding(
      effect.dispersion,
      values,
      DEFAULT_LIQUID_GLASS_OPTIONS.dispersion,
      0,
      MAX_LIQUID_GLASS_DISPERSION,
    ),
    glare: resolveNumberBinding(
      effect.glare,
      values,
      DEFAULT_LIQUID_GLASS_OPTIONS.glare,
      0,
      MAX_LIQUID_GLASS_PERCENT,
    ),
  };
  return {
    enabled: requested && capabilities.liquidGlassSupported,
    requested,
    supported: capabilities.liquidGlassSupported,
    options,
  };
}

function resolveToggleEffect(
  effect: ThemeToggleEffect | undefined,
  values: Readonly<Record<string, ThemeSettingValue>>,
): boolean {
  if (!effect) return false;
  return resolveBooleanBinding(effect.enabled, values, false);
}

const SAFE_CSS_UNITS = new Set<string>(["px", "%", "rem", "em", "ms", "s", "deg"]);

function formatSettingCssValue(
  definition: ThemeSettingDefinition,
  value: ThemeSettingValue,
): string {
  switch (definition.type) {
    case "boolean":
      return value === true ? "1" : "0";
    case "number": {
      const unit = definition.unit && SAFE_CSS_UNITS.has(definition.unit) ? definition.unit : "";
      return `${value}${unit}`;
    }
    case "select":
    case "color":
      return String(value);
  }
}

function toAttributeSlug(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`).toLowerCase();
}

function collectSettingBindings(
  schema: ThemeSettingsSchema | undefined,
  values: Readonly<Record<string, ThemeSettingValue>>,
  cssPrefix: string,
  attrPrefix: string,
  cssVariables: Record<string, string>,
  rootAttributes: Record<string, string>,
): void {
  if (!schema) return;
  for (const [key, definition] of Object.entries(schema)) {
    const value = values[key] ?? definition.default;
    const slug = toAttributeSlug(key);
    cssVariables[`${cssPrefix}${slug}`] = formatSettingCssValue(definition, value);
    if (definition.type === "boolean") {
      rootAttributes[`${attrPrefix}${slug}`] = value === true ? "true" : "false";
    } else if (definition.type === "select") {
      rootAttributes[`${attrPrefix}${slug}`] = String(value);
    }
  }
}

function getThemeEffectCapabilities(): ThemeEffectCapabilities {
  if (typeof window === "undefined") {
    return { liquidGlassSupported: false, reducedMotion: false };
  }
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    liquidGlassSupported: supportsLiquidGlass(),
    reducedMotion,
  };
}

export function resolveThemeEffectsAndSettings(input: {
  readonly palette: Pick<ThemeDefinition, "id" | "settings" | "effects"> | null;
  readonly style: Pick<ThemeStyleDefinition, "id" | "settings" | "effects"> | null;
  readonly overrides: ThemeSettingOverridesMap;
  readonly capabilities?: ThemeEffectCapabilities;
}): ResolvedThemeStyleState {
  const capabilities = input.capabilities ?? getThemeEffectCapabilities();
  const paletteValues = resolveThemeSettingValues(
    input.palette?.settings,
    input.palette ? input.overrides[input.palette.id] : undefined,
  );
  const styleValues = resolveThemeSettingValues(
    input.style?.settings,
    input.style ? input.overrides[input.style.id] : undefined,
  );

  const cssVariables: Record<string, string> = {};
  const rootAttributes: Record<string, string> = {};
  collectSettingBindings(
    input.palette?.settings,
    paletteValues,
    "--theme-setting-",
    "data-theme-setting-",
    cssVariables,
    rootAttributes,
  );
  collectSettingBindings(
    input.style?.settings,
    styleValues,
    "--theme-style-setting-",
    "data-theme-style-setting-",
    cssVariables,
    rootAttributes,
  );

  // Whole-effect replacement: if the active style declares an effect key, it replaces the palette's.
  const liquidGlassSource =
    input.style?.effects?.liquidGlass !== undefined
      ? { effect: input.style.effects.liquidGlass, values: styleValues }
      : { effect: input.palette?.effects?.liquidGlass, values: paletteValues };
  const floatingPanelsSource =
    input.style?.effects?.floatingPanels !== undefined
      ? { effect: input.style.effects.floatingPanels, values: styleValues }
      : { effect: input.palette?.effects?.floatingPanels, values: paletteValues };
  const ambientShimmerSource =
    input.style?.effects?.ambientShimmer !== undefined
      ? { effect: input.style.effects.ambientShimmer, values: styleValues }
      : { effect: input.palette?.effects?.ambientShimmer, values: paletteValues };

  const liquidGlass = resolveLiquidGlassEffect(
    liquidGlassSource.effect,
    liquidGlassSource.values,
    capabilities,
  );
  const floatingPanelsEnabled = resolveToggleEffect(
    floatingPanelsSource.effect,
    floatingPanelsSource.values,
  );
  const shimmerRequested = resolveToggleEffect(
    ambientShimmerSource.effect,
    ambientShimmerSource.values,
  );

  return {
    effects: {
      liquidGlass,
      floatingPanels: { enabled: floatingPanelsEnabled },
      ambientShimmer: {
        enabled: shimmerRequested && !capabilities.reducedMotion,
        requested: shimmerRequested,
        blockedByReducedMotion: shimmerRequested && capabilities.reducedMotion,
      },
    },
    cssVariables,
    rootAttributes,
    paletteValues,
    styleValues,
  };
}

export function readThemeSettingOverrides(): ThemeSettingOverridesMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(THEME_SETTING_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const result: Record<string, Record<string, ThemeSettingValue>> = {};
    for (const [ownerId, entries] of Object.entries(parsed)) {
      if (!isRecord(entries)) continue;
      const clean: Record<string, ThemeSettingValue> = {};
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
          clean[key] = value;
        }
      }
      if (Object.keys(clean).length > 0) result[ownerId] = clean;
    }
    return result;
  } catch {
    return {};
  }
}

function saveThemeSettingOverrides(next: ThemeSettingOverridesMap): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (Object.keys(next).length === 0) {
      window.localStorage.removeItem(THEME_SETTING_OVERRIDES_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_SETTING_OVERRIDES_STORAGE_KEY, JSON.stringify(next));
    }
    return true;
  } catch {
    return false;
  }
}

export function writeThemeSettingOverride(
  ownerId: string,
  key: string,
  value: ThemeSettingValue,
  schema?: ThemeSettingsSchema,
): boolean {
  const definition = schema?.[key];
  const coerced = definition ? coerceThemeSettingValue(definition, value) : value;
  const current = readThemeSettingOverrides();
  const nextOwner: Record<string, ThemeSettingValue> = { ...current[ownerId] };
  if (definition && coerced === definition.default) {
    delete nextOwner[key];
  } else {
    nextOwner[key] = coerced;
  }
  const next: Record<string, Readonly<Record<string, ThemeSettingValue>>> = { ...current };
  if (Object.keys(nextOwner).length === 0) {
    delete next[ownerId];
  } else {
    next[ownerId] = nextOwner;
  }
  return saveThemeSettingOverrides(next);
}

export function resetThemeSettingOverrides(ownerId: string): boolean {
  const current = readThemeSettingOverrides();
  if (!(ownerId in current)) return true;
  const next = { ...current };
  delete next[ownerId];
  return saveThemeSettingOverrides(next);
}

let appliedCssVariableNames: ReadonlyArray<string> = [];
let appliedRootAttributeNames: ReadonlyArray<string> = [];

export function applyResolvedThemeSettingBindings(
  root: HTMLElement,
  resolved: Pick<ResolvedThemeStyleState, "cssVariables" | "rootAttributes">,
): void {
  for (const name of appliedCssVariableNames) {
    if (!(name in resolved.cssVariables)) {
      root.style.removeProperty(name);
    }
  }
  for (const [name, value] of Object.entries(resolved.cssVariables)) {
    root.style.setProperty(name, value);
  }
  appliedCssVariableNames = Object.keys(resolved.cssVariables);

  for (const name of appliedRootAttributeNames) {
    if (!(name in resolved.rootAttributes)) {
      root.removeAttribute(name);
    }
  }
  for (const [name, value] of Object.entries(resolved.rootAttributes)) {
    root.setAttribute(name, value);
  }
  appliedRootAttributeNames = Object.keys(resolved.rootAttributes);
}

function applyLegacyForkVisualSettingsRecord(parsed: Record<string, unknown>): boolean {
  if (typeof window === "undefined") return false;
  if (window.localStorage.getItem(THEME_STYLE_STORAGE_KEY) !== null) return false;

  const liquidGlassEnabled = parsed.liquidGlassEnabled === true;
  const floatingPanelsEnabled = parsed.floatingPanelsEnabled === true;
  const ambientShimmerEnabled = parsed.ambientShimmerEnabled === true;
  if (!liquidGlassEnabled && !floatingPanelsEnabled && !ambientShimmerEnabled) {
    return false;
  }

  window.localStorage.setItem(THEME_STYLE_STORAGE_KEY, BUILT_IN_LIQUID_GLASS_STYLE.id);
  const schema = BUILT_IN_LIQUID_GLASS_STYLE.settings;
  const overrides: Record<string, ThemeSettingValue> = {
    liquidGlass: liquidGlassEnabled,
    floatingPanels: floatingPanelsEnabled,
    ambientShimmer: ambientShimmerEnabled,
  };
  const numericMapping = [
    ["liquidGlassBlur", "blur"],
    ["liquidGlassCenterBlur", "centerBlur"],
    ["liquidGlassSaturation", "saturation"],
    ["liquidGlassRefraction", "refraction"],
    ["liquidGlassDispersion", "dispersion"],
    ["liquidGlassGlare", "glare"],
  ] as const;
  for (const [legacyKey, settingKey] of numericMapping) {
    const value = parsed[legacyKey];
    const def = schema?.[settingKey];
    if (def && typeof value === "number" && Number.isFinite(value)) {
      overrides[settingKey] = coerceThemeSettingValue(def, value);
    }
  }
  const pruned: Record<string, ThemeSettingValue> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (schema?.[key]?.default !== value) {
      pruned[key] = value;
    }
  }
  if (Object.keys(pruned).length > 0) {
    const existing = readThemeSettingOverrides();
    saveThemeSettingOverrides({
      ...existing,
      [BUILT_IN_LIQUID_GLASS_STYLE.id]: {
        ...existing[BUILT_IN_LIQUID_GLASS_STYLE.id],
        ...pruned,
      },
    });
  }
  return true;
}

/**
 * One-time migration for existing fork users upgrading from legacy client-settings visual toggles
 * (`liquidGlassEnabled`, `floatingPanelsEnabled`, `ambientShimmerEnabled`, and slider knobs)
 * to the `"liquid-glass"` user style. Runs before `UnifiedSettings` schema decoding drops them.
 */
export function migrateLegacyForkVisualSettings(): boolean {
  if (typeof window === "undefined") return false;
  // On Electron desktop, `migrateLegacyDesktopForkVisualSettings()` owns the migration so
  // legacy browser localStorage cannot shadow the desktop JSON file or set the flag early.
  if (window.desktopBridge?.getLegacyVisualSettings) return false;
  try {
    if (window.localStorage.getItem(LEGACY_VISUAL_MIGRATED_KEY) === "1") return false;
    const rawSettings = window.localStorage.getItem(LEGACY_CLIENT_SETTINGS_STORAGE_KEY);
    if (!rawSettings) {
      window.localStorage.setItem(LEGACY_VISUAL_MIGRATED_KEY, "1");
      return false;
    }
    const parsed: unknown = JSON.parse(rawSettings);
    const migrated = isRecord(parsed) ? applyLegacyForkVisualSettingsRecord(parsed) : false;
    window.localStorage.setItem(LEGACY_VISUAL_MIGRATED_KEY, "1");
    return migrated;
  } catch {
    return false;
  }
}

export async function migrateLegacyDesktopForkVisualSettings(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const readLegacy = window.desktopBridge?.getLegacyVisualSettings;
  if (!readLegacy) return false;
  try {
    if (window.localStorage.getItem(LEGACY_VISUAL_MIGRATED_KEY) === "1") return false;
    const parsed = await readLegacy();
    let migrated = false;
    if (isRecord(parsed)) {
      migrated = applyLegacyForkVisualSettingsRecord(parsed);
    } else {
      const rawSettings = window.localStorage.getItem(LEGACY_CLIENT_SETTINGS_STORAGE_KEY);
      if (rawSettings) {
        const localParsed: unknown = JSON.parse(rawSettings);
        if (isRecord(localParsed)) {
          migrated = applyLegacyForkVisualSettingsRecord(localParsed);
        }
      }
    }
    window.localStorage.setItem(LEGACY_VISUAL_MIGRATED_KEY, "1");
    return migrated;
  } catch {
    return false;
  }
}

export function startThemeEffectController(
  getEffects: () => ResolvedThemeEffects,
  subscribe: (listener: () => void) => () => void,
): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};
  const root = document.documentElement;
  let liquidGlass: LiquidGlassController | null = null;

  const sync = () => {
    const effects = getEffects();
    root.toggleAttribute("data-ambient-shimmer", effects.ambientShimmer.enabled);
    root.toggleAttribute("data-floating-panels", effects.floatingPanels.enabled);

    if (effects.liquidGlass.enabled) {
      if (liquidGlass) {
        liquidGlass.update(effects.liquidGlass.options);
      } else {
        liquidGlass = startLiquidGlass(effects.liquidGlass.options);
      }
    } else if (liquidGlass) {
      liquidGlass.stop();
      liquidGlass = null;
    }
  };

  const unsubscribe = subscribe(sync);
  const reducedMotionQuery =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  reducedMotionQuery?.addEventListener("change", sync);
  sync();

  return () => {
    unsubscribe();
    reducedMotionQuery?.removeEventListener("change", sync);
    if (liquidGlass) {
      liquidGlass.stop();
      liquidGlass = null;
    }
    root.removeAttribute("data-ambient-shimmer");
    root.removeAttribute("data-floating-panels");
  };
}
