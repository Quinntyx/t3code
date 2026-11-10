import { describe, expect, it } from "vite-plus/test";
import { createVoiceStorage } from "./storage";

function localStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("device-local Voice storage", () => {
  it("keeps the browser key and model on this device", async () => {
    const storage = localStorage();
    const voice = createVoiceStorage(storage);
    expect(await voice.key.read()).toBeNull();
    expect(voice.model.read()).toBe("gemini-2.5-flash-native-audio-preview-09-2025");
    voice.model.write(" custom-live-model ");
    expect(createVoiceStorage(storage).model.read()).toBe("custom-live-model");
    voice.model.write("");
    expect(voice.model.read()).toBe("gemini-2.5-flash-native-audio-preview-09-2025");
    await voice.key.write("fake-key");
    expect(await voice.key.read()).toBe("fake-key");
    await voice.key.write("");
    expect(await voice.key.read()).toBeNull();
  });

  it("persists only ciphertext on desktop and never falls back after encryption failure", async () => {
    const storage = localStorage();
    const encrypted = createVoiceStorage(storage, {
      encryptVoiceKey: async () => "ciphertext",
      decryptVoiceKey: async (value) => {
        expect(value).toBe("ciphertext");
        return "fake-key";
      },
    });
    await encrypted.key.write("fake-key");
    expect([...storage.values.values()]).toEqual(["ciphertext"]);
    expect(await encrypted.key.read()).toBe("fake-key");
    const unavailable = createVoiceStorage(storage, {
      encryptVoiceKey: async () => {
        throw new Error("keyring locked");
      },
      decryptVoiceKey: async () => {
        throw new Error("keyring locked");
      },
    });
    await expect(unavailable.key.write("other-key")).rejects.toThrow("keyring locked");
    await expect(unavailable.key.read()).rejects.toThrow("keyring locked");
    expect([...storage.values.values()]).toEqual(["ciphertext"]);
  });

  it("restores seen notification identities without retaining duplicate records", () => {
    const storage = localStorage();
    createVoiceStorage(storage).seen.mark(["env-a:thread-a:item", "env-a:thread-a:item"]);
    const restored = createVoiceStorage(storage);
    expect(restored.seen.has("env-a:thread-a:item")).toBe(true);
    expect(restored.seen.has("env-b:thread-a:item")).toBe(false);
    expect(JSON.parse(storage.values.get("t3.voice.seen")!)).toEqual(["env-a:thread-a:item"]);
  });
});
