import { View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { WorkspaceAppBarScope } from "../../../components/ui/WorkspaceAppBar.android";
import { LiquidGlassTarget } from "../../../native/LiquidGlass";
import { AndroidHomeFabLayout } from "../../home/AndroidHomeFab";
import { useAndroidFloatingTabs } from "../../settings/appearance/AppearancePreferencesProvider";
import type { ThreadListDrawerContextValue } from "../../threads/thread-list-drawer";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { AndroidWorkspaceNavigation, FloatingWorkspaceTabs } from "./AndroidWorkspaceNavigation";
import { WorkspaceThreadSidebar } from "./WorkspaceThreadSidebar";

/** The compact window's sidebar: Home's thread list, compose button and navigation in a drawer. */
export function ThreadListDrawerPanel(props: {
  readonly drawer: ThreadListDrawerContextValue;
  readonly width: number;
}) {
  const { drawer, width } = props;
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const safeAreaInsets = useSafeAreaInsets();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  const startNewTaskFromDrawer = () => {
    drawer.closeDrawer();
    startNewTask();
  };
  return (
    <View className="flex-1">
      <SafeAreaInsetsContext
        value={floatingTabsEnabled ? safeAreaInsets : { ...safeAreaInsets, bottom: 0 }}
      >
        <LiquidGlassTarget style={{ flex: 1 }}>
          <WorkspaceAppBarScope>
            <AndroidHomeFabLayout onStartNewTask={startNewTaskFromDrawer}>
              <WorkspaceThreadSidebar
                drawer={{ width, visible: drawer.open, close: drawer.closeDrawer }}
              />
            </AndroidHomeFabLayout>
          </WorkspaceAppBarScope>
        </LiquidGlassTarget>
      </SafeAreaInsetsContext>
      {floatingTabsEnabled ? (
        <FloatingWorkspaceTabs
          glass
          paneWidth={width}
          onNewThread={startNewTaskFromDrawer}
          onSelect={drawer.closeDrawer}
        />
      ) : (
        <AndroidWorkspaceNavigation
          paneWidth={width}
          onNewThread={startNewTaskFromDrawer}
          onSelect={drawer.closeDrawer}
        />
      )}
    </View>
  );
}
