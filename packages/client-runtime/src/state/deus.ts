import {
  WS_METHODS,
  DeusStateError,
  type DeusScope,
  type DeusSessionRef,
  type DeusSubscriptionEvent,
  type DeusSession,
  type DeusCursor,
  type DeusTranscript,
  type DeusAttachInput,
  type DeusHumanCeiling,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { deusMetadata, deusRequest } from "../rpc/deus.ts";
import { makeDeusMediaTransport } from "../rpc/deusMedia.ts";
import {
  makeDeusVoiceConnection,
  type DeusVoiceHandlers,
  type DeusVoiceConnection,
} from "../deus/voice.ts";
export type { DeusVoiceHandlers, DeusVoiceConnection } from "../deus/voice.ts";
import type { EnvironmentUnaryRpcTag } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

const isDeusStateError = Schema.is(DeusStateError);

type DeusUnaryTag = Extract<EnvironmentUnaryRpcTag, `deus.${string}`>;
/** @public Shared command surface for web, desktop and mobile Deus clients. */
export function createDeusCommands<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const command = <T extends DeusUnaryTag>(tag: T) =>
    createEnvironmentRpcCommand(runtime, { label: tag, tag });
  const attach = command(WS_METHODS.deusAttach);
  const voice = createEnvironmentRpcCommand(runtime, {
    label: "Deus voice connect",
    tag: WS_METHODS.deusAttach,
    execute: (
      input: DeusAttachInput & {
        readonly authority: DeusHumanCeiling;
        readonly conversation: DeusSession["conversation"];
        readonly handlers: DeusVoiceHandlers;
        readonly connected: (connection: DeusVoiceConnection) => void;
      },
    ) => {
      const { handlers, connected, conversation, ...request } = input;
      return deusRequest(WS_METHODS.deusAttach, request).pipe(
        Effect.flatMap((attachment) =>
          makeDeusMediaTransport(attachment).pipe(
            Effect.flatMap((transport) =>
              makeDeusVoiceConnection(attachment, transport, handlers, conversation),
            ),
            Effect.tap((connection) => Effect.sync(() => connected(connection))),
            Effect.as(attachment),
            Effect.onError(() =>
              deusRequest(WS_METHODS.deusDetach, attachment).pipe(Effect.ignore),
            ),
          ),
        ),
      );
    },
  });
  return {
    voice,
    getCapabilities: command(WS_METHODS.deusGetCapabilities),
    open: command(WS_METHODS.deusOpen),
    getSnapshot: command(WS_METHODS.deusGetSnapshot),
    sendInput: command(WS_METHODS.deusSendInput),
    resetConversation: command(WS_METHODS.deusResetConversation),
    launchTask: command(WS_METHODS.deusLaunchTask),
    taskAction: command(WS_METHODS.deusTaskAction),
    memorySearch: command(WS_METHODS.deusMemorySearch),
    memoryRead: command(WS_METHODS.deusMemoryRead),
    memoryCorrect: command(WS_METHODS.deusMemoryCorrect),
    ponder: command(WS_METHODS.deusPonder),
    getLearning: command(WS_METHODS.deusGetLearning),
    configureLearning: command(WS_METHODS.deusConfigureLearning),
    attach,
    renew: command(WS_METHODS.deusRenew),
    detach: command(WS_METHODS.deusDetach),
    mediaPush: command(WS_METHODS.deusMediaPush),
    mediaControl: command(WS_METHODS.deusMediaControl),
    getSettings: command(WS_METHODS.deusGetSettings),
    updateSettings: command(WS_METHODS.deusUpdateSettings),
    setCredential: command(WS_METHODS.deusSetCredential),
    conversation: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "Deus conversation",
      idleTtlMs: 0,
      subscribe: (input: import("@t3tools/contracts").DeusSubscriptionInput) =>
        deusMetadata(input).pipe(
          Stream.scanEffect(
            () => null as DeusConversationView | null,
            (state, event) =>
              Effect.try({
                try: () => projectDeusConversation(state, event, input),
                catch: (error) =>
                  isDeusStateError(error)
                    ? error
                    : new DeusStateError({ reason: "conflict", message: "Invalid Deus metadata." }),
              }),
          ),
        ),
    }),
    metadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "Deus metadata",
      subscribe: deusMetadata,
    }),
  };
}

export const DEUS_TRANSCRIPT_LIMIT = 200;
const DEUS_TRANSCRIPT_TEXT_LIMIT = 128_000;

export interface DeusConversationView {
  readonly session: DeusSession;
  readonly cursor: DeusCursor;
  readonly transcripts: readonly DeusTranscript[];
}

export function sameDeusScope(a: DeusScope, b: DeusScope) {
  return a.environmentId === b.environmentId && a.projectId === b.projectId;
}

function boundedTranscripts(rows: readonly DeusTranscript[]) {
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()].slice(
    -DEUS_TRANSCRIPT_LIMIT,
  );
  let characters = 0;
  let start = unique.length;
  while (start > 0 && characters + unique[start - 1]!.text.length <= DEUS_TRANSCRIPT_TEXT_LIMIT) {
    characters += unique[--start]!.text.length;
  }
  return unique.slice(start);
}

export function projectDeusConversation(
  state: DeusConversationView | null,
  event: DeusSubscriptionEvent,
  ref: DeusSessionRef,
): DeusConversationView {
  const identity = event.type === "snapshot" ? event.snapshot.session : event.delta;
  if (!sameDeusScope(identity, ref) || identity.sessionId !== ref.sessionId) {
    throw new DeusStateError({
      reason: "scope-mismatch",
      message: "Deus metadata belongs to another destination.",
    });
  }
  if (event.type === "snapshot") {
    if (state && state.cursor > event.snapshot.cursor) return state;
    return {
      session: event.snapshot.session,
      cursor: event.snapshot.cursor,
      transcripts: boundedTranscripts(event.snapshot.transcripts),
    };
  }
  const delta = event.delta;
  if (state && delta.cursor <= state.cursor) return state;
  if (
    !state ||
    state.cursor !== delta.previousCursor ||
    delta.cursor !== delta.previousCursor + 1
  ) {
    throw new DeusStateError({
      reason: "cursor-expired",
      message: "Deus history has a gap. Refresh the conversation.",
    });
  }
  return {
    ...state,
    cursor: delta.cursor,
    ...(delta.change.type === "conversation-reset"
      ? { session: { ...state.session, conversation: delta.change.conversation } }
      : {}),
    ...(delta.change.type === "transcript"
      ? { transcripts: boundedTranscripts([...state.transcripts, delta.change.transcript]) }
      : {}),
  };
}

/** Local media only: stopping an attachment never cancels server workers. */
export function createDeusLocalAttachment() {
  let owned: {
    scope: DeusScope;
    stop: () => Promise<void>;
    stopping: Promise<void> | null;
  } | null = null;
  return {
    has: (scope: DeusScope) => owned !== null && sameDeusScope(owned.scope, scope),
    register: (scope: DeusScope, stop: () => Promise<void>) => {
      if (owned) throw new Error("Release the existing local Deus attachment first.");
      const attachment = { scope, stop, stopping: null as Promise<void> | null };
      owned = attachment;
      return () => {
        if (owned === attachment && !attachment.stopping) owned = null;
      };
    },
    release: (scope: DeusScope): Promise<void> => {
      if (!owned || !sameDeusScope(owned.scope, scope)) return Promise.resolve();
      const attachment = owned;
      if (attachment.stopping) return attachment.stopping;
      attachment.stopping = attachment.stop().then(
        () => {
          if (owned === attachment) owned = null;
        },
        (error: unknown) => {
          attachment.stopping = null;
          throw error;
        },
      );
      return attachment.stopping;
    },
  };
}
