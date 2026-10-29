import { Platform } from "react-native";

import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
} from "../../../../lib/appearancePreferences";
import { defaultFontLabel, terminalFontChoices } from "../../../../lib/fontFamilies";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import {
  AppearancePreviewSeparator,
  TerminalAppearancePreview,
} from "../components/AppearancePreviews";
import { FontFamilyMenuRow } from "../components/FontFamilyMenuRow";
import { FontSizeSliderRow } from "../components/FontSizeSliderRow";

export function TerminalAppearanceSection() {
  const { isReady, appearance, setTerminalFontId, setTerminalFontSize } =
    useAppearancePreferences();
  const custom = appearance.isTerminalFontSizeCustom;

  const handleToggleCustom = (enabled: boolean) => {
    setTerminalFontSize(enabled ? appearance.terminalFontSize : null);
  };

  return (
    <SettingsSection title="Terminal">
      <TerminalAppearancePreview
        fontFamily={appearance.terminalFontFamily}
        fontSize={appearance.terminalFontSize}
      />
      <AppearancePreviewSeparator />
      <FontFamilyMenuRow
        disabled={!isReady}
        label="Font"
        defaultLabel={defaultFontLabel("terminal", Platform.OS)}
        choices={terminalFontChoices(Platform.OS)}
        selectedId={appearance.terminalFontId}
        onSelect={setTerminalFontId}
      />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="terminal"
        label="Custom font size"
        onValueChange={handleToggleCustom}
        value={custom}
      />
      {custom ? (
        <FontSizeSliderRow
          disabled={!isReady}
          icon="textformat.size"
          label="Font size"
          max={MAX_TERMINAL_FONT_SIZE}
          min={MIN_TERMINAL_FONT_SIZE}
          onChange={setTerminalFontSize}
          step={TERMINAL_FONT_SIZE_STEP}
          value={appearance.terminalFontSize}
          valueLabel={`${appearance.terminalFontSize.toFixed(1)} pt`}
        />
      ) : null}
    </SettingsSection>
  );
}
