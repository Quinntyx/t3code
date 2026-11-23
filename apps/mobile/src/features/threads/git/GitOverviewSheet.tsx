import type { ThreadRepositorySection } from "@t3tools/client-runtime/state/thread-repositories";
import { changeRequestTermKind } from "../../../lib/changeRequestTerm";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useEffect } from "react";
import { RefreshControl } from "../../../components/ui/RefreshControl";
import { NativeScrollView } from "../../../native/NativeScrollViewMarker";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBar } from "../../../components/ui/AppBar";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { groupedListInsets } from "../../../components/ui/listMetrics";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { SheetPane } from "../../../components/ui/SheetPane";
import { AppText as Text } from "../../../components/ui/AppText";
import {
  gitRepositoryTargetFromRoute,
  type GitRepositoryRouteParams,
} from "../../../state/thread-git-target";
import { menuItemIconName } from "./gitSheetComponents";
import { ThreadRepositoryRows } from "./ThreadRepositoryRows";
import { LinkedPullRequestRow, linkedPullRequestKey } from "../LinkedPullRequestList";
import { useGitOverview } from "./useGitOverview";

type GitOverviewSheetProps = StaticScreenProps<
  {
    readonly environmentId: string;
    readonly threadId: string;
  } & GitRepositoryRouteParams
> & {
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
  const git = useGitOverview({
    environmentId: props.route.params.environmentId,
    threadId: props.route.params.threadId,
    presentation,
    repository: gitRepositoryTargetFromRoute(props.route.params),
  });
  const { linkedPrActions } = git;

  const openRepository = (section: ThreadRepositorySection) => git.openRepository(section);

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
      {git.sheetMenuItems.length > 0 || git.behindCount > 0 ? (
        <ListSection>
          {git.sheetMenuItems.map(({ item, disabledReason }) => (
            <ListRow
              key={`${item.id}-${item.label}`}
              icon={menuItemIconName(item.icon)}
              label={item.label}
              description={disabledReason ?? git.rowStatusDetail(item)}
              disabled={item.disabled}
              onPress={() => void git.onPressMenuItem(item)}
            />
          ))}
          {git.behindCount > 0 ? (
            <ListRow
              icon="arrow.down.circle"
              label={gt("Pull latest")}
              description={
                git.canWriteSourceControl
                  ? gt(
                      "{count, plural, one {{count} commit behind upstream} other {{count} commits behind upstream}}",
                      { count: git.behindCount },
                    )
                  : gt("This connection cannot change source control.")
              }
              disabled={!git.canWriteSourceControl || git.busy || !git.isRepo}
              onPress={git.pull}
            />
          ) : null}
        </ListSection>
      ) : null}

      {git.listsRepositories && git.projectId !== null ? (
        <ThreadRepositoryRows
          threadRef={git.threadRef}
          projectId={git.projectId}
          threadCwd={git.selectedThreadCwd}
          taskFolder={git.taskFolder}
          reachesTracked={git.reachesTracked}
          onTaskFolderChange={git.refreshTaskFolder}
          explainsEmpty={!git.isRepo}
          onOpen={openRepository}
        />
      ) : null}

      {git.repository === undefined || git.isPinnedRepository ? (
        <ListSection>
          {git.repository === undefined ? (
            <>
              <ListRow
                icon="text.bubble"
                label={gt("Review changes")}
                description={
                  git.trackedRepositoryCount > 0
                    ? gt("Inspect turn diffs")
                    : gt("Inspect changes, uncommitted edits, and turn diffs")
                }
                disabled={git.busy || !(git.isRepo || git.trackedRepositoryCount > 0)}
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
                disabled={git.busy || !git.isRepo}
                onPress={git.openBranches}
              />
              {linkedPrActions.canLink ? (
                <ListRow
                  icon="link"
                  label={gt(
                    "{term, select, mr {Link merge request} cr {Link change request} other {Link pull request}}",
                    { term: changeRequestTermKind(linkedPrActions.terminology) },
                  )}
                  description={gt(
                    "{term, select, mr {Attach a merge request by URL or number} cr {Attach a change request by URL or number} other {Attach a pull request by URL or number}}",
                    { term: changeRequestTermKind(linkedPrActions.terminology) },
                  )}
                  onPress={linkedPrActions.promptLink}
                />
              ) : null}
            </>
          ) : git.isPinnedRepository ? (
            <ListRow
              icon="pin.slash"
              label={gt("Remove from this thread")}
              description={gt("The repository stays tracked by the project")}
              disabled={git.busy}
              onPress={git.unpinRepository}
            />
          ) : null}
        </ListSection>
      ) : null}

      {git.repository === undefined && git.linkedPrLines.length > 0 ? (
        <ListSection title={gt("Linked {terms}", { terms: linkedPrActions.terminology.plural })}>
          {git.linkedPrLines.map((line, index) => (
            <LinkedPullRequestRow
              key={linkedPullRequestKey(line)}
              line={line}
              separator={index < git.linkedPrLines.length - 1}
              surfaceClassName="text-grouped-card"
              openPullRequest={git.openPullRequest}
              actions={linkedPrActions}
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

  const refresh = {
    accessibilityLabel: gt("Refresh repository status"),
    disabled: git.busy || git.isRefreshing,
    onPress: () => void git.refresh(),
  };

  return (
    <SheetPane surface={isInspector ? "screen" : "sheet"}>
      <AppBar
        title={git.currentBranchLabel}
        subtitle={git.currentStatusSummary}
        hideBottomBorder={!isInspector}
        onClose={isInspector ? undefined : () => navigation.goBack()}
        refresh={refresh}
      />
      <ScreenContent insetHorizontal={isInspector ? true : undefined}>{content}</ScreenContent>
    </SheetPane>
  );
}
