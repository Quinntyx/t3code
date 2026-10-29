import { resolveTextScaleVariables } from "./appearancePreferences";
import type { UiFontFaces } from "./fontFamilies";
import { BUILT_IN_THEME_IDS, type BuiltInThemeId } from "@t3tools/shared/themePalettes";
import {
  DEFAULT_MOBILE_THEME_ID,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeMode,
} from "./mobileTheme";

export type MobileUniwindThemeName =
  | MobileThemeAppearance
  | `${BuiltInThemeId}-${MobileThemeAppearance}`;

export interface MobileThemeRuntimeState {
  readonly baseFontSize: number;
  readonly uiFont: UiFontFaces;
  readonly monoFontFamily: string;
  readonly themeAppearance: MobileThemeAppearance;
  readonly themeMode: MobileThemeMode;
}

export type MobileThemeRuntimeOperation =
  | {
      readonly kind: "update-css-variables";
      readonly themeName: "light" | "dark" | MobileUniwindThemeName;
      readonly variables: Readonly<Record<string, number | string>>;
    }
  | {
      readonly kind: "set-appearance-mode";
      readonly appearance: MobileThemeAppearance;
      readonly themeMode: MobileThemeMode;
    };

const UNIWIND_THEME_NAMES: ReadonlyArray<"light" | "dark" | MobileUniwindThemeName> = [
  "light",
  "dark",
  ...BUILT_IN_THEME_IDS.flatMap((themeId) => [
    `${themeId}-light` as const,
    `${themeId}-dark` as const,
  ]),
];

export function getMobileUniwindThemeName(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): MobileUniwindThemeName {
  return themeId === DEFAULT_MOBILE_THEME_ID || themeId === "material-you"
    ? appearance
    : `${themeId}-${appearance}`;
}

export function createMobileThemeRuntimeOperations(
  previous: MobileThemeRuntimeState | null,
  next: MobileThemeRuntimeState,
): ReadonlyArray<MobileThemeRuntimeOperation> {
  const operations: MobileThemeRuntimeOperation[] = [];

  if (previous === null || previous.baseFontSize !== next.baseFontSize) {
    const variables = resolveTextScaleVariables(next.baseFontSize);
    for (const themeName of UNIWIND_THEME_NAMES) {
      operations.push({ kind: "update-css-variables", themeName, variables });
    }
  }

  if (
    previous === null ||
    previous.uiFont !== next.uiFont ||
    previous.monoFontFamily !== next.monoFontFamily
  ) {
    const variables = {
      "--font-sans": next.uiFont.regular,
      "--font-medium": next.uiFont.medium,
      "--font-bold": next.uiFont.bold,
      "--font-mono": next.monoFontFamily,
    };
    for (const themeName of UNIWIND_THEME_NAMES) {
      operations.push({ kind: "update-css-variables", themeName, variables });
    }
  }

  if (previous === null || previous.themeMode !== next.themeMode) {
    operations.push({
      kind: "set-appearance-mode",
      appearance: next.themeAppearance,
      themeMode: next.themeMode,
    });
  }

  return operations;
}
