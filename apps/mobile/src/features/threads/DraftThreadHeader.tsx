import { uuidv4 } from "../../lib/uuid";
import * as Dialog from "../../components/ui/Dialog";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { AuthFilesystemReadScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsActionManager, vcsEnvironment } from "../../state/vcs";
import { useVcsActionState } from "../../state/use-vcs-action-state";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadDetailsInspectorPane } from "./ThreadDetails";
import type { ThreadGitControlsProps } from "./ThreadGitControls";
import { Inspector, useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";

export function DraftThreadHeader(props: {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject;
  readonly cwd: string | null;
}) {
  const navigation = useNavigation();
  const environmentId = props.thread.environmentId;
  const runtime = useRemoteEnvironmentRuntime(environmentId);
  const canReadFiles = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canWriteGit = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const status = useEnvironmentQuery(
    props.cwd ? vcsEnvironment.status({ environmentId, input: { cwd: props.cwd } }) : null,
  );
  const target = { environmentId, cwd: props.cwd };
  const progress = useVcsActionState(target);
  const runAction = useAtomCommand(vcsActionManager.runStackedAction(target), {
    reportFailure: false,
  });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const openFiles = () => {
    if (!props.cwd || !canReadFiles) return;
    navigation.navigate("NewTaskFiles", {
      environmentId,
      cwd: props.cwd,
      projectName: props.project.title,
    });
  };
  const goBack = useWorkspaceBackNavigation("threads");
  const { showInspector } = useAdaptiveWorkspaceLayout();
  const [detailsChosen, setDetailsChosen] = useState(false);
  const requiresThread = () =>
    Dialog.alert("Available after the first message", "This action needs a saved thread.");
  const gitControls: ThreadGitControlsProps = {
    environmentId,
    threadId: props.thread.id,
    hasThread: false,
    currentBranch: props.thread.branch,
    gitStatus: status.data,
    gitOperationLabel: progress.currentLabel,
    canOpenTerminal: false,
    canOperateTerminal: false,
    canOpenFiles: canReadFiles && props.cwd !== null,
    projectScripts: resolveProjectScripts(
      runtime?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
      props.project,
    ),
    terminalSessions: [],
    onOpenFilesInspector: openFiles,
    onOpenGitInspector: requiresThread,
    onOpenTerminal: requiresThread,
    onOpenNewTerminal: requiresThread,
    onRunProjectScript: async () => {
      requiresThread();
    },
    onPull: async () => {
      if (!canWriteGit || !props.cwd) return;
      const result = await pull({ environmentId, input: { cwd: props.cwd } });
      if (AsyncResult.isFailure(result))
        Dialog.alert("Could not pull", String(Cause.squash(result.cause)));
    },
    onRunAction: async (input) => {
      if (!canWriteGit || !props.cwd) return null;
      const result = await runAction({
        ...input,
        projectId: props.project.id,
        actionId: uuidv4(),
      });
      if (AsyncResult.isFailure(result)) {
        Dialog.alert("Git action failed", String(Cause.squash(result.cause)));
        return null;
      }
      return result.value;
    },
  };
  const details = {
    title: "New thread",
    project: props.project,
    cwd: props.cwd,
    worktreePath: props.thread.worktreePath,
    gitControls,
    onCloseThread: goBack,
  };
  return (
    <>
      {detailsChosen ? (
        <Inspector
          content={{
            active: "details",
            panes: [{ key: "details", render: () => <ThreadDetailsInspectorPane {...details} /> }],
          }}
        />
      ) : null}
      <ThreadHeader
        draft
        title={details.title}
        subtitle=""
        project={props.project}
        cwd={props.cwd}
        worktreePath={props.thread.worktreePath}
        gitControls={gitControls}
        inspectorMode={detailsChosen ? "details" : null}
        onOpenFilesInspector={openFiles}
        onOpenDetailsInspector={() => {
          setDetailsChosen(true);
          showInspector();
        }}
      />
    </>
  );
}
