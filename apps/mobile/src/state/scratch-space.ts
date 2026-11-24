import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScratchKey, ScratchStreamEvent } from "@t3tools/contracts";
import {
  mergeScratchMarkdown3Way,
  splitScratchMarkdownBlocks,
  type ScratchMarkdownBlock,
} from "@t3tools/shared/scratchDocument";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { appAtomRegistry } from "./atom-registry";
import {
  consumeScratchChunk,
  createScratchDocumentStore,
  loadPendingMobileScratchConsumptions,
  recordEstablishedScratchOwner,
  removePendingMobileScratchConsumption,
  scratchDocumentClientId,
  scratchDocumentStream,
  scratchEnvironment,
  scratchKeyOfProject,
  scratchRevisionConflictOf,
  scratchViewStateStore,
  useScratchOwnerEnvironment,
  type ScratchDocumentState,
  type ScratchDocumentStore,
  type ScratchProject,
} from "./scratch";

export interface ArmedScratchRange {
  readonly scratchKey: ScratchKey;
  readonly startIndex: number;
  readonly endIndex: number;
  /** Snapshot of armed block markdowns so remote prepends rebase cleanly and never shift onto unrelated prose. */
  readonly expectedBlocks?: ReadonlyArray<string>;
}

const EMPTY_STATE: ScratchDocumentState = {
  scratchKey: "" as ScratchKey,
  markdown: "",
  attachments: [],
  revision: 0,
  lastCursorOffset: 0,
  loaded: false,
  dirty: false,
  saving: false,
  saveFailed: false,
  mergedRemoteEdit: false,
};

interface ScratchSpaceEntry {
  readonly environmentId: EnvironmentId;
  readonly scratchKey: ScratchKey;
  readonly store: ScratchDocumentStore;
}

const entries = new Map<string, ScratchSpaceEntry>();
const consumerCounts = new Map<string, number>();
const entryListeners = new Map<string, Set<() => void>>();
let armed: ArmedScratchRange | null = null;
const armedListeners = new Set<() => void>();

function emitArmed(): void {
  for (const listener of armedListeners) listener();
}

function emitEntry(key: string): void {
  const listeners = entryListeners.get(key);
  if (listeners === undefined) return;
  for (const listener of listeners) listener();
}

function spaceKey(environmentId: EnvironmentId, scratchKey: ScratchKey): string {
  return `${environmentId}|${scratchKey}`;
}

function snapshotBlocks(
  blocks: ReadonlyArray<ScratchMarkdownBlock> | undefined,
  startIndex: number,
  endIndex: number,
): ReadonlyArray<string> | undefined {
  if (blocks === undefined) return undefined;
  return blocks.slice(startIndex, endIndex + 1).map((block) => block.markdown);
}

function retainOrCreateEntry(
  environmentId: EnvironmentId,
  scratchKey: ScratchKey,
): ScratchSpaceEntry {
  const key = spaceKey(environmentId, scratchKey);
  consumerCounts.set(key, (consumerCounts.get(key) ?? 0) + 1);
  const existing = entries.get(key);
  if (existing !== undefined) return existing;
  const store = createScratchDocumentStore({
    scratchKey,
    clientId: scratchDocumentClientId(),
    save: async (input) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        scratchEnvironment.save,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Success") return result.value;
      throw squashAtomCommandFailure(result);
    },
    setCursor: async (input) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        scratchEnvironment.setCursor,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Success") return result.value;
      throw squashAtomCommandFailure(result);
    },
  });
  const entry: ScratchSpaceEntry = {
    environmentId,
    scratchKey,
    store,
  };
  entries.set(key, entry);
  emitEntry(key);
  return entry;
}

function releaseEntry(entry: ScratchSpaceEntry): void {
  const key = spaceKey(entry.environmentId, entry.scratchKey);
  const next = Math.max(0, (consumerCounts.get(key) ?? 1) - 1);
  if (next > 0) {
    consumerCounts.set(key, next);
    return;
  }
  consumerCounts.delete(key);
  void entry.store.flush().finally(() => {
    if ((consumerCounts.get(key) ?? 0) === 0 && entries.get(key) === entry) {
      entry.store.dispose();
      entries.delete(key);
      emitEntry(key);
    }
  });
}

export function armedScratchRange(): ArmedScratchRange | null {
  return armed;
}

export function armScratchRange(
  scratchKey: ScratchKey,
  index: number,
  blocks?: ReadonlyArray<ScratchMarkdownBlock>,
): void {
  const expectedBlocks = snapshotBlocks(blocks, index, index);
  armed = {
    scratchKey,
    startIndex: index,
    endIndex: index,
    ...(expectedBlocks === undefined ? {} : { expectedBlocks }),
  };
  emitArmed();
}

export function extendScratchRange(
  scratchKey: ScratchKey,
  index: number,
  blocks?: ReadonlyArray<ScratchMarkdownBlock>,
): void {
  if (armed === null || armed.scratchKey !== scratchKey) {
    armScratchRange(scratchKey, index, blocks);
    return;
  }
  const startIndex = Math.min(armed.startIndex, armed.endIndex, index);
  const endIndex = Math.max(armed.startIndex, armed.endIndex, index);
  const expectedBlocks = snapshotBlocks(blocks, startIndex, endIndex);
  armed = {
    scratchKey,
    startIndex,
    endIndex,
    ...(expectedBlocks === undefined ? {} : { expectedBlocks }),
  };
  emitArmed();
}

/** Shrinks the range from either edge while keeping it contiguous. */
export function trimScratchRange(
  scratchKey: ScratchKey,
  edge: "start" | "end",
  blocks?: ReadonlyArray<ScratchMarkdownBlock>,
): void {
  if (armed === null || armed.scratchKey !== scratchKey) return;
  let startIndex = armed.startIndex;
  let endIndex = armed.endIndex;
  if (edge === "end" && endIndex > startIndex) {
    endIndex -= 1;
  } else if (edge === "start" && startIndex < endIndex) {
    startIndex += 1;
  } else {
    armed = null;
    emitArmed();
    return;
  }
  const expectedBlocks = snapshotBlocks(blocks, startIndex, endIndex);
  armed = {
    scratchKey,
    startIndex,
    endIndex,
    ...(expectedBlocks === undefined ? {} : { expectedBlocks }),
  };
  emitArmed();
}

export function releaseScratchRange(): void {
  if (armed === null) return;
  armed = null;
  emitArmed();
}

/**
 * Keeps the armed block range aligned when local edits split, clear, remove, or insert blocks.
 * If the armed range shrinks to zero blocks, releases it instead of pulling in adjacent prose.
 */
export function adjustArmedScratchRange(
  scratchKey: ScratchKey,
  atIndex: number,
  delta: number,
  totalBlocks: number,
  nextBlocks?: ReadonlyArray<ScratchMarkdownBlock>,
): void {
  if (armed === null || armed.scratchKey !== scratchKey) return;
  if (totalBlocks <= 0) {
    armed = null;
    emitArmed();
    return;
  }
  let { startIndex, endIndex } = armed;
  if (delta !== 0) {
    if (atIndex < startIndex) {
      startIndex += delta;
      endIndex += delta;
    } else if (atIndex <= endIndex) {
      endIndex += delta;
    }
  }
  startIndex = Math.max(0, startIndex);
  endIndex = Math.min(totalBlocks - 1, endIndex);
  if (endIndex < startIndex) {
    armed = null;
    emitArmed();
    return;
  }
  const expectedBlocks = snapshotBlocks(nextBlocks, startIndex, endIndex) ?? armed.expectedBlocks;
  const unchanged =
    startIndex === armed.startIndex &&
    endIndex === armed.endIndex &&
    expectedBlocks?.length === armed.expectedBlocks?.length &&
    (expectedBlocks?.every((block, idx) => block === armed!.expectedBlocks?.[idx]) ?? true);
  if (unchanged) return;
  armed = {
    scratchKey,
    startIndex,
    endIndex,
    ...(expectedBlocks === undefined ? {} : { expectedBlocks }),
  };
  emitArmed();
}

/**
 * Rebases an armed range across remote document updates by matching its anchored block contents.
 * Releases the range when the armed content moved ambiguously or was changed/deleted remotely.
 */
export function rebaseArmedScratchRange(
  scratchKey: ScratchKey,
  blocks: ReadonlyArray<ScratchMarkdownBlock>,
): void {
  if (armed === null || armed.scratchKey !== scratchKey) return;
  if (blocks.length === 0) {
    armed = null;
    emitArmed();
    return;
  }
  const expected = armed.expectedBlocks;
  if (expected === undefined || expected.length === 0) {
    if (armed.endIndex >= blocks.length) {
      armed = null;
      emitArmed();
    }
    return;
  }
  const matchesAt = (start: number): boolean => {
    if (start < 0 || start + expected.length > blocks.length) return false;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (blocks[start + offset]?.markdown !== expected[offset]) return false;
    }
    return true;
  };
  if (armed.endIndex - armed.startIndex + 1 === expected.length && matchesAt(armed.startIndex)) {
    return;
  }
  const matches: number[] = [];
  for (let candidate = 0; candidate <= blocks.length - expected.length; candidate += 1) {
    if (matchesAt(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) {
    armed = null;
    emitArmed();
    return;
  }
  const nextStart = matches[0]!;
  armed = {
    scratchKey,
    startIndex: nextStart,
    endIndex: nextStart + expected.length - 1,
    expectedBlocks: expected,
  };
  emitArmed();
}

export function useArmedScratchRange(): ArmedScratchRange | null {
  return useSyncExternalStore(
    (listener) => {
      armedListeners.add(listener);
      return () => {
        armedListeners.delete(listener);
      };
    },
    armedScratchRange,
    armedScratchRange,
  );
}

export interface ScratchSpace {
  readonly environmentId: EnvironmentId;
  readonly scratchKey: ScratchKey;
  readonly ownerSettled: boolean;
  readonly ownerConnected: boolean;
  readonly store: ScratchDocumentStore;
  readonly state: ScratchDocumentState;
  readonly blocks: ReadonlyArray<ScratchMarkdownBlock>;
}

const EMPTY_STREAM_ATOM = Atom.make(AsyncResult.initial<ScratchStreamEvent, never>(false));

/** Resolves the machine that owns this project's scratch and keeps its document subscribed. */
export function useScratchSpace(input: {
  readonly project: ScratchProject | null;
  readonly projects: ReadonlyArray<ScratchProject>;
}): ScratchSpace | null {
  const scratchKey = input.project === null ? null : scratchKeyOfProject(input.project);
  const {
    environmentId,
    settled: ownerSettled,
    ownerConnected,
  } = useScratchOwnerEnvironment(input);
  const activeKey =
    environmentId === null || scratchKey === null ? null : spaceKey(environmentId, scratchKey);

  // Subscribe acquires/retains strictly on commit (never during speculative render) and cancels disposal races.
  const subscribeEntry = useCallback(
    (listener: () => void) => {
      if (activeKey === null || environmentId === null || scratchKey === null) {
        return () => {};
      }
      let listeners = entryListeners.get(activeKey);
      if (listeners === undefined) {
        listeners = new Set();
        entryListeners.set(activeKey, listeners);
      }
      listeners.add(listener);
      const entry = retainOrCreateEntry(environmentId, scratchKey);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) entryListeners.delete(activeKey);
        releaseEntry(entry);
      };
    },
    [activeKey, environmentId, scratchKey],
  );
  const getEntrySnapshot = useCallback(
    () => (activeKey === null ? null : (entries.get(activeKey) ?? null)),
    [activeKey],
  );
  const entry = useSyncExternalStore(subscribeEntry, getEntrySnapshot, getEntrySnapshot);

  const streamAtom = useMemo(
    () =>
      entry === null || !ownerSettled || !ownerConnected
        ? EMPTY_STREAM_ATOM
        : scratchDocumentStream({
            environmentId: entry.environmentId,
            input: { scratchKey: entry.scratchKey },
          }),
    [entry, ownerConnected, ownerSettled],
  );
  const stream = useAtomValue(streamAtom);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds server stream events into the local scratch store
  useEffect(() => {
    if (entry === null || !ownerSettled || !ownerConnected || !AsyncResult.isSuccess(stream))
      return;
    entry.store.receive(stream.value);
    if (stream.value.revision > 0) {
      recordEstablishedScratchOwner(entry.scratchKey, entry.environmentId, stream.value.revision);
    }
  }, [entry, ownerConnected, ownerSettled, stream]);

  const [fallback] = useState(EMPTY_STATE);
  const state = useSyncExternalStore(
    entry === null ? noopSubscribe : entry.store.subscribe,
    entry === null ? () => fallback : entry.store.getState,
    entry === null ? () => fallback : entry.store.getState,
  );
  const blocks = useMemo(() => splitScratchMarkdownBlocks(state.markdown), [state.markdown]);

  // Replay any post-enqueue consumptions that previously failed while disconnected.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replays pending idempotent chunk consumptions once the owner reconnects
  useEffect(() => {
    if (entry === null || !state.loaded || !ownerSettled || !ownerConnected) return;
    let active = true;
    void (async () => {
      const pending = await loadPendingMobileScratchConsumptions(
        entry.environmentId,
        entry.scratchKey,
      );
      if (!active || pending.length === 0) return;
      for (const item of pending) {
        if (!active) return;
        await entry.store.flush();
        if (!active) return;
        const live = entry.store.getState();
        const nextMarkdown =
          live.markdown === item.baseMarkdown
            ? item.nextMarkdown
            : mergeScratchMarkdown3Way(item.baseMarkdown, item.nextMarkdown, live.markdown);
        const send = (expectedRevision: number, markdownToCommit: string) =>
          consumeScratchChunk({
            consumptionId: item.consumptionId,
            scratchEnvId: item.scratchEnvId,
            scratchKey: item.scratchKey,
            expectedRevision,
            nextMarkdown: markdownToCommit,
            nextCursorOffset: Math.min(item.nextCursorOffset, markdownToCommit.length),
            consumedAttachmentIds: item.consumedAttachmentIds,
          });
        let expectedRevision = live.revision;
        let markdownToCommit = nextMarkdown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const result = await send(expectedRevision, markdownToCommit);
            removePendingMobileScratchConsumption(item.consumptionId);
            entry.store.applyConsumption(result);
            break;
          } catch (error) {
            const conflict = scratchRevisionConflictOf(error);
            if (conflict === null) break;
            expectedRevision = conflict.revision;
            markdownToCommit = mergeScratchMarkdown3Way(
              item.baseMarkdown,
              item.nextMarkdown,
              conflict.markdown,
            );
          }
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [entry, ownerConnected, ownerSettled, state.loaded]);

  if (entry === null) return null;
  return {
    environmentId: entry.environmentId,
    scratchKey: entry.scratchKey,
    ownerSettled,
    ownerConnected,
    store: entry.store,
    state,
    blocks,
  };
}

function noopSubscribe(): () => void {
  return () => {};
}

const VIEW_STATE_SAVE_DEBOUNCE_MS = 250;

/** Persisted per-device scroll offset per scratch key (cursor offset is global via the server). */
export function useScratchViewState(scratchKey: ScratchKey | null): {
  readonly initial: { readonly cursorOffset: number; readonly scrollY: number } | null;
  readonly remember: (state: { readonly cursorOffset: number; readonly scrollY: number }) => void;
} {
  const [loaded, setLoaded] = useState<{
    readonly key: ScratchKey;
    readonly state: { readonly cursorOffset: number; readonly scrollY: number } | null;
  } | null>(null);
  const pendingWriteRef = useRef<{
    readonly key: ScratchKey;
    readonly state: { readonly cursorOffset: number; readonly scrollY: number };
  } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads persisted per-device view state from disk and flushes pending debounced writes on leave
  useEffect(() => {
    if (scratchKey === null) return;
    let alive = true;
    void scratchViewStateStore()
      .read(scratchKey)
      .then((state) => {
        if (!alive) return;
        setLoaded({ key: scratchKey, state });
      });
    return () => {
      alive = false;
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const pending = pendingWriteRef.current;
      pendingWriteRef.current = null;
      if (pending !== null) {
        void scratchViewStateStore().write(pending.key, pending.state);
      }
    };
  }, [scratchKey]);

  const remember = useCallback(
    (state: { readonly cursorOffset: number; readonly scrollY: number }) => {
      if (scratchKey === null) return;
      pendingWriteRef.current = { key: scratchKey, state };
      if (saveTimerRef.current !== null) return;
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        const pending = pendingWriteRef.current;
        pendingWriteRef.current = null;
        if (pending !== null) {
          void scratchViewStateStore().write(pending.key, pending.state);
        }
      }, VIEW_STATE_SAVE_DEBOUNCE_MS);
    },
    [scratchKey],
  );
  const initial = scratchKey !== null && loaded?.key === scratchKey ? loaded.state : null;
  return { initial, remember };
}
