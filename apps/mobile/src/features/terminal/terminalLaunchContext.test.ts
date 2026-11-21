import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  resolveTerminalOpenLocation,
  stageCommandTerminalLaunch,
  stagePendingTerminalLaunch,
  takePendingTerminalLaunch,
} from "./terminalLaunchContext";

describe("resolveTerminalOpenLocation", () => {
  it("preserves the running terminal snapshot cwd when attaching to an existing session", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: {
          cwd: "/repo/worktrees/feature",
          worktreePath: "/repo/worktrees/feature",
        },
        workspaceRoot: "/repo/root",
        threadShellWorktreePath: null,
        threadDetailWorktreePath: "/repo/worktrees/other",
      }),
    ).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
    });
  });

  it("preserves checkout cwd and identity from the selected terminal or active session", () => {
    const checkout = { cwd: "/repo/root/packages/app", worktreePath: null };
    const threadLocation = {
      workspaceRoot: "/repo/root",
      threadShellWorktreePath: "/repo/worktrees/feature",
      threadDetailWorktreePath: "/repo/worktrees/feature",
    };

    expect(
      resolveTerminalOpenLocation({
        ...threadLocation,
        terminalLocation: checkout,
        activeSessionLocation: {
          cwd: "/repo/worktrees/other",
          worktreePath: "/repo/worktrees/other",
        },
      }),
    ).toEqual(checkout);

    expect(
      resolveTerminalOpenLocation({
        ...threadLocation,
        terminalLocation: null,
        activeSessionLocation: checkout,
      }),
    ).toEqual(checkout);
  });
});

describe("command terminal launches", () => {
  it("stages a command in the detail worktree with the project runtime environment", () => {
    const target = {
      environmentId: EnvironmentId.make("env-command"),
      threadId: ThreadId.make("thread-command"),
      terminalId: "term-follow-worktree",
    };
    const launch = stageCommandTerminalLaunch({
      target,
      workspaceRoot: "/repo/root",
      threadShellWorktreePath: "/repo/worktrees/stale",
      threadDetailWorktreePath: "/repo/worktrees/feature",
      command: "tail -n +1 -F '/tmp/task.output'",
    });

    expect(launch).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
      env: {
        T3CODE_PROJECT_ROOT: "/repo/root",
        T3CODE_WORKTREE_PATH: "/repo/worktrees/feature",
      },
      initialInput: " tail -n +1 -F '/tmp/task.output'\r",
    });
    expect(takePendingTerminalLaunch(target)).toEqual(launch);
    expect(takePendingTerminalLaunch(target)).toBeNull();
  });

  it("falls back to the shell worktree and then the project checkout", () => {
    for (const worktreePath of ["/repo/worktrees/feature", null]) {
      const target = {
        environmentId: EnvironmentId.make("env-command"),
        threadId: ThreadId.make("thread-command"),
        terminalId: worktreePath === null ? "term-project" : "term-shell-worktree",
      };
      stageCommandTerminalLaunch({
        target,
        workspaceRoot: "/repo/root",
        threadShellWorktreePath: worktreePath,
        threadDetailWorktreePath: null,
        command: "printf 'hello'",
      });

      expect(takePendingTerminalLaunch(target)).toEqual({
        cwd: worktreePath ?? "/repo/root",
        worktreePath,
        env: {
          T3CODE_PROJECT_ROOT: "/repo/root",
          ...(worktreePath ? { T3CODE_WORKTREE_PATH: worktreePath } : {}),
        },
        initialInput: " printf 'hello'\r",
      });
    }
  });
});

describe("pending terminal launches", () => {
  it("stages and consumes launch details for a specific terminal target", () => {
    const target = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };

    stagePendingTerminalLaunch({
      target,
      launch: {
        cwd: "/repo/worktrees/feature",
        worktreePath: "/repo/worktrees/feature",
        env: { FOO: "bar" },
        initialInput: "pnpm dev\r",
      },
    });

    expect(takePendingTerminalLaunch(target)).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
      env: { FOO: "bar" },
      initialInput: "pnpm dev\r",
    });
    expect(takePendingTerminalLaunch(target)).toBeNull();
  });
});
