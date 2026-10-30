// @effect-diagnostics nodeBuiltinImport:off -- this private IPC entrypoint exclusively owns one official SDK connection.
import { GoogleGenAI, type Session } from "@google/genai";
import type { LiveProcessInput, LiveProcessOutput } from "./geminiLiveProcess.ts";

export const runGeminiLiveWorker = () => {
  if (!process.send) throw new Error("Live SDK worker requires an owned IPC channel");
  let started = false;
  let failed = false;
  let session: Session | undefined;
  const fail = (cause: unknown) => {
    if (failed) return;
    failed = true;
    const message = cause instanceof Error ? cause.message : String(cause);
    process.send?.(
      { type: "failure", message: message.slice(0, 2000) } satisfies LiveProcessOutput,
      () => process.exit(1),
    );
  };
  const send = (message: LiveProcessOutput) => {
    if (failed) return;
    if (Buffer.byteLength(JSON.stringify(message)) > 100_000)
      return fail(new Error("Live SDK message exceeds the process bound"));
    if (
      !process.send?.(message, (cause) => {
        if (cause) process.exit(1);
      })
    )
      process.exit(1);
  };
  process.once("disconnect", () => process.exit(0));
  process.on("message", (message: LiveProcessInput) => {
    if (failed) return;
    if (message.type === "connect") {
      if (started) return fail(new Error("Live SDK worker already connected"));
      started = true;
      const client = new GoogleGenAI({
        apiKey: message.apiKey,
        vertexai: false,
        apiVersion: "v1beta",
        ...(message.baseUrl ? { httpOptions: { baseUrl: message.baseUrl } } : {}),
      });
      void client.live
        .connect({
          ...message.parameters,
          callbacks: {
            onmessage: (value) => send({ type: "message", value }),
            onerror: (event) => fail(new Error(event.message)),
            onclose: (event) =>
              fail(new Error(`Connection closed (${event.code}): ${event.reason}`)),
          },
        })
        .then((value) => {
          session = value;
          if (failed) {
            try {
              value.close();
            } catch {
              /* The owner exits even if late SDK cleanup throws. */
            }
            return;
          }
          send({ type: "ready" });
        })
        .catch(fail);
      return;
    }
    try {
      if (!session) throw new Error("Live SDK setup has not completed");
      if (message.type === "sendRealtimeInput") session.sendRealtimeInput(message.value);
      else if (message.type === "sendToolResponse") session.sendToolResponse(message.value);
      else session.sendContextUpdate(message.value);
    } catch (cause) {
      fail(cause);
    }
  });
};
