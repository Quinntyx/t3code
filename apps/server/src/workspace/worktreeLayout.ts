import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const makeResolveMainCheckout = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return Effect.fn("worktreeLayout.resolveMainCheckout")(function* (workspaceRoot: string) {
    const main = path.join(workspaceRoot, "main");
    const gitEntry = yield* fs.stat(path.join(main, ".git")).pipe(Effect.orElseSucceed(() => null));
    if (gitEntry?.type !== "Directory" && gitEntry?.type !== "File") return workspaceRoot;

    // A folder holding sibling standalone git repositories is a multi-repo workspace, not a
    // single-repo worktree container (where sibling worktrees have a `.git` file, not directory).
    const entries = yield* fs
      .readDirectory(workspaceRoot)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of entries) {
      if (entry === "main") continue;
      const siblingGit = yield* fs
        .stat(path.join(workspaceRoot, entry, ".git"))
        .pipe(Effect.orElseSucceed(() => null));
      if (siblingGit?.type === "Directory") return workspaceRoot;
    }

    // A main/ child inside an existing repository is not a worktree container.
    let ancestor = yield* fs
      .realPath(workspaceRoot)
      .pipe(Effect.orElseSucceed(() => workspaceRoot));
    for (;;) {
      if (yield* fs.exists(path.join(ancestor, ".git")).pipe(Effect.orElseSucceed(() => true))) {
        return workspaceRoot;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return main;
      ancestor = parent;
    }
  });
});
