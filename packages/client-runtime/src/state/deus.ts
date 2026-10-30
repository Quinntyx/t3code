import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { deusMetadata } from "../rpc/deus.ts";
import type { EnvironmentUnaryRpcTag } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

type DeusUnaryTag = Extract<EnvironmentUnaryRpcTag, `deus.${string}`>;
/** @public Shared command surface for web, desktop and mobile Deus clients. */
export function createDeusCommands<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const command = <T extends DeusUnaryTag>(tag: T) =>
    createEnvironmentRpcCommand(runtime, { label: tag, tag });
  return {
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
    attach: command(WS_METHODS.deusAttach),
    renew: command(WS_METHODS.deusRenew),
    detach: command(WS_METHODS.deusDetach),
    mediaPush: command(WS_METHODS.deusMediaPush),
    mediaControl: command(WS_METHODS.deusMediaControl),
    getSettings: command(WS_METHODS.deusGetSettings),
    updateSettings: command(WS_METHODS.deusUpdateSettings),
    setCredential: command(WS_METHODS.deusSetCredential),
    metadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "Deus metadata",
      subscribe: deusMetadata,
    }),
  };
}
