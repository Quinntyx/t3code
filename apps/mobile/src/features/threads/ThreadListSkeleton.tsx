import { useGT } from "gt-react-native";
import { Platform, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";

import { cn } from "../../lib/cn";
import {
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE,
  THREAD_LIST_V2_SIDEBAR_ROW_STYLE,
} from "./thread-list-v2-row-appearance";

interface SkeletonRowSpec {
  readonly id: string;
  readonly titleWidth: DimensionValue;
  readonly metaWidth: DimensionValue;
  readonly badgeWidth: number;
}

const HOME_SKELETON_ROWS: ReadonlyArray<SkeletonRowSpec> = [
  { id: "row-1", titleWidth: "74%", metaWidth: "42%", badgeWidth: 42 },
  { id: "row-2", titleWidth: "58%", metaWidth: "36%", badgeWidth: 34 },
  { id: "row-3", titleWidth: "82%", metaWidth: "48%", badgeWidth: 46 },
  { id: "row-4", titleWidth: "66%", metaWidth: "32%", badgeWidth: 30 },
  { id: "row-5", titleWidth: "78%", metaWidth: "44%", badgeWidth: 38 },
  { id: "row-6", titleWidth: "52%", metaWidth: "38%", badgeWidth: 34 },
  { id: "row-7", titleWidth: "70%", metaWidth: "40%", badgeWidth: 42 },
];

const SIDEBAR_SKELETON_ROWS = HOME_SKELETON_ROWS.slice(0, 6);

export function ThreadListSkeleton(props: {
  readonly variant: "home" | "sidebar";
  readonly style?: StyleProp<ViewStyle>;
}) {
  const gt = useGT();
  const sidebar = props.variant === "sidebar";
  const rows = sidebar ? SIDEBAR_SKELETON_ROWS : HOME_SKELETON_ROWS;
  const android = Platform.OS === "android";

  return (
    <View
      testID="thread-list-skeleton"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={gt("Loading threads…")}
      className="flex-1"
      style={props.style}
    >
      {rows.map((row) => (
        <View
          key={row.id}
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={
            android
              ? [
                  THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE,
                  sidebar ? THREAD_LIST_V2_SIDEBAR_ROW_STYLE : undefined,
                ]
              : sidebar
                ? THREAD_LIST_V2_SIDEBAR_ROW_STYLE
                : undefined
          }
          className={cn(
            !sidebar && THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
            !android && !sidebar && THREAD_LIST_V2_ROW_DIVIDERS && "border-b border-border-subtle",
          )}
        >
          <View className="flex-row items-center gap-2">
            <View className="size-4 rounded bg-subtle-strong" />
            <View className="flex-1">
              <View className="h-3.5 rounded bg-subtle-strong" style={{ width: row.titleWidth }} />
            </View>
            <View className="h-3 rounded bg-subtle-strong" style={{ width: row.badgeWidth }} />
          </View>
          <View className="mt-2.5 flex-row items-center gap-2 pl-6">
            <View className="h-2.5 rounded bg-subtle-strong" style={{ width: row.metaWidth }} />
          </View>
        </View>
      ))}
    </View>
  );
}
