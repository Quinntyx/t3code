import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  type AssistantCitation,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { useState, type RefObject } from "react";

import { collapseExpandedComposerCursor } from "~/composer-logic";
import { useClientSettings } from "~/hooks/useSettings";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
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
}: {
  citation: AssistantCitation;
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
  onSubmit: (comment: string) => boolean;
  onSubmitAndSend?: (comment: string) => boolean;
  onCancel: () => void;
  onDraftChange?: (comment: string) => void;
}) {
  const richTextEnabled = useClientSettings((settings) => settings.composerRichTextEnabled);
  const [comment, setComment] = useState(citation.comment ?? "");
  const [cursor, setCursor] = useState(() =>
    collapseExpandedComposerCursor(comment, comment.length),
  );
  const commentTooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const submit = () => {
    if (!commentTooLong) onSubmit(comment);
  };
  const submitAndSend = () => {
    if (commentTooLong) return;
    if (onSubmitAndSend) {
      onSubmitAndSend(comment);
    } else {
      onSubmit(comment);
    }
  };

  return (
    <div
      data-citation-comment-editor="true"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
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
        disabled={false}
        ariaLabel="Comment on selected text"
        ariaDescription="Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line."
        ariaInvalid={commentTooLong}
        placeholder="Add an optional comment..."
        className="max-h-40"
        onChange={(nextComment, nextCursor) => {
          setComment(nextComment);
          setCursor(nextCursor);
          onDraftChange?.(nextComment);
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
          Comments can contain up to {ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}{" "}
          characters.
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="xs"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={commentTooLong}
          onPointerDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          {commentTooLong ? "Shorten comment" : "Save"}
        </Button>
      </div>
    </div>
  );
}
