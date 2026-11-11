import { useState } from "react";
import { View } from "react-native";

import { AppTextInput } from "./AppText";
import { SecretRevealButton } from "./SecretRevealButton";
import type { SecretTextInputProps } from "./SecretTextInput.types";

/** Masked field for a value that must stay out of password managers and suggestions. */
export function SecretTextInput(props: SecretTextInputProps) {
  const [revealed, setRevealed] = useState(false);
  return (
    <View className="justify-center">
      <AppTextInput
        accessibilityLabel={props.accessibilityLabel}
        className="pr-12"
        placeholder={props.placeholder}
        value={props.value}
        onChangeText={props.onChangeText}
        editable={props.editable}
        secureTextEntry={!revealed}
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        spellCheck={false}
        returnKeyType="done"
        onSubmitEditing={(event) => props.onSubmitEditing(event.nativeEvent.text)}
      />
      <View className="absolute inset-y-0 right-1.5 justify-center">
        <SecretRevealButton
          revealed={revealed}
          disabled={!props.editable}
          onPress={() => setRevealed((current) => !current)}
        />
      </View>
    </View>
  );
}
