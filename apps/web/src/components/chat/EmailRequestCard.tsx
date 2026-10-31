import { useAtomValue } from "@effect/atom-react";
import { pipe } from "effect/Function";
import {
  EMAIL_REQUEST_NO_PERMISSION_NOTE,
  EMAIL_REQUEST_PRIVACY_NOTE,
  emailComposerEdits,
  emailRequestAnswerInput,
  emailRequestDisplay,
  emailRequestFailureMessage,
  type EmailComposerFields,
  type EmailRequestItem,
} from "@t3tools/client-runtime/email-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { CheckIcon, MailIcon, MinusIcon, SendIcon } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { isMacPlatform } from "~/lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { WorkLogRow } from "./WorkLog";

export function EmailRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: EmailRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = emailRequestDisplay(item, props.visibility);
  if (display.kind === "answered" || display.kind === "pending-elsewhere") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? MailIcon
        : display.outcome === "sent"
          ? CheckIcon
          : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={display.label}
      />
    );
  }
  return <PendingEmailComposer environmentId={props.environmentId} item={item} />;
}

function ComposerRow(props: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 border-t border-border/60 px-3">
      {props.htmlFor === undefined ? (
        <span className="w-14 shrink-0 text-xs leading-6.5 text-muted-foreground max-sm:leading-7.5">
          {props.label}
        </span>
      ) : (
        <label
          htmlFor={props.htmlFor}
          className="w-14 shrink-0 text-xs leading-6.5 text-muted-foreground max-sm:leading-7.5"
        >
          {props.label}
        </label>
      )}
      <div className="min-w-0 flex-1">{props.children}</div>
      {props.trailing}
    </div>
  );
}

function PendingEmailComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly item: EmailRequestItem;
}) {
  const { item } = props;
  const ids = {
    to: useId(),
    cc: useId(),
    bcc: useId(),
    subject: useId(),
    body: useId(),
    error: useId(),
  };
  const answer = useAtomCommand(serverEnvironment.answerEmailRequest, {
    label: "answer email request",
  });
  const [fields, setFields] = useState<EmailComposerFields>(() => emailComposerEdits.get(item));
  const [showCc, setShowCc] = useState(item.draft.cc.length > 0);
  const [showBcc, setShowBcc] = useState(item.draft.bcc.length > 0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter and click can both submit before a render.
  const inFlight = useRef(false);
  const canAnswer = useAtomValue(
    serverEnvironment.answerEmailRequest.permissionAtom(props.environmentId),
  );
  const locked = submitting || !canAnswer;
  const canSend = emailRequestAnswerInput(item, { type: "send", fields }) !== null;
  const sendShortcut = isMacPlatform(navigator.platform) ? "⌘↵" : "Ctrl+↵";

  const update = (field: keyof EmailComposerFields) => (value: string) => {
    const next = { ...fields, [field]: value };
    emailComposerEdits.set(item, next);
    setFields(next);
  };

  const send = async (
    reply:
      | { readonly type: "send"; readonly fields: EmailComposerFields }
      | { readonly type: "discard" },
  ) => {
    const input = emailRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") return emailComposerEdits.clear(item);
    if (isAtomCommandInterrupted(result)) return;
    pipe(squashAtomCommandFailure(result), emailRequestFailureMessage, setError);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send({ type: "send", fields });
  };

  const account = item.accounts.find((candidate) => candidate.name === fields.account);
  // Wraps so every recipient stays visible for review.
  const addressInput = (id: string, field: "to" | "cc" | "bcc", placeholder?: string) => (
    <Textarea
      id={id}
      unstyled
      size="line"
      rows={1}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      value={fields[field]}
      disabled={locked}
      onChange={(event) => update(field)(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) event.preventDefault();
      }}
    />
  );

  return (
    <form
      data-v2-item-type={item.type}
      aria-label="Email draft"
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-card"
      onSubmit={onSubmit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !locked) {
          event.preventDefault();
          void send({ type: "send", fields });
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
        <MailIcon className="size-4 shrink-0 text-icon-muted" aria-hidden />
        <span className="text-sm font-medium text-foreground">Email draft</span>
        <span className="truncate text-xs text-muted-foreground">Review before it sends</span>
      </div>
      <ComposerRow label="From">
        {item.accounts.length > 1 ? (
          <Select
            value={fields.account}
            disabled={locked}
            onValueChange={(next) => {
              if (next !== null) update("account")(next as string);
            }}
          >
            <SelectTrigger variant="ghost" size="sm" aria-label="From">
              <SelectValue>{() => account?.from ?? fields.account}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {item.accounts.map((candidate) => (
                <SelectItem key={candidate.name} value={candidate.name}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{candidate.from}</span>
                    <span className="text-xs text-muted-foreground">{candidate.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <span className="block truncate px-2.5 py-1.5 text-sm text-foreground">
            {account?.from ?? fields.account}
          </span>
        )}
      </ComposerRow>
      <ComposerRow
        label="To"
        htmlFor={ids.to}
        trailing={
          showCc && showBcc ? null : (
            <span className="flex shrink-0 items-center py-px">
              {showCc ? null : (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => setShowCc(true)}
                >
                  Cc
                </Button>
              )}
              {showBcc ? null : (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => setShowBcc(true)}
                >
                  Bcc
                </Button>
              )}
            </span>
          )
        }
      >
        {addressInput(ids.to, "to", "name@example.com")}
      </ComposerRow>
      {showCc ? (
        <ComposerRow label="Cc" htmlFor={ids.cc}>
          {addressInput(ids.cc, "cc")}
        </ComposerRow>
      ) : null}
      {showBcc ? (
        <ComposerRow label="Bcc" htmlFor={ids.bcc}>
          {addressInput(ids.bcc, "bcc")}
        </ComposerRow>
      ) : null}
      <ComposerRow label="Subject" htmlFor={ids.subject}>
        <Input
          id={ids.subject}
          unstyled
          size="sm"
          autoComplete="off"
          value={fields.subject}
          disabled={locked}
          onChange={(event) => update("subject")(event.currentTarget.value)}
        />
      </ComposerRow>
      <div className="border-t border-border/60 px-0.5 py-1">
        <Textarea
          id={ids.body}
          unstyled
          aria-label="Message"
          value={fields.body}
          disabled={locked}
          onChange={(event) => update("body")(event.currentTarget.value)}
        />
      </div>
      {error !== null ? (
        <p
          id={ids.error}
          role="alert"
          className="border-t border-border/60 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {canAnswer ? EMAIL_REQUEST_PRIVACY_NOTE : EMAIL_REQUEST_NO_PERMISSION_NOTE}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            disabled={locked}
            onClick={() => void send({ type: "discard" })}
          >
            Discard
          </Button>
          <Button
            type="submit"
            size="sm"
            title={`Send (${sendShortcut})`}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            disabled={locked || !canSend}
            aria-describedby={error !== null ? ids.error : undefined}
          >
            <SendIcon aria-hidden />
            {submitting ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </form>
  );
}
