import {
  type DeusSettings,
  type DeusSettingsPatch,
  type ProjectId,
  type SecretRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Requests from "../secrets/SecretRequests.ts";
import * as Settings from "../serverSettings.ts";
import { DeusTextError } from "./textProtocol.ts";

const credentialName = "deus-google-api-key";
export class DeusConfiguration extends Context.Service<
  DeusConfiguration,
  {
    readonly status: Effect.Effect<
      { readonly settings: DeusSettings; readonly credentialPresent: boolean },
      DeusTextError
    >;
    readonly update: (patch: DeusSettingsPatch) => Effect.Effect<void, DeusTextError>;
    readonly setCredential: (input: {
      readonly secretRef: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<void, DeusTextError, Requests.SecretRequests>;
    readonly removeCredential: Effect.Effect<void, DeusTextError>;
    readonly withTextCredential: <A, E>(
      use: (model: string, key: string) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | DeusTextError>;
  }
>()("t3/deus/DeusConfiguration") {}
const configurationError = () => new DeusTextError({ code: "configuration" });
const make = Effect.gen(function* () {
  const store = yield* Secrets.ServerSecretStore;
  const settings = yield* Settings.ServerSettingsService;
  const read = store.get(credentialName).pipe(Effect.mapError(configurationError));
  return DeusConfiguration.of({
    status: Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(Effect.mapError(configurationError));
      return { settings: current.deus, credentialPresent: Option.isSome(yield* read) };
    }),
    update: Effect.fn("DeusConfiguration.update")((deus) =>
      settings.updateSettings({ deus }).pipe(Effect.asVoid, Effect.mapError(configurationError)),
    ),
    setCredential: Effect.fn("DeusConfiguration.setCredential")(function* (input) {
      const requests = yield* Requests.SecretRequests;
      const key = yield* requests
        .consume({ ref: input.secretRef, projectId: input.projectId })
        .pipe(Effect.mapError(configurationError));
      if (!key.trim() || key.length > 4096) return yield* configurationError();
      yield* store
        .set(credentialName, new TextEncoder().encode(key.trim()))
        .pipe(Effect.mapError(configurationError));
    }),
    removeCredential: store.remove(credentialName).pipe(Effect.mapError(configurationError)),
    withTextCredential: Effect.fn("DeusConfiguration.withTextCredential")(function* <A, E>(
      use: (model: string, key: string) => Effect.Effect<A, E>,
    ) {
      const current = (yield* settings.getSettings.pipe(Effect.mapError(configurationError))).deus;
      if (!current.enabled || !current.textModel) return yield* configurationError();
      const key = yield* read;
      if (Option.isNone(key) || key.value.byteLength === 0) return yield* configurationError();
      return yield* use(current.textModel, new TextDecoder().decode(key.value));
    }),
  });
});
export const layer = Layer.effect(DeusConfiguration, make);
