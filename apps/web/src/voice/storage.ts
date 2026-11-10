import type { DesktopBridge } from "@t3tools/contracts";
import type { VoiceKeyStore } from "@t3tools/client-runtime/voice/session";
import {
  createVoicePreferences,
  type VoiceKeyValueStorage,
} from "@t3tools/client-runtime/voice/storage";

export function createVoiceStorage(
  storage: VoiceKeyValueStorage,
  desktop?: Pick<DesktopBridge, "encryptVoiceKey" | "decryptVoiceKey">,
) {
  const keyName = desktop ? "t3.voice.encrypted-key" : "t3.voice.key";
  const key: VoiceKeyStore & { write: (value: string) => Promise<void> } = {
    async read() {
      const stored = storage.getItem(keyName);
      if (!stored) return null;
      return desktop ? desktop.decryptVoiceKey(stored) : stored;
    },
    async write(value) {
      if (!value.trim()) {
        storage.removeItem(keyName);
        return;
      }
      storage.setItem(
        keyName,
        desktop ? await desktop.encryptVoiceKey(value.trim()) : value.trim(),
      );
    },
  };
  return { key, ...createVoicePreferences(storage) };
}
