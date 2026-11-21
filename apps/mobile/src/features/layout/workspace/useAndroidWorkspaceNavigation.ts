import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { BackHandler, Keyboard, Platform } from "react-native";
import {
  resetAndroidWorkspace,
  returnToAndroidWorkspaceList,
} from "../../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

export function useWorkspaceListNavigation(tab: WorkspaceTab) {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  return () => {
    if (Platform.OS === "android") {
      dispatch?.({ type: "select", tab });
      resetAndroidWorkspace(navigation);
    } else if (navigation.canGoBack()) navigation.goBack();
    else navigation.dispatch(StackActions.replace("Home"));
  };
}

export function useWorkspaceBackNavigation() {
  const navigation = useNavigation();
  return () => {
    if (Platform.OS === "android") returnToAndroidWorkspaceList(navigation);
    else if (navigation.canGoBack()) navigation.goBack();
    else navigation.dispatch(StackActions.replace("Home"));
  };
}

export function useAndroidWorkspaceBack() {
  const goBack = useWorkspaceBackNavigation();
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (Keyboard.isVisible()) Keyboard.dismiss();
        else goBack();
        return true;
      });
      return () => subscription.remove();
    }, [goBack]),
  );
  return goBack;
}
