import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { mergeScratchMarkdown3Way } from "@t3tools/shared/scratchDocument";
import type {
  EnvironmentId,
  ScratchAttachment,
  ScratchConsumeChunkInput,
  ScratchDocumentSnapshot,
  ScratchKey,
  ScratchSaveInput,
  ScratchSetCursorInput,
  ScratchStreamEvent,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { useStableCallback } from "~/hooks/useStableCallback";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentQuery } from "~/state/query";
import {
  enqueuePendingScratchConsumption,
  readPendingScratchConsumptions,
  recordEstablishedScratchOwner,
  removePendingScratchConsumption,
  scratchDocumentStream,
  scratchEnvironment,
} from "~/state/scratch";

const SAVE_DEBOUNCE_MS = 400;
const CURSOR_DEBOUNCE_MS = 250;
const CONSUME_CONFLICT_ATTEMPTS = 3;

export type ScratchSaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

const TARGET_BUFFER_SYMBOL = Symbol("ScratchDocumentTargetBuffer");

export interface ScratchDocumentTarget {
  readonly environmentId: EnvironmentId;
  readonly scratchKey: ScratchKey;
  readonly [TARGET_BUFFER_SYMBOL]: TargetBuffer;
}

export interface ScratchDocumentHandle {
  readonly markdown: string;
  readonly attachments: ReadonlyArray<ScratchAttachment>;
  readonly getAttachments: () => ReadonlyArray<ScratchAttachment>;
  readonly revision: number;
  readonly getRevision: () => number;
  readonly lastCursorOffset: number;
  /** Increments whenever another device updates the global cursor offset. */
  readonly remoteCursorSeq: number;
  /** Increments whenever a chunk consumption commits on this target so undo history resets. */
  readonly consumptionSeq: number;
  readonly status: ScratchSaveStatus;
  readonly isLoading: boolean;
  readonly isLoaded: boolean;
  readonly error: string | null;
  readonly captureTarget: () => ScratchDocumentTarget;
  readonly setMarkdown: (markdown: string) => void;
  readonly setCursorOffset: (offset: number, options?: { readonly immediate?: boolean }) => void;
  readonly flush: () => Promise<void>;
  /** Consumes an armed chunk on the server after thread submission succeeds. */
  readonly consumeRange: (input: {
    readonly target?: ScratchDocumentTarget;
    readonly consumptionId?: string;
    readonly baseMarkdown: string;
    readonly baseRevision: number;
    readonly nextMarkdown: string;
    readonly nextCursorOffset: number;
    readonly attachmentIds: ReadonlyArray<ScratchAttachment["attachmentId"]>;
  }) => Promise<
    | {
        readonly ok: true;
        readonly appliedMarkdown: string;
        readonly nextCursorOffset: number;
      }
    | { readonly ok: false }
  >;
  readonly reload: () => void;
}

interface ScratchTransport {
  readonly save: typeof scratchEnvironment.save;
  readonly setCursor?: typeof scratchEnvironment.setCursor;
  readonly consumeChunk: typeof scratchEnvironment.consumeChunk;
}

/**
 * Per-target mutable editing state so switching projects allocates a fresh buffer while the
 * departing project's queued save/flush finishes with its own up-to-date revision and base.
 */
interface TargetBuffer {
  readonly targetKey: string;
  readonly environmentId: EnvironmentId;
  readonly scratchKey: ScratchKey;
  markdown: string;
  savedMarkdown: string;
  attachments: ReadonlyArray<ScratchAttachment>;
  revision: number;
  cursorOffset: number;
  sentCursorOffset: number;
  dirty: boolean;
  saveFailed: boolean;
  writeChain: Promise<unknown>;
}

function createTargetBuffer(
  environmentId: EnvironmentId,
  scratchKey: ScratchKey,
  snapshot: ScratchStreamEvent | null,
): TargetBuffer {
  const matches = snapshot !== null && snapshot.scratchKey === scratchKey;
  const initialMarkdown = matches ? snapshot.markdown : "";
  const initialCursor = matches ? snapshot.lastCursorOffset : 0;
  return {
    targetKey: `${environmentId}|${scratchKey}`,
    environmentId,
    scratchKey,
    markdown: initialMarkdown,
    savedMarkdown: initialMarkdown,
    attachments: matches ? snapshot.attachments : [],
    revision: matches ? snapshot.revision : 0,
    cursorOffset: initialCursor,
    sentCursorOffset: initialCursor,
    dirty: false,
    saveFailed: false,
    writeChain: Promise.resolve(),
  };
}

function enqueueOnBuffer<A>(buffer: TargetBuffer, task: () => Promise<A>): Promise<A> {
  const run = buffer.writeChain.then(task, task);
  buffer.writeChain = run.catch(() => undefined);
  return run;
}

function isRevisionConflict(
  failure: unknown,
): failure is { readonly current: ScratchDocumentSnapshot } {
  return (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "ScratchRevisionConflictError" &&
    "current" in failure
  );
}

function createClientId(): string {
  return randomUUID();
}

export function useScratchDocument(input: {
  readonly environmentId: EnvironmentId;
  readonly scratchKey: ScratchKey;
  readonly enabled?: boolean;
  readonly transport?: ScratchTransport;
}): ScratchDocumentHandle {
  const { environmentId, scratchKey } = input;
  const transport = input.transport ?? scratchEnvironment;
  const setCursorCommand = transport.setCursor ?? scratchEnvironment.setCursor;
  const documentAtom = scratchDocumentStream({ environmentId, input: { scratchKey } });
  const query = useEnvironmentQuery<ScratchStreamEvent, unknown>(
    input.enabled === false ? null : documentAtom,
  );
  const snapshot = query.data;

  const currentTargetKey = `${environmentId}|${scratchKey}`;
  const [loadedTargetKey, setLoadedTargetKey] = useState<string | null>(() =>
    snapshot !== null && snapshot.scratchKey === scratchKey ? currentTargetKey : null,
  );
  const [markdown, setMarkdownState] = useState(() =>
    snapshot !== null && snapshot.scratchKey === scratchKey ? snapshot.markdown : "",
  );
  const [attachments, setAttachments] = useState<ReadonlyArray<ScratchAttachment>>(() =>
    snapshot !== null && snapshot.scratchKey === scratchKey ? snapshot.attachments : [],
  );
  const [revision, setRevision] = useState(() =>
    snapshot !== null && snapshot.scratchKey === scratchKey ? snapshot.revision : 0,
  );
  const [lastCursorOffset, setLastCursorOffset] = useState(() =>
    snapshot !== null && snapshot.scratchKey === scratchKey ? snapshot.lastCursorOffset : 0,
  );
  const [remoteCursorSeq, setRemoteCursorSeq] = useState(0);
  const [consumptionSeq, setConsumptionSeq] = useState(0);
  const [status, setStatus] = useState<ScratchSaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const [clientId] = useState(createClientId);
  const bufferRef = useRef<TargetBuffer>(createTargetBuffer(environmentId, scratchKey, snapshot));
  const pendingReplayKeyRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const cursorTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const isActiveBuffer = (buffer: TargetBuffer): boolean =>
    mountedRef.current && bufferRef.current === buffer;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const clearCursorTimer = () => {
    if (cursorTimerRef.current !== null) {
      window.clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = null;
    }
  };

  const sendCursorNow = useStableCallback((buffer: TargetBuffer) => {
    if (buffer.dirty) return;
    const clamped = Math.min(buffer.cursorOffset, buffer.markdown.length);
    if (clamped === buffer.sentCursorOffset) return;
    if (buffer.revision === 0 && buffer.markdown.length === 0) return;
    const cursorInput: ScratchSetCursorInput = {
      scratchKey: buffer.scratchKey,
      cursorOffset: clamped,
      clientId,
    };
    void runAtomCommand(
      appAtomRegistry,
      setCursorCommand,
      { environmentId: buffer.environmentId, input: cursorInput },
      { label: "sync scratch global cursor", reportFailure: false },
    ).then((result) => {
      if (result._tag === "Success") {
        buffer.sentCursorOffset = clamped;
      }
    });
  });

  // Allocate a fresh TargetBuffer on project/env switch; flush the departing buffer on its own write chain.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- switches the local editing buffer when the target scratch key changes
  useEffect(() => {
    const nextTargetKey = `${environmentId}|${scratchKey}`;
    if (bufferRef.current.targetKey !== nextTargetKey) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (cursorTimerRef.current !== null) {
        window.clearTimeout(cursorTimerRef.current);
        cursorTimerRef.current = null;
      }
      bufferRef.current = createTargetBuffer(environmentId, scratchKey, null);
      setMarkdownState("");
      setAttachments([]);
      setRevision(0);
      setLastCursorOffset(0);
      setLoadedTargetKey(null);
      setStatus("idle");
      setError(null);
    }
    mountedRef.current = true;
    const buffer = bufferRef.current;
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (cursorTimerRef.current !== null) {
        window.clearTimeout(cursorTimerRef.current);
        cursorTimerRef.current = null;
      }
      if (buffer.dirty) {
        void enqueueOnBuffer(buffer, async () => {
          // Run after any in-flight persistNow on this buffer so revision & savedMarkdown are current.
          if (!buffer.dirty || buffer.markdown === buffer.savedMarkdown) {
            buffer.dirty = false;
            return;
          }
          const finalBaseMarkdown = buffer.savedMarkdown;
          const finalMarkdown = buffer.markdown;
          const finalRevision = buffer.revision;
          const finalCursor = buffer.cursorOffset;
          buffer.dirty = false;
          const sendSave = (expectedRevision: number, markdownToSave: string) =>
            runAtomCommand(
              appAtomRegistry,
              transport.save,
              {
                environmentId: buffer.environmentId,
                input: {
                  scratchKey: buffer.scratchKey,
                  markdown: markdownToSave,
                  expectedRevision,
                  clientId,
                  cursorOffset: Math.min(finalCursor, markdownToSave.length),
                },
              },
              { label: "flush scratch document on leave", reportFailure: false },
            );
          let persistedMarkdown = finalMarkdown;
          let result = await sendSave(finalRevision, persistedMarkdown);
          if (result._tag !== "Success") {
            const failure = squashAtomCommandFailure(result);
            if (isRevisionConflict(failure)) {
              const merged = mergeScratchMarkdown3Way(
                finalBaseMarkdown,
                finalMarkdown,
                failure.current.markdown,
              );
              persistedMarkdown = merged;
              if (merged === failure.current.markdown) {
                if (failure.current.revision >= buffer.revision) {
                  buffer.revision = failure.current.revision;
                  buffer.markdown = merged;
                  buffer.savedMarkdown = merged;
                  buffer.attachments = failure.current.attachments;
                  buffer.sentCursorOffset = Math.min(finalCursor, merged.length);
                }
                return;
              }
              result = await sendSave(failure.current.revision, merged);
            }
          }
          if (result._tag === "Success" && result.value.revision >= buffer.revision) {
            buffer.revision = result.value.revision;
            buffer.markdown = persistedMarkdown;
            buffer.savedMarkdown = persistedMarkdown;
            buffer.attachments = result.value.attachments;
            buffer.sentCursorOffset = Math.min(finalCursor, persistedMarkdown.length);
          }
        });
      } else {
        sendCursorNow(buffer);
      }
      mountedRef.current = false;
    };
  }, [clientId, environmentId, scratchKey, sendCursorNow, transport.save]);

  async function persistBuffer(buffer: TargetBuffer): Promise<void> {
    while (buffer.dirty) {
      const nextMarkdown = buffer.markdown;
      if (nextMarkdown === buffer.savedMarkdown) {
        buffer.dirty = false;
        if (isActiveBuffer(buffer)) setStatus("saved");
        return;
      }

      if (isActiveBuffer(buffer)) setStatus("saving");
      const cursorToSend = Math.min(buffer.cursorOffset, nextMarkdown.length);
      const saveInput: ScratchSaveInput = {
        scratchKey: buffer.scratchKey,
        markdown: nextMarkdown,
        expectedRevision: buffer.revision,
        clientId,
        cursorOffset: cursorToSend,
      };
      const result = await runAtomCommand(
        appAtomRegistry,
        transport.save,
        { environmentId: buffer.environmentId, input: saveInput },
        { label: "save scratch document", reportFailure: false },
      );

      if (result._tag === "Success") {
        buffer.saveFailed = false;
        // Never roll back revision/base if a newer remote stream event arrived while save was in flight.
        if (result.value.revision >= buffer.revision) {
          buffer.revision = result.value.revision;
          buffer.attachments = result.value.attachments;
          buffer.savedMarkdown = nextMarkdown;
          buffer.sentCursorOffset = cursorToSend;
          if (isActiveBuffer(buffer)) {
            setRevision(result.value.revision);
            setAttachments(result.value.attachments);
          }
        }
        if (buffer.markdown === nextMarkdown) {
          buffer.dirty = false;
          if (isActiveBuffer(buffer)) {
            setStatus("saved");
            setError(null);
          }
          if (Math.min(buffer.cursorOffset, buffer.markdown.length) !== buffer.sentCursorOffset) {
            sendCursorNow(buffer);
          }
          return;
        }
        continue;
      }

      const failure = squashAtomCommandFailure(result);
      if (!isRevisionConflict(failure)) {
        buffer.saveFailed = true;
        if (isActiveBuffer(buffer)) {
          setStatus("error");
          setError(
            failure instanceof Error ? failure.message : m(msg("Could not save the scratch page.")),
          );
        }
        return;
      }

      const current = failure.current;
      const merged = mergeScratchMarkdown3Way(
        buffer.savedMarkdown,
        buffer.markdown,
        current.markdown,
      );
      buffer.revision = current.revision;
      buffer.attachments = current.attachments;
      buffer.savedMarkdown = current.markdown;
      buffer.markdown = merged;
      buffer.dirty = merged !== current.markdown;
      if (isActiveBuffer(buffer)) {
        setRevision(current.revision);
        setAttachments(current.attachments);
        setMarkdownState(merged);
        setStatus("conflict");
      }
      if (!buffer.dirty) return;
    }
  }

  function persist(buffer: TargetBuffer): Promise<void> {
    return enqueueOnBuffer(buffer, () => persistBuffer(buffer));
  }

  const schedule = useStableCallback(() => {
    clearTimer();
    const buffer = bufferRef.current;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void persist(buffer);
    }, SAVE_DEBOUNCE_MS);
  });

  function setMarkdown(next: string): void {
    const buffer = bufferRef.current;
    buffer.markdown = next;
    buffer.saveFailed = false;
    setMarkdownState(next);
    if (next === buffer.savedMarkdown) {
      buffer.dirty = false;
      setStatus("saved");
      return;
    }
    buffer.dirty = true;
    setStatus("saving");
    schedule();
  }

  function setCursorOffset(offset: number, options?: { readonly immediate?: boolean }): void {
    const buffer = bufferRef.current;
    const clamped = Math.max(0, Math.min(Math.trunc(offset), buffer.markdown.length));
    buffer.cursorOffset = clamped;
    setLastCursorOffset(clamped);
    if (buffer.dirty) return;
    clearCursorTimer();
    if (options?.immediate) {
      sendCursorNow(buffer);
      return;
    }
    cursorTimerRef.current = window.setTimeout(() => {
      cursorTimerRef.current = null;
      sendCursorNow(buffer);
    }, CURSOR_DEBOUNCE_MS);
  }

  async function flush(): Promise<void> {
    clearTimer();
    await persist(bufferRef.current);
  }

  async function executeConsumeOnBuffer(
    buffer: TargetBuffer,
    range: {
      readonly consumptionId: string;
      readonly baseMarkdown: string;
      readonly baseRevision: number;
      readonly nextMarkdown: string;
      readonly nextCursorOffset: number;
      readonly attachmentIds: ReadonlyArray<ScratchAttachment["attachmentId"]>;
    },
  ): Promise<
    | {
        readonly ok: true;
        readonly appliedMarkdown: string;
        readonly nextCursorOffset: number;
      }
    | { readonly ok: false }
  > {
    if (isActiveBuffer(buffer)) {
      await persistBuffer(buffer);
    }
    const sendConsume = (expectedRevision: number, nextMarkdown: string) => {
      const clampedCursor = Math.min(range.nextCursorOffset, nextMarkdown.length);
      const consumeInput: ScratchConsumeChunkInput = {
        scratchKey: buffer.scratchKey,
        expectedRevision,
        clientId,
        nextMarkdown,
        nextCursorOffset: clampedCursor,
        consumedAttachmentIds: range.attachmentIds,
        consumptionId: range.consumptionId,
      };
      return runAtomCommand(
        appAtomRegistry,
        transport.consumeChunk,
        { environmentId: buffer.environmentId, input: consumeInput },
        { label: "consume scratch chunk", reportFailure: false },
      );
    };

    const localMarkdownBeforeRpc = buffer.markdown;
    let appliedMarkdown =
      buffer.markdown !== range.baseMarkdown
        ? mergeScratchMarkdown3Way(range.baseMarkdown, range.nextMarkdown, buffer.markdown)
        : range.nextMarkdown;
    let expectedRevision = Math.max(buffer.revision, range.baseRevision);
    let result = await sendConsume(expectedRevision, appliedMarkdown);
    for (
      let attempt = 1;
      attempt < CONSUME_CONFLICT_ATTEMPTS && result._tag !== "Success";
      attempt += 1
    ) {
      const failure = squashAtomCommandFailure(result);
      if (!isRevisionConflict(failure)) break;
      const conflict = failure.current;
      appliedMarkdown =
        conflict.markdown === range.baseMarkdown
          ? range.nextMarkdown
          : mergeScratchMarkdown3Way(range.baseMarkdown, range.nextMarkdown, conflict.markdown);
      if (conflict.revision > buffer.revision) {
        buffer.revision = conflict.revision;
      }
      expectedRevision = conflict.revision;
      result = await sendConsume(expectedRevision, appliedMarkdown);
    }

    if (result._tag === "Success") {
      removePendingScratchConsumption(range.consumptionId);
      const serverMarkdown = result.value.markdown;
      const serverCursorOffset = Math.min(result.value.lastCursorOffset, serverMarkdown.length);
      if (result.value.revision >= buffer.revision) {
        buffer.revision = result.value.revision;
        buffer.savedMarkdown = serverMarkdown;
        buffer.attachments = result.value.attachments;
        if (buffer.markdown !== localMarkdownBeforeRpc) {
          const merged = mergeScratchMarkdown3Way(
            localMarkdownBeforeRpc,
            buffer.markdown,
            serverMarkdown,
          );
          buffer.markdown = merged;
          buffer.dirty = merged !== serverMarkdown;
          if (buffer.dirty && isActiveBuffer(buffer)) {
            schedule();
          }
        } else {
          buffer.markdown = serverMarkdown;
          buffer.cursorOffset = serverCursorOffset;
          buffer.sentCursorOffset = serverCursorOffset;
          buffer.dirty = false;
        }
      }
      if (isActiveBuffer(buffer)) {
        setRevision(buffer.revision);
        setMarkdownState(buffer.markdown);
        setAttachments(buffer.attachments);
        setLastCursorOffset(buffer.cursorOffset);
        setConsumptionSeq((seq) => seq + 1);
        setStatus(buffer.dirty ? "saving" : buffer.markdown.trim().length === 0 ? "idle" : "saved");
        setError(null);
      }
      return {
        ok: true,
        appliedMarkdown: buffer.markdown,
        nextCursorOffset: buffer.cursorOffset,
      } as const;
    }

    enqueuePendingScratchConsumption({
      consumptionId: range.consumptionId,
      environmentId: buffer.environmentId,
      scratchKey: buffer.scratchKey,
      baseMarkdown: range.baseMarkdown,
      baseRevision: range.baseRevision,
      nextMarkdown: range.nextMarkdown,
      nextCursorOffset: range.nextCursorOffset,
      attachmentIds: range.attachmentIds,
    });
    if (isActiveBuffer(buffer)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : m(msg("Could not update the scratch page.")),
      );
    }
    return { ok: false } as const;
  }

  function captureTarget(): ScratchDocumentTarget {
    const buffer = bufferRef.current;
    return {
      environmentId: buffer.environmentId,
      scratchKey: buffer.scratchKey,
      [TARGET_BUFFER_SYMBOL]: buffer,
    };
  }

  async function consumeRange(range: {
    readonly target?: ScratchDocumentTarget;
    readonly consumptionId?: string;
    readonly baseMarkdown: string;
    readonly baseRevision: number;
    readonly nextMarkdown: string;
    readonly nextCursorOffset: number;
    readonly attachmentIds: ReadonlyArray<ScratchAttachment["attachmentId"]>;
  }): Promise<
    | {
        readonly ok: true;
        readonly appliedMarkdown: string;
        readonly nextCursorOffset: number;
      }
    | { readonly ok: false }
  > {
    const buffer = range.target?.[TARGET_BUFFER_SYMBOL] ?? bufferRef.current;
    if (bufferRef.current === buffer) {
      clearTimer();
      clearCursorTimer();
    }
    const consumptionId = range.consumptionId ?? randomUUID();
    return enqueueOnBuffer(buffer, () =>
      executeConsumeOnBuffer(buffer, { ...range, consumptionId }),
    );
  }

  const replayPendingConsumptions = useStableCallback((buffer: TargetBuffer) => {
    const pending = readPendingScratchConsumptions(buffer.environmentId, buffer.scratchKey);
    if (pending.length === 0) return;
    for (const entry of pending) {
      void enqueueOnBuffer(buffer, () => executeConsumeOnBuffer(buffer, entry));
    }
  });

  // oxlint-disable t3code/no-unreasoned-state-sync -- mirrors the scratch document stream, including other devices' writes and global cursor moves, into local edit state
  useEffect(() => {
    if (input.enabled === false || snapshot === null || snapshot.scratchKey !== scratchKey) {
      pendingReplayKeyRef.current = null;
      return;
    }
    const buffer = bufferRef.current;
    if (buffer.targetKey !== currentTargetKey) {
      pendingReplayKeyRef.current = null;
      return;
    }
    if (snapshot.revision < buffer.revision) return;
    const alreadyLoaded = loadedTargetKey === currentTargetKey;
    setLoadedTargetKey(currentTargetKey);

    const applySnapshot = () => {
      // Suppress self-echoes so fast typing or local cursor moves never fight live input.
      if (snapshot.originClientId === clientId) {
        if (snapshot.revision >= buffer.revision) {
          buffer.revision = snapshot.revision;
          buffer.savedMarkdown = snapshot.markdown;
          buffer.attachments = snapshot.attachments;
          setRevision(snapshot.revision);
          setAttachments(snapshot.attachments);
          if (!buffer.dirty) {
            buffer.markdown = snapshot.markdown;
            setMarkdownState(snapshot.markdown);
          }
        }
        return;
      }

      // Same revision & markdown: attachment refresh or remote global cursor move (never yank active typing).
      if (snapshot.revision === buffer.revision && snapshot.markdown === buffer.savedMarkdown) {
        buffer.attachments = snapshot.attachments;
        setAttachments(snapshot.attachments);
        if (!buffer.dirty && snapshot.lastCursorOffset !== buffer.cursorOffset) {
          buffer.cursorOffset = snapshot.lastCursorOffset;
          buffer.sentCursorOffset = snapshot.lastCursorOffset;
          setLastCursorOffset(snapshot.lastCursorOffset);
          if (snapshot.originClientId !== null || alreadyLoaded) {
            setRemoteCursorSeq((seq) => seq + 1);
          }
        }
        return;
      }

      const remoteIsNewer = snapshot.revision > buffer.revision;
      buffer.revision = snapshot.revision;
      buffer.attachments = snapshot.attachments;
      setRevision(snapshot.revision);
      setAttachments(snapshot.attachments);

      if (!buffer.dirty) {
        buffer.savedMarkdown = snapshot.markdown;
        buffer.markdown = snapshot.markdown;
        buffer.cursorOffset = snapshot.lastCursorOffset;
        buffer.sentCursorOffset = snapshot.lastCursorOffset;
        setMarkdownState(snapshot.markdown);
        setLastCursorOffset(snapshot.lastCursorOffset);
        if (snapshot.originClientId !== null || alreadyLoaded) {
          setRemoteCursorSeq((seq) => seq + 1);
        }
        if (snapshot.markdown.trim().length > 0) setStatus("saved");
        return;
      }

      if (!remoteIsNewer) return;
      const merged = mergeScratchMarkdown3Way(
        buffer.savedMarkdown,
        buffer.markdown,
        snapshot.markdown,
      );
      buffer.savedMarkdown = snapshot.markdown;
      if (merged !== buffer.markdown) {
        buffer.markdown = merged;
        setMarkdownState(merged);
        schedule();
      }
    };

    applySnapshot();
    if (buffer.revision > 0) {
      recordEstablishedScratchOwner(buffer.scratchKey, buffer.environmentId, buffer.revision);
    }
    if (buffer.dirty && buffer.saveFailed) {
      buffer.saveFailed = false;
      schedule();
    }
    if (
      pendingReplayKeyRef.current !== currentTargetKey ||
      readPendingScratchConsumptions(buffer.environmentId, buffer.scratchKey).length > 0
    ) {
      pendingReplayKeyRef.current = currentTargetKey;
      replayPendingConsumptions(buffer);
    }
  }, [
    clientId,
    currentTargetKey,
    input.enabled,
    loadedTargetKey,
    replayPendingConsumptions,
    schedule,
    scratchKey,
    snapshot,
  ]);
  // oxlint-enable t3code/no-unreasoned-state-sync

  const targetMatches = loadedTargetKey === currentTargetKey;
  return {
    markdown: targetMatches ? markdown : "",
    attachments: targetMatches ? attachments : [],
    getAttachments: () =>
      bufferRef.current.targetKey === currentTargetKey ? bufferRef.current.attachments : [],
    revision: targetMatches ? revision : 0,
    getRevision: () =>
      bufferRef.current.targetKey === currentTargetKey ? bufferRef.current.revision : 0,
    lastCursorOffset: targetMatches ? lastCursorOffset : 0,
    remoteCursorSeq,
    consumptionSeq,
    status,
    isLoading: query.isPending && !targetMatches,
    isLoaded: targetMatches,
    error: error ?? query.error,
    captureTarget,
    setMarkdown,
    setCursorOffset,
    flush,
    consumeRange,
    reload: query.refresh,
  };
}
