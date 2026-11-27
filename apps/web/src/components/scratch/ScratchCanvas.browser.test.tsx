import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { ChatAttachmentId, EnvironmentId, ScratchKey } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { ScratchCanvas, type ScratchCanvasHandle } from "./ScratchCanvas";
import type { UploadedScratchImage } from "./ScratchDocumentEditor";
import type { ScratchDocumentHandle } from "./useScratchDocument";

function useTestDocument(
  initialMarkdown: string,
  onMarkdownChange?: ((markdown: string) => void) | undefined,
): ScratchDocumentHandle {
  const [markdown, setMarkdownState] = useState(initialMarkdown);
  const setMarkdown = (next: string) => {
    onMarkdownChange?.(next);
    setMarkdownState(next);
  };
  return {
    markdown,
    attachments: [],
    getAttachments: () => [],
    revision: 1,
    getRevision: () => 1,
    lastCursorOffset: 0,
    remoteCursorSeq: 0,
    consumptionSeq: 0,
    status: "saved",
    isLoading: false,
    isLoaded: true,
    error: null,
    captureTarget: () => ({}) as ReturnType<ScratchDocumentHandle["captureTarget"]>,
    setMarkdown,
    setCursorOffset: () => {},
    flush: async () => {},
    consumeRange: async ({ nextMarkdown, nextCursorOffset }) => ({
      ok: true,
      appliedMarkdown: nextMarkdown,
      nextCursorOffset,
    }),
    reload: () => {},
  };
}

function Harness({
  initialMarkdown,
  onArmedChange,
  onArmedSend,
  onMarkdownChange,
  onExtract,
  onUploadImage,
}: {
  readonly initialMarkdown: string;
  readonly onArmedChange?: ((armed: unknown) => void) | undefined;
  readonly onArmedSend?: ((mode: "foreground" | "background") => void) | undefined;
  readonly onMarkdownChange?: ((markdown: string) => void) | undefined;
  readonly onExtract?:
    | ((chunk: ReturnType<ScratchCanvasHandle["extractArmedChunk"]>) => void)
    | undefined;
  readonly onUploadImage?: ((file: File) => Promise<UploadedScratchImage | null>) | undefined;
}) {
  const document = useTestDocument(initialMarkdown, onMarkdownChange);
  const canvasRef = useRef<ScratchCanvasHandle>(null);
  const scratchKey = "path:test:/tmp/project" as ScratchKey;
  return (
    <div>
      <button type="button" onClick={() => canvasRef.current?.armSelection()}>
        Arm
      </button>
      <button
        type="button"
        onClick={() => onExtract?.(canvasRef.current?.extractArmedChunk() ?? null)}
      >
        Extract
      </button>
      <button
        type="button"
        onClick={() => {
          void (async () => {
            await canvasRef.current?.waitForPendingUploads();
            onExtract?.(canvasRef.current?.extractArmedChunk() ?? null);
          })();
        }}
      >
        WaitAndExtract
      </button>
      <button
        type="button"
        onClick={() => canvasRef.current?.applyConsumedMarkdown("Remaining", 0)}
      >
        Consume
      </button>
      <button type="button">Outside</button>
      <ScratchCanvas
        ref={canvasRef}
        environmentId={"environment-1" as EnvironmentId}
        scratchKey={scratchKey}
        document={document}
        onArmedChange={onArmedChange}
        onArmedSend={onArmedSend}
        onUploadImage={onUploadImage}
      />
    </div>
  );
}

describe("ScratchCanvas", () => {
  it("renders the document without stealing focus and commits typed text", async () => {
    // ScratchCanvas does not depend on TanStack Router context.
    await using screen = await render(<Harness initialMarkdown="First note" />, { router: false });
    await expect.element(screen.getByText("First note")).toBeVisible();
    await vi.waitFor(() => {
      expect(document.querySelector(".scratch-inactive-caret")).not.toBeNull();
    });
    await userEvent.click(screen.getByLabelText("Scratch document"));
    await userEvent.type(screen.getByLabelText("Scratch document"), " and more");
    await expect.element(screen.getByText("First note and more")).toBeVisible();
  });

  it("arms the selected block, dims the rest read-only, and sends on Enter", async () => {
    const onArmedChange = vi.fn();
    const onArmedSend = vi.fn();
    // ScratchCanvas does not depend on TanStack Router context.
    await using screen = await render(
      <Harness
        initialMarkdown={"First note\n\nSecond note"}
        onArmedChange={onArmedChange}
        onArmedSend={onArmedSend}
      />,
      { router: false },
    );
    await userEvent.click(screen.getByLabelText("Scratch document"));
    await userEvent.keyboard("{Control>}{Home}{/Control}{Shift>}{ArrowDown}{/Shift}");
    await userEvent.click(screen.getByText("Arm"));
    expect(onArmedChange).toHaveBeenCalled();
    await expect.element(screen.getByText("First note")).toHaveClass("scratch-block-armed");
    await expect.element(screen.getByText("Second note")).toHaveClass("scratch-block-readonly");

    await userEvent.click(screen.getByText("First note"));
    await userEvent.keyboard("{Enter}");
    expect(onArmedSend).toHaveBeenCalledWith("foreground");
  });

  it("keeps Shift+Enter newlines inside the armed chunk and preserves edits after Escape release", async () => {
    const changes: string[] = [];
    // ScratchCanvas does not depend on TanStack Router context.
    await using screen = await render(
      <Harness
        initialMarkdown={"First note\n\nSecond note"}
        onMarkdownChange={(markdown) => changes.push(markdown)}
      />,
      { router: false },
    );
    await userEvent.click(screen.getByLabelText("Scratch document"));
    await userEvent.keyboard("{Control>}{Home}{/Control}{Shift>}{ArrowDown}{/Shift}");
    await userEvent.click(screen.getByText("Arm"));
    await userEvent.click(screen.getByText("First note"));
    await userEvent.keyboard("{End}{Shift>}{Enter}{/Shift}line two");
    await expect.element(screen.getByText(/line two/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByText("Second note")).not.toHaveClass("scratch-block-readonly");
    await expect.element(screen.getByText(/line two/)).toBeVisible();
  });

  it("does not allow Undo to resurrect a consumed chunk", async () => {
    // ScratchCanvas does not depend on TanStack Router context.
    await using screen = await render(<Harness initialMarkdown={"Consumed chunk\n\nRemaining"} />, {
      router: false,
    });
    await userEvent.click(screen.getByLabelText("Scratch document"));
    await userEvent.click(screen.getByText("Consume"));
    await expect.element(screen.getByText("Remaining")).toBeVisible();
    await userEvent.click(screen.getByLabelText("Scratch document"));
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect.element(screen.getByText("Remaining")).toBeVisible();
    expect(document.body.textContent).not.toContain("Consumed chunk");
  });

  it("renders task lists and consumes heading blocks without leaving orphaned markdown syntax", async () => {
    const captured: Array<ReturnType<ScratchCanvasHandle["extractArmedChunk"]>> = [];
    // ScratchCanvas does not depend on TanStack Router context.
    await using screen = await render(
      <Harness
        initialMarkdown={"## First heading\n\n- [ ] Task one\n- [x] Task two"}
        onExtract={(chunk) => {
          captured.push(chunk);
        }}
      />,
      { router: false },
    );
    await expect.element(screen.getByText("First heading")).toBeVisible();
    await expect.element(screen.getByText("Task one")).toBeVisible();
    await userEvent.click(screen.getByText("First heading"));
    await userEvent.keyboard("{Control>}{Home}{/Control}{Shift>}{End}{/Shift}");
    await userEvent.click(screen.getByText("Arm"));
    await userEvent.click(screen.getByText("Extract"));
    const extracted = captured.at(-1) ?? null;
    expect(extracted).not.toBeNull();
    expect(extracted?.nextMarkdown).not.toContain("##");
    expect(extracted?.nextMarkdown).toContain("Task one");
  });

  it("consumes all items in a list without leaving an orphaned list marker", async () => {
    const captured: Array<ReturnType<ScratchCanvasHandle["extractArmedChunk"]>> = [];
    // ScratchCanvas does not depend on TanStack Router context.
    await using screen = await render(
      <Harness
        initialMarkdown={"- First item\n- Second item\n\nAfter list"}
        onExtract={(chunk) => {
          captured.push(chunk);
        }}
      />,
      { router: false },
    );
    await expect.element(screen.getByText("First item")).toBeVisible();
    await userEvent.click(screen.getByText("First item"));
    await userEvent.keyboard("{Control>}{Home}{/Control}{Shift>}{ArrowDown}{End}{/Shift}");
    await userEvent.click(screen.getByText("Arm"));
    await userEvent.click(screen.getByText("Extract"));
    const extracted = captured.at(-1) ?? null;
    expect(extracted).not.toBeNull();
    expect(extracted?.nextMarkdown).toBe("After list");
  });

  it("allows single-clicking a standalone image to select and arm it", async () => {
    const captured: Array<ReturnType<ScratchCanvasHandle["extractArmedChunk"]>> = [];
    // ScratchCanvas does not depend on TanStack Router context.
    await using screen = await render(
      <Harness
        initialMarkdown={"Before\n\n![shot](t3-scratch-image://scratch-img-1)\n\nAfter"}
        onExtract={(chunk) => {
          captured.push(chunk);
        }}
      />,
      { router: false },
    );
    await expect.element(screen.getByText("Before")).toBeVisible();
    const imageWrapper = document.querySelector("[data-drag-handle]");
    expect(imageWrapper).not.toBeNull();
    await userEvent.click(imageWrapper as Element);
    await userEvent.click(screen.getByText("Arm"));
    await userEvent.click(screen.getByText("Extract"));
    const extracted = captured.at(-1) ?? null;
    expect(extracted).not.toBeNull();
    expect(extracted?.attachmentIds).toEqual(["scratch-img-1"]);
    expect(extracted?.nextMarkdown).toBe("Before\n\nAfter");
  });

  it("waits until pending inline image uploads write attachmentId into ProseMirror before extracting", async () => {
    let resolveUpload!: (uploaded: UploadedScratchImage | null) => void;
    const captured: Array<ReturnType<ScratchCanvasHandle["extractArmedChunk"]>> = [];
    // ScratchCanvas does not depend on TanStack Router context.
    await using screen = await render(
      <Harness
        initialMarkdown={"Armed line\n\nOutside"}
        onUploadImage={() =>
          new Promise<UploadedScratchImage | null>((resolve) => {
            resolveUpload = resolve;
          })
        }
        onExtract={(chunk) => {
          captured.push(chunk);
        }}
      />,
      { router: false },
    );
    await expect.element(screen.getByText("Armed line")).toBeVisible();
    await userEvent.click(screen.getByText("Armed line"));
    await userEvent.keyboard("{Control>}{Home}{/Control}{Shift>}{End}{/Shift}");
    await userEvent.click(screen.getByText("Arm"));

    // Paste an image into the armed chunk while the upload stays in flight.
    const editorDom = document.querySelector(".ProseMirror")!;
    const file = new File(["png"], "paste.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    editorDom.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dataTransfer, bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => {
      expect(resolveUpload).toBeTypeOf("function");
    });

    // Trigger WaitAndExtract before resolving upload; extraction must see the written attachmentId.
    await userEvent.click(screen.getByText("WaitAndExtract"));
    resolveUpload({ attachmentId: "scratch-pasted-9" as ChatAttachmentId, name: "paste.png" });
    await vi.waitFor(() => {
      expect(captured).toHaveLength(1);
    });
    expect(captured[0]?.attachmentIds).toEqual(["scratch-pasted-9"]);
  });
});
