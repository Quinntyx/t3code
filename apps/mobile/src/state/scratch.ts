import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  deriveScratchKey,
  isSharedRepositoryScratchKey,
  resolveScratchOwnerEnvironment,
  type EstablishedScratchOwner,
} from "@t3tools/client-runtime/state/scratch-key";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  ScratchKey,
  WS_METHODS,
  type ChatAttachmentId,
  type EnvironmentId,
  type ScratchAttachment,
  type ScratchConsumeChunkInput,
  type ScratchConsumeChunkResult,
  type ScratchDocumentSnapshot,
  type ScratchSaveInput,
  type ScratchSaveResult,
  type ScratchSetCursorInput,
  type ScratchSetCursorResult,
  type ScratchStreamEvent,
  type ScratchSummary,
} from "@t3tools/contracts";
import {
  extractScratchImageIds,
  mergeScratchMarkdown3Way,
  removeScratchMarkdownRange,
  splitScratchMarkdownBlocks,
  stripScratchImagesForPrompt,
} from "@t3tools/shared/scratchDocument";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { resolveOwnedComposerAttachmentFileUri } from "../lib/composerAttachmentFiles";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { environmentSession } from "./session";

/**
 * Scratch commands run against the machine that owns the document, which is elected per logical
 * project and is therefore not always the machine the next thread will run on.
 */
export const scratchEnvironment = {
  get: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "mobile:scratch:get",
    tag: WS_METHODS.scratchGet,
  }),
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "mobile:scratch:save",
    tag: WS_METHODS.scratchSave,
  }),
  setCursor: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "mobile:scratch:setCursor",
    tag: WS_METHODS.scratchSetCursor,
  }),
  consumeChunk: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "mobile:scratch:consumeChunk",
    tag: WS_METHODS.scratchConsumeChunk,
  }),
  createImageUploadUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "mobile:scratch:createImageUploadUrl",
    tag: WS_METHODS.scratchCreateImageUploadUrl,
  }),
};

export const scratchDocumentStream = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "mobile:scratch:document",
    tag: WS_METHODS.scratchSubscribe,
  },
);

export const scratchSummariesStream = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "mobile:scratch:summaries",
    tag: WS_METHODS.scratchSubscribeSummaries,
  },
);

/** Identifies this device's writes so their stream echo does not rewrite live typing. */
const scratchClientId = `mobile-${Math.random().toString(36).slice(2, 12)}`;

export function scratchDocumentClientId(): string {
  return scratchClientId;
}

export type ScratchProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "isScratch"
>;

export function scratchKeyOfProject(project: ScratchProject): ScratchKey {
  return deriveScratchKey(project);
}

export interface ScratchEnvironmentInput {
  readonly project: ScratchProject;
  readonly projects: ReadonlyArray<ScratchProject>;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly summariesByEnvironmentId: ReadonlyMap<
    EnvironmentId,
    ReadonlyMap<ScratchKey, ScratchSummary>
  >;
  readonly establishedOwner?: EstablishedScratchOwner | null;
}

/** Every machine holding the same logical key may serve it, so the owner is elected, not assumed. */
export function resolveScratchEnvironment(input: ScratchEnvironmentInput): EnvironmentId {
  const scratchKey = scratchKeyOfProject(input.project);
  const memberEnvironmentIds = [
    ...new Set(
      input.projects
        .filter((project) => scratchKeyOfProject(project) === scratchKey)
        .map((project) => project.environmentId),
    ),
  ];
  return (
    resolveScratchOwnerEnvironment({
      scratchKey,
      memberEnvironmentIds:
        memberEnvironmentIds.length > 0 ? memberEnvironmentIds : [input.project.environmentId],
      connectedEnvironmentIds: input.connectedEnvironmentIds,
      summariesByEnvironmentId: input.summariesByEnvironmentId,
      establishedOwner: input.establishedOwner,
    }) ?? input.project.environmentId
  );
}

const establishedOwnersByScratchKey = new Map<string, EstablishedScratchOwner>();
let establishedOwnersHydrated = false;
const EMPTY_CONNECTION_OPTION_ATOM = Atom.make(Option.none<unknown>());

export interface EstablishedScratchOwnersStore {
  load: () => Promise<ReadonlyMap<string, EstablishedScratchOwner>>;
  record: (scratchKey: ScratchKey, owner: EstablishedScratchOwner) => Promise<void>;
}

function parseEstablishedScratchOwners(
  contents: string | null,
): Map<string, EstablishedScratchOwner> {
  const owners = new Map<string, EstablishedScratchOwner>();
  if (contents === null || contents.trim().length === 0) return owners;
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null) return owners;
    for (const [scratchKey, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { environmentId, revision } = entry as Record<string, unknown>;
      if (typeof environmentId === "string" && typeof revision === "number" && revision > 0) {
        owners.set(scratchKey, {
          environmentId: environmentId as EnvironmentId,
          revision: Math.trunc(revision),
        });
      }
    }
  } catch {
    return owners;
  }
  return owners;
}

export function createEstablishedScratchOwnersStore(
  io: ScratchViewStateIo,
): EstablishedScratchOwnersStore {
  let cached: Map<string, EstablishedScratchOwner> | null = null;
  let loading: Promise<Map<string, EstablishedScratchOwner>> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const load = async (): Promise<Map<string, EstablishedScratchOwner>> => {
    if (cached !== null) return cached;
    loading ??= io.read().then((contents) => {
      cached = parseEstablishedScratchOwners(contents);
      loading = null;
      return cached;
    });
    return loading;
  };

  return {
    load,
    record: async (scratchKey, owner) => {
      if (owner.revision <= 0) return;
      const owners = await load();
      const existing = owners.get(scratchKey);
      if (
        existing !== undefined &&
        (existing.revision > owner.revision ||
          (existing.environmentId === owner.environmentId && existing.revision >= owner.revision))
      ) {
        return;
      }
      owners.set(scratchKey, owner);
      const contents = JSON.stringify(Object.fromEntries(owners));
      writing = writing.then(
        () => io.write(contents),
        () => io.write(contents),
      );
      await writing;
    },
  };
}

const SCRATCH_ESTABLISHED_OWNERS_FILE = "scratch/established-owners.json";
let defaultEstablishedOwnersStore: EstablishedScratchOwnersStore | null = null;

export function recordEstablishedScratchOwner(
  scratchKey: ScratchKey,
  environmentId: EnvironmentId,
  revision: number,
): void {
  if (!isSharedRepositoryScratchKey(scratchKey) || revision <= 0) return;
  const existing = establishedOwnersByScratchKey.get(scratchKey);
  if (
    existing !== undefined &&
    (existing.revision > revision ||
      (existing.environmentId === environmentId && existing.revision >= revision))
  ) {
    return;
  }
  const nextOwner: EstablishedScratchOwner = { environmentId, revision };
  establishedOwnersByScratchKey.set(scratchKey, nextOwner);
  void establishedScratchOwnersStore()
    .record(scratchKey, nextOwner)
    .catch(() => {
      // Best-effort persistence; in-memory map still guards this session.
    });
}

function establishedScratchOwnersStore(): EstablishedScratchOwnersStore {
  defaultEstablishedOwnersStore ??= createEstablishedScratchOwnersStore({
    read: async () => {
      const { File, Paths } = await import("expo-file-system");
      const file = new File(Paths.document, SCRATCH_ESTABLISHED_OWNERS_FILE);
      return file.exists ? await file.text() : null;
    },
    write: async (contents) => {
      const { Directory, File, Paths } = await import("expo-file-system");
      const directory = new Directory(Paths.document, "scratch");
      directory.create({ idempotent: true, intermediates: true });
      new File(directory, "established-owners.json").write(contents);
    },
  });
  return defaultEstablishedOwnersStore;
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

/** One atom over every member machine's connection state and summaries, keyed by sorted member ids. */
const scratchOwnerInputAcrossEnvironmentsAtom = Atom.family((key: string) => {
  const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
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
      const result = get(scratchSummariesStream({ environmentId, input: undefined }));
      if (!AsyncResult.isSuccess(result)) {
        if (connected) allConnectedSucceeded = false;
        continue;
      }
      summariesByEnvironmentId.set(
        environmentId,
        new Map(result.value.summaries.map((summary) => [summary.scratchKey, summary])),
      );
    }
    return { connectedEnvironmentIds, summariesByEnvironmentId, allConnectedSucceeded };
  });
});

export function useScratchOwnerEnvironment(input: {
  readonly project: ScratchProject | null;
  readonly projects: ReadonlyArray<ScratchProject>;
}): {
  readonly environmentId: EnvironmentId | null;
  readonly settled: boolean;
  readonly ownerConnected: boolean;
} {
  const scratchKey = input.project === null ? null : scratchKeyOfProject(input.project);
  const memberEnvironmentIds =
    scratchKey === null
      ? []
      : [
          ...new Set(
            input.projects
              .filter((project) => scratchKeyOfProject(project) === scratchKey)
              .map((project) => project.environmentId),
          ),
        ].sort();
  const isSharedRepoKey = scratchKey !== null && isSharedRepositoryScratchKey(scratchKey);
  const [ownersHydrated, setOwnersHydrated] = useState(() => establishedOwnersHydrated);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hydrates persisted multi-machine scratch owners from disk before settling election
  useEffect(() => {
    if (!isSharedRepoKey || ownersHydrated) return;
    let alive = true;
    void establishedScratchOwnersStore()
      .load()
      .then((loaded) => {
        for (const [key, owner] of loaded) {
          const existing = establishedOwnersByScratchKey.get(key);
          if (existing === undefined || owner.revision > existing.revision) {
            establishedOwnersByScratchKey.set(key, owner);
          }
        }
        establishedOwnersHydrated = true;
        if (alive) setOwnersHydrated(true);
      })
      .catch(() => {
        establishedOwnersHydrated = true;
        if (alive) setOwnersHydrated(true);
      });
    return () => {
      alive = false;
    };
  }, [isSharedRepoKey, ownersHydrated]);

  const establishedOwner =
    isSharedRepoKey && scratchKey !== null
      ? (establishedOwnersByScratchKey.get(scratchKey) ?? null)
      : null;
  const candidateMembers =
    establishedOwner !== null && !memberEnvironmentIds.includes(establishedOwner.environmentId)
      ? [...memberEnvironmentIds, establishedOwner.environmentId].sort()
      : memberEnvironmentIds;
  const multiMachine = isSharedRepoKey && candidateMembers.length > 1;
  const singleConnection = useAtomValue(
    input.project === null
      ? EMPTY_CONNECTION_OPTION_ATOM
      : environmentSession.preparedConnectionValueAtom(input.project.environmentId),
  );
  const { connectedEnvironmentIds, summariesByEnvironmentId, allConnectedSucceeded } = useAtomValue(
    scratchOwnerInputAcrossEnvironmentsAtom(JSON.stringify(multiMachine ? candidateMembers : [])),
  );

  const environmentId =
    input.project === null || scratchKey === null
      ? null
      : multiMachine
        ? (resolveScratchOwnerEnvironment({
            scratchKey,
            memberEnvironmentIds: candidateMembers,
            connectedEnvironmentIds,
            summariesByEnvironmentId,
            establishedOwner,
          }) ?? input.project.environmentId)
        : input.project.environmentId;

  const electedRevision =
    multiMachine &&
    ownersHydrated &&
    scratchKey !== null &&
    environmentId !== null &&
    allConnectedSucceeded
      ? (summariesByEnvironmentId.get(environmentId)?.get(scratchKey)?.revision ?? 0)
      : 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records and persists the elected multi-machine scratch owner outside render
  useEffect(() => {
    if (
      !multiMachine ||
      !ownersHydrated ||
      scratchKey === null ||
      environmentId === null ||
      electedRevision <= 0
    ) {
      return;
    }
    const existing = establishedOwnersByScratchKey.get(scratchKey);
    if (existing === undefined || electedRevision >= existing.revision) {
      const nextOwner: EstablishedScratchOwner = {
        environmentId,
        revision: electedRevision,
      };
      establishedOwnersByScratchKey.set(scratchKey, nextOwner);
      void establishedScratchOwnersStore()
        .record(scratchKey, nextOwner)
        .catch(() => {
          // Best-effort persistence; in-memory map still guards this session.
        });
    }
  }, [electedRevision, environmentId, multiMachine, ownersHydrated, scratchKey]);

  if (input.project === null || scratchKey === null || environmentId === null) {
    return { environmentId: null, settled: true, ownerConnected: false };
  }
  if (!multiMachine) {
    return {
      environmentId,
      settled: !isSharedRepoKey || ownersHydrated,
      ownerConnected: Option.isSome(singleConnection),
    };
  }
  return {
    environmentId,
    settled: allConnectedSucceeded && ownersHydrated,
    ownerConnected: connectedEnvironmentIds.has(environmentId),
  };
}

export function useScratchEnvironmentId(input: {
  readonly project: ScratchProject | null;
  readonly projects: ReadonlyArray<ScratchProject>;
}): EnvironmentId | null {
  return useScratchOwnerEnvironment(input).environmentId;
}

/** Per-device caret and scroll, keyed by scratch key so it follows the document between machines. */
export interface ScratchViewState {
  readonly cursorOffset: number;
  readonly scrollY: number;
}

export interface ScratchViewStateIo {
  readonly read: () => Promise<string | null>;
  readonly write: (contents: string) => Promise<void>;
}

export interface ScratchViewStateStore {
  read: (scratchKey: ScratchKey) => Promise<ScratchViewState | null>;
  write: (scratchKey: ScratchKey, state: ScratchViewState) => Promise<void>;
}

function parseScratchViewStates(contents: string | null): Map<string, ScratchViewState> {
  const states = new Map<string, ScratchViewState>();
  if (contents === null || contents.trim().length === 0) return states;
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null) return states;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const { cursorOffset, scrollY } = value as Partial<ScratchViewState>;
      if (typeof cursorOffset !== "number" || typeof scrollY !== "number") continue;
      states.set(key, {
        cursorOffset: Math.max(0, Math.trunc(cursorOffset)),
        scrollY: Math.max(0, scrollY),
      });
    }
  } catch {
    return states;
  }
  return states;
}

export function createScratchViewStateStore(io: ScratchViewStateIo): ScratchViewStateStore {
  let cached: Map<string, ScratchViewState> | null = null;
  let loading: Promise<Map<string, ScratchViewState>> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const load = async (): Promise<Map<string, ScratchViewState>> => {
    if (cached !== null) return cached;
    loading ??= io.read().then((contents) => {
      cached = parseScratchViewStates(contents);
      loading = null;
      return cached;
    });
    return loading;
  };

  return {
    read: async (scratchKey) => (await load()).get(scratchKey) ?? null,
    write: async (scratchKey, state) => {
      const states = await load();
      states.set(scratchKey, state);
      const contents = JSON.stringify(Object.fromEntries(states));
      writing = writing.then(
        () => io.write(contents),
        () => io.write(contents),
      );
      await writing;
    },
  };
}

const SCRATCH_VIEW_STATE_FILE = "scratch/view-state.json";
let defaultViewStateStore: ScratchViewStateStore | null = null;

export function scratchViewStateStore(): ScratchViewStateStore {
  defaultViewStateStore ??= createScratchViewStateStore({
    read: async () => {
      const { File, Paths } = await import("expo-file-system");
      const file = new File(Paths.document, SCRATCH_VIEW_STATE_FILE);
      return file.exists ? await file.text() : null;
    },
    write: async (contents) => {
      const { Directory, File, Paths } = await import("expo-file-system");
      const directory = new Directory(Paths.document, "scratch");
      directory.create({ idempotent: true, intermediates: true });
      new File(directory, "view-state.json").write(contents);
    },
  });
  return defaultViewStateStore;
}

export interface ScratchDocumentState {
  readonly scratchKey: ScratchKey;
  readonly markdown: string;
  readonly attachments: ReadonlyArray<ScratchAttachment>;
  readonly revision: number;
  readonly lastCursorOffset: number;
  readonly loaded: boolean;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly saveFailed: boolean;
  /** A remote edit landed under local text instead of replacing it. */
  readonly mergedRemoteEdit: boolean;
}

export interface ScratchDocumentStore {
  getState: () => ScratchDocumentState;
  subscribe: (listener: () => void) => () => void;
  receive: (event: ScratchStreamEvent) => void;
  edit: (markdown: string, cursorOffset?: number) => void;
  setCursorOffset: (cursorOffset: number, options?: { readonly immediate?: boolean }) => void;
  flush: () => Promise<void>;
  clearMergedRemoteEdit: () => void;
  /** The contiguous block range's payload, computed without mutating the document. */
  takeBlocks: (range: {
    readonly startIndex: number;
    readonly endIndex: number;
    readonly expectedBlocks?: ReadonlyArray<string>;
  }) =>
    | {
        readonly removedMarkdown: string;
        readonly prompt: string;
        readonly consumedAttachmentIds: ReadonlyArray<ChatAttachmentId>;
        readonly nextMarkdown: string;
        readonly nextCursorOffset: number;
      }
    | undefined;
  /** Applies the authoritative server result after a chunk is accepted and consumed. */
  applyConsumption: (result: ScratchConsumeChunkResult) => void;
  dispose: () => void;
}

export interface ScratchDocumentStoreOptions {
  readonly scratchKey: ScratchKey;
  readonly clientId?: string;
  readonly save: (input: ScratchSaveInput) => Promise<ScratchSaveResult>;
  readonly setCursor?: (input: ScratchSetCursorInput) => Promise<ScratchSetCursorResult>;
  readonly debounceMs?: number;
}

const DEFAULT_SAVE_DEBOUNCE_MS = 400;
const CURSOR_SYNC_DEBOUNCE_MS = 250;
const SAVE_ATTEMPT_LIMIT = 3;

export function scratchRevisionConflictOf(error: unknown): ScratchDocumentSnapshot | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { readonly _tag?: string; readonly current?: ScratchDocumentSnapshot };
  if (candidate._tag !== "ScratchRevisionConflictError") return null;
  return candidate.current ?? null;
}

/**
 * Holds one scratch document for its editor: debounced single-flight saves on optimistic
 * revisions, a block merge when a peer wrote first, and self-echo suppression for its own writes.
 */
export function createScratchDocumentStore(
  options: ScratchDocumentStoreOptions,
): ScratchDocumentStore {
  const clientId = options.clientId ?? scratchClientId;
  const debounceMs = options.debounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
  let state: ScratchDocumentState = {
    scratchKey: options.scratchKey,
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
  let baseMarkdown = "";
  let sentCursorOffset = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();

  const publish = (next: Partial<ScratchDocumentState>): void => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const adopt = (next: {
    markdown: string;
    revision: number;
    attachments: ReadonlyArray<ScratchAttachment>;
    lastCursorOffset: number;
  }): void => {
    baseMarkdown = next.markdown;
    sentCursorOffset = next.lastCursorOffset;
    publish({
      markdown: next.markdown,
      revision: next.revision,
      attachments: next.attachments,
      lastCursorOffset: next.lastCursorOffset,
      loaded: true,
      dirty: false,
      saveFailed: false,
    });
  };

  const syncCursorNow = (): void => {
    if (disposed || state.dirty || options.setCursor === undefined) return;
    if (state.revision === 0 && state.markdown.length === 0) return;
    const clamped = Math.max(0, Math.min(state.lastCursorOffset, state.markdown.length));
    if (clamped === sentCursorOffset) return;
    void options
      .setCursor({
        scratchKey: options.scratchKey,
        cursorOffset: clamped,
        clientId,
      })
      .then(() => {
        sentCursorOffset = clamped;
      })
      .catch(() => {
        // Best-effort global cursor sync; next edit or cursor move retries.
      });
  };

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  };

  const saveOnce = async (): Promise<void> => {
    const markdown = state.markdown;
    const cursorToSend = Math.max(0, Math.min(state.lastCursorOffset, markdown.length));
    publish({ saving: true });
    try {
      const saved = await options.save({
        scratchKey: options.scratchKey,
        markdown,
        expectedRevision: state.revision,
        clientId,
        cursorOffset: cursorToSend,
      });
      // Never roll back revision/base if a newer remote stream snapshot arrived while save was in flight.
      if (saved.revision >= state.revision) {
        baseMarkdown = markdown;
        sentCursorOffset = cursorToSend;
        publish({
          revision: saved.revision,
          attachments: saved.attachments,
          saving: false,
          dirty: state.markdown !== markdown,
          saveFailed: false,
        });
        if (
          state.markdown === markdown &&
          Math.max(0, Math.min(state.lastCursorOffset, state.markdown.length)) !== sentCursorOffset
        ) {
          syncCursorNow();
        }
      } else {
        publish({
          saving: false,
          dirty: state.markdown !== baseMarkdown,
          saveFailed: false,
        });
      }
    } catch (error) {
      const conflict = scratchRevisionConflictOf(error);
      if (conflict === null) {
        publish({ saving: false, saveFailed: true });
        throw error;
      }
      const previousBase = baseMarkdown;
      baseMarkdown = conflict.markdown;
      const merged = mergeScratchMarkdown3Way(previousBase, state.markdown, conflict.markdown);
      publish({
        markdown: merged,
        revision: conflict.revision,
        attachments: conflict.attachments,
        saving: false,
        dirty: merged !== conflict.markdown,
        mergedRemoteEdit: true,
      });
    }
  };

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (;;) {
      if (disposed) return;
      if (inFlight !== null) {
        await inFlight;
        if (disposed || !state.dirty || state.saveFailed) return;
      }
      if (!state.dirty || disposed) return;
      let failed = false;
      const run = (async () => {
        try {
          for (let attempt = 0; attempt < SAVE_ATTEMPT_LIMIT && state.dirty; attempt += 1) {
            await saveOnce();
          }
        } catch {
          failed = true;
          // Keep local text so the next edit retries the save.
        } finally {
          inFlight = null;
        }
      })();
      inFlight = run;
      await run;
      if (failed || !state.dirty) return;
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    receive(event) {
      const snapshot = {
        markdown: event.markdown,
        revision: event.revision,
        attachments: event.attachments,
        lastCursorOffset: event.lastCursorOffset,
      };
      if (!state.loaded) {
        if (!state.dirty) {
          adopt(snapshot);
          return;
        }
        baseMarkdown = snapshot.markdown;
        const merged = mergeScratchMarkdown3Way("", state.markdown, snapshot.markdown);
        publish({
          markdown: merged,
          revision: snapshot.revision,
          attachments: snapshot.attachments,
          loaded: true,
          dirty: merged !== snapshot.markdown,
          mergedRemoteEdit: true,
        });
        schedule();
        return;
      }
      if (snapshot.revision < state.revision) return;
      if (event.originClientId === clientId) {
        if (snapshot.revision >= state.revision) {
          baseMarkdown = snapshot.markdown;
          publish({
            revision: snapshot.revision,
            attachments: snapshot.attachments,
            dirty: state.markdown !== snapshot.markdown,
          });
        }
        return;
      }
      // Same revision: remote global cursor update, attachment refresh, or reconnect retry after save failure.
      if (snapshot.revision === state.revision) {
        if (state.dirty && state.saveFailed) {
          schedule();
          return;
        }
        if (
          !state.dirty &&
          snapshot.markdown === baseMarkdown &&
          snapshot.lastCursorOffset !== state.lastCursorOffset
        ) {
          sentCursorOffset = snapshot.lastCursorOffset;
          publish({
            attachments: snapshot.attachments,
            lastCursorOffset: snapshot.lastCursorOffset,
          });
        }
        return;
      }
      if (!state.dirty) {
        adopt(snapshot);
        return;
      }
      const previousBase = baseMarkdown;
      baseMarkdown = snapshot.markdown;
      const merged = mergeScratchMarkdown3Way(previousBase, state.markdown, snapshot.markdown);
      publish({
        markdown: merged,
        revision: snapshot.revision,
        attachments: snapshot.attachments,
        dirty: merged !== snapshot.markdown,
        mergedRemoteEdit: true,
      });
      schedule();
    },
    edit(markdown, cursorOffset) {
      publish({
        markdown,
        dirty: markdown !== baseMarkdown,
        ...(cursorOffset === undefined
          ? {}
          : { lastCursorOffset: Math.max(0, Math.min(cursorOffset, markdown.length)) }),
      });
      schedule();
    },
    setCursorOffset(cursorOffset, cursorOptions) {
      const clamped = Math.max(0, Math.min(Math.trunc(cursorOffset), state.markdown.length));
      if (state.lastCursorOffset !== clamped) {
        publish({ lastCursorOffset: clamped });
      }
      if (state.dirty || options.setCursor === undefined) return;
      if (cursorTimer !== null) {
        clearTimeout(cursorTimer);
        cursorTimer = null;
      }
      if (cursorOptions?.immediate) {
        syncCursorNow();
        return;
      }
      cursorTimer = setTimeout(() => {
        cursorTimer = null;
        syncCursorNow();
      }, CURSOR_SYNC_DEBOUNCE_MS);
    },
    clearMergedRemoteEdit() {
      if (state.mergedRemoteEdit) publish({ mergedRemoteEdit: false });
    },
    flush,
    takeBlocks(range) {
      const blocks = splitScratchMarkdownBlocks(state.markdown);
      let startIndex = range.startIndex;
      let endIndex = range.endIndex;
      if (range.expectedBlocks !== undefined && range.expectedBlocks.length > 0) {
        const expected = range.expectedBlocks;
        const matchesAt = (start: number): boolean => {
          if (start < 0 || start + expected.length > blocks.length) return false;
          for (let offset = 0; offset < expected.length; offset += 1) {
            if (blocks[start + offset]?.markdown !== expected[offset]) return false;
          }
          return true;
        };
        if (endIndex - startIndex + 1 !== expected.length || !matchesAt(startIndex)) {
          const matches: number[] = [];
          for (let candidate = 0; candidate <= blocks.length - expected.length; candidate += 1) {
            if (matchesAt(candidate)) matches.push(candidate);
          }
          if (matches.length !== 1) return undefined;
          startIndex = matches[0]!;
          endIndex = startIndex + expected.length - 1;
        }
      }
      const first = blocks[startIndex];
      const last = blocks[endIndex];
      if (first === undefined || last === undefined) return undefined;
      const removedMarkdown = state.markdown.slice(first.startOffset, last.endOffset);
      const next = removeScratchMarkdownRange({
        markdown: state.markdown,
        startOffset: first.startOffset,
        endOffset: last.endOffset,
      });
      const stripped = stripScratchImagesForPrompt(removedMarkdown);
      return {
        removedMarkdown,
        prompt: stripped.prompt,
        consumedAttachmentIds: extractScratchImageIds(removedMarkdown).map(
          (id) => id as ChatAttachmentId,
        ),
        nextMarkdown: next.nextMarkdown,
        nextCursorOffset: next.nextCursorOffset,
      };
    },
    applyConsumption(result) {
      if (result.revision < state.revision) return;
      const nextMarkdown = result.markdown;
      const nextCursorOffset = Math.min(result.lastCursorOffset, nextMarkdown.length);
      if (state.dirty && state.markdown !== baseMarkdown) {
        const merged = mergeScratchMarkdown3Way(baseMarkdown, state.markdown, nextMarkdown);
        baseMarkdown = nextMarkdown;
        publish({
          markdown: merged,
          revision: result.revision,
          attachments: result.attachments,
          dirty: merged !== nextMarkdown,
          saveFailed: false,
        });
        if (merged !== nextMarkdown) schedule();
        return;
      }
      baseMarkdown = nextMarkdown;
      sentCursorOffset = nextCursorOffset;
      publish({
        markdown: nextMarkdown,
        revision: result.revision,
        attachments: result.attachments,
        lastCursorOffset: nextCursorOffset,
        dirty: false,
        saveFailed: false,
      });
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (cursorTimer !== null) clearTimeout(cursorTimer);
      listeners.clear();
    },
  };
}

export async function uploadScratchImage(input: {
  readonly environmentId: EnvironmentId;
  readonly scratchKey: ScratchKey;
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
}): Promise<ScratchAttachment> {
  const { File, Paths, UploadType } = await import("expo-file-system");
  let temporaryFile: InstanceType<typeof File> | null = null;
  let source: InstanceType<typeof File>;
  if (input.uri.startsWith("data:")) {
    const comma = input.uri.indexOf(",");
    if (comma < 0) throw new Error(`Could not read '${input.name}'.`);
    temporaryFile = new File(Paths.cache, `t3-scratch-upload-${uuidv4()}`);
    await temporaryFile.write(input.uri.slice(comma + 1), { encoding: "base64" });
    source = temporaryFile;
  } else {
    const resolvedUri =
      resolveOwnedComposerAttachmentFileUri(input.uri, Paths.document.uri) ?? input.uri;
    source = new File(resolvedUri);
  }
  try {
    const sizeBytes = source.size ?? 0;
    if (sizeBytes <= 0) throw new Error(`Could not read '${input.name}'.`);
    const mintedResult = await runAtomCommand(
      appAtomRegistry,
      scratchEnvironment.createImageUploadUrl,
      {
        environmentId: input.environmentId,
        input: {
          scratchKey: input.scratchKey,
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes,
          ...(input.width === undefined ? {} : { width: input.width }),
          ...(input.height === undefined ? {} : { height: input.height }),
        },
      },
      { reportFailure: false },
    );
    if (mintedResult._tag === "Failure") {
      throw squashAtomCommandFailure(mintedResult);
    }
    const minted = mintedResult.value;
    const connection = appAtomRegistry.get(
      environmentSession.preparedConnectionValueAtom(input.environmentId),
    );
    if (Option.isNone(connection)) throw new Error("The environment is not connected.");
    const uploadUrl = resolveAssetUrl(connection.value.httpBaseUrl, minted.relativeUrl);
    if (uploadUrl === null) throw new Error("Invalid scratch upload URL.");
    const response = await source.upload(uploadUrl, {
      httpMethod: "POST",
      uploadType: UploadType.BINARY_CONTENT,
      headers: { "Content-Type": input.mimeType },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Upload failed for '${input.name}' (${response.status}).`);
    }
    return {
      attachmentId: minted.attachmentId,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes,
      width: input.width ?? null,
      height: input.height ?? null,
    };
  } finally {
    if (temporaryFile !== null) {
      try {
        if (temporaryFile.exists) temporaryFile.delete();
      } catch {
        // Best-effort cleanup of temp cache upload file.
      }
    }
  }
}

/**
 * Prepares scratch images as draft attachments for the mobile outbox.
 * Same-machine sends keep `uploadedAttachmentId` so the outbox skips re-uploading;
 * cross-machine sends cache the downloaded bytes so the outbox uploads them to the target.
 */
export async function prepareScratchDraftImageAttachments(input: {
  readonly scratchEnvId: EnvironmentId;
  readonly targetEnvId: EnvironmentId;
  readonly attachments: ReadonlyArray<ScratchAttachment>;
}): Promise<ReadonlyArray<DraftComposerImageAttachment>> {
  if (input.attachments.length === 0) return [];
  const sourceConnection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(input.scratchEnvId),
  );
  if (Option.isNone(sourceConnection)) {
    throw new Error("The scratch machine must be connected to attach images.");
  }
  const { Directory, File, Paths } = await import("expo-file-system");
  const { executeAtomQuery } = await import("@t3tools/client-runtime/state/runtime");
  const { assetEnvironment } = await import("./assets");
  const cacheDir = new Directory(Paths.cache, "scratch-attachments");
  cacheDir.create({ idempotent: true, intermediates: true });

  const sameEnv = input.scratchEnvId === input.targetEnvId;
  const prepared: DraftComposerImageAttachment[] = [];
  try {
    for (const attachment of input.attachments) {
      const signedResult = await executeAtomQuery(
        appAtomRegistry,
        assetEnvironment.createUrl({
          environmentId: input.scratchEnvId,
          input: { resource: { _tag: "attachment", attachmentId: attachment.attachmentId } },
        }),
        { reportFailure: false },
      );
      if (signedResult._tag === "Failure") {
        throw squashAtomCommandFailure(signedResult);
      }
      const downloadUrl = resolveAssetUrl(
        sourceConnection.value.httpBaseUrl,
        signedResult.value.relativeUrl,
      );
      if (downloadUrl === null) throw new Error(`Could not resolve '${attachment.name}'.`);
      const localId = uuidv4();
      if (sameEnv) {
        // Same-machine sends already have the attachment on disk; skip caching a duplicate local file.
        prepared.push({
          id: localId,
          type: "image",
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          previewUri: downloadUrl,
          uploadedAttachmentId: attachment.attachmentId,
          uploadEnvironmentId: input.targetEnvId,
        });
        continue;
      }
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error(`Could not download '${attachment.name}'.`);
      const localFile = new File(cacheDir, `${localId}-${attachment.attachmentId}`);
      localFile.create({ overwrite: true });
      localFile.write(new Uint8Array(await response.arrayBuffer()));
      prepared.push({
        id: localId,
        type: "image",
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUri: localFile.uri,
        fileUri: localFile.uri,
      });
    }
    return prepared;
  } catch (error) {
    await cleanupPreparedScratchAttachments(prepared);
    throw error;
  }
}

/** Deletes temporary cache files created by `prepareScratchDraftImageAttachments` if enqueue fails. */
export async function cleanupPreparedScratchAttachments(
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): Promise<void> {
  if (attachments.length === 0) return;
  const { File } = await import("expo-file-system");
  for (const attachment of attachments) {
    if (!attachment.fileUri) continue;
    try {
      const file = new File(attachment.fileUri);
      if (file.exists) file.delete();
    } catch {
      // Best-effort cleanup of temp cache files.
    }
  }
}

export interface PendingMobileScratchConsumption {
  readonly consumptionId: string;
  readonly scratchEnvId: EnvironmentId;
  readonly scratchKey: ScratchKey;
  readonly baseMarkdown: string;
  readonly expectedRevision: number;
  readonly nextMarkdown: string;
  readonly nextCursorOffset: number;
  readonly consumedAttachmentIds: ReadonlyArray<ChatAttachmentId>;
}

export interface PendingMobileScratchConsumptionStore {
  enqueue: (entry: PendingMobileScratchConsumption) => Promise<void>;
  remove: (consumptionId: string) => Promise<void>;
  list: (
    scratchEnvId: EnvironmentId,
    scratchKey: ScratchKey,
  ) => Promise<ReadonlyArray<PendingMobileScratchConsumption>>;
}

function parsePendingMobileConsumptions(
  contents: string | null,
): Map<string, PendingMobileScratchConsumption> {
  const entries = new Map<string, PendingMobileScratchConsumption>();
  if (contents === null || contents.trim().length === 0) return entries;
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!Array.isArray(parsed)) return entries;
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Partial<PendingMobileScratchConsumption>;
      if (
        typeof entry.consumptionId === "string" &&
        typeof entry.scratchEnvId === "string" &&
        typeof entry.scratchKey === "string" &&
        typeof entry.baseMarkdown === "string" &&
        typeof entry.expectedRevision === "number" &&
        typeof entry.nextMarkdown === "string" &&
        typeof entry.nextCursorOffset === "number" &&
        Array.isArray(entry.consumedAttachmentIds)
      ) {
        entries.set(entry.consumptionId, entry as PendingMobileScratchConsumption);
      }
    }
  } catch {
    return entries;
  }
  return entries;
}

export function createPendingMobileScratchConsumptionStore(
  io: ScratchViewStateIo,
): PendingMobileScratchConsumptionStore {
  let cached: Map<string, PendingMobileScratchConsumption> | null = null;
  let loading: Promise<Map<string, PendingMobileScratchConsumption>> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const load = async (): Promise<Map<string, PendingMobileScratchConsumption>> => {
    if (cached !== null) return cached;
    loading ??= io.read().then((contents) => {
      cached = parsePendingMobileConsumptions(contents);
      loading = null;
      return cached;
    });
    return loading;
  };

  const persist = (entries: Map<string, PendingMobileScratchConsumption>): Promise<void> => {
    const contents = JSON.stringify([...entries.values()]);
    writing = writing.then(
      () => io.write(contents),
      () => io.write(contents),
    );
    return writing;
  };

  return {
    enqueue: async (entry) => {
      const entries = await load();
      entries.set(entry.consumptionId, entry);
      await persist(entries);
    },
    remove: async (consumptionId) => {
      const entries = await load();
      if (!entries.delete(consumptionId)) return;
      await persist(entries);
    },
    list: async (scratchEnvId, scratchKey) => {
      const entries = await load();
      return [...entries.values()].filter(
        (entry) => entry.scratchEnvId === scratchEnvId && entry.scratchKey === scratchKey,
      );
    },
  };
}

const SCRATCH_PENDING_CONSUMPTIONS_FILE = "scratch/pending-consumptions.json";
let defaultPendingConsumptionsStore: PendingMobileScratchConsumptionStore | null = null;

function pendingMobileConsumptionsStore(): PendingMobileScratchConsumptionStore {
  defaultPendingConsumptionsStore ??= createPendingMobileScratchConsumptionStore({
    read: async () => {
      const { File, Paths } = await import("expo-file-system");
      const file = new File(Paths.document, SCRATCH_PENDING_CONSUMPTIONS_FILE);
      return file.exists ? await file.text() : null;
    },
    write: async (contents) => {
      const { Directory, File, Paths } = await import("expo-file-system");
      const directory = new Directory(Paths.document, "scratch");
      directory.create({ idempotent: true, intermediates: true });
      new File(directory, "pending-consumptions.json").write(contents);
    },
  });
  return defaultPendingConsumptionsStore;
}

export function enqueuePendingMobileScratchConsumption(
  entry: PendingMobileScratchConsumption,
): void {
  void pendingMobileConsumptionsStore()
    .enqueue(entry)
    .catch(() => {
      // Ignore disk write failures; retry remains in memory for this session.
    });
}

export function removePendingMobileScratchConsumption(consumptionId: string): void {
  void pendingMobileConsumptionsStore()
    .remove(consumptionId)
    .catch(() => {
      // Best-effort cleanup of persisted retry entry.
    });
}

export function loadPendingMobileScratchConsumptions(
  scratchEnvId: EnvironmentId,
  scratchKey: ScratchKey,
): Promise<ReadonlyArray<PendingMobileScratchConsumption>> {
  return pendingMobileConsumptionsStore()
    .list(scratchEnvId, scratchKey)
    .catch(() => []);
}

/** Called only after the target thread (or its outbox entry) accepted the chunk. */
export async function consumeScratchChunk(input: {
  readonly consumptionId?: string;
  readonly scratchEnvId: EnvironmentId;
  readonly scratchKey: ScratchKey;
  readonly expectedRevision: number;
  readonly nextMarkdown: string;
  readonly nextCursorOffset?: number;
  readonly consumedAttachmentIds: ReadonlyArray<ChatAttachmentId>;
}): Promise<ScratchConsumeChunkResult> {
  const payload: ScratchConsumeChunkInput = {
    scratchKey: input.scratchKey,
    expectedRevision: input.expectedRevision,
    clientId: scratchClientId,
    nextMarkdown: input.nextMarkdown,
    ...(input.nextCursorOffset === undefined ? {} : { nextCursorOffset: input.nextCursorOffset }),
    consumedAttachmentIds: [...input.consumedAttachmentIds],
    ...(input.consumptionId === undefined ? {} : { consumptionId: input.consumptionId }),
  };
  const result = await runAtomCommand(
    appAtomRegistry,
    scratchEnvironment.consumeChunk,
    { environmentId: input.scratchEnvId, input: payload },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    throw squashAtomCommandFailure(result);
  }
  return result.value;
}
