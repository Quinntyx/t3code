import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));

import * as MobileDatabase from "./mobile-database";
import * as MobileSecureStorage from "./mobile-secure-storage";
import * as MobilePreferences from "./mobile-preferences";

function fixture(payload?: unknown) {
  let stored: MobileDatabase.StoredPreferencesJson | undefined =
    payload === undefined ? undefined : { payload: JSON.stringify(payload), updatedAt: 1 };
  const database = MobileDatabase.MobileDatabase.of({
    loadCache: () => Effect.succeed(Option.none()),
    listCache: () => Effect.succeed([]),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.sync(() => Option.fromNullishOr(stored)),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.sync(() => {
        stored = { payload, updatedAt };
      }),
  });
  const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: () => Effect.succeed(null),
    setItem: () => Effect.void,
    removeItem: () => Effect.void,
  });
  return Effect.gen(function* () {
    return yield* MobilePreferences.MobilePreferencesStore;
  }).pipe(
    Effect.provide(
      MobilePreferences.layer.pipe(
        Layer.provide(Layer.succeed(MobileDatabase.MobileDatabase, database)),
        Layer.provide(Layer.succeed(MobileSecureStorage.MobileSecureStorage, secureStorage)),
      ),
    ),
  );
}

it.effect(
  "persists hidden thread keys across store instances and preserves unrelated preferences",
  () =>
    Effect.gen(function* () {
      const makeStore = fixture();
      const store = yield* makeStore;
      yield* store.savePatch({ baseFontSize: 18, hiddenThreadKeys: ["first:same", "second:same"] });
      const reloaded = yield* makeStore;
      expect(yield* reloaded.load).toEqual({
        baseFontSize: 18,
        hiddenThreadKeys: ["first:same", "second:same"],
      });
      yield* reloaded.savePatch({ uiFontId: "system", codeFontId: null });
      expect(yield* (yield* makeStore).load).toMatchObject({
        uiFontId: "system",
        codeFontId: null,
      });
      yield* reloaded.savePatch({ uiFontId: undefined, codeFontId: undefined });
      yield* reloaded.update((current) => ({
        hiddenThreadKeys: current.hiddenThreadKeys?.filter((key) => key !== "first:same"),
      }));
      expect(yield* store.load).toEqual({ baseFontSize: 18, hiddenThreadKeys: ["second:same"] });
      yield* reloaded.savePatch({ hiddenThreadKeys: [] });
      expect(yield* store.load).toEqual({ baseFontSize: 18, hiddenThreadKeys: [] });
    }),
);

it.effect("reads older preferences without hidden keys and sanitizes stored values", () =>
  Effect.gen(function* () {
    const oldStore = yield* fixture({ baseFontSize: 18 });
    expect(yield* oldStore.load).toEqual({ baseFontSize: 18 });
    const store = yield* fixture({
      baseFontSize: 18,
      hiddenThreadKeys: ["first:same", false, null, "", "first:same", "second:same"],
      liquidGlassEnabled: true,
      glassOpacity: 20,
      liquidGlassBlur: 4,
      liquidGlassSaturation: 250,
      liquidGlassRefraction: 12.5,
      liquidGlassDispersion: "100",
    });
    expect(yield* store.load).toEqual({
      baseFontSize: 18,
      hiddenThreadKeys: ["first:same", "second:same"],
      liquidGlassEnabled: true,
      liquidGlassBlur: 4,
    });
  }),
);
