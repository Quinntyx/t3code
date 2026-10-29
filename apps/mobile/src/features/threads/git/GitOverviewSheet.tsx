import { SheetHeader } from "../../../components/ui/SheetHeader";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { useEffect } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeInspectorContent } from "../../../native/NativeInspectorContent";
import { NativeHeader, NativeScreen } from "../../../native/ThemedScreenStack";
import {
  AndroidHeaderIconButton,
  AndroidSheetHeader,
} from "../../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../../components/ui/AndroidAnchoredMenu";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { useAdaptiveWorkspaceLayout } from "../../layout/AdaptiveWorkspaceLayout";
import { AppText as Text } from "../../../components/ui/AppText";
import {
  NativeStackScreenOptions,
  nativeHeaderScrollEdgeEffects,
} from "../../../native/StackHeader";
import { menuItemIconName } from "./gitSheetComponents";
import { LinkedPullRequestRow, linkedPullRequestKey } from "../LinkedPullRequestList";
import { useGitOverview } from "./useGitOverview";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type GitOverviewSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}> & {
  readonly headerInset?: number;
  readonly presentation?: "sheet" | "inspector";
};

export function GitOverviewSheet(props: GitOverviewSheetProps) {
  const navigation = useNavigation();
  const { environmentId, threadId } = props.route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator when the route link names a blank environment or thread
  useEffect(() => {
    if (isBlankLink) navigation.goBack();
  }, [isBlankLink, navigation]);
  if (isBlankLink) return null;
  return <GitOverviewSheetContent {...props} />;
}

function GitOverviewSheetContent(props: GitOverviewSheetProps) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const presentation = props.presentation ?? "sheet";
  const isInspector = presentation === "inspector";
  const { environmentId, threadId } = props.route.params;
  const git = useGitOverview({ environmentId, threadId, presentation });
  const { currentBranchLabel, currentStatusSummary, busy, isRepo, behindCount } = git;
  const handleRefresh = git.refresh;

  const sections = (
    <>
      <ListSection>
        {git.menuItems.map(({ item, disabledReason, statusDetail }) => (
          <ListRow
            key={`${item.id}-${item.label}`}
            icon={menuItemIconName(item.icon)}
            label={item.label}
            description={disabledReason ?? statusDetail}
            disabled={item.disabled}
            onPress={() => void git.onPressMenuItem(item)}
          />
        ))}
        {behindCount > 0 ? (
          <ListRow
            icon="arrow.down.circle"
            label="Pull latest"
            description={
              git.canWriteSourceControl
                ? `${behindCount} commit${behindCount === 1 ? "" : "s"} behind upstream`
                : "This connection cannot change source control."
            }
            disabled={!git.canWriteSourceControl || busy || !isRepo}
            onPress={git.pull}
          />
        ) : null}
        <ListRow
          icon="text.bubble"
          label="Review changes"
          description="Inspect changes, uncommitted edits, and turn diffs"
          disabled={busy || !isRepo}
          onPress={git.openReview}
        />
        <ListRow
          icon="point.topleft.down.curvedto.point.bottomright.up"
          label="Branches & worktrees"
          description={
            git.canChangeThreadBranch
              ? "Switch branch, create branch, or move to a worktree"
              : "View branches and worktrees"
          }
          disabled={busy || !isRepo}
          onPress={() => navigation.navigate("GitBranches", { environmentId, threadId })}
        />
        {git.linkedPrActions.canLink ? (
          <ListRow
            icon="link"
            label={`Link ${git.linkedPrActions.terminology.singular}`}
            description={`Attach a ${git.linkedPrActions.terminology.singular} by URL or number`}
            onPress={git.linkedPrActions.promptLink}
          />
        ) : null}
      </ListSection>

      {git.linkedPrLines.length > 0 ? (
        <ListSection title={`Linked ${git.linkedPrActions.terminology.plural}`}>
          {git.linkedPrLines.map((line, index) => (
            <LinkedPullRequestRow
              key={linkedPullRequestKey(line)}
              line={line}
              separator={index < git.linkedPrLines.length - 1}
              surfaceClassName="text-grouped-card"
              openPullRequest={git.openLinkedPullRequest}
              actions={git.linkedPrActions}
            />
          ))}
        </ListSection>
      ) : null}

      {git.worktreePath ? (
        <ListSection title="Worktree">
          <Text selectable textRole="footnote" className="p-4 text-foreground-muted">
            {git.worktreePath}
          </Text>
        </ListSection>
      ) : null}
    </>
  );

  const content = (
    <ScrollView
      nestedScrollEnabled
      alwaysBounceVertical
      className="flex-1 android:bg-sheet-solid ios:bg-screen"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      showsVerticalScrollIndicator={false}
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentContainerStyle={{
        paddingHorizontal: Platform.OS === "android" ? 8 : isInspector ? 12 : 20,
        paddingTop: 8,
        gap: Platform.OS === "android" ? 8 : 14,
      }}
      refreshControl={
        Platform.OS === "ios" || isInspector ? (
          <RefreshControl refreshing={git.isRefreshing} onRefresh={() => void handleRefresh()} />
        ) : undefined
      }
    >
      {sections}
    </ScrollView>
  );

  if (isInspector && Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 border-l border-border bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-git-inspector-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            <NativeInspectorContent>{content}</NativeInspectorContent>
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={currentBranchLabel}
              titleColorClassName="accent-foreground"
              titleFontSize={17}
              titleFontWeight="700"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader
          presentation="native"
          title={currentBranchLabel}
          subtitle={currentStatusSummary}
          onClose={() => navigation.goBack()}
        />
        {content}
      </View>
    );
  }

  const refreshMenu = (
    <AndroidAnchoredMenu
      title="Repository options"
      actions={[
        {
          id: "refresh",
          title: "Refresh repository status",
          attributes: { disabled: busy || git.isRefreshing },
        },
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "refresh") void handleRefresh();
      }}
    >
      {(open) => (
        <AndroidHeaderIconButton
          accessibilityLabel="Repository options"
          icon="ellipsis"
          onPress={open}
        />
      )}
    </AndroidAnchoredMenu>
  );

  return (
    <View
      collapsable={false}
      className={
        Platform.OS === "android"
          ? "flex-1 bg-header"
          : isInspector
            ? "flex-1 border-l border-border bg-sheet"
            : "flex-1 bg-sheet"
      }
    >
      {!isInspector ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: Platform.OS === "android" ? 28 : undefined }}
        />
      ) : null}
      {isInspector ? (
        <View
          style={{
            minHeight: props.headerInset ?? 0,
            paddingTop: props.headerInset ?? 0,
          }}
        />
      ) : null}

      {isInspector ? (
        <View className="gap-1 px-4 pb-4 pt-3 android:bg-header ios:border-b ios:border-border">
          {Platform.OS === "android" ? (
            <View className="absolute right-3 top-4 z-[1]">{refreshMenu}</View>
          ) : (
            <Pressable
              className={
                busy
                  ? "absolute right-3 top-4 z-[1] h-9 w-9 items-center justify-center rounded-full bg-subtle opacity-[0.45]"
                  : "absolute right-3 top-4 z-[1] h-9 w-9 items-center justify-center rounded-full bg-subtle"
              }
              disabled={busy}
              onPress={() => void handleRefresh()}
            >
              <SymbolView
                name="arrow.clockwise"
                size={16}
                tintColorClassName="accent-icon"
                type="monochrome"
                weight="medium"
              />
            </Pressable>
          )}
          <Text className="text-xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
            Repository
          </Text>
          <Text className="pr-10 text-xl font-t3-bold">{currentBranchLabel}</Text>
          <Text className="text-foreground-secondary text-sm font-medium leading-normal">
            {currentStatusSummary}
          </Text>
        </View>
      ) : (
        <AndroidSheetHeader
          title={currentBranchLabel}
          hideBottomBorder={Platform.OS === "android"}
          subtitle={currentStatusSummary}
          onBack={() => navigation.goBack()}
          trailing={Platform.OS === "android" ? refreshMenu : undefined}
          actions={
            Platform.OS === "android"
              ? undefined
              : [
                  {
                    accessibilityLabel: "Refresh repository status",
                    disabled: busy,
                    icon: "arrow.clockwise",
                    onPress: () => void handleRefresh(),
                  },
                ]
          }
        />
      )}

      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}
