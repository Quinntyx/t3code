import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type Ref,
} from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useGT } from "gt-react-native";
import type { ChatAttachmentId, EnvironmentId } from "@t3tools/contracts";
import {
  formatScratchImageMarkdown,
  insertQuickDraftIntoScratch,
  mergeScratchMarkdown3Way,
  splitScratchMarkdownBlocks,
} from "@t3tools/shared/scratchDocument";

import { AppText as Text } from "../../components/ui/AppText";
import { ComposerEditor, type ComposerEditorSelection } from "../../components/ComposerEditor";
import { MobileEnrichedMarkdownText } from "../../native/EnrichedMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { convertPastedImagesToAttachments, pickComposerImages } from "../../lib/composerImages";
import { useAssetUrl } from "../../state/assets";
import { useCachedAssetImageUri } from "../../state/cached-asset-image";
import {
  adjustArmedScratchRange,
  armScratchRange,
  extendScratchRange,
  rebaseArmedScratchRange,
  trimScratchRange,
  type ArmedScratchRange,
  type ScratchSpace,
} from "../../state/scratch-space";
import { uploadScratchImage } from "../../state/scratch";

const ASSET_RESOURCE_KIND = { _tag: "attachment" } as const;

function ScratchImageView(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: ChatAttachmentId;
  readonly alt: string;
  readonly removable: boolean;
  readonly onRemove: () => void;
}) {
  const gt = useGT();
  const resource = useMemo(
    () => ({ ...ASSET_RESOURCE_KIND, attachmentId: props.attachmentId }),
    [props.attachmentId],
  );
  const signed = useAssetUrl(props.environmentId, resource);
  const uri = useCachedAssetImageUri(props.environmentId, resource, signed);
  const label = props.alt.length > 0 ? props.alt : gt("Image");
  return (
    <View className="relative overflow-hidden rounded-xl border border-border bg-card">
      {uri === null ? (
        <View className="h-40 w-full items-center justify-center bg-secondary/40">
          <ActivityIndicator size="small" />
        </View>
      ) : (
        <Image
          accessibilityLabel={label}
          className="h-48 w-full"
          resizeMode="contain"
          source={{ uri }}
        />
      )}
      {props.removable ? (
        <Pressable
          accessibilityLabel={gt("Remove image from scratch")}
          accessibilityRole="button"
          className="absolute right-2 top-2 h-7 w-7 items-center justify-center rounded-full bg-background/85 active:opacity-65"
          hitSlop={6}
          onPress={props.onRemove}
        >
          <Text className="text-sm text-foreground">×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export interface MobileScratchCanvasHandle {
  readonly commitPendingEdits: () => void;
  readonly focusRemembered: () => void;
  readonly blurAndSave: () => void;
  readonly armBlockAt: (index: number, selectionStart?: number) => boolean;
}

export interface ScratchCanvasProps {
  readonly ref?: Ref<MobileScratchCanvasHandle>;
  readonly space: ScratchSpace;
  readonly armed: ArmedScratchRange | null;
  readonly scrollY?: number | undefined;
  readonly onScrollYChange?: ((scrollY: number) => void) | undefined;
  readonly onCursorOffsetChange?: ((cursorOffset: number) => void) | undefined;
  readonly onEditorFocusChange?: ((focused: boolean) => void) | undefined;
  readonly onActiveSelectionChange?:
    | ((
        selection: { readonly index: number; readonly start: number; readonly end: number } | null,
      ) => void)
    | undefined;
  readonly onArmedSend?: ((mode: "foreground" | "background") => void) | undefined;
  readonly readOnly?: boolean | undefined;
}

interface PendingBlockEdit {
  readonly index: number;
  readonly originalMarkdown: string;
  readonly originalFullMarkdown: string;
  readonly originalStartOffset: number;
  readonly originalEndOffset: number;
  readonly text: string;
  readonly caretOffset?: number;
}

/**
 * Document-style block list for mobile scratch: unfocused blocks render markdown inline,
 * tapping edits in place with native keyboard + image paste, and long-pressing arms a contiguous
 * range while dimming and locking everything outside it.
 */
export function ScratchCanvas({
  ref,
  space,
  armed,
  scrollY,
  onScrollYChange,
  onCursorOffsetChange,
  onEditorFocusChange,
  onActiveSelectionChange,
  onArmedSend,
  readOnly,
}: ScratchCanvasProps) {
  const gt = useGT();
  const { nativeTextStyle } = useMarkdownPreviewStyles();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [editingSelection, setEditingSelection] = useState<ComposerEditorSelection | undefined>(
    undefined,
  );
  const editingDraftRef = useRef<PendingBlockEdit | null>(null);
  const [appending, setAppending] = useState<number | null>(null);
  const [appendDraft, setAppendDraft] = useState("");
  const appendDraftRef = useRef("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const restoredKeyRef = useRef<string | null>(null);

  const armedHere = armed !== null && armed.scratchKey === space.scratchKey;
  const inArmedRange = useCallback(
    (index: number) => armedHere && index >= armed.startIndex && index <= armed.endIndex,
    [armed, armedHere],
  );
  const blocks = space.blocks;

  const renderedBlocks = useMemo(
    () => (appending === null ? blocks : [...blocks, null]),
    [appending, blocks],
  );

  // Rebase the armed index range and active editor index when remote edits prepend/shift blocks.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps armed range and active block editor anchored across remote updates
  useEffect(() => {
    if (armedHere) {
      rebaseArmedScratchRange(space.scratchKey, blocks);
    }
    const activeEdit = editingDraftRef.current;
    if (activeEdit !== null && blocks[activeEdit.index]?.markdown !== activeEdit.originalMarkdown) {
      const matches: number[] = [];
      for (let i = 0; i < blocks.length; i += 1) {
        if (blocks[i]?.markdown === activeEdit.originalMarkdown) matches.push(i);
      }
      if (matches.length === 1) {
        const nextIndex = matches[0]!;
        editingDraftRef.current = { ...activeEdit, index: nextIndex };
        // oxlint-disable-next-line react/set-state-in-effect -- keeps active ComposerEditor mounted at its rebased block index after remote prepend
        setEditingIndex(nextIndex);
      }
    }
  }, [armedHere, blocks, space.scratchKey]);

  // Restore scroll only once the document snapshot has loaded and rendered its blocks.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores saved scroll offset once per scratch key after load
  useEffect(() => {
    if (
      !space.state.loaded ||
      restoredKeyRef.current === space.scratchKey ||
      scrollY === undefined ||
      scrollY <= 0
    ) {
      return;
    }
    restoredKeyRef.current = space.scratchKey;
    scrollRef.current?.scrollTo({ y: scrollY, animated: false });
  }, [scrollY, space.scratchKey, space.state.loaded]);

  const applyPendingBlockEdit = useCallback(
    (pending: PendingBlockEdit): number | null => {
      if (pending.text === pending.originalMarkdown) return null;
      const currentMarkdown = space.store.getState().markdown;
      const prevBlocks = splitScratchMarkdownBlocks(currentMarkdown);
      const block = prevBlocks[pending.index];
      let next: string;
      let nextCursor: number;
      const localCaret = Math.max(
        0,
        Math.min(pending.caretOffset ?? pending.text.length, pending.text.length),
      );
      if (block !== undefined && block.markdown === pending.originalMarkdown) {
        const rawNext = `${currentMarkdown.slice(0, block.startOffset)}${pending.text}${currentMarkdown.slice(block.endOffset)}`;
        next =
          pending.text.trim().length === 0 ? rawNext.replace(/\n{3,}/g, "\n\n").trim() : rawNext;
        nextCursor = Math.min(block.startOffset + localCaret, next.length);
      } else {
        // A remote update shifted or changed this block while editing: merge via 3-way diff instead of discarding.
        const rawLocal = `${pending.originalFullMarkdown.slice(0, pending.originalStartOffset)}${pending.text}${pending.originalFullMarkdown.slice(pending.originalEndOffset)}`;
        const localFull =
          pending.text.trim().length === 0 ? rawLocal.replace(/\n{3,}/g, "\n\n").trim() : rawLocal;
        next = mergeScratchMarkdown3Way(pending.originalFullMarkdown, localFull, currentMarkdown);
        nextCursor = Math.min(pending.originalStartOffset + localCaret, next.length);
      }
      const nextBlocks = splitScratchMarkdownBlocks(next);
      space.store.edit(next, nextCursor);
      if (block !== undefined && block.markdown === pending.originalMarkdown) {
        adjustArmedScratchRange(
          space.scratchKey,
          pending.index,
          nextBlocks.length - prevBlocks.length,
          nextBlocks.length,
          nextBlocks,
        );
      }
      return nextCursor;
    },
    [space.scratchKey, space.store],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- flushes any active block or append draft if the screen unmounts before blur
  useEffect(() => {
    return () => {
      const pendingEdit = editingDraftRef.current;
      editingDraftRef.current = null;
      if (pendingEdit !== null) {
        applyPendingBlockEdit(pendingEdit);
      }
      const pending = appendDraftRef.current;
      appendDraftRef.current = "";
      if (pending.trim().length > 0) {
        const current = space.store.getState();
        const inserted = insertQuickDraftIntoScratch({
          markdown: current.markdown,
          cursorOffset: current.markdown.length,
          insertedMarkdown: pending,
        });
        space.store.edit(inserted.nextMarkdown, inserted.nextCursorOffset);
      }
    };
  }, [applyPendingBlockEdit, space.store]);

  const commitActiveEdit = useCallback(() => {
    const pendingEdit = editingDraftRef.current;
    editingDraftRef.current = null;
    if (pendingEdit !== null) {
      const nextCursor = applyPendingBlockEdit(pendingEdit);
      if (nextCursor !== null) onCursorOffsetChange?.(nextCursor);
    }
    const pendingAppend = appendDraftRef.current;
    appendDraftRef.current = "";
    if (pendingAppend.trim().length > 0) {
      const current = space.store.getState();
      const inserted = insertQuickDraftIntoScratch({
        markdown: current.markdown,
        cursorOffset: current.markdown.length,
        insertedMarkdown: pendingAppend,
      });
      space.store.edit(inserted.nextMarkdown, inserted.nextCursorOffset);
      onCursorOffsetChange?.(inserted.nextCursorOffset);
      setAppendDraft("");
      setAppending(null);
    }
    setEditingIndex(null);
    setEditingDraft("");
    setEditingSelection(undefined);
  }, [applyPendingBlockEdit, onCursorOffsetChange, space.store]);

  // Only commits/closes on blur if this block is still the active editor (tapping another block already committed & switched).
  const commitEditForIndex = useCallback(
    (index: number) => {
      if (editingDraftRef.current?.index !== index) return;
      commitActiveEdit();
      space.store.setCursorOffset(space.store.getState().lastCursorOffset, { immediate: true });
    },
    [commitActiveEdit, space.store],
  );

  const startEditingBlock = useCallback(
    (index: number, initialSelection?: ComposerEditorSelection) => {
      commitActiveEdit();
      const liveMarkdown = space.store.getState().markdown;
      const liveBlocks = splitScratchMarkdownBlocks(liveMarkdown);
      const block = liveBlocks[index];
      if (block === undefined || block.kind === "image") return;
      editingDraftRef.current = {
        index,
        originalMarkdown: block.markdown,
        originalFullMarkdown: liveMarkdown,
        originalStartOffset: block.startOffset,
        originalEndOffset: block.endOffset,
        text: block.markdown,
        caretOffset: initialSelection?.end ?? block.markdown.length,
      };
      setAppending(null);
      setEditingIndex(index);
      setEditingDraft(block.markdown);
      setEditingSelection(initialSelection);
    },
    [commitActiveEdit, space.store],
  );

  const focusRememberedBlock = useCallback(() => {
    if (readOnly) return;
    const current = space.store.getState();
    const liveBlocks = splitScratchMarkdownBlocks(current.markdown);
    if (liveBlocks.length === 0) {
      commitActiveEdit();
      setAppending(0);
      setEditingIndex(0);
      return;
    }
    const offset = current.lastCursorOffset;
    const matchIndex = liveBlocks.findIndex(
      (candidate) => offset >= candidate.startOffset && offset <= candidate.endOffset,
    );
    const targetIndex = matchIndex >= 0 ? matchIndex : liveBlocks.length - 1;
    const target = liveBlocks[targetIndex];
    if (target !== undefined && target.kind !== "image") {
      const localCaret = Math.max(0, Math.min(offset - target.startOffset, target.markdown.length));
      startEditingBlock(targetIndex, { start: localCaret, end: localCaret });
    } else {
      commitActiveEdit();
      setAppending(liveBlocks.length);
      setEditingIndex(liveBlocks.length);
    }
  }, [commitActiveEdit, readOnly, space.store, startEditingBlock]);

  const arm = useCallback(
    (index: number, selectionStart?: number): boolean => {
      if (readOnly) return false;
      const pendingEdit = editingDraftRef.current;
      const pendingAppend = appendDraftRef.current;
      const preCommitMarkdown = space.store.getState().markdown;
      commitActiveEdit();
      const postCommitMarkdown = space.store.getState().markdown;
      const liveBlocks = splitScratchMarkdownBlocks(postCommitMarkdown);
      let targetIndex = index;
      if (selectionStart !== undefined && liveBlocks.length > 0) {
        const baseStart =
          pendingEdit !== null
            ? pendingEdit.originalStartOffset
            : pendingAppend.trim().length > 0
              ? preCommitMarkdown.length + (preCommitMarkdown.trim().length > 0 ? 2 : 0)
              : (liveBlocks[index]?.startOffset ?? 0);
        const docOffset = Math.max(
          0,
          Math.min(baseStart + selectionStart, postCommitMarkdown.length),
        );
        const matched = liveBlocks.findIndex(
          (candidate) => docOffset >= candidate.startOffset && docOffset <= candidate.endOffset,
        );
        if (matched >= 0) targetIndex = matched;
      }
      if (targetIndex < 0 || targetIndex >= liveBlocks.length) return false;
      armScratchRange(space.scratchKey, targetIndex, liveBlocks);
      setAppending(null);
      const targetBlock = liveBlocks[targetIndex];
      if (targetBlock !== undefined && targetBlock.kind === "text") {
        editingDraftRef.current = {
          index: targetIndex,
          originalMarkdown: targetBlock.markdown,
          originalFullMarkdown: postCommitMarkdown,
          originalStartOffset: targetBlock.startOffset,
          originalEndOffset: targetBlock.endOffset,
          text: targetBlock.markdown,
          caretOffset: targetBlock.markdown.length,
        };
        setEditingIndex(targetIndex);
        setEditingDraft(targetBlock.markdown);
        setEditingSelection({
          start: targetBlock.markdown.length,
          end: targetBlock.markdown.length,
        });
      }
      return true;
    },
    [commitActiveEdit, readOnly, space.scratchKey, space.store],
  );

  useImperativeHandle(
    ref,
    () => ({
      commitPendingEdits: commitActiveEdit,
      focusRemembered: focusRememberedBlock,
      blurAndSave: () => {
        commitActiveEdit();
        space.store.setCursorOffset(space.store.getState().lastCursorOffset, { immediate: true });
      },
      armBlockAt: arm,
    }),
    [arm, commitActiveEdit, focusRememberedBlock, space.store],
  );

  const insertAtCursor = useCallback(
    (insertedMarkdown: string) => {
      if (insertedMarkdown.trim().length === 0) return;
      const current = space.store.getState();
      const prevBlocks = splitScratchMarkdownBlocks(current.markdown);
      const anchorIndex = prevBlocks.findIndex(
        (candidate) =>
          current.lastCursorOffset >= candidate.startOffset &&
          current.lastCursorOffset <= candidate.endOffset,
      );
      const inserted = insertQuickDraftIntoScratch({
        markdown: current.markdown,
        cursorOffset: current.lastCursorOffset,
        insertedMarkdown,
      });
      const nextBlocks = splitScratchMarkdownBlocks(inserted.nextMarkdown);
      space.store.edit(inserted.nextMarkdown, inserted.nextCursorOffset);
      if (nextBlocks.length !== prevBlocks.length) {
        adjustArmedScratchRange(
          space.scratchKey,
          anchorIndex >= 0 ? anchorIndex : prevBlocks.length,
          nextBlocks.length - prevBlocks.length,
          nextBlocks.length,
          nextBlocks,
        );
      }
      onCursorOffsetChange?.(inserted.nextCursorOffset);
    },
    [onCursorOffsetChange, space.scratchKey, space.store],
  );

  const removeBlock = useCallback(
    (index: number) => {
      const currentMarkdown = space.store.getState().markdown;
      const prevBlocks = splitScratchMarkdownBlocks(currentMarkdown);
      const block = prevBlocks[index];
      if (block === undefined) return;
      const next =
        `${currentMarkdown.slice(0, block.startOffset)}${currentMarkdown.slice(block.endOffset)}`
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      const nextCursor = Math.min(block.startOffset, next.length);
      const nextBlocks = splitScratchMarkdownBlocks(next);
      space.store.edit(next, nextCursor);
      if (nextBlocks.length !== prevBlocks.length) {
        adjustArmedScratchRange(
          space.scratchKey,
          index,
          nextBlocks.length - prevBlocks.length,
          nextBlocks.length,
          nextBlocks,
        );
      }
      onCursorOffsetChange?.(nextCursor);
      editingDraftRef.current = null;
      setEditingIndex(null);
      setEditingDraft("");
      setEditingSelection(undefined);
    },
    [onCursorOffsetChange, space.scratchKey, space.store],
  );

  const uploadImage = useCallback(
    async (image: {
      readonly uri: string;
      readonly name: string;
      readonly mimeType: string;
      readonly width?: number;
      readonly height?: number;
    }) => {
      const attachment = await uploadScratchImage({
        environmentId: space.environmentId,
        scratchKey: space.scratchKey,
        uri: image.uri,
        name: image.name,
        mimeType: image.mimeType,
        ...(image.width == null ? {} : { width: image.width }),
        ...(image.height == null ? {} : { height: image.height }),
      });
      insertAtCursor(formatScratchImageMarkdown(attachment.attachmentId, attachment.name));
    },
    [insertAtCursor, space.environmentId, space.scratchKey],
  );

  const runUploads = useCallback(
    async (images: ReadonlyArray<Parameters<typeof uploadImage>[0]>) => {
      setUploading(true);
      setError(null);
      await (async () => {
        for (const image of images) await uploadImage(image);
      })()
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : gt("Could not add that image."));
        })
        .finally(() => {
          setUploading(false);
        });
    },
    [gt, uploadImage],
  );

  const pasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      commitActiveEdit();
      const converted = await convertPastedImagesToAttachments({ uris });
      if (converted.error !== null && converted.attachments.length === 0) {
        setError(converted.error);
        return;
      }
      await runUploads(
        converted.attachments.flatMap((image) => {
          const uri = image.fileUri ?? image.dataUrl ?? image.previewUri;
          if (!uri) return [];
          return [{ uri, name: image.name, mimeType: image.mimeType }];
        }),
      );
      if (converted.error !== null) {
        setError(converted.error);
      }
    },
    [commitActiveEdit, runUploads],
  );

  const addImages = useCallback(async () => {
    const picked = await pickComposerImages({ existingCount: 0 });
    if (picked.error !== null) {
      setError(picked.error);
      return;
    }
    await runUploads(
      picked.images.flatMap((image) => {
        const uri = image.fileUri ?? image.previewUri ?? image.dataUrl;
        if (!uri) return [];
        return [{ uri, name: image.name, mimeType: image.mimeType }];
      }),
    );
  }, [runUploads]);

  const extend = useCallback(
    (index: number) => {
      if (readOnly) return;
      extendScratchRange(space.scratchKey, index, blocks);
    },
    [blocks, readOnly, space.scratchKey],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onScrollYChange?.(event.nativeEvent.contentOffset.y);
    },
    [onScrollYChange],
  );

  return (
    <View className="flex-1 px-4" testID="scratch-canvas">
      <View className="flex-row items-center justify-end gap-1 pb-1">
        {uploading ? <ActivityIndicator size="small" /> : null}
        {armedHere ? (
          <>
            <Pressable
              accessibilityLabel={gt("Trim top of selection")}
              accessibilityRole="button"
              className="h-7 w-7 items-center justify-center rounded-full bg-secondary active:opacity-65"
              hitSlop={6}
              onPress={() => trimScratchRange(space.scratchKey, "start", blocks)}
            >
              <Text className="text-xs text-foreground">▲</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={gt("Trim bottom of selection")}
              accessibilityRole="button"
              className="h-7 w-7 items-center justify-center rounded-full bg-secondary active:opacity-65"
              hitSlop={6}
              onPress={() => trimScratchRange(space.scratchKey, "end", blocks)}
            >
              <Text className="text-xs text-foreground">▼</Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            accessibilityLabel={gt("Add image to scratch")}
            accessibilityRole="button"
            className="h-7 w-7 items-center justify-center rounded-full active:opacity-65"
            disabled={uploading || readOnly}
            hitSlop={6}
            onPress={() => void addImages()}
          >
            <Text className="text-base text-foreground-muted">⊕</Text>
          </Pressable>
        )}
      </View>

      {error !== null ? <Text className="pb-1 text-xs text-destructive">{error}</Text> : null}

      <ScrollView
        ref={scrollRef}
        alwaysBounceVertical={false}
        className="flex-1"
        contentContainerClassName="grow gap-1.5 pb-6"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={80}
        showsVerticalScrollIndicator={false}
      >
        {blocks.length === 0 && appending === null ? (
          <Pressable
            accessibilityLabel={gt("Scratch document")}
            accessibilityRole="button"
            className="flex-1 py-4"
            disabled={readOnly}
            onPress={() => {
              commitActiveEdit();
              setAppending(0);
              setEditingIndex(0);
            }}
          />
        ) : null}

        {renderedBlocks.map((block, index) => {
          const armedBlock = inArmedRange(index);
          const outsideArmed = armedHere && !armedBlock;
          const isEditing = editingIndex === index && (!armedHere || armedBlock);
          const dimmed = outsideArmed;
          return (
            <View
              key={block === null ? "trailing" : String(index)}
              className="flex-row gap-2"
              style={{ opacity: dimmed ? 0.35 : 1 }}
            >
              <View
                className={
                  armedBlock
                    ? "w-[3px] rounded-full bg-primary"
                    : "w-[3px] rounded-full bg-transparent"
                }
              />
              <View
                className={
                  armedBlock
                    ? "min-w-0 flex-1 rounded-xl bg-primary/10 px-2.5 py-1.5"
                    : "min-w-0 flex-1 rounded-xl px-1 py-0.5"
                }
              >
                {block === null ? (
                  <ComposerEditor
                    autoFocus
                    multiline
                    scrollEnabled={false}
                    value={appendDraft}
                    onFocus={() => onEditorFocusChange?.(true)}
                    onChangeText={(text) => {
                      appendDraftRef.current = text;
                      setAppendDraft(text);
                    }}
                    onBlur={() => {
                      onEditorFocusChange?.(false);
                      onActiveSelectionChange?.(null);
                      const pending = appendDraftRef.current;
                      appendDraftRef.current = "";
                      setAppendDraft("");
                      setAppending(null);
                      if (editingDraftRef.current === null) {
                        setEditingIndex(null);
                      }
                      if (pending.trim().length > 0) {
                        const current = space.store.getState();
                        const inserted = insertQuickDraftIntoScratch({
                          markdown: current.markdown,
                          cursorOffset: current.markdown.length,
                          insertedMarkdown: pending,
                        });
                        space.store.edit(inserted.nextMarkdown, inserted.nextCursorOffset);
                        onCursorOffsetChange?.(inserted.nextCursorOffset);
                      }
                    }}
                    onSelectionChange={(selection) => {
                      onActiveSelectionChange?.({
                        index,
                        start: selection.start,
                        end: selection.end,
                      });
                    }}
                    onPasteImages={(uris) => void pasteImages(uris)}
                    placeholder=""
                  />
                ) : block.kind === "image" ? (
                  <Pressable
                    accessibilityRole="imagebutton"
                    delayLongPress={300}
                    onLongPress={() => arm(index)}
                    onPress={() => {
                      if (outsideArmed) {
                        extend(index);
                      } else {
                        commitActiveEdit();
                        setEditingIndex(isEditing ? null : index);
                      }
                    }}
                  >
                    <ScratchImageView
                      environmentId={space.environmentId}
                      attachmentId={block.attachmentId as ChatAttachmentId}
                      alt={block.alt}
                      removable={isEditing && !readOnly}
                      onRemove={() => removeBlock(index)}
                    />
                  </Pressable>
                ) : isEditing && !readOnly ? (
                  <ComposerEditor
                    autoFocus
                    multiline
                    scrollEnabled={false}
                    value={editingDraft}
                    {...(editingSelection === undefined ? {} : { selection: editingSelection })}
                    onFocus={() => onEditorFocusChange?.(true)}
                    onChangeText={(text) => {
                      const prev = editingDraftRef.current;
                      editingDraftRef.current =
                        prev !== null && prev.index === index
                          ? { ...prev, text }
                          : {
                              index,
                              originalMarkdown: block.markdown,
                              originalFullMarkdown: space.store.getState().markdown,
                              originalStartOffset: block.startOffset,
                              originalEndOffset: block.endOffset,
                              text,
                            };
                      setEditingDraft(text);
                      setEditingSelection(undefined);
                    }}
                    onBlur={() => {
                      onEditorFocusChange?.(false);
                      onActiveSelectionChange?.(null);
                      commitEditForIndex(index);
                    }}
                    onSelectionChange={(selection) => {
                      const active = editingDraftRef.current;
                      if (active !== null && active.index === index) {
                        editingDraftRef.current = {
                          ...active,
                          caretOffset: selection.end,
                        };
                      }
                      onActiveSelectionChange?.({
                        index,
                        start: selection.start,
                        end: selection.end,
                      });
                      const hasUncommittedText =
                        active !== null &&
                        active.index === index &&
                        active.text !== active.originalMarkdown;
                      if (!hasUncommittedText) {
                        const nextOffset = block.startOffset + selection.end;
                        space.store.setCursorOffset(nextOffset);
                        onCursorOffsetChange?.(nextOffset);
                      }
                    }}
                    {...(armedHere && armedBlock && onArmedSend !== undefined
                      ? {
                          enterBehavior: "send" as const,
                          onSubmit: (alternate: boolean) =>
                            onArmedSend(alternate ? "background" : "foreground"),
                        }
                      : {})}
                    onPasteImages={(uris) => void pasteImages(uris)}
                    placeholder=""
                  />
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    delayLongPress={300}
                    onLongPress={() => arm(index)}
                    onPress={() => {
                      if (outsideArmed) {
                        extend(index);
                      } else if (!readOnly) {
                        startEditingBlock(index);
                      }
                    }}
                  >
                    <MobileEnrichedMarkdownText
                      markdown={block.markdown}
                      preserveSoftBreaks
                      textStyle={nativeTextStyle}
                    />
                  </Pressable>
                )}
              </View>
            </View>
          );
        })}

        {appending === null && blocks.length > 0 && !armedHere && !readOnly ? (
          <Pressable
            accessibilityLabel={gt("Write at end of scratch")}
            accessibilityRole="button"
            className="min-h-20 flex-1"
            onPress={() => {
              commitActiveEdit();
              space.store.setCursorOffset(space.store.getState().markdown.length);
              setAppending(blocks.length);
              setEditingIndex(blocks.length);
            }}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
