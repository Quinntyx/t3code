import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { disconnectVoice, reloadVoice, voiceKey, voicePreferences } from "../voice/controller";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

const KEY_STORE = Platform.OS === "ios" ? "the iOS Keychain" : "the Android Keystore";

export function SettingsVoiceRouteScreen() {
  const insets = useSafeAreaInsets();
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState(voicePreferences.model.read);
  const [status, setStatus] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads whether the OS keystore already holds this device's key
  useEffect(() => {
    let active = true;
    voiceKey.read().then(
      (value) => active && setSaved(value !== null),
      () => active && setSaved(false),
    );
    return () => {
      active = false;
    };
  }, []);

  const saveKey = async (value: string) => {
    setSaving(true);
    try {
      disconnectVoice();
      await voiceKey.write(value);
      setKey("");
      setSaved(value.trim().length > 0);
      await reloadVoice();
      setStatus(value.trim() ? "Key saved on this device." : "Key removed. Voice is off.");
    } catch {
      setStatus("Couldn't save the key on this device.");
    } finally {
      setSaving(false);
    }
  };
  const saveModel = () => {
    voicePreferences.model.write(model);
    setModel(voicePreferences.model.read());
    setStatus("Model saved. Used on the next connection.");
  };

  const content = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      <SettingsSection
        title="Gemini API key"
        footer={`Stored only on this device, in ${KEY_STORE}. It never reaches a T3 server; Gemini receives the conversation and tool results directly. Talking to Voice may incur Gemini charges.`}
      >
        <View className="px-4 py-3">
          <TextInput
            accessibilityLabel="Gemini API key"
            placeholder={saved ? "Saved. Enter a new key to replace it." : "Gemini API key"}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            value={key}
            onChangeText={setKey}
            className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
          />
        </View>
        <SettingsActionRow
          icon="checkmark"
          label="Save key"
          disabled={!key.trim()}
          loading={saving}
          onPress={() => void saveKey(key)}
        />
        {saved ? (
          <SettingsActionRow
            icon="trash"
            label="Remove key"
            tone="danger"
            disabled={saving}
            onPress={() => void saveKey("")}
          />
        ) : null}
      </SettingsSection>
      <SettingsSection
        title="Live model"
        footer="Used on the next connection. Clear it to restore the default native-audio model."
      >
        <View className="px-4 py-3">
          <TextInput
            accessibilityLabel="Live model"
            autoCapitalize="none"
            autoCorrect={false}
            value={model}
            onChangeText={setModel}
            onEndEditing={saveModel}
            className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
          />
        </View>
      </SettingsSection>
      {status ? (
        <Text accessibilityLiveRegion="polite" className="px-2 text-sm text-foreground-muted">
          {status}
        </Text>
      ) : null}
    </ScrollView>
  );

  return Platform.OS === "android" ? (
    <SettingsScreen title="Voice">{content}</SettingsScreen>
  ) : (
    <View collapsable={false} className="flex-1 bg-sheet">
      {content}
    </View>
  );
}
