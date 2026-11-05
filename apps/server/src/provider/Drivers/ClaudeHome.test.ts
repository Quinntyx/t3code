import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readClaudeSettingsBaseUrl } from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("readClaudeSettingsBaseUrl", (it) => {
  const withHome = (
    contents: string | null,
    read: (
      homePath: string,
    ) => Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
      if (contents !== null) {
        yield* fs.writeFileString(path.join(home, "settings.json"), contents);
      }
      return yield* read(home);
    }).pipe(Effect.scoped);

  it.effect("reads the base URL the CLI would use", () =>
    withHome('{"env":{"ANTHROPIC_BASE_URL":"http://proxy.example:8317"}}', (homePath) =>
      readClaudeSettingsBaseUrl({ homePath }),
    ).pipe(
      Effect.tap((baseUrl) =>
        Effect.sync(() => assert.strictEqual(baseUrl, "http://proxy.example:8317")),
      ),
    ),
  );

  it.effect("reports no endpoint without a settings file or a base URL", () =>
    Effect.gen(function* () {
      assert.isUndefined(
        yield* withHome(null, (homePath) => readClaudeSettingsBaseUrl({ homePath })),
      );
      assert.isUndefined(
        yield* withHome('{"env":{}}', (homePath) => readClaudeSettingsBaseUrl({ homePath })),
      );
    }),
  );

  it.effect("ignores a malformed settings file instead of failing the probe", () =>
    withHome("{ not json", (homePath) => readClaudeSettingsBaseUrl({ homePath })).pipe(
      Effect.tap((baseUrl) => Effect.sync(() => assert.isUndefined(baseUrl))),
    ),
  );
});
