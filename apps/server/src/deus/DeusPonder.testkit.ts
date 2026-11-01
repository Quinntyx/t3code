import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Ponder from "./DeusPonderService.ts";
import * as Writer from "./DeusMemoryWriter.ts";
import * as Worker from "./DeusPonderWorker.ts";
import { ponderError } from "./ponderProtocol.ts";

export const layer = Ponder.layer.pipe(
  Layer.provideMerge(Writer.layer.pipe(Layer.provide(Git.layer))),
  Layer.provide(
    Layer.succeed(Worker.DeusPonderWorker, {
      run: () => Effect.fail(ponderError("Synthetic fixture has no learning provider.")),
    }),
  ),
);
