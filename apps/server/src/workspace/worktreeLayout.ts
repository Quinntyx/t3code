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
