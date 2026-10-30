// @effect-diagnostics nodeBuiltinImport:off -- owns the SDK process because Live setup has no public cancellation hook.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";
import type { GoogleGenAI, Session } from "@google/genai";

export type LiveSession = Pick<
  Session,
  "sendRealtimeInput" | "sendToolResponse" | "sendContextUpdate" | "close"
>;
export interface LiveClient {
  readonly connect: (
    parameters: Parameters<GoogleGenAI["live"]["connect"]>[0],
  ) => Promise<LiveSession>;
  readonly dispose: () => Promise<void>;
}
export type LiveProcessInput =
  | {
      readonly type: "connect";
      readonly apiKey: string;
      readonly baseUrl?: string;
      readonly parameters: Omit<Parameters<GoogleGenAI["live"]["connect"]>[0], "callbacks">;
    }
  | {
      readonly type: "sendRealtimeInput";
      readonly value: Parameters<Session["sendRealtimeInput"]>[0];
    }
  | {
      readonly type: "sendToolResponse";
      readonly value: Parameters<Session["sendToolResponse"]>[0];
    }
  | {
      readonly type: "sendContextUpdate";
      readonly value: Parameters<Session["sendContextUpdate"]>[0];
    };
export type LiveProcessOutput =
  | { readonly type: "ready" }
  | {
      readonly type: "message";
      readonly value: Parameters<
        NonNullable<Parameters<GoogleGenAI["live"]["connect"]>[0]["callbacks"]["onmessage"]>
      >[0];
    }
  | { readonly type: "failure"; readonly message: string };

export const createLiveClient = (options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly entry?: string;
}): LiveClient & { readonly owner: NodeChildProcess.ChildProcess } => {
  const entry =
    options.entry ??
    NodeURL.fileURLToPath(
      new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
    );
  const child = NodeChildProcess.spawn(
    process.execPath,
    [...(NodeSea.isSea() ? [] : [entry]), "__deus-live"],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  const ready = Promise.withResolvers<LiveSession>();
  const ended = Promise.withResolvers<void>();
  // The process can fail before connect installs its consumer.
  void ready.promise.catch(() => undefined);
  let callbacks: Parameters<GoogleGenAI["live"]["connect"]>[0]["callbacks"] | undefined;
  let closed = false;
  let started = false;
  let pending = 0;
  const failure = (message: string) => {
    ready.reject(new Error(message));
    if (!closed) callbacks?.onerror?.({ message });
  };
  const send = (value: LiveProcessInput) => {
    if (closed || !child.connected) throw new Error("Live SDK process is closed");
    if (pending >= 32) throw new Error("Live SDK process send queue is full");
    pending++;
    if (
      !child.send(value, (cause) => {
        pending--;
        if (cause) failure(cause.message);
      })
    )
      throw new Error("Live SDK process IPC backpressure");
  };
  const dispose = () => {
    if (!closed) {
      closed = true;
      ready.reject(new Error("Live SDK process was closed"));
      // Session is hidden until setupComplete; terminating its owner also closes a never-ready socket.
      child.kill("SIGKILL");
    }
    return ended.promise;
  };
  const session: LiveSession = {
    sendRealtimeInput: (value) => send({ type: "sendRealtimeInput", value }),
    sendToolResponse: (value) => send({ type: "sendToolResponse", value }),
    sendContextUpdate: (value) => send({ type: "sendContextUpdate", value }),
    close: () => {
      void dispose();
    },
  };
  child.on("message", (message: LiveProcessOutput) => {
    if (closed) return;
    if (message.type === "ready") ready.resolve(session);
    else if (message.type === "message") callbacks?.onmessage?.(message.value);
    else if (message.type === "failure") failure(message.message);
  });
  child.on("error", (cause) => failure(cause.message));
  child.once("close", (code, signal) => {
    failure(`Live SDK process ended (${signal ?? code})`);
    closed = true;
    child.removeAllListeners();
    ended.resolve();
  });
  return {
    owner: child,
    dispose,
    connect: (parameters) => {
      if (started) return Promise.reject(new Error("Live SDK process already connected"));
      started = true;
      callbacks = parameters.callbacks;
      try {
        send({
          type: "connect",
          apiKey: options.apiKey,
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          parameters: {
            model: parameters.model,
            ...(parameters.config ? { config: parameters.config } : {}),
          },
        });
      } catch (cause) {
        ready.reject(cause);
      }
      return ready.promise;
    },
  };
};
