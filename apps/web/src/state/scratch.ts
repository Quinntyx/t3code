import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  isSharedRepositoryScratchKey,
  resolveScratchOwnerEnvironment,
  type EstablishedScratchOwner,
} from "@t3tools/client-runtime/state/scratch-key";
import {
  WS_METHODS,
  type ChatAttachmentId,
  type EnvironmentId,
  type ScratchKey,
  type ScratchSummary,
} from "@t3tools/contracts";
import { Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { environmentSession } from "~/state/session";

export const scratchDocumentStream = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:scratch:document",
    tag: WS_METHODS.scratchSubscribe,
  },
);

const scratchSummariesStream = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:scratch:summaries",
  tag: WS_METHODS.scratchSubscribeSummaries,
});

export const scratchEnvironment = {
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:scratch:save",
    tag: WS_METHODS.scratchSave,
  }),
  setCursor: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:scratch:set-cursor",
    tag: WS_METHODS.scratchSetCursor,
  }),
  consumeChunk: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:scratch:consume-chunk",
    tag: WS_METHODS.scratchConsumeChunk,
  }),
  createImageUploadUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:scratch:create-image-upload-url",
    tag: WS_METHODS.scratchCreateImageUploadUrl,
  }),
};

const SCRATCH_OWNERS_STORAGE_KEY = "t3code:scratch-owners:v1";
const SCRATCH_VIEW_STORAGE_KEY = "t3code:scratch-view:v1";
const SCRATCH_PENDING_CONSUMPTIONS_STORAGE_KEY = "t3code:scratch-pending-consumptions:v1";

type ScratchStorage = Pick<Storage, "getItem" | "setItem">;

function scratchStorage(): ScratchStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readJsonRecord(storage: ScratchStorage, key: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const establishedOwnersCache = new Map<string, EstablishedScratchOwner>();
let establishedOwnersLoaded = false;

function ensureEstablishedOwnersLoaded(storage: ScratchStorage | null): void {
  if (establishedOwnersLoaded || storage === null) return;
  establishedOwnersLoaded = true;
  const record = readJsonRecord(storage, SCRATCH_OWNERS_STORAGE_KEY);
  for (const [scratchKey, entry] of Object.entries(record)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { environmentId, revision } = entry as Record<string, unknown>;
    if (typeof environmentId === "string" && typeof revision === "number" && revision > 0) {
      establishedOwnersCache.set(scratchKey, {
        environmentId: environmentId as EnvironmentId,
        revision: Math.trunc(revision),
      });
    }
  }
}

function readEstablishedOwner(scratchKey: ScratchKey): EstablishedScratchOwner | null {
  ensureEstablishedOwnersLoaded(scratchStorage());
  return establishedOwnersCache.get(scratchKey) ?? null;
}

export function recordEstablishedScratchOwner(
  scratchKey: ScratchKey,
  environmentId: EnvironmentId,
  revision: number,
): void {
  if (!isSharedRepositoryScratchKey(scratchKey) || revision <= 0) return;
  recordEstablishedOwner(scratchKey, environmentId, revision);
}

function recordEstablishedOwner(
  scratchKey: ScratchKey,
  environmentId: EnvironmentId,
  revision: number,
): void {
  if (revision <= 0) return;
  const storage = scratchStorage();
  ensureEstablishedOwnersLoaded(storage);
  const existing = establishedOwnersCache.get(scratchKey);
  if (
    existing !== undefined &&
    existing.environmentId === environmentId &&
    existing.revision >= revision
  ) {
    return;
  }
  if (existing !== undefined && existing.revision > revision) {
    return;
  }
  const next: EstablishedScratchOwner = { environmentId, revision };
  establishedOwnersCache.set(scratchKey, next);
  if (storage === null) return;
  const record = readJsonRecord(storage, SCRATCH_OWNERS_STORAGE_KEY);
  record[scratchKey] = next;
  try {
    storage.setItem(SCRATCH_OWNERS_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Ignore storage quota failures; in-memory map still guards this session.
  }
}

const EMPTY_OWNER_INPUT: {
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly summariesByEnvironmentId: ReadonlyMap<
    EnvironmentId,
    ReadonlyMap<ScratchKey, ScratchSummary>
  >;
  readonly allConnectedSucceeded: boolean;
} = {
  connectedEnvironmentIds: new Set(),
  summariesByEnvironmentId: new Map(),
  allConnectedSucceeded: true,
};

const scratchOwnerInputByEnvironmentsAtom = Atom.family((serializedIds: string) => {
  const environmentIds = JSON.parse(serializedIds) as ReadonlyArray<EnvironmentId>;
  if (environmentIds.length === 0) return Atom.make(EMPTY_OWNER_INPUT);
  return Atom.make((get) => {
    const connectedEnvironmentIds = new Set<EnvironmentId>();
    const summariesByEnvironmentId = new Map<
      EnvironmentId,
      ReadonlyMap<ScratchKey, ScratchSummary>
    >();
    let allConnectedSucceeded = true;
    for (const environmentId of environmentIds) {
      const connected = Option.isSome(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (connected) {
        connectedEnvironmentIds.add(environmentId);
      }
      const stream = get(scratchSummariesStream({ environmentId, input: undefined }));
      if (!AsyncResult.isSuccess(stream)) {
        if (connected) allConnectedSucceeded = false;
        continue;
      }
      summariesByEnvironmentId.set(
        environmentId,
        new Map(stream.value.summaries.map((summary) => [summary.scratchKey, summary])),
      );
    }
    return { connectedEnvironmentIds, summariesByEnvironmentId, allConnectedSucceeded };
  });
});

/** Elects the canonical environment that owns a logical project's scratch document. */
export function useScratchOwnerEnvironment(input: {
  readonly scratchKey: ScratchKey | null;
  readonly fallbackEnvironmentId: EnvironmentId;
  readonly memberEnvironmentIds: ReadonlyArray<EnvironmentId>;
}): {
  readonly environmentId: EnvironmentId;
  readonly settled: boolean;
  readonly ownerConnected: boolean;
} {
  const uniqueMembers = [...new Set(input.memberEnvironmentIds)].toSorted();
  const isSharedRepoKey =
    input.scratchKey !== null && isSharedRepositoryScratchKey(input.scratchKey);
  const establishedOwner =
    isSharedRepoKey && input.scratchKey !== null ? readEstablishedOwner(input.scratchKey) : null;
  const candidateMembers =
    establishedOwner !== null && !uniqueMembers.includes(establishedOwner.environmentId)
      ? [...uniqueMembers, establishedOwner.environmentId].toSorted()
      : uniqueMembers;
  const multiMachine = isSharedRepoKey && candidateMembers.length > 1;
  const fallbackConnected = Option.isSome(
    useAtomValue(environmentSession.preparedConnectionValueAtom(input.fallbackEnvironmentId)),
  );
  const { connectedEnvironmentIds, summariesByEnvironmentId, allConnectedSucceeded } = useAtomValue(
    scratchOwnerInputByEnvironmentsAtom(JSON.stringify(multiMachine ? candidateMembers : [])),
  );

  const environmentId =
    multiMachine && input.scratchKey !== null
      ? (resolveScratchOwnerEnvironment({
          scratchKey: input.scratchKey,
          memberEnvironmentIds: candidateMembers,
          connectedEnvironmentIds,
          summariesByEnvironmentId,
          establishedOwner,
        }) ?? input.fallbackEnvironmentId)
      : input.fallbackEnvironmentId;

  const electedRevision =
    multiMachine && input.scratchKey !== null && allConnectedSucceeded
      ? (summariesByEnvironmentId.get(environmentId)?.get(input.scratchKey)?.revision ?? 0)
      : 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the elected multi-machine scratch owner outside render
  useEffect(() => {
    if (!multiMachine || input.scratchKey === null || electedRevision <= 0) return;
    recordEstablishedOwner(input.scratchKey, environmentId, electedRevision);
  }, [electedRevision, environmentId, input.scratchKey, multiMachine]);

  if (!multiMachine || input.scratchKey === null) {
    return {
      environmentId: input.fallbackEnvironmentId,
      settled: true,
      ownerConnected: fallbackConnected,
    };
  }

  return {
    environmentId,
    settled: allConnectedSucceeded,
    ownerConnected: connectedEnvironmentIds.has(environmentId),
  };
}

export interface ScratchViewState {
  readonly scrollTop: number;
}

/** Per-device scroll position (cursor position is synced globally via the server). */
export function readScratchViewState(
  scratchKey: string,
  storage: ScratchStorage | null = scratchStorage(),
): ScratchViewState | null {
  if (storage === null) return null;
  const entry = readJsonRecord(storage, SCRATCH_VIEW_STORAGE_KEY)[scratchKey];
  if (typeof entry !== "object" || entry === null) return null;
  const { scrollTop } = entry as Record<string, unknown>;
  if (typeof scrollTop !== "number" || !Number.isFinite(scrollTop)) return null;
  return {
    scrollTop: Math.max(0, Math.trunc(scrollTop)),
  };
}

export function writeScratchViewState(
  scratchKey: string,
  state: ScratchViewState,
  storage: ScratchStorage | null = scratchStorage(),
): void {
  if (storage === null) return;
  const record = readJsonRecord(storage, SCRATCH_VIEW_STORAGE_KEY);
  record[scratchKey] = {
    scrollTop: Math.max(0, Math.trunc(state.scrollTop)),
  };
  try {
    storage.setItem(SCRATCH_VIEW_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Full or blocked storage only loses this device's scroll memory.
  }
}

export interface PendingScratchConsumption {
  readonly consumptionId: string;
  readonly environmentId: EnvironmentId;
  readonly scratchKey: ScratchKey;
  readonly baseMarkdown: string;
  readonly baseRevision: number;
  readonly nextMarkdown: string;
  readonly nextCursorOffset: number;
  readonly attachmentIds: ReadonlyArray<ChatAttachmentId>;
}

const pendingConsumptionsMemory = new Map<string, PendingScratchConsumption>();
let pendingConsumptionsLoaded = false;

function ensurePendingConsumptionsLoaded(storage: ScratchStorage | null): void {
  if (pendingConsumptionsLoaded || storage === null) return;
  pendingConsumptionsLoaded = true;
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(SCRATCH_PENDING_CONSUMPTIONS_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Partial<PendingScratchConsumption>;
      if (
        typeof entry.consumptionId === "string" &&
        typeof entry.environmentId === "string" &&
        typeof entry.scratchKey === "string" &&
        typeof entry.baseMarkdown === "string" &&
        typeof entry.baseRevision === "number" &&
        typeof entry.nextMarkdown === "string" &&
        typeof entry.nextCursorOffset === "number" &&
        Array.isArray(entry.attachmentIds)
      ) {
        pendingConsumptionsMemory.set(entry.consumptionId, entry as PendingScratchConsumption);
      }
    }
  } catch {
    // Ignore malformed pending queue.
  }
}

function persistPendingConsumptions(storage: ScratchStorage | null): void {
  if (storage === null) return;
  try {
    storage.setItem(
      SCRATCH_PENDING_CONSUMPTIONS_STORAGE_KEY,
      JSON.stringify([...pendingConsumptionsMemory.values()]),
    );
  } catch {
    // Ignore storage quota failures.
  }
}

export function enqueuePendingScratchConsumption(entry: PendingScratchConsumption): void {
  const storage = scratchStorage();
  ensurePendingConsumptionsLoaded(storage);
  pendingConsumptionsMemory.set(entry.consumptionId, entry);
  persistPendingConsumptions(storage);
}

export function removePendingScratchConsumption(consumptionId: string): void {
  const storage = scratchStorage();
  ensurePendingConsumptionsLoaded(storage);
  if (!pendingConsumptionsMemory.delete(consumptionId)) return;
  persistPendingConsumptions(storage);
}

export function readPendingScratchConsumptions(
  environmentId: EnvironmentId,
  scratchKey: ScratchKey,
): ReadonlyArray<PendingScratchConsumption> {
  const storage = scratchStorage();
  ensurePendingConsumptionsLoaded(storage);
  return [...pendingConsumptionsMemory.values()].filter(
    (entry) => entry.environmentId === environmentId && entry.scratchKey === scratchKey,
  );
}
