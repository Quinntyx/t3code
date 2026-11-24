import { Extension, type Editor } from "@tiptap/core";
import { EditorState, Selection } from "@tiptap/pm/state";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { EnvironmentId, ScratchAttachment } from "@t3tools/contracts";
import {
  extractScratchImageIds,
  insertQuickDraftIntoScratch,
  scratchChunkPreviewTitle,
  stripScratchImagesForPrompt,
} from "@t3tools/shared/scratchDocument";
import { useGT } from "gt-react";
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  type Ref,
} from "react";
import { ImageIcon, Maximize2Icon, XIcon } from "lucide-react";

import {
  ComposerBlockExtensions,
  ComposerBoldExtension,
  ComposerCodeBlockExtension,
  ComposerCodeExtension,
  ComposerItalicExtension,
  ComposerListExtensions,
  ComposerScratchImageExtension,
  ComposerStrikeExtension,
  ComposerTaskItemExtension,
  ComposerTaskListExtension,
  buildDocJson,
  flatToMarkdown,
  flatToPm,
  markdownToFlat,
  pmToFlat,
  serializeEditorDoc,
  serializeSelection,
} from "~/composer-rich-text-doc";
import { ComposerMarkdownSourceExtension } from "~/composer-markdown-source";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import {
  armScratchSelection,
  createScratchArmPlugin,
  editBounds,
  releaseScratchArm,
  scratchArmKey,
  SCRATCH_ARM_BYPASS_META,
  snapSelectionToBlocks,
  type ScratchArmMeta,
  type ScratchArmedRange,
} from "./ScratchArmPlugin";
import { useScratchAttachmentUrl } from "./useScratchAttachmentUrl";

export interface ScratchSelection {
  readonly markdown: string;
  readonly from: number;
  readonly to: number;
}

export interface ScratchArmResult {
  readonly armed: boolean;
  readonly titlePreview?: string | undefined;
  readonly imageCount?: number | undefined;
  readonly range?: ScratchArmedRange | undefined;
}

export interface ScratchExtractedChunk {
  readonly fullMarkdown: string;
  readonly markdown: string;
  readonly prompt: string;
  readonly attachmentIds: ReadonlyArray<ScratchAttachment["attachmentId"]>;
  readonly nextMarkdown: string;
  readonly nextCursorOffset: number;
}

export interface ScratchDocumentEditorHandle {
  focusAtOffset(offset: number, options?: { readonly preventScroll?: boolean }): void;
  restoreCursorWithoutFocus(offset: number): void;
  syncRemoteCursor(offset: number): void;
  focus(): void;
  focusEnd(): void;
  getCursorOffset(): number;
  hasNonEmptySelection(): boolean;
  getArmedState(): ScratchArmedRange | null;
  getArmedMarkdown(): string;
  armSelection(): ScratchArmResult;
  releaseArmed(): void;
  extractArmedChunk(): ScratchExtractedChunk | null;
  insertBelowCursor(
    insertedMarkdown: string,
  ): { nextMarkdown: string; nextCursorOffset: number } | null;
  applyConsumedMarkdown(nextMarkdown: string, nextCursorOffset: number): void;
  setInactiveCaretVisible(visible: boolean): void;
  scrollToArmed(): void;
  waitForPendingUploads(): Promise<void>;
}

export interface UploadedScratchImage {
  readonly attachmentId: ScratchAttachment["attachmentId"];
  readonly name: string;
}

interface ScratchImageViewContextValue {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
  readonly onExpandImage?: ((url: string, alt: string) => void) | undefined;
  readonly onPreviewSuperseded?: ((previewUrl: string) => void) | undefined;
}

const ScratchImageViewContext = createContext<ScratchImageViewContextValue | null>(null);

function ScratchImageNodeView({ node, deleteNode, selected }: NodeViewProps) {
  const gt = useGT();
  const context = useContext(ScratchImageViewContext);
  const attachmentId = String(node.attrs.attachmentId ?? "");
  const alt = String(node.attrs.alt ?? "");
  const previewUrl = typeof node.attrs.previewUrl === "string" ? node.attrs.previewUrl : null;
  const resolvedUrl = useScratchAttachmentUrl(
    context?.environmentId ?? ("unavailable" as EnvironmentId),
    attachmentId.length > 0 ? attachmentId : null,
  );
  const url = resolvedUrl ?? previewUrl;

  return (
    <NodeViewWrapper
      className={cn(
        "group/image relative my-3 overflow-hidden rounded-lg border border-border/60 bg-card/30",
        selected && "ring-2 ring-ring",
      )}
      data-drag-handle
    >
      <div
        className="block w-full cursor-pointer"
        onDoubleClick={() => {
          if (url !== null) context?.onExpandImage?.(url, alt);
        }}
      >
        {url === null ? (
          <div className="flex h-40 w-full items-center justify-center bg-muted/25 text-muted-foreground">
            <ImageIcon className="size-5" />
          </div>
        ) : (
          <img
            src={url}
            alt={alt}
            decoding="async"
            loading="lazy"
            onLoad={() => {
              if (resolvedUrl !== null && previewUrl !== null && url === resolvedUrl) {
                context?.onPreviewSuperseded?.(previewUrl);
              }
            }}
            className="max-h-96 w-full object-contain"
          />
        )}
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/image:opacity-100">
        {url !== null && context?.onExpandImage !== undefined ? (
          <button
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              context.onExpandImage?.(url, alt);
            }}
            aria-label={gt("Expand image")}
            className="rounded-md bg-background/85 p-1 text-muted-foreground backdrop-blur hover:text-foreground"
          >
            <Maximize2Icon className="size-3.5" />
          </button>
        ) : null}
        {context?.readOnly ? null : (
          <button
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (context?.readOnly) return;
              deleteNode();
            }}
            aria-label={gt("Remove image")}
            className="rounded-md bg-background/85 p-1 text-muted-foreground backdrop-blur hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
    </NodeViewWrapper>
  );
}

const ScratchImageExtension = ComposerScratchImageExtension.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ScratchImageNodeView);
  },
});

interface ScratchDocumentEditorProps {
  readonly environmentId: EnvironmentId;
  readonly markdown: string;
  readonly onMarkdownChange: (markdown: string) => void;
  readonly onArmedChange?:
    | ((armed: { range: ScratchArmedRange; markdown: string } | null) => void)
    | undefined;
  readonly onArmedSend?: ((mode: "foreground" | "background") => void) | undefined;
  readonly onSelectionChange?: ((selection: ScratchSelection | null) => void) | undefined;
  readonly onCursorChange?: ((offset: number) => void) | undefined;
  readonly onUploadImage?:
    | ((file: File) => Promise<UploadedScratchImage | null> | UploadedScratchImage | null)
    | undefined;
  readonly onExpandImage?: ((url: string, alt: string) => void) | undefined;
  readonly readOnly?: boolean;
  readonly className?: string | undefined;
}

function markdownForRange(editor: Editor, from: number, to: number): string {
  return serializeSelection(editor.state.doc, from, to);
}

function markdownOffsetAt(editor: Editor, position: number): number {
  const map = serializeEditorDoc(editor.state.doc);
  return flatToMarkdown(map, pmToFlat(map, position));
}

function positionAtMarkdownOffset(editor: Editor, offset: number): number {
  const map = serializeEditorDoc(editor.state.doc);
  return Math.max(
    1,
    Math.min(flatToPm(map, markdownToFlat(map, offset)), editor.state.doc.content.size),
  );
}

function contentForMarkdown(markdown: string) {
  return buildDocJson(markdown, () => null, {
    enableScratchImages: true,
  });
}

export const ScratchDocumentEditor = forwardRef(function ScratchDocumentEditor(
  {
    environmentId,
    markdown,
    onMarkdownChange,
    onArmedChange,
    onArmedSend,
    onSelectionChange,
    onCursorChange,
    onUploadImage,
    onExpandImage,
    readOnly = false,
    className,
  }: ScratchDocumentEditorProps,
  ref: Ref<ScratchDocumentEditorHandle>,
) {
  const lastEmitted = useRef(markdown);
  const suppressUpdateRef = useRef(false);
  const suppressCursorReportRef = useRef(false);
  const externalDocSyncEpochRef = useRef(0);
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const pendingUploadsRef = useRef<Set<Promise<unknown>>>(new Set());
  const revokePreviewUrl = useStableCallback((previewUrl: string) => {
    if (previewUrlsRef.current.delete(previewUrl)) {
      URL.revokeObjectURL(previewUrl);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revokes any optimistic image blob URLs still held when the editor unmounts
  useEffect(() => {
    const urls = previewUrlsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);
  const uploadStable = useStableCallback(
    async (file: File): Promise<UploadedScratchImage | null> => {
      if (onUploadImage === undefined) return null;
      return await onUploadImage(file);
    },
  );
  const gt = useGT();
  const onMarkdownChangeStable = useStableCallback(onMarkdownChange);
  const onSelectionChangeStable = useStableCallback((selection: ScratchSelection | null) =>
    onSelectionChange?.(selection),
  );
  const onCursorChangeStable = useStableCallback((offset: number) => onCursorChange?.(offset));
  const onArmedSendStable = useStableCallback((mode: "foreground" | "background") =>
    onArmedSend?.(mode),
  );
  const onArmedChangeStable = useStableCallback(
    (armed: { range: ScratchArmedRange; markdown: string } | null) => onArmedChange?.(armed),
  );
  const onExpandImageStable = useStableCallback((url: string, alt: string) =>
    onExpandImage?.(url, alt),
  );

  const insertUploadedImage = async (
    view: Editor["view"],
    file: File,
    position: number,
  ): Promise<number | null> => {
    if (view.isDestroyed || !view.editable) return null;
    const nodeType = view.state.schema.nodes.scratchImage;
    if (nodeType === undefined) return null;
    const insertAt = Math.max(1, Math.min(position, view.state.doc.content.size));
    const armed = scratchArmKey.getState(view.state)?.armed ?? null;
    if (armed !== null) {
      const bounds = editBounds(view.state.doc, armed);
      if (insertAt < bounds.min || insertAt > bounds.max) return null;
    }
    const previewUrl = URL.createObjectURL(file);
    previewUrlsRef.current.add(previewUrl);
    view.dispatch(
      view.state.tr
        .insert(insertAt, nodeType.create({ attachmentId: "", alt: file.name, previewUrl }))
        .setMeta(SCRATCH_ARM_BYPASS_META, true),
    );
    const findPreviewPos = (): number | null => {
      let found: number | null = null;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === "scratchImage" && node.attrs.previewUrl === previewUrl) {
          found = pos;
          return false;
        }
        return true;
      });
      return found;
    };
    if (findPreviewPos() === null) {
      revokePreviewUrl(previewUrl);
      return null;
    }
    const uploadStartEpoch = externalDocSyncEpochRef.current;
    let task!: Promise<number | null>;
    task = (async () => {
      const uploaded = await uploadStable(file);
      if (view.isDestroyed) {
        revokePreviewUrl(previewUrl);
        return null;
      }
      const previewPosition = findPreviewPos();
      if (previewPosition === null) {
        revokePreviewUrl(previewUrl);
        if (uploaded === null || externalDocSyncEpochRef.current === uploadStartEpoch) {
          return null;
        }
        let fallbackPos = Math.max(1, Math.min(insertAt, view.state.doc.content.size));
        const fallbackArmed = scratchArmKey.getState(view.state)?.armed ?? null;
        if (fallbackArmed !== null) {
          const bounds = editBounds(view.state.doc, fallbackArmed);
          fallbackPos = Math.max(bounds.min, Math.min(fallbackPos, bounds.max));
        }
        view.dispatch(
          view.state.tr
            .insert(
              fallbackPos,
              nodeType.create({
                attachmentId: uploaded.attachmentId,
                alt: uploaded.name,
                previewUrl: null,
              }),
            )
            .setMeta(SCRATCH_ARM_BYPASS_META, true),
        );
        return fallbackPos + 1;
      }
      if (uploaded === null) {
        revokePreviewUrl(previewUrl);
        view.dispatch(
          view.state.tr
            .delete(previewPosition, previewPosition + 1)
            .setMeta(SCRATCH_ARM_BYPASS_META, true),
        );
        return previewPosition;
      }
      view.dispatch(
        view.state.tr
          .setNodeMarkup(previewPosition, undefined, {
            attachmentId: uploaded.attachmentId,
            alt: uploaded.name,
            previewUrl,
          })
          .setMeta(SCRATCH_ARM_BYPASS_META, true),
      );
      return previewPosition + 1;
    })().finally(() => {
      pendingUploadsRef.current.delete(task);
    });
    pendingUploadsRef.current.add(task);
    return task;
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bulletList: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        listItem: false,
        orderedList: false,
        code: false,
        italic: false,
        bold: false,
        strike: false,
        underline: false,
        link: false,
        dropcursor: false,
        gapcursor: false,
        trailingNode: false,
        listKeymap: false,
      }),
      ComposerMarkdownSourceExtension,
      ComposerItalicExtension,
      ComposerBoldExtension,
      ComposerStrikeExtension,
      ComposerCodeExtension,
      ComposerCodeBlockExtension,
      ...ComposerListExtensions,
      ComposerTaskListExtension,
      ComposerTaskItemExtension,
      ...ComposerBlockExtensions,
      ScratchImageExtension,
      Extension.create({
        name: "scratchArm",
        addProseMirrorPlugins: () => [
          createScratchArmPlugin({
            onArmedSend: (mode) => onArmedSendStable(mode),
            onRelease: () => onArmedChangeStable(null),
          }),
        ],
      }),
    ],
    content: contentForMarkdown(markdown),
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: "composer-tiptap min-h-48 py-1 text-[15px] leading-relaxed focus:outline-none",
        "aria-label": gt("Scratch document"),
      },
      handlePaste(view, event) {
        if (!view.editable) return false;
        const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        void (async () => {
          let position = view.state.selection.from;
          for (const file of files) {
            const nextPos = await insertUploadedImage(view, file, position);
            if (nextPos === null) break;
            position = nextPos;
          }
        })();
        return true;
      },
      handleDrop(view, event) {
        if (!view.editable) return false;
        const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        const basePos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? 1;
        void (async () => {
          let position = basePos;
          for (const file of files) {
            const nextPos = await insertUploadedImage(view, file, position);
            if (nextPos === null) break;
            position = nextPos;
          }
        })();
        return true;
      },
    },
    onUpdate: ({ editor: instance }) => {
      if (suppressUpdateRef.current) return;
      const next = serializeEditorDoc(instance.state.doc).value;
      lastEmitted.current = next;
      onMarkdownChangeStable(next);
      const armed = scratchArmKey.getState(instance.state)?.armed ?? null;
      if (armed === null) {
        onArmedChangeStable(null);
      } else {
        onArmedChangeStable({
          range: armed,
          markdown: markdownForRange(instance, armed.from, armed.to),
        });
      }
    },
    onSelectionUpdate: ({ editor: instance }) => {
      const { from, to } = instance.state.selection;
      onSelectionChangeStable(
        from === to ? null : { markdown: markdownForRange(instance, from, to), from, to },
      );
      if (!suppressCursorReportRef.current && instance.view.hasFocus()) {
        onCursorChangeStable(markdownOffsetAt(instance, to));
      }
    },
  });

  // Push remote or loaded markdown updates into Tiptap without firing a local edit echo.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the Tiptap document in step with the markdown prop
  useEffect(() => {
    if (!editor || markdown === lastEmitted.current) return;
    lastEmitted.current = markdown;
    const prevArmed = scratchArmKey.getState(editor.state)?.armed ?? null;
    const prevArmedMarkdown =
      prevArmed !== null
        ? serializeSelection(editor.state.doc, prevArmed.from, prevArmed.to)
        : null;
    const nextDoc = editor.schema.nodeFromJSON(contentForMarkdown(markdown));
    let remappedArmed: ScratchArmedRange | null = null;
    if (prevArmedMarkdown !== null && prevArmedMarkdown.length > 0) {
      const nextMap = serializeEditorDoc(nextDoc);
      const firstIndex = nextMap.value.indexOf(prevArmedMarkdown);
      const lastIndex = nextMap.value.lastIndexOf(prevArmedMarkdown);
      if (firstIndex >= 0 && firstIndex === lastIndex) {
        const pmFrom = flatToPm(nextMap, markdownToFlat(nextMap, firstIndex));
        const pmTo = flatToPm(
          nextMap,
          markdownToFlat(nextMap, firstIndex + prevArmedMarkdown.length),
        );
        const snapped = snapSelectionToBlocks(nextDoc, pmFrom, pmTo);
        if (
          snapped !== null &&
          serializeSelection(nextDoc, snapped.from, snapped.to) === prevArmedMarkdown
        ) {
          remappedArmed = snapped;
        }
      }
    }
    const tr = editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, nextDoc.content)
      .setMeta("addToHistory", false)
      .setMeta(SCRATCH_ARM_BYPASS_META, true);
    if (prevArmed !== null) {
      tr.setMeta(
        scratchArmKey,
        remappedArmed !== null
          ? ({ type: "arm", armed: remappedArmed } satisfies ScratchArmMeta)
          : ({ type: "release" } satisfies ScratchArmMeta),
      );
    }
    suppressUpdateRef.current = true;
    suppressCursorReportRef.current = true;
    externalDocSyncEpochRef.current += 1;
    editor.view.dispatch(tr);
    suppressUpdateRef.current = false;
    suppressCursorReportRef.current = false;
    if (prevArmed !== null) {
      onArmedChangeStable(
        remappedArmed !== null && prevArmedMarkdown !== null
          ? { range: remappedArmed, markdown: prevArmedMarkdown }
          : null,
      );
    }
  }, [editor, markdown, onArmedChangeStable]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the Tiptap editability in step with readOnly
  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  function replaceDocAndResetHistory(nextMarkdown: string, nextCursorOffset: number): void {
    if (!editor) return;
    lastEmitted.current = nextMarkdown;
    const nextDoc = editor.schema.nodeFromJSON(contentForMarkdown(nextMarkdown));
    const nextState = EditorState.create({
      doc: nextDoc,
      plugins: editor.state.plugins,
    });
    editor.view.updateState(nextState);
    const position = positionAtMarkdownOffset(editor, nextCursorOffset);
    const selection = Selection.near(editor.state.doc.resolve(position), -1);
    editor.view.dispatch(
      editor.state.tr
        .setSelection(selection)
        .setMeta(scratchArmKey, { type: "release" } satisfies ScratchArmMeta)
        .setMeta(SCRATCH_ARM_BYPASS_META, true),
    );
  }

  useImperativeHandle(
    ref,
    () => ({
      focusAtOffset(offset, options) {
        if (!editor) return;
        const position = positionAtMarkdownOffset(editor, offset);
        const selection = Selection.near(editor.state.doc.resolve(position), 1);
        editor.view.dispatch(
          editor.state.tr
            .setSelection(selection)
            .setMeta(scratchArmKey, {
              type: "inactive-caret",
              inactiveCaretPos: null,
            } satisfies ScratchArmMeta)
            .setMeta(SCRATCH_ARM_BYPASS_META, true),
        );
        editor.view.dom.focus({ preventScroll: options?.preventScroll === true });
      },
      restoreCursorWithoutFocus(offset) {
        if (!editor) return;
        const position = positionAtMarkdownOffset(editor, offset);
        const selection = Selection.near(editor.state.doc.resolve(position), 1);
        suppressCursorReportRef.current = true;
        editor.view.dispatch(
          editor.state.tr
            .setSelection(selection)
            .setMeta(scratchArmKey, {
              type: "inactive-caret",
              inactiveCaretPos: selection.to,
            } satisfies ScratchArmMeta)
            .setMeta(SCRATCH_ARM_BYPASS_META, true),
        );
        suppressCursorReportRef.current = false;
      },
      syncRemoteCursor(offset) {
        if (!editor) return;
        if (scratchArmKey.getState(editor.state)?.armed !== null) return;
        const position = positionAtMarkdownOffset(editor, offset);
        const selection = Selection.near(editor.state.doc.resolve(position), 1);
        const focused = editor.view.hasFocus();
        if (focused && editor.state.selection.from !== editor.state.selection.to) return;
        suppressCursorReportRef.current = true;
        editor.view.dispatch(
          editor.state.tr
            .setSelection(selection)
            .setMeta(scratchArmKey, {
              type: "inactive-caret",
              inactiveCaretPos: focused ? null : selection.to,
            } satisfies ScratchArmMeta)
            .setMeta(SCRATCH_ARM_BYPASS_META, true),
        );
        suppressCursorReportRef.current = false;
      },
      focus() {
        if (!editor) return;
        editor.view.dispatch(
          editor.state.tr
            .setMeta(scratchArmKey, {
              type: "inactive-caret",
              inactiveCaretPos: null,
            } satisfies ScratchArmMeta)
            .setMeta(SCRATCH_ARM_BYPASS_META, true),
        );
        editor.view.dom.focus({ preventScroll: true });
      },
      focusEnd() {
        if (!editor) return;
        const endPos = Math.max(1, editor.state.doc.content.size);
        const selection = Selection.near(editor.state.doc.resolve(endPos), -1);
        editor.view.dispatch(
          editor.state.tr
            .setSelection(selection)
            .setMeta(scratchArmKey, {
              type: "inactive-caret",
              inactiveCaretPos: null,
            } satisfies ScratchArmMeta)
            .setMeta(SCRATCH_ARM_BYPASS_META, true),
        );
        editor.view.dom.focus({ preventScroll: true });
      },
      getCursorOffset() {
        if (!editor) return 0;
        return markdownOffsetAt(editor, editor.state.selection.to);
      },
      hasNonEmptySelection() {
        return editor !== null && editor.state.selection.from !== editor.state.selection.to;
      },
      getArmedState() {
        if (!editor) return null;
        return scratchArmKey.getState(editor.state)?.armed ?? null;
      },
      getArmedMarkdown() {
        if (!editor) return "";
        const armed = scratchArmKey.getState(editor.state)?.armed ?? null;
        return armed === null ? "" : markdownForRange(editor, armed.from, armed.to);
      },
      armSelection() {
        if (!editor) return { armed: false };
        const armed = armScratchSelection(editor.view);
        if (armed === null) return { armed: false };
        const selected = markdownForRange(editor, armed.from, armed.to);
        onArmedChangeStable({ range: armed, markdown: selected });
        return {
          armed: true,
          range: armed,
          titlePreview: scratchChunkPreviewTitle(selected) || undefined,
          imageCount: extractScratchImageIds(selected).length,
        };
      },
      releaseArmed() {
        if (!editor) return;
        releaseScratchArm(editor.view);
        onArmedChangeStable(null);
      },
      extractArmedChunk() {
        if (!editor) return null;
        const armed = scratchArmKey.getState(editor.state)?.armed ?? null;
        if (armed === null) return null;
        const doc = editor.state.doc;
        const fullMarkdown = serializeEditorDoc(doc).value;
        // Collapse one adjacent empty separator paragraph at the deletion boundary so removing a
        // middle block turns `Before\n\nChunk\n\nAfter` into `Before\n\nAfter` without touching
        // intentional blank lines elsewhere in the document.
        const isEmptyParagraph = (node: typeof doc.firstChild): boolean =>
          node !== null && node.type.name === "paragraph" && node.content.size === 0;
        let deleteFrom = armed.from;
        let deleteTo = armed.to;
        const $from = doc.resolve(armed.from);
        const $to = doc.resolve(armed.to);
        if ($from.depth === 0 && $to.depth === 0) {
          const prevNode = $from.nodeBefore;
          const nextNode = $to.nodeAfter;
          if (deleteFrom === 0 && isEmptyParagraph(nextNode)) {
            deleteTo += nextNode!.nodeSize;
          } else if (deleteTo === doc.content.size && isEmptyParagraph(prevNode)) {
            deleteFrom -= prevNode!.nodeSize;
          } else if (isEmptyParagraph(prevNode) && isEmptyParagraph(nextNode)) {
            deleteTo += nextNode!.nodeSize;
          }
        }
        // Delete directly in ProseMirror so headings, list items, code fences, and HRs leave no orphaned syntax.
        const deleteTr = editor.state.tr.delete(deleteFrom, deleteTo);
        const nextDoc = deleteTr.doc;
        const nextMap = serializeEditorDoc(nextDoc);
        const nextMarkdown = nextMap.value;
        const mappedPos = Math.max(
          1,
          Math.min(deleteTr.mapping.map(deleteFrom, -1), nextDoc.content.size),
        );
        const nextCursorOffset =
          nextMarkdown.length === 0 ? 0 : flatToMarkdown(nextMap, pmToFlat(nextMap, mappedPos));
        const chunkMarkdown = serializeSelection(doc, armed.from, armed.to);
        const { prompt, attachmentIds } = stripScratchImagesForPrompt(chunkMarkdown);
        return {
          fullMarkdown,
          markdown: chunkMarkdown,
          prompt,
          attachmentIds: attachmentIds as ReadonlyArray<ScratchAttachment["attachmentId"]>,
          nextMarkdown,
          nextCursorOffset,
        };
      },
      insertBelowCursor(insertedMarkdown) {
        if (!editor) return null;
        const currentMarkdown = serializeEditorDoc(editor.state.doc).value;
        const cursorOffset = markdownOffsetAt(editor, editor.state.selection.to);
        const { nextMarkdown, nextCursorOffset } = insertQuickDraftIntoScratch({
          markdown: currentMarkdown,
          cursorOffset,
          insertedMarkdown,
        });
        lastEmitted.current = nextMarkdown;
        const nextDoc = editor.schema.nodeFromJSON(contentForMarkdown(nextMarkdown));
        suppressUpdateRef.current = true;
        editor.view.dispatch(
          editor.state.tr
            .replaceWith(0, editor.state.doc.content.size, nextDoc.content)
            .setMeta(SCRATCH_ARM_BYPASS_META, true),
        );
        suppressUpdateRef.current = false;
        const position = positionAtMarkdownOffset(editor, nextCursorOffset);
        const selection = Selection.near(editor.state.doc.resolve(position), 1);
        editor.view.dispatch(
          editor.state.tr
            .setSelection(selection)
            .setMeta(scratchArmKey, {
              type: "inactive-caret",
              inactiveCaretPos: null,
            } satisfies ScratchArmMeta)
            .setMeta(SCRATCH_ARM_BYPASS_META, true),
        );
        editor.view.dom.focus();
        onMarkdownChangeStable(nextMarkdown);
        return { nextMarkdown, nextCursorOffset };
      },
      applyConsumedMarkdown(nextMarkdown, nextCursorOffset) {
        replaceDocAndResetHistory(nextMarkdown, nextCursorOffset);
        onArmedChangeStable(null);
      },
      setInactiveCaretVisible(visible) {
        if (!editor) return;
        const pmPos = visible ? editor.state.selection.to : null;
        editor.view.dispatch(
          editor.state.tr
            .setMeta(scratchArmKey, {
              type: "inactive-caret",
              inactiveCaretPos: pmPos,
            } satisfies ScratchArmMeta)
            .setMeta(SCRATCH_ARM_BYPASS_META, true),
        );
      },
      scrollToArmed() {
        if (!editor) return;
        const armed = scratchArmKey.getState(editor.state)?.armed;
        if (!armed) return;
        const domAt = editor.view.domAtPos(armed.from);
        const element = domAt.node instanceof Element ? domAt.node : domAt.node.parentElement;
        element?.scrollIntoView({ block: "nearest" });
      },
      async waitForPendingUploads() {
        while (pendingUploadsRef.current.size > 0) {
          await Promise.allSettled(pendingUploadsRef.current);
        }
      },
    }),
    [editor, onArmedChangeStable, onMarkdownChangeStable],
  );

  return (
    <ScratchImageViewContext.Provider
      value={{
        environmentId,
        readOnly,
        onExpandImage: onExpandImageStable,
        onPreviewSuperseded: revokePreviewUrl,
      }}
    >
      <div className={cn("min-h-48", className)}>
        <EditorContent editor={editor} />
      </div>
    </ScratchImageViewContext.Provider>
  );
});
