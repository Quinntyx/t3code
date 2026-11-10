import type { FunctionDeclaration } from "@google/genai";
import { EnvironmentId, OrchestrationV2Command } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";
import type { AtomCommand } from "../state/runtime.ts";
import type { VoiceTools } from "./session.ts";

export interface VoiceEnvironmentView {
  readonly id: string;
  readonly label: string;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title?: string }>;
  readonly providers: ReadonlyArray<unknown>;
  readonly threads: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly activeRunId?: string | null;
  }>;
}

type Dispatch = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: OrchestrationV2Command },
  unknown,
  unknown
> & {
  readonly permissionAtom: (
    environmentId: EnvironmentId | null,
    input?: unknown,
  ) => Atom.Atom<boolean>;
};
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const string = { type: "string" };
const object = { type: "object" };
const target = { environmentId: string, threadId: string };
const definitions = [
  ["list_environments", "List this client's connected environments.", {}, []],
  [
    "list_projects",
    "List projects in a visible environment.",
    { environmentId: string },
    ["environmentId"],
  ],
  [
    "list_providers",
    "List providers and available model choices in an environment.",
    { environmentId: string },
    ["environmentId"],
  ],
  [
    "list_threads",
    "List visible threads, optionally filtering their titles.",
    { environmentId: string, query: string },
    ["environmentId"],
  ],
  [
    "search_threads",
    "Search visible thread titles across connected environments.",
    { query: string },
    ["query"],
  ],
  [
    "read_thread",
    "Read a thread's status, recent output and pending approval or question requests.",
    target,
    ["environmentId", "threadId"],
  ],
  [
    "create_thread",
    "Create a thread in an existing project. Choose modelSelection from list_providers; returns its id. Use send_message to start work.",
    { environmentId: string, projectId: string, title: string, modelSelection: object },
    ["environmentId", "projectId", "title", "modelSelection"],
  ],
  [
    "send_message",
    "Send user work to a visible thread, queuing after active work.",
    { ...target, message: string },
    ["environmentId", "threadId", "message"],
  ],
  [
    "interrupt_thread",
    "Interrupt the active turn without disconnecting its provider session.",
    target,
    ["environmentId", "threadId"],
  ],
  ["stop_thread", "Stop a thread and its delegated work.", target, ["environmentId", "threadId"]],
  [
    "respond_to_approval",
    "Answer a pending approval after the user instructs you. Read the request first.",
    { ...target, requestId: string, decision: string, feedback: string },
    ["environmentId", "threadId", "requestId", "decision"],
  ],
  [
    "respond_to_question",
    "Answer pending questions after reading the request. answers maps question ids to string arrays.",
    { ...target, requestId: string, answers: object },
    ["environmentId", "threadId", "requestId", "answers"],
  ],
] as const;
const declarations: ReadonlyArray<FunctionDeclaration> = definitions.map(
  ([name, description, properties, required]) => ({
    name,
    description,
    parametersJsonSchema: {
      type: "object",
      properties,
      required: [...required],
      additionalProperties: false,
    },
  }),
);

export function createVoiceTools(options: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly dispatch: Dispatch;
  readonly environments: () => ReadonlyArray<VoiceEnvironmentView>;
  readonly readThread: (environmentId: EnvironmentId, threadId: string) => Promise<unknown>;
  readonly uuid: () => string;
}): VoiceTools {
  const text = (args: Record<string, unknown>, key: string) => {
    const value = args[key];
    if (typeof value !== "string" || !value.trim() || value.length > 16000)
      throw new Error(`Invalid ${key}`);
    return value.trim();
  };
  return {
    declarations,
    async execute(name, args) {
      const environments = options.environments();
      if (name === "list_environments") return environments.map(({ id, label }) => ({ id, label }));
      if (name === "search_threads") {
        const query = text(args, "query").toLowerCase();
        return environments
          .flatMap((environment) =>
            environment.threads
              .filter((thread) => thread.title.toLowerCase().includes(query))
              .map((thread) => ({ environmentId: environment.id, ...thread })),
          )
          .slice(0, 100);
      }
      const environment = environments.find((entry) => entry.id === args.environmentId);
      if (!environment) throw new Error("Environment is not visible in this client.");
      const environmentId = EnvironmentId.make(environment.id);
      if (name === "list_projects") return environment.projects;
      if (name === "list_providers") return environment.providers;
      if (name === "list_threads")
        return environment.threads
          .filter(
            (thread) =>
              typeof args.query !== "string" ||
              thread.title.toLowerCase().includes(args.query.toLowerCase()),
          )
          .slice(0, 100);
      let command: Record<string, unknown>;
      let threadId: string;
      if (name === "create_thread") {
        if (!environment.projects.some((project) => project.id === args.projectId))
          throw new Error("Project is not visible in this client.");
        threadId = options.uuid();
        command = {
          type: "thread.create",
          threadId,
          projectId: text(args, "projectId"),
          title: text(args, "title"),
          modelSelection: args.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        };
      } else {
        threadId = text(args, "threadId");
        if (!environment.threads.some((thread) => thread.id === threadId))
          throw new Error("Thread is not visible in this client.");
        if (name === "read_thread") return options.readThread(environmentId, threadId);
        switch (name) {
          case "send_message":
            command = {
              type: "message.dispatch",
              threadId,
              messageId: options.uuid(),
              text: text(args, "message"),
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            };
            break;
          case "interrupt_thread": {
            const runId = environment.threads.find((thread) => thread.id === threadId)?.activeRunId;
            if (!runId) throw new Error("Thread has no active run to interrupt.");
            command = { type: "run.interrupt", threadId, runId, holdQueue: true };
            break;
          }
          case "stop_thread":
            command = { type: "thread.stop", threadId };
            break;
          case "respond_to_approval":
            command = {
              type: "runtime-request.respond",
              threadId,
              requestId: text(args, "requestId"),
              decision: text(args, "decision"),
              ...(typeof args.feedback === "string" ? { feedback: args.feedback } : {}),
            };
            break;
          case "respond_to_question":
            command = {
              type: "runtime-request.respond",
              threadId,
              requestId: text(args, "requestId"),
              answers: args.answers,
            };
            break;
          default:
            throw new Error("Unknown Voice tool.");
        }
      }
      const input = decodeCommand({ ...command, commandId: options.uuid() });
      if (!options.registry.get(options.dispatch.permissionAtom(environmentId, input)))
        throw new Error("This client's grant does not allow that command.");
      const result = await options.dispatch.run(options.registry, { environmentId, input });
      if (!AsyncResult.isSuccess(result))
        throw new Error("The client command failed or permission was revoked.");
      return { threadId, result: result.value };
    },
  };
}
