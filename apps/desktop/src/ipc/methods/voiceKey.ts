import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

class VoiceSecureStorageUnavailable extends Data.TaggedError("VoiceSecureStorageUnavailable")<{
  readonly message: string;
}> {}

const requireEncryption = Effect.fn("desktop.voice.requireEncryption")(function* () {
  const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const backend = yield* storage.selectedStorageBackend;
  if (!(yield* storage.isEncryptionAvailable) || Option.getOrNull(backend) === "basic_text")
    return yield* new VoiceSecureStorageUnavailable({
      message: "Device secure storage is unavailable. Unlock your keyring first.",
    });
  return storage;
});

export const encryptVoiceKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENCRYPT_VOICE_KEY_CHANNEL,
  payload: Schema.String.check(Schema.isMaxLength(4096)),
  result: Schema.String,
  handler: Effect.fn("desktop.voice.encryptKey")(function* (key) {
    const storage = yield* requireEncryption();
    return Buffer.from(yield* storage.encryptString(key)).toString("base64");
  }),
});

export const decryptVoiceKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DECRYPT_VOICE_KEY_CHANNEL,
  payload: Schema.String.check(Schema.isMaxLength(16384)),
  result: Schema.String,
  handler: Effect.fn("desktop.voice.decryptKey")(function* (encrypted) {
    const storage = yield* requireEncryption();
    return yield* storage.decryptString(Buffer.from(encrypted, "base64"));
  }),
});
