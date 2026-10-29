import { ChatAttachmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  DraftId,
} from "../../composerDraftStore";
import { composerCommandKeyHandler } from "./composerCommandKey";

function imageAttachment(id: string): ComposerImageAttachment {
  return {
    type: "image",
    id: ChatAttachmentId.make(id),
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 1,
    previewUrl: "",
    file: new File(["image"], "image.png", { type: "image/png" }),
  };
}

function fileAttachment(id: string): ComposerFileAttachment {
  return {
    type: "file",
    id: ChatAttachmentId.make(id),
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    file: new File(["notes"], "notes.txt", { type: "text/plain" }),
  };
}

function escapeEvent(): KeyboardEvent {
  return {
    type: "keydown",
    code: "Escape",
    key: "Escape",
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 27,
  } as unknown as KeyboardEvent;
}

function createHandler(
  options: {
    prompt?: string;
    images?: ComposerImageAttachment[];
    files?: ComposerFileAttachment[];
    menuOpen?: boolean;
  } = {},
) {
  const promptRef = { current: options.prompt ?? "" };
  const composerImages = options.images ?? [];
  const composerFiles = options.files ?? [];
  const clearComposerAttachments = vi.fn(() => true);
  const dismissComposerTrigger = vi.fn();
  const handler = composerCommandKeyHandler({
    keybindings: [],
    sendShortcut: "enter",
    routeKind: "draft",
    phase: "ready",
    isCompacting: false,
    followUpBehavior: "queue",
    isSoftwareKeyboardOpen: false,
    planModeUiEnabled: false,
    isLiteralPendingAnswer: false,
    pendingUserInputs: [],
    promptHistoryMessages: [],
    promptHistoryPositionRef: { current: null },
    composerDraftTarget: DraftId.make("escape-attachments"),
    promptRef,
    composerImagesRef: { current: composerImages },
    composerFilesRef: { current: composerFiles },
    composerTerminalContextsRef: { current: [] },
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    composerEditorRef: { current: null },
    composerMenuOpenRef: { current: options.menuOpen ?? false },
    composerMenuItemsRef: { current: [] },
    activeComposerMenuItemRef: { current: null },
    setComposerDraftPrompt: vi.fn(),
    setComposerCursor: vi.fn(),
    setComposerTrigger: vi.fn(),
    setComposerHighlightedItemId: vi.fn(),
    dismissComposerTrigger,
    toggleInteractionMode: vi.fn(),
    nudgeComposerMenuHighlight: vi.fn(),
    onSelectComposerItem: vi.fn(),
    resolveActiveComposerTrigger: () => ({ trigger: null }),
    readComposerSnapshot: () => ({ value: promptRef.current }),
    applyPromptReplacement: () => false,
    submitComposer: vi.fn(),
    clearComposerAttachments,
  });
  return { handler, clearComposerAttachments, dismissComposerTrigger };
}

describe("composer Escape", () => {
  it("clears attachments when the composer has no text", () => {
    const { handler, clearComposerAttachments } = createHandler({
      images: [imageAttachment("image-1")],
    });

    expect(handler("Escape", escapeEvent())).toBe(true);
    expect(clearComposerAttachments).toHaveBeenCalledOnce();
  });

  it("clears attachments when the composer only holds their context chips", () => {
    const { handler, clearComposerAttachments } = createHandler({
      prompt: "[notes.txt](t3-context://v1/file/file-1) ",
      files: [fileAttachment("file-1")],
    });

    expect(handler("Escape", escapeEvent())).toBe(true);
    expect(clearComposerAttachments).toHaveBeenCalledOnce();
  });

  it("keeps attachments when the user typed text", () => {
    const { handler, clearComposerAttachments } = createHandler({
      prompt: "Explain this",
      images: [imageAttachment("image-1")],
    });

    expect(handler("Escape", escapeEvent())).toBe(false);
    expect(clearComposerAttachments).not.toHaveBeenCalled();
  });

  it("keeps attachments when there are none", () => {
    const { handler } = createHandler();

    expect(handler("Escape", escapeEvent())).toBe(false);
  });

  it("dismisses the command menu before clearing attachments", () => {
    const { handler, clearComposerAttachments, dismissComposerTrigger } = createHandler({
      images: [imageAttachment("image-1")],
      menuOpen: true,
    });

    expect(handler("Escape", escapeEvent())).toBe(true);
    expect(dismissComposerTrigger).toHaveBeenCalledOnce();
    expect(clearComposerAttachments).not.toHaveBeenCalled();
  });
});
