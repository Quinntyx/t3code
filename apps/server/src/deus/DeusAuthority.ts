import {
  DeusSessionRef,
  type DeusInputId,
  type DeusAttachmentId,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class DeusAuthorityError extends Schema.TaggedError<DeusAuthorityError>()(
  "DeusAuthorityError",
  {
    reason: Schema.Literals(["inactive", "mode-limit", "worktree-not-authorized", "capacity"]),
  },
) {}

export type DeusAuthorityRef = DeusSessionRef & {
  readonly inputId?: DeusInputId;
  readonly attachmentId?: DeusAttachmentId;
  readonly origin?: { readonly attachmentId: DeusAttachmentId };
};

export class DeusActionSource extends Context.Reference<DeusAuthorityRef | undefined>(
  "t3/deus/DeusActionSource",
  { defaultValue: () => undefined },
) {}

export class DeusAuthority extends Context.Service<
  DeusAuthority,
  {
    readonly authorize: (input: DeusAuthorityRef) => Effect.Effect<
      {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
        readonly allowWorktree: boolean;
      },
      DeusAuthorityError
    >;
  }
>()("t3/deus/DeusAuthority") {}
