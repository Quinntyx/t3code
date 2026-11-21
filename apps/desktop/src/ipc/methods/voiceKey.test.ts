import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { vi } from "vite-plus/test";
vi.mock("electron", () => ({}));
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import { decryptVoiceKey, encryptVoiceKey } from "./voiceKey.ts";

it.effect("encrypts device keys through the OS backend and decodes the IPC ciphertext", () => {
  const service = ElectronSafeStorage.ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.succeed(true),
    selectedStorageBackend: Effect.succeedSome("gnome_libsecret"),
    encryptString: (key) => {
      assert.equal(key, "fake-key");
      return Effect.succeed(new TextEncoder().encode("opaque"));
    },
    decryptString: (ciphertext) => {
      assert.equal(new TextDecoder().decode(ciphertext), "opaque");
      return Effect.succeed("fake-key");
    },
  });
  return Effect.gen(function* () {
    const ciphertext = yield* encryptVoiceKey.handler("fake-key");
    assert.equal(ciphertext, Buffer.from("opaque").toString("base64"));
    assert.equal(yield* decryptVoiceKey.handler(ciphertext), "fake-key");
  }).pipe(Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, service));
});

it.effect("refuses plaintext or unavailable keyrings before touching the key", () =>
  Effect.gen(function* () {
    for (const backend of ["basic_text", "locked"]) {
      const service = ElectronSafeStorage.ElectronSafeStorage.of({
        isEncryptionAvailable: Effect.succeed(backend !== "locked"),
        selectedStorageBackend: Effect.succeedSome(backend),
        encryptString: () => Effect.die("must not encrypt without a secure keyring"),
        decryptString: () => Effect.die("must not decrypt without a secure keyring"),
      });
      const encryption = yield* encryptVoiceKey
        .handler("fake-key")
        .pipe(Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, service), Effect.exit);
      const decryption = yield* decryptVoiceKey
        .handler("ciphertext")
        .pipe(Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, service), Effect.exit);
      assert.equal(encryption._tag, "Failure");
      assert.equal(decryption._tag, "Failure");
      if (encryption._tag === "Failure")
        assert.match(Cause.pretty(encryption.cause), /VoiceSecureStorageUnavailable/);
      if (decryption._tag === "Failure")
        assert.match(Cause.pretty(decryption.cause), /VoiceSecureStorageUnavailable/);
    }
  }),
);
