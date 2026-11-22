import { useAtomValue } from "@effect/atom-react";

import { subscribeAtomChanges } from "../rpc/atomRegistry";
import {
  environmentStyleDefinitionsAtom,
  environmentThemeDefinitionsAtom,
  storePublishedEnvironmentStyles,
  storePublishedEnvironmentThemes,
  type ThemeDefinition,
  type ThemeStyleDefinition,
} from "../themePalette";
import { refreshTheme } from "./useTheme";

export function useEnvironmentThemeDefinitions(): ReadonlyArray<ThemeDefinition> {
  return useAtomValue(environmentThemeDefinitionsAtom);
}

export function useEnvironmentStyleDefinitions(): ReadonlyArray<ThemeStyleDefinition> {
  return useAtomValue(environmentStyleDefinitionsAtom);
}

/**
 * The palette and style are painted from a snapshot taken when the theme last changed, so new
 * colors or styles only land if the active theme is re-applied.
 */
export function startEnvironmentThemeRepaint(): () => void {
  const unsubscribeThemes = subscribeAtomChanges(environmentThemeDefinitionsAtom, (definitions) => {
    storePublishedEnvironmentThemes(definitions);
    refreshTheme({ preservePreview: true });
  });
  const unsubscribeStyles = subscribeAtomChanges(environmentStyleDefinitionsAtom, (definitions) => {
    storePublishedEnvironmentStyles(definitions);
    refreshTheme({ preservePreview: true });
  });
  return () => {
    unsubscribeThemes();
    unsubscribeStyles();
  };
}
