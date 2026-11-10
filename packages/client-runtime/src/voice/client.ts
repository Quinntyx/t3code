import { ORCHESTRATION_V2_WS_METHODS, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "../state/runtime.ts";
import type { createEnvironmentCatalogAtoms } from "../state/connections.ts";
import type { createServerEnvironmentAtoms } from "../state/server.ts";
import {
  createLiveShellEnvironmentIdsAtom,
  type createEnvironmentShellAtoms,
} from "../state/shell.ts";
import type { createEnvironmentThreadStateAtoms } from "../state/threads.ts";
import { awaitAtomValue } from "./awaitAtom.ts";
import {
  createNotificationFeed,
  notificationsFromShell,
  type VoiceNotification,
  type VoiceSeenStore,
} from "./notifications.ts";
import { createVoiceSession, type VoiceKeyStore } from "./session.ts";
import { createVoiceTools, type VoiceEnvironmentView } from "./tools.ts";

/** What a platform's audio owner hands Voice once its microphone and speaker are running. */
export interface VoiceAudioConnection {
  readonly offer: (bytes: Uint8Array) => Promise<boolean>;
  readonly control: (action: "mute" | "resume" | "interrupt-response") => Promise<boolean>;
  readonly dispose: () => Promise<void>;
}
/** What Voice hands the platform's audio owner: 24 kHz PCM to play and session events. */
export interface VoiceAudioHandlers {
  readonly audio: (bytes: Uint8Array, epoch: number) => void;
  readonly epoch: (epoch: number) => void;
  readonly event: (event: {
    readonly type: string;
    readonly state?: string;
    readonly error?: { readonly message: string };
  }) => void;
  readonly closed: () => void;
}
export interface VoiceAudioDevice {
  readonly connect: (
    attach: (handlers: VoiceAudioHandlers) => Promise<VoiceAudioConnection>,
  ) => Promise<void>;
  readonly disconnect: () => Promise<void>;
}

const READ_THREAD_TIMEOUT_MS = 15_000;

/** The client half of Voice: a Gemini session over the threads this client's shells can see. */
export function createVoiceClient<R, ER>(options: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>;
  readonly catalog: Pick<ReturnType<typeof createEnvironmentCatalogAtoms>, "catalogValueAtom">;
  readonly shell: Pick<
    ReturnType<typeof createEnvironmentShellAtoms>,
    "stateValueAtom" | "statusAtom"
  >;
  readonly server: Pick<ReturnType<typeof createServerEnvironmentAtoms>, "providersValueAtom">;
  readonly threads: Pick<ReturnType<typeof createEnvironmentThreadStateAtoms>, "stateAtom">;
  readonly storage: {
    readonly key: VoiceKeyStore;
    readonly seen: VoiceSeenStore;
    readonly model: { readonly read: () => string };
  };
  readonly audio: VoiceAudioDevice;
  readonly uuid: () => string;
}) {
  const { registry } = options;
  const liveEnvironmentIds = createLiveShellEnvironmentIdsAtom({
    catalogValueAtom: options.catalog.catalogValueAtom,
    statusAtom: options.shell.statusAtom,
  });
  const snapshotOf = (get: Atom.AtomContext, environmentId: EnvironmentId) =>
    Option.getOrNull(get(options.shell.stateValueAtom(environmentId)).snapshot);
  const viewsAtom = Atom.make((get): ReadonlyArray<VoiceEnvironmentView> => {
    const catalog = get(options.catalog.catalogValueAtom);
    return [...get(liveEnvironmentIds)].flatMap((environmentId) => {
      const snapshot = snapshotOf(get, environmentId);
      if (!snapshot) return [];
      return [
        {
          id: environmentId,
          label: catalog.entries.get(environmentId)?.target.label ?? environmentId,
          projects: snapshot.projects,
          threads: snapshot.threads,
          providers: get(options.server.providersValueAtom(environmentId)) ?? [],
        },
      ];
    });
  });
  const notificationsAtom = Atom.make((get) => {
    const notifications: VoiceNotification[] = [];
    for (const environmentId of get(liveEnvironmentIds)) {
      const snapshot = snapshotOf(get, environmentId);
      if (snapshot) notifications.push(...notificationsFromShell(environmentId, snapshot));
    }
    return notifications;
  });
  const feed = createNotificationFeed(options.storage.seen, (notice) =>
    registry
      .get(viewsAtom)
      .some(
        (environment) =>
          environment.id === notice.environmentId &&
          environment.threads.some((thread) => thread.id === notice.threadId),
      ),
  );
  const tools = createVoiceTools({
    registry,
    dispatch: createEnvironmentRpcCommand(options.runtime, {
      label: "voice:dispatch",
      tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    }),
    environments: () => registry.get(viewsAtom),
    async readThread(environmentId, threadId) {
      const abort = new AbortController();
      // @effect-diagnostics-next-line globalTimers:off - Gemini awaits this tool call outside an Effect runtime.
      const timeout = setTimeout(() => abort.abort(), READ_THREAD_TIMEOUT_MS);
      try {
        const data = await awaitAtomValue(
          registry,
          options.threads.stateAtom(environmentId, ThreadId.make(threadId)),
          (result) => (AsyncResult.isSuccess(result) ? Option.getOrNull(result.value.data) : null),
          abort.signal,
        );
        return {
          thread: data.thread,
          recentOutput: data.turnItems.slice(-30),
          pendingRequests: data.runtimeRequests.filter((request) => request.status === "pending"),
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    uuid: options.uuid,
  });

  let handlers: VoiceAudioHandlers | null = null;
  let audioEpoch = 0;
  const session = createVoiceSession({
    key: options.storage.key,
    model: options.storage.model.read,
    feed,
    tools,
    onAudio: (data) => {
      const bytes = Base64.decode(data);
      if (Result.isSuccess(bytes)) handlers?.audio(bytes.success, audioEpoch);
    },
    onInterrupt: () => handlers?.epoch(++audioEpoch),
    onDisconnect: () => {
      const previous = handlers;
      handlers = null;
      previous?.closed();
    },
  });

  let unwatchNotifications: (() => void) | null = null;
  const open = async (reload: boolean) => {
    if (reload || !session.getSnapshot().open) await session.open();
    const snapshot = session.getSnapshot();
    if (!snapshot.open || snapshot.status === "disabled") {
      unwatchNotifications?.();
      unwatchNotifications = null;
      return;
    }
    unwatchNotifications ??= registry.subscribe(
      notificationsAtom,
      (notifications) => feed.update(notifications),
      { immediate: true },
    );
  };
  return {
    session,
    /** Opens the session and forwards thread notifications until `close`. */
    open: () => open(false),
    /** Re-reads the device key for an open session, after Settings changes it. */
    async reload() {
      if (session.getSnapshot().open) await open(true);
    },
    close() {
      unwatchNotifications?.();
      unwatchNotifications = null;
      session.close();
      void options.audio.disconnect();
    },
    /** Starts the microphone and speaker, then Gemini, from an explicit user gesture. */
    async connectMicrophone() {
      if (session.getSnapshot().status === "disabled") return;
      await options.audio.connect(async (next) => {
        handlers = next;
        audioEpoch = 0;
        await session.connect();
        if (session.getSnapshot().status !== "connected")
          throw new Error("Gemini did not connect.");
        next.event({ type: "control", state: "listening" });
        return {
          offer: async (bytes) => {
            session.sendAudio(Base64.encode(bytes));
            return true;
          },
          control: async (action) => {
            if (action === "interrupt-response") session.interrupt();
            else if (action === "mute") session.endAudio();
            return true;
          },
          dispose: async () => {
            handlers = null;
            session.disconnect();
          },
        };
      });
    },
    disconnect() {
      session.disconnect();
      void options.audio.disconnect();
    },
  };
}
