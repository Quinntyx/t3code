import { useGT } from "gt-react-native";
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
  const gt = useGT();
  const { isReady, appearance, setTerminalFontId, setTerminalFontSize } =
    useAppearancePreferences();
  const custom = appearance.isTerminalFontSizeCustom;

  const handleToggleCustom = (enabled: boolean) => {
    setTerminalFontSize(enabled ? appearance.terminalFontSize : null);
  };

  return (
    <SettingsSection title={gt("Terminal", { $context: "settings section for the terminal" })}>
      <TerminalAppearancePreview
        fontFamily={appearance.terminalFontFamily}
        fontSize={appearance.terminalFontSize}
      />
      <AppearancePreviewSeparator />
      <FontFamilyMenuRow
        disabled={!isReady}
        label={gt("Font", { $context: "settings row for font family" })}
        defaultLabel={defaultFontLabel("terminal", Platform.OS)}
        choices={terminalFontChoices(Platform.OS)}
        selectedId={appearance.terminalFontId}
        onSelect={setTerminalFontId}
      />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="terminal"
        label={gt("Custom font size")}
        onValueChange={handleToggleCustom}
        value={custom}
      />
      {custom ? (
        <FontSizeSliderRow
          disabled={!isReady}
          icon="textformat.size"
          label={gt("Font size")}
          max={MAX_TERMINAL_FONT_SIZE}
          min={MIN_TERMINAL_FONT_SIZE}
          onChange={setTerminalFontSize}
          step={TERMINAL_FONT_SIZE_STEP}
          value={appearance.terminalFontSize}
          valueLabel={gt("{size} pt", { size: appearance.terminalFontSize.toFixed(1) })}
        />
      ) : null}
    </SettingsSection>
  );
}
