import { useNavigation } from "@react-navigation/native";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AuthFilesystemReadScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { use, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { FloatingHeaderButtonBackdrop } from "../../components/ui/FloatingHeaderButtonBackdrop";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { cn } from "../../lib/cn";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { InspectorSheetContext } from "../layout/workspace-inspector-sheet";
import { getTerminalStatusLabel } from "../terminal/terminalMenu";
import { GitBranchesContent } from "./git/GitBranchesSheet";
import { ThreadRepositoryRows } from "./git/ThreadRepositoryRows";
import { useGitOverview, type GitOverview } from "./git/useGitOverview";
import { PullRequestDiffStats } from "../pull-requests/PullRequestPresentation";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useEnvironmentScope } from "../../state/session";
import {
  useRemoteEnvironmentRuntime,
  useSavedRemoteConnection,
} from "../../state/use-remote-environment-registry";
import { LinkedPullRequestRow, linkedPullRequestKey } from "./LinkedPullRequestList";
import { ThreadProjectActions } from "./ThreadProjectActions";
import type { ThreadGitControlsProps } from "./ThreadGitControls";
import { ThreadListDrawerHost, threadListDrawerWidth } from "./thread-list-drawer";

const CONNECTION_STATE_LABELS: Record<EnvironmentConnectionPhase, string> = {
  available: msg("Available", { $context: "environment connection status" }),
  offline: msg("Offline", { $context: "environment connection status" }),
  connecting: msg("Connecting", { $context: "environment connection status" }),
  reconnecting: msg("Reconnecting", { $context: "environment connection status" }),
  connected: msg("Connected", { $context: "environment connection status" }),
  error: msg("Error", { $context: "environment connection status" }),
  unsupported: msg("Unsupported", { $context: "environment connection status" }),
};

interface DetailsProps {
  readonly title: string;
  readonly project: EnvironmentProject | null;
  readonly cwd: string | null;
  readonly worktreePath: string | null;
  readonly gitControls: ThreadGitControlsProps;
  readonly onCloseThread: () => void;
  readonly onReturnToThread?: (() => void) | undefined;
}

/** Compact windows: the details slide in from the right edge over the thread. */
export function ThreadDetailsDrawer(props: DetailsProps) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const { width } = useWindowDimensions();
  return (
    <ThreadListDrawerHost side="right" width={threadListDrawerWidth(layout.listPaneWidth, width)}>
      {(drawer) => <ThreadDetailsDrawerPanel {...props} onClose={drawer.closeDrawer} />}
    </ThreadListDrawerHost>
  );
}

function ThreadDetailsDrawerPanel(props: DetailsProps & { readonly onClose: () => void }) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  return (
    <View
      className="flex-1 bg-header"
      style={{ paddingTop: Platform.OS === "android" ? insets.top : 0 }}
    >
      <View className="flex-row items-center justify-between gap-3 px-5 py-4">
        <View className="min-w-0 flex-1 gap-1">
          <Text textRole="title" className="font-t3-bold">
            <T>Thread details</T>
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
            {props.title}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Close thread details")}
          onPress={props.onClose}
          className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle"
        >
          {Platform.OS === "android" ? <FloatingHeaderButtonBackdrop /> : null}
          <SymbolView name="xmark" size={20} tintColorClassName="accent-header-foreground" />
        </Pressable>
      </View>
      <ThreadDetailsBody {...props} presentation="drawer" onLeave={props.onClose} />
    </View>
  );
}

/** Split windows: the same details as an inspector pane, in its column or sheet. */
export function ThreadDetailsInspectorPane(props: DetailsProps) {
  const gt = useGT();
  return (
    <View collapsable={false} className="flex-1 android:bg-header ios:bg-screen">
      <AppBar title={gt("Thread details")} subtitle={props.title} />
      <ScreenContent insetHorizontal>
        <ThreadDetailsBody {...props} presentation="inspector" />
      </ScreenContent>
    </View>
  );
}

type BodyProps = DetailsProps & {
  readonly presentation: "drawer" | "inspector";
  /** Closes the host before the details hand off to another surface. */
  readonly onLeave?: () => void;
};

// Read-only facts sit at the top; the actions people reach for most sit in a dock under the thumb.
function ThreadDetailsBody(props: BodyProps) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const closeInspectorSheet = use(InspectorSheetContext);
  const controls = props.gitControls;
  const hasThread = controls.hasThread !== false;
  const git = useGitOverview({
    environmentId: String(controls.environmentId),
    threadId: String(controls.threadId),
    presentation: props.presentation,
    onNavigate: props.onLeave,
  });
  // A route presented over the inspector sheet would race its dismissal, so the sheet goes first.
  const navigate = (action: () => void) => {
    props.onLeave?.();
    if (closeInspectorSheet) closeInspectorSheet(action);
    else action();
  };
  // A thread's files are another inspector pane, shown in place; a draft's are a route.
  const openFiles = () => {
    const open = () => controls.onOpenFilesInspector?.();
    if (!hasThread) {
      navigate(open);
      return;
    }
    props.onLeave?.();
    open();
  };
  // The pane's scroll view registers with its own bar; the drawer's must not take the thread's.
  const Scroll = props.presentation === "inspector" ? NativeScrollView : ScrollView;
  return (
    <View className="flex-1">
      <Scroll
        className="flex-1"
        contentInsetAdjustmentBehavior={props.presentation === "inspector" ? "automatic" : "never"}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 20, gap: 20 }}
        refreshControl={
          hasThread ? (
            <RefreshControl refreshing={git.isRefreshing} onRefresh={() => void git.refresh()} />
          ) : undefined
        }
      >
        {hasThread ? (
          <ListSection>
            <ListRow
              icon="doc.text"
              label={gt("Notebook")}
              description={gt("Read-only cells and outputs")}
              onPress={() =>
                navigate(() =>
                  navigation.navigate("ThreadNotebook", {
                    environmentId: EnvironmentId.make(String(controls.environmentId)),
                    threadId: ThreadId.make(String(controls.threadId)),
                  }),
                )
              }
            />
          </ListSection>
        ) : null}

        <WorkspaceSummary {...props} git={git} hasThread={hasThread} />

        {hasThread && git.listsRepositories && git.projectId !== null ? (
          <ThreadRepositoryRows
            threadRef={git.threadRef}
            projectId={git.projectId}
            threadCwd={git.selectedThreadCwd}
            taskFolder={git.taskFolder}
            reachesTracked={git.reachesTracked}
            onTaskFolderChange={git.refreshTaskFolder}
            explainsEmpty={!git.isRepo}
            onOpen={git.openRepository}
          />
        ) : null}

        {hasThread && git.linkedPrLines.length > 0 ? (
          <ListSection
            title={gt(
              "{term, select, mr {Linked merge requests} cr {Linked change requests} other {Linked pull requests}}",
              { term: changeRequestTermKind(git.linkedPrActions.terminology) },
            )}
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

        <ManageSection {...props} git={git} hasThread={hasThread} navigate={navigate} />

        {props.project ? (
          <ThreadProjectActions
            key={`${controls.environmentId}:${props.project.id}`}
            environmentId={EnvironmentId.make(String(controls.environmentId))}
            project={props.project}
            scripts={controls.projectScripts}
            canRun={controls.canOperateTerminal && hasThread}
            onRun={(script) => navigate(() => void controls.onRunProjectScript(script))}
          />
        ) : null}

        <ListSection
          title={gt("Terminals")}
          footer={
            !controls.canOperateTerminal
              ? gt("Terminal commands require a saved thread and terminal access.")
              : undefined
          }
        >
          {controls.terminalSessions.map((session) => (
            <ListRow
              key={session.terminalId}
              icon="terminal"
              label={session.displayLabel}
              description={getTerminalStatusLabel(session, m)}
              disabled={!controls.canOpenTerminal}
              onPress={() => navigate(() => controls.onOpenTerminal(session.terminalId))}
            />
          ))}
          <ListRow
            icon="plus"
            label={gt("New terminal")}
            disabled={!controls.canOperateTerminal}
            onPress={() => navigate(controls.onOpenNewTerminal)}
          />
        </ListSection>
      </Scroll>
      <ActionDock
        {...props}
        git={git}
        hasThread={hasThread}
        navigate={navigate}
        openFiles={openFiles}
      />
    </View>
  );
}

function WorkspaceSummary(props: BodyProps & { git: GitOverview; hasThread: boolean }) {
  const gt = useGT();
  const m = useMessages();
  const { git, cwd } = props;
  const controls = props.gitControls;
  const environmentId = EnvironmentId.make(String(controls.environmentId));
  const environment = useSavedRemoteConnection(environmentId);
  const connectionState =
    useRemoteEnvironmentRuntime(environmentId)?.connectionState ?? "available";
  const [copied, setCopied] = useState(false);
  const branch = props.hasThread
    ? git.currentBranchLabel
    : (controls.gitStatus?.refName ?? controls.currentBranch ?? gt("Detached HEAD"));
  const changes = git.gitStatus ? (git.gitStatus.branchChanges ?? git.gitStatus.workingTree) : null;
  return (
    <View className="gap-4 rounded-3xl bg-grouped-card px-4 py-4">
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <SymbolView
            name="point.topleft.down.curvedto.point.bottomright.up"
            size={16}
            tintColorClassName="accent-foreground-muted"
          />
          <Text selectable textRole="headline" className="min-w-0 flex-1 font-t3-bold">
            {branch}
          </Text>
        </View>
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <Text textRole="footnote" className="text-foreground-muted">
            {props.hasThread
              ? git.currentStatusSummary
              : gt("Send the first message to use source control.")}
          </Text>
          {props.hasThread && changes && changes.insertions + changes.deletions > 0 ? (
            <PullRequestDiffStats additions={changes.insertions} deletions={changes.deletions} />
          ) : null}
        </View>
      </View>

      <View className="gap-3 border-t border-border-subtle pt-4">
        <SummaryFact label={gt("Environment")}>
          <View className="flex-row items-center gap-2">
            <View
              className={cn(
                "size-2 rounded-full",
                connectionState === "connected"
                  ? "bg-adaptive-emerald-600-400"
                  : connectionState === "connecting" || connectionState === "reconnecting"
                    ? "bg-warning"
                    : connectionState === "error" || connectionState === "offline"
                      ? "bg-danger"
                      : "bg-foreground-tertiary",
              )}
            />
            <Text textRole="footnote" className="min-w-0 shrink font-t3-medium" numberOfLines={1}>
              {environment?.environmentLabel ?? gt("Environment")}
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {m(CONNECTION_STATE_LABELS[connectionState])}
            </Text>
          </View>
        </SummaryFact>
        <SummaryFact label={gt("Project")}>
          <Text textRole="footnote" className="font-t3-medium" numberOfLines={1}>
            {props.project?.title ?? gt("Project")}
          </Text>
        </SummaryFact>
        <SummaryFact label={props.worktreePath ? gt("Worktree") : gt("Directory")}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? gt("Workspace path copied") : gt("Copy workspace path")}
            disabled={!cwd}
            onPress={() => {
              if (!cwd) return;
              void Clipboard.setStringAsync(cwd);
              setCopied(true);
            }}
            className="flex-row items-start gap-2 rounded-lg active:opacity-60"
          >
            <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-secondary">
              {cwd ?? gt("Workspace unavailable")}
            </Text>
            {cwd ? (
              <SymbolView
                name={copied ? "checkmark" : "doc.on.doc"}
                size={14}
                tintColorClassName="accent-foreground-muted"
              />
            ) : null}
          </Pressable>
        </SummaryFact>
      </View>
    </View>
  );
}

function SummaryFact(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-0.5">
      <Text textRole="caption" className="text-foreground-tertiary">
        {props.label}
      </Text>
      {props.children}
    </View>
  );
}

function ManageSection(
  props: BodyProps & {
    git: GitOverview;
    hasThread: boolean;
    navigate: (action: () => void) => void;
  },
) {
  const gt = useGT();
  const { git, navigate } = props;
  const controls = props.gitControls;
  const [branchesOpen, setBranchesOpen] = useState(false);
  const canManageBranches = props.hasThread && git.isRepo;
  return (
    <View className="gap-3">
      <ListSection title={gt("Manage")}>
        {canManageBranches ? (
          <ListRow
            icon="point.topleft.down.curvedto.point.bottomright.up"
            label={gt("Branches & worktrees")}
            description={
              git.canChangeThreadBranch
                ? gt("Switch branch, create branch, or move to a worktree")
                : gt("View branches and worktrees")
            }
            disabled={git.busy}
            onPress={() => setBranchesOpen((open) => !open)}
          />
        ) : null}
        {props.hasThread && git.linkedPrActions.canLink ? (
          <ListRow
            icon="link"
            label={gt(
              "{term, select, mr {Link merge request} cr {Link change request} other {Link pull request}}",
              { term: changeRequestTermKind(git.linkedPrActions.terminology) },
            )}
            description={gt(
              "{term, select, mr {Attach a merge request by URL or number} cr {Attach a change request by URL or number} other {Attach a pull request by URL or number}}",
              { term: changeRequestTermKind(git.linkedPrActions.terminology) },
            )}
            onPress={() => navigate(git.linkedPrActions.promptLink)}
          />
        ) : null}
        {controls.onMergeBack ? (
          <ListRow
            icon={PullRequestGlyph.merged}
            label={gt("Merge back to source")}
            onPress={() => navigate(() => controls.onMergeBack?.())}
          />
        ) : null}
        <ListRow
          icon="chevron.left"
          label={gt("Close thread")}
          onPress={() => navigate(props.onCloseThread)}
        />
      </ListSection>
      {canManageBranches && branchesOpen ? <GitBranchesContent /> : null}
    </View>
  );
}

function ActionDock(
  props: BodyProps & {
    git: GitOverview;
    hasThread: boolean;
    navigate: (action: () => void) => void;
    openFiles: () => void;
  },
) {
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  const { git, navigate, hasThread } = props;
  const controls = props.gitControls;
  const canReadFiles = useEnvironmentScope(
    EnvironmentId.make(String(controls.environmentId)),
    AuthFilesystemReadScope,
  );
  const latestTerminal = controls.terminalSessions.at(-1);
  const showGit = hasThread && git.isRepo;
  const { quickAction } = git;
  const quickActionIcon: AppSymbolName =
    quickAction.kind === "run_pull"
      ? "arrow.down.circle"
      : quickAction.action === "commit"
        ? "checkmark.circle"
        : quickAction.action === "push" || quickAction.action === "commit_push"
          ? "arrow.up.circle"
          : "arrow.up.right.circle";

  return (
    <View
      className="gap-2 border-t border-header-border px-3 pt-3"
      style={{ paddingBottom: Math.max(insets.bottom, 12) }}
    >
      {showGit ? (
        <View className="gap-1">
          <Button
            label={quickAction.label}
            icon={quickActionIcon}
            tone="primary"
            fullWidth
            disabled={quickAction.disabled}
            loading={git.busy}
            accessibilityHint={quickAction.hint}
            onPress={() => void git.runQuickAction()}
          />
          {quickAction.disabled && quickAction.hint ? (
            <Text textRole="caption" className="text-center text-foreground-muted">
              {quickAction.hint}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View className="flex-row gap-2">
        {props.onReturnToThread ? (
          <DockTile
            icon="bubble.left"
            label={gt("Chat", { $context: "thread conversation view" })}
            onPress={() => navigate(() => props.onReturnToThread?.())}
          />
        ) : null}
        <DockTile
          icon="folder"
          label={gt("Files")}
          disabled={!controls.canOpenFiles || !canReadFiles}
          onPress={props.openFiles}
        />
        <DockTile
          icon="terminal"
          label={gt("Terminal")}
          detail={latestTerminal ? getTerminalStatusLabel(latestTerminal, m) : undefined}
          disabled={latestTerminal ? !controls.canOpenTerminal : !controls.canOperateTerminal}
          onPress={() =>
            navigate(() =>
              latestTerminal
                ? controls.onOpenTerminal(latestTerminal.terminalId)
                : controls.onOpenNewTerminal(),
            )
          }
        />
        {hasThread ? (
          <DockTile
            icon="text.bubble"
            label={gt("Review", { $context: "code review action" })}
            disabled={git.busy || !(git.isRepo || git.trackedRepositoryCount > 0)}
            onPress={git.openReview}
          />
        ) : null}
      </View>
    </View>
  );
}

function DockTile(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[props.label, props.detail].filter(Boolean).join(", ")}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-16 min-w-0 flex-1 items-center justify-center gap-1 rounded-2xl bg-grouped-card px-2 py-2 active:opacity-70",
        props.disabled && "opacity-40",
      )}
    >
      <SymbolView name={props.icon} size={20} tintColorClassName="accent-icon" />
      <Text textRole="label" numberOfLines={1} className="font-t3-medium text-foreground">
        {props.label}
      </Text>
      {props.detail ? (
        <Text textRole="caption" numberOfLines={1} className="text-foreground-muted">
          {props.detail}
        </Text>
      ) : null}
    </Pressable>
  );
}
