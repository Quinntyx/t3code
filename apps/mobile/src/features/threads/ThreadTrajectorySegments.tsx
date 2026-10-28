import { Pressable, View } from "react-native";
import type { AgentTrajectorySummary } from "@t3tools/client-runtime/work-log/trajectory-summary";

import { AppText as Text } from "../../components/ui/AppText";
import { alert } from "../../components/ui/Dialog";

export function ThreadTrajectorySegments({
  summary,
}: {
  readonly summary: AgentTrajectorySummary;
}) {
  return summary.map((segment) => (
    <View key={segment.kind} className="flex-row items-center gap-x-1">
      <Text accessible={false} className="text-sm text-foreground-muted">
        ·
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={segment.label}
        accessibilityHint="Show breakdown"
        onPress={() => alert(segment.title, segment.details.join("\n"))}
        className="min-h-11 justify-center px-1"
      >
        <Text className="font-t3-medium text-sm tabular-nums text-foreground-muted">
          {segment.label}
        </Text>
      </Pressable>
    </View>
  ));
}
