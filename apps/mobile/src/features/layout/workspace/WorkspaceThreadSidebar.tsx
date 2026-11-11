import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation, useNavigationState } from "@react-navigation/native";

import { scopedThreadKey } from "../../../lib/scopedEntities";
import { uuidv4 } from "../../../lib/uuid";
import { usePendingTaskListActions } from "../../home/usePendingTaskListActions";
import { useAdaptiveWorkspaceLayout, useWorkspacePaneState } from "../adaptive-workspace-context";
import { openSettings } from "../../settings/settings-navigation";
import { ThreadNavigationSidebar } from "../../threads/ThreadNavigationSidebar";
import { useOpenThreadPullRequests } from "../../threads/use-open-thread-pull-requests";
import { useSelectWorkspaceDetail } from "./useSelectWorkspaceDetail";
import { useWorkspaceListNavigation } from "./useAndroidWorkspaceNavigation";

type Route = { readonly name: string; readonly params?: object };

function selectedThreadKey(state: { readonly index: number; readonly routes: readonly Route[] }) {
  const params = state.routes
    .slice(0, state.index + 1)
    .findLast((route) => route.name.startsWith("Thread"))?.params;
  if (
    !params ||
    !("environmentId" in params) ||
    !("threadId" in params) ||
    typeof params.environmentId !== "string" ||
    typeof params.threadId !== "string"
  ) {
    return null;
  }
  try {
    return scopedThreadKey(
      EnvironmentId.make(params.environmentId),
      ThreadId.make(params.threadId),
    );
  } catch {
    return null;
  }
}

/** The thread list in the workspace's sidebar column, or in the compact thread drawer. */
export function WorkspaceThreadSidebar(props: {
  /** The compact drawer closes before anything opens, so the page is what it uncovers. */
  readonly drawer?: {
    readonly width: number;
    readonly visible: boolean;
    readonly close: () => void;
  };
}) {
  const navigation = useNavigation();
  const { layout, setPrimarySidebarSearchQuery, revealPrimarySidebar, openWorkspaceTab } =
    useAdaptiveWorkspaceLayout();
  const { panes, primarySidebarSearchQuery } = useWorkspacePaneState();
  const selectDetail = useSelectWorkspaceDetail();
  const openThreadPullRequests = useOpenThreadPullRequests();
  const openHome = useWorkspaceListNavigation("threads");
  const selectedThread = useNavigationState(selectedThreadKey);
  const { drawer } = props;
  const leave = <Args extends unknown[]>(open: (...args: Args) => void) =>
    drawer
      ? (...args: Args) => {
          drawer.close();
          open(...args);
        }
      : open;
  const selectThreadRoute = leave((params: ReactNavigation.RootParamList["Thread"]) =>
    selectDetail({ name: "Thread", params }),
  );
  const { openPendingTask } = usePendingTaskListActions(selectThreadRoute);
  return (
    <ThreadNavigationSidebar
      width={drawer?.width ?? layout.listPaneWidth ?? 0}
      visible={drawer?.visible ?? panes.primarySidebarVisible}
      onRequestVisibility={revealPrimarySidebar}
      selectedThreadKey={selectedThread}
      onOpenSettings={leave(() => openWorkspaceTab("settings"))}
      onOpenEnvironmentSettings={() => openSettings(navigation, "SettingsEnvironments")}
      onOpenHome={drawer ? leave(openHome) : undefined}
      onOpenThreadNotebook={leave((thread: EnvironmentThreadShell) =>
        navigation.navigate("ThreadNotebook", {
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
      )}
      onNewThreadInProject={(project: EnvironmentProject) =>
        selectThreadRoute({
          draft: {
            requestId: uuidv4(),
            environmentId: String(project.environmentId),
            projectId: String(project.id),
            title: project.title,
          },
        })
      }
      onNewThreadOnBranch={(thread: EnvironmentThreadShell) =>
        selectThreadRoute({
          draft: {
            requestId: uuidv4(),
            environmentId: String(thread.environmentId),
            projectId: String(thread.projectId),
            branch: thread.branch,
            worktreePath: thread.worktreePath,
          },
        })
      }
      onOpenPendingTask={openPendingTask}
      onSelectThread={(thread) =>
        selectThreadRoute({
          environmentId: String(thread.environmentId),
          threadId: String(thread.id),
        })
      }
      onOpenThreadPullRequests={leave(openThreadPullRequests)}
      onSearchQueryChange={setPrimarySidebarSearchQuery}
      searchQuery={primarySidebarSearchQuery}
    />
  );
}
