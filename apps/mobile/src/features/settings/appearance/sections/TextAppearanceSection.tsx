import { useGT } from "gt-react-native";
import { Platform } from "react-native";

import {
  BASE_FONT_SIZE_STEP,
  MAX_BASE_FONT_SIZE,
  MIN_BASE_FONT_SIZE,
} from "../../../../lib/appearancePreferences";
import { defaultFontLabel, uiFontChoices } from "../../../../lib/fontFamilies";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import {
  AppearancePreviewSeparator,
  TextAppearancePreview,
} from "../components/AppearancePreviews";
import { FontFamilyMenuRow } from "../components/FontFamilyMenuRow";
import { FontSizeSliderRow } from "../components/FontSizeSliderRow";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

export function TextAppearanceSection() {
  const gt = useGT();
  const {
    isReady,
    appearance,
    setBaseFontSize,
    setUiFontId,
    mathRenderingEnabled,
    setMathRenderingEnabled,
  } = useAppearancePreferences();

  return (
    <SettingsSection title={gt("Text", { $context: "settings section for text size" })}>
      <TextAppearancePreview fontSize={appearance.baseFontSize} />
      <AppearancePreviewSeparator />
      <FontFamilyMenuRow
        disabled={!isReady}
        label={gt("Font", { $context: "settings row for font family" })}
        defaultLabel={defaultFontLabel("ui", Platform.OS)}
        choices={uiFontChoices(Platform.OS)}
        selectedId={appearance.uiFontId}
        onSelect={setUiFontId}
      />
      <FontSizeSliderRow
        disabled={!isReady}
        icon="textformat.size"
        label={gt("Text size")}
        max={MAX_BASE_FONT_SIZE}
        min={MIN_BASE_FONT_SIZE}
        onChange={setBaseFontSize}
        step={BASE_FONT_SIZE_STEP}
        value={appearance.baseFontSize}
        valueLabel={gt("{size} pt", { size: appearance.baseFontSize })}
      />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="plusminus"
        label={gt("Render math")}
        value={mathRenderingEnabled}
        onValueChange={setMathRenderingEnabled}
      />
    </SettingsSection>
  );
}
