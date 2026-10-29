import { DeusSessionRef, type RuntimeMode, type ProviderInteractionMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class DeusAuthorityError extends Schema.TaggedError<DeusAuthorityError>()(
  "DeusAuthorityError",
  {
    reason: Schema.Literals(["inactive", "mode-limit", "worktree-not-authorized"]),
  },
) {}

export class DeusAuthority extends Context.Service<
  DeusAuthority,
  {
    readonly authorize: (input: DeusSessionRef) => Effect.Effect<
      {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
        readonly allowWorktree: boolean;
      },
      DeusAuthorityError
    >;
  }
>()("t3/deus/DeusAuthority") {}

// Until a human transport owns renewable authority, persisted intents cannot authorize execution.
export const layerUnavailable = Layer.succeed(DeusAuthority, {
  authorize: Effect.fn("DeusAuthority.authorize")(() =>
    Effect.fail(new DeusAuthorityError({ reason: "inactive" })),
  ),
});
