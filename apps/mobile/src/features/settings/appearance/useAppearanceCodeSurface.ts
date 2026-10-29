import { useMemo } from "react";
import { Platform } from "react-native";

import {
  resolveMobileCodeSurface,
  type ResolvedMobileCodeSurface,
} from "../../../lib/appearancePreferences";
import { defaultCodeFontFamily } from "../../../lib/fontFamilies";
import { createNativeReviewDiffStyle } from "../../review/nativeReviewDiffAdapter";
import { createNativeSourceStyle } from "../../files/nativeSourceFileAdapter";
import { useAppearancePreferences } from "./AppearancePreferencesProvider";

export function useAppearanceCodeSurface(): {
  readonly codeSurface: ResolvedMobileCodeSurface;
  readonly codeWordBreak: boolean;
  readonly nativeSourceStyle: ReturnType<typeof createNativeSourceStyle>;
  readonly nativeReviewDiffStyle: ReturnType<typeof createNativeReviewDiffStyle>;
} {
  const { appearance } = useAppearancePreferences();
  const codeFontFamily = appearance.codeFontFamily ?? defaultCodeFontFamily(Platform.OS);
  const codeSurface = useMemo(
    () => resolveMobileCodeSurface(appearance.codeFontSize, codeFontFamily),
    [appearance.codeFontSize, codeFontFamily],
  );
  const nativeSourceStyle = useMemo(() => createNativeSourceStyle(codeSurface), [codeSurface]);
  const nativeReviewDiffStyle = useMemo(
    () => createNativeReviewDiffStyle(codeSurface, appearance.codeWordBreak),
    [appearance.codeWordBreak, codeSurface],
  );

  return {
    codeSurface,
    codeWordBreak: appearance.codeWordBreak,
    nativeSourceStyle,
    nativeReviewDiffStyle,
  };
}
