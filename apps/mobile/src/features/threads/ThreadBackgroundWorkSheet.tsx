import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  backgroundCommandOutputFile,
  deriveBackgroundWorkDetails,
  followOutputFileCommand,
  type BackgroundWorkDetail,
} from "@t3tools/client-runtime/state/thread-execution";
import {
  toolCallLines,
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { pullRequestChecksStatus, pullRequestStatus } from "../pull-requests/pullRequestStatus";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { stageCommandTerminalLaunch } from "../terminal/terminalLaunchContext";
import { ThreadCommandOutput, useCommandOutputStreaming } from "./thread-command-output";
import { useVisibleSecondClock } from "./use-visible-second-clock";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const KIND_LABELS = {
  subagent: "Subagent",
  command: "Command",
  monitor: "Monitor",
  background_task: "Background task",
} as const;

type BackgroundWorkTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadBackgroundWorkSheet({ route }: StaticScreenProps<BackgroundWorkTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = route.params;
  const threadRef = scopeThreadRef(target.environmentId, target.threadId);
  const thread = useQuietThreadShell(threadRef);
  const structure = useQuietThreadStructure(threadRef);
  const project = useProject(
    thread ? { environmentId: target.environmentId, projectId: thread.projectId } : null,
  );
  const canOperateTerminal = useEnvironmentScope(target.environmentId, AuthTerminalOperateScope);
  const work = deriveBackgroundWorkDetails({
    tasks: thread?.pendingBackgroundTasks ?? [],
    turnItems: structure?.projection.turnItems ?? [],
    pullRequests: thread?.pullRequests,
  });
  const followOutput = (path: string) => {
    if (
      !project?.workspaceRoot ||
      !readEnvironmentScope(target.environmentId, AuthTerminalOperateScope)
    )
      return;
    void Haptics.selectionAsync();
    const terminalId = nextTerminalId([], uuidv4());
    stageCommandTerminalLaunch({
      target: { ...target, terminalId },
      workspaceRoot: project.workspaceRoot,
      threadShellWorktreePath: thread?.worktreePath ?? null,
      threadDetailWorktreePath: structure?.projection.thread.worktreePath ?? null,
      command: followOutputFileCommand(path),
    });
    void navigation.navigate("ThreadTerminal", {
      environmentId: String(target.environmentId),
      threadId: String(target.threadId),
      terminalId,
    });
  };
  const openThread = (threadId: ThreadId) => {
    void Haptics.selectionAsync();
    // A thread replaces the leaf sheet so workspace back navigation still works.
    navigation.dispatch(
      StackActions.replace("Thread", { environmentId: target.environmentId, threadId }),
    );
  };
  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {work === null ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          Nothing running in the background.
        </Text>
      ) : (
        work.details.map((detail) =>
          detail.pullRequest ? (
            <PullRequestMonitorRow
              key={detail.item.taskId}
              link={detail.pullRequest}
              startedAtMs={detail.startedAtMs}
            />
          ) : (
            <BackgroundWorkRow
              key={detail.item.taskId}
              detail={detail}
              target={target}
              onOpen={openThread}
              onFollow={canOperateTerminal && project?.workspaceRoot ? followOutput : undefined}
            />
          ),
        )
      )}
    </ScrollView>
  );
  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-background-work-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title="Background work"
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title="Background work" onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

const CHECKS_LABELS = {
  passing: "checks passing",
  pending: "checks pending",
  failing: "checks failing",
} as const;

function BackgroundWorkElapsed({ startedAtMs }: { readonly startedAtMs: number | null }) {
  const nowMs = useVisibleSecondClock(startedAtMs !== null);
  return startedAtMs === null ? null : (
    <Text className="text-xs text-foreground-muted">
      {` · ${formatDuration(Math.max(0, nowMs - startedAtMs))}`}
    </Text>
  );
}

function PullRequestMonitorRow(props: {
  readonly link: ThreadPullRequestLink;
  readonly startedAtMs: number | null;
}) {
  const { link } = props;
  // The snapshot arrives from the host after the link, so the row must stay tappable without it.
  const snapshot = link.snapshot;
  const status = snapshot ? pullRequestStatus(snapshot) : null;
  const checksState = snapshot?.state === "open" ? snapshot.checksState : undefined;
  const checks = checksState ? pullRequestChecksStatus(checksState) : null;
  const checksLabel = checksState ? CHECKS_LABELS[checksState] : undefined;
  const title = snapshot?.title ?? `Pull request #${link.number}`;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Watching pull request ${link.number}, ${title}${status ? `, ${status.label}` : ""}${checksLabel ? `, ${checksLabel}` : ""}`}
      accessibilityHint="Opens this pull request externally"
      onPress={() => {
        void Haptics.selectionAsync();
        void tryOpenExternalUrl(link.url, "pull-request").then((opened) => {
          if (!opened) Dialog.alert("Unable to open PR", "The pull request could not be opened.");
        });
      }}
      className="active:opacity-70"
    >
      <View className="flex-row items-center gap-3 border-b border-border py-3.5">
        <SymbolView
          name={{ ios: "bolt", android: "bolt" }}
          size={15}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="font-t3-medium text-sm text-foreground" numberOfLines={2}>
            {title}
          </Text>
          <View className="flex-row flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <Text className={cn("font-t3-medium text-xs", status?.text ?? "text-foreground-muted")}>
              #{link.number}
            </Text>
            <Text className="text-xs text-foreground-muted">
              Monitor · Watching{status ? ` · ${status.label}` : ""}
              <BackgroundWorkElapsed startedAtMs={props.startedAtMs} />
            </Text>
            {checks ? (
              <View className="flex-row items-center gap-1">
                <SymbolView name={checks.icon} size={12} tintColorClassName={checks.tint} />
                <Text className="text-xs text-foreground-muted">{checksLabel}</Text>
              </View>
            ) : null}
          </View>
        </View>
        <SymbolView name="arrow.up.right" size={12} tintColorClassName="accent-icon-subtle" />
      </View>
    </Pressable>
  );
}

function BackgroundWorkRow(props: {
  readonly detail: BackgroundWorkDetail;
  readonly target: BackgroundWorkTarget;
  readonly onOpen: (threadId: ThreadId) => void;
  readonly onFollow: ((path: string) => void) | undefined;
}) {
  const { item, childThreadId } = props.detail;
  const [expanded, setExpanded] = useState(false);
  const focused = useIsFocused();
  return (
    <View className="border-b border-border">
      <Pressable
        accessibilityRole={childThreadId === undefined ? "button" : "link"}
        accessibilityLabel={
          childThreadId === undefined ? item.label : `Open subagent ${item.label}`
        }
        accessibilityState={childThreadId === undefined ? { expanded } : undefined}
        onPress={() => {
          if (childThreadId !== undefined) {
            props.onOpen(childThreadId);
          } else {
            void Haptics.selectionAsync();
            setExpanded((value) => !value);
          }
        }}
        className="active:opacity-70"
      >
        <View className="flex-row items-center gap-3 py-3.5">
          <SymbolView
            name={
              item.kind === "subagent" ? "person.2" : item.kind === "monitor" ? "clock" : "terminal"
            }
            size={15}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
          <View className="min-w-0 flex-1">
            <Text className="font-t3-medium text-sm text-foreground">{item.label}</Text>
            <Text className="text-xs text-foreground-muted">
              {KIND_LABELS[item.kind]}
              <BackgroundWorkElapsed startedAtMs={props.detail.startedAtMs} />
            </Text>
          </View>
          <SymbolView
            name={expanded && childThreadId === undefined ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-subtle"
          />
        </View>
      </Pressable>
      {expanded && focused ? (
        <BackgroundWorkInspection
          detail={props.detail}
          target={props.target}
          onFollow={props.onFollow}
        />
      ) : null}
    </View>
  );
}

function BackgroundWorkInspection(props: {
  readonly detail: BackgroundWorkDetail;
  readonly target: BackgroundWorkTarget;
  readonly onFollow: ((path: string) => void) | undefined;
}) {
  const { detail, target, onFollow } = props;
  const { themeAppearance } = useAppearancePreferences();
  const streaming = useCommandOutputStreaming(target.environmentId);
  const item = detail.turnItem;
  const inspectableItem =
    item?.type === "command_execution" || item?.type === "dynamic_tool" ? item : null;
  const needsFetch = inspectableItem !== null && turnItemNeedsDetailFetch(inspectableItem);
  const fetched = useEnvironmentQuery(
    needsFetch
      ? orchestrationEnvironment.turnItem({
          environmentId: target.environmentId,
          input: {
            threadId: inspectableItem.threadId,
            itemId: inspectableItem.id,
            revision: turnItemDetailRevision(inspectableItem),
          },
        })
      : null,
  );
  const shownItem = fetched.data?.item ?? item;
  const commandItem = shownItem?.type === "command_execution" ? shownItem : null;
  const toolItem = shownItem?.type === "dynamic_tool" ? shownItem : null;
  const subagent = shownItem?.type === "subagent" ? shownItem : null;
  const command = commandItem?.input ?? detail.command;
  const description = shownItem?.title?.trim() || detail.item.label;
  const outputFile = detail.outputFile ?? backgroundCommandOutputFile(commandItem?.output);
  const loading = needsFetch && fetched.data === null && fetched.error === null;
  const streamsOutput = streaming && commandItem !== null && outputFile === null && !loading;
  const output = inspectableItem ? turnItemOutputText(fetched.data?.item ?? inspectableItem) : null;
  const toolInput = toolItem ? toolCallLines({ args: toolItem.input }) : null;
  const inputText =
    toolInput?.args?.map(([name, value]) => `${name}: ${value}`).join("\n") ??
    toolInput?.argsText ??
    subagent?.prompt;
  return (
    <View className="gap-3 pb-4 pl-7">
      {description !== command?.trim() ? (
        <Text selectable className="text-sm text-foreground-muted">
          {description}
        </Text>
      ) : null}
      {command ? (
        <View className="rounded-lg bg-subtle p-3">
          <ScrollView horizontal nestedScrollEnabled>
            <Text selectable className="font-mono text-xs leading-normal text-foreground">
              {command}
            </Text>
          </ScrollView>
        </View>
      ) : null}
      {toolItem ? (
        <Text selectable className="font-t3-medium text-xs text-foreground">
          {toolItem.toolName ?? "Tool"}
        </Text>
      ) : null}
      {inputText ? (
        <Text selectable className="font-mono text-xs leading-normal text-foreground-muted">
          {inputText}
        </Text>
      ) : null}
      {outputFile !== null ? (
        <>
          <Text className="text-xs text-foreground-muted">Output file on this environment</Text>
          <Text selectable className="font-mono text-xs text-foreground-muted">
            {outputFile}
          </Text>
          {onFollow ? (
            <Button
              label="Follow in terminal"
              icon="terminal"
              onPress={() => onFollow(outputFile)}
            />
          ) : null}
        </>
      ) : streamsOutput && commandItem ? (
        <ThreadCommandOutput
          environmentId={target.environmentId}
          threadId={commandItem.threadId}
          itemId={commandItem.id}
          themeAppearance={themeAppearance}
        />
      ) : (
        <ScrollView nestedScrollEnabled className="max-h-60">
          <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
            {loading
              ? "Loading output…"
              : fetched.error
                ? `Couldn't load output: ${fetched.error}`
                : (output ?? subagent?.progress ?? subagent?.result ?? "No output yet.")}
          </Text>
        </ScrollView>
      )}
      <Text selectable className="font-mono text-3xs text-foreground-subtle">
        Task {detail.item.taskId}
      </Text>
    </View>
  );
}
