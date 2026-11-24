import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";

import type {
  EnvironmentId,
  ScratchConsumeChunkInput,
  ScratchConsumeChunkResult,
  ScratchDocumentSnapshot,
  ScratchKey,
  ScratchSaveInput,
  ScratchSaveResult,
  ScratchSetCursorInput,
  ScratchSetCursorResult,
  ScratchStreamEvent,
} from "@t3tools/contracts";
import { fakeTimers, render } from "../../../test/render";

const mockState = vi.hoisted(() => ({
  snapshot: null as ScratchStreamEvent | null,
  saveImpl:
    vi.fn<
      (input: {
        readonly environmentId: EnvironmentId;
        readonly input: ScratchSaveInput;
      }) => Promise<AsyncResult.AsyncResult<ScratchSaveResult, unknown>>
    >(),
  consumeImpl:
    vi.fn<
      (input: {
        readonly environmentId: EnvironmentId;
        readonly input: ScratchConsumeChunkInput;
      }) => Promise<AsyncResult.AsyncResult<ScratchConsumeChunkResult, unknown>>
    >(),
  setCursorImpl:
    vi.fn<
      (input: {
        readonly environmentId: EnvironmentId;
        readonly input: ScratchSetCursorInput;
      }) => Promise<AsyncResult.AsyncResult<ScratchSetCursorResult, unknown>>
    >(),
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mockState.snapshot,
    isPending: mockState.snapshot === null,
    error: null,
    refresh: () => {},
  }),
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>();
  return {
    ...actual,
    runAtomCommand: (_registry: unknown, command: { _kind?: string }, payload: unknown) => {
      if (command._kind === "consume") {
        return mockState.consumeImpl(
          payload as {
            readonly environmentId: EnvironmentId;
            readonly input: ScratchConsumeChunkInput;
          },
        );
      }
      if (command._kind === "setCursor") {
        return mockState.setCursorImpl(
          payload as {
            readonly environmentId: EnvironmentId;
            readonly input: ScratchSetCursorInput;
          },
        );
      }
      return mockState.saveImpl(
        payload as { readonly environmentId: EnvironmentId; readonly input: ScratchSaveInput },
      );
    },
  };
});

import { useScratchDocument, type ScratchDocumentHandle } from "./useScratchDocument";

const ENV_ID = "env-test" as EnvironmentId;
const SCRATCH_KEY = "path:env-test:/repo" as ScratchKey;
const OTHER_SCRATCH_KEY = "path:env-test:/other-repo" as ScratchKey;
const TRANSPORT = {
  save: { _kind: "save" },
  setCursor: { _kind: "setCursor" },
  consumeChunk: { _kind: "consume" },
} as unknown as NonNullable<Parameters<typeof useScratchDocument>[0]["transport"]>;

function makeSnapshot(
  markdown: string,
  revision: number,
  originClientId: string | null = null,
  options?: { readonly scratchKey?: ScratchKey; readonly lastCursorOffset?: number },
): ScratchStreamEvent {
  return {
    scratchKey: options?.scratchKey ?? SCRATCH_KEY,
    markdown,
    revision,
    lastCursorOffset: options?.lastCursorOffset ?? 0,
    updatedAt: "2026-11-23T00:00:00.000Z",
    attachments: [],
    originClientId,
  };
}

function setup() {
  window.localStorage.clear();
  mockState.snapshot = null;
  mockState.saveImpl.mockReset();
  mockState.consumeImpl.mockReset();
  mockState.setCursorImpl.mockReset();
  mockState.setCursorImpl.mockImplementation(async ({ input }) =>
    AsyncResult.success({
      scratchKey: input.scratchKey,
      lastCursorOffset: input.cursorOffset,
    }),
  );
}

function Probe({
  onHandle,
  scratchKey = SCRATCH_KEY,
  enabled = true,
}: {
  readonly onHandle: (handle: ScratchDocumentHandle) => void;
  readonly scratchKey?: ScratchKey;
  readonly enabled?: boolean;
}) {
  const handle = useScratchDocument({
    environmentId: ENV_ID,
    scratchKey,
    enabled,
    transport: TRANSPORT,
  });
  useEffect(() => {
    onHandle(handle);
  }, [handle, onHandle]);
  return (
    <div>
      <pre data-testid="markdown">{JSON.stringify(handle.markdown)}</pre>
      <span data-testid="cursor">{handle.lastCursorOffset}</span>
      <span data-testid="remote-cursor-seq">{handle.remoteCursorSeq}</span>
    </div>
  );
}

describe("useScratchDocument", () => {
  it("retries OCC save conflicts with a 3-way merge and suppresses self-echoes", async () => {
    setup();
    mockState.snapshot = makeSnapshot("Head\n\nTail", 1);
    const savedCalls: ScratchSaveInput[] = [];
    mockState.saveImpl.mockImplementation(async ({ input }) => {
      savedCalls.push(input);
      if (savedCalls.length === 1) {
        const current: ScratchDocumentSnapshot = {
          scratchKey: SCRATCH_KEY,
          markdown: "Head\n\nTail\n\nRemote",
          revision: 2,
          lastCursorOffset: 0,
          updatedAt: "2026-11-23T00:00:01.000Z",
          attachments: [],
        };
        return AsyncResult.fail({
          _tag: "ScratchRevisionConflictError",
          current,
        });
      }
      return AsyncResult.success({
        scratchKey: SCRATCH_KEY,
        revision: 3,
        updatedAt: "2026-11-23T00:00:02.000Z",
        attachments: [],
      });
    });

    let latest!: ScratchDocumentHandle;
    function Wrapper() {
      const [, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            Rerender
          </button>
          <Probe onHandle={(h) => (latest = h)} />
        </div>
      );
    }

    // useScratchDocument does not depend on TanStack Router context.
    await using screen = await render(<Wrapper />, { router: false });
    await vi.waitFor(() => {
      expect(screen.getByTestId("markdown").element().textContent).toBe(
        JSON.stringify("Head\n\nTail"),
      );
    });

    latest.setMarkdown("Local head\n\nTail");
    await latest.flush();

    expect(savedCalls).toHaveLength(2);
    expect(savedCalls[0]?.expectedRevision).toBe(1);
    expect(savedCalls[1]?.expectedRevision).toBe(2);
    expect(savedCalls[1]?.markdown).toBe("Local head\n\nTail\n\nRemote");
    await vi.waitFor(() => {
      expect(screen.getByTestId("markdown").element().textContent).toBe(
        JSON.stringify("Local head\n\nTail\n\nRemote"),
      );
    });

    // A self-echo arriving while the user has typed newer text must not clobber live input.
    const clientId = savedCalls[0]!.clientId;
    latest.setMarkdown("Local head\n\nTail\n\nRemote\n\nTyping");
    mockState.snapshot = makeSnapshot("Local head\n\nTail\n\nRemote", 3, clientId);
    screen
      .getByText("Rerender")
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(screen.getByTestId("markdown").element().textContent).toBe(
        JSON.stringify("Local head\n\nTail\n\nRemote\n\nTyping"),
      );
    });
  });

  it("retries OCC conflicts during unmount flush and completes post-unmount consumeRange", async () => {
    setup();
    mockState.snapshot = makeSnapshot("Keep\n\nSend me", 1);
    const saveCalls: ScratchSaveInput[] = [];
    mockState.saveImpl.mockImplementation(async ({ input }) => {
      saveCalls.push(input);
      if (saveCalls.length === 1) {
        const current: ScratchDocumentSnapshot = {
          scratchKey: SCRATCH_KEY,
          markdown: "Keep\n\nSend me\n\nPeer",
          revision: 2,
          lastCursorOffset: 0,
          updatedAt: "2026-11-23T00:00:01.000Z",
          attachments: [],
        };
        return AsyncResult.fail({
          _tag: "ScratchRevisionConflictError",
          current,
        });
      }
      return AsyncResult.success({
        scratchKey: SCRATCH_KEY,
        revision: 3,
        updatedAt: "2026-11-23T00:00:02.000Z",
        attachments: [],
      });
    });

    const consumeCalls: ScratchConsumeChunkInput[] = [];
    mockState.consumeImpl.mockImplementation(async ({ input }) => {
      consumeCalls.push(input);
      return AsyncResult.success({
        scratchKey: input.scratchKey,
        markdown: input.nextMarkdown,
        revision: input.expectedRevision + 1,
        lastCursorOffset: input.nextCursorOffset ?? 0,
        updatedAt: "2026-11-23T00:00:03.000Z",
        attachments: [],
      });
    });

    let latest!: ScratchDocumentHandle;
    // useScratchDocument does not depend on TanStack Router context.
    await using screen = await render(<Probe onHandle={(h) => (latest = h)} />, {
      router: false,
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("markdown").element().textContent).toBe(
        JSON.stringify("Keep\n\nSend me"),
      );
    });

    latest.setMarkdown("Keep edited\n\nSend me");
    await screen.unmount();

    await vi.waitFor(() => {
      expect(saveCalls).toHaveLength(2);
    });
    expect(saveCalls[1]?.markdown).toBe("Keep edited\n\nSend me\n\nPeer");

    // Post-unmount consumeRange (e.g. background draft rotation) still commits on the server
    // using the revision and merged text established by the queued unmount flush.
    const consumed = await latest.consumeRange({
      baseMarkdown: "Keep edited\n\nSend me\n\nPeer",
      baseRevision: 3,
      nextMarkdown: "Keep edited\n\nPeer",
      nextCursorOffset: 11,
      attachmentIds: [],
    });
    expect(consumed).toEqual({
      ok: true,
      appliedMarkdown: "Keep edited\n\nPeer",
      nextCursorOffset: 11,
    });
    expect(consumeCalls).toHaveLength(1);
    expect(consumeCalls[0]?.expectedRevision).toBe(3);
  });

  it("does not duplicate text when unmounting while an earlier save is in flight and syncs remote global cursor", async () => {
    setup();
    mockState.snapshot = makeSnapshot("", 0);
    let releaseFirstSave!: () => void;
    const saveCalls: ScratchSaveInput[] = [];
    mockState.saveImpl.mockImplementation(async ({ input }) => {
      saveCalls.push(input);
      if (saveCalls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        });
      }
      return AsyncResult.success({
        scratchKey: SCRATCH_KEY,
        revision: input.expectedRevision + 1,
        updatedAt: "2026-11-23T00:00:01.000Z",
        attachments: [],
      });
    });

    let latest!: ScratchDocumentHandle;
    function Wrapper() {
      const [, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            Rerender
          </button>
          <Probe onHandle={(h) => (latest = h)} />
        </div>
      );
    }

    // useScratchDocument does not depend on TanStack Router context.
    await using screen = await render(<Wrapper />, { router: false });
    latest.setMarkdown("First");
    const firstFlush = latest.flush();
    await vi.waitFor(() => {
      expect(saveCalls).toHaveLength(1);
    });

    // User types more and leaves while the first save is genuinely in flight.
    latest.setMarkdown("First and second");
    await screen.unmount();
    releaseFirstSave();
    await firstFlush;

    await vi.waitFor(() => {
      expect(saveCalls).toHaveLength(2);
    });
    expect(saveCalls[0]).toMatchObject({ markdown: "First", expectedRevision: 0 });
    expect(saveCalls[1]).toMatchObject({ markdown: "First and second", expectedRevision: 1 });
  });

  it("consumes against the captured project target after switching projects and never touches the new project", async () => {
    setup();
    mockState.snapshot = makeSnapshot("Project A keep\n\nProject A send", 2, null, {
      scratchKey: SCRATCH_KEY,
    });
    const consumeCalls: ScratchConsumeChunkInput[] = [];
    mockState.consumeImpl.mockImplementation(async ({ input }) => {
      consumeCalls.push(input);
      return AsyncResult.success({
        scratchKey: input.scratchKey,
        markdown: input.nextMarkdown,
        revision: input.expectedRevision + 1,
        lastCursorOffset: input.nextCursorOffset ?? 0,
        updatedAt: "2026-11-23T00:00:04.000Z",
        attachments: [],
      });
    });

    let latest!: ScratchDocumentHandle;
    function Switchable() {
      const [activeKey, setActiveKey] = useState<ScratchKey>(SCRATCH_KEY);
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              mockState.snapshot = makeSnapshot("Project B untouched", 5, null, {
                scratchKey: OTHER_SCRATCH_KEY,
              });
              setActiveKey(OTHER_SCRATCH_KEY);
            }}
          >
            SwitchProject
          </button>
          <Probe scratchKey={activeKey} onHandle={(h) => (latest = h)} />
        </div>
      );
    }

    // useScratchDocument does not depend on TanStack Router context.
    await using screen = await render(<Switchable />, { router: false });
    await vi.waitFor(() => {
      expect(screen.getByTestId("markdown").element().textContent).toBe(
        JSON.stringify("Project A keep\n\nProject A send"),
      );
    });

    // Simulate an unsaved local edit on Project A whose leave-flush resolves an OCC conflict with a peer edit
    // before the captured target's consumeRange runs after switching to Project B.
    let saveAttempt = 0;
    mockState.saveImpl.mockImplementation(async ({ input }) => {
      saveAttempt += 1;
      if (saveAttempt === 1) {
        return AsyncResult.fail({
          _tag: "ScratchRevisionConflictError",
          current: {
            scratchKey: SCRATCH_KEY,
            markdown: "Project A keep\n\nProject A send\n\nPeer note",
            revision: 3,
            lastCursorOffset: 0,
            updatedAt: "2026-11-23T00:00:03.000Z",
            attachments: [],
          },
        });
      }
      return AsyncResult.success({
        scratchKey: input.scratchKey,
        revision: input.expectedRevision + 1,
        updatedAt: "2026-11-23T00:00:03.500Z",
        attachments: [],
      });
    });

    latest.setMarkdown("Project A keep!\n\nProject A send");
    const capturedTarget = latest.captureTarget();
    screen
      .getByText("SwitchProject")
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(screen.getByTestId("markdown").element().textContent).toBe(
        JSON.stringify("Project B untouched"),
      );
    });

    const consumed = await latest.consumeRange({
      target: capturedTarget,
      baseMarkdown: "Project A keep!\n\nProject A send",
      baseRevision: 2,
      nextMarkdown: "Project A keep!",
      nextCursorOffset: 15,
      attachmentIds: [],
    });
    expect(consumed.ok).toBe(true);
    expect(consumeCalls).toHaveLength(1);
    expect(consumeCalls[0]?.scratchKey).toBe(SCRATCH_KEY);
    expect(consumeCalls[0]?.nextMarkdown).toBe("Project A keep!\n\nPeer note");
    expect(screen.getByTestId("markdown").element().textContent).toBe(
      JSON.stringify("Project B untouched"),
    );
  });

  it("replays pending consumptions on reconnect, adopts authoritative server markdown, and guards dirty typing from remote cursor yanks", async () => {
    setup();
    mockState.snapshot = makeSnapshot("Keep\n\nSend me", 1, null, { lastCursorOffset: 4 });
    const consumeCalls: ScratchConsumeChunkInput[] = [];
    let failFirstConsume = true;
    mockState.consumeImpl.mockImplementation(async ({ input }) => {
      consumeCalls.push(input);
      if (failFirstConsume) {
        failFirstConsume = false;
        return AsyncResult.fail(new Error("offline"));
      }
      // Server already applied the idempotent consumption and a peer added follow-up text at rev 3.
      return AsyncResult.success({
        scratchKey: input.scratchKey,
        markdown: "Keep\n\nPeer note",
        revision: 3,
        lastCursorOffset: 15,
        updatedAt: "2026-11-23T00:00:05.000Z",
        attachments: [],
      });
    });

    let latest!: ScratchDocumentHandle;
    function Reconnectable() {
      const [enabled, setEnabled] = useState(true);
      const [, setTick] = useState(0);
      return (
        <div>
          <span data-testid="enabled">{String(enabled)}</span>
          <button type="button" onClick={() => setEnabled(false)}>
            Disconnect
          </button>
          <button type="button" onClick={() => setEnabled(true)}>
            Reconnect
          </button>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            Rerender
          </button>
          <Probe enabled={enabled} onHandle={(h) => (latest = h)} />
        </div>
      );
    }

    // useScratchDocument does not depend on TanStack Router context.
    await using screen = await render(<Reconnectable />, { router: false });
    await vi.waitFor(() => {
      expect(screen.getByTestId("markdown").element().textContent).toBe(
        JSON.stringify("Keep\n\nSend me"),
      );
    });

    // While local typing is unsaved (dirty), a remote same-revision setCursor must not yank the caret.
    latest.setMarkdown("Keep typing\n\nSend me");
    mockState.snapshot = makeSnapshot("Keep\n\nSend me", 1, "other-device", {
      lastCursorOffset: 12,
    });
    screen
      .getByText("Rerender")
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(screen.getByTestId("markdown").element().textContent).toBe(
        JSON.stringify("Keep typing\n\nSend me"),
      );
    });
    expect(screen.getByTestId("remote-cursor-seq").element().textContent).toBe("0");

    // Reset back to clean and fail a consumeRange so it persists to pending replay queue.
    latest.setMarkdown("Keep\n\nSend me");
    const firstAttempt = await latest.consumeRange({
      consumptionId: "replay-id-1",
      baseMarkdown: "Keep\n\nSend me",
      baseRevision: 1,
      nextMarkdown: "Keep",
      nextCursorOffset: 4,
      attachmentIds: [],
    });
    expect(firstAttempt).toEqual({ ok: false });
    expect(consumeCalls).toHaveLength(1);

    // Disconnect and reconnect -> pending consumption replays and adopts authoritative server markdown.
    screen
      .getByText("Disconnect")
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(screen.getByTestId("enabled").element().textContent).toBe("false");
    });
    screen
      .getByText("Reconnect")
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => {
      expect(consumeCalls).toHaveLength(2);
      expect(screen.getByTestId("markdown").element().textContent).toBe(
        JSON.stringify("Keep\n\nPeer note"),
      );
    });
    expect(screen.getByTestId("cursor").element().textContent).toBe("15");
  });

  it("pushes cursor moves made during an in-flight save, re-syncs caret on reconnect snapshots, and merges typing during replay", async () => {
    setup();
    mockState.snapshot = makeSnapshot("Keep\n\nSend me", 1, null, { lastCursorOffset: 4 });
    let releaseSave!: () => void;
    const cursorCalls: ScratchSetCursorInput[] = [];
    mockState.saveImpl.mockImplementation(async ({ input }) => {
      await new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      return AsyncResult.success({
        scratchKey: input.scratchKey,
        revision: input.expectedRevision + 1,
        updatedAt: "2026-11-23T00:00:06.000Z",
        attachments: [],
      });
    });
    mockState.setCursorImpl.mockImplementation(async ({ input }) => {
      cursorCalls.push(input);
      return AsyncResult.success({
        scratchKey: input.scratchKey,
        lastCursorOffset: input.cursorOffset,
      });
    });
    let releaseConsume!: () => void;
    mockState.consumeImpl.mockImplementation(async ({ input }) => {
      await new Promise<void>((resolve) => {
        releaseConsume = resolve;
      });
      return AsyncResult.success({
        scratchKey: input.scratchKey,
        markdown: "Keep!",
        revision: input.expectedRevision + 1,
        lastCursorOffset: 5,
        updatedAt: "2026-11-23T00:00:07.000Z",
        attachments: [],
      });
    });

    let latest!: ScratchDocumentHandle;
    function Wrapper() {
      const [, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            Rerender
          </button>
          <Probe onHandle={(h) => (latest = h)} />
        </div>
      );
    }

    // useScratchDocument does not depend on TanStack Router context.
    await using screen = await render(<Wrapper />, { router: false });
    await vi.waitFor(() => {
      expect(screen.getByTestId("markdown").element().textContent).toBe(
        JSON.stringify("Keep\n\nSend me"),
      );
    });

    // Move cursor while save is in flight -> pushed automatically once save finishes.
    latest.setMarkdown("Keep!\n\nSend me");
    const flushing = latest.flush();
    await vi.waitFor(() => {
      expect(mockState.saveImpl).toHaveBeenCalledTimes(1);
    });
    latest.setCursorOffset(12);
    releaseSave();
    await flushing;
    expect(cursorCalls.map((c) => c.cursorOffset)).toContain(12);

    // Reconnect snapshot (originClientId: null) with newer revision bumps remoteCursorSeq to reposition inactive caret.
    const seqBeforeReconnect = Number(
      screen.getByTestId("remote-cursor-seq").element().textContent,
    );
    mockState.snapshot = makeSnapshot("Keep!\n\nSend me", 3, null, { lastCursorOffset: 2 });
    screen
      .getByText("Rerender")
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(Number(screen.getByTestId("remote-cursor-seq").element().textContent)).toBeGreaterThan(
        seqBeforeReconnect,
      );
    });

    // Typing while a consumeRange RPC is in flight merges instead of wiping the new local text.
    const consuming = latest.consumeRange({
      consumptionId: "merge-during-consume",
      baseMarkdown: "Keep!\n\nSend me",
      baseRevision: 3,
      nextMarkdown: "Keep!",
      nextCursorOffset: 5,
      attachmentIds: [],
    });
    await vi.waitFor(() => {
      expect(mockState.consumeImpl).toHaveBeenCalledTimes(1);
    });
    latest.setMarkdown("Keep!\n\nSend me\n\nTyped mid-replay");
    releaseConsume();
    await consuming;
    await vi.waitFor(() => {
      const md = JSON.parse(screen.getByTestId("markdown").element().textContent ?? '""') as string;
      expect(md).toContain("Keep!");
      expect(md).toContain("Typed mid-replay");
      expect(md).not.toContain("Send me");
    });
  });

  it("retries failed setCursor calls and auto-retries failed saves on reconnect", async () => {
    setup();
    mockState.snapshot = makeSnapshot("Base text", 1, null, { lastCursorOffset: 0 });
    let failNextCursor = true;
    mockState.setCursorImpl.mockImplementation(async ({ input }) => {
      if (failNextCursor) {
        failNextCursor = false;
        return AsyncResult.fail(new Error("cursor offline"));
      }
      return AsyncResult.success({
        scratchKey: input.scratchKey,
        lastCursorOffset: input.cursorOffset,
      });
    });

    let failNextSave = true;
    mockState.saveImpl.mockImplementation(async ({ input }) => {
      if (failNextSave) {
        failNextSave = false;
        return AsyncResult.fail(new Error("network offline"));
      }
      return AsyncResult.success({
        scratchKey: input.scratchKey,
        revision: input.expectedRevision + 1,
        updatedAt: "2026-11-23T00:00:09.000Z",
        attachments: [],
      });
    });

    let latest!: ScratchDocumentHandle;
    function Wrapper() {
      const [enabled, setEnabled] = useState(true);
      return (
        <div>
          <span data-testid="enabled">{String(enabled)}</span>
          <button type="button" onClick={() => setEnabled(false)}>
            Off
          </button>
          <button type="button" onClick={() => setEnabled(true)}>
            On
          </button>
          <Probe enabled={enabled} onHandle={(h) => (latest = h)} />
        </div>
      );
    }

    // useScratchDocument does not depend on TanStack Router context.
    await using screen = await render(<Wrapper />, { router: false });
    await vi.waitFor(() => {
      expect(screen.getByTestId("markdown").element().textContent).toBe(
        JSON.stringify("Base text"),
      );
    });

    // First setCursor fails -> does not advance sentCursorOffset, so repeating at the same offset retries.
    latest.setCursorOffset(4, { immediate: true });
    await vi.waitFor(() => {
      expect(mockState.setCursorImpl).toHaveBeenCalledTimes(1);
    });
    latest.setCursorOffset(4, { immediate: true });
    await vi.waitFor(() => {
      expect(mockState.setCursorImpl).toHaveBeenCalledTimes(2);
    });

    // Save fails transiently -> status becomes "error" without starting a 400ms retry loop;
    // reconnecting auto-retries the dirty save once.
    {
      using _timers = fakeTimers();
      latest.setMarkdown("Base text edited");
      await latest.flush();
      expect(mockState.saveImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(mockState.saveImpl).toHaveBeenCalledTimes(1);
    }

    screen
      .getByText("Off")
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(screen.getByTestId("enabled").element().textContent).toBe("false");
    });
    screen
      .getByText("On")
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(mockState.saveImpl).toHaveBeenCalledTimes(2);
    });
  });
});
