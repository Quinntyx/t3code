import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { SWAP_SCRIPT } from "./MacBundleSwap.ts";

// No process ever has this id, so the script's wait for the app to exit ends at once.
const EXITED_PID = "2147483646";

const runSwap = Effect.fn("runSwap")(function* (options: { readonly updateUnpacked: boolean }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bundle-swap-" });
  const current = path.join(root, "T3 Code.app");
  const stage = path.join(root, ".t3code-update-1");
  const next = path.join(stage, "T3 Code.app");
  const opened = path.join(root, "opened");
  const bin = path.join(root, "bin");

  yield* fs.makeDirectory(current);
  yield* fs.writeFileString(path.join(current, "version"), "old");
  yield* fs.makeDirectory(stage);
  if (options.updateUnpacked) {
    yield* fs.makeDirectory(next);
    yield* fs.writeFileString(path.join(next, "version"), "new");
  }
  yield* fs.makeDirectory(bin);
  yield* fs.writeFileString(path.join(bin, "open"), `#!/bin/sh\nprintf %s "$1" > "$OPENED"\n`);
  yield* fs.chmod(path.join(bin, "open"), 0o755);

  const child = yield* spawner.spawn(
    ChildProcess.make("sh", ["-c", SWAP_SCRIPT, "sh", EXITED_PID, current, next, stage], {
      env: { PATH: `${bin}:/usr/bin:/bin`, OPENED: opened },
    }),
  );
  yield* child.exitCode;

  return {
    installed: yield* fs.readFileString(path.join(current, "version")),
    relaunched: (yield* fs.readFileString(opened)) === current,
    stageLeft: yield* fs.exists(stage),
  };
}, Effect.scoped);

it.live("replaces the bundle with the unpacked update and relaunches it", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* runSwap({ updateUnpacked: true }), {
      installed: "new",
      relaunched: true,
      stageLeft: false,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("puts the old bundle back when the update cannot move in", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* runSwap({ updateUnpacked: false }), {
      installed: "old",
      relaunched: true,
      stageLeft: false,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
