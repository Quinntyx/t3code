import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { buddyCatalogEntries, buddyClipPath } from "./BuddySourceService.ts";

const makeManifest = (id = "hero") => ({
  schemaVersion: 1,
  id,
  name: id === "hero" ? "Hero" : id,
  description: "A buddy",
  author: "Tester",
  license: "MIT",
  aspectRatio: 1,
  clips: { idle: "idle.webm" },
});

const services = ServerConfig.layerTest(process.cwd(), { prefix: "t3-buddy-service-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "scans both direct buddy folders and parent folders with mismatched directory names",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;

      const singleDir = path.join(config.baseDir, "single-buddy");
      yield* fs.makeDirectory(singleDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(singleDir, "buddy.json"),
        JSON.stringify(makeManifest("solo")),
      );
      yield* fs.writeFileString(path.join(singleDir, "idle.webm"), "solo-clip");

      const collectionDir = path.join(config.baseDir, "collection");
      const renamedSubdir = path.join(collectionDir, "custom-folder-name");
      yield* fs.makeDirectory(renamedSubdir, { recursive: true });
      yield* fs.writeFileString(
        path.join(renamedSubdir, "buddy.json"),
        JSON.stringify(makeManifest("hero")),
      );
      yield* fs.writeFileString(path.join(renamedSubdir, "idle.webm"), "hero-clip");

      const configuredFolders = [singleDir, collectionDir];
      const entries = yield* buddyCatalogEntries(configuredFolders);

      expect(entries).toEqual([
        {
          folderPath: singleDir,
          buddies: [
            {
              id: "solo",
              name: "solo",
              description: "A buddy",
              author: "Tester",
              license: "MIT",
              aspectRatio: 1,
              clips: { idle: "idle.webm" },
            },
          ],
          error: null,
        },
        {
          folderPath: collectionDir,
          buddies: [
            {
              id: "hero",
              name: "Hero",
              description: "A buddy",
              author: "Tester",
              license: "MIT",
              aspectRatio: 1,
              clips: { idle: "idle.webm" },
            },
          ],
          error: null,
        },
      ]);

      const soloClip = yield* buddyClipPath({
        configuredFolders,
        folderPath: singleDir,
        buddyId: "solo",
        file: "idle.webm",
      });
      expect(soloClip).toBe(yield* fs.realPath(path.join(singleDir, "idle.webm")));

      const heroClip = yield* buddyClipPath({
        configuredFolders,
        folderPath: collectionDir,
        buddyId: "hero",
        file: "idle.webm",
      });
      expect(heroClip).toBe(yield* fs.realPath(path.join(renamedSubdir, "idle.webm")));
    }).pipe(Effect.provide(services)),
);

it.effect("expands ~/ relative to HostProcess.HomeDirectory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const homeDir = path.join(config.baseDir, "home");
    const buddyDir = path.join(homeDir, "my-buddies");
    yield* fs.makeDirectory(buddyDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(buddyDir, "buddy.json"),
      JSON.stringify(makeManifest("home-pet")),
    );
    yield* fs.writeFileString(path.join(buddyDir, "idle.webm"), "clip");

    const entries = yield* buddyCatalogEntries(["~/my-buddies"]).pipe(
      Effect.provideService(HostProcess.HomeDirectory, homeDir),
    );
    expect(entries[0]?.error).toBeNull();
    expect(entries[0]?.buddies.map((buddy) => buddy.id)).toEqual(["home-pet"]);
  }).pipe(Effect.provide(services)),
);

it.effect("refuses clips from unconfigured folders, undeclared files, and escaping symlinks", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;

    const folder = path.join(config.baseDir, "buddies");
    const buddyDir = path.join(folder, "hero");
    yield* fs.makeDirectory(buddyDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(buddyDir, "buddy.json"),
      JSON.stringify(makeManifest("hero")),
    );
    yield* fs.writeFileString(path.join(buddyDir, "idle.webm"), "clip");
    yield* fs.writeFileString(path.join(buddyDir, "undeclared.webm"), "hidden");

    // Folder not in configuredFolders is rejected.
    expect(
      yield* buddyClipPath({
        configuredFolders: [],
        folderPath: folder,
        buddyId: "hero",
        file: "idle.webm",
      }),
    ).toBeNull();

    // Undeclared .webm file in the same folder is rejected.
    expect(
      yield* buddyClipPath({
        configuredFolders: [folder],
        folderPath: folder,
        buddyId: "hero",
        file: "undeclared.webm",
      }),
    ).toBeNull();

    // Symlinked clip pointing outside the configured folder is rejected.
    const outsideClip = path.join(config.baseDir, "secret.webm");
    yield* fs.writeFileString(outsideClip, "secret");
    yield* fs.remove(path.join(buddyDir, "idle.webm"));
    yield* fs.symlink(outsideClip, path.join(buddyDir, "idle.webm"));

    expect(
      yield* buddyClipPath({
        configuredFolders: [folder],
        folderPath: folder,
        buddyId: "hero",
        file: "idle.webm",
      }),
    ).toBeNull();

    // Symlinked manifest pointing outside the configured folder is skipped.
    const outsideDir = path.join(config.baseDir, "outside");
    yield* fs.makeDirectory(outsideDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(outsideDir, "buddy.json"),
      JSON.stringify(makeManifest("escaped")),
    );
    yield* fs.remove(path.join(buddyDir, "buddy.json"));
    yield* fs.symlink(path.join(outsideDir, "buddy.json"), path.join(buddyDir, "buddy.json"));

    const entries = yield* buddyCatalogEntries([folder]);
    expect(entries[0]?.buddies).toEqual([]);
  }).pipe(Effect.provide(services)),
);

it.effect("reports missing folders cleanly without hiding healthy folders", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;

    const healthy = path.join(config.baseDir, "healthy");
    const missing = path.join(config.baseDir, "missing");
    yield* fs.makeDirectory(healthy, { recursive: true });
    yield* fs.writeFileString(path.join(healthy, "buddy.json"), JSON.stringify(makeManifest("ok")));
    yield* fs.writeFileString(path.join(healthy, "idle.webm"), "clip");

    const entries = yield* buddyCatalogEntries([missing, healthy]);
    expect(entries[0]?.buddies).toEqual([]);
    expect(entries[0]?.error).not.toBeNull();
    expect(entries[1]?.error).toBeNull();
    expect(entries[1]?.buddies.map((buddy) => buddy.id)).toEqual(["ok"]);
  }).pipe(Effect.provide(services)),
);
