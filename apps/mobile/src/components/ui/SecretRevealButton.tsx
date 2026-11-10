import { Pressable } from "react-native";

import { SymbolView } from "./AppSymbol";

export function SecretRevealButton(props: {
  readonly revealed: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.revealed ? "Hide secret" : "Show secret"}
      accessibilityState={{ disabled: props.disabled, selected: props.revealed }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="size-10 items-center justify-center rounded-full active:opacity-70"
    >
      <SymbolView
        name={props.revealed ? "eye.slash" : "eye"}
        size={18}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
    </Pressable>
  );
}
