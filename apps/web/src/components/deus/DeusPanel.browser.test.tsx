import "../../index.css";
import type { ThreadRouteTarget } from "../../threadRoutes";
import type { VoicePlatform } from "../../deus/VoiceAudio";
import { useSyncExternalStore } from "react";
import { RegistryContext } from "@effect/atom-react";
import { createDeusCommands } from "@t3tools/client-runtime/state/deus";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type { WsRpcProtocolClient, RpcSession } from "@t3tools/client-runtime/rpc";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  DEFAULT_SERVER_SETTINGS,
  DeusConversation,
  DeusAttachmentId,
  type DeusAttachInput,
  type DeusHumanCeiling,
  type DeusPcmInput,
  type DeusMediaControlInput,
  type DeusMediaOutput,
  DeusCursor,
  DeusPonderId,
  DeusSessionId,
  DeusTranscriptId,
  DeusStateError,
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
  type DeusHumanInput,
  type DeusOpenInput,
  type DeusSnapshot,
  type DeusSubscriptionEvent,
  type DeusSubscriptionInput,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { useDeusPanelStore } from "../../deusPanelStore";
import { useDeusCommands } from "./DeusCommands";
import { SidebarProvider } from "../ui/sidebar";
import { ChatRouteLayout } from "../ChatRouteLayout";
import { ProjectLanding } from "./ProjectLanding";
import type { EnvironmentPresentation } from "../../state/environments";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

const state = vi.hoisted(() => ({
  supervisors: new Map<
    EnvironmentId,
    Effect.Effect<EnvironmentSupervisor.EnvironmentSupervisor["Service"]>
  >(),
  sessions: new Map<
    EnvironmentId,
    Atom.Writable<AsyncResult.AsyncResult<AuthSessionState, Error>>
  >(),
  environments: new Map<EnvironmentId, EnvironmentPresentation>(),
  projects: [] as EnvironmentProject[],
  audio: null as VoicePlatform | null,
  version: 0,
  listeners: new Set<() => void>(),
}));
vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((
      ...args: Parameters<typeof actual.createEnvironmentSessionAtoms>
    ) => ({
      ...actual.createEnvironmentSessionAtoms(...args),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
    })) as typeof actual.createEnvironmentSessionAtoms,
  };
});
vi.mock(import("../../state/deus"), async () => ({
  deusEnvironment: createDeusCommands(
    Atom.runtime(
      Layer.effect(
        EnvironmentRegistry.EnvironmentRegistry,
        Effect.gen(function* () {
          const supervisors = new Map(
            yield* Effect.forEach([...state.supervisors], ([id, program]) =>
              program.pipe(Effect.map((supervisor) => [id, supervisor] as const)),
            ),
          );
          return {
            run: (id, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisors.get(id)!,
              ),
            followStream: (id, stream) =>
              Stream.provideService(
                stream,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisors.get(id)!,
              ),
          } as EnvironmentRegistry.EnvironmentRegistry["Service"];
        }),
      ),
    ),
  ),
}));
function useFixturePresentation() {
  useSyncExternalStore(
    (notify) => {
      state.listeners.add(notify);
      return () => {
        state.listeners.delete(notify);
      };
    },
    () => state.version,
  );
}
vi.mock(import("../../deus/browserAudio"), () => ({
  browserVoicePlatform: {
    check: () => state.audio!.check(),
    createContext: () => state.audio!.createContext(),
    getUserMedia: () => state.audio!.getUserMedia(),
    createCapture: (...args: Parameters<VoicePlatform["createCapture"]>) =>
      state.audio!.createCapture(...args),
  },
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironment: (id: EnvironmentId | null) => {
    useFixturePresentation();
    return id === null ? null : (state.environments.get(id) ?? null);
  },
}));
vi.mock(import("../../state/entities"), () => ({
  useThreadShells: () => [],
  useProject: (ref: { environmentId: EnvironmentId; projectId: ProjectId } | null) => {
    useFixturePresentation();
    return ref === null
      ? null
      : (state.projects.find(
          (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
        ) ?? null);
  },
}));
vi.mock(import("../../hooks/useSettings"), () => ({
  useClientSettings: ((select?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
}));
vi.mock(import("../ThreadRouteView"), () => ({
  ThreadRouteView: ({ target }: { target: ThreadRouteTarget }) => (
    <p>Worker {target.kind === "server" ? target.threadRef.threadId : target.draftId}</p>
  ),
}));
vi.mock(import("../promptLinks/ThreadLinkPrompt"), () => ({ ThreadLinkPrompt: () => null }));

const first = { environmentId: EnvironmentId.make("one"), projectId: ProjectId.make("project") };
const second = { ...first, projectId: ProjectId.make("second") };
const remote = { ...first, environmentId: EnvironmentId.make("two") };
const supported = {
  available: true,
  protocolVersion: 1,
  text: true,
  liveAudio: false,
  learning: false,
  reportModes: ["SILENT"],
} as const;
const timestamp = "2026-10-30T00:00:00.000Z";
function config(environmentId: EnvironmentId): ServerConfig {
  return {
    environment: {
      environmentId,
      label: environmentId,
      platform: { os: "linux", arch: "x64" },
      serverVersion: "test",
      capabilities: { repositoryIdentity: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    cwd: "/fixture",
    keybindingsConfigPath: "/fixture/keys.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/fixture/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
    deus: supported,
  };
}
const session = (operate = true): AuthSessionState => ({
  authenticated: true,
  scopes: operate
    ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
    : [AuthOrchestrationReadScope],
  auth: config(first.environmentId).auth,
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function OpenCommandFixture() {
  const action = useDeusCommands(first)[0]!;
  return (
    <button disabled={!action.enabled} onClick={action.run}>
      Open Deus command
    </button>
  );
}
async function setup(path = "/projects/one/project", voice = false, learningFailure = false) {
  state.supervisors.clear();
  state.environments.clear();
  state.sessions.clear();
  state.projects = [];
  state.version = 0;
  state.listeners.clear();
  useDeusPanelStore.setState({
    target: null,
    pendingTarget: null,
    maximized: false,
    busy: false,
    error: null,
  });
  const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const capture = { stop: vi.fn() };
  const context = {
    state: "running",
    currentTime: 0,
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const microphone = vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
  let onInput!: (bytes: Uint8Array) => Promise<boolean>;
  state.audio = {
    check: () => {},
    createContext: () => context as unknown as AudioContext,
    getUserMedia: microphone,
    createCapture: async (_context, _stream, input) => {
      onInput = input;
      return capture;
    },
  };
  const attachments: Array<DeusAttachInput & { authority: DeusHumanCeiling }> = [];
  const inputs: DeusPcmInput[] = [];
  const controls: DeusMediaControlInput[] = [];
  const detached = deferred();
  const mediaQueues = new Map<string, Queue.Enqueue<DeusMediaOutput>>();
  const snapshots = new Map<string, DeusSnapshot>();
  const queues = new Map<string, Queue.Enqueue<DeusSubscriptionEvent>>();
  const opened: string[] = [];
  const subscribed: string[] = [];
  const stopped = new Map<string, ReturnType<typeof deferred>>();
  let failSend = false;
  const key = (ref: { environmentId: EnvironmentId; projectId: ProjectId }) =>
    `${ref.environmentId}/${ref.projectId}`;
  for (const ref of [first, second, remote]) {
    const scope = key(ref);
    stopped.set(scope, deferred());
    state.projects.push({
      environmentId: ref.environmentId,
      id: ref.projectId,
      title: scope,
      workspaceRoot: "/fixture",
      defaultModelSelection: null,
      scripts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const serverConfig = { ...config(ref.environmentId), deus: { ...supported, liveAudio: voice } };
    const target = new PrimaryConnectionTarget({
      environmentId: ref.environmentId,
      label: ref.environmentId,
      httpBaseUrl: "https://fixture.test",
      wsBaseUrl: "wss://fixture.test",
    });
    state.environments.set(ref.environmentId, {
      environmentId: ref.environmentId,
      label: ref.environmentId,
      connection: { phase: "connected", error: null, traceId: null },
      serverConfig,
      displayUrl: null,
      relayManaged: false,
      entry: { target, enabled: true, profile: Option.none() },
    });
    state.sessions.set(
      ref.environmentId,
      Atom.make<AsyncResult.AsyncResult<AuthSessionState, Error>>(AsyncResult.success(session())),
    );
    const attachment = {
      ...ref,
      sessionId: DeusSessionId.make(`session-${scope}`),
      attachmentId: DeusAttachmentId.make(`audio-${scope}`),
      generation: 1,
      responseEpoch: 0,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const client = {
      [WS_METHODS.deusAttach]: (input: DeusAttachInput & { authority: DeusHumanCeiling }) =>
        Effect.sync(() => {
          attachments.push(input);
          return attachment;
        }),
      [WS_METHODS.deusMediaPush]: (input: DeusPcmInput) =>
        Effect.sync(() => {
          inputs.push(input);
        }),
      [WS_METHODS.deusMediaControl]: (input: DeusMediaControlInput) =>
        Effect.sync(() => {
          controls.push(input);
        }),
      [WS_METHODS.deusDetach]: () =>
        Effect.sync(() => {
          detached.resolve();
        }),
      [WS_METHODS.deusRenew]: () => Effect.succeed(attachment),
      [WS_METHODS.deusMediaSubscribe]: () =>
        Stream.callback<DeusMediaOutput>((queue) =>
          Effect.gen(function* () {
            mediaQueues.set(scope, queue);
            yield* Queue.offer(queue, {
              ...attachment,
              conversation: DeusConversation.make(1),
              turnId: `turn-${scope}`,
              sequence: 0,
              type: "control",
              state: "listening",
            });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                mediaQueues.delete(scope);
              }),
            );
          }),
        ),
      [WS_METHODS.deusOpen]: (input: DeusOpenInput) =>
        Effect.sync(() => {
          const destination = key(input);
          opened.push(destination);
          if (!snapshots.has(destination))
            snapshots.set(destination, {
              session: {
                ...input,
                sessionId: DeusSessionId.make(`session-${destination}`),
                conversation: DeusConversation.make(1),
                createdAt: timestamp,
                updatedAt: timestamp,
              },
              cursor: DeusCursor.make(0),
              transcripts: [],
              tasks: [],
              reports: [],
              observations: [],
              memories: [],
              ponderReceipts: learningFailure
                ? [
                    {
                      id: DeusPonderId.make("failed-learning"),
                      snapshotCursor: DeusCursor.make(0),
                      observationIds: [],
                      writtenMemoryIds: [],
                      acknowledgedObservationIds: [],
                      status: "blocked",
                      error: "Fixture learning blocked",
                      createdAt: timestamp,
                      completedAt: timestamp,
                    },
                  ]
                : [],
            });
          return snapshots.get(destination)!;
        }),
      [WS_METHODS.deusSubscribe]: (input: DeusSubscriptionInput) =>
        Stream.callback<DeusSubscriptionEvent>((queue) =>
          Effect.gen(function* () {
            const destination = key(input);
            subscribed.push(destination);
            queues.set(destination, queue);
            yield* Queue.offer(queue, { type: "snapshot", snapshot: snapshots.get(destination)! });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                queues.delete(destination);
                stopped.get(destination)!.resolve();
              }),
            );
          }),
        ),
      [WS_METHODS.deusSendInput]: (input: DeusHumanInput) =>
        Effect.gen(function* () {
          if (failSend)
            return yield* new DeusStateError({
              reason: "conflict",
              message: "Fixture rejected this message",
            });
          const destination = key(input);
          const previous = snapshots.get(destination)!;
          const row = {
            id: DeusTranscriptId.make(input.inputId),
            inputId: input.inputId,
            conversation: input.conversation,
            role: "human" as const,
            text: input.text,
            createdAt: timestamp,
          };
          const cursor = DeusCursor.make(previous.cursor + 1);
          snapshots.set(destination, {
            ...previous,
            cursor,
            transcripts: [...previous.transcripts, row],
          });
          yield* Queue.offer(queues.get(destination)!, {
            type: "delta",
            delta: {
              ...previous.session,
              previousCursor: previous.cursor,
              cursor,
              change: { type: "transcript", transcript: row },
            },
          });
          return { inputId: input.inputId, cursor, status: "accepted" as const };
        }),
    } as unknown as WsRpcProtocolClient;
    const rpcSession: RpcSession = {
      client,
      initialConfig: Effect.succeed(serverConfig),
      subscribeServerConfig: () => Stream.never,
      ready: Effect.void,
      probe: Effect.void,
      inboundFrames: Effect.succeed(0),
      closed: Effect.never,
    };
    state.supervisors.set(
      ref.environmentId,
      Effect.gen(function* () {
        return EnvironmentSupervisor.EnvironmentSupervisor.of({
          target,
          session: yield* SubscriptionRef.make(Option.some(rpcSession)),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          }),
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
      }),
    );
  }
  const registry = AtomRegistry.make();
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat", component: ChatRouteLayout });
  const project = createRoute({
    getParentRoute: () => chat,
    path: "projects/$environmentId/$projectId",
    component: () => {
      const params = project.useParams();
      return (
        <>
          <OpenCommandFixture />
          <ProjectLanding
            target={{
              environmentId: EnvironmentId.make(params.environmentId),
              projectId: ProjectId.make(params.projectId),
            }}
          />
        </>
      );
    },
  });
  const thread = createRoute({
    getParentRoute: () => chat,
    path: "$environmentId/$threadId",
    component: () => null,
  });
  const settings = createRoute({
    getParentRoute: () => chat,
    path: "settings/general",
    component: () => <div role="dialog">Settings fixture</div>,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([project, thread, settings])]),
    history: createMemoryHistory({ initialEntries: [path] }),
    disableGlobalCatchBoundary: true,
  });
  await using stack = new AsyncDisposableStack();
  stack.defer(() => registry.dispose());
  const screen = stack.use(
    await render(
      <RegistryContext value={registry}>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </RegistryContext>,
    ),
  );
  const resources = stack.move();
  return {
    screen,
    microphone,
    context,
    track,
    capture,
    attachments,
    inputs,
    controls,
    detached,
    mediaQueues,
    input: (bytes: Uint8Array) => onInput(bytes),
    router,
    registry,
    opened,
    subscribed,
    snapshots,
    stopped,
    failSend: (value: boolean) => {
      failSend = value;
    },
    redraw: () =>
      act(() => {
        state.version++;
        for (const notify of state.listeners) notify();
      }),
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}

describe("project Deus runtime ownership", () => {
  it("keeps failed learning visible while details and task history are collapsed", async () => {
    await using h = await setup("/projects/one/project", true, true);
    await userEvent.click(h.screen.getByRole("button", { name: "Open Deus command", exact: true }));
    await expect
      .element(h.screen.getByRole("button", { name: "Connect voice", exact: true }))
      .toBeEnabled();
    await expect
      .element(h.screen.getByRole("alert"))
      .toHaveTextContent("Learning blocked: Fixture learning blocked");
    await expect.element(h.screen.getByText("Run learning now", { exact: true })).not.toBeVisible();
    expect(h.microphone).not.toHaveBeenCalled();
  });
  it("owns controlled voice above navigation and responsive frames, using guarded authority and distinct controls", async () => {
    await page.viewport(1280, 800);
    await using h = await setup("/projects/one/project", true);
    await act(() => useDeusPanelStore.getState().requestOpen(first));
    await expect.element(h.screen.getByRole("button", { name: "Connect voice" })).toBeEnabled();
    expect(h.microphone).not.toHaveBeenCalled();
    expect(h.attachments).toEqual([]);
    await userEvent.click(h.screen.getByRole("button", { name: "Connect voice" }));
    await expect
      .element(h.screen.getByLabelText("Voice status"))
      .toHaveTextContent("Voice: listening.");
    expect(h.attachments).toHaveLength(1);
    expect(h.attachments[0]).toMatchObject({
      ...first,
      takeover: false,
      authority: {
        runtimeMode: "approval-required",
        interactionMode: "default",
        allowWorktree: false,
      },
    });
    await h.input(new Uint8Array(640));
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1));
    for (const path of ["/one/worker-a", "/settings/general", "/projects/one/second"])
      await act(() => h.router.navigate({ to: path }));
    await page.viewport(600, 800);
    await expect.element(page.getByRole("button", { name: "Mute microphone" })).toBeVisible();
    expect(h.microphone).toHaveBeenCalledOnce();
    expect(h.context.close).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Mute microphone" }));
    await expect.element(page.getByRole("button", { name: "Resume microphone" })).toBeVisible();
    expect(h.track.stop).toHaveBeenCalledOnce();
    await userEvent.click(page.getByRole("button", { name: "Interrupt speech" }));
    await vi.waitFor(() =>
      expect(h.controls.map((row) => row.action)).toEqual(["mute", "interrupt-response"]),
    );
    await userEvent.click(page.getByRole("button", { name: "Resume microphone" }));
    await expect.element(page.getByRole("button", { name: "Mute microphone" })).toBeVisible();
    expect(h.microphone).toHaveBeenCalledTimes(2);
    await userEvent.fill(
      page.getByRole("textbox", { name: "Message Deus" }),
      "Typed while attached",
    );
    await userEvent.click(page.getByRole("button", { name: "Send message", exact: true }));
    await expect
      .element(
        page.getByRole("list", { name: "Deus transcript" }).getByText("Typed while attached"),
      )
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Disconnect voice" }));
    await h.detached.promise;
    await expect.element(page.getByRole("button", { name: "Connect voice" })).toBeEnabled();
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.controls.map((row) => row.action)).toEqual(["mute", "interrupt-response", "resume"]);
    await userEvent.click(page.getByRole("button", { name: "Close Deus", exact: true }));
    await page.viewport(1280, 800);
  });

  it("revokes actual controlled voice and blocks a new permission prompt at the destination", async () => {
    await using h = await setup("/projects/one/project", true);
    await act(() => useDeusPanelStore.getState().requestOpen(first));
    await expect.element(h.screen.getByRole("button", { name: "Connect voice" })).toBeEnabled();
    await userEvent.click(h.screen.getByRole("button", { name: "Connect voice" }));
    await expect
      .element(h.screen.getByLabelText("Voice status"))
      .toHaveTextContent("Voice: listening.");
    await act(() =>
      h.registry.set(state.sessions.get(first.environmentId)!, AsyncResult.success(session(false))),
    );
    await expect.element(h.screen.getByRole("button", { name: "Connect voice" })).toBeDisabled();
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.microphone).toHaveBeenCalledOnce();
  });

  it("opens an empty project without worker/provider commands, preserves the mounted conversation through threads and Settings", async () => {
    await page.viewport(1280, 800);
    await using h = await setup();
    await expect.element(h.screen.getByRole("heading", { name: "one/project" })).toBeVisible();
    expect(h.opened).toEqual([]);
    await userEvent.click(h.screen.getByRole("button", { name: "Open Deus", exact: true }));
    await expect.element(h.screen.getByText("Text conversation connected.")).toBeVisible();
    const composer = h.screen.container.querySelector("textarea");
    await userEvent.fill(h.screen.getByRole("textbox", { name: "Message Deus" }), "Keep my draft");
    for (const path of [
      "/one/worker-a",
      "/one/worker-b",
      "/settings/general",
      "/one/worker-a",
      "/projects/one/second",
      "/projects/two/project",
    ]) {
      await act(() => h.router.navigate({ to: path }));
      expect(h.screen.container.querySelector("textarea")).toBe(composer);
      expect(useDeusPanelStore.getState().target).toEqual(first);
    }
    expect(h.opened).toEqual(["one/project"]);
    expect(h.subscribed).toEqual(["one/project"]);
    await userEvent.click(h.screen.getByRole("button", { name: "Send message", exact: true }));
    await expect
      .element(h.screen.getByRole("list", { name: "Deus transcript" }).getByText("Keep my draft"))
      .toBeVisible();
    expect(h.snapshots.get("one/project")?.transcripts).toHaveLength(1);
  });

  it("requires explicit cross-target switching, awaits local stop and closes without a worker cancel", async () => {
    await page.viewport(1280, 800);
    await using h = await setup();
    await userEvent.click(h.screen.getByRole("button", { name: "Open Deus", exact: true }));
    await expect.element(h.screen.getByText("Text conversation connected.")).toBeVisible();
    const release = deferred();
    let localStops = 0;
    useDeusPanelStore.getState().localAttachment.register(first, () => {
      localStops++;
      return release.promise;
    });
    await act(() => useDeusPanelStore.getState().requestOpen(remote));
    await userEvent.click(h.screen.getByRole("button", { name: "Keep current destination" }));
    expect(localStops).toBe(0);
    await act(() => useDeusPanelStore.getState().requestOpen(remote));
    await userEvent.click(
      h.screen.getByRole("button", { name: "Stop local attachment and switch" }),
    );
    expect(useDeusPanelStore.getState().target).toEqual(first);
    await act(() => release.resolve());
    await expect
      .element(h.screen.getByLabelText("Deus destination"))
      .toHaveTextContent("two / project");
    await userEvent.click(h.screen.getByRole("button", { name: "Close Deus", exact: true }));
    await expect
      .element(h.screen.getByRole("region", { name: "Project Deus" }))
      .not.toBeInTheDocument();
    expect(localStops).toBe(1);
    expect(h.opened).toEqual(["one/project", "two/project"]);
    await h.stopped.get("one/project")!.promise;
  });

  it.each(["legacy", "disabled", "credential", "offline", "removed"])(
    "does not open an unavailable %s destination",
    async (kind) => {
      await using h = await setup();
      const environment = state.environments.get(first.environmentId)!;
      if (kind === "legacy") {
        const { deus: _, ...legacy } = environment.serverConfig!;
        state.environments.set(first.environmentId, { ...environment, serverConfig: legacy });
      }
      if (kind === "disabled" || kind === "credential")
        state.environments.set(first.environmentId, {
          ...environment,
          serverConfig: {
            ...environment.serverConfig!,
            deus: {
              available: false,
              protocolVersion: 1,
              reason: kind === "disabled" ? "disabled" : "not-configured",
            },
          },
        });
      if (kind === "offline")
        state.environments.set(first.environmentId, {
          ...environment,
          connection: { phase: "offline", error: null, traceId: null },
        });
      if (kind === "removed") state.projects = [];
      await act(() => useDeusPanelStore.getState().requestOpen(first));
      await expect.element(h.screen.getByRole("textbox", { name: "Message Deus" })).toBeDisabled();
      expect(h.opened).toEqual([]);
    },
  );

  it("surfaces a service rejection, preserves draft and releases local media on revocation", async () => {
    await using h = await setup();
    await act(() => useDeusPanelStore.getState().requestOpen(first));
    await expect.element(h.screen.getByText("Text conversation connected.")).toBeVisible();
    h.failSend(true);
    await userEvent.fill(
      h.screen.getByRole("textbox", { name: "Message Deus" }),
      "Retain this message",
    );
    await userEvent.click(h.screen.getByRole("button", { name: "Send message", exact: true }));
    await expect
      .element(h.screen.getByRole("alert"))
      .toHaveTextContent("Fixture rejected this message");
    await expect
      .element(h.screen.getByRole("textbox", { name: "Message Deus" }))
      .toHaveValue("Retain this message");
    const released = deferred();
    useDeusPanelStore.getState().localAttachment.register(first, () => {
      released.resolve();
      return Promise.resolve();
    });
    await act(() =>
      h.registry.set(state.sessions.get(first.environmentId)!, AsyncResult.success(session(false))),
    );
    await released.promise;
    await expect
      .element(h.screen.getByRole("button", { name: "Send message", exact: true }))
      .toBeDisabled();
    expect(h.subscribed).toEqual(["one/project"]);
  });

  it.each(["revoked", "offline", "deleted", "removed-environment"])(
    "disposes its local attachment and subscription when %s",
    async (kind) => {
      await using h = await setup();
      await act(() => useDeusPanelStore.getState().requestOpen(first));
      await expect.element(h.screen.getByText("Text conversation connected.")).toBeVisible();
      const released = deferred();
      useDeusPanelStore.getState().localAttachment.register(first, () => {
        released.resolve();
        return Promise.resolve();
      });
      if (kind === "revoked")
        await act(() =>
          h.registry.set(
            state.sessions.get(first.environmentId)!,
            AsyncResult.success({ ...session(), scopes: [] }),
          ),
        );
      if (kind === "offline") {
        const environment = state.environments.get(first.environmentId)!;
        state.environments.set(first.environmentId, {
          ...environment,
          connection: { phase: "offline", error: null, traceId: null },
        });
      }
      if (kind === "deleted")
        state.projects = state.projects.filter(
          (project) =>
            project.id !== first.projectId || project.environmentId !== first.environmentId,
        );
      if (kind === "removed-environment") state.environments.delete(first.environmentId);
      await h.redraw();
      await released.promise;
      await h.stopped.get("one/project")!.promise;
      await expect.element(h.screen.getByRole("textbox", { name: "Message Deus" })).toBeDisabled();
      expect(useDeusPanelStore.getState().localAttachment.has(first)).toBe(false);
    },
  );

  it("keeps service ownership across inline/sheet resizing and maximize/restore", async () => {
    await page.viewport(1280, 800);
    await using h = await setup();
    await act(() => useDeusPanelStore.getState().requestOpen(first));
    await expect.element(h.screen.getByText("Text conversation connected.")).toBeVisible();
    await page.viewport(600, 800);
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await act(() => h.router.navigate({ to: "/settings/general" }));
    await expect.element(h.screen.getByText("Settings fixture")).toBeVisible();
    await act(() =>
      h.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: "one", threadId: "worker-a" },
      }),
    );
    await expect.element(page.getByRole("button", { name: "Maximize panel" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Maximize panel" }));
    await expect
      .element(h.screen.getByRole("button", { name: "Restore panel size" }))
      .toBeVisible();
    expect(h.subscribed).toEqual(["one/project"]);
    await userEvent.click(h.screen.getByRole("button", { name: "Restore panel size" }));
    await userEvent.click(page.getByRole("button", { name: "Close Deus", exact: true }));
    await page.viewport(1280, 800);
  });
});
