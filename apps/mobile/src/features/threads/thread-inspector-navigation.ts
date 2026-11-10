import { StackActions, useNavigation } from "@react-navigation/native";
import { createContext, use } from "react";
import { Platform } from "react-native";

import { useWorkspacePaneState } from "../layout/AdaptiveWorkspaceLayout";

export type ThreadInspectorMode = "route" | "git" | "files" | "preview" | "details";

/**
 * The pane a thread's inspector shows. A preview target wins; the chosen mode survives thread
 * switches, and "route" applies only while the route supplies its own inspector.
 */
export function resolveThreadInspectorMode(input: {
  readonly previewing: boolean;
  readonly routeInspector: boolean;
  readonly chosen: ThreadInspectorMode | null;
  readonly hasCwd: boolean;
}): ThreadInspectorMode | null {
  if (input.previewing) return "preview";
  const mode = input.routeInspector
    ? input.chosen === null || input.chosen === "route"
      ? "route"
      : input.chosen
    : input.chosen === "route"
      ? null
      : input.chosen;
  return mode === "files" && !input.hasCwd ? null : mode;
}

export type ThreadInspectorTarget = {
  readonly type: "thread" | "device";
  readonly environmentId: string;
  readonly threadId: string;
  readonly deviceKey?: string;
};

export const ThreadInspectorNavigationContext = createContext<
  ((target: ThreadInspectorTarget) => void) | null
>(null);

export function useOpenThreadInspector() {
  const navigation = useNavigation();
  const { fileInspector } = useWorkspacePaneState();
  const openInInspector = use(ThreadInspectorNavigationContext);
  return (
    source: { readonly environmentId: string; readonly threadId: string },
    target: ThreadInspectorTarget,
  ) => {
    if (Platform.OS !== "ios" || !fileInspector.supported) return false;
    if (openInInspector) openInInspector(target);
    else {
      const parent = navigation.getState()?.routes.findLast((route) => route.name === "Thread");
      if (
        !parent?.params ||
        !("environmentId" in parent.params) ||
        parent.params.environmentId !== source.environmentId ||
        !("threadId" in parent.params) ||
        parent.params.threadId !== source.threadId
      )
        return false;
      navigation.dispatch(
        StackActions.popTo("Thread", { ...source, inspector: target }, { merge: true }),
      );
    }
    return true;
  };
}
