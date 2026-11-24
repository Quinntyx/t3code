import { describe, expect, it, vi } from "vite-plus/test";

// The store is pure, but its module loads the live connection layer, which boots Expo at import.
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: { get: () => ({ _tag: "None" }) } }));
vi.mock("./session", () => ({
  environmentSession: { preparedConnectionValueAtom: () => ({}) },
}));
vi.mock("./assets", () => ({ assetEnvironment: { createUrl: {} } }));
vi.mock("./attachments", () => ({ attachmentEnvironment: { createUploadUrl: {} } }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid-test" }));

import {
  ScratchKey,
  type EnvironmentId,
  type ScratchDocumentSnapshot,
  type ScratchSaveInput,
} from "@t3tools/contracts";

import {
  createEstablishedScratchOwnersStore,
  createPendingMobileScratchConsumptionStore,
  createScratchDocumentStore,
  createScratchViewStateStore,
  resolveScratchEnvironment,
  type ScratchProject,
} from "./scratch";
import {
  adjustArmedScratchRange,
  armScratchRange,
  armedScratchRange,
  extendScratchRange,
  rebaseArmedScratchRange,
  releaseScratchRange,
} from "./scratch-space";
import { splitScratchMarkdownBlocks } from "@t3tools/shared/scratchDocument";

const PROJECT_ID = "project-1" as ScratchProject["id"];

function project(environmentId: string, workspaceRoot = "/repos/t3"): ScratchProject {
  return {
    environmentId: environmentId as EnvironmentId,
    id: PROJECT_ID,
    workspaceRoot,
    repositoryIdentity: {
      canonicalKey: "github.com/t3tools/t3code",
      rootPath: "/repos/t3",
    } as never,
  };
}

function snapshot(markdown: string, revision: number): ScratchDocumentSnapshot {
  return {
    scratchKey: ScratchKey.make("path:env-a:/repos/t3"),
    markdown,
    revision,
    lastCursorOffset: markdown.length,
    updatedAt: "2026-11-23T00:00:00.000Z",
    attachments: [],
  };
}

describe("resolveScratchEnvironment", () => {
  it("resolves one owner for a repository-shared key on every member machine", () => {
    const projects = [project("env-a"), project("env-b")];
    const resolved = projects.map((member) =>
      resolveScratchEnvironment({
        project: member,
        projects,
        connectedEnvironmentIds: new Set(["env-a", "env-b"] as EnvironmentId[]),
        summariesByEnvironmentId: new Map(),
      }),
    );
    expect(resolved).toEqual(["env-a", "env-a"]);
  });
});

describe("scratch view state", () => {
  it("remembers the caret and scroll per key across restarts", async () => {
    let contents: string | null = null;
    const io = {
      read: async () => contents,
      write: async (next: string) => {
        contents = next;
      },
    };
    const keyA = ScratchKey.make("path:env-a:/repos/t3");
    const keyB = ScratchKey.make("path:env-a:/repos/t3/sub");
    await createScratchViewStateStore(io).write(keyA, { cursorOffset: 12, scrollY: 240 });
    const reopened = createScratchViewStateStore(io);
    expect(await reopened.read(keyA)).toEqual({ cursorOffset: 12, scrollY: 240 });
    expect(await reopened.read(keyB)).toBeNull();
    await reopened.write(keyB, { cursorOffset: 3, scrollY: 0 });
    expect(await reopened.read(keyA)).toEqual({ cursorOffset: 12, scrollY: 240 });
    expect(await reopened.read(keyB)).toEqual({ cursorOffset: 3, scrollY: 0 });
  });
});

describe("scratch document store", () => {
  it("merges a peer conflict on save instead of dropping local typing", async () => {
    let saved: ScratchSaveInput | null = null;
    let attempts = 0;
    let releaseSave!: () => void;
    const store = createScratchDocumentStore({
      scratchKey: ScratchKey.make("path:env-a:/repos/t3"),
      clientId: "test-client",
      debounceMs: 1,
      save: async (input) => {
        attempts += 1;
        saved = input;
        if (attempts === 1) {
          await new Promise<void>((resolve) => {
            releaseSave = resolve;
          });
          throw Object.assign(new Error("conflict"), {
            _tag: "ScratchRevisionConflictError",
            current: snapshot("first line\n\nremote second line", 2),
          });
        }
        return {
          scratchKey: input.scratchKey,
          revision: 3,
          updatedAt: "2026-11-23T00:00:01.000Z",
          attachments: [],
        };
      },
    });
    store.receive({
      ...snapshot("first line", 1),
      originClientId: null,
    });
    store.edit("first line\n\nlocal second", 10);
    const flushPromise = store.flush();
    // Simulate typing that arrived while the conflicting save RPC was in flight.
    store.edit("first line\n\nlocal second line with more", 26);
    releaseSave();
    await flushPromise;

    expect(store.getState().markdown).toContain("local second line with more");
    expect(store.getState().markdown).toContain("remote second line");
    expect(store.getState().mergedRemoteEdit).toBe(true);
    expect(saved).not.toBeNull();
    store.dispose();
  });

  it("merges a concurrent stream update against the prior base revision", () => {
    const store = createScratchDocumentStore({
      scratchKey: ScratchKey.make("path:env-a:/repos/t3"),
      clientId: "test-client",
      debounceMs: 500,
      save: async () => {
        throw new Error("should not flush synchronously");
      },
    });
    store.receive({
      ...snapshot("shared top\n\nmiddle\n\nshared bottom", 1),
      originClientId: null,
    });
    store.edit("local top\n\nmiddle\n\nshared bottom", 9);
    store.receive({
      ...snapshot("shared top\n\nmiddle\n\nremote bottom", 2),
      originClientId: "other-client",
    });

    expect(store.getState().markdown).toBe("local top\n\nmiddle\n\nremote bottom");
    expect(store.getState().mergedRemoteEdit).toBe(true);
    store.dispose();
  });

  it("strips internal scratch image tokens from takeBlocks prompt output", () => {
    const store = createScratchDocumentStore({
      scratchKey: ScratchKey.make("path:env-a:/repos/t3"),
      clientId: "test-client",
      save: async () => {
        throw new Error("unused");
      },
    });
    store.receive({
      ...snapshot("Fix layout\n\n![shot](t3-scratch-image://scratch-123)\n\nNext item", 1),
      originClientId: null,
    });
    const taken = store.takeBlocks({ startIndex: 0, endIndex: 1 });
    expect(taken?.prompt).toBe("Fix layout");
    expect(taken?.consumedAttachmentIds).toEqual(["scratch-123"]);
    expect(taken?.nextMarkdown).toBe("Next item");
    store.dispose();
  });

  it("ignores stale out-of-order self-echoes without rolling revision backward", () => {
    const store = createScratchDocumentStore({
      scratchKey: ScratchKey.make("path:env-a:/repos/t3"),
      clientId: "test-client",
      debounceMs: 500,
      save: async () => {
        throw new Error("unused");
      },
    });
    store.receive({ ...snapshot("rev 3 text", 3), originClientId: "test-client" });
    store.receive({ ...snapshot("rev 2 stale", 2), originClientId: "test-client" });
    expect(store.getState().revision).toBe(3);
    expect(store.getState().markdown).toBe("rev 3 text");
    store.dispose();
  });

  it("re-flushes edits that arrive while an earlier save is in flight", async () => {
    const savedTexts: string[] = [];
    let releaseFirst!: () => void;
    const store = createScratchDocumentStore({
      scratchKey: ScratchKey.make("path:env-a:/repos/t3"),
      clientId: "test-client",
      debounceMs: 500,
      save: async (input) => {
        savedTexts.push(input.markdown);
        if (savedTexts.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return {
          scratchKey: input.scratchKey,
          revision: input.expectedRevision + 1,
          updatedAt: "2026-11-23T00:00:01.000Z",
          attachments: [],
        };
      },
    });
    store.receive({ ...snapshot("base", 1), originClientId: null });
    store.edit("first edit", 10);
    const firstFlush = store.flush();
    store.edit("second edit during flight", 25);
    const secondFlush = store.flush();
    releaseFirst();
    await Promise.all([firstFlush, secondFlush]);
    expect(savedTexts).toEqual(["first edit", "second edit during flight"]);
    expect(store.getState().dirty).toBe(false);
    store.dispose();
  });

  it("keeps armed block ranges aligned when blocks split, clear, remove, or shift", () => {
    const key = ScratchKey.make("path:env-a:/repos/t3");
    releaseScratchRange();

    // Splitting an armed block expands endIndex so both halves stay armed.
    armScratchRange(key, 1);
    adjustArmedScratchRange(key, 1, 1, 4);
    expect(armedScratchRange()).toEqual({ scratchKey: key, startIndex: 1, endIndex: 2 });

    // Clearing one block inside a multi-block range shrinks endIndex without pulling in unarmed blocks.
    adjustArmedScratchRange(key, 1, -1, 3);
    expect(armedScratchRange()).toEqual({ scratchKey: key, startIndex: 1, endIndex: 1 });

    // Removing the sole armed block releases the armed range cleanly.
    adjustArmedScratchRange(key, 1, -1, 2);
    expect(armedScratchRange()).toBeNull();

    // Inserting a block before an armed range shifts both endpoints forward.
    armScratchRange(key, 1);
    extendScratchRange(key, 2);
    adjustArmedScratchRange(key, 0, 1, 4);
    expect(armedScratchRange()).toEqual({ scratchKey: key, startIndex: 2, endIndex: 3 });

    // Remote prepend rebases an anchored armed range onto the moved block instead of shifting onto unrelated prose.
    const initialBlocks = splitScratchMarkdownBlocks("Alpha\n\nBeta");
    armScratchRange(key, 1, initialBlocks);
    const prependedBlocks = splitScratchMarkdownBlocks("Peer\n\nAlpha\n\nBeta");
    rebaseArmedScratchRange(key, prependedBlocks);
    expect(armedScratchRange()).toEqual({
      scratchKey: key,
      startIndex: 2,
      endIndex: 2,
      expectedBlocks: ["Beta"],
    });

    // Modifying the armed block remotely releases the range instead of sending altered text.
    rebaseArmedScratchRange(key, splitScratchMarkdownBlocks("Peer\n\nAlpha\n\nBeta changed"));
    expect(armedScratchRange()).toBeNull();

    releaseScratchRange();
  });

  it("does not roll back revision when a newer remote stream snapshot arrives while save is in flight and syncs global cursor", async () => {
    const cursorUpdates: number[] = [];
    let releaseSave!: () => void;
    const store = createScratchDocumentStore({
      scratchKey: ScratchKey.make("path:env-a:/repos/t3"),
      clientId: "mobile-1",
      debounceMs: 500,
      save: async (input) => {
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        return {
          scratchKey: input.scratchKey,
          revision: input.expectedRevision + 1,
          updatedAt: "2026-11-23T00:00:01.000Z",
          attachments: [],
        };
      },
      setCursor: async (input) => {
        cursorUpdates.push(input.cursorOffset);
        return { scratchKey: input.scratchKey, lastCursorOffset: input.cursorOffset };
      },
    });
    store.receive({ ...snapshot("Alpha\n\nBeta", 1), originClientId: null });
    store.edit("Alpha edited\n\nBeta", 12);
    const savePromise = store.flush();

    // Remote rev 3 lands while our rev 2 save RPC is still in flight.
    store.receive({
      ...snapshot("Alpha edited\n\nBeta\n\nRemote", 3),
      lastCursorOffset: 20,
      originClientId: "desktop-1",
    });
    releaseSave();
    await savePromise;
    expect(store.getState().revision).toBe(3);

    // Remote global cursor move at the same revision updates local cursorOffset immediately.
    store.receive({
      ...snapshot("Alpha edited\n\nBeta\n\nRemote", 3),
      lastCursorOffset: 6,
      originClientId: "desktop-1",
    });
    expect(store.getState().lastCursorOffset).toBe(6);

    // Immediate local cursor update pushes to setCursor when clean.
    store.setCursorOffset(10, { immediate: true });
    expect(cursorUpdates).toEqual([10]);

    // While dirty, a same-revision remote cursor move must not yank the active local caret.
    store.edit("Alpha edited locally\n\nBeta\n\nRemote", 20);
    store.receive({
      ...snapshot("Alpha edited\n\nBeta\n\nRemote", 3),
      lastCursorOffset: 2,
      originClientId: "desktop-1",
    });
    expect(store.getState().lastCursorOffset).toBe(20);

    // Reset back to clean and verify applyConsumption adopts authoritative server markdown and cursor offset.
    store.edit("Alpha edited\n\nBeta\n\nRemote", 6);
    store.applyConsumption({
      scratchKey: ScratchKey.make("path:env-a:/repos/t3"),
      markdown: "Remaining\n\nPeer addition",
      revision: 4,
      lastCursorOffset: 24,
      updatedAt: "2026-11-23T00:00:02.000Z",
      attachments: [],
    });
    expect(store.getState().markdown).toBe("Remaining\n\nPeer addition");
    expect(store.getState().revision).toBe(4);
    expect(store.getState().lastCursorOffset).toBe(24);
    expect(store.getState().dirty).toBe(false);
    store.dispose();
  });

  it("persists pending mobile consumptions across restarts until removed", async () => {
    let contents: string | null = null;
    const io = {
      read: async () => contents,
      write: async (next: string) => {
        contents = next;
      },
    };
    const key = ScratchKey.make("path:env-a:/repos/t3");
    const envId = "env-a" as EnvironmentId;
    const store = createPendingMobileScratchConsumptionStore(io);
    await store.enqueue({
      consumptionId: "msg-1",
      scratchEnvId: envId,
      scratchKey: key,
      baseMarkdown: "A\n\nB",
      expectedRevision: 1,
      nextMarkdown: "A",
      nextCursorOffset: 1,
      consumedAttachmentIds: [],
    });

    const reopened = createPendingMobileScratchConsumptionStore(io);
    expect(await reopened.list(envId, key)).toHaveLength(1);
    await reopened.remove("msg-1");
    expect(await createPendingMobileScratchConsumptionStore(io).list(envId, key)).toEqual([]);
  });

  it("persists established scratch owners across restarts and merges concurrent edits during applyConsumption", async () => {
    let contents: string | null = null;
    const io = {
      read: async () => contents,
      write: async (next: string) => {
        contents = next;
      },
    };
    const repoKey = ScratchKey.make("repo:github.com/t3tools/t3code");
    const ownersStore = createEstablishedScratchOwnersStore(io);
    await ownersStore.record(repoKey, { environmentId: "env-a" as EnvironmentId, revision: 4 });
    // Older revision must not overwrite established owner.
    await ownersStore.record(repoKey, { environmentId: "env-b" as EnvironmentId, revision: 2 });
    const reopenedOwners = await createEstablishedScratchOwnersStore(io).load();
    expect(reopenedOwners.get(repoKey)).toEqual({ environmentId: "env-a", revision: 4 });

    // Moving cursor during an in-flight save pushes the new cursor once save settles,
    // and applyConsumption merges unsaved concurrent typing instead of wiping it.
    const cursorUpdates: number[] = [];
    let releaseSave!: () => void;
    const store = createScratchDocumentStore({
      scratchKey: repoKey,
      clientId: "mobile-2",
      debounceMs: 500,
      save: async (input) => {
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        return {
          scratchKey: input.scratchKey,
          revision: input.expectedRevision + 1,
          updatedAt: "2026-11-23T00:00:05.000Z",
          attachments: [],
        };
      },
      setCursor: async (input) => {
        cursorUpdates.push(input.cursorOffset);
        return { scratchKey: input.scratchKey, lastCursorOffset: input.cursorOffset };
      },
    });
    store.receive({ ...snapshot("Keep\n\nChunk", 1), originClientId: null });
    store.edit("Keep!\n\nChunk", 5);
    const saving = store.flush();
    // Move cursor while save is in flight.
    store.setCursorOffset(11);
    releaseSave();
    await saving;
    expect(cursorUpdates).toEqual([11]);

    // Type a concurrent edit before a background replay applies a consumption.
    store.edit("Keep!\n\nChunk\n\nFresh local note", 30);
    store.applyConsumption({
      scratchKey: repoKey,
      markdown: "Keep!",
      revision: 3,
      lastCursorOffset: 5,
      updatedAt: "2026-11-23T00:00:06.000Z",
      attachments: [],
    });
    expect(store.getState().markdown).toContain("Keep!");
    expect(store.getState().markdown).toContain("Fresh local note");
    expect(store.getState().markdown).not.toContain("Chunk");
    expect(store.getState().dirty).toBe(true);
    store.dispose();
  });

  it("retries failed setCursor calls and auto-retries failed saves on reconnect snapshot", async () => {
    const repoKey = ScratchKey.make("repo:github.com/t3tools/t3code");
    let cursorAttempts = 0;
    let saveAttempts = 0;
    const store = createScratchDocumentStore({
      scratchKey: repoKey,
      clientId: "mobile-retry",
      debounceMs: 1,
      save: async (input) => {
        saveAttempts += 1;
        if (saveAttempts === 1) throw new Error("offline");
        return {
          scratchKey: input.scratchKey,
          revision: input.expectedRevision + 1,
          updatedAt: "2026-11-23T00:00:08.000Z",
          attachments: [],
        };
      },
      setCursor: async (input) => {
        cursorAttempts += 1;
        if (cursorAttempts === 1) throw new Error("offline");
        return { scratchKey: input.scratchKey, lastCursorOffset: input.cursorOffset };
      },
    });
    store.receive({ ...snapshot("Hello world", 1), originClientId: null });
    store.setCursorOffset(5, { immediate: true });
    await Promise.resolve();
    store.setCursorOffset(5, { immediate: true });
    expect(cursorAttempts).toBe(2);

    store.edit("Hello world edited", 18);
    await store.flush();
    expect(store.getState().saveFailed).toBe(true);
    expect(saveAttempts).toBe(1);

    // Same-revision reconnect snapshot schedules a retry for the failed dirty save.
    store.receive({ ...snapshot("Hello world", 1), originClientId: null });
    await vi.waitFor(() => {
      expect(saveAttempts).toBe(2);
      expect(store.getState().saveFailed).toBe(false);
    });
    store.dispose();
  });
});
