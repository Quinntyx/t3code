import {
  GitRestackError,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  WorktreeMcpFailure,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Project from "../../../project/ProjectService.ts";
import * as PullRequestStackService from "../../../pullRequest/PullRequestStackService.ts";
import { assertSameLink } from "../../linkOrigin.ts";
import {
  assertTargetWithinLimits,
  loadCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import { WorktreeToolkit } from "./tools.ts";

const handlers = {
  t3_worktree_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* McpInvocationContext.McpInvocationContext;
      if (!context.capabilities.has("worktree"))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential cannot inspect worktrees.",
        });
      const { threadId, ...refs } = input;
      const {
        projection: { thread },
      } = yield* readThread(threadId);
      const projects = yield* Project.ProjectService;
      const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service
        .listRefs({
          ...refs,
          worktreePath: thread.worktreePath,
          workspaceRoot: project.value.workspaceRoot,
        })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_worktree_handoff: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service.handoff(scope, input);
    }),
  ),
  t3_worktree_restack: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.thread === undefined || !scope.capabilities.has("worktree")) {
        return yield* new WorktreeMcpFailure({
          code: "capability_denied",
          message: "This credential cannot restack worktrees.",
        });
      }
      const caller = yield* loadCaller().pipe(
        Effect.mapError(
          (error) => new WorktreeMcpFailure({ code: "capability_denied", message: error.message }),
        ),
      );
      if (caller.caller === undefined || caller.caller.interactionMode === "plan") {
        return yield* new WorktreeMcpFailure({
          code: "capability_denied",
          message: "A plan-mode thread cannot restack worktrees.",
        });
      }
      const stacks = yield* PullRequestStackService.PullRequestStackService;
      const authorizeTarget = Effect.fn("t3_worktree_restack.authorizeTarget")(function* (
        target: OrchestrationV2ThreadShell,
      ) {
        yield* Effect.suspend(() => assertTargetWithinLimits(caller.limits, target)).pipe(
          Effect.mapError(
            (error) => new GitRestackError({ threadId: target.id, detail: error.message }),
          ),
        );
        yield* Effect.suspend(() => assertSameLink(caller, target)).pipe(
          Effect.mapError(
            (error) => new GitRestackError({ threadId: target.id, detail: error.message }),
          ),
        );
      });
      return yield* stacks
        .restackDependents({
          threadId: scope.thread.threadId,
          authorizeTarget,
        })
        .pipe(
          Effect.mapError(
            (error) => new WorktreeMcpFailure({ code: "operation_failed", message: error.detail }),
          ),
        );
    }),
  ),
  t3_worktree_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service.status(scope);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof WorktreeToolkit.tools>;

export const layer = McpToolAccess.toLayer(WorktreeToolkit, handlers);
