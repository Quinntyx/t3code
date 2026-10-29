import { describe, expect, it } from "vite-plus/test";

import { FONT_FAMILIES, uiFontChoices } from "./fontFamilies";
import {
  createMobileThemeRuntimeOperations,
  type MobileThemeRuntimeState,
} from "./mobileThemeRuntime";

const initialState: MobileThemeRuntimeState = {
  baseFontSize: 16,
  uiFont: FONT_FAMILIES,
  monoFontFamily: "ui-monospace",
  themeAppearance: "light",
  themeMode: "system",
};

describe("mobileThemeRuntime", () => {
  it("lets system appearance changes flow through the root ScopedTheme only", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      themeAppearance: "dark",
    });

    expect(operations).toEqual([]);
  });

  it("rewrites font variables for every theme when a font choice changes", () => {
    const system = uiFontChoices("ios").find((choice) => choice.id === "system")!.value;
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      uiFont: system,
      monoFontFamily: "Menlo",
    });

    expect(operations.length).toBeGreaterThan(1);
    for (const operation of operations) {
      expect(operation).toMatchObject({
        kind: "update-css-variables",
        variables: {
          "--font-sans": "System",
          "--font-medium": "System",
          "--font-bold": "System",
          "--font-mono": "Menlo",
        },
      });
    }
  });
});
