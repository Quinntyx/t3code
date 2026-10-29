import {
  DeusSessionRef,
  DeusObservationId,
  DeusStateError,
  type DeusDelta,
  type DeusInputReceipt,
  type DeusObservation,
  type DeusSourceRef,
  type DeusSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Repository from "./DeusRepository.ts";
import * as Memory from "./DeusMemoryService.ts";
import { type ObservationInput } from "./decide.ts";
import { CONTEXT_LIMITS, lexicalScore, page, preview } from "./contextBounds.ts";

const SearchInput = Schema.Struct({
  ...DeusSessionRef.fields,
  query: Schema.String.check(Schema.isMaxLength(1024)),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CONTEXT_LIMITS.items })),
  ),
  includeSuperseded: Schema.optional(Schema.Boolean),
  memoryScopes: Schema.optional(Schema.Array(Memory.MemoryScope).check(Schema.isMaxLength(3))),
});
export type ContextSearchInput = typeof SearchInput.Type;
const ObservationReadInput = Schema.Struct({
  ...DeusSessionRef.fields,
  observationId: DeusObservationId,
});
export type ObservationReadInput = typeof ObservationReadInput.Type;
export type ContextPreview = Pick<
  DeusObservation,
  "id" | "kind" | "source" | "supersedes" | "conversation" | "taskId"
> &
  ReturnType<typeof preview>;
export type ContextPage = {
  readonly items: ReadonlyArray<ContextPreview>;
  readonly omitted: number;
};
export type InputContext = {
  readonly evidenceOnly: true;
  readonly working: ContextPage;
  readonly memory: Memory.MemoryPage;
};
type Failure = Repository.DeusRepositoryError;
export class DeusContextService extends Context.Service<
  DeusContextService,
  {
    readonly recordObservation: (
      input: ObservationInput,
    ) => Effect.Effect<DeusInputReceipt, Failure>;
    readonly search: (input: ContextSearchInput) => Effect.Effect<ContextPage, Failure>;
    readonly readObservation: (
      input: ObservationReadInput,
    ) => Effect.Effect<
      { readonly observation: DeusObservation; readonly source: DeusDelta },
      Failure
    >;
    readonly readSource: (ref: DeusSourceRef) => Effect.Effect<DeusDelta, Failure>;
    readonly contextForInput: (input: ContextSearchInput) => Effect.Effect<InputContext, Failure>;
  }
>()("t3/deus/DeusContextService") {}

const decodeSearch = Schema.decodeEffect(SearchInput);
const decodeObservationRead = Schema.decodeEffect(ObservationReadInput);
const searchSnapshot = (input: ContextSearchInput, snapshot: DeusSnapshot) => {
  const superseded = new Set(snapshot.observations.map((observation) => observation.supersedes));
  const ranked = snapshot.observations
    .filter((observation) => input.includeSuperseded || !superseded.has(observation.id))
    .map((observation) => ({ observation, score: lexicalScore(observation.text, input.query) }))
    .filter(
      ({ observation, score }) =>
        !input.query.trim() || score > 0 || observation.kind === "correction",
    )
    .sort(
      (a, b) =>
        Number(b.observation.kind === "correction") - Number(a.observation.kind === "correction") ||
        b.score - a.score ||
        (b.observation.source?.cursor ?? 0) - (a.observation.source?.cursor ?? 0) ||
        b.observation.createdAt.localeCompare(a.observation.createdAt) ||
        b.observation.id.localeCompare(a.observation.id),
    );
  return page(
    ranked.map(({ observation }) => ({
      id: observation.id,
      kind: observation.kind,
      source: observation.source,
      supersedes: observation.supersedes,
      conversation: observation.conversation,
      taskId: observation.taskId,
      ...preview(observation.text),
    })),
    input.limit,
  );
};

const make = Effect.gen(function* () {
  const repository = yield* Repository.DeusRepository;
  const memory = yield* Memory.DeusMemoryService;
  const search = Effect.fn("DeusContextService.search")(function* (raw: ContextSearchInput) {
    const input = yield* decodeSearch(raw).pipe(
      Effect.mapError(
        () => new DeusStateError({ reason: "conflict", message: "Invalid Deus context query." }),
      ),
    );
    return searchSnapshot(input, yield* repository.snapshot(input));
  });
  const readSource = Effect.fn("DeusContextService.readSource")(function* (ref: DeusSourceRef) {
    const source = yield* repository.readSource(ref);
    if (source.change.type !== "report" && source.change.type !== "transcript")
      return yield* new DeusStateError({
        reason: "conflict",
        message: "This cursor is derived context, not original source evidence.",
      });
    return source;
  });
  const readObservation = Effect.fn("DeusContextService.readObservation")(function* (
    raw: ObservationReadInput,
  ) {
    const input = yield* decodeObservationRead(raw).pipe(
      Effect.mapError(
        () =>
          new DeusStateError({ reason: "conflict", message: "Invalid Deus observation identity." }),
      ),
    );
    const snapshot = yield* repository.snapshot(input);
    const observation = snapshot.observations.find((entry) => entry.id === input.observationId);
    if (!observation?.source)
      return yield* new DeusStateError({
        reason: "not-found",
        message: "Deus observation or original source was not found.",
      });
    if (
      observation.source.sessionId !== input.sessionId ||
      observation.source.environmentId !== input.environmentId ||
      observation.source.projectId !== input.projectId
    )
      return yield* new DeusStateError({
        reason: "scope-mismatch",
        message: "Deus observation source is not in this scope.",
      });
    return { observation, source: yield* readSource(observation.source) };
  });
  return DeusContextService.of({
    recordObservation: Effect.fn("DeusContextService.recordObservation")((input) =>
      repository.commit({ type: "observe", input }).pipe(Effect.map((result) => result.receipt)),
    ),
    search,
    readSource,
    readObservation,
    contextForInput: Effect.fn("DeusContextService.contextForInput")(function* (raw) {
      const input = yield* decodeSearch(raw).pipe(
        Effect.mapError(
          () => new DeusStateError({ reason: "conflict", message: "Invalid Deus context query." }),
        ),
      );
      const snapshot = yield* repository.snapshot(input);
      const working = searchSnapshot(input, snapshot);
      const superseded = new Set(
        snapshot.observations.flatMap((observation) =>
          observation.supersedes === null ? [] : [observation.supersedes],
        ),
      );
      const memories = yield* memory.search(
        { ...input, scopes: input.memoryScopes ?? ["project"] },
        superseded,
      );
      return { evidenceOnly: true as const, working, memory: memories };
    }),
  });
});
export const layer = Layer.effect(DeusContextService, make);
