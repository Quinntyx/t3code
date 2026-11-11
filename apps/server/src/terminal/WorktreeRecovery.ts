import {
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  type TerminalOpenInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const makeRecoverMissingWorktree = <E>(dependencies: {
  readonly getThreadWorkspace: (threadId: string) => Effect.Effect<
    {
      readonly workspaceRoot: string;
      readonly worktreePath: string | null;
      readonly branch: string | null;
    } | null,
    E
  >;
  readonly isManagedWorktreePath: (path: string) => Effect.Effect<boolean>;
  readonly git: Pick<
    GitVcsDriver.GitVcsDriver["Service"],
    "execute" | "pruneWorktrees" | "createWorktree"
  >;
}) =>
  Effect.fn("terminal.recoverMissingWorktree")(function* (input: TerminalOpenInput) {
    const workspace = yield* dependencies
      .getThreadWorkspace(input.threadId)
      .pipe(Effect.mapError((cause) => new TerminalCwdStatError({ cwd: input.cwd, cause })));
    if (
      !workspace?.branch ||
      workspace.worktreePath !== input.cwd ||
      (input.worktreePath != null && input.worktreePath !== workspace.worktreePath) ||
      !(yield* dependencies.isManagedWorktreePath(workspace.worktreePath))
    ) {
      return yield* new TerminalCwdNotFoundError({ cwd: input.cwd });
    }
    yield* dependencies.git
      .execute({
        cwd: workspace.workspaceRoot,
        operation: "terminal.verifyRecoveryBranch",
        args: ["show-ref", "--verify", `refs/heads/${workspace.branch}`],
      })
      .pipe(
        Effect.andThen(dependencies.git.pruneWorktrees({ cwd: workspace.workspaceRoot })),
        Effect.andThen(
          dependencies.git.createWorktree({
            cwd: workspace.workspaceRoot,
            refName: workspace.branch,
            path: workspace.worktreePath,
          }),
        ),
        Effect.mapError((cause) => new TerminalCwdStatError({ cwd: input.cwd, cause })),
      );
  });
