import { Platform } from "react-native";
import { LinearTransition, ReduceMotion } from "react-native-reanimated";

// Keep recycled Android rows out of native layout transitions to avoid stale duplicate views.
export const THREAD_SIDEBAR_ROW_LAYOUT =
  Platform.OS === "android"
    ? undefined
    : LinearTransition.duration(180).reduceMotion(ReduceMotion.System);
