import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AuthFilesystemReadScope, EnvironmentId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { cn } from "../../lib/cn";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
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
import type { ThreadGitControls } from "./ThreadGitControls";
import {
  ThreadListDrawerHost,
  threadListDrawerWidth,
  useThreadDetailsDrawer,
} from "./thread-list-drawer";

type DetailsProps = Parameters<typeof ThreadDetailsDrawer>[0];

export function ThreadDetailsDrawer(props: {
  readonly title: string;
  readonly project: EnvironmentProject | null;
  readonly cwd: string | null;
  readonly worktreePath: string | null;
  readonly gitControls: Parameters<typeof ThreadGitControls>[0];
  readonly onCloseThread: () => void;
  readonly onReturnToThread?: (() => void) | undefined;
}) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const { width } = useWindowDimensions();
  return (
    <ThreadListDrawerHost side="right" width={threadListDrawerWidth(layout.listPaneWidth, width)}>
      {() => <ThreadDetailsContent {...props} />}
    </ThreadListDrawerHost>
  );
}

// Read-only facts sit at the top; the actions people reach for most sit in a dock under the thumb.
function ThreadDetailsContent(props: DetailsProps) {
  const insets = useSafeAreaInsets();
  const { closeDrawer } = useThreadDetailsDrawer();
  const controls = props.gitControls;
  const hasThread = controls.hasThread !== false;
  const git = useGitOverview({
    environmentId: String(controls.environmentId),
    threadId: String(controls.threadId),
    presentation: "drawer",
    onNavigate: closeDrawer,
  });
  const navigate = (action: () => void) => {
    closeDrawer();
    action();
  };
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
          onPress={closeDrawer}
          className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle"
        >
          <SymbolView name="xmark" size={20} tintColorClassName="accent-header-foreground" />
        </Pressable>
      </View>
      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 20, gap: 20 }}
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
      </ScrollView>
      <ActionDock {...props} git={git} hasThread={hasThread} navigate={navigate} />
    </View>
  );
}

function WorkspaceSummary(props: DetailsProps & { git: GitOverview; hasThread: boolean }) {
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
  props: DetailsProps & {
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
  props: DetailsProps & {
    git: GitOverview;
    hasThread: boolean;
    navigate: (action: () => void) => void;
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
  const showGit = hasThread && git.isRepo && git.menuItems.length > 0;

  const [commit, push, pr] = git.menuItems;
  const branchPrUrl = git.gitStatus?.pr?.state === "open" ? git.gitStatus.pr.url : null;
  const linkedPr = git.linkedPrLines.find(
    (line) => line.link.snapshot === null || line.link.snapshot.state === "open",
  )?.link;
  const prUrl = branchPrUrl ?? linkedPr?.url ?? null;
  const prNumber = branchPrUrl ? git.gitStatus?.pr?.number : linkedPr?.number;
  const pull = git.behindCount > 0;
  const gitTiles = showGit
    ? [
        commit && {
          key: "commit",
          icon: "checkmark.circle" as const,
          label: commit.item.label,
          detail: commit.statusDetail,
          disabled: commit.item.disabled,
          onPress: () => void git.onPressMenuItem(commit.item),
        },
        pull
          ? {
              key: "pull",
              icon: "arrow.down.circle" as const,
              label: "Pull",
              detail: `${git.behindCount} behind`,
              disabled: !git.canWriteSourceControl || git.busy,
              onPress: git.pull,
            }
          : push && {
              key: "push",
              icon: "arrow.up.circle" as const,
              label: push.item.label,
              detail: push.statusDetail,
              disabled: push.item.disabled,
              onPress: () => void git.onPressMenuItem(push.item),
            },
        prUrl
          ? {
              key: "pr",
              icon: PullRequestGlyph.pullRequest,
              label: `Open ${git.terminology.shortLabel}`,
              detail: prNumber != null ? `#${prNumber}` : undefined,
              disabled: false,
              onPress: () => void git.openUrl(prUrl),
            }
          : pr && {
              key: "pr",
              icon: "arrow.up.right.circle" as const,
              label: pr.item.label,
              detail: pr.statusDetail,
              disabled: pr.item.disabled,
              onPress: () => void git.onPressMenuItem(pr.item),
            },
      ].filter((tile) => !!tile)
    : [];
  const primaryKey = gitTiles.find((tile) => !tile.disabled)?.key;

  return (
    <View
      className="gap-2 border-t border-header-border px-3 pt-3"
      style={{ paddingBottom: Math.max(insets.bottom, 12) }}
    >
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
          onPress={() => navigate(() => controls.onOpenFilesInspector?.())}
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
      {gitTiles.length > 0 ? (
        <View className="flex-row gap-2">
          {gitTiles.map(({ key, ...tile }) => (
            <DockTile key={key} {...tile} primary={key === primaryKey} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function DockTile(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly disabled?: boolean;
  readonly primary?: boolean;
  readonly onPress: () => void;
}) {
  const primary = props.primary && !props.disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[props.label, props.detail].filter(Boolean).join(", ")}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-16 min-w-0 flex-1 items-center justify-center gap-1 rounded-2xl px-2 py-2 active:opacity-70",
        primary ? "bg-primary" : "bg-grouped-card",
        props.disabled && "opacity-40",
      )}
    >
      <SymbolView
        name={props.icon}
        size={20}
        tintColorClassName={primary ? "accent-primary-foreground" : "accent-icon"}
      />
      <Text
        textRole="label"
        numberOfLines={1}
        className={cn("font-t3-medium", primary ? "text-primary-foreground" : "text-foreground")}
      >
        {props.label}
      </Text>
      {props.detail ? (
        <Text
          textRole="caption"
          numberOfLines={1}
          className={primary ? "text-primary-foreground" : "text-foreground-muted"}
        >
          {props.detail}
        </Text>
      ) : null}
    </Pressable>
  );
}
