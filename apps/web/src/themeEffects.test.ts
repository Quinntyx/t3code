import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ThemeSettingsSchema } from "@t3tools/contracts";

import {
  BUILT_IN_LIQUID_GLASS_STYLE,
  coerceThemeSettingValue,
  DEFAULT_RESOLVED_THEME_EFFECTS,
  isThemeSettingVisible,
  migrateLegacyDesktopForkVisualSettings,
  migrateLegacyForkVisualSettings,
  readThemeSettingOverrides,
  resolveThemeEffectsAndSettings,
  startThemeEffectController,
  THEME_SETTING_OVERRIDES_STORAGE_KEY,
  THEME_STYLE_STORAGE_KEY,
  type ResolvedThemeEffects,
} from "./themeEffects";

function withMockLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: storage },
    configurable: true,
    writable: true,
  });
  return store;
}

afterEach(() => {
  if ("window" in globalThis) {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("resolveThemeEffectsAndSettings", () => {
  it("resolves built-in liquid-glass defaults, namespaced bindings, and user overrides", () => {
    const resolved = resolveThemeEffectsAndSettings({
      palette: null,
      style: BUILT_IN_LIQUID_GLASS_STYLE,
      overrides: {
        "liquid-glass": {
          blur: 12,
          ambientShimmer: true,
          floatingPanels: false,
        },
      },
      capabilities: { liquidGlassSupported: true, reducedMotion: false },
    });

    expect(resolved.effects.liquidGlass.enabled).toBe(true);
    expect(resolved.effects.liquidGlass.requested).toBe(true);
    expect(resolved.effects.liquidGlass.options.blur).toBe(12);
    expect(resolved.effects.floatingPanels.enabled).toBe(false);
    expect(resolved.effects.ambientShimmer).toEqual({
      enabled: true,
      requested: true,
      blockedByReducedMotion: false,
    });
    expect(resolved.cssVariables["--theme-style-setting-blur"]).toBe("12px");
    expect(resolved.cssVariables["--theme-style-setting-ambient-shimmer"]).toBe("1");
    expect(resolved.rootAttributes["data-theme-style-setting-floating-panels"]).toBe("false");
  });

  it("replaces palette effects wholesale when the style declares the same effect key", () => {
    const palette = {
      id: "custom-palette",
      settings: {
        accentTint: {
          type: "color" as const,
          label: "Accent tint",
          default: "#224466",
        },
      },
      effects: {
        liquidGlass: {
          enabled: true,
          blur: 14,
          refraction: 90,
        },
        ambientShimmer: {
          enabled: true,
        },
      },
    };
    const style = {
      id: "minimal-glass",
      effects: {
        liquidGlass: {
          enabled: true,
          blur: 2,
        },
      },
    };

    const resolved = resolveThemeEffectsAndSettings({
      palette,
      style,
      overrides: {},
      capabilities: { liquidGlassSupported: true, reducedMotion: false },
    });

    // Style declared liquidGlass without refraction -> whole-effect replacement resets refraction to engine default, not palette's 90.
    expect(resolved.effects.liquidGlass.options.blur).toBe(2);
    expect(resolved.effects.liquidGlass.options.refraction).not.toBe(90);
    // Style omitted ambientShimmer -> palette's ambientShimmer stays active.
    expect(resolved.effects.ambientShimmer.enabled).toBe(true);
    expect(resolved.cssVariables["--theme-setting-accent-tint"]).toBe("#224466");
  });

  it("enforces Chromium capability for liquid glass and reduced-motion pause for ambient shimmer", () => {
    const resolved = resolveThemeEffectsAndSettings({
      palette: null,
      style: BUILT_IN_LIQUID_GLASS_STYLE,
      overrides: {
        "liquid-glass": {
          ambientShimmer: true,
        },
      },
      capabilities: { liquidGlassSupported: false, reducedMotion: true },
    });

    expect(resolved.effects.liquidGlass.requested).toBe(true);
    expect(resolved.effects.liquidGlass.supported).toBe(false);
    expect(resolved.effects.liquidGlass.enabled).toBe(false);
    expect(resolved.effects.ambientShimmer).toEqual({
      enabled: false,
      requested: true,
      blockedByReducedMotion: true,
    });
  });

  it("clamps and snaps setting values and evaluates local when conditions", () => {
    const schema: ThemeSettingsSchema = {
      enabled: { type: "boolean", label: "Enabled", default: false },
      strength: {
        type: "number",
        label: "Strength",
        min: 0,
        max: 100,
        step: 5,
        default: 50,
        when: { setting: "enabled", equals: true },
      },
      mode: {
        type: "select",
        label: "Mode",
        options: [
          { id: "soft", label: "Soft" },
          { id: "crisp", label: "Crisp" },
        ],
        default: "soft",
      },
      tint: { type: "color", label: "Tint", default: "#112233" },
    };

    expect(coerceThemeSettingValue(schema.strength!, 143)).toBe(100);
    expect(coerceThemeSettingValue(schema.strength!, 23)).toBe(25);
    expect(coerceThemeSettingValue(schema.mode!, "unknown")).toBe("soft");
    expect(coerceThemeSettingValue(schema.tint!, "red")).toBe("#112233");
    expect(coerceThemeSettingValue(schema.tint!, "#abcdef")).toBe("#abcdef");
    expect(isThemeSettingVisible(schema.strength!, { enabled: false })).toBe(false);
    expect(isThemeSettingVisible(schema.strength!, { enabled: true })).toBe(true);
  });
});

describe("migrateLegacyForkVisualSettings", () => {
  it("migrates legacy enabled fork toggles and glass knobs into the liquid-glass style once", () => {
    const store = withMockLocalStorage({
      "t3code:client-settings:v1": JSON.stringify({
        liquidGlassEnabled: true,
        floatingPanelsEnabled: false,
        ambientShimmerEnabled: true,
        liquidGlassBlur: 11,
        liquidGlassGlare: 60,
      }),
    });

    expect(migrateLegacyForkVisualSettings()).toBe(true);
    expect(store.get(THEME_STYLE_STORAGE_KEY)).toBe("liquid-glass");
    expect(readThemeSettingOverrides()).toEqual({
      "liquid-glass": {
        floatingPanels: false,
        ambientShimmer: true,
        blur: 11,
        glare: 60,
      },
    });

    // Running again is a no-op even if the user later switches back to None.
    store.delete(THEME_STYLE_STORAGE_KEY);
    expect(migrateLegacyForkVisualSettings()).toBe(false);
    expect(store.get(THEME_STYLE_STORAGE_KEY)).toBeUndefined();
  });

  it("leaves users with all legacy visual toggles off on None", () => {
    const store = withMockLocalStorage({
      "t3code:client-settings:v1": JSON.stringify({
        liquidGlassEnabled: false,
        floatingPanelsEnabled: false,
        ambientShimmerEnabled: false,
      }),
    });

    expect(migrateLegacyForkVisualSettings()).toBe(false);
    expect(store.get(THEME_STYLE_STORAGE_KEY)).toBeUndefined();
    expect(store.get(THEME_SETTING_OVERRIDES_STORAGE_KEY)).toBeUndefined();
  });

  it("migrates legacy visual settings from Electron desktopBridge even when localStorage exists and retries after transient read errors", async () => {
    const store = withMockLocalStorage({
      "t3code:client-settings:v1": JSON.stringify({
        liquidGlassEnabled: false,
      }),
    });
    const prevBridge = window.desktopBridge;
    let shouldFail = true;
    (window as unknown as { desktopBridge?: unknown }).desktopBridge = {
      getLegacyVisualSettings: async () => {
        if (shouldFail) throw new Error("transient read failure");
        return {
          liquidGlassEnabled: true,
          floatingPanelsEnabled: true,
          ambientShimmerEnabled: false,
          liquidGlassBlur: 9,
        };
      },
    };
    try {
      // Browser migrator must defer to desktopBridge without setting the migrated flag.
      expect(migrateLegacyForkVisualSettings()).toBe(false);
      // Transient desktopBridge error leaves the migrated flag unset so the next startup retries.
      expect(await migrateLegacyDesktopForkVisualSettings()).toBe(false);
      shouldFail = false;
      expect(await migrateLegacyDesktopForkVisualSettings()).toBe(true);
      expect(store.get(THEME_STYLE_STORAGE_KEY)).toBe("liquid-glass");
      expect(readThemeSettingOverrides()).toEqual({
        "liquid-glass": {
          blur: 9,
        },
      });
      // Second call is a no-op once migrated.
      store.delete(THEME_STYLE_STORAGE_KEY);
      expect(await migrateLegacyDesktopForkVisualSettings()).toBe(false);
    } finally {
      (window as unknown as { desktopBridge?: unknown }).desktopBridge = prevBridge;
    }
  });

  it("drops unsafe CSS unit strings from emitted custom properties", () => {
    const resolved = resolveThemeEffectsAndSettings({
      palette: null,
      style: {
        id: "unsafe-unit-test",
        settings: {
          radius: {
            type: "number",
            label: "Radius",
            min: 0,
            max: 20,
            default: 8,
            unit: "%url(//evil.example)" as unknown as "px",
          },
        },
      },
      overrides: {},
    });
    expect(resolved.cssVariables["--theme-style-setting-radius"]).toBe("8");
  });
});

describe("startThemeEffectController", () => {
  afterEach(() => {
    if ("document" in globalThis) {
      Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("toggles data-liquid-glass-effect on documentElement without setting data-liquid-glass", () => {
    const attrs = new Set<string>();
    const root = {
      toggleAttribute: (name: string, force?: boolean) => {
        if (force) attrs.add(name);
        else attrs.delete(name);
        return attrs.has(name);
      },
      removeAttribute: (name: string) => {
        attrs.delete(name);
      },
    };
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: { documentElement: root },
      configurable: true,
      writable: true,
    });

    let current: ResolvedThemeEffects = {
      ...DEFAULT_RESOLVED_THEME_EFFECTS,
      liquidGlass: {
        ...DEFAULT_RESOLVED_THEME_EFFECTS.liquidGlass,
        requested: true,
        enabled: false,
      },
      floatingPanels: { enabled: true },
    };
    const listeners = new Set<() => void>();
    const notify = () => {
      for (const cb of listeners) cb();
    };
    const stop = startThemeEffectController(
      () => current,
      (cb) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    );

    expect(attrs.has("data-liquid-glass-effect")).toBe(true);
    expect(attrs.has("data-liquid-glass")).toBe(false);
    expect(attrs.has("data-floating-panels")).toBe(true);

    current = DEFAULT_RESOLVED_THEME_EFFECTS;
    notify();
    expect(attrs.has("data-liquid-glass-effect")).toBe(false);
    expect(attrs.has("data-floating-panels")).toBe(false);

    current = {
      ...DEFAULT_RESOLVED_THEME_EFFECTS,
      liquidGlass: {
        ...DEFAULT_RESOLVED_THEME_EFFECTS.liquidGlass,
        requested: true,
        enabled: false,
      },
    };
    notify();
    expect(attrs.has("data-liquid-glass-effect")).toBe(true);

    stop();
    expect(attrs.has("data-liquid-glass-effect")).toBe(false);
  });
});
