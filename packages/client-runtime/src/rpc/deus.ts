import { WS_METHODS, type DeusSubscriptionInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { subscribeDynamic } from "./client.ts";
export { requestGuarded as deusRequest } from "./client.ts";

export function deusMetadata(input: DeusSubscriptionInput) {
  return Stream.suspend(() => {
    let after = input.after;
    return subscribeDynamic(WS_METHODS.deusSubscribe, () =>
      Effect.succeed({ ...input, after }),
    ).pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          after = event.type === "snapshot" ? event.snapshot.cursor : event.delta.cursor;
        }),
      ),
    );
  });
}
