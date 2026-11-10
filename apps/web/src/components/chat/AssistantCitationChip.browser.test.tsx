import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  type AssistantCitation,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import type { TiptapEditorHTMLElement } from "@tiptap/core";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import "~/index.css";
import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  observeSource: vi.fn(),
  dispose: vi.fn(),
  dictation: null as null | {
    readDraft: () => { text: string; selection: { start: number; end: number } };
    commitDraft: (text: string, selection: { start: number; end: number }) => void;
  },
}));
vi.mock(import("~/speech/useEnvironmentSpeechInput"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    useEnvironmentSpeechInput: (input) => {
      mocks.dictation = input;
      return original.useEnvironmentSpeechInput(input);
    },
  };
});
vi.mock(import("./AssistantCitationSource"), async (importOriginal) => ({
  ...(await importOriginal()),
  observeAssistantCitationCommentSource: mocks.observeSource,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
  Link: (({ children }: { children: ReactNode }) => <a>{children}</a>) as never,
}));

import { AssistantCitationChip } from "./AssistantCitationChip";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};

// The mocked source observer is shared, so every test starts by resetting it.
function setup() {
  mocks.observeSource.mockReset().mockReturnValue(mocks.dispose);
  mocks.dispose.mockClear();
  const source = document.createElement("p");
  source.textContent = "hello";
  document.body.append(source);
  const range = document.createRange();
  range.selectNodeContents(source);
  const sourceAnchor = { source, range, viewport: document.body } as AssistantCitationSourceAnchor;
  return { sourceAnchor, [Symbol.dispose]: () => source.remove() };
}

function mount(
  sourceAnchor: AssistantCitationSourceAnchor | undefined,
  onSave: () => boolean,
  chipCitation: AssistantCitation = citation,
) {
  function Composer() {
    const [open, setOpen] = useState(true);
    return (
      <AssistantCitationChip
        citation={chipCitation}
        composer
        commentEditor={{ open, sourceAnchor, onOpenChange: setOpen, onSave }}
      />
    );
  }
  return render(<Composer />);
}

const commentInput = () =>
  document.querySelector<TiptapEditorHTMLElement>('[aria-label="Comment on selected text"]');

async function typeComment(value: string) {
  const editor = commentInput()!.editor!;
  await act(async () => {
    editor.chain().selectAll().insertContent(value).run();
  });
}

async function removeSource() {
  const { onUnavailable } = mocks.observeSource.mock.lastCall![0];
  await act(async () => onUnavailable());
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

describe("citation comment editing", () => {
  it("formats markdown as it is typed and saves it on Enter", async () => {
    using source = setup();
    const onSave = vi.fn(() => true);
    await using _screen = await mount(source.sourceAnchor, onSave);
    await vi.waitFor(() => expect(document.activeElement).toBe(commentInput()));
    // Typing on past the closing marker leaves emphasis, as in the composer.
    await userEvent.keyboard("needs to *spawn agents* now{Shift>}{Enter}{/Shift}twice");

    expect(commentInput()?.querySelector("em")?.textContent).toBe("spawn agents");
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledWith("needs to *spawn agents* now\ntwice");
    expect(commentInput()).toBeNull();
  });
});

describe("citation comment dictation", () => {
  it("inserts a transcript at the editor's caret and keeps typing after it", async () => {
    using source = setup();
    const onSave = vi.fn(() => true);
    await using _screen = await mount(source.sourceAnchor, onSave, {
      ...citation,
      comment: "hello world",
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(commentInput()));
    await userEvent.keyboard("{ArrowLeft>6/}");
    expect(mocks.dictation!.readDraft()).toEqual({
      text: "hello world",
      selection: { start: 5, end: 5 },
    });

    await act(async () =>
      mocks.dictation!.commitDraft("hello dictated world", { start: 14, end: 14 }),
    );
    await vi.waitFor(() => expect(commentInput()?.textContent).toBe("hello dictated world"));
    await vi.waitFor(() => expect(document.activeElement).toBe(commentInput()));
    await userEvent.keyboard("!{Enter}");
    expect(onSave).toHaveBeenCalledWith("hello dictated! world");
  });
});

describe("citation comment source disappearance", () => {
  it("preserves an over-length draft at the composer until it can be shortened and saved", async () => {
    using source = setup();
    const onSave = vi.fn(() => true);
    await using _screen = await mount(source.sourceAnchor, onSave);
    const draft = "x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1);
    await typeComment(draft);
    await removeSource();

    expect(commentInput()?.textContent).toBe(draft);
    expect(commentInput()?.getAttribute("aria-invalid")).toBe("true");
    expect(onSave).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.observeSource).toHaveBeenCalledTimes(1);

    await typeComment("shortened comment");
    await clickButton("Save");
    expect(onSave).toHaveBeenCalledWith("shortened comment");
    expect(commentInput()).toBeNull();
  });

  it("preserves a rejected save and allows a later retry", async () => {
    using source = setup();
    const onSave = vi.fn(() => false);
    await using _screen = await mount(source.sourceAnchor, onSave);
    await typeComment("keep this draft");
    await removeSource();

    expect(onSave).toHaveBeenCalledWith("keep this draft");
    expect(commentInput()?.textContent).toBe("keep this draft");
    onSave.mockReturnValue(true);
    await clickButton("Save");
    expect(onSave).toHaveBeenLastCalledWith("keep this draft");
    expect(commentInput()).toBeNull();
  });
});

describe("citation comment caret", () => {
  it("opens a saved comment with the caret after its end, scrolled into view", async () => {
    using _source = setup();
    const comment = `${"line\n".repeat(40)}end`;
    const onSave = vi.fn(() => true);
    await using _screen = await mount(undefined, onSave, { ...citation, comment });
    await vi.waitFor(() => expect(document.activeElement).toBe(commentInput()));
    const input = commentInput()!;

    expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
    await vi.waitFor(() => {
      const caret = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      expect(input.scrollTop).toBeGreaterThan(0);
      expect(caret.bottom).toBeLessThanOrEqual(input.getBoundingClientRect().bottom);
    });
    await userEvent.keyboard("!{Enter}");
    expect(onSave).toHaveBeenCalledWith(`${comment}!`);
  });
});

describe("citation comment popup position", () => {
  it("opens at its anchor instead of sliding in from the window corner", async () => {
    using source = setup();
    await using _screen = await mount(
      source.sourceAnchor,
      vi.fn(() => true),
    );
    const positioner = () =>
      document.querySelector<HTMLElement>('[data-slot="popover-positioner"]');
    await vi.waitFor(() => expect(positioner()?.style.opacity).not.toBe("0"));

    const moves = positioner()!
      .getAnimations()
      .filter(
        (animation) =>
          animation instanceof CSSTransition &&
          ["transform", "top", "left"].includes(animation.transitionProperty),
      );
    expect(moves).toEqual([]);
  });

  it("stays on screen when the cited text ends in a code block's hidden overflow", async () => {
    using _source = setup();
    const message = document.createElement("div");
    message.className = "chat-markdown";
    message.style.width = "240px";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    // Highlighted code is split into token spans, so the range's last client rect
    // covers only the final token, wholly inside the hidden overflow.
    for (let index = 0; index < 40; index += 1) {
      const token = document.createElement("span");
      token.textContent = `token${index} `;
      code.append(token);
    }
    pre.append(code);
    message.append(pre);
    document.body.prepend(message);
    using _message = { [Symbol.dispose]: () => message.remove() };
    const range = document.createRange();
    range.selectNodeContents(code);
    const rects = range.getClientRects();
    expect(rects.item(rects.length - 1)!.left).toBeGreaterThan(window.innerWidth);
    const sourceAnchor = {
      source: message,
      range,
      viewport: document.body,
    } as AssistantCitationSourceAnchor;

    await using _screen = await mount(
      sourceAnchor,
      vi.fn(() => true),
    );
    const popup = () => document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
    await vi.waitFor(() => expect(popup()?.getBoundingClientRect().width).toBeGreaterThan(0));
    // Typing scrolls ancestors to reveal the caret, which shifts the whole app
    // sideways when the box is off screen.
    await userEvent.keyboard("note");

    expect(commentInput()?.textContent).toBe("note");
    expect(document.scrollingElement?.scrollLeft).toBe(0);
    expect(document.body.scrollLeft).toBe(0);
    const rect = popup()!.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  });
});
