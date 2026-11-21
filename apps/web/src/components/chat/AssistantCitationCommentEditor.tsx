import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  type AssistantCitation,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { use, useEffect, useRef, useState, type RefObject } from "react";

import { collapseExpandedComposerCursor } from "~/composer-logic";
import { useClientSettings } from "~/hooks/useSettings";
import { TextFieldSpeechControls, useDraftFieldSpeech } from "~/speech/useTextFieldSpeech";

import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { ComposerContextActionsContext } from "../composerContextActions";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { Button } from "../ui/button";

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

function noop() {}

export function AssistantCitationCommentEditor({
  citation,
  editorRef,
  onSubmit,
  onSubmitAndSend,
  onCancel,
  onDraftChange,
  onVoiceSetupOpenChange,
}: {
  citation: AssistantCitation;
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
  onSubmit: (comment: string) => boolean;
  onSubmitAndSend?: (comment: string) => boolean;
  onCancel: () => void;
  onDraftChange?: (comment: string) => void;
  onVoiceSetupOpenChange?: (open: boolean) => void;
}) {
  const gt = useGT();
  const richTextEnabled = useClientSettings((settings) => settings.composerRichTextEnabled);
  const [comment, setComment] = useState(citation.comment ?? "");
  const [cursor, setCursor] = useState(() =>
    collapseExpandedComposerCursor(comment, comment.length),
  );
  const fieldRef = useRef<HTMLDivElement>(null);
  const { environmentId, projectId } = use(ComposerContextActionsContext);
  const updateComment = (text: string) => {
    setComment(text);
    onDraftChange?.(text);
  };
  const speech = useDraftFieldSpeech({
    environmentId: environmentId ?? citation.environmentId,
    projectId,
    ownerKey: JSON.stringify([
      "citation",
      environmentId,
      citation.threadId,
      citation.messageId,
      citation.start,
      citation.end,
    ]),
    text: comment,
    targetRef: fieldRef,
    readDraft: () => {
      const editor = editorRef.current;
      const snapshot = editor?.readSnapshot();
      const text = snapshot?.value ?? comment;
      const caret = snapshot?.expandedCursor ?? text.length;
      return { text, selection: editor?.readSelectionRange() ?? { start: caret, end: caret } };
    },
    commitDraft: (text, selection) => {
      const next = collapseExpandedComposerCursor(text, selection.start);
      updateComment(text);
      setCursor(next);
      window.requestAnimationFrame(() => editorRef.current?.focusAt(next));
    },
  });
  const setupOpen = speech.setup.open;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the citation popover open while the voice setup dialog owns focus
  useEffect(() => {
    onVoiceSetupOpenChange?.(setupOpen);
    return () => onVoiceSetupOpenChange?.(false);
  }, [onVoiceSetupOpenChange, setupOpen]);
  const commentTooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const submit = () => {
    speech.submitAfterDictation((text) => {
      if (text.length <= ASSISTANT_CITATION_MAX_COMMENT_LENGTH) onSubmit(text);
    });
  };
  const submitAndSend = () => {
    speech.submitAfterDictation((text) => {
      if (text.length <= ASSISTANT_CITATION_MAX_COMMENT_LENGTH) (onSubmitAndSend ?? onSubmit)(text);
    });
  };

  return (
    <div
      ref={fieldRef}
      data-citation-comment-editor="true"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          if (speech.state.phase !== "idle") speech.cancel();
          else onCancel();
        }
      }}
    >
      <ComposerPromptEditorTiptap
        editorRef={editorRef}
        value={comment}
        cursor={cursor}
        richTextEnabled={richTextEnabled}
        contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
        skills={NO_SKILLS}
        disabled={speech.freezesEditor}
        ariaLabel={gt("Comment on selected text")}
        ariaDescription={gt(
          "Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line.",
        )}
        ariaInvalid={commentTooLong}
        placeholder={gt("Add an optional comment...")}
        className="max-h-40"
        onChange={(nextComment, nextCursor) => {
          updateComment(nextComment);
          setCursor(nextCursor);
        }}
        onCommandKeyDown={(key, event) => {
          if (key !== "Enter" || event.shiftKey) return false;
          if (event.metaKey || event.ctrlKey) {
            submitAndSend();
          } else {
            submit();
          }
          return true;
        }}
        onPaste={noop}
      />
      {commentTooLong ? (
        <p role="status" className="pt-1 text-xs text-destructive">
          <T>
            Comments can contain up to{" "}
            <Var>{ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}</Var> characters.
          </T>
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <TextFieldSpeechControls speech={speech} />
        {/* Wrap as a pair so the recording pill never pushes Save alone onto a new row under Cancel. */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="xs"
            // Escape cancels; keep Tab from the comment on Save so Enter cannot discard a new citation.
            tabIndex={-1}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onCancel}
          >
            <T>Cancel</T>
          </Button>
          <Button
            size="xs"
            disabled={speech.preparing || (commentTooLong && !speech.blocksSubmission)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={submit}
          >
            {commentTooLong
              ? gt("Shorten comment")
              : gt("Save", { $context: "verb, saves the comment" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
