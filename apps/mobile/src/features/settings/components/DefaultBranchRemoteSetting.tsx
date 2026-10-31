import type { ServerSettingsPatch } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SettingsSection } from "./SettingsSection";

export function DefaultBranchRemoteSetting(props: {
  value: string | null;
  disabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  // Save on exit too: Android Back hides the keyboard without ending editing.
  const draft = useRef<{ text: string; over: string | null } | null>(null);
  const save = () => {
    const current = draft.current;
    draft.current = null;
    // Drop a draft typed over an older saved value: the updated value has already remounted the input.
    if (current === null || current.over !== props.value) return;
    const value = current.text.trim();
    if (props.value === null || value !== props.value)
      props.onChange({ defaultBranchRemote: value });
  };
  const saveOnUnmount = useEffectEvent(save);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves an unsent default remote draft to server settings when the section unmounts
  useEffect(() => () => saveOnUnmount(), []);
  return (
    <SettingsSection title="Default remote">
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          Branch pickers list this remote's branches with your local ones. Branches on other remotes
          sit behind Other remotes. Falls back to origin when the project has no such remote.
        </Text>
        <AppTextInput
          key={props.value}
          accessibilityLabel="Default remote"
          onChangeText={(text) => {
            draft.current = { text, over: props.value };
          }}
          defaultValue={props.value ?? ""}
          placeholder={props.value === null ? "Mixed" : "origin"}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
          onEndEditing={save}
        />
      </View>
    </SettingsSection>
  );
}
