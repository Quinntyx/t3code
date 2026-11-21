import {
  backgroundCommandOutputFile,
  followOutputFileCommand,
  type BackgroundWorkDetail,
} from "@t3tools/client-runtime/state/thread-execution";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { T, useGT, Var } from "gt-react";
import {
  ActivityIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  ListTodoIcon,
  TerminalIcon,
} from "lucide-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import { useTurnItemDetail } from "../../state/queries";
import { tickTextContent } from "~/lib/tickTextContent";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { resolveExternalWebLinkHref } from "./externalLinkContextMenu";
import { MessageCopyButton } from "./MessageCopyButton";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { V2ItemInspector } from "./V2ItemInspector";

const KIND_ICONS = {
  subagent: CircleDashedIcon,
  command: TerminalIcon,
  monitor: ActivityIcon,
  background_task: ListTodoIcon,
};
const MONO_CLASS_NAME =
  "font-mono text-xs leading-relaxed whitespace-pre-wrap break-words select-text";

interface BackgroundWorkDetailsProps {
  readonly environmentId: EnvironmentId;
  readonly details: ReadonlyArray<BackgroundWorkDetail>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onRunInTerminal?: ((command: string) => void) | undefined;
}

function BackgroundWorkSection(
  props: Omit<BackgroundWorkDetailsProps, "details"> & {
    readonly detail: BackgroundWorkDetail;
    readonly streamsOutput: boolean;
  },
) {
  const gt = useGT();
  const { detail } = props;
  const { item, turnItem, command, startedAtMs, childThreadId, pullRequest } = detail;
  const wireCommand = turnItem?.type === "command_execution" ? turnItem : undefined;
  const fetchesOutput = wireCommand?.outputOmitted === true;
  const fetchedOutput = useTurnItemDetail(
    fetchesOutput && wireCommand
      ? {
          environmentId: props.environmentId,
          threadId: wireCommand.threadId,
          itemId: wireCommand.id,
          revision: turnItemDetailRevision(wireCommand),
        }
      : null,
  );
  const fetchedItem = fetchedOutput.data?.item;
  const commandItem = fetchedItem?.type === "command_execution" ? fetchedItem : wireCommand;
  const outputFile = backgroundCommandOutputFile(commandItem?.output) ?? detail.outputFile;
  const pendingOutput = fetchesOutput && commandItem === wireCommand && fetchedOutput.isPending;
  // A finished launch call only holds its launch message; the work's output lives elsewhere.
  const outputRunning = commandItem?.status === "running";
  const Icon = KIND_ICONS[item.kind];
  const kindLabel =
    item.kind === "subagent"
      ? gt("Subagent", { $context: "kind of background work" })
      : item.kind === "command"
        ? gt("Command", { $context: "title of a background shell command" })
        : item.kind === "monitor"
          ? gt("Monitor", { $context: "kind of background work" })
          : gt("Background task", { $context: "kind of background work" });
  const heading = item.named && !detail.isRawCommand ? item.label : kindLabel;
  const waiting = backgroundWorkHoldsCompletion([
    { kind: item.kind, awaited: detail.awaited ? true : undefined },
  ]);
  const description = turnItem?.title?.trim();
  const prHref = pullRequest ? resolveExternalWebLinkHref(pullRequest.url) : null;
  return (
    <section className="space-y-2 border-b border-border/50 pb-4 text-sm last:border-0 last:pb-0">
      <div className="flex items-start gap-2">
        <Icon aria-hidden className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="font-medium wrap-anywhere">{heading}</h3>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {heading === kindLabel ? null : (
              <>
                <span>{kindLabel}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span>
              {waiting
                ? gt("Waiting", { $context: "status of background work" })
                : gt("Running", { $context: "status of background work" })}
            </span>
            {startedAtMs === null ? null : (
              <>
                <span aria-hidden>·</span>
                <span
                  className="tabular-nums"
                  ref={tickTextContent(
                    (nowMs) => formatDuration(Math.max(1_000, nowMs - startedAtMs), m),
                    true,
                  )}
                />
              </>
            )}
          </div>
        </div>
      </div>
      {description && description !== item.label && description !== command ? (
        <p className="whitespace-pre-wrap text-muted-foreground">{description}</p>
      ) : null}
      {command === null ? null : (
        <div className="space-y-1.5 rounded-md border border-border/50 bg-muted/15 p-2">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              <T>Command</T>
            </span>
            <MessageCopyButton
              text={command}
              label={gt("Copy command")}
              variant="ghost"
              size="icon-xs"
            />
          </div>
          <div className={MONO_CLASS_NAME}>
            <ShellCommandBlock command={command} />
          </div>
        </div>
      )}
      {outputFile !== null ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            <T>Output file</T>
          </p>
          <pre className={MONO_CLASS_NAME}>{outputFile}</pre>
          {props.onRunInTerminal ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => props.onRunInTerminal?.(followOutputFileCommand(outputFile))}
            >
              <TerminalIcon />
              <T>Follow in terminal</T>
            </Button>
          ) : null}
        </div>
      ) : commandItem && (outputRunning || pendingOutput || fetchedOutput.error) ? (
        <div className={MONO_CLASS_NAME}>
          {pendingOutput ? (
            <p className="text-muted-foreground italic">
              <T>Loading output…</T>
            </p>
          ) : fetchedOutput.error ? (
            <p className="text-destructive">
              <T>
                Couldn&apos;t load output: <Var>{fetchedOutput.error}</Var>
              </T>
            </p>
          ) : props.streamsOutput ? (
            <CommandOutputPanel
              environmentId={props.environmentId}
              threadId={commandItem.threadId}
              itemId={commandItem.id}
            />
          ) : commandItem.output ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-muted-foreground">
              {commandItem.output}
            </pre>
          ) : (
            <p className="text-muted-foreground italic">
              <T>No output yet.</T>
            </p>
          )}
        </div>
      ) : null}
      {detail.activity ? (
        <p className="whitespace-pre-wrap text-muted-foreground">{detail.activity}</p>
      ) : null}
      {childThreadId === undefined ? null : (
        <Button size="xs" variant="outline" onClick={() => props.onOpenThread(childThreadId)}>
          <T>Open thread</T>
        </Button>
      )}
      {pullRequest ? (
        <div className="space-y-1">
          {prHref ? (
            <a
              href={prHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium hover:underline"
            >
              #{pullRequest.number} {pullRequest.snapshot?.title ?? gt("Pull request")}
              <ExternalLinkIcon aria-hidden className="size-3" />
            </a>
          ) : (
            <p>
              #{pullRequest.number} {pullRequest.snapshot?.title ?? gt("Pull request")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            <T>Watching</T>
            {pullRequest.snapshot
              ? ` · ${pullRequest.snapshot.isDraft ? `${gt("Draft")} · ` : ""}${pullRequest.snapshot.state}`
              : ""}
            {pullRequest.snapshot?.checksState
              ? ` · ${gt("checks")} ${pullRequest.snapshot.checksState}`
              : ""}
          </p>
        </div>
      ) : null}
      {turnItem?.type === "dynamic_tool" ? (
        <V2ItemInspector
          environmentId={props.environmentId}
          projectedItem={{
            position: turnItem.ordinal,
            visibility: "local",
            sourceThreadId: turnItem.threadId,
            sourceItemId: turnItem.id,
            item: turnItem,
          }}
        />
      ) : null}
      {turnItem === undefined &&
      command === null &&
      pullRequest === undefined &&
      detail.activity === null &&
      childThreadId === undefined ? (
        <p className="text-muted-foreground">
          <T>No additional details reported yet.</T>
        </p>
      ) : null}
    </section>
  );
}

/** The background work line's Details action: every task with its command, output, and links. */
export function BackgroundWorkDetails(props: BackgroundWorkDetailsProps) {
  const [open, setOpen] = useState(false);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  const { onRunInTerminal } = props;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<InlineButton tone="muted" />}>
        <T>Details</T>
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <T>Background work</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {props.details.map((detail) => (
            <BackgroundWorkSection
              key={detail.item.taskId}
              detail={detail}
              streamsOutput={streamsOutput}
              environmentId={props.environmentId}
              onOpenThread={(threadId) => {
                setOpen(false);
                props.onOpenThread(threadId);
              }}
              onRunInTerminal={
                onRunInTerminal
                  ? (command) => {
                      setOpen(false);
                      onRunInTerminal(command);
                    }
                  : undefined
              }
            />
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
