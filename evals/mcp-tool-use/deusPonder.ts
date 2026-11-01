#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  PonderRun,
  PromotionKind,
  PromotionResult,
  validatePromotion,
} from "../../apps/server/src/deus/ponderProtocol.ts";
import { buildPonderPrompt } from "../../apps/server/src/deus/ponderPrompt.ts";

const Case = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  record: Schema.String,
  kind: Schema.NullOr(PromotionKind),
  safe: Schema.Unknown,
  unsafe: Schema.Unknown,
});
const decodeCase = Schema.decodeEffect(Schema.fromJsonString(Case));
const decodeRun = Schema.decodeUnknownSync(PonderRun);
const decodeResult = Schema.decodeUnknownSync(PromotionResult);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const loadPonderCases = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const input = yield* fs.readFileString(new URL("./deus-ponder.ndjson", import.meta.url).pathname);
  return yield* Effect.forEach(input.trim().split("\n"), (line) => decodeCase(line));
});
export const ponderCase = Effect.fn("PonderEval.request")(function* (fixture: typeof Case.Type) {
  const fs = yield* FileSystem.FileSystem;
  const policy = yield* fs.readFileString(
    new URL("../../apps/server/src/deus/prompts/ponder.md", import.meta.url).pathname,
  );
  const scope = { environmentId: "synthetic", projectId: "synthetic", sessionId: "synthetic" };
  const run = decodeRun({
    ...scope,
    localDate: "2026-01-01",
    receipt: {
      id: "synthetic",
      snapshotCursor: 1,
      observationIds: ["o1"],
      status: "running",
      writtenMemoryIds: [],
      acknowledgedObservationIds: [],
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
    },
    model: null,
    attempt: 1,
    threadId: "synthetic",
    observations: [
      {
        id: "o1",
        kind: "context",
        source: { ...scope, cursor: 1 },
        conversation: 1,
        text: fixture.record,
        inputId: null,
        taskId: null,
        supersedes: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    history: [],
    omitted: 1,
    intent: null,
    commit: null,
  });
  return {
    run,
    prompt: buildPonderPrompt(policy, {
      observations: run.observations,
      history: run.history,
      omitted: run.omitted,
    }),
  };
});
export function gradePonderCase(run: PonderRun, output: unknown, kind: (typeof Case.Type)["kind"]) {
  try {
    const result = decodeResult(output);
    validatePromotion(run, result);
    return kind === null
      ? result.disposition === "no-change"
      : result.entries.some((entry) => entry.kind === kind);
  } catch {
    return false;
  }
}
const main = Effect.gen(function* () {
  const flags = process.argv.slice(2);
  if (flags.length !== 1 || !["--dry-run", "--context"].includes(flags[0]!))
    return yield* Effect.die(
      "Only --dry-run or --context is supported; no provider calls exist in this runner.",
    );
  for (const fixture of yield* loadPonderCases) {
    const request = yield* ponderCase(fixture);
    yield* Console.log(
      encodeJson({
        id: fixture.id,
        bytes: Buffer.byteLength(request.prompt),
        ...(flags[0] === "--dry-run"
          ? { prompt: request.prompt }
          : { observations: request.run.observations.length }),
      }),
    );
  }
});
if (import.meta.main) main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
