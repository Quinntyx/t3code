import { Pressable, View } from "react-native";
import { useGT } from "gt-react-native";

import { AppText as Text } from "../../components/ui/AppText";

export interface ScratchArmedBarProps {
  readonly title: string;
  readonly imageCount: number;
  readonly sending: boolean;
  readonly disabled: boolean;
  readonly onRelease: () => void;
  readonly onSend: () => void;
}

/**
 * Replaces the composer input while a scratch chunk is armed, keeping draft controls and the
 * send button in the same docked bottom bar.
 */
export function ScratchArmedBar(props: ScratchArmedBarProps) {
  const gt = useGT();
  const sendDisabled = props.disabled || props.sending;
  return (
    <View
      className="flex-row items-center gap-2 rounded-2xl border border-border bg-card px-2.5 py-2"
      testID="scratch-armed-bar"
    >
      <View className="h-7 w-[3px] rounded-full bg-primary" />
      <View className="min-w-0 flex-1">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.imageCount > 0 ? (
          <Text className="text-[11px] text-foreground-muted">
            {gt("{count, plural, one {# image} other {# images}}", { count: props.imageCount })}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityLabel={gt("Release selection")}
        accessibilityRole="button"
        className="h-9 w-9 items-center justify-center rounded-full bg-secondary active:opacity-65"
        hitSlop={6}
        onPress={props.onRelease}
      >
        <Text className="text-sm text-foreground">×</Text>
      </Pressable>
      <Pressable
        accessibilityLabel={gt("Send selection")}
        accessibilityRole="button"
        accessibilityState={{ disabled: sendDisabled, busy: props.sending }}
        className="h-9 w-9 items-center justify-center rounded-full bg-primary active:opacity-65"
        disabled={sendDisabled}
        hitSlop={6}
        onPress={props.onSend}
        style={{ opacity: sendDisabled ? 0.4 : 1 }}
      >
        <Text className="text-base text-primary-foreground">↑</Text>
      </Pressable>
    </View>
  );
}
