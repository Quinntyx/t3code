import { cn } from "../../../lib/cn";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect } from "react";
import { Platform, RefreshControl, View } from "react-native";
import { NativeScrollView } from "../../../native/NativeScrollViewMarker";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBar } from "../../../components/ui/AppBar";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { AppText as Text } from "../../../components/ui/AppText";
import { menuItemIconName } from "./gitSheetComponents";
import { LinkedPullRequestRow, linkedPullRequestKey } from "../LinkedPullRequestList";
import { useGitOverview } from "./useGitOverview";

type GitOverviewSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}> & {
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
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const presentation = props.presentation ?? "sheet";
  const isInspector = presentation === "inspector";
  const { environmentId, threadId } = props.route.params;
  const git = useGitOverview({ environmentId, threadId, presentation });
  const { busy, isRepo, behindCount } = git;

  const content = (
    <NativeScrollView
      nestedScrollEnabled
      alwaysBounceVertical
      className="flex-1 android:bg-sheet-solid ios:bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentContainerStyle={{
        paddingHorizontal: Platform.OS === "android" ? 8 : isInspector ? 12 : 20,
        paddingTop: 8,
        gap: Platform.OS === "android" ? 8 : 14,
      }}
      refreshControl={
        <RefreshControl refreshing={git.isRefreshing} onRefresh={() => void git.refresh()} />
      }
    >
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
          onPress={git.openBranches}
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
    </NativeScrollView>
  );

  return (
    <View
      collapsable={false}
      className={cn("flex-1 android:bg-header", isInspector ? "ios:bg-screen" : "ios:bg-sheet")}
    >
      <AppBar
        title={git.currentBranchLabel}
        subtitle={git.currentStatusSummary}
        hideBottomBorder={!isInspector}
        onClose={isInspector ? undefined : () => navigation.goBack()}
        refresh={{
          accessibilityLabel: "Refresh repository status",
          disabled: busy || git.isRefreshing,
          onPress: () => void git.refresh(),
        }}
      />
      <ScreenContent insetHorizontal={isInspector ? true : undefined}>{content}</ScreenContent>
    </View>
  );
}
