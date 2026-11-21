import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

/** Android sets the card against a grouped page under a floating header. */
export const ATTACHMENT_VIEWER_PAGE_CLASS_NAME =
  Platform.OS === "android" ? "flex-1 bg-grouped-card" : "flex-1 bg-sheet";

export function AttachmentViewerCard(props: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  if (Platform.OS !== "android") return props.children;
  return (
    <View
      className="mx-3 flex-1 overflow-hidden rounded-[24px] border border-border border-continuous bg-sheet"
      style={{ marginBottom: insets.bottom + 12 }}
    >
      {/* The card's margin already clears the navigation bar. */}
      <SafeAreaInsetsContext value={{ ...insets, bottom: 0 }}>
        {props.children}
      </SafeAreaInsetsContext>
    </View>
  );
}
