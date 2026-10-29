import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { type ChatAttachment, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObjectCandidates, parseLenientJson } from "@t3tools/shared/schemaJson";

import type { ProviderTextGeneration } from "./textGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildReviewGuidePrompt,
  buildThreadTitlePrompt,
} from "./textGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

export type Operation = keyof ProviderTextGeneration;

export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** Investigate cwd with read-only tools across turns; fail if the runner cannot guarantee read-only access. */
  readonly investigate?: { readonly timeoutMs: number } | undefined;
}

const INVESTIGATION_TIMEOUT_MS = 15 * 60_000;

export const investigationUnsupported = (operation: Operation, provider: string) =>
  new TextGenerationError({
    operation,
    detail: `${provider} cannot investigate a checkout read-only. Choose another review guide model, or source control writer model when none is set.`,
  });

export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

export const withoutInvestigation =
  (provider: string, run: Runner): Runner =>
  (request) =>
    request.investigate
      ? Effect.fail(investigationUnsupported(request.operation, provider))
      : run(request);

export interface InvalidStructuredOutput {
  /** One-line explanation for the error toast. */
  readonly reason: string;
  readonly cause?: unknown;
}

const REASON_MAX_CHARS = 200;

const describeShapeFailure = (cause: unknown): string => {
  const message =
    typeof cause === "object" && cause !== null && "message" in cause
      ? (cause as { message: unknown }).message
      : undefined;
  const compact = typeof message === "string" ? message.replace(/\s+/g, " ").trim() : "";
  return compact.length > 0 ? compact.slice(0, REASON_MAX_CHARS) : "the shape did not match";
};

const parseCandidate = (candidate: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(candidate) as unknown };
  } catch {
    const lenient = parseLenientJson(candidate);
    return Result.isSuccess(lenient) ? { value: lenient.success } : undefined;
  }
};

export const decodeJsonReplyDetailed = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  text: string,
): Effect.Effect<S["Type"], InvalidStructuredOutput, S["DecodingServices"]> =>
  // Effect.suspend keeps the generic on this function; Effect.fn would erase S.
  Effect.suspend(() =>
    Effect.gen(function* () {
      const reply = text.trim();
      if (reply.length === 0) {
        return yield* Effect.fail({ reason: "the reply was empty" });
      }

      // Try the last object first, since a model that corrects itself repeats the answer at the end.
      const { complete, truncated } = extractJsonObjectCandidates(reply);
      const decode = Schema.decodeUnknownEffect(request.outputSchema);
      let shapeFailure: InvalidStructuredOutput | undefined;

      for (const candidate of complete) {
        const parsed = parseCandidate(candidate);
        if (parsed === undefined) continue;
        const decoded = yield* Effect.result(decode(parsed.value));
        if (decoded._tag === "Success") return decoded.success;
        shapeFailure ??= {
          reason: `the JSON did not match the expected shape (${describeShapeFailure(decoded.failure)})`,
          cause: decoded.failure,
        };
      }

      if (shapeFailure !== undefined) return yield* Effect.fail(shapeFailure);
      if (truncated !== undefined) {
        return yield* Effect.fail({
          reason: `the JSON object was unterminated after ${reply.length} characters, so the reply was likely truncated`,
        });
      }
      return yield* Effect.fail({ reason: "the reply contained no JSON object" });
    }),
  );

export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) =>
  decodeJsonReplyDetailed(request, text).pipe(
    Effect.mapError(
      (failure) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output: ${failure.reason}.`,
          cause: failure.cause,
        }),
    ),
  );

export function fromRunner(name: string, run: Runner): ProviderTextGeneration {
  const generateCommitMessage: ProviderTextGeneration["generateCommitMessage"] = Effect.fn(
    `${name}.generateCommitMessage`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      }),
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: ProviderTextGeneration["generatePrContent"] = Effect.fn(
    `${name}.generatePrContent`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generatePrContent",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
        threadContext: input.threadContext,
      }),
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: ProviderTextGeneration["generateBranchName"] = Effect.fn(
    `${name}.generateBranchName`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateBranchName",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      }),
    });
    return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
  });

  const generateThreadTitle: ProviderTextGeneration["generateThreadTitle"] = Effect.fn(
    `${name}.generateThreadTitle`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        forkSource: input.forkSource,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
        instructions: input.instructions,
      }),
    });
    return {
      title: sanitizeThreadTitle(generated.title),
      ...(generated.needsRefinement ? { needsRefinement: true } : {}),
    };
  });

  const generateReviewGuide: ProviderTextGeneration["generateReviewGuide"] = Effect.fn(
    `${name}.generateReviewGuide`,
  )(function* (input) {
    return yield* run({
      operation: "generateReviewGuide",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      investigate: { timeoutMs: INVESTIGATION_TIMEOUT_MS },
      ...buildReviewGuidePrompt(input),
    });
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateReviewGuide,
  } satisfies ProviderTextGeneration;
}
