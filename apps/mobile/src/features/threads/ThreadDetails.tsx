import { useNavigation } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AuthFilesystemReadScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { use, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { FloatingHeaderButtonBackdrop } from "../../components/ui/FloatingHeaderButtonBackdrop";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { InspectorSheetContext } from "../layout/workspace-inspector-sheet";
import { getTerminalStatusLabel } from "../terminal/terminalMenu";
import { GitBranchesContent } from "./git/GitBranchesSheet";
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
  const insets = useSafeAreaInsets();
  return (
    <View
      className="flex-1 bg-header"
      style={{ paddingTop: Platform.OS === "android" ? insets.top : 0 }}
    >
      <View className="flex-row items-center justify-between gap-3 px-5 py-4">
        <View className="min-w-0 flex-1 gap-1">
          <Text textRole="title" className="font-t3-bold">
            Thread details
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
            {props.title}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close thread details"
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
  return (
    <View collapsable={false} className="flex-1 android:bg-header ios:bg-screen">
      <AppBar title="Thread details" subtitle={props.title} />
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
        <WorkspaceSummary {...props} git={git} hasThread={hasThread} />

        {hasThread && git.linkedPrLines.length > 0 ? (
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

        <ListSection title="Notebook">
          <ListRow
            icon="doc.text"
            label="Notebook"
            description="Read-only cells and outputs"
            disabled={!hasThread}
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
          title="Terminals"
          footer={
            !controls.canOperateTerminal
              ? "Terminal commands require a saved thread and terminal access."
              : undefined
          }
        >
          {controls.terminalSessions.map((session) => (
            <ListRow
              key={session.terminalId}
              icon="terminal"
              label={session.displayLabel}
              description={getTerminalStatusLabel(session)}
              disabled={!controls.canOpenTerminal}
              onPress={() => navigate(() => controls.onOpenTerminal(session.terminalId))}
            />
          ))}
          <ListRow
            icon="plus"
            label="New terminal"
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
  const { git, cwd } = props;
  const controls = props.gitControls;
  const environmentId = EnvironmentId.make(String(controls.environmentId));
  const environment = useSavedRemoteConnection(environmentId);
  const connectionState =
    useRemoteEnvironmentRuntime(environmentId)?.connectionState ?? "available";
  const [copied, setCopied] = useState(false);
  const branch = props.hasThread
    ? git.currentBranchLabel
    : (controls.gitStatus?.refName ?? controls.currentBranch ?? "Detached HEAD");
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
              : "Send the first message to use source control."}
          </Text>
          {props.hasThread && changes && changes.insertions + changes.deletions > 0 ? (
            <PullRequestDiffStats additions={changes.insertions} deletions={changes.deletions} />
          ) : null}
        </View>
      </View>

      <View className="gap-3 border-t border-border-subtle pt-4">
        <SummaryFact label="Environment">
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
              {environment?.environmentLabel ?? "Environment"}
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {connectionState.charAt(0).toUpperCase() + connectionState.slice(1)}
            </Text>
          </View>
        </SummaryFact>
        <SummaryFact label="Project">
          <Text textRole="footnote" className="font-t3-medium" numberOfLines={1}>
            {props.project?.title ?? "Project"}
          </Text>
        </SummaryFact>
        <SummaryFact label={props.worktreePath ? "Worktree" : "Directory"}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? "Workspace path copied" : "Copy workspace path"}
            disabled={!cwd}
            onPress={() => {
              if (!cwd) return;
              void Clipboard.setStringAsync(cwd);
              setCopied(true);
            }}
            className="flex-row items-start gap-2 rounded-lg active:opacity-60"
          >
            <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-secondary">
              {cwd ?? "Workspace unavailable"}
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
  const { git, navigate } = props;
  const controls = props.gitControls;
  const [branchesOpen, setBranchesOpen] = useState(false);
  const canManageBranches = props.hasThread && git.isRepo;
  return (
    <View className="gap-3">
      <ListSection title="Manage">
        {canManageBranches ? (
          <ListRow
            icon="point.topleft.down.curvedto.point.bottomright.up"
            label="Branches & worktrees"
            description={
              git.canChangeThreadBranch
                ? "Switch branch, create branch, or move to a worktree"
                : "View branches and worktrees"
            }
            disabled={git.busy}
            onPress={() => setBranchesOpen((open) => !open)}
          />
        ) : null}
        {props.hasThread && git.linkedPrActions.canLink ? (
          <ListRow
            icon="link"
            label={`Link ${git.linkedPrActions.terminology.singular}`}
            description={`Attach a ${git.linkedPrActions.terminology.singular} by URL or number`}
            onPress={() => navigate(git.linkedPrActions.promptLink)}
          />
        ) : null}
        {controls.onMergeBack ? (
          <ListRow
            icon={PullRequestGlyph.merged}
            label="Merge back to source"
            onPress={() => navigate(() => controls.onMergeBack?.())}
          />
        ) : null}
        <ListRow
          icon="chevron.left"
          label="Close thread"
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
            label="Chat"
            onPress={() => navigate(() => props.onReturnToThread?.())}
          />
        ) : null}
        <DockTile
          icon="folder"
          label="Files"
          disabled={!controls.canOpenFiles || !canReadFiles}
          onPress={props.openFiles}
        />
        <DockTile
          icon="terminal"
          label="Terminal"
          detail={latestTerminal ? getTerminalStatusLabel(latestTerminal) : undefined}
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
            label="Review"
            disabled={git.busy || !git.isRepo}
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
