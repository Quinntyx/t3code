import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { setClientSettings } from "./clientSettings.ts";

const makeLayer = (input: {
  readonly platform: NodeJS.Platform;
  readonly initialSettings: ClientSettings;
  readonly recreateCount: Ref.Ref<number>;
}) =>
  Layer.mergeAll(
    DesktopClientSettings.layerTest(Option.some(input.initialSettings)),
    Layer.mock(DesktopSnapShot.DesktopSnapShot)({ configure: () => Effect.void }),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform: input.platform,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.mock(DesktopWindow.DesktopWindow)({
      recreateMain: Ref.update(input.recreateCount, (count) => count + 1),
    }),
  );

const setWindowControlsHidden = (hidden: boolean) =>
  setClientSettings.handler({ ...DEFAULT_CLIENT_SETTINGS, hideWindowControls: hidden });

it.effect("rebuilds the window when window controls change on Linux", () =>
  Effect.gen(function* () {
    const recreateCount = yield* Ref.make(0);
    yield* setWindowControlsHidden(true).pipe(
      Effect.provide(
        makeLayer({
          platform: "linux",
          initialSettings: DEFAULT_CLIENT_SETTINGS,
          recreateCount,
        }),
      ),
    );
    expect(yield* Ref.get(recreateCount)).toBe(1);
  }),
);

it.effect("keeps the window when window controls do not change", () =>
  Effect.gen(function* () {
    const recreateCount = yield* Ref.make(0);
    yield* setWindowControlsHidden(true).pipe(
      Effect.provide(
        makeLayer({
          platform: "linux",
          initialSettings: { ...DEFAULT_CLIENT_SETTINGS, hideWindowControls: true },
          recreateCount,
        }),
      ),
    );
    expect(yield* Ref.get(recreateCount)).toBe(0);
  }),
);

it.effect("keeps the macOS window for the next launch", () =>
  Effect.gen(function* () {
    const recreateCount = yield* Ref.make(0);
    yield* setWindowControlsHidden(true).pipe(
      Effect.provide(
        makeLayer({
          platform: "darwin",
          initialSettings: DEFAULT_CLIENT_SETTINGS,
          recreateCount,
        }),
      ),
    );
    expect(yield* Ref.get(recreateCount)).toBe(0);
  }),
);
