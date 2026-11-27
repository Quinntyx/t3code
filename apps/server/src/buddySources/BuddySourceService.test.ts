import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import {
  buddyCatalogEntries,
  buddyClipPath,
  isSupportedRepositoryUrl,
  sourceSlug,
} from "./BuddySourceService.ts";

const repositoryUrl = "https://example.com/buddies.git";

const manifest = {
  schemaVersion: 1,
  id: "hero",
  name: "Hero",
  description: "A buddy",
  author: "Tester",
  license: "MIT",
  aspectRatio: 1,
  clips: { idle: "idle.webm" },
};

const services = (clones: Ref.Ref<number>) =>
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-buddy-service-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
    Layer.mock(SourceControlRepositoryService, {
      cloneRepository: (input) =>
        Ref.update(clones, (count) => count + 1).pipe(
          Effect.as({
            cwd: input.destinationPath,
            remoteUrl: input.remoteUrl ?? repositoryUrl,
            repository: null,
          }),
        ),
      discardClone: () => Effect.void,
    }),
  );

const checkoutPaths = Effect.fnUntraced(function* (remoteUrl: string) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const root = path.join(config.baseDir, "userdata", "buddy-sources");
  const directory = path.join(root, sourceSlug(remoteUrl), "hero");
  return { config, path, root, directory };
});

const writeCheckout = Effect.fnUntraced(function* (remoteUrl: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* checkoutPaths(remoteUrl);
  yield* fs.makeDirectory(paths.directory, { recursive: true });
  yield* fs.writeFileString(`${paths.directory}/buddy.json`, JSON.stringify(manifest));
  yield* fs.writeFileString(`${paths.directory}/idle.webm`, "clip");
  return paths;
});

it.effect("rejects URLs that could escape the buddy source root", () =>
  Effect.gen(function* () {
    const clones = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      for (const unsafe of [
        "..",
        ".",
        "https://..",
        "file:///etc/passwd",
        "--upload-pack=sh",
        "/tmp/buddies",
        "git@example.com:../buddies.git",
        "https://example.com/a/../../etc/passwd",
        "https://example.com/buddies.git\n--upload-pack=sh",
      ]) {
        expect(isSupportedRepositoryUrl(unsafe)).toBe(false);
        expect(
          yield* buddyClipPath({ repositoryUrl: unsafe, buddyId: "hero", file: "idle.webm" }),
        ).toBeNull();
      }

      for (const safe of [
        "https://github.com/t3tools/buddies.git",
        "http://example.com/buddies",
        "ssh://git@github.com/t3tools/buddies.git",
        "git@github.com:t3tools/buddies.git",
      ]) {
        expect(isSupportedRepositoryUrl(safe)).toBe(true);
      }

      for (const value of ["", "..", ".", "https://..", "--upload-pack=sh"]) {
        const slug = sourceSlug(value);
        expect(slug.length).toBeGreaterThan(0);
        expect(slug).not.toBe(".");
        expect(slug).not.toBe("..");
        expect(slug.includes("/")).toBe(false);
        expect(slug.includes("\\")).toBe(false);
        expect(slug).toMatch(/^[a-zA-Z0-9._-]+-[0-9a-f]{12}$/);
      }
      // Two URLs with the same readable prefix still get separate checkouts.
      expect(sourceSlug("https://example.com/a-b")).not.toBe(sourceSlug("https://example.com/a b"));
    }).pipe(Effect.provide(services(clones)));
    expect(yield* Ref.get(clones)).toBe(0);
  }),
);

it.effect("reads existing checkouts without invoking the clone provider", () =>
  Effect.gen(function* () {
    const clones = yield* Ref.make(0);
    const entries = yield* Effect.gen(function* () {
      yield* writeCheckout(repositoryUrl);
      return yield* buddyCatalogEntries([repositoryUrl]);
    }).pipe(Effect.provide(services(clones)));
    expect(entries).toEqual([
      {
        repositoryUrl,
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
    expect(yield* Ref.get(clones)).toBe(0);
  }),
);

it.effect("reports a missing checkout in read-only mode without cloning", () =>
  Effect.gen(function* () {
    const clones = yield* Ref.make(0);
    const entries = yield* buddyCatalogEntries([repositoryUrl], { sync: false }).pipe(
      Effect.provide(services(clones)),
    );
    expect(entries[0]?.buddies).toEqual([]);
    expect(entries[0]?.error).not.toBeNull();
    expect(yield* Ref.get(clones)).toBe(0);
  }),
);

it.effect("skips manifests that symlink outside the checkout", () =>
  Effect.gen(function* () {
    const clones = yield* Ref.make(0);
    const entries = yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const paths = yield* writeCheckout(repositoryUrl);
      const outside = path.join(paths.config.baseDir, "outside");
      yield* fs.makeDirectory(outside, { recursive: true });
      yield* fs.writeFileString(path.join(outside, "buddy.json"), JSON.stringify(manifest));
      yield* fs.remove(path.join(paths.directory, "buddy.json"));
      yield* fs.symlink(path.join(outside, "buddy.json"), path.join(paths.directory, "buddy.json"));
      return yield* buddyCatalogEntries([repositoryUrl]);
    }).pipe(Effect.provide(services(clones)));
    expect(entries[0]?.buddies).toEqual([]);
    expect(yield* Ref.get(clones)).toBe(0);
  }),
);

it.effect("refuses clips that symlink outside the checkout", () =>
  Effect.gen(function* () {
    const clones = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const paths = yield* writeCheckout(repositoryUrl);

      const inside = yield* buddyClipPath({
        repositoryUrl,
        buddyId: "hero",
        file: "idle.webm",
      });
      expect(inside).not.toBeNull();

      const secret = path.join(paths.config.baseDir, "secret.webm");
      yield* fs.writeFileString(secret, "secret");
      yield* fs.remove(path.join(paths.directory, "idle.webm"));
      yield* fs.symlink(secret, path.join(paths.directory, "idle.webm"));

      const outside = yield* buddyClipPath({
        repositoryUrl,
        buddyId: "hero",
        file: "idle.webm",
      });
      expect(outside).toBeNull();
    }).pipe(Effect.provide(services(clones)));
    expect(yield* Ref.get(clones)).toBe(0);
  }),
);
