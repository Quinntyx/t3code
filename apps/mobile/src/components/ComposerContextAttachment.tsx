import { Button } from "./ui/Button";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Dialog from "./ui/Dialog";
import type { ComposerContextRecord, EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { useEffect, useId, useRef, useState } from "react";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { composerAttachmentInlineUri, isFileBackedComposerAttachment } from "../lib/composerImages";
import {
  loadLocalAttachmentPreview,
  useLocalAttachmentPreview,
} from "../lib/localAttachmentPreview";
import { downloadAndShareAttachment, downloadAttachmentToDevice } from "../lib/attachmentDownload";
import { canSaveFileToDownloads } from "../lib/saveToDevice";
import { assetImageSource } from "../lib/assetImageSource";
import { useAssetUrlState, useRefreshAssetUrl } from "../state/assets";
import { AppText as Text } from "./ui/AppText";
import { FilePreviewModal } from "./ui/FilePreviewModal";
import { PresentationSource } from "./ui/NativePresentation";

export function ComposerContextAttachment(props: {
  record: Extract<ComposerContextRecord, { attachmentId: string }>;
  environmentId?: EnvironmentId;
  attachment?: DraftComposerAttachment;
}) {
  const { record, attachment } = props;
  const shareSourceIdentifier = useId();
  const resource = {
    _tag: "attachment" as const,
    attachmentId: record.attachmentId,
    fileName: record.name,
  };
  const local = attachment?.fileUri
    ? (attachment as DraftComposerAttachment & { fileUri: string })
    : undefined;
  const inlineUri = composerAttachmentInlineUri(attachment);
  const remoteEnvironmentId = local || inlineUri ? null : (props.environmentId ?? null);
  const asset = useAssetUrlState(remoteEnvironmentId, resource);
  const refresh = useRefreshAssetUrl(remoteEnvironmentId, resource);
  const localPreview = useLocalAttachmentPreview(local ?? null);
  const error = localPreview.error ? "The local file is unavailable. Attach it again." : null;
  const [busy, setBusy] = useState<"share" | "download" | null>(null);
  const task = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts an in-flight share or download when the attachment closes
  useEffect(() => () => task.current?.abort(), []);
  const [previewOpen, setPreviewOpen] = useState(false);
  const uri = local
    ? localPreview.uri
    : (inlineUri ?? (asset._tag === "Success" ? asset.url : null));
  const run = async (kind: "share" | "download") => {
    if (busy) return;
    setBusy(kind);
    const controller = new AbortController();
    task.current = controller;
    const { signal } = controller;
    const result = await settlePromise(async () => {
      if (local) {
        const preview = await loadLocalAttachmentPreview(local, signal);
        if (!preview) return;
        const done = await settlePromise(() =>
          kind === "download"
            ? downloadAttachmentToDevice({ uri: preview.uri, attachment: record, signal })
            : preview.share(signal, shareSourceIdentifier),
        );
        preview.dispose();
        if (AsyncResult.isFailure(done)) throw squashAtomCommandFailure(done);
        return;
      }
      const url = await refresh();
      if (!url) throw new Error("Reconnect to the environment and try again.");
      if (kind === "download") {
        await downloadAttachmentToDevice({ uri: url, attachment: record, signal });
        return;
      }
      await downloadAndShareAttachment({
        url,
        attachment: record,
        signal,
        sourceIdentifier: shareSourceIdentifier,
      });
    });
    if (task.current === controller) task.current = null;
    if (signal.aborted) return;
    setBusy(null);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        kind === "download" ? "Could not download attachment" : "Could not open attachment",
        cause instanceof Error ? cause.message : "Try again.",
      );
    }
  };
  return (
    <View className="gap-3">
      {record.kind === "image" && uri ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Preview ${record.name}`}
          onPress={() => setPreviewOpen(true)}
        >
          <Image
            source={
              remoteEnvironmentId === null
                ? { uri }
                : assetImageSource(remoteEnvironmentId, resource, uri)
            }
            style={{ width: "100%", height: 280 }}
            contentFit="contain"
            accessibilityLabel={record.name}
          />
        </Pressable>
      ) : null}
      {error || (!local && asset._tag === "Failure") ? (
        <Text className="text-foreground-muted">
          {error ?? "Attachment unavailable. Reconnect and try again."}
        </Text>
      ) : null}
      {canSaveFileToDownloads() ? (
        <Button
          label={busy === "download" ? "Downloading…" : "Download attachment"}
          tone="secondary"
          disabled={busy !== null}
          onPress={() => void run("download")}
          fullWidth
          loading={busy === "download"}
        />
      ) : null}
      <PresentationSource identifier={shareSourceIdentifier}>
        <Button
          label={busy === "share" ? "Opening attachment…" : "Open or share attachment"}
          tone="secondary"
          disabled={busy !== null}
          onPress={() => void run("share")}
          fullWidth
          loading={busy === "share"}
        />
      </PresentationSource>
      {previewOpen && record.kind === "image" && uri ? (
        <FilePreviewModal
          source={{
            kind: "image",
            name: record.name,
            uri,
            actionsSource: {
              name: record.name,
              mimeType: record.mimeType,
              ...(attachment && isFileBackedComposerAttachment(attachment)
                ? { attachment }
                : inlineUri === undefined && props.environmentId
                  ? { environmentId: props.environmentId, resource }
                  : { uri }),
            },
          }}
          onRequestClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </View>
  );
}
