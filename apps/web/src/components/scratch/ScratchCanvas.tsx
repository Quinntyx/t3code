import type { EnvironmentId, ScratchKey } from "@t3tools/contracts";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { readScratchViewState, writeScratchViewState } from "~/state/scratch";

import {
  ScratchDocumentEditor,
  type ScratchDocumentEditorHandle,
  type ScratchExtractedChunk,
  type ScratchSelection,
  type UploadedScratchImage,
} from "./ScratchDocumentEditor";
import type { ScratchArmedRange } from "./ScratchArmPlugin";
import type { ScratchDocumentHandle } from "./useScratchDocument";

export interface ScratchCanvasHandle {
  focusAtOffset(offset: number, options?: { readonly preventScroll?: boolean }): void;
  focusRemembered(): void;
  focus(): void;
  getCursorOffset(): number;
  hasNonEmptySelection(): boolean;
  getArmedState(): ScratchArmedRange | null;
  armSelection(): ScratchArmedRange | null;
  extractArmedChunk(): ScratchExtractedChunk | null;
  releaseArmed(): void;
  insertBelowCursor(markdown: string): { nextMarkdown: string; nextCursorOffset: number } | null;
  applyConsumedMarkdown(nextMarkdown: string, nextCursorOffset: number): void;
  setInactiveCaretVisible(visible: boolean): void;
  scrollToArmed(): void;
  saveView(): void;
  waitForPendingUploads(): Promise<void>;
}

export function ScratchCanvas({
  environmentId,
  scratchKey,
  document,
  bottomPaddingPx,
  onUploadImage,
  onExpandImage,
  onSelectionChange,
  onArmedChange,
  onArmedSend,
  readOnly = false,
  ref,
}: {
  readonly environmentId: EnvironmentId;
  readonly scratchKey: ScratchKey;
  readonly document: ScratchDocumentHandle;
  readonly bottomPaddingPx?: number | undefined;
  readonly onUploadImage?: ((file: File) => Promise<UploadedScratchImage | null>) | undefined;
  readonly onExpandImage?: ((url: string, alt: string) => void) | undefined;
  readonly onSelectionChange?: ((selection: ScratchSelection | null) => void) | undefined;
  readonly onArmedChange?:
    | ((armed: { range: ScratchArmedRange; markdown: string } | null) => void)
    | undefined;
  readonly onArmedSend?: ((mode: "foreground" | "background") => void) | undefined;
  readonly ref?: Ref<ScratchCanvasHandle>;
  readonly readOnly?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const editorRef = useRef<ScratchDocumentEditorHandle>(null);
  const cursorOffsetRef = useRef(0);
  const restoredKeyRef = useRef<string | null>(null);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastAppliedRemoteCursorSeqRef = useRef(0);
  const lastAppliedConsumptionSeqRef = useRef(document.consumptionSeq);

  const saveView = useStableCallback((options?: { readonly immediateCursor?: boolean }) => {
    const offset = editorRef.current?.getCursorOffset() ?? cursorOffsetRef.current;
    cursorOffsetRef.current = offset;
    document.setCursorOffset(offset, { immediate: options?.immediateCursor === true });
    if (scrollRef.current !== null) {
      scrollTopRef.current = scrollRef.current.scrollTop;
    }
    writeScratchViewState(scratchKey, {
      scrollTop: scrollTopRef.current,
    });
  });

  const saveViewSoon = () => {
    if (scrollRef.current !== null) {
      scrollTopRef.current = scrollRef.current.scrollTop;
    }
    if (scrollSaveTimerRef.current !== null) return;
    scrollSaveTimerRef.current = setTimeout(() => {
      scrollSaveTimerRef.current = null;
      writeScratchViewState(scratchKey, {
        scrollTop: scrollTopRef.current,
      });
    }, 120);
  };

  // Restore scroll and global cursor once the server snapshot is mirrored into local state, without stealing focus.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores scroll position and global inactive caret after first load
  useEffect(() => {
    if (!document.isLoaded || restoredKeyRef.current === scratchKey) return;
    restoredKeyRef.current = scratchKey;
    const saved = readScratchViewState(scratchKey);
    const offset = document.lastCursorOffset;
    const restoredScrollTop = saved?.scrollTop ?? 0;
    cursorOffsetRef.current = offset;
    scrollTopRef.current = restoredScrollTop;
    if (scrollRef.current !== null) scrollRef.current.scrollTop = restoredScrollTop;
    const active = window.document.activeElement;
    const scratchHasFocus =
      active instanceof Element && active.closest("[data-scratch-canvas]") !== null;
    if (!scratchHasFocus && document.markdown.length > 0) {
      editorRef.current?.restoreCursorWithoutFocus(offset);
    }
  }, [document.isLoaded, document.lastCursorOffset, document.markdown.length, scratchKey]);

  // Apply remote global cursor moves from other devices immediately for seamless device switching.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors remote global cursor updates into the editor caret
  useEffect(() => {
    if (!document.isLoaded || document.remoteCursorSeq === lastAppliedRemoteCursorSeqRef.current) {
      return;
    }
    lastAppliedRemoteCursorSeqRef.current = document.remoteCursorSeq;
    cursorOffsetRef.current = document.lastCursorOffset;
    editorRef.current?.syncRemoteCursor(document.lastCursorOffset);
  }, [document.isLoaded, document.lastCursorOffset, document.remoteCursorSeq]);

  // Reset ProseMirror undo history whenever a chunk consumption (direct or replayed) commits.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears ProseMirror undo history after a consumed chunk commits
  useEffect(() => {
    if (document.consumptionSeq === lastAppliedConsumptionSeqRef.current) return;
    lastAppliedConsumptionSeqRef.current = document.consumptionSeq;
    cursorOffsetRef.current = document.lastCursorOffset;
    editorRef.current?.applyConsumedMarkdown(document.markdown, document.lastCursorOffset);
  }, [document.consumptionSeq, document.lastCursorOffset, document.markdown]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists device scroll position on unmount
  useEffect(() => {
    return () => {
      if (scrollSaveTimerRef.current !== null) clearTimeout(scrollSaveTimerRef.current);
      writeScratchViewState(scratchKey, {
        scrollTop: scrollTopRef.current,
      });
    };
  }, [scratchKey]);

  useImperativeHandle(
    ref,
    () => ({
      focusAtOffset(offset, options) {
        cursorOffsetRef.current = offset;
        editorRef.current?.focusAtOffset(offset, options);
      },
      focusRemembered() {
        const saved = readScratchViewState(scratchKey);
        const offset = document.lastCursorOffset;
        cursorOffsetRef.current = offset;
        if (scrollRef.current !== null && saved !== null) {
          scrollRef.current.scrollTop = saved.scrollTop;
        }
        editorRef.current?.focusAtOffset(offset, { preventScroll: true });
      },
      focus() {
        editorRef.current?.focus();
      },
      getCursorOffset() {
        return editorRef.current?.getCursorOffset() ?? cursorOffsetRef.current;
      },
      hasNonEmptySelection() {
        return editorRef.current?.hasNonEmptySelection() ?? false;
      },
      getArmedState() {
        return editorRef.current?.getArmedState() ?? null;
      },
      armSelection() {
        return editorRef.current?.armSelection().range ?? null;
      },
      extractArmedChunk() {
        return editorRef.current?.extractArmedChunk() ?? null;
      },
      releaseArmed() {
        editorRef.current?.releaseArmed();
      },
      insertBelowCursor(markdown) {
        const result = editorRef.current?.insertBelowCursor(markdown) ?? null;
        if (result !== null) {
          cursorOffsetRef.current = result.nextCursorOffset;
          document.setCursorOffset(result.nextCursorOffset);
          writeScratchViewState(scratchKey, {
            scrollTop: scrollRef.current?.scrollTop ?? 0,
          });
        }
        return result;
      },
      applyConsumedMarkdown(nextMarkdown, nextCursorOffset) {
        cursorOffsetRef.current = nextCursorOffset;
        editorRef.current?.applyConsumedMarkdown(nextMarkdown, nextCursorOffset);
        writeScratchViewState(scratchKey, {
          scrollTop: scrollRef.current?.scrollTop ?? 0,
        });
      },
      setInactiveCaretVisible(visible) {
        editorRef.current?.setInactiveCaretVisible(visible);
      },
      scrollToArmed() {
        editorRef.current?.scrollToArmed();
      },
      saveView: () => saveView({ immediateCursor: true }),
      waitForPendingUploads: async () => {
        await editorRef.current?.waitForPendingUploads();
      },
    }),
    [document, saveView, scratchKey],
  );

  return (
    <div
      ref={scrollRef}
      data-scratch-canvas
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-both"
      onScroll={() => saveViewSoon()}
      onFocusCapture={() => editorRef.current?.setInactiveCaretVisible(false)}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        saveView({ immediateCursor: true });
        if (editorRef.current?.getArmedState() === null && document.markdown.length > 0) {
          editorRef.current?.setInactiveCaretVisible(true);
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && editorRef.current?.getArmedState() === null) {
          event.preventDefault();
          editorRef.current?.focusEnd();
        }
      }}
    >
      <div
        className="mx-auto w-full max-w-(--chat-content-max-width) px-5 pt-6 sm:px-6"
        style={{ paddingBottom: Math.max(224, (bottomPaddingPx ?? 0) + 48) }}
      >
        <ScratchDocumentEditor
          ref={editorRef}
          environmentId={environmentId}
          markdown={document.markdown}
          onMarkdownChange={document.setMarkdown}
          onSelectionChange={onSelectionChange}
          onCursorChange={(offset) => {
            cursorOffsetRef.current = offset;
            document.setCursorOffset(offset);
          }}
          onArmedChange={onArmedChange}
          onArmedSend={onArmedSend}
          onUploadImage={onUploadImage}
          onExpandImage={onExpandImage}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}
