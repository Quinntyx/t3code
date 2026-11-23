import { describe, expect, it, vi } from "vite-plus/test";

import { FONT_FAMILIES, uiFontChoices } from "../lib/fontFamilies";

// app.config.ts reads the repo env; the font registration under test does not.
vi.mock("../../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));
vi.stubEnv("APP_VARIANT", "development");

interface AndroidFontFamily {
  readonly fontFamily: string;
  readonly fontDefinitions: ReadonlyArray<{ readonly weight: number }>;
}

type ExpoFontPlugin = [
  "expo-font",
  { readonly android?: { readonly fonts?: ReadonlyArray<AndroidFontFamily> } },
];

const isExpoFontPlugin = (plugin: unknown): plugin is ExpoFontPlugin =>
  Array.isArray(plugin) && plugin[0] === "expo-font";

async function androidFontWeights() {
  const config = (await import("../../app.config.ts")).default;
  const plugin = config.plugins?.find(isExpoFontPlugin);
  return new Map(
    (plugin?.[1].android?.fonts ?? []).map((font) => [
      font.fontFamily,
      new Set(font.fontDefinitions.map((definition) => definition.weight)),
    ]),
  );
}

describe("Android bold font registration", () => {
  it("registers both weights for every non-weight-bold family that ships a Bold face", async () => {
    const weights = await androidFontWeights();
    const boldFamilies = [FONT_FAMILIES, ...uiFontChoices("android").map((choice) => choice.value)]
      .filter((font) => !font.boldByWeight && font.bold.endsWith("-Bold"))
      .map((font) => font.bold);

    expect(boldFamilies.length).toBeGreaterThan(0);
    for (const family of boldFamilies) {
      expect(weights.get(family), `${family} missing from expo-font's Android fonts`).toEqual(
        new Set([400, 700]),
      );
    }
  });
});
