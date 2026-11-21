import { useMemo, useState } from "react";
import { Platform } from "react-native";
import { useGT } from "gt-react-native";
import type { AssistantCitation } from "@t3tools/contracts";
import { parseAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { AssistantCitationSheet } from "../components/AssistantCitationSheet";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";

import { MobileEnrichedMarkdownText } from "./EnrichedMarkdownText";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import {
  useBlockingGestureTags,
  useCoveredByThreadDrawer,
} from "../features/threads/thread-list-drawer";

export type {
  MarkdownFileContextMenu,
  MarkdownFileContextMenuAction,
  MarkdownImageRenderer,
  MarkdownImageRequest,
  MarkdownImageSourceResolver,
  MarkdownLinkCustomization,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "./SelectableMarkdownText.types";

export function SelectableMarkdownText(props: SelectableMarkdownTextProps) {
  const [citation, setCitation] = useState<AssistantCitation | null>(null);
  const gt = useGT();
  const hasCitations = props.markdown.includes("t3-citation:");
  const theme = useUniwindTheme();
  // Over-wide tables and code blocks are horizontally scrollable natively; the
  // drawer pans learn those touches through the fork's blockingGestureTags.
  const blockingGestureTags = useBlockingGestureTags();
  const coveredByDrawer = useCoveredByThreadDrawer();
  const selectionColor = themeColorWithAlpha(theme["--color-focus"], 0.32);
  const selectionHandleColor = theme["--color-focus"];
  const textStyle = useMemo(
    () =>
      Platform.OS === "android"
        ? { selectionColor, selectionHandleColor, ...props.textStyle }
        : props.textStyle,
    [props.textStyle, selectionColor, selectionHandleColor],
  );
  return (
    <>
      <MobileEnrichedMarkdownText
        {...props}
        blockingGestureTags={blockingGestureTags}
        selectable={(props.selectable ?? true) && !coveredByDrawer}
        textStyle={textStyle}
        onLinkPress={
          hasCitations
            ? (href) => {
                const quote = parseAssistantCitationHref(href);
                if (quote) setCitation(quote);
                else props.onLinkPress?.(href);
              }
            : props.onLinkPress
        }
        fileContextMenu={
          hasCitations
            ? (href) =>
                parseAssistantCitationHref(href)
                  ? {
                      title: gt("Assistant quote"),
                      actions: [
                        { id: "open-quote", title: gt("Open quote") },
                        { id: "copy-quote", title: gt("Copy quote") },
                      ],
                    }
                  : props.fileContextMenu?.(href)
            : props.fileContextMenu
        }
        onFileContextMenuAction={
          hasCitations
            ? (href, actionId) => {
                const quote = parseAssistantCitationHref(href);
                if (quote) {
                  if (actionId === "open-quote") setCitation(quote);
                  else if (actionId === "copy-quote") copyTextWithHaptic(quote.text);
                } else props.onFileContextMenuAction?.(href, actionId);
              }
            : props.onFileContextMenuAction
        }
      />
      {citation ? (
        <AssistantCitationSheet citation={citation} onClose={() => setCitation(null)} />
      ) : null}
    </>
  );
}
