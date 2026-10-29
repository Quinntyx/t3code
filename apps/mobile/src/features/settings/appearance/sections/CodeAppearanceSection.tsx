import { Platform } from "react-native";

import {
  CODE_FONT_SIZE_STEP,
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
} from "../../../../lib/appearancePreferences";
import {
  codeFontChoices,
  defaultCodeFontFamily,
  defaultFontLabel,
} from "../../../../lib/fontFamilies";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import {
  AppearancePreviewSeparator,
  CodeAppearancePreview,
} from "../components/AppearancePreviews";
import { FontFamilyMenuRow } from "../components/FontFamilyMenuRow";
import { FontSizeSliderRow } from "../components/FontSizeSliderRow";

export function CodeAppearanceSection() {
  const { isReady, appearance, setCodeFontId, setCodeFontSize, setCodeWordBreak } =
    useAppearancePreferences();
  const custom = appearance.isCodeFontSizeCustom;

  const handleToggleCustom = (enabled: boolean) => {
    setCodeFontSize(enabled ? appearance.codeFontSize : null);
  };

  return (
    <SettingsSection title="Code & Diffs">
      <CodeAppearancePreview
        fontFamily={appearance.codeFontFamily ?? defaultCodeFontFamily(Platform.OS)}
        fontSize={appearance.codeFontSize}
        wordBreak={appearance.codeWordBreak}
      />
      <AppearancePreviewSeparator />
      <FontFamilyMenuRow
        disabled={!isReady}
        label="Font"
        defaultLabel={defaultFontLabel("code", Platform.OS)}
        choices={codeFontChoices(Platform.OS)}
        selectedId={appearance.codeFontId}
        onSelect={setCodeFontId}
      />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="chevron.left.forwardslash.chevron.right"
        label="Custom font size"
        onValueChange={handleToggleCustom}
        value={custom}
      />
      {custom ? (
        <FontSizeSliderRow
          disabled={!isReady}
          icon="textformat.size"
          label="Font size"
          max={MAX_CODE_FONT_SIZE}
          min={MIN_CODE_FONT_SIZE}
          onChange={setCodeFontSize}
          step={CODE_FONT_SIZE_STEP}
          value={appearance.codeFontSize}
          valueLabel={`${appearance.codeFontSize} pt`}
        />
      ) : null}
      <SettingsSwitchRow
        disabled={!isReady}
        icon="text.word.spacing"
        label="Word break"
        onValueChange={setCodeWordBreak}
        value={appearance.codeWordBreak}
      />
    </SettingsSection>
  );
}
