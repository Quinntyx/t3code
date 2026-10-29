import { describe, expect, it } from "vite-plus/test";

import { resolveAppearance, resolveAppearancePreferences } from "./appearancePreferences";
import { FONT_FAMILIES } from "./fontFamilies";

describe("appearancePreferences", () => {
  it("migrates the legacy markdownFontSize key to baseFontSize", () => {
    expect(resolveAppearancePreferences({ markdownFontSize: 18 }).baseFontSize).toBe(18);
    expect(
      resolveAppearancePreferences({ baseFontSize: 16, markdownFontSize: 18 }).baseFontSize,
    ).toBe(16);
  });

  it("resolves font choices per platform and falls back for ids it does not offer", () => {
    const preferences = resolveAppearancePreferences({
      uiFontId: "condensed",
      codeFontId: "menlo",
      terminalFontId: "serif-mono",
    });

    const android = resolveAppearance(preferences, "android");
    expect(android.uiFontId).toBe("condensed");
    expect(android.uiFont.regular).toBe("sans-serif-condensed");
    expect(android.codeFontId).toBeNull();
    expect(android.codeFontFamily).toBeNull();
    expect(android.terminalFontFamily).toBe("serif-monospace");

    const ios = resolveAppearance(preferences, "ios");
    expect(ios.uiFontId).toBeNull();
    expect(ios.uiFont).toBe(FONT_FAMILIES);
    expect(ios.codeFontFamily).toBe("Menlo");
    expect(ios.terminalFontFamily).toBeNull();
  });
});
