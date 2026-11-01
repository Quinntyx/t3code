import { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Registry from "../provider/ProviderRegistry.ts";
import { invalidOptionSelections } from "../provider/validateModelOptions.ts";
import { PONDER_LIMITS, ponderError, type PonderRun } from "./ponderProtocol.ts";
import { buildPonderPrompt } from "./ponderPrompt.ts";
import prompt from "./prompts/ponder.md" with { type: "text" };

export class DeusPonderWorker extends Context.Service<
  DeusPonderWorker,
  {
    readonly run: (run: PonderRun) => Effect.Effect<unknown, ReturnType<typeof ponderError>>;
  }
>()("t3/deus/DeusPonderWorker") {}
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const make = Effect.gen(function* () {
  const registry = yield* Registry.ProviderRegistry;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const run = Effect.fn("DeusPonderWorker.run")(function* (input: PonderRun) {
    const model = input.model;
    if (!model)
      return yield* ponderError(
        "Configure a learning model and effort explicitly; no fallback model is selected.",
      );
    const provider = (yield* registry.getProviders).find(
      (candidate) => candidate.instanceId === model.instanceId,
    );
    const available = provider?.models.find((candidate) => candidate.slug === model.model);
    if (
      !provider?.installed ||
      !provider.enabled ||
      provider.status !== "ready" ||
      provider.auth.status === "unauthenticated" ||
      !available ||
      invalidOptionSelections(model.options ?? [], available.capabilities?.optionDescriptors)
        .length > 0
    )
      return yield* ponderError("Configured learning provider, model, or effort is unavailable.");
    const launch = yield* launches
      .launch({
        commandId: CommandId.make(input.threadId),
        threadId: input.threadId,
        projectId: input.projectId,
        title: `Deus learning ${input.localDate}`,
        generateTitle: false,
        modelSelection: model,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          text: buildPonderPrompt(prompt, {
            observations: input.observations,
            history: input.history,
            omitted: input.omitted,
          }),
          attachments: [],
        },
        createdBy: "system",
        creationSource: "deus",
      })
      .pipe(Effect.mapError(() => ponderError("Learning worker thread could not be launched.")));
    const initial = launch.projection.runs.find((candidate) => candidate.ordinal === 1);
    if (!initial) return yield* ponderError("Learning worker launch has no initial run.");
    const stopped = yield* threads
      .waitForThread({
        projectId: input.projectId,
        threadId: input.threadId,
        runId: initial.id,
        timeoutMs: PONDER_LIMITS.timeoutMs,
      })
      .pipe(
        Effect.onInterrupt(() =>
          threads
            .interruptThread({
              projectId: input.projectId,
              threadId: input.threadId,
              runId: initial.id,
              commandId: CommandId.make(`${input.threadId}:stop`),
              reason: "Learning owner was interrupted.",
            })
            .pipe(Effect.ignore),
        ),
        Effect.mapError(() => ponderError("Learning worker completion could not be read.")),
      );
    if (stopped.timedOut) {
      yield* threads
        .interruptThread({
          projectId: input.projectId,
          threadId: input.threadId,
          runId: initial.id,
          commandId: CommandId.make(`${input.threadId}:timeout`),
          reason: "Bounded Deus learning deadline reached.",
        })
        .pipe(Effect.ignore);
      return yield* ponderError("Learning worker exceeded its ten-minute deadline.");
    }
    if (stopped.run?.status !== "completed")
      return yield* ponderError("Learning worker did not complete successfully.");
    const window = yield* threads
      .getThreadSnapshotWindow(input.threadId, { rowLimit: 32 })
      .pipe(Effect.mapError(() => ponderError("Learning worker result could not be read.")));
    const message = window.projection.messages
      .filter((candidate) => candidate.runId === initial.id && candidate.role === "assistant")
      .at(-1);
    if (!message || Buffer.byteLength(message.text) > PONDER_LIMITS.resultBytes)
      return yield* ponderError("Learning result is absent or exceeds its bound.");
    return yield* decodeJson(message.text).pipe(
      Effect.mapError(() => ponderError("Learning worker did not return one JSON object.")),
    );
  });
  return DeusPonderWorker.of({ run });
});
export const layer = Layer.effect(DeusPonderWorker, make);
