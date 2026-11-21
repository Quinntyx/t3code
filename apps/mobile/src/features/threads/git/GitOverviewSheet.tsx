import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useEffect } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../../components/ui/AppBar";
import { AppText as Text } from "../../../components/ui/AppText";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { groupedListInsets } from "../../../components/ui/listMetrics";
import { RefreshControl } from "../../../components/ui/RefreshControl";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { SheetPane } from "../../../components/ui/SheetPane";
import { changeRequestTermKind } from "../../../lib/changeRequestTerm";
import { NativeScrollView } from "../../../native/NativeScrollViewMarker";
import { LinkedPullRequestRow, linkedPullRequestKey } from "../LinkedPullRequestList";
import { menuItemIconName } from "./gitSheetComponents";
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
  const gt = useGT();
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
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        ...groupedListInsets(isInspector),
        paddingTop: 8,
        paddingBottom: Math.max(insets.bottom, 18) + 18,
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
            label={gt("Pull latest")}
            description={
              git.canWriteSourceControl
                ? gt(
                    "{count, plural, one {{count} commit behind upstream} other {{count} commits behind upstream}}",
                    { count: behindCount },
                  )
                : gt("This connection cannot change source control.")
            }
            disabled={!git.canWriteSourceControl || busy || !isRepo}
            onPress={git.pull}
          />
        ) : null}
        <ListRow
          icon="text.bubble"
          label={gt("Review changes")}
          description={gt("Inspect changes, uncommitted edits, and turn diffs")}
          disabled={busy || !isRepo}
          onPress={git.openReview}
        />
        <ListRow
          icon="point.topleft.down.curvedto.point.bottomright.up"
          label={gt("Branches & worktrees")}
          description={
            git.canChangeThreadBranch
              ? gt("Switch branch, create branch, or move to a worktree")
              : gt("View branches and worktrees")
          }
          disabled={busy || !isRepo}
          onPress={git.openBranches}
        />
        {git.linkedPrActions.canLink ? (
          <ListRow
            icon="link"
            label={gt(
              "{term, select, mr {Link merge request} cr {Link change request} other {Link pull request}}",
              {
                term: changeRequestTermKind(git.linkedPrActions.terminology),
              },
            )}
            description={gt(
              "{term, select, mr {Attach a merge request by URL or number} cr {Attach a change request by URL or number} other {Attach a pull request by URL or number}}",
              {
                term: changeRequestTermKind(git.linkedPrActions.terminology),
              },
            )}
            onPress={git.linkedPrActions.promptLink}
          />
        ) : null}
      </ListSection>

      {git.linkedPrLines.length > 0 ? (
        <ListSection
          title={gt("Linked {terms}", { terms: git.linkedPrActions.terminology.plural })}
        >
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
        <ListSection title={gt("Worktree")}>
          <Text selectable textRole="footnote" className="p-4 text-foreground-muted">
            {git.worktreePath}
          </Text>
        </ListSection>
      ) : null}
    </NativeScrollView>
  );

  return (
    <SheetPane surface={isInspector ? "screen" : "sheet"}>
      <AppBar
        title={git.currentBranchLabel}
        subtitle={git.currentStatusSummary}
        hideBottomBorder={!isInspector}
        onClose={isInspector ? undefined : () => navigation.goBack()}
        refresh={{
          accessibilityLabel: gt("Refresh repository status"),
          disabled: busy || git.isRefreshing,
          onPress: () => void git.refresh(),
        }}
      />
      <ScreenContent insetHorizontal={isInspector ? true : undefined}>{content}</ScreenContent>
    </SheetPane>
  );
}
