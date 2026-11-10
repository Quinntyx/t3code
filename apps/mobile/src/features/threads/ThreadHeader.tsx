import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";
import { ThreadDetailsDrawer } from "./ThreadDetailsDrawer";
import { useThreadDetailsDrawer } from "./thread-list-drawer";
import {
  ThreadFloatingHeader,
  ThreadFloatingTopScrim,
  usesFloatingThreadControls,
} from "./ThreadFloatingControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly project: EnvironmentProject | null;
  readonly cwd: string | null;
  readonly worktreePath: string | null;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
}) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout, toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const details = useThreadDetailsDrawer();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  // Without columns, the details drawer holds files, git and terminals behind one button.
  const actions: AppBarAction[] = !layout.usesSplitView
    ? [
        {
          accessibilityLabel: "Open thread details",
          icon: "sidebar.right",
          selected: details.open,
          onPress: details.openDrawer,
        },
      ]
    : props.cwd !== null
      ? [
          {
            accessibilityLabel: filesVisible ? "Close files" : "Open files",
            icon: "folder",
            selected: filesVisible,
            disabled: !props.gitControls.canOpenFiles,
            separateBackground: false,
            onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
          },
        ]
      : [];
  const menus = layout.usesSplitView
    ? [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null)
    : [];

  return (
    <>
      {usesFloatingThreadControls(layout) ? (
        <>
          <ThreadFloatingTopScrim />
          <ThreadFloatingHeader />
        </>
      ) : (
        <AppBar
          title={props.title}
          subtitle={props.subtitle}
          onBackToList={goBack}
          onCompose={props.draft ? undefined : startNewTask}
          backInSplitView={
            props.onReturnToThread
              ? {
                  accessibilityLabel: "Return to chat",
                  icon: "chevron.left",
                  onPress: props.onReturnToThread,
                }
              : undefined
          }
          actions={actions}
          menus={menus}
          hideBottomBorder
        />
      )}
      <ThreadDetailsDrawer
        title={props.title}
        project={props.project}
        cwd={props.cwd}
        worktreePath={props.worktreePath}
        gitControls={props.gitControls}
        onCloseThread={goBack}
        onReturnToThread={props.onReturnToThread}
      />
    </>
  );
}
